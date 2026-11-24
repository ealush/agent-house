import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import type { HostApi, MemoryFile, SpaceView } from './api.ts';
import { askConfirm } from './ask.tsx';
import { Icon } from './icons.tsx';
import { errorText } from './errors.ts';
import { SheetBar, useSheet } from './sheet.tsx';
import { attachedSpaceFor, KIND_LABEL, knownProjects, projectName, removalText } from './spaces.ts';

/** The projects to offer: what New session offers on this host (`/api/projects`) and `extra` (live sessions' projects). */
function useKnownProjects(client: HostApi, extra: string[], root: string, on: boolean): string[] {
  const [listed, setListed] = useState<string[]>([]);
  useEffect(() => {
    if (!on) return;
    let live = true;
    client.projects().then(
      (p) => live && setListed(p),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, on]);
  return knownProjects([...extra, ...listed], root);
}

// Spaces (docs/spec/17-spaces.md, SPC-6): a new plain Space, and a Space's settings: what it
// is, its preferences and memory (plain Spaces), and Remove, said before it's done.

/**
 * The projects attached to a Space (SPC-8): each a chip to detach, then a picker of the known
 * ones (or any folder's path) to attach.
 */
export function ProjectsPicker({ value, known, onChange, disabled }: { value: string[]; known: string[]; onChange: (projects: string[]) => void; disabled?: boolean }) {
  const [typed, setTyped] = useState('');
  const offer = known.filter((p) => !value.includes(p));
  const add = (p: string) => {
    const clean = p.trim().replace(/\/+$/, '');
    if (!clean || value.includes(clean)) return;
    onChange([...value, clean]);
    setTyped('');
  };
  return (
    <div className="space-projects">
      {value.length > 0 ? (
        <ul className="space-project-list">
          {value.map((p) => (
            <li key={p}>
              <span className="grow">
                <strong>{projectName(p)}</strong> <code>{p}</code>
              </span>
              <button type="button" className="icon-btn small" disabled={disabled} aria-label={`Detach ${projectName(p)}`} title="Detach: its sessions leave this Space" onClick={() => onChange(value.filter((x) => x !== p))}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">No projects yet: its sessions are the ones you put in it.</p>
      )}
      <div className="space-project-add">
        {offer.length > 0 && (
          <select value="" disabled={disabled} aria-label="Attach a project" onChange={(e) => e.target.value && add(e.target.value)}>
            <option value="">Attach a project…</option>
            {offer.map((p) => (
              <option key={p} value={p}>
                {projectName(p)} — {p}
              </option>
            ))}
          </select>
        )}
        <input
          value={typed}
          disabled={disabled}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(typed);
            }
          }}
          placeholder="or a folder: ~/code/app"
          aria-label="Attach a folder by its path"
          autoCapitalize="off"
          spellCheck={false}
        />
        <button type="button" className="btn small" disabled={disabled || !/^(~|\/)/.test(typed.trim())} onClick={() => add(typed)}>
          Attach
        </button>
      </div>
    </div>
  );
}

/** New Space: a name, the projects whose sessions belong in it, and optionally the preferences every agent in it reads. */
export function NewSpaceDialog({ client, root, extra = [], withProjects = false, onClose, onMade }: { client: HostApi; root: string; extra?: string[]; withProjects?: boolean; onClose: () => void; onMade: (space: SpaceView) => void }) {
  const known = useKnownProjects(client, extra, root, withProjects);
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [name, setName] = useState('');
  const [projects, setProjects] = useState<string[]>([]);
  const [preferences, setPreferences] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { space } = await client.createSpace(name.trim(), preferences.trim() ? preferences : undefined, withProjects ? projects : undefined);
      onMade(space);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialog} className="dialog new-session space-dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={submit}>
        <header className="ns-head">
          <h2>New Space</h2>
        </header>
        <p className="hint">
          {withProjects
            ? 'A place of its own for the sessions about one thing, from any number of projects. Every agent in it reads the same preferences, keeps one shared memory, and can be run by a Chief of Staff. '
            : 'A place for conversations about one thing, with no repository behind it. Every agent you start in it reads the same preferences and keeps one shared memory. '}
          It's a folder in <code>{root}</code>.
        </p>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required autoFocus placeholder="Trips" autoCapitalize="words" />
        </label>
        {withProjects && (
          <div className="field">
            <span>Projects</span>
            <p className="hint">Sessions started in these repositories or folders join the Space by themselves; you can also put any session in it by hand.</p>
            <ProjectsPicker value={projects} known={known} onChange={setProjects} disabled={busy} />
          </div>
        )}
        <label className="field">
          <span>Preferences</span>
          <textarea value={preferences} onChange={(e) => setPreferences(e.target.value)} rows={5} placeholder="What it's for and how agents should work here. Leave empty for a starting text you can change later." />
        </label>
        {error && <p className="form-error">{error}</p>}
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <ConfirmButton type="submit" className="btn primary" disabled={busy || !name.trim()}>
            Create Space
          </ConfirmButton>
        </div>
      </form>
    </dialog>
  );
}

