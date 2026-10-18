import { useContext, useEffect, useRef, useState } from 'react';
import { HostPresetsContext } from '../ModelPicker.tsx';
import { ReviewContext } from '../reviewContext.ts';
import { ConfirmButton } from '../ConfirmButton.tsx';
import type { Layer, OwnerSuggestion, ReviewApi, Stack } from '../reviewApi.ts';
import { look } from '../agents.ts';
import { SheetBar, useSheet } from '../sheet.tsx';
import { Markdown } from '../Markdown.tsx';
import { GitHubText, type ImageUrl } from './GitHubText.tsx';
import { errorText } from '../errors.ts';

const STATUS: Record<string, string> = { waiting: 'needs you', busy: 'working', attention: 'done', idle: 'idle', ended: 'ended; sending resumes it' };

/**
 * What goes to the agent: the findings with their locations, your
 * decisions, and the restack of the layers above, drafted by the host and
 * editable here. It goes through the normal send path: typed in now when the
 * agent is idle, queued when it's working, resumed first when it has ended.
 * The first send binds the stack to that conversation. Or a new agent session
 * starts for it, in a worktree at the layer, and the layer's fixes go there.
 * Fixes always go to an agent session, never to a subscription.
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
  const [drafted, setDrafted] = useState('');
  const host = useContext(ReviewContext)?.host ?? '';
  const agents = useContext(HostPresetsContext)(host).filter((p) => p.available && !p.hidden && p.command && p.id !== 'shell');
  const fresh = target.startsWith('new:');

  useEffect(() => dialog.current?.showModal(), []);

  // A new session gets the draft for one: where it is, how to push, why the stack exists. Edits you made stay.
  const wasFresh = useRef(false);
  useEffect(() => {
    if (loading || kind === 'restack' || fresh === wasFresh.current) return;
    wasFresh.current = fresh;
    if (text !== drafted) return;
    api.dispatchText(stack.id, layer.pr, findingIds, extra, kind, fresh).then((t) => (setText(t.text), setDrafted(t.text)), () => {});
  }, [fresh, loading]);

  useEffect(() => {
    let live = true;
    Promise.all([api.dispatchText(stack.id, layer.pr, findingIds, extra, kind), api.owners(stack.id)])
      .then(([t, o]) => {
        if (!live) return;
        setText(t.text);
        setDrafted(t.text);
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
      const out = await api.dispatch(stack.id, layer.pr, fresh ? { findingIds, text, newSession: { preset: target.slice(4) } } : { findingIds, text, targetUid: target });
      onSent(out.outcome, fresh ? `a new ${look(target.slice(4)).name} session` : (chosen?.title ?? stack.owner?.title ?? 'the agent'));
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
            {!owners.length && !agents.length && <option value="">No agent works in {stack.repo.split('/')[1]} — start one first</option>}
            {owners.length > 0 && (
              <optgroup label="Sessions">
                {owners.map((o) => (
                  <option key={o.uid} value={o.uid}>
                    {o.title} · {look(o.agent).name} · {o.origin ? 'made this stack' : o.reason === 'branch' ? `on ${o.branch}` : 'same repo'} · {STATUS[o.status] ?? o.status}
                  </option>
                ))}
              </optgroup>
            )}
            {agents.length > 0 && (
              <optgroup label="Start a new session">
                {agents.map((p) => (
                  <option key={p.id} value={`new:${p.id}`}>
                    New {look(p.id).name} session, in a worktree at {layer.headRef}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {fresh ? (
          <p className="hint">It starts in a new worktree at this layer's head and gets this message first. {label}'s fixes go to it from then on.</p>
        ) : (
          !bound && target && <p className="hint">Sending binds this stack to that conversation; later findings go there too, even after it resumes.</p>
        )}
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
            {busy ? (fresh ? 'Starting…' : 'Sending…') : fresh ? 'Start and send' : 'Send'}
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}

/** The stack's plan, to read where you review. */
export function PlanDialog({ path, text, image, onClose }: { path: string | null; text: string | null; image: ImageUrl; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  useEffect(() => dialog.current?.showModal(), []);
  return (
    <dialog ref={dialog} className="dialog wide review-plan" aria-label="Plan" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} title="Plan" />
      {/* A form, like every dialog, for its padding and layout; it has nothing to submit. */}
      <form method="dialog" onSubmit={(e) => (e.preventDefault(), dismiss())}>
        <header className="ns-head">
          <h2>{path ? path.split('/').pop() : "The first PR's description"}</h2>
        </header>
        {/* A plan file is yours; without one it's the first PR's description, as GitHub shows it. */}
        <div className="plan-text">{!text ? <p className="hint">The plan couldn't be read.</p> : path ? <Markdown text={text} /> : <GitHubText text={text.replace(/^\(No plan file; this is the root PR's description\.\)\n/, '')} image={image} />}</div>
        <div className="actions">
          <button type="submit" className="btn">
            Close
          </button>
        </div>
      </form>
    </dialog>
  );
}
