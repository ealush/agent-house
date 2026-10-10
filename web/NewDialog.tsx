import { useEffect, useRef, useState } from 'react';
import type { HostApi, SendResult, State } from './api.ts';
import { showError } from './ask.tsx';
import { look } from './agents.ts';
import { AgentLogo } from './logos.tsx';
import { ModelPicker, Popover, effectiveModel, effortsFor, type Pick } from './ModelPicker.tsx';

type Props = {
  /** Online machines; starting "here or there" is the same code path (F4). */
  hosts: string[];
  initialHost: string;
  hostState: (host: string) => State | null;
  clientFor: (host: string) => HostApi;
  /** Prefill the directory, e.g. from the currently selected window. */
  initialCwd: string;
  /** First message, sent once the session is up. Send to… fills this in. */
  initialPrompt?: string;
  onClose: () => void;
  onCreated: (host: string, id: string, uid: string) => void;
  /** Queue flash for that first message. */
  onSent?: (r: SendResult) => void;
};

const NEW_SESSION = '\u0000new';

type Remembered = { mode?: string; model?: string; effort?: string };
const memKey = (preset: string) => `ah.launch.${preset}`;
function remembered(preset: string): Remembered {
  try {
    return JSON.parse(localStorage.getItem(memKey(preset)) ?? '{}');
  } catch {
    return {};
  }
}