/** One memory file: open to read or change it, delete it (not the index). */
function MemoryRow({ file, onSave, onDelete }: { file: MemoryFile; onSave: (text: string) => Promise<void>; onDelete?: () => Promise<void> }) {
  const [text, setText] = useState(file.text);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(file.text), [file.text]);
  const dirty = text !== file.text;
  return (
    <details className="space-memory">
      <summary>
        <span className="mono">{file.name}</span>
        <span className="sub">{file.text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? 'Empty'}</span>
      </summary>
      {file.truncated && <p className="hint">Only the first 256 KB is shown; saving keeps only what's here.</p>}
      <div className="field">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} className="mono" aria-label={file.name} />
      </div>
      <div className="actions">
        {onDelete && (
          <button
            type="button"
            className="btn ghost danger"
            disabled={busy}
            onClick={async () => {
              if (!(await askConfirm({ title: `Delete ${file.name}?`, body: 'Agents in this Space stop reading it. It can’t be undone.', confirm: 'Delete', danger: true }))) return;
              setBusy(true);
              await onDelete().finally(() => setBusy(false));
            }}
          >
            Delete
          </button>
        )}
        <button type="button" className="btn small" disabled={!dirty || busy} onClick={() => void (setBusy(true), onSave(text).finally(() => setBusy(false)))}>
          Save
        </button>
      </div>
    </details>
  );
}

