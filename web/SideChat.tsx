import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMsg, Followup, HostApi, SendResult, Subscription, Win } from './api.ts';
import { askConfirm, showError, showNotice } from './ask.tsx';
import { Icon } from './icons.tsx';
import { Markdown } from './Markdown.tsx';

// Side chat: talk about the session's change without polluting the agent's
// context. The server answers with the working diff, branch and PR attached.
// Anything worth acting on goes to the session through the normal send path.
export function SideChat({ client, w, onSent }: { client: HostApi; w: Win; onSent: (r: SendResult) => void }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [subId, setSubId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Premade next steps under the latest answer; gone once used or superseded.
  const [followups, setFollowups] = useState<Followup[]>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const msgRefs = useRef(new Map<number, HTMLDivElement>());
  const seenRef = useRef(0);
  const prevLenRef = useRef(0);

  // Grow with the draft, up to the CSS max-height, same as the session composer.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useEffect(() => {
    setFollowups([]);
    seenRef.current = 0;
    prevLenRef.current = 0;
    client
      .chat(w.id)
      .then((r) => {
        setMessages(r.messages);
        setSubId((cur) => cur ?? r.subscriptionId ?? undefined);
      })
      .catch((e) => setError(e.message));
    client.subscriptions().then(setSubs).catch(() => setSubs([]));
  }, [w.id, w.key, client]);

  // Keep new arrivals readable from their top: at the bottom (or first load)
  // that means the first new message's top; scrolled up, it means the first
  // message since the user last saw the bottom. Jumping to the very bottom
  // would hide a long answer's beginning. Layout, not passive, so a short
  // thread doesn't flash from the top of the spacer.
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el) {
      prevLenRef.current = messages.length;
      return;
    }
    if (messages.length > prevLenRef.current) {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      const firstNew = Math.min(prevLenRef.current, messages.length - 1);
      if (atBottom || prevLenRef.current === 0) {
        msgRefs.current.get(firstNew)?.scrollIntoView({ block: 'start' });
        seenRef.current = messages.length;
      } else {
        msgRefs.current.get(Math.min(seenRef.current, messages.length - 1))?.scrollIntoView({ block: 'start' });
      }
    }
    prevLenRef.current = messages.length;
  }, [messages]);

  async function submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    setFollowups([]);
    setDraft('');
    try {
      const reply = await client.sendChat(w.id, trimmed, subId);
      setMessages((await client.chat(w.id)).messages);
      if (reply.followups.length) setFollowups(reply.followups);
    } catch (e) {
      setError((e as Error).message);
      setDraft(trimmed);
    } finally {
      setBusy(false);
    }
  }

  async function fireFollowup(f: Followup) {
    setFollowups([]);
    if (f.kind === 'session') await sendToSession(f.text);
    else await submit(f.text);
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
      await client.clearChat(w.id);
      setMessages([]);
      setFollowups([]);
    } catch (e) {
      showError(e, "Couldn't clear the chat");
    }
  }

  const lastAssistant = (() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') return i;
    return -1;
  })();

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
        {messages.map((m, i) => (
          <div
            key={i}
            className={`sidechat-msg ${m.role}`}
            ref={(el) => {
              if (el) msgRefs.current.set(i, el);
              else msgRefs.current.delete(i);
            }}
          >
            <div className="sidechat-bubble">{m.role === 'assistant' ? <Markdown text={m.text} /> : m.text}</div>
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
            {i === lastAssistant && followups.length > 0 && (
              <div className="suggestions">
                {followups.map((f) => (
                  <button key={f.title + f.text} className="sugg" onClick={() => fireFollowup(f)} title={f.kind === 'session' ? 'Send to the session' : 'Ask side chat'}>
                    {f.title}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <p className="sidechat-status">Thinking…</p>}
      </div>

      <form
        className="sidechat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          submit(draft);
        }}
      >
        {subs && subs.length > 1 && (
          <select aria-label="Chat subscription" value={subId ?? ''} disabled={busy} onChange={(e) => setSubId(e.target.value || undefined)}>
            {subs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.model}
              </option>
            ))}
          </select>
        )}
        <div className="sidechat-field">
          <textarea
            ref={areaRef}
            value={draft}
            disabled={busy || noSub}
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
          <button type="submit" className="send-btn" disabled={!draft.trim() || busy} aria-label={busy ? 'Sending' : 'Send'} title={busy ? 'Sending' : 'Send'}>
            <Icon name="up" />
          </button>
        </div>
      </form>
    </div>
  );
}
