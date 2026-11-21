import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HostApi, Subscription } from '../api.ts';
import type { Attachment, Finding, Followup, Layer, ReviewApi, ThreadMsg } from '../reviewApi.ts';
import { askConfirm, showError, showNotice } from '../ask.tsx';
import { Icon } from '../icons.tsx';
import { Markdown } from '../Markdown.tsx';
import { SubscriptionPicker } from '../SubscriptionPicker.tsx';
import { FindingRow } from './Findings.tsx';

type Row = ThreadMsg & { key: string; pending?: boolean; failed?: string; followups?: Followup[] };

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
      Reading the code{s > 2 ? ` · ${s}s` : '…'}
    </div>
  );
}

/** Over a question: the layer it was asked on, and what was attached to it. */
function AskedOn({ m, layers }: { m: ThreadMsg; layers: Layer[] }) {
  const l = m.pr === null ? null : layers.find((x) => x.pr === m.pr);
  return (
    <div className="asked-on">
      <span className="asked-where">{l ? `On ${l.role || `#${l.pr}`}` : m.pr === null ? 'On the stack' : `On #${m.pr}`}</span>
      {m.context.map((c) => (
        <span key={`${c.kind}:${c.kind === 'finding' ? c.id : `${c.pr}:${c.path}:${c.kind === 'lines' ? c.start : ''}`}`} className="ctx-chip small" title={c.kind === 'lines' ? `${c.path}:${c.start}–${c.end}` : c.kind === 'file' ? c.path : c.label}>
          <Icon name={c.kind === 'finding' ? 'flag' : c.kind === 'file' ? 'file' : 'diff'} size={12} />
          <span className="ellipsis">{c.label}</span>
        </span>
      ))}
    </div>
  );
}

const STARTERS_LAYER = ['What could break here?', 'Does this fit what the layers above need?', 'Is anything here in the wrong layer?'];
const STARTERS_STACK = ['Does the overall architecture hold together?', 'Which layer owns each behavior?', 'What should I look at first?'];

/**
 * The stack's one conversation with the reviewer, beside whatever you're
 * looking at. The layer you're on rides along as a chip (take it off to ask
 * about the whole stack), with anything you attached: findings, diff lines,
 * files. It answers from the exact revisions; what it proposes lands as cards
 * you keep or dismiss, and anything worth doing goes to the agent through Send.
 */
export function Thread({
  client,
  api,
  stackId,
  pr,
  layers,
  attached,
  onDetach,
  focus,
  onHide,
  sheet = false,
  sessionLabel = null,
  onSend,
  onDecision,
  onChanged,
}: {
  client: HostApi;
  api: ReviewApi;
  stackId: string;
  /** The layer you're on; null on the stack's overview. */
  pr: number | null;
  layers: Layer[];
  /** What you brought to the conversation (a finding's Discuss, a diff line's Ask): sent with the next question. */
  attached: Attachment[];
  /** Take one off (by key), or all of them (null) once they've gone with a question. */
  onDetach: (key: string | null) => void;
  /** Bumped when something is attached: the field takes focus, with what you'd started writing (a diff line's note). */
  focus: { n: number; text: string };
  /** Fold the panel away (or, in a phone's sheet, put the sheet away). */
  onHide?: () => void;
  sheet?: boolean;
  /** Name of the linked session for clearer "Send to <Session>" action labels. */
  sessionLabel?: string | null;
  /** Open the send dialog with this text. */
  onSend: (text: string) => void;
  onDecision: (text: string) => void;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [cards, setCards] = useState<Finding[]>([]);
  const [subs, setSubs] = useState<Subscription[] | null>(null);
  const [subId, setSubId] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const gen = useRef(0);
  const sending = useRef(false);
  // The layer you're on is the question's scope until you take its chip off; a new layer puts it back.
  const [scoped, setScoped] = useState(true);
  useEffect(() => setScoped(true), [pr]);
  useEffect(() => {
    if (!focus.n) return;
    if (focus.text) setDraft((d) => (d.trim() ? `${d.trimEnd()}\n${focus.text}` : focus.text));
    areaRef.current?.focus({ preventScroll: true });
    areaRef.current?.scrollIntoView({ block: 'nearest' });
  }, [focus.n]);

  const load = () =>
    api
      .thread(stackId)
      .then((t) => {
        setRows(t.messages.map((m) => ({ ...m, key: `m${m.id}` })));
        setCards(t.findings);
        // This thread's own pick, else the active subscription.
        setSubId(t.subscriptionId ?? undefined);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    gen.current++;
    setRows([]);
    setCards([]);
    setError(null);
    setSubId(undefined);
    void load();
    client.subscriptions().then(setSubs, () => setSubs([]));
  }, [stackId]);

  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  useLayoutEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  async function ask(text: string) {
    const t = text.trim();
    if (!t || sending.current) return;
    sending.current = true;
    const mine = gen.current;
    const at = Math.floor(Date.now() / 1000);
    setDraft('');
    const key = `u${Date.now()}`;
    const on = scoped ? pr : null;
    const sent = attached;
    const shown = sent.map((a) => ({ ...a.ctx, label: a.label })) as ThreadMsg['context'];
    setRows((r) => [...r, { role: 'user', text: t, at, id: -1, pr: on, context: shown, key }, { role: 'assistant', text: '', at, id: -2, pr: on, context: [], key: 'pending', pending: true }]);
    onDetach(null);
    try {
      const out = await api.ask(stackId, on, t, subId, sent.map((a) => a.ctx));
      if (mine !== gen.current) return;
      setRows((r) => [...r.filter((x) => !x.pending).map((x) => (x.key === key ? { ...out.asked, key: `m${out.asked.id}` } : x)), { ...out.message, key: `m${out.message.id}`, followups: out.followups }]);
      setCards((c) => [...c, ...out.findings]);
    } catch (e) {
      if (mine !== gen.current) return;
      setRows((r) => r.filter((x) => !x.pending).map((x) => (x.key.startsWith('u') && x.text === t && x.id === -1 ? { ...x, failed: (e as Error).message } : x)));
    } finally {
      sending.current = false;
    }
  }

  async function clear() {
    if (!rows.length) return;
    if (!(await askConfirm({ title: 'Clear the conversation?', body: "The stack's whole conversation with the reviewer goes. Kept findings stay; proposals from it go.", confirm: 'Clear', danger: true }))) return;
    try {
      gen.current++;
      await api.clearThread(stackId);
      setRows([]);
      setSubId(undefined);
      setCards([]);
      onChanged();
    } catch (e) {
      showError(e, "Couldn't clear the thread");
    }
  }

  const noSub = subs !== null && subs.length === 0;
  const layer = pr === null ? null : (layers.find((l) => l.pr === pr) ?? null);
  const on = scoped ? layer : null;

  return (
    <div className="panel-body sidechat review-thread">
      <header className="reviewer-head">
        <Icon name="sparkle" size={16} />
        <span className="grow">
          <span className="reviewer-title">Reviewer</span>
          <span className="hint">One conversation for the stack</span>
        </span>
        {rows.length > 0 && (
          <button className="btn ghost small" onClick={clear}>
            Clear
          </button>
        )}
        {onHide && (
          <button className={sheet ? 'icon-btn round' : 'icon-btn'} onClick={onHide} aria-label={sheet ? 'Close the reviewer' : 'Hide the reviewer'} title={sheet ? 'Close' : 'Hide the reviewer'}>
            <Icon name={sheet ? 'close' : 'panel'} size={16} />
          </button>
        )}
      </header>
      {noSub && (
        <p className="panel-msg">
          The reviewer needs a model. <a href="#settings/subscriptions">Add one under Settings → Subscriptions</a>.
        </p>
      )}
      {error && <p className="panel-msg">{error}</p>}
      <div className="sidechat-log" ref={logRef}>
        {!rows.length && !noSub && (
          <div className="sidechat-empty">
            <Icon name="sparkle" size={28} />
            <p className="title">{on ? `Ask about ${on.role || `#${on.pr}`}` : 'Ask about the stack'}</p>
            <p className="hint">It reads the exact revisions, the plan and your decisions, and follows you from layer to layer. Discuss on a finding or a diff line brings it here. Nothing reaches the agent unless you send it.</p>
            <div className="suggestions">
              {(on ? STARTERS_LAYER : STARTERS_STACK).map((s) => (
                <button key={s} className="sugg" onClick={() => ask(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {rows.length > 0 && <div className="sidechat-spacer" aria-hidden />}
        {rows.map((m) => {
          const mine = cards.filter((c) => c.messageId === m.id);
          return (
            <div key={m.key} className={`sidechat-msg ${m.role}${m.pending ? ' sending' : ''}`}>
              {m.role === 'user' && <AskedOn m={m} layers={layers} />}
              <div className="sidechat-bubble">{m.role === 'assistant' ? m.pending ? <Thinking since={m.at * 1000} /> : <Markdown text={m.text} /> : m.text}</div>
              {m.failed && (
                <div className="msg-meta failed">
                  <span>Couldn't ask: {m.failed}</span>
                  <button className="btn ghost small" onClick={() => {
                    setRows((r) => r.filter((x) => x.key !== m.key));
                    void ask(m.text);
                  }}>
                    Retry
                  </button>
                </div>
              )}
              {m.role === 'assistant' && !m.pending && (
                <div className="msg-actions">
                  <button
                    className="btn ghost small"
                    onClick={() => navigator.clipboard?.writeText(m.text).catch(() => showNotice('Copy failed', 'Select the text and copy it yourself.'))}
                  >
                    Copy
                  </button>
                  <button className="btn ghost small" onClick={() => onSend(m.text)} title="Send this to the agent that owns the stack">
                    Send to agent
                  </button>
                  <button className="btn ghost small" onClick={() => onDecision(m.text.split('\n').find((x) => x.trim() && !x.startsWith('#'))?.replace(/^[-*]\s*/, '').slice(0, 300) ?? '')} title="Keep a decision the reviewer and the agent are held to">
                    Pin as decision
                  </button>
                </div>
              )}
              {mine.length > 0 && (
                <ul className="finding-list proposed-cards">
                  {mine.map((f) => (
                    <FindingRow
                      key={f.id}
                      f={f}
                      api={api}
                      stackId={stackId}
                      layers={layers}
                     
                      onChanged={() => {
                        void load();
                        onChanged();
                      }}
                    />
                  ))}
                </ul>
              )}
              {m.followups?.length ? (
                <div className="suggestions">
                  {m.followups.map((f) => (
                    <button key={f.title + f.text} className="sugg" onClick={() => (f.kind === 'session' ? onSend(f.text) : ask(f.text))} title={f.kind === 'session' ? 'Send to the agent' : 'Ask the reviewer'}>
                      {f.title}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <form
        className="sidechat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(draft);
        }}
      >
        {subs && subs.length > 0 && (
          <SubscriptionPicker
            subs={subs}
            value={subId}
            title="Reviewer model"
            note="This thread keeps it"
            onPick={(id) => {
              setSubId(id);
              api.pickSubscription(stackId, id).catch((e) => showError(e, "Couldn't switch the reviewer"));
            }}
          />
        )}
        {(on || attached.length > 0) && (
          <div className="ctx-chips" aria-label="Asking about">
            {on && (
              <span className="ctx-chip scope" title={`${on.title}: the reviewer reads this layer first. Take it off to ask about the whole stack.`}>
                <span className="mono">{on.role || `#${on.pr}`}</span>
                <button type="button" className="chip-x" aria-label={`Ask about the whole stack, not ${on.role || `#${on.pr}`}`} onClick={() => setScoped(false)}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            )}
            {attached.map((a) => (
              <span key={a.key} className="ctx-chip" title={a.ctx.kind === 'lines' ? `${a.ctx.path}:${a.ctx.start}–${a.ctx.end}` : a.ctx.kind === 'file' ? a.ctx.path : a.label}>
                <Icon name={a.ctx.kind === 'finding' ? 'flag' : a.ctx.kind === 'file' ? 'file' : 'diff'} size={12} />
                <span className="ellipsis">{a.label}</span>
                <button type="button" className="chip-x" aria-label={`Take off ${a.label}`} onClick={() => onDetach(a.key)}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {!on && layer && (
          <button type="button" className="btn ghost small rescope" onClick={() => setScoped(true)}>
            Asking about the whole stack · <span className="mono">{layer.role || `#${layer.pr}`}</span> again
          </button>
        )}
        <div className="sidechat-field">
          <textarea
            ref={areaRef}
            value={draft}
            disabled={noSub}
            rows={1}
            enterKeyHint="send"
            placeholder={attached.length ? 'Ask about these…' : on ? `Ask about ${on.role || `#${on.pr}`}…` : 'Ask about the stack…'}
            title="Shift+Enter for a new line"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void ask(draft);
              }
            }}
          />
          <button type="submit" className="send-btn" disabled={!draft.trim() || noSub} aria-label="Ask" title="Ask">
            <Icon name="up" />
          </button>
        </div>
      </form>
    </div>
  );
}