/** A Space's settings: what it is, its preferences and memory (all Space kinds on spaces >= 2), Remove. */
export function SpaceSettingsDialog({
  client,
  host,
  space,
  multiHost,
  supportsSpaceContext = false,
  extra = [],
  onClose,
  onRemoved,
  onChanged,
}: {
  client: HostApi;
  host: string;
  space: SpaceView;
  multiHost: boolean;
  supportsSpaceContext?: boolean;
  /** Live sessions' projects, offered for attaching (spaces 3) with what New session offers. */
  extra?: string[];
  onClose: () => void;
  onRemoved: () => void;
  /** The Space changed (its projects): read the list again. */
  onChanged?: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const plain = space.kind === 'space';
  // A spaces 3 host lists each Space's projects; there a Space is only removed from its folder's sessions.
  const attachable = Array.isArray(space.projects);
  const known = useKnownProjects(client, extra, space.path ? space.path.replace(/\/[^/]*$/, '') : '~/spaces', attachable);
  const [projects, setProjects] = useState<string[]>(space.projects ?? []);
  useEffect(() => setProjects(space.projects ?? []), [space.projects]);
  const hasContext = plain || supportsSpaceContext;
  const [prefs, setPrefs] = useState<{ text: string; saved: string; updatedAt: number } | null>(null);
  const [memory, setMemory] = useState<MemoryFile[] | null>(null);
  const [newFile, setNewFile] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => dialog.current?.showModal(), []);
  const loadMemory = () =>
    client
      .spaceMemory(space.name)
      .then((m) => setMemory(m.files))
      .catch((e) => setError(errorText(e)));
  useEffect(() => {
    if (!hasContext) return;
    client
      .spacePreferences(space.name)
      .then((p) => setPrefs({ text: p.text, saved: p.text, updatedAt: p.updatedAt }))
      .catch((e) => setError(errorText(e)));
    void loadMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.name, hasContext]);

  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    }
  };

  async function savePreferences() {
    if (!prefs) return;
    setBusy(true);
    await run(async () => {
      const p = await client.putSpacePreferences(space.name, prefs.text, prefs.updatedAt > 0 ? prefs.updatedAt : undefined);
      setPrefs({ text: p.text, saved: p.text, updatedAt: p.updatedAt });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
    });
    setBusy(false);
  }

  async function saveProjects(next: string[]) {
    const before = projects;
    setProjects(next);
    setBusy(true);
    await run(async () => {
      try {
        const { space: got } = await client.setSpaceProjects(space.name, next);
        setProjects(got.projects ?? next);
        onChanged?.();
      } catch (e) {
        setProjects(before);
        throw e;
      }
    });
    setBusy(false);
  }

  async function remove() {
    if (!(await askConfirm({ title: `Remove ${space.name}?`, body: removalText(space), confirm: 'Remove', danger: true }))) return;
    await run(async () => {
      await client.removeSpace(space.name);
      onRemoved();
    });
  }

  const name = newFile.trim().replace(/\.md$/i, '');
  return (
    <dialog ref={dialog} className="dialog space-dialog space-settings-dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <div className="space-settings">
        <header className="ns-head">
          <h2>{space.name}</h2>
        </header>
        <p className="hint">
          {attachable ? 'Space' : KIND_LABEL[space.kind]}
          {multiHost ? ` on ${host}` : ''}
          {space.path ? (
            <>
              {' · '}
              <code>{space.path}</code>
              {!space.exists && ' (gone)'}
            </>
          ) : null}
          {' · '}
          {space.live === 1 ? '1 session running' : `${space.live} sessions running`}
          {' · '}
          {space.conversations === 1 ? '1 conversation' : `${space.conversations} conversations`}
        </p>
        {error && <p className="form-error">{error}</p>}

        {attachable && (
          <section className="space-section">
            <h3>Projects</h3>
            <p className="hint">
              Sessions started in these repositories or folders (a worktree counts as its repository) are in {space.name}. A project belongs to one Space: attaching it here
              moves it from another. Any session can also be moved in or out by hand.
            </p>
            <ProjectsPicker value={projects} known={known} onChange={(next) => void saveProjects(next)} disabled={busy} />
          </section>
        )}

        {hasContext ? (
          <>
            <section className="space-section">
              <h3>Preferences</h3>
              <p className="hint">
                {plain ? (
                  <>
                    <code>AGENTS.md</code> in the Space: every agent you start here reads it (Claude Code and Gemini through <code>CLAUDE.md</code> and <code>GEMINI.md</code>). A
                    running agent picks up a change in its next conversation.
                  </>
                ) : (
                  <>
                    Space-owned <code>AGENTS.md</code> stored outside your repository ({space.contextPath ? <code>{space.contextPath}</code> : 'Space state'}) so git stays clean.
                  </>
                )}
              </p>
              {prefs ? (
                <>
                  <div className="field">
                    <textarea className="mono" rows={12} value={prefs.text} onChange={(e) => setPrefs({ ...prefs, text: e.target.value })} aria-label="Preferences" />
                  </div>
                  <div className="actions">
                    {saved && <span className="hint" role="status">Saved</span>}
                    <button type="button" className="btn primary small" disabled={busy || prefs.text === prefs.saved} onClick={() => void savePreferences()}>
                      Save preferences
                    </button>
                  </div>
                </>
              ) : (
                !error && <p className="hint">Loading…</p>
              )}
            </section>
            <section className="space-section">
              <h3>Memory</h3>
              <p className="hint">
                What agents here keep for the next conversation, in <code>memory/</code>: they read <code>MEMORY.md</code> first.
              </p>
              {memory === null ? (
                !error && <p className="hint">Loading…</p>
              ) : (
                memory.map((f) => (
                  <MemoryRow
                    key={f.name}
                    file={f}
                    onSave={(text) =>
                      run(async () => {
                        const got = await client.putSpaceMemory(space.name, f.name, text, f.updatedAt > 0 ? f.updatedAt : undefined);
                        setMemory((m) => m && m.map((x) => (x.name === f.name ? got : x)));
                      })
                    }
                    onDelete={
                      f.name === 'MEMORY.md'
                        ? undefined
                        : () =>
                            run(async () => {
                              await client.deleteSpaceMemory(space.name, f.name);
                              await loadMemory();
                            })
                    }
                  />
                ))
              )}
              <form
                className="space-new-memory field"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!name) return;
                  if (name.toUpperCase() === 'MEMORY') {
                    setError('MEMORY.md is the memory index: edit it above instead of adding a file named MEMORY.');
                    return;
                  }
                  void run(async () => {
                    await client.putSpaceMemory(space.name, `${name}.md`, `# ${name}\n`);
                    setNewFile('');
                    await loadMemory();
                  });
                }}
              >
                <input value={newFile} onChange={(e) => setNewFile(e.target.value)} placeholder="New file, like decisions" aria-label="New memory file" maxLength={77} autoCapitalize="off" spellCheck={false} />
                <button type="submit" className="btn small" disabled={!name}>
                  Add
                </button>
              </form>
            </section>
          </>
        ) : (
          <p className="note">
            <span>
              {space.kind === 'repo'
                ? "Agents here read the repository's own AGENTS.md and CLAUDE.md; ah doesn't write into it."
                : 'A folder sessions ran in. Its own files, if any, are what agents read.'}
            </span>
          </p>
        )}

        <section className="space-section">
          <h3>Remove</h3>
          <p className="hint">{space.live > 0 && !attachable ? `End its ${space.live === 1 ? 'session' : `${space.live} sessions`} first.` : removalText(space)}</p>
          <div className="actions">
            <button type="button" className="btn danger" disabled={space.live > 0 && !attachable} onClick={() => void remove()}>
              Remove Space…
            </button>
          </div>
        </section>
      </div>
    </dialog>
  );
}


