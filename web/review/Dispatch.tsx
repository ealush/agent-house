import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from '../ConfirmButton.tsx';
import type { Layer, OwnerSuggestion, ReviewApi, Stack } from '../reviewApi.ts';
import { look } from '../agents.ts';
import { SheetBar, useSheet } from '../sheet.tsx';
import { Markdown } from '../Markdown.tsx';
import { errorText } from '../errors.ts';

const STATUS: Record<string, string> = { waiting: 'needs you', busy: 'working', attention: 'done', idle: 'idle', ended: 'ended; sending resumes it' };

/**
 * What goes to the agent: the findings with their locations, your
 * decisions, and the restack of the layers above, drafted by the host and
 * editable here. It goes through the normal send path: typed in now when the
 * agent is idle, queued when it's working, resumed first when it has ended.
 * The first send binds the stack to that conversation.
 */
export function DispatchDialog({
  api,
  stack,
  layer,
  findingIds,
  extra,
  kind,
  onClose,
  onSent,
}: {
  api: ReviewApi;
  stack: Stack;
  layer: Layer;
  findingIds: number[];
  extra: string;
  kind?: 'restack';
  onClose: () => void;
  onSent: (outcome: string, to: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [owners, setOwners] = useState<OwnerSuggestion[]>([]);
  const [target, setTarget] = useState<string>(layer.ownerUid ?? stack.owner?.uid ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => dialog.current?.showModal(), []);

  useEffect(() => {
    let live = true;
    Promise.all([api.dispatchText(stack.id, layer.pr, findingIds, extra, kind), api.owners(stack.id)])
      .then(([t, o]) => {
        if (!live) return;
        setText(t.text);
        setOwners(o);
        setTarget((cur) => cur || o[0]?.uid || '');
      })
      .catch((e) => live && setError(errorText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, []);

  const chosen = owners.find((o) => o.uid === target);
  const bound = stack.owner && stack.owner.uid === target;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim() || !target) return;
    setBusy(true);
    setError(null);
    try {
      const out = await api.dispatch(stack.id, layer.pr, { findingIds, text, targetUid: target });
      onSent(out.outcome, chosen?.title ?? stack.owner?.title ?? 'the agent');
      onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const label = layer.role || `#${layer.pr}`;
  return (
    <dialog ref={dialog} className="dialog wide send-to review-dispatch" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2>{kind === 'restack' ? `Restack ${label}` : findingIds.length ? `Send ${findingIds.length} finding${findingIds.length > 1 ? 's' : ''} for ${label}` : `Send to the agent on ${label}`}</h2>
        </header>
        <p className="hint">
          Drafted from your findings, decisions and the layers above. Edit it as you like. When the agent finishes and pushes, the layer comes back for a re-review.
        </p>
        <label className="field">
          <span>Session</span>
          <select aria-label="Session to send to" value={target} onChange={(e) => setTarget(e.target.value)} disabled={loading}>
            {!owners.length && <option value="">No agent works in {stack.repo.split('/')[1]} — start one first</option>}
            {owners.map((o) => (
              <option key={o.uid} value={o.uid}>
                {o.title} · {look(o.agent).name} · {o.origin ? 'made this stack' : o.reason === 'branch' ? `on ${o.branch}` : 'same repo'} · {STATUS[o.status] ?? o.status}
              </option>
            ))}
          </select>
        </label>
        {!bound && target && <p className="hint">Sending binds this stack to that conversation; later findings go there too, even after it resumes.</p>}
        {loading ? (
          <p className="hint">Drafting…</p>
        ) : (
          <label className="field">
            <span>Message</span>
            <textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} className="mono-ish" />
          </label>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <ConfirmButton type="submit" className="btn primary" disabled={busy || loading || !text.trim() || !target}>
            {busy ? 'Sending…' : 'Send'}
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}

/** The stack's plan, to read where you review. */
export function PlanDialog({ path, text, onClose }: { path: string | null; text: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog ref={dialog} className="dialog wide review-plan" aria-label="Plan" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} title="Plan" />
      <header className="ns-head">
        <h2>{path ? path.split('/').pop() : "The first PR's description"}</h2>
      </header>
      <div className="plan-text">{text ? <Markdown text={text} /> : <p className="hint">The plan couldn't be read.</p>}</div>
      <div className="actions">
        <button type="button" className="btn" onClick={dismiss}>
          Close
        </button>
      </div>
    </dialog>
  );
}
