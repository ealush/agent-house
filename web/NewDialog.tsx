import { radioGridMove } from './rove.ts';
import { bareProject } from './projectPath.ts';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import { Icon } from './icons.tsx';
import type { DirState, HostApi, Preset, SendResult, State } from './api.ts';
import { showError } from './ask.tsx';
import { frontAgents, look } from './agents.ts';
import { AgentLogo } from './logos.tsx';
import { Glide } from './Glide.tsx';
import { EffortPicker, ModelPicker, Popover, effectiveModel, effortsFor, type Pick } from './ModelPicker.tsx';
import { SheetBar, useSheet } from './sheet.tsx';
import { errorText } from './errors.ts';

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
  /** Preselect an agent (Continue in…). */
  initialPreset?: string;
  /** Opened as "New project": start by naming a new folder in the projects root. */
  newProject?: boolean;
  onClose: () => void;
  /** Phones: a full screen inside the app shell (its own scrolling), not a modal over it. */
  screen?: boolean;
  onCreated: (host: string, id: string, uid: string) => void;
  /** Queue flash for that first message. */
  onSent?: (r: SendResult) => void;
};

const NEW_SESSION = '\u0000new';

/** Why the typed path can't be used; a new folder gets its own row instead. */
const DIR_PROBLEM: Partial<Record<DirState, string>> = {
  file: 'That’s a file, not a folder.',
  missing: 'No such folder. A new one goes inside a folder that exists.',
  outside: 'ah creates folders only inside the browsable folders (files.roots in the config).',
};

type Remembered = { mode?: string; model?: string; effort?: string };
const memKey = (preset: string) => `ah.launch.${preset}`;
function remembered(preset: string): Remembered {
  try {
    return JSON.parse(localStorage.getItem(memKey(preset)) ?? '{}');
  } catch {
    return {};
  }
}

/** Where the last session on `host` was started from this device: the default when nothing nearer is open. */
export function lastCwd(host: string): string {
  try {
    return localStorage.getItem(`ah.lastCwd.${host}`) || '~';
  } catch {
    return '~';
  }
}

