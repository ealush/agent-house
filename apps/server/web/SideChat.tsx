import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMsg, Followup, HostApi, SendResult, Subscription, Win } from './api.ts';
import { askConfirm, showError, showNotice } from './ask.tsx';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';
import { SubscriptionPicker } from './SubscriptionPicker.tsx';

// Side chat: talk about the session's change without polluting the agent's
// context. The server answers with the working diff, branch and PR attached.
// Anything worth acting on goes to the session through the normal send path.
//
// Sends are optimistic and chained: your bubble appears the moment you press
// send, with its answer's slot reserved right below it, and while one reply
// is still on its way you can keep typing — the next send waits its turn
// behind the in-flight one, so the server (which rewrites the turn log per
// reply) never sees two concurrent writes from this panel. Each answer keeps
// its own follow-ups until a newer message supersedes them.
type RowState = 'queued' | 'sending' | 'sent' | 'failed';
type Row = ChatMsg & { key: string; state: RowState; error?: string; followups?: Followup[] };

function Thinking({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return (
    <div className="sidechat-thinking" aria-live="polite">
      <span className="thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      Thinking{s > 2 ? ` · ${s}s` : '…'}
    </div>
  );
}

export function SideChat({ client, w, onSent }: { client: HostApi; w: Win; onSent: (r: SendResult) => void }) {
  const [messages, setMessages] = useState<Row[]>([]);
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [subId, setSubId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const msgRefs = useRef(new Map<string, HTMLDivElement>());
  const seenRef = useRef(0);
  const prevLenRef = useRef(0);
  // Serializes sends so concurrent replies can't interleave the server log.
  const tailRef = useRef<Promise<void>>(Promise.resolve());
  // Bumped on session switch and on clear: late completions apply nothing.
  const genRef = useRef(0);
  const localRef = useRef(0);
  const widRef = useRef(w.uid);
  widRef.current = w.uid;

  // Grow with the draft, up to the CSS max-height, same as the session composer.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    genRef.current += 1;
    tailRef.current = Promise.resolve();
    setError(null);
    seenRef.current = 0;
    prevLenRef.current = 0;
    setSubId(undefined);
    client
      .chat(w.uid)
      .then((r) => {
        setMessages(r.messages.map((m, i) => ({ ...m, key: m.id != null ? `m${m.id}` : `i${i}`, state: 'sent' as RowState })));
        // This chat's own pick, else the active subscription.
        setSubId(r.subscriptionId ?? undefined);
      })
      .catch((e) => setError(e.message));
    client.subscriptions().then(setSubs).catch(() => setSubs([]));
  }, [w.uid, w.key, client]);

  // Keep new arrivals readable from their top: at the bottom (or first load)
  // that means the first new message's top; scrolled up, it means the first
  // message since the user last saw the bottom. Jumping to the very bottom
  // would hide a long answer's beginning. Layout, not passive, so a short
  // thread doesn't flash from the top of the spacer. Same-length updates are
  // always this panel's own latest activity, so they settle at the bottom —
  // but only when already there, never yanking away from reading history.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) {
      prevLenRef.current = messages.length;
      return;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    if (messages.length > prevLenRef.current) {
      const firstNew = Math.min(prevLenRef.current, messages.length - 1);
      if (atBottom || prevLenRef.current === 0) {
        const key = messages[firstNew]?.key;
        if (key) msgRefs.current.get(key)?.scrollIntoView({ block: 'start' });
        seenRef.current = messages.length;
      } else {
        const key = messages[Math.min(seenRef.current, messages.length - 1)]?.key;
        if (key) msgRefs.current.get(key)?.scrollIntoView({ block: 'start' });
      }
    } else if (atBottom) {
      el.scrollTo({ top: el.scrollHeight });
    }
    prevLenRef.current = messages.length;
  }, [messages]);

  function enqueue(userKey: string, asstKey: string, text: string, sub: string | undefined) {
    const wid = widRef.current;
    const gen = genRef.current;
    tailRef.current = tailRef.current.then(async () => {
      if (gen !== genRef.current) return;
      setMessages((ms) =>
        ms.map((m) => (m.key === userKey || m.key === asstKey ? { ...m, state: 'sending' as RowState, error: undefined } : m)),
      );
      try {
        const reply = await client.sendChat(wid, text, sub);
        if (gen !== genRef.current) return;
        setMessages((ms) => {
          if (!ms.some((m) => m.key === userKey)) return ms;
          return ms.map((m) => {
            if (m.key === userKey) return { ...m, state: 'sent' as RowState };
            if (m.key === asstKey) return { ...m, ...reply.message, key: asstKey, state: 'sent' as RowState, followups: reply.followups };
            return m;
          });
        });
      } catch (e) {
        if (gen !== genRef.current) return;
        // The answer's slot goes away with it; the question stays with a retry.
        setMessages((ms) =>
          ms
            .filter((m) => m.key !== asstKey)
            .map((m) => (m.key === userKey ? { ...m, state: 'failed' as RowState, error: (e as Error).message } : m)),
        );
      }
    });
  }

  function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || noSub) return;
    const n = ++localRef.current;
    const userKey = `l${n}`;
    const asstKey = `a${n}`;
    const at = Math.floor(Date.now() / 1000);
    setDraft('');
    setMessages((ms) => [
      // A newer question supersedes older answers' suggestions.
      ...ms.map((m) => (m.followups?.length ? { ...m, followups: undefined } : m)),
      { role: 'user', text: trimmed, at, key: userKey, state: 'queued' as RowState },
      { role: 'assistant', text: '', at, key: asstKey, state: 'queued' as RowState },
    ]);
    enqueue(userKey, asstKey, trimmed, subId);
  }

  function retry(key: string) {
    const row = messages.find((m) => m.key === key);
    if (!row || row.state !== 'failed') return;
    const asstKey = `a${key}`;
    const at = Math.floor(Date.now() / 1000);
    setMessages((ms) => {
      const out: Row[] = [];
      for (const m of ms) {
        if (m.key === asstKey) continue;
        out.push(m.key === key ? { ...m, state: 'queued' as RowState, error: undefined } : m);
        if (m.key === key) out.push({ role: 'assistant', text: '', at, key: asstKey, state: 'queued' as RowState });
      }
      return out;
    });
    enqueue(key, asstKey, row.text, subId);
  }

  async function fireFollowup(f: Followup) {
    setMessages((ms) => ms.map((m) => (m.followups?.length ? { ...m, followups: undefined } : m)));
    if (f.kind === 'session') await sendToSession(f.text);
    else submit(f.text);
  }

  async function sendToSession(text: string) {
    try {
      onSent(await client.send(w.uid, text, true));
    } catch (e) {
      showError(e, "Couldn't send to session");
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      showNotice('Copy failed', 'Select the text and copy it yourself.');
    }
  }

  async function clear() {
    if (!messages.length) return;
    if (!(await askConfirm({ title: 'Clear this side chat?', body: 'The agent never saw it.', confirm: 'Clear', danger: true }))) return;
    try {
      genRef.current += 1;
      await client.clearChat(w.uid);
      setMessages([]);
      setSubId(undefined);
    } catch (e) {
      showError(e, "Couldn't clear the chat");
    }
  }

  const noSub = subs !== null && subs.length === 0;
  const showEmpty = !messages.length && !noSub && !error;

  return (
    <div className="panel-body sidechat">
      <div className="sidechat-context">
        <span className="sidechat-where">
          <Icon name="branch" size={14} />
          <span className="hint">
            {w.branch ?? 'no branch'}
            {w.agent ? ` · talking about ${w.title}` : ' · talking about this shell'}
          </span>
        </span>
        <span className="spacer" />
        {messages.length > 0 && (
          <button className="btn ghost small" onClick={clear}>
            Clear
          </button>
        )}
      </div>

      {noSub && (
        <p className="panel-msg">
          No chat subscription yet. <a href="#settings/subscriptions">Add one under Settings → Subscriptions</a>.
        </p>
      )}
      {error && <p className="panel-msg">{error}</p>}

      <div
        className="sidechat-log"
        ref={logRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight < 48) seenRef.current = messages.length;
        }}
      >
        {showEmpty && (
          <div className="sidechat-empty">
            <Icon name="chat" size={28} />
            <p className="title">Ask about this change</p>
            <p className="hint">A review, an explanation, or a plan. Nothing here reaches the agent unless you send it over.</p>
          </div>
        )}
        {messages.length > 0 && <div className="sidechat-spacer" aria-hidden />}
        {messages.map((m) => (
          <Fragment key={m.key}>
            <div
              className={`sidechat-msg ${m.role}${m.state !== 'sent' ? ` ${m.state}` : ''}`}
              ref={(el) => {
                if (el) msgRefs.current.set(m.key, el);
                else msgRefs.current.delete(m.key);
              }}
            >
              <div className="sidechat-bubble">
                {m.role === 'assistant' ? (
                  m.state === 'sent' ? (
                    <Markdown text={m.text} />
                  ) : (
                    <Thinking since={m.at * 1000} />
                  )
                ) : (
                  m.text
                )}
              </div>
              {m.role === 'user' && m.state === 'queued' && <div className="msg-meta">Queued</div>}
              {m.role === 'user' && m.state === 'failed' && (
                <div className="msg-meta failed">
                  <span>Couldn't send{m.error ? `: ${m.error}` : ''}</span>
                  <button className="btn ghost small" onClick={() => retry(m.key)}>
                    Retry
                  </button>
                </div>
              )}
              {m.state === 'sent' && (
                <div className="msg-actions">
                  <button className="btn ghost small" onClick={() => copy(m.text)}>
                    Copy
                  </button>
                  {m.role === 'assistant' && (
                    <button className="btn ghost small" onClick={() => sendToSession(m.text)} title="Send this to the session (queued if it's busy)">
                      Send to session
                    </button>
                  )}
                </div>
              )}
              {m.followups?.length ? (
                <div className="suggestions">
                  {m.followups.map((f) => (
                    <button key={f.title + f.text} className="sugg" onClick={() => fireFollowup(f)} title={f.kind === 'session' ? 'Send to the session' : 'Ask side chat'}>
                      {f.title}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </Fragment>
        ))}
      </div>

      <form
        className="sidechat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        {subs && subs.length > 0 && (
          <SubscriptionPicker
            subs={subs}
            value={subId}
            title="Chat subscription"
            note="This chat keeps it"
            onPick={(id) => {
              setSubId(id);
              client.pickChatSubscription(w.uid, id).catch((e) => showError(e, "Couldn't switch the subscription"));
            }}
          />
        )}
        <div className="sidechat-field">
          <textarea
            ref={areaRef}
            value={draft}
            disabled={noSub}
            rows={1}
            enterKeyHint="send"
            placeholder="Ask about this change…"
            title="Shift+Enter for a new line"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(draft);
              }
            }}
          />
          <button type="submit" className="send-btn" disabled={!draft.trim() || noSub} aria-label="Send" title="Send">
            <Icon name="up" />
          </button>
        </div>
      </form>
    </div>
  );
}
