import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import type { HostApi, Migration, MovePreview } from './api.ts';
import { SheetBar, useSheet } from './sheet.tsx';
import { errorText } from './errors.ts';

export type MoveTarget = { ref: string; host: string; title: string };

type Props = {
  /** The API of the host the session is on: the source drives the move. */
  client: HostApi;
  target: MoveTarget;
  /** Hosts it can go to (online, not its own). */
  hosts: string[];
  onClose: () => void;
  /** Done: the session is on `host` as `uid`, ended and resumable there. */
  onMoved: (host: string, uid: string) => void;
};

const STEP: Record<string, string> = {
  planned: 'Starting…',
  transferring: 'Sending the conversation…',
  committing: 'Restoring it there…',
  verifying: 'Checking it resumes there…',
};

/**
 * Move to another host (server/migrate): the destination says first where the session
 * would work and what it lacks; only a stopped session moves, and the original stays.
 */
export function MoveDialog({ client, target, hosts, onClose, onMoved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [to, setTo] = useState(hosts[0] ?? '');
  const [plan, setPlan] = useState<MovePreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [moving, setMoving] = useState<Migration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(`web:${crypto.randomUUID()}`);

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    if (!to) return;
    let live = true;
    setPlan(null);
    setLoadError(null);
    setConfirmed(false);
    client
      .movePreview(target.ref, to)
      .then((p) => live && setPlan(p))
      .catch((e) => live && setLoadError(errorText(e)));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.ref, to]);

  // Follow the move until it lands or stops.
  useEffect(() => {
    if (!moving || ['completed', 'failed', 'cancelled'].includes(moving.state)) return;
    const t = window.setTimeout(() => void client.migration(moving.id).then(setMoving, (e) => setError(errorText(e))), 600);
    return () => window.clearTimeout(t);
  }, [client, moving]);

  const warnings = plan?.preflight.requirements.filter((r) => !r.blocking) ?? [];
  const blocking = plan?.preflight.requirements.filter((r) => r.blocking) ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const out = await client.moveStart(target.ref, to, { acceptWarnings: confirmed, idempotencyKey: key.current });
      setMoving(out.migration);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <dialog ref={dialog} className="dialog new-session" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2>Move to another host</h2>
        </header>
        <p className="hint">“{target.title}” goes on on another host: its conversation is copied there and resumes there. The original stays on {target.host} as it was.</p>
        {hosts.length > 1 && !moving && (
          <label className="field">
            <span>To</span>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {hosts.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        )}
        {!moving && loadError && <p className="form-error">{loadError}</p>}
        {!moving && !plan && !loadError && <p className="hint">Asking {to}…</p>}
        {!moving && plan && (
          <>
            {plan.preflight.destCwd && (
              <p className="note">
                <span>
                  On {plan.preflight.host} it works in <code>{plan.preflight.destCwd}</code>
                  {plan.preflight.resolvedBy === 'git_remote' ? ', a checkout of the same repository' : plan.preflight.resolvedBy === 'path_map' ? ', by your path map' : ''}.
                </span>
              </p>
            )}
            {(blocking.length > 0 || warnings.length > 0) && (
              <ul className="continue-list">
                {[...blocking, ...warnings].map((r) => (
                  <li key={r.code} className={r.blocking ? 'form-error' : undefined}>
                    {r.message}
                  </li>
                ))}
              </ul>
            )}
            {warnings.length > 0 && blocking.length === 0 && (
              <label className="check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>Move it anyway</span>
              </label>
            )}
          </>
        )}
        {moving && (
          <p className={moving.state === 'failed' ? 'form-error' : 'hint'} role="status">
            {moving.state === 'completed' ? `Moved to ${moving.peer}. It's in History there, ready to resume.` : moving.state === 'failed' ? `It stopped: ${moving.error ?? 'unknown error'}` : moving.state === 'cancelled' ? 'Cancelled; nothing stays on the other host.' : (STEP[moving.state] ?? moving.state)}
          </p>
        )}
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          {moving?.state === 'failed' && (
            <>
              <button type="button" className="btn ghost" onClick={() => void client.moveCancel(moving.id).then(setMoving, (e) => setError(errorText(e)))}>
                Cancel the move
              </button>
              <button type="button" className="btn primary" onClick={() => void client.moveRetry(moving.id).then(setMoving, (e) => setError(errorText(e)))}>
                Retry
              </button>
            </>
          )}
          {moving?.state === 'completed' ? (
            <button type="button" className="btn primary" onClick={() => onMoved(moving.peer, moving.destUid!)}>
              Resume on {moving.peer}
            </button>
          ) : !moving ? (
            <>
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <ConfirmButton type="submit" className="btn primary" disabled={!plan || blocking.length > 0 || (warnings.length > 0 && !confirmed)}>
                Move to {to}
              </ConfirmButton>
            </>
          ) : null}
        </div>
      </form>
    </dialog>
  );
}
