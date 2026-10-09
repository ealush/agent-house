import { Fragment, useEffect, useRef, useState } from 'react';
import {
  COMMANDS,
  bindingError,
  chordFromEvent,
  formatChord,
  handleShortcutKey,
  hintChord,
  isMac,
  isOverridden,
  loadOverrides,
  registerCommand,
  resetAllOverrides,
  resetOverride,
  setOverride,
  setShortcutCapture,
  subscribeShortcuts,
  whenLabel,
  type Chord,
  type CommandId,
  type Overrides,
} from './shortcuts.ts';

export function useShortcutRevision() {
  const [n, setN] = useState(0);
  useEffect(() => subscribeShortcuts(() => setN((v) => v + 1)), []);
  return n;
}

/** Register `fn` while this component is mounted and `enabled`. The latest `fn` is called. */
export function useCommand(id: CommandId, fn: () => void, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return registerCommand(id, () => ref.current());
  }, [id, enabled]);
}

export function ShortcutHint({ id }: { id: CommandId }) {
  useShortcutRevision();
  const chord = hintChord(id, isMac(), loadOverrides());
  if (!chord) return null;
  return <kbd>{formatChord(chord, isMac())}</kbd>;
}

export function shortcutTitle(label: string, id: CommandId): string {
  const chord = hintChord(id, isMac(), loadOverrides());
  return chord ? `${label} (${formatChord(chord, isMac())})` : label;
}

/** One capture-phase listener for the whole app. Mounted once, inside the signed-in shell. */
export function Shortcuts() {
  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey, true);
    return () => window.removeEventListener('keydown', handleShortcutKey, true);
  }, []);
  return null;
}

function resolved(id: CommandId, overrides: Overrides): Chord[] {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] ?? [];
  return COMMANDS.find((c) => c.id === id)?.chords ?? [];
}

function stopRecording(setRecording: (id: CommandId | null) => void, setPending: (c: Chord | null) => void, setError: (s: string | null) => void) {
  setRecording(null);
  setPending(null);
  setError(null);
}

/** Searchable shortcut table. Click a keybinding to record; Enter saves, Escape cancels, Backspace clears. */
export function ShortcutsPanel({ focusSearch = false }: { focusSearch?: boolean }) {
  useShortcutRevision();
  const mac = isMac();
  const overrides = loadOverrides();
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<CommandId | null>(null);
  const [pending, setPending] = useState<Chord | null>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  const [error, setError] = useState<string | null>(null);
  const any = COMMANDS.some((c) => isOverridden(c.id, overrides));
  const q = query.trim().toLowerCase();

  useEffect(() => {
    if (!recording) return;
    setShortcutCapture((e) => {
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
      if (e.key === 'Escape' && plain) {
        stopRecording(setRecording, setPending, setError);
        return;
      }
      if (e.key === 'Enter' && plain) {
        const chord = pendingRef.current;
        if (!chord) return;
        const problem = setOverride(recording, [chord]);
        setError(problem);
        if (!problem) stopRecording(setRecording, setPending, setError);
        return;
      }
      // Unmodified Backspace clears. A modified Backspace is a chord (Deny, Close pane).
      if ((e.key === 'Backspace' || e.key === 'Delete') && plain) {
        const problem = setOverride(recording, null);
        setError(problem);
        if (!problem) stopRecording(setRecording, setPending, setError);
        return;
      }
      const chord = chordFromEvent(e);
      if (!chord) return;
      setPending(chord);
      setError(bindingError(recording, chord, loadOverrides(), mac));
    });
    return () => setShortcutCapture(null);
  }, [recording, mac]);

  const rows = COMMANDS.filter((cmd) => {
    if (!q) return true;
    const chords = resolved(cmd.id, overrides).map((c) => formatChord(c, mac));
    return [cmd.label, cmd.detail, cmd.group, whenLabel(cmd.id), ...chords].join('\n').toLowerCase().includes(q);
  });

  const start = (id: CommandId) => {
    setError(null);
    setPending(null);
    setRecording(id);
  };

  let group = '';
  return (
    <div className="keymap">
      <div className="keymap-bar">
        <label className="field keymap-search">
          <input
            autoFocus={focusSearch}
            value={query}
            placeholder="Search commands and keybindings"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {any && (
          <button
            className="btn ghost small"
            onClick={() => {
              resetAllOverrides();
              setError(null);
            }}
          >
            Reset all
          </button>
        )}
      </div>
      <div className="keymap-scroll">
        <table className="keymap-table">
          <thead>
            <tr>
              <th>Command</th>
              <th>Keybinding</th>
              <th>When</th>
              <th>Source</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((cmd) => {
              const head = cmd.group !== group;
              group = cmd.group;
              const chords = resolved(cmd.id, overrides);
              const user = isOverridden(cmd.id, overrides);
              const live = recording === cmd.id;
              return (
                <Fragment key={cmd.id}>
                  {head && (
                    <tr className="keymap-group">
                      <td colSpan={5}>{cmd.group}</td>
                    </tr>
                  )}
                  <tr className={live ? 'recording' : undefined}>
                    <td>
                      <div className="keymap-name">{cmd.label}</div>
                      <div className="hint">{cmd.detail}</div>
                    </td>
                    <td>
                      {live ? (
                        <div className="keymap-record">
                          {pending ? <kbd>{formatChord(pending, mac)}</kbd> : <span className="hint">Press a shortcut, then Enter</span>}
                          <span className="hint">Enter saves · Esc cancels · ⌫ clears</span>
                          {error && <span className="keymap-error">{error}</span>}
                        </div>
                      ) : (
                        <button type="button" className="keymap-bind" onClick={() => start(cmd.id)} title={`Change ${cmd.label}`}>
                          {chords.length ? chords.map((c, i) => <kbd key={i}>{formatChord(c, mac)}</kbd>) : <span className="hint">Record</span>}
                        </button>
                      )}
                    </td>
                    <td className="keymap-when">{whenLabel(cmd.id)}</td>
                    <td className="keymap-source">{user ? 'This device' : 'Default'}</td>
                    <td className="keymap-actions">
                      {user && (
                        <button
                          type="button"
                          className="btn ghost small"
                          onClick={() => {
                            resetOverride(cmd.id);
                            setError(null);
                          }}
                        >
                          Reset
                        </button>
                      )}
                      {chords.length > 0 && (
                        <button
                          type="button"
                          className="btn ghost small"
                          aria-label={`Clear ${cmd.label}`}
                          title="Clear keybinding"
                          onClick={() => {
                            setOverride(cmd.id, null);
                            setError(null);
                          }}
                        >
                          Clear
                        </button>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="hint">
                  No shortcuts match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The shortcut table as a dialog, opened from its own shortcut. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} className="dialog keymap-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <header className="keymap-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </header>
      <ShortcutsPanel focusSearch />
    </dialog>
  );
}