/** The project of the most recently active session, if any has one. */
export function newestProject(windows: Array<{ activity: number; projectPath?: string | null }>): string | null {
  const w = [...windows].filter((x) => x.projectPath).sort((a, b) => b.activity - a.activity)[0];
  return w?.projectPath ?? null;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How many agents get a button of their own; the rest wait in the menu beside them. */
const FRONT = 3;
const USE_KEY = 'ah.agentUse';

/** Sessions started per agent from this device. */
function launches(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(USE_KEY) ?? '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function countLaunch(id: string) {
  try {
    const use = launches();
    localStorage.setItem(USE_KEY, JSON.stringify({ ...use, [id]: (use[id] ?? 0) + 1 }));
  } catch {
    // private mode: the order just doesn't learn
  }
}


export function NewDialog({ hosts, initialHost, hostState, clientFor, initialCwd, initialPrompt = '', initialPreset, newProject = false, onClose, onCreated, onSent, screen = false }: Props) {
  const [host, setHost] = useState(initialHost);
  const state = hostState(host) ?? hostState(hosts[0])!;
  const client = clientFor(host);
  // What's installed here, less what Settings → Agents keeps out of the way.
  const presets = state.presets.filter((p) => p.available && !p.hidden);
  // Shell or agent first; then which agent: the most used have buttons, the rest a menu.
  const shellPreset = presets.find((p) => !p.command);
  const agents = presets.filter((p) => p.command);
  const [use] = useState(launches);
  const front = frontAgents(agents, state.windows.map((w) => w.agent), use, FRONT);
  // What you used last; on a device that has never started anything, an agent (the most used
  // here, or one running on the host), since agents are what ah is for. Shell is one tap away.
  const [presetId, setPresetId] = useState(() => initialPreset ?? localStorage.getItem('ah.lastPreset') ?? front[0]?.id ?? presets[0]?.id ?? 'shell');
  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  const rest = agents.filter((a) => !front.includes(a));
  const [lastAgent, setLastAgent] = useState(() => (preset?.command ? preset.id : (localStorage.getItem('ah.lastAgent') ?? front[0]?.id)));
  const pickAgent = (id: string) => {
    setPresetId(id);
    setLastAgent(id);
  };
  // Nothing to go on (no focused session, nothing started from this device): the project of
  // the session that was active last, rather than the home folder.
  const [cwd, setCwd] = useState(() => (newProject ? '' : initialCwd === '~' ? (newestProject(state.windows) ?? '~') : initialCwd));
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
  // What the typed path is, for the host it was asked of; `root` is where new projects go.
  const [place, setPlace] = useState<{ host: string; cwd: string; state: DirState } | null>(null);
  const [root, setRoot] = useState<string | null>(null);
  const [gitInit, setGitInit] = useState(() => localStorage.getItem('ah.newGit') !== '0');
  const cwdInput = useRef<HTMLInputElement>(null);
  const caretToEnd = useRef(false);
  const projectPending = useRef(newProject);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const screenRef = useRef<HTMLElement>(null);
  const { dismiss } = useSheet(screen ? screenRef : dialog, onClose);

  // A screen is no dialog, so nothing moves the keyboard into it: start on the agent
  // chosen, where the arrows pick another (and never on the page underneath). Once.
  // No agent to choose (none installed): the Project field, or with a finger, where a
  // field would raise the on-screen keyboard, the screen itself, so Tab starts inside it.
  useEffect(() => {
    if (!screen) return;
    const raf = requestAnimationFrame(() => {
      const box = screenRef.current;
      const finger = document.documentElement.hasAttribute('data-touch');
      const to = box?.querySelector<HTMLElement>('[data-autofocus]') ?? (finger ? null : cwdInput.current) ?? box;
      to?.focus({ preventScroll: true });
      // Its folder is a suggestion, selected as a Mac dialog's field is: typing replaces it.
      if (to === cwdInput.current) cwdInput.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, []);
  useEffect(() => {
    if (!screen) {
      dialog.current?.showModal();
      return;
    }
    // A screen has no dialog to catch Escape, and focus may be anywhere: listen
    // on the window, after anything open inside it (a picker) had its turn.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [screen, onClose]);
  useEffect(() => {
    client.projects().then(setProjects).catch(() => setProjects([]));
    setRoot(null);
  }, [host]);
  // A bare name that is one of the chips' projects ("acme-web") means that project, not
  // a folder of that name in the home directory: check and start there, chip lit.
  const path = bareProject(cwd, projects) ?? cwd;
  useEffect(() => {
    let live = true;
    const check = () =>
      client
        .dir(path)
        .then((d) => {
          if (!live) return;
          setPlace({ host, cwd: path, state: d.state });
          setRoot(d.root);
          // New project: once the host says where projects live, prefill it and wait for a name.
          if (projectPending.current) {
            projectPending.current = false;
            caretToEnd.current = true;
            setCwd(`${d.root.replace(/\/$/, '')}/`);
          }
        })
        .catch(() => live && setPlace(null)); // an older peer can't say
    const t = setTimeout(check, place ? 150 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [host, path]);

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
  // Shown: the last answer for this host, kept while the next check is in flight so nothing flickers.
  // Acted on: only an answer for exactly what is typed.
  const shown = place?.host === host ? place.state : null;
  const known = place?.host === host && place.cwd === path ? place.state : null;
  const isNew = shown === 'new';
  const trimmed = path.trim().replace(/\/+$/, '');
  const newName = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const newParent = trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
  const naming = !!root && cwd === `${root.replace(/\/$/, '')}/`;

  function newFolder() {
    if (!root) return;
    caretToEnd.current = true;
    setCwd(`${root.replace(/\/$/, '')}/`);
  }
  // After the prefill lands, before the next keystroke: focus with the caret after the slash.
  useLayoutEffect(() => {
    const input = cwdInput.current;
    if (!caretToEnd.current || !input) return;
    caretToEnd.current = false;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [cwd]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!preset) return;
    setBusy(true);
    setError(null);
    try {
      // Pressed Start before the path was checked: if it means a new folder, say so first.
      let state = known;
      if (!state) {
        state = (await client.dir(path).catch(() => null))?.state ?? null;
        if (state) setPlace({ host, cwd: path, state });
        if (state === 'new') {
          setBusy(false);
          return;
        }
      }
      const create = state === 'new';
      localStorage.setItem('ah.lastPreset', preset.id);
      if (preset.command) {
        localStorage.setItem('ah.lastAgent', preset.id);
        countLaunch(preset.id);
      }
      localStorage.setItem(`ah.lastCwd.${host}`, path);
      if (create) localStorage.setItem('ah.newGit', gitInit ? '1' : '0');
      localStorage.setItem(memKey(preset.id), JSON.stringify({ mode, model: pick.model, effort: pick.effort }));
      // Only send what differs from the harness's own defaults: fewer flags, same result.
      const model = pick.model && pick.model !== preset.defaultModel ? pick.model : undefined;
      const eff = pick.effort && (pick.effort !== preset.defaultEffort || model) ? pick.effort : undefined;
      const { id, uid } = await client.create({
        preset: preset.id,
        cwd: path,
        ...(create ? { create: true, git: gitInit } : {}),
        label,
        session: session === NEW_SESSION ? newSession : session,
        worktree: worktree && !create,
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
      setError(errorText(err));
      setBusy(false);
    }
  }

  const form = (
      <form onSubmit={submit}>
        <header className="ns-head">
          {screen && (
            <button type="button" className="icon-btn ns-back" onClick={onClose} aria-label="Back">
              <Icon name="back" size={22} />
            </button>
          )}
          <h2>{newProject || isNew || naming ? 'New project' : 'New session'}</h2>
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

        <div className="ns-body">
        {shellPreset && agents.length > 0 && (
          <div
            className="seg kind"
            role="radiogroup"
            aria-label="Start"
            onKeyDown={(e) => {
              if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
              const next = radioGridMove(e.currentTarget, e.target as HTMLElement, e.key);
              if (!next || next === e.target) return;
              e.preventDefault();
              next.focus();
              next.click();
            }}
          >
            <Glide match=".on" className="thumb" />
            <button
              type="button"
              role="radio"
              aria-checked={isShell}
              className={isShell ? 'on' : ''}
              data-autofocus={isShell || undefined}
              tabIndex={isShell ? 0 : -1}
              onClick={() => setPresetId(shellPreset.id)}
            >
              <AgentLogo id="shell" size={15} />
              Shell
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!isShell}
              className={isShell ? '' : 'on'}
              tabIndex={isShell ? -1 : 0}
              // Focus starts on the agent chosen; on this when that one waits in the menu.
              data-autofocus={(!isShell && !front.some((p) => p.id === preset?.id)) || undefined}
              onClick={() => setPresetId(agents.find((a) => a.id === lastAgent)?.id ?? front[0].id)}
            >
              <Icon name="sparkle" size={15} />
              Agent
            </button>
          </div>
        )}
        {!isShell && agents.length > 0 && (
          <div className="agent-pick">
            <div
              className="agents"
              role="radiogroup"
              aria-label="Agent"
              onKeyDown={(e) => {
                // A radio group: the arrows move across the agents and choose as they go. The
                // menu's button takes focus without opening; its open menu has arrows of its own.
                if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.target as HTMLElement).closest('.popover')) return;
                const next = radioGridMove(e.currentTarget, e.target as HTMLElement, e.key);
                if (!next || next === e.target) return;
                e.preventDefault();
                next.focus();
                if (next.getAttribute('role') === 'radio') next.click();
              }}
            >
              {front.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  role="radio"
                  aria-checked={p.id === preset?.id}
                  className={`agent-pill ${p.id === preset?.id ? 'on' : ''}`}
                  data-autofocus={p.id === preset?.id || undefined}
                  // One Tab stop for the group, on the chosen agent; the arrows move within it.
                  tabIndex={p.id === preset?.id ? 0 : -1}
                  style={{ '--agent': look(p.id).color } as React.CSSProperties}
                  onClick={() => pickAgent(p.id)}
                >
                  <span className="chip sm">
                    <AgentLogo id={p.id} size={13} />
                  </span>
                  {p.name}
                </button>
              ))}
              {rest.length > 0 && <MoreAgents agents={rest} chosen={rest.find((p) => p.id === preset?.id)} onPick={pickAgent} />}
            </div>
          </div>
        )}

        <label className="field">
          <span>Project</span>
          <span className="path-field">
            <input className="mono" ref={cwdInput} value={cwd} onChange={(e) => setCwd(e.target.value)} list="ah-projects" autoCapitalize="off" autoCorrect="off" spellCheck={false} placeholder="~/code/project" />
            {/* At rest, a path too long for the field shows its end, the folder it names ("…/code/acme"). */}
            {cwd && (
              <span className="path-tail mono" aria-hidden>
                <bdi>{cwd}</bdi>
              </span>
            )}
          </span>
          <datalist id="ah-projects">
            {projects.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        {(recent.length > 0 || root) && (
          <div className="suggestions">
            {recent.map((p) => (
              <button type="button" key={p} className={`sugg project ${p === path ? 'on' : ''}`} title={p} onClick={() => setCwd(p)}>
                {p.split('/').pop() || p}
              </button>
            ))}
            {root && (
              <button type="button" className={`sugg add ${naming || isNew ? 'on' : ''}`} onClick={newFolder}>
                <Icon name="plus" size={12} />
                New folder
              </button>
            )}
          </div>
        )}
        {isNew ? (
          <div className="new-dir">
            <Icon name="folder-plus" size={16} />
            <span className="grow">
              Creates <b>{newName}</b> in {newParent}
            </span>
            <label className="check">
              <input type="checkbox" switch="" checked={gitInit} onChange={(e) => setGitInit(e.target.checked)} />
              <span>git init</span>
            </label>
          </div>
        ) : naming ? (
          <p className="hint dir-note">Type a name for the new folder.</p>
        ) : (
          shown && DIR_PROBLEM[shown] && <p className="hint dir-note">{DIR_PROBLEM[shown]}</p>
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
              <div className="field compact">
                <span>Effort</span>
                {/* The same kind of control as Model beside it, not a native select. */}
                <Popover
                  up={false}
                  className="select-btn"
                  label={
                    <>
                      <span className="grow">{pick.effort ? cap(pick.effort) : `Default${preset.defaultEffort ? ` · ${preset.defaultEffort}` : ''}`}</span>
                      <Icon name="chevron-down" size={14} />
                    </>
                  }
                >
                  {(close) => (
                    <EffortPicker
                      levels={levels}
                      value={pick.effort}
                      onPick={(effort) => {
                        setPick({ ...pick, effort });
                        close();
                      }}
                    />
                  )}
                </Popover>
              </div>
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
          <textarea className="prose" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={initialPrompt ? 8 : 3} placeholder="Optional. Sent once the session starts." />
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
            {!isNew && (
              <label className="check">
                <input type="checkbox" switch="" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} />
                <span>
                  Isolated git worktree <span className="hint">— its own branch and checkout</span>
                </span>
              </label>
            )}
            {preset?.resume && (
              <label className="check">
                <input type="checkbox" switch="" checked={resume} onChange={(e) => setResume(e.target.checked)} />
                <span>
                  Continue the last conversation in this folder <span className="hint">— {preset.resume}</span>
                </span>
              </label>
            )}
            {!isShell && (
              <label className="field">
                <span>Additional arguments</span>
                <input className="mono" value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} placeholder="--flag value" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={2048} />
              </label>
            )}
          </div>
        )}

        {error && <p className="form-error">{error}</p>}
        </div>

        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <ConfirmButton
            type="submit"
            className={`btn ${activeMode?.dangerous ? 'danger-solid' : 'primary'}`}
            disabled={busy || !preset}
          >
            {busy ? 'Starting…' : `${isNew ? 'Create & start' : 'Start'} ${preset?.name ?? ''}`}
          </ConfirmButton>
        </div>
      </form>
  );

  if (screen)
    return (
      <section ref={screenRef} className="ns-screen new-session" aria-label="New session" tabIndex={-1} data-confirm data-focus-owner>
        <SheetBar onClose={dismiss} />
        {form}
      </section>
    );

  return (
    <dialog ref={dialog} className="dialog new-session" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      {form}
    </dialog>
  );
}

/** The agents used less: one button, showing the chosen one when it's among them, and a menu of the rest. */
function MoreAgents({ agents, chosen, onPick }: { agents: Preset[]; chosen?: Preset; onPick: (id: string) => void }) {
  return (
    <div className="more-agents" style={{ '--agent': look(chosen?.id ?? null).color } as React.CSSProperties}>
      <Popover
        up={false}
        align="right"
        title="More agents"
        // Part of the agents' one Tab stop: reached by the arrows, unless it holds the agent chosen.
        tabIndex={chosen ? 0 : -1}
        className={`agent-pill others ${chosen ? 'on' : ''}`}
        label={
          <>
            {chosen && (
              <span className="chip sm">
                <AgentLogo id={chosen.id} size={13} />
              </span>
            )}
            <span className="grow">{chosen ? chosen.name : `${agents.length} more`}</span>
            <Icon name="chevron-down" size={14} />
          </>
        }
      >
        {(close) => (
          <div className="picker" aria-label="More agents">
            <div className="picker-title">More agents</div>
            {agents.map((a) => (
              <button
                type="button"
                key={a.id}
                className="picker-name agent-option"
                onClick={() => {
                  onPick(a.id);
                  close();
                }}
              >
                <span className="chip sm" style={{ '--agent': look(a.id).color } as React.CSSProperties}>
                  <AgentLogo id={a.id} size={13} />
                </span>
                {a.name}
                {a.id === chosen?.id && <span className="check">✓</span>}
              </button>
            ))}
          </div>
        )}
      </Popover>
    </div>
  );
}
