import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import type { ForkInfo, HostApi, Win } from './api.ts';
import { ModelPicker, Popover, effectiveModel, effortsFor, usePreset, type Pick } from './ModelPicker.tsx';
import { SheetBar, useSheet } from './sheet.tsx';

export type ForkTarget = { ref: string; host: string; harness: string | null; title: string };

type Props = {
  client: HostApi;
  target: ForkTarget;
  onClose: () => void;
  /** The new session's window id on the target host. */
  onForked: (uid: string) => void;
};

/**
 * Fork (F36): copy the conversation into a fresh worktree session. Model,
 * effort and permission mode are inherited from the parent and shown, so a
 * dangerous mode is never inherited silently.
 */
export function ForkDialog({ client, target, onClose, onForked }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [info, setInfo] = useState<ForkInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState('default');
  const [pick, setPick] = useState<Pick>({});
  const [inherited, setInherited] = useState<Pick>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preset = usePreset(target.host, target.harness);

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    let live = true;
    client
      .forkInfo(target.ref)
      .then((i) => {
        if (!live) return;
        setInfo(i);
        setName(i.suggestedName);
        setMode(i.mode ?? 'default');
        const inh = { model: i.model ?? undefined, effort: i.effort ?? undefined };
        setPick(inh);
        setInherited(inh);
      })
      .catch((e) => live && setLoadError((e as Error).message));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.ref]);

  const modes = preset?.modes ?? [];
  const models = preset?.models ?? [];
  const activeMode = modes.find((m) => m.id === mode);
  const chosen = preset ? effectiveModel(preset, pick.model) : undefined;
  const levels = preset ? effortsFor(preset, chosen) : [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const out = await client.fork(target.ref, {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        ...(modes.length > 1 ? { mode } : {}),
        ...(pick.model !== inherited.model ? { model: pick.model ?? 'default' } : {}),
        ...(pick.effort !== inherited.effort ? { effort: pick.effort ?? 'default' } : {}),
      });
      onForked(out.uid);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog new-session" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2>Fork session</h2>
        </header>
        {loadError && <p className="form-error">{loadError}</p>}
        {!info && !loadError && <p className="hint">Checking the session…</p>}
        {info && !info.canFork && (
          <>
            <p>{info.reason}</p>
            <div className="actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
        {info?.canFork && (
          <>
            <p className="hint">
              Copies “{info.title}” into its own worktree on a new branch, from {info.branch ?? 'HEAD'} @ {info.head}. The original keeps running untouched.
            </p>
            {info.dirty > 0 && (
              <p className="warn">
                Parent has {info.dirty} uncommitted change{info.dirty === 1 ? '' : 's'}; the fork starts from the last commit ({info.head}).
              </p>
            )}
            {info.busy && <p className="hint">The parent is working; the fork will start when its current turn ends.</p>}
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoCapitalize="off" />
            </label>
            <label className="field">
              <span>First message for the fork (optional)</span>
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Take the risky approach: rewrite the parser." />
            </label>
            {preset && (models.length > 0 || preset.modelArgs || levels.length > 0 || modes.length > 1) && (
              <div className="launch-row">
                {(models.length > 0 || preset.modelArgs) && (
                  <div className="field compact">
                    <span>Model</span>
                    <Popover
                      up={false}
                      className="select-btn"
                      label={
                        <>
                          <span className="grow">{chosen?.name ?? 'Default'}</span>
                          <span className="caret" aria-hidden>
                            ▾
                          </span>
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
                {modes.length > 1 && (
                  <div className="field compact">
                    <span>Permissions</span>
                    <div className="seg modes" role="radiogroup" aria-label="Permissions">
                      {modes.map((m) => (
                        <button
                          type="button"
                          key={m.id}
                          role="radio"
                          aria-checked={m.id === mode}
                          title={m.description}
                          className={`${m.id === mode ? 'on' : ''} ${m.dangerous ? 'danger' : ''}`}
                          onClick={() => setMode(m.id)}
                        >
                          {m.dangerous ? '⚠ ' : ''}
                          {m.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            {activeMode?.description && activeMode.id !== 'default' && <p className={activeMode.dangerous ? 'warn' : 'hint'}>{activeMode.description}</p>}
            {error && <p className="form-error">{error}</p>}
            <div className="actions">
              <button type="button" className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <ConfirmButton type="submit" className={`btn ${activeMode?.dangerous ? 'danger-solid' : 'primary'}`} disabled={busy}>
                {busy ? 'Forking…' : 'Fork session'}
              </ConfirmButton>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}

type Line = { key: string; title: string; status: string; branch: string | null; live: boolean; changed: number | null };

/**
 * The fork family of one session (F36): root, parent and sibling lines with
 * their status and branch, so two lines can be compared or opened side by side.
 */
export function ForksDialog({
  client,
  w,
  onClose,
  onOpen,
  onSplitWith,
}: {
  client: HostApi;
  w: Win;
  onClose: () => void;
  onOpen?: (key: string) => void;
  onSplitWith?: (key: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    let live = true;
    client
      .state()
      .then(async (s) => {
        if (!live) return;
        const rootUid = w.fork?.rootUid ?? w.uid;
        const family = s.windows.filter((x) => x.uid === rootUid || x.fork?.rootUid === rootUid || x.uid === w.uid);
        const root = s.history.find((h) => h.ref === rootUid);
        const out: Line[] = family.map((x) => ({ key: x.key, title: x.title, status: x.status, branch: x.branch, live: true, changed: null }));
        if (root && !family.some((x) => x.uid === rootUid)) out.unshift({ key: '', title: root.title, status: 'ended', branch: null, live: false, changed: null });
        setLines(out);
        // Diff sizes are a per-window fetch; fill them in as they land.
        for (const x of family) {
          const ch = await client.changes(x.id).catch(() => null);
          if (!live) return;
          if (ch) setLines((prev) => prev.map((l) => (l.key === x.key ? { ...l, changed: ch.files.length } : l)));
        }
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [w.key]);

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form method="dialog">
        <header className="ns-head">
          <h2>Forks</h2>
        </header>
        {lines.length === 0 && <p className="hint">Loading…</p>}
        <ul className="rows">
          {lines.map((l) => (
            <li key={l.key || l.title}>
              <div className="row quiet">
                <span className="stack">
                  <span className="name">{l.title}</span>
                  <span className="sub">
                    {[l.status, l.branch ? `⎇ ${l.branch}` : null, l.changed != null ? `${l.changed} file${l.changed === 1 ? '' : 's'} changed` : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                {l.live && l.key !== w.key && onOpen && (
                  <button type="button" className="btn small" onClick={() => onOpen(l.key)}>
                    Open
                  </button>
                )}
                {l.live && l.key !== w.key && onSplitWith && (
                  <button type="button" className="btn small ghost" onClick={() => onSplitWith(l.key)}>
                    Open in split
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Close
          </button>
        </div>
      </form>
    </dialog>
  );
}
