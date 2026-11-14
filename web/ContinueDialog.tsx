import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { ApiError, type ContinuePlan, type HostApi } from './api.ts';
import { SheetBar, useSheet } from './sheet.tsx';
import { errorText } from './errors.ts';
import { look } from './agents.ts';
import { Icon } from './icons.tsx';
import { ModelPicker, Popover, effectiveModel, effortsFor, usePreset, type Pick } from './ModelPicker.tsx';

export type ContinueTarget = { ref: string; host: string; harness: string | null; title: string };

type Props = {
  client: HostApi;
  target: ContinueTarget;
  /** The agent to continue in (a preset id). */
  to: string;
  onClose: () => void;
  /** The host predates portable conversations: the caller falls back to its own hand-off. */
  onUnsupported: () => void;
  /** The new session's uid on the target host. */
  onContinued: (uid: string) => void;
};

/**
 * Continue in (server/portable): before anything starts, the host says what moves
 * to the other agent and what doesn't, in plain words: a native copy where the
 * agent's own history can carry it, else a record reconstructed from the transcript.
 */
export function ContinueDialog({ client, target, to, onClose, onUnsupported, onContinued }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [plan, setPlan] = useState<ContinuePlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [worktree, setWorktree] = useState(false);
  /** The destination's model and effort, from its catalog (its defaults when unset). */
  const [pick, setPick] = useState<Pick>({});
  const preset = usePreset(target.host, to);
  const models = preset?.models ?? [];
  const chosen = preset ? effectiveModel(preset, pick.model) : undefined;
  const levels = preset ? effortsFor(preset, chosen) : [];
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per dialog: a double tap or a retried request continues once.
  const key = useRef(`web:${crypto.randomUUID()}`);
  const dest = look(to).name;
  const from = look(target.harness).name;

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    let live = true;
    setPlan(null);
    client
      .continuePreview(target.ref, { to, worktree, ...choice() })
      .then((p) => live && setPlan(p))
      .catch((e) => {
        if (!live) return;
        // An older host has no such route (a 404 without ah's own reason code).
        if (e instanceof ApiError && e.status === 404 && !e.code) return onUnsupported();
        setLoadError(errorText(e));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.ref, to, worktree, pick.model, pick.effort]);

  function choice() {
    return { ...(pick.model ? { model: pick.model } : {}), ...(pick.effort ? { effort: pick.effort } : {}) };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await client.continueIn(target.ref, { to, worktree, ...choice(), idempotencyKey: key.current });
      if (out.operation.childUid) onContinued(out.operation.childUid);
      else onClose();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog new-session" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2>Continue in {dest}</h2>
        </header>
        {loadError && <p className="form-error">{loadError}</p>}
        {!plan && !loadError && <p className="hint">Reading the conversation…</p>}
        {plan?.blocked && (
          <>
            <p>{plan.blocked.message}</p>
            <div className="actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
        {plan && !plan.blocked && (
          <>
            <p className="hint">
              “{target.title}” in {from} goes on in a new {dest} session{plan.destination.worktree ? ' in its own worktree' : ' in the same folder'}.
            </p>
            <ul className="continue-list">
              {plan.transfers.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            {plan.limitations.length > 0 && (
              <details className="continue-limits">
                <summary>What doesn't carry over ({plan.limitations.length})</summary>
                <ul>
                  {plan.limitations.map((l) => (
                    <li key={l.code}>{l.message}</li>
                  ))}
                </ul>
              </details>
            )}
            {preset && (models.length > 0 || levels.length > 0) && (
              <div className="launch-row">
                {models.length > 0 && (
                  <div className="field compact">
                    <span>Model</span>
                    <Popover
                      up={false}
                      className="select-btn"
                      label={
                        <>
                          <span className="grow">{chosen?.name ?? 'Default'}</span>
                          <Icon name="chevron-down" size={14} />
                        </>
                      }
                    >
                      {(close) => (
                        <ModelPicker
                          preset={preset}
                          value={pick}
                          onPick={(p) => {
                            setPick(p);
                            close();
                          }}
                        />
                      )}
                    </Popover>
                  </div>
                )}
                {levels.length > 0 && (
                  <label className="field compact">
                    <span>Effort</span>
                    <select aria-label="Reasoning effort" value={pick.effort ?? ''} onChange={(e) => setPick({ ...pick, effort: e.target.value || undefined })}>
                      <option value="">Default{preset.defaultEffort ? ` · ${preset.defaultEffort}` : ''}</option>
                      {levels.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            <label className="check">
              <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
              <span>Its own worktree and branch (both sessions can keep working)</span>
            </label>
            {error && <p className="form-error">{error}</p>}
            <div className="actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <ConfirmButton type="submit" className="btn primary" disabled={busy}>
                Continue in {dest}
              </ConfirmButton>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}