export function NewDialog({ hosts, initialHost, hostState, clientFor, initialCwd, initialPrompt = '', onClose, onCreated, onSent }: Props) {
  const [host, setHost] = useState(initialHost);
  const state = hostState(host) ?? hostState(hosts[0])!;
  const client = clientFor(host);
  const presets = state.presets.filter((p) => p.available);
  const [presetId, setPresetId] = useState(() => localStorage.getItem('ah.lastPreset') ?? presets[0]?.id ?? 'shell');
  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  const [cwd, setCwd] = useState(initialCwd);
  const [label, setLabel] = useState('');
  const [session, setSession] = useState(state.sessions.includes(state.defaultSession) ? state.defaultSession : (state.sessions[0] ?? NEW_SESSION));
  const [newSession, setNewSession] = useState(state.sessions.length ? '' : state.defaultSession);
  const [resume, setResume] = useState(false);
  const [worktree, setWorktree] = useState(false);
  const [mode, setMode] = useState('default');
  const [pick, setPick] = useState<Pick>({});
  const [prompt, setPrompt] = useState(initialPrompt);
  const [extraArgs, setExtraArgs] = useState('');
  const [more, setMore] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    client.projects().then(setProjects).catch(() => setProjects([]));
  }, [host]);

  // Per-agent memory of the last launch choices. A dangerous mode is never restored.
  useEffect(() => {
    if (!preset) return;
    const mem = remembered(preset.id);
    const m = preset.modes?.find((x) => x.id === mem.mode);
    setMode(m && !m.dangerous ? m.id : 'default');
    const model = effectiveModel(preset, mem.model);
    const rememberedModel = preset.models?.some((m) => m.id === mem.model) || (preset.modelArgs && /^[A-Za-z0-9][\w.:/@-]{0,79}$/.test(mem.model ?? ''));
    setPick({ model: rememberedModel ? mem.model : undefined, effort: mem.effort && effortsFor(preset, model).includes(mem.effort) ? mem.effort : undefined });
    setExtraArgs('');
    setResume(false);
  }, [host, preset?.id]);

  const modes = preset?.modes ?? [];
  const models = preset?.models ?? [];
  const isShell = preset?.id === 'shell' || !preset?.command;
  const activeMode = modes.find((m) => m.id === mode);
  const chosen = preset ? effectiveModel(preset, pick.model) : undefined;
  const levels = preset ? effortsFor(preset, chosen) : [];
  const recent = projects.slice(0, 6);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!preset) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('ah.lastPreset', preset.id);
      localStorage.setItem(memKey(preset.id), JSON.stringify({ mode, model: pick.model, effort: pick.effort }));
      // Only send what differs from the harness's own defaults: fewer flags, same result.
      const model = pick.model && pick.model !== preset.defaultModel ? pick.model : undefined;
      const eff = pick.effort && (pick.effort !== preset.defaultEffort || model) ? pick.effort : undefined;
      const { id, uid } = await client.create({
        preset: preset.id,
        cwd,
        label,
        session: session === NEW_SESSION ? newSession : session,
        worktree,
        resume: resume && !!preset.resume,
        ...(mode !== 'default' ? { mode } : {}),
        ...(model ? { model } : {}),
        ...(eff ? { effort: eff } : {}),
        ...(extraArgs.trim() ? { extraArgs: extraArgs.trim() } : {}),
      });
      const first = prompt.trim();
      let sent: SendResult | null = null;
      let sendError: unknown = null;
      if (first) {
        try {
          sent = await client.send(uid, first, true);
        } catch (err) {
          sendError = err;
        }
      }
      onCreated(host, id, uid);
      if (sent) onSent?.(sent);
      if (sendError) showError(sendError, 'Session started. The first message did not send.');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog new-session" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2>New session</h2>
          {hosts.length > 1 && (
            <div className="seg" role="radiogroup" aria-label="Machine">
              {hosts.map((h) => (
                <button type="button" key={h} role="radio" aria-checked={h === host} className={h === host ? 'on' : ''} onClick={() => setHost(h)}>
                  {h}
                </button>
              ))}
            </div>
          )}
        </header>

        <div className="agents" role="radiogroup" aria-label="Agent">
          {presets.map((p) => (
            <button
              type="button"
              key={p.id}
              role="radio"
              aria-checked={p.id === preset?.id}
              className={`agent-pill ${p.id === preset?.id ? 'on' : ''}`}
              style={{ '--agent': look(p.id).color } as React.CSSProperties}
              onClick={() => setPresetId(p.id)}
            >
              <span className="chip sm">
                <AgentLogo id={p.id} size={13} />
              </span>
              {p.name}
            </button>
          ))}
        </div>

        <label className="field">
          <span>Project</span>
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
                      footer={
                        <>
                          <span>Default</span>
                          <span>
                            {models.find((m) => m.isDefault)?.name ?? 'the agent’s own'}
                            {preset.defaultEffort ? ` · ${preset.defaultEffort}` : ''}
                          </span>
                        </>
                      }
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
                  {levels.map((level) => <option key={level} value={level}>{level}</option>)}
                </select>
              </label>
            )}
            {modes.length > 1 && (
              <div className="field compact">
                <span>{isShell ? 'Shell' : 'Permissions'}</span>
                <div className="seg modes" role="radiogroup" aria-label={isShell ? 'Shell' : 'Permissions'}>
                  {modes.map((m) => (
                    <button type="button" key={m.id} role="radio" aria-checked={m.id === mode} title={m.description} className={`${m.id === mode ? 'on' : ''} ${m.dangerous ? 'danger' : ''}`} onClick={() => setMode(m.id)}>
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

        <label className="field">
          <span>Prompt</span>
          <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={initialPrompt ? 8 : 3} placeholder="Optional. Sent once the session starts." />
        </label>

        <button type="button" className="disclosure" aria-expanded={more} onClick={() => setMore(!more)}>
          <span aria-hidden>{more ? '▾' : '▸'}</span> More options
          {!more && (label || worktree || resume || extraArgs || session !== state.defaultSession) && <span className="dim"> · changed</span>}
        </button>
        {more && (
          <div className="more">
            <div className="fields">
              <label className="field">
                <span>Name</span>
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={preset?.command ? preset.id : 'shell'} maxLength={80} />
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
                Isolated git worktree <span className="hint">— its own branch and checkout</span>
              </span>
            </label>
            {preset?.resume && (
              <label className="check">
                <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
                <span>
                  Continue the last conversation in this folder <span className="hint">— {preset.resume}</span>
                </span>
              </label>
            )}
            {!isShell && (
              <label className="field">
                <span>Additional arguments</span>
                <input value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder="--flag value" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={2048} />
              </label>
            )}
          </div>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={`btn ${activeMode?.dangerous ? 'danger-solid' : 'primary'}`}
            disabled={busy || !preset}
          >
            {busy ? 'Starting…' : `Start ${preset?.name ?? ''}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
