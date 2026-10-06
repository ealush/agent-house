import { useEffect, useRef, useState } from 'react';
import type { HostApi, Recipe, State } from './api.ts';
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
  onClose: () => void;
  onCreated: (host: string, id: string) => void;
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

export function NewDialog({ hosts, initialHost, hostState, clientFor, initialCwd, onClose, onCreated }: Props) {
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
  const [extraArgs, setExtraArgs] = useState('');
  const [more, setMore] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  // Fleet recipes (issue #6): launch a wired team instead of a single session.
  const [kind, setKind] = useState<'session' | 'recipe'>('session');
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recipeId, setRecipeId] = useState('');
  const [brief, setBrief] = useState('');
  const [memberModes, setMemberModes] = useState<Record<string, string>>({});
  const recipe = recipes.find((r) => r.id === recipeId) ?? recipes.find((r) => !r.errors?.length) ?? recipes[0];

  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    client.projects().then(setProjects).catch(() => setProjects([]));
  }, [host]);
  useEffect(() => {
    client
      .recipes()
      .then((list) => {
        setRecipes(list);
        setRecipeId((cur) => (list.some((r) => r.id === cur) ? cur : (list.find((r) => !r.errors?.length)?.id ?? list[0]?.id ?? '')));
      })
      .catch(() => setRecipes([]));
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

  useEffect(() => setMemberModes({}), [host, recipe?.id]);

  const modes = preset?.modes ?? [];
  const models = preset?.models ?? [];
  const isShell = preset?.id === 'shell' || !preset?.command;
  const activeMode = modes.find((m) => m.id === mode);
  const chosen = preset ? effectiveModel(preset, pick.model) : undefined;
  const levels = preset ? effortsFor(preset, chosen) : [];
  const recent = projects.slice(0, 6);

  async function submitRecipe() {
    if (!recipe) return;
    if (recipe.errors?.length) {
      setError(`This recipe cannot launch: ${recipe.errors.join('; ')}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const overrides: Record<string, { mode?: string }> = {};
      for (const member of recipe.members) {
        const mode = memberModes[member.key] ?? member.mode ?? undefined;
        if (mode) overrides[member.key] = { mode };
      }
      const out = await client.launchRecipe(recipe.id, {
        cwd,
        brief,
        session: session === NEW_SESSION ? newSession : session,
        ...(Object.keys(overrides).length ? { overrides } : {}),
      });
      const first = out.members[0];
      if (!first) throw new Error('recipe launched no sessions');
      onCreated(host, first.id);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (kind === 'recipe') return submitRecipe();
    if (!preset) return;
    setBusy(true);
    setError(null);
    try {
      localStorage.setItem('ah.lastPreset', preset.id);
      localStorage.setItem(memKey(preset.id), JSON.stringify({ mode, model: pick.model, effort: pick.effort }));
      // Only send what differs from the harness's own defaults: fewer flags, same result.
      const model = pick.model && pick.model !== preset.defaultModel ? pick.model : undefined;
      const eff = pick.effort && (pick.effort !== preset.defaultEffort || model) ? pick.effort : undefined;
      const { id } = await client.create({
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
      onCreated(host, id);
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

        <div className="seg" role="radiogroup" aria-label="What to start">
          <button type="button" role="radio" aria-checked={kind === 'session'} className={kind === 'session' ? 'on' : ''} onClick={() => setKind('session')}>
            Session
          </button>
          <button type="button" role="radio" aria-checked={kind === 'recipe'} className={kind === 'recipe' ? 'on' : ''} onClick={() => setKind('recipe')}>
            Recipe (team)
          </button>
        </div>

        {kind === 'recipe' ? (
          <div className="agents" role="radiogroup" aria-label="Recipe">
            {recipes.length === 0 && <p className="hint">No recipes on this host yet. Add them in Settings, Recipes.</p>}
            {recipes.map((r) => (
              <button
                type="button"
                key={r.id}
                role="radio"
                aria-checked={r.id === recipe?.id}
                className={`agent-pill ${r.id === recipe?.id ? 'on' : ''}`}
                onClick={() => setRecipeId(r.id)}
                title={r.errors?.length ? r.errors.join('; ') : r.description}
              >
                {r.name} · {r.members.length}
                {r.errors?.length ? ' ⚠' : ''}
              </button>
            ))}
          </div>
        ) : (
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
        )}

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

        {kind === 'recipe' && recipe && (
          <>
            {recipe.description && <p className="hint">{recipe.description}</p>}
            {recipe.errors?.length ? <p className="form-error">{recipe.errors.join('; ')}</p> : null}
            <label className="field">
              <span>Brief</span>
              <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} placeholder="What should the team do?" maxLength={32000} />
            </label>
            <div className="recipe-members">
              {recipe.members.map((member) => {
                const mp = state.presets.find((p) => p.id === member.preset);
                return (
                  <div key={member.key} className="recipe-member">
                    <span className="grow">
                      {member.title ?? member.key}{' '}
                      <span className="hint">
                        · {mp?.name ?? member.preset}
                        {member.worktree ? ' · worktree' : ''}
                        {member.cwdFrom ? ` · in ${member.cwdFrom}'s directory` : ''}
                      </span>
                    </span>
                    {mp?.modes && mp.modes.length > 1 && (
                      <select
                        aria-label={`Permissions for ${member.title ?? member.key}`}
                        value={memberModes[member.key] ?? member.mode ?? 'default'}
                        onChange={(e) => setMemberModes({ ...memberModes, [member.key]: e.target.value })}
                      >
                        {mp.modes.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.dangerous ? `⚠ ${m.name}` : m.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="hint">Runs on {host} only. Members launch together; handoffs fire as their turns end.</p>
          </>
        )}

        {kind === 'session' && preset && (models.length > 0 || preset.modelArgs || levels.length > 0 || modes.length > 1) && (
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
        {kind === 'session' && activeMode?.description && activeMode.id !== 'default' && <p className={activeMode.dangerous ? 'warn' : 'hint'}>{activeMode.description}</p>}

        {kind === 'session' && (
        <>
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
        </>
        )}

        {error && <p className="form-error">{error}</p>}

        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className={`btn ${kind === 'session' && activeMode?.dangerous ? 'danger-solid' : 'primary'}`}
            disabled={busy || (kind === 'session' ? !preset : !recipe || !!recipe.errors?.length)}
          >
            {busy ? 'Starting…' : kind === 'recipe' ? `Start ${recipe?.name ?? 'recipe'}` : `Start ${preset?.name ?? ''}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}