/**
 * Move to Space… (SPC-6): any Space on the session's host, back to its project's (when attached),
 * or none. `spaced`: a spaces 3 host (an older one has no "its project's" and no "none").
 */
export function MoveToSpaceDialog({ client, uid, title, current, projectPath, home, spaced, onClose, onMoved }: { client: HostApi; uid: string; title: string; current: string | null; projectPath: string; home: string; spaced: boolean; onClose: () => void; onMoved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [list, setList] = useState<SpaceView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);
  useEffect(() => {
    let live = true;
    client.spaces().then(
      (l) => live && setList(l.spaces.filter((s) => s.kind === 'space')),
      (e) => live && setError(errorText(e)),
    );
    return () => {
      live = false;
    };
  }, [client]);
  const own = spaced && list ? attachedSpaceFor(list, projectPath, home) : null;
  async function move(space: string | null) {
    setBusy(true);
    setError(null);
    try {
      await client.setSessionSpace(uid, space);
      onMoved();
      onClose();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  const option = (key: string, label: string, detail: string | null, on: boolean, value: string | null) => (
    <button key={key} type="button" role="menuitemradio" aria-checked={on} disabled={busy} className="space-move-option" onClick={() => void move(value)}>
      <span className="grow menu-item-text">
        <span>{label}</span>
        {detail && <span className="menu-item-detail">{detail}</span>}
      </span>
      {on && <Icon name="check" size={15} />}
    </button>
  );
  return (
    <dialog ref={dialog} className="dialog space-dialog" onClose={onClose} onClick={(e) => e.target === dialog.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <form onSubmit={(e) => e.preventDefault()}>
        <header className="ns-head">
          <h2>Move to Space</h2>
        </header>
        <p className="hint">
          Where <strong>{title}</strong> belongs: its Space's preferences, memory and Chief of Staff apply from its next conversation.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="menu space-move-list" role="menu" aria-label="Spaces">
          {list === null && !error && <p className="hint">Loading…</p>}
          {(list ?? []).map((s) => option(s.name, s.name, (s.projects ?? []).map(projectName).join(', ') || null, current === s.name, s.name))}
          {spaced && own && own !== current && option('own', `Back to ${own}`, `the Space ${projectName(projectPath)} is attached to`, false, null)}
          {option('none', 'No Space', spaced && own ? `even though ${projectName(projectPath)} is attached to ${own}` : null, !current, spaced ? '' : null)}
        </div>
        <div className="actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}
