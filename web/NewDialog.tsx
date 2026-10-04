import { useEffect, useRef, useState } from 'react';
import { api, type State } from './api.ts';
import { look } from './agents.ts';

type Props = {
  state: State;
  /** Prefill the directory, e.g. from the currently selected window. */
  initialCwd: string;
  onClose: () => void;
  onCreated: (id: string) => void;
};

const NEW_SESSION = '\u0000new';

export function NewDialog({ state, initialCwd, onClose, onCreated }: Props) {
  const presets = state.presets.filter((p) => p.available);
  const [preset, setPreset] = useState(() => localStorage.getItem('ah.lastPreset') ?? presets[0]?.id ?? 'shell');
  const [cwd, setCwd] = useState(initialCwd);
  const [label, setLabel] = useState('');
  const [session, setSession] = useState(state.sessions.includes(state.defaultSession) ? state.defaultSession : state.sessions[0] ?? NEW_SESSION);
  const [newSession, setNewSession] = useState(state.sessions.length ? '' : state.defaultSession);
  const [resume, setResume] = useState(false);
  const [worktree, setWorktree] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialog.current?.showModal();
    api.projects().then(setProjects).catch(() => {});
  }, []);

  const current = presets.find((p) => p.id === preset) ?? presets[0];
  const recent = projects.slice(0, 8);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('ah.lastPreset', current.id);
      const { id } = await api.create({
        preset: current.id,
        cwd,
        label,
        session: session === NEW_SESSION ? newSession : session,
        worktree,
        resume: resume && !!current.resume,
      });
      onCreated(id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <form onSubmit={submit}>
        <h2>New session</h2>

        <fieldset className="presets">
          <legend>Run</legend>
          {presets.map((p) => {
            const { color, glyph } = look(p.id);
            return (
              <label key={p.id} className={`preset ${p.id === current?.id ? 'on' : ''}`} style={{ '--agent': color } as React.CSSProperties}>
                <input type="radio" name="preset" value={p.id} checked={p.id === current?.id} onChange={() => setPreset(p.id)} />
                <span className="chip">{glyph}</span>
                <span>{p.name}</span>
              </label>
            );
          })}
        </fieldset>

        <label className="field">
          <span>Directory</span>
          <input value={cwd} onChange={(e) => setCwd(e.target.value)} list="ah-projects" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="~/code/project" />
          <datalist id="ah-projects">
            {projects.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        {recent.length > 0 && (
          <div className="suggestions">
            {recent.map((p) => (
              <button type="button" key={p} className={`sugg ${p === cwd ? 'on' : ''}`} onClick={() => setCwd(p)}>
                {p.split('/').pop() || p}
              </button>
            ))}
          </div>
        )}

        <div className="row">
          <label className="field">
            <span>Name</span>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={current?.command ? current.id : 'shell'} maxLength={80} />
          </label>
          <label className="field">
            <span>tmux session</span>
            <select value={session} onChange={(e) => setSession(e.target.value)}>
              {state.sessions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
              <option value={NEW_SESSION}>New session…</option>
            </select>
          </label>
        </div>
        {session === NEW_SESSION && (
          <label className="field">
            <span>New session name</span>
            <input value={newSession} onChange={(e) => setNewSession(e.target.value)} required autoCapitalize="off" />
          </label>
        )}

        <label className="check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
          <span>
            Isolated git worktree <span className="hint">— new branch, so agents don't edit the same checkout</span>
          </span>
        </label>

        {current?.resume && (
          <label className="check">
            <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
            <span>
              Continue the last conversation here <code>{current.resume}</code>
            </span>
          </label>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={busy || !current}>
            {busy ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
