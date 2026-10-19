import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HostApi, Subscription } from '../api.ts';
import type { Finding, Followup, Layer, ReviewApi, ThreadMsg } from '../reviewApi.ts';
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
 * The reviewer, for a layer or for the whole stack. It answers from the exact
 * revisions; what it proposes lands as cards you keep or dismiss, and anything
 * worth doing goes to the agent through Send.
 */
export function Thread({
  client,
  api,
  stackId,
  pr,
  layers,
  onSend,
  onDecision,
  onChanged,
}: {
  client: HostApi;
  api: ReviewApi;
  stackId: string;
  pr: number | null;
  layers: Layer[];
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
    setRows((r) => [...r, { role: 'user', text: t, at, id: -1, pr, context: [], key }, { role: 'assistant', text: '', at, id: -2, pr, context: [], key: 'pending', pending: true }]);
    try {
      const out = await api.ask(stackId, pr, t, subId);
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
  const layer = pr === null ? null : layers.find((l) => l.pr === pr);

  return (
    <div className="panel-body sidechat review-thread">
      <div className="sidechat-context">
        <span className="sidechat-where">
          <Icon name="sparkle" size={14} />
          <span className="hint">{layer ? `Reviewer · now on ${layer.role || `#${layer.pr}`}, the whole stack in view` : 'Reviewer on the whole stack'}</span>
        </span>
        <span className="spacer" />
        {rows.length > 0 && (
          <button className="btn ghost small" onClick={clear}>
            Clear
          </button>
        )}
      </div>
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
            <p className="title">{layer ? 'Ask about this layer' : 'Ask about the stack'}</p>
            <p className="hint">The reviewer reads the exact revisions, the plan and your decisions. Nothing reaches the agent unless you send it.</p>
            <div className="suggestions">
              {(layer ? STARTERS_LAYER : STARTERS_STACK).map((s) => (
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
        <div className="sidechat-field">
          <textarea
            ref={areaRef}
            value={draft}
            disabled={noSub}
            rows={1}
            enterKeyHint="send"
            placeholder={layer ? `Ask about ${layer.role || `#${layer.pr}`}…` : 'Ask about the stack…'}
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
