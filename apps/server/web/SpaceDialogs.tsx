import { useEffect, useRef, useState } from 'react';
import { ConfirmButton } from './ConfirmButton.tsx';
import type { HostApi, MemoryFile, SpaceView } from './api.ts';
import { askConfirm } from './ask.tsx';
import { errorText } from './errors.ts';
import { SheetBar, useSheet } from './sheet.tsx';
import { KIND_LABEL, removalText } from './spaces.ts';

// Spaces (docs/spec/17-spaces.md, SPC-6): a new plain Space, and a Space's settings: what it
// is, its preferences and memory (plain Spaces), and Remove, said before it's done.

/** New Space: a name, and optionally the preferences every agent in it reads. */
export function NewSpaceDialog({ client, root, onClose, onMade }: { client: HostApi; root: string; onClose: () => void; onMade: (space: SpaceView) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const [name, setName] = useState('');
  const [preferences, setPreferences] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => dialog.current?.showModal(), []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { space } = await client.createSpace(name.trim(), preferences.trim() ? preferences : undefined);
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
          A place for conversations about one thing, with no repository behind it. Every agent you start in it reads the same preferences and keeps one shared memory. It's a folder in{' '}
          <code>{root}</code>.
        </p>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} required autoFocus placeholder="Trips" autoCapitalize="words" />
        </label>
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

/** A Space's settings: what it is, its preferences and memory (plain Spaces), Remove. */
export function SpaceSettingsDialog({ client, host, space, multiHost, onClose, onRemoved }: { client: HostApi; host: string; space: SpaceView; multiHost: boolean; onClose: () => void; onRemoved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(dialog, onClose);
  const plain = space.kind === 'space';
  const [prefs, setPrefs] = useState<{ text: string; saved: string } | null>(null);
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
    if (!plain) return;
    client
      .spacePreferences(space.name)
      .then((p) => setPrefs({ text: p.text, saved: p.text }))
      .catch((e) => setError(errorText(e)));
    void loadMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space.name, plain]);

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
      const p = await client.putSpacePreferences(space.name, prefs.text);
      setPrefs({ text: p.text, saved: p.text });
      setSaved(true);
      setTimeout(() => setSaved(false), 1600);
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
          {KIND_LABEL[space.kind]}
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

        {plain ? (
          <>
            <section className="space-section">
              <h3>Preferences</h3>
              <p className="hint">
                <code>AGENTS.md</code> in the Space: every agent you start here reads it (Claude Code and Gemini through <code>CLAUDE.md</code> and <code>GEMINI.md</code>). A running
                agent picks up a change in its next conversation.
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
                        const got = await client.putSpaceMemory(space.name, f.name, text);
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
          <p className="hint">{space.live > 0 ? `End its ${space.live === 1 ? 'session' : `${space.live} sessions`} first.` : removalText(space)}</p>
          <div className="actions">
            <button type="button" className="btn danger" disabled={space.live > 0} onClick={() => void remove()}>
              Remove Space…
            </button>
          </div>
        </section>
      </div>
    </dialog>
  );
}

