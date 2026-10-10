import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import type { HostApi, SendResult, Subscription, Win } from './api.ts';
import { look } from './agents.ts';
import { handoffText, readHandoff } from './gui/reducer.ts';

const STATUS = { waiting: 'Needs you', busy: 'Working', attention: 'Done', idle: 'Idle' } as const;
/** Select value for starting a session instead of delivering into a live one. */
const NEW_SESSION = '\u0000new';

type Props = {
  client: HostApi;
  clientFor: (host: string | undefined) => HostApi;
  source: Win;
  /** Live sessions in sidebar order. The source is left out of the picker. */
  windows: Win[];
  multiHost: boolean;
  onClose: () => void;
  onSent: (r: SendResult) => void;
  /** Open the new-session dialog with this text as its first message. */
  onNewSession: (prompt: string) => void;
};

function optionLabel(w: Win): string {
  return `${w.title} · ${look(w.agent).name} · ${STATUS[w.status]}`;
}

/** Consecutive runs of the same project (or host, when more than one is online). */
function groupsOf(list: Win[], multiHost: boolean): { id: string; windows: Win[] }[] {
  const out: { id: string; windows: Win[] }[] = [];
  for (const w of list) {
    const id = (multiHost ? w.host : w.project) || 'Sessions';
    const last = out.at(-1);
    if (last && last.id === id) last.windows.push(w);
    else out.push({ id, windows: [w] });
  }
  return out;
}

/**
 * Send a handoff into another live session: a subscription summary of this
 * session, then its latest assistant reply. The text is editable. Delivery
 * is the normal queue: typed now when the target is idle, queued when it is busy.
 */
export function SendToDialog({ client, clientFor, source, windows, multiHost, onClose, onSent, onNewSession }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef('');
  const latestRef = useRef('');
  const gen = useRef(0);
  const [text, setText] = useState('');
  const [hadReply, setHadReply] = useState(false);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('Reading the session…');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [noSub, setNoSub] = useState(false);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [subId, setSubId] = useState<string | undefined>(undefined);
  const [targetKey, setTargetKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = windows.filter((w) => w.key !== source.key);
  const creatingNew = targetKey === NEW_SESSION || (!targetKey && others.length === 0);
  const target = creatingNew ? null : (others.find((w) => w.key === targetKey) ?? others[0] ?? null);
  const groups = groupsOf(others, multiHost);

  useEffect(() => dialog.current?.showModal(), []);

  async function draftFrom(subscriptionId: string | undefined, transcript: string, latest: string) {
    const mine = ++gen.current;
    let summary = '';
    if (subscriptionId && transcript.trim()) {
      setStatus('Summarizing the session…');
      const titled = `Session: ${source.title}\n\n${transcript}`;
      summary = (await client.summarize(titled, subscriptionId)).summary;
    }
    if (mine !== gen.current) return;
    const next = handoffText(summary, latest);
    setText(next);
    setHadReply(!!next.trim());
    setSummaryError(null);
  }

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [handoff, listed] = await Promise.all([
          readHandoff((before, limit) => client.feedPage(source.uid, before, limit)),
          client.subscriptions().catch(() => [] as Subscription[]),
        ]);
        if (!live) return;
        transcriptRef.current = handoff.transcript;
        latestRef.current = handoff.latest;
        setSubs(listed);
        const chosen = listed.find((s) => s.isDefault) ?? listed[0];
        setSubId(chosen?.id);
        setNoSub(!chosen);
        if (!chosen) {
          const next = handoffText('', handoff.latest);
          setText(next);
          setHadReply(!!next.trim());
          return;
        }
        await draftFrom(chosen.id, handoff.transcript, handoff.latest);
      } catch (e) {
        if (!live) return;
        const msg = (e as Error).message;
        if (/no transcript/i.test(msg)) {
          setText('');
          return;
        }
        // A summary failure still leaves the latest reply to send.
        if (latestRef.current || transcriptRef.current) {
          setText(handoffText('', latestRef.current));
          setHadReply(!!latestRef.current.trim());
          setSummaryError(msg);
          return;
        }
        setLoadError(msg);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
      gen.current++;
    };
    // The transcript is read once, when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.uid]);

  useEffect(() => {
    if (!loading) box.current?.focus();
  }, [loading]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || (!creatingNew && !target)) return;
    if (creatingNew) {
      onNewSession(body);
      onClose();
      return;
    }
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      onSent(await clientFor(target.host).send(target.uid, body, true));
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const options = (list: Win[]) =>
    list.map((w) => (
      <option key={w.key} value={w.key}>
        {optionLabel(w)}
      </option>
    ));

  return (
    <dialog ref={dialog} className="dialog wide send-to" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2>Send to…</h2>
        </header>
        <p className="hint">A summary of this session, then its latest reply. Edit it, then send it on. A busy session queues it until the agent is free. New session starts another one with this as its first message.</p>
        {loadError && <p className="form-error">{loadError}</p>}
        {noSub && (
          <p className="hint">
            No chat subscription yet, so there is no summary.{' '}
            <a href="#settings/subscriptions" onClick={onClose}>
              Add one under Settings → Subscriptions
            </a>{' '}
            to include one.
          </p>
        )}
        {summaryError && <p className="form-error">{summaryError}</p>}
        {subs.length > 1 && (
          <label className="field">
            <span>Subscription</span>
            <select
              aria-label="Chat subscription"
              value={subId ?? ''}
              disabled={busy || loading}
              onChange={(e) => {
                const id = e.target.value || undefined;
                setSubId(id);
                setLoading(true);
                setSummaryError(null);
                draftFrom(id, transcriptRef.current, latestRef.current)
                  .catch((err: Error) => {
                    setText(handoffText('', latestRef.current));
                    setHadReply(!!latestRef.current.trim());
                    setSummaryError(err.message);
                  })
                  .finally(() => setLoading(false));
              }}
            >
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.model}
                </option>
              ))}
            </select>
          </label>
        )}
        {loading ? (
          <p className="hint">{status}</p>
        ) : (
          <label className="field">
            <span>Message</span>
            <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} rows={10} placeholder="Write what to send." />
          </label>
        )}
        {!loading && !loadError && !hadReply && !text.trim() && <p className="hint">This session has no assistant reply yet. Write what to send.</p>}
        <label className="field">
          <span>Session</span>
          <select aria-label="Session to send to" value={creatingNew ? NEW_SESSION : (target?.key ?? '')} onChange={(e) => setTargetKey(e.target.value)}>
            <option value={NEW_SESSION}>New session…</option>
            {groups.length > 1
              ? groups.map((g) => (
                  <optgroup key={g.id} label={g.id}>
                    {options(g.windows)}
                  </optgroup>
                ))
              : options(others)}
          </select>
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <ConfirmButton type="submit" className="btn primary" disabled={busy || loading || !text.trim() || (!creatingNew && !target)}>
            {busy ? 'Sending…' : creatingNew ? 'New session…' : 'Send'}
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}
