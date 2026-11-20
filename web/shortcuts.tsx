import { Fragment, useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './icons.tsx';
import { keepListFocus, roveKey } from './rove.ts';
import { leafCount, registerProvider, resolveTree, searchTree, type PaletteNode, type ProviderId } from './palette.ts';
import {
  COMMANDS,
  bindingError,
  chordFromEvent,
  chordParts,
  modLabel,
  chordsFor,
  formatChord,
  handleShortcutKey,
  hintChord,
  isMac,
  isOverridden,
  loadOverrides,
  matchShortcut,
  registerCommand,
  resetAllOverrides,
  resetOverride,
  searchCommands,
  setOverride,
  setShortcutCapture,
  subscribeShortcuts,
  whenLabel,
  type Chord,
  type CommandId,
  type Overrides,
  returnKey,
} from './shortcuts.ts';
import { PHONE, SheetBar, useSheet } from './sheet.tsx';
import { AgentLogo } from './logos.tsx';

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

/**
 * One raised cap per key, the only way a key is drawn anywhere in ah: modifiers as
 * this platform prints them (⌃ ⇧ ⌥ ⌘ on a Mac, Ctrl Shift Alt Super elsewhere), and
 * ↵ Esc and arrows as glyphs. Tooltips and search use the `formatChord` string, which agrees.
 */
export function Keycaps({ chord, keys }: { chord?: Chord; keys?: string[] }) {
  const parts = chord ? chordParts(chord) : (keys ?? []);
  return (
    <span className="keycaps">
      {parts.map((part, i) => (
        <kbd key={i}>{part}</kbd>
      ))}
    </span>
  );
}

/** The main modifier as drawn on a keycap: ⌘ on Apple devices, Ctrl elsewhere. */
export const MOD = () => (isMac() ? '⌘' : 'Ctrl');

export function ShortcutHint({ id }: { id: CommandId }) {
  useShortcutRevision();
  const chord = hintChord(id, isMac(), loadOverrides());
  if (!chord) return null;
  return <Keycaps chord={chord} />;
}

export function shortcutTitle(label: string, id: CommandId): string {
  const chord = hintChord(id, isMac(), loadOverrides());
  return chord ? `${label} (${formatChord(chord, isMac())})` : label;
}

/** One capture-phase listener for the whole app. Mounted once, inside the signed-in shell. */
export function Shortcuts() {
  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey, true);
    // Bubble phase: lists with their own arrow handling get the key first.
    window.addEventListener('keydown', roveKey);
    const stopKeeping = keepListFocus();
    return () => {
      window.removeEventListener('keydown', handleShortcutKey, true);
      window.removeEventListener('keydown', roveKey);
      stopKeeping();
    };
  }, []);
  return null;
}

/** One icon per catalog action. The type fails the build when a command has none. */
const BASE_ICONS = {
  'command-palette': 'commands',
  switcher: 'search',
  'cycle-prev': 'chevron-up',
  'cycle-next': 'chevron-down',
  'new-session': 'plus',
  'new-project': 'folder-plus',
  'toggle-sidebar': 'panel',
  'go-inbox': 'inbox',
  'go-settings': 'gear',
  'go-review': 'stack',
  'go-jobs': 'queue',
  'go-usage': 'effort',
  'go-search': 'search',
  worktrees: 'branch',
  'switch-branch': 'branch',
  'show-shortcuts': 'keyboard',
  'toggle-view': 'view',
  'toggle-steps': 'queue',
  'toggle-panel': 'panel-right',
  reply: 'reply',
  approve: 'check',
  deny: 'ban',
  terminate: 'trash',
  interrupt: 'stop',
  'send-now': 'send',
  'clear-queue': 'close',
  rename: 'edit',
  fork: 'fork',
  'send-to': 'send',
  pin: 'pin',
  'panel-diff': 'diff',
  'panel-files': 'files',
  'panel-chat': 'chat',
  'panel-queue': 'queue',
  'panel-snapshots': 'history',
  'panel-preview': 'globe',
  'panel-stack': 'stack',
  'panel-terminal': 'terminal',
  'pick-model': 'model',
  'pick-effort': 'effort',
  'copy-last': 'copy',
  'jump-latest': 'chevron-down',
  'browse-messages': 'chat',
  scrollback: 'terminal',
  'copy-attach': 'copy',
  'toggle-keys': 'keyboard',
  'session-menu': 'more',
  'focus-sidebar': 'panel',
  'focus-main': 'view',
  'reload-page': 'recall',
  'split-right': 'split-right',
  'split-below': 'split-below',
  'close-pane': 'pane-close',
  'focus-pane-left': 'pane-left',
  'focus-pane-right': 'pane-right',
  'focus-pane-up': 'pane-up',
  'focus-pane-down': 'pane-down',
  'move-pane-left': 'pane-left',
  'move-pane-right': 'pane-right',
  'move-pane-up': 'pane-up',
  'move-pane-down': 'pane-down',
  'toggle-split': 'split-flip',
  'resize-left': 'pane-left',
  'resize-right': 'pane-right',
  'resize-up': 'pane-up',
  'resize-down': 'pane-down',
  'resize-mode': 'split-right',
  'maximize-pane': 'pane',
  'pane-mode': 'pane',
  'open-in-pane': 'split-right',
  'replace-pane': 'view',
  'scratchpad': 'terminal',
  'exit-split': 'pane',
} as const satisfies Record<Exclude<CommandId, `workspace-${string}` | `to-workspace-${string}`>, IconName>;

const COMMAND_ICONS = Object.fromEntries([
  ...Object.entries(BASE_ICONS),
  ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].flatMap((d) => [
    [`workspace-${d}`, 'pane'],
    [`to-workspace-${d}`, 'send'],
  ]),
]) as Record<CommandId, IconName>;

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
            enterKeyHint="search"
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
              const user = isOverridden(cmd.id, overrides);
              // Off a Mac, ⌘ is the window manager's Super key: show the chords that work here.
              const all = resolved(cmd.id, overrides);
              const here = mac || user ? all : all.filter((c) => !c.meta);
              const chords = here.length ? here : all;
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
                      <div className="keymap-cmd">
                        <Icon name={COMMAND_ICONS[cmd.id]} size={16} />
                        <div>
                          <div className="keymap-name">{cmd.label}</div>
                          <div className="hint">{cmd.detail}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      {live ? (
                        <div className="keymap-record">
                          {pending ? <Keycaps chord={pending} /> : <span className="hint">Press a shortcut, then Enter</span>}
                          <span className="hint keymap-how">
                            <Keycaps keys={[returnKey()]} /> saves
                            <Keycaps keys={['Esc']} /> cancels
                            <Keycaps keys={['Backspace']} /> clears
                          </span>
                          {error && <span className="keymap-error">{error}</span>}
                        </div>
                      ) : (
                        <button type="button" className="keymap-bind" onClick={() => start(cmd.id)} title={`Change ${cmd.label}`}>
                          {chords.length ? chords.map((c, i) => <Keycaps key={i} chord={c} />) : <span className="hint">Record</span>}
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

/** Register a live palette branch while mounted and `enabled`. The latest `fn` is used. */
export function usePaletteProvider(id: ProviderId, fn: () => PaletteNode[] | Promise<PaletteNode[]>, enabled = true) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    return registerProvider(id, () => ref.current());
  }, [id, enabled]);
}

function nodeIcon(node: PaletteNode): IconName {
  if (node.icon) return node.icon;
  if (node.command) return COMMAND_ICONS[node.command];
  return node.children ? 'commands' : 'more';
}

/**
 * The command palette as a tree (Omarchy-style): categories you walk into with →
 * or Enter and out of with ← or Backspace; typing searches everything below where
 * you are, categories included, each hit with its breadcrumb. A command's chord
 * sits on its row.
 *
 * On a phone it is a full-screen sheet you browse with a finger: the bar names the
 * level you are on and steps back out of it, and the keyboard stays down until you
 * tap the search field. A command runs once the sheet has gone down.
 */
export function CommandPalette({ onClose, onRun }: { onClose: () => void; onRun: (node: PaletteNode) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  // The command chosen, run when the sheet is gone; nothing, when it was just closed.
  const chosen = useRef<PaletteNode | null>(null);
  const { dismiss } = useSheet(ref, () => (chosen.current ? onRun(chosen.current) : onClose()));
  const input = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [root, setRoot] = useState<PaletteNode | null>(null);
  const [stack, setStack] = useState<PaletteNode[]>([]);
  const [drill, setDrill] = useState<'in' | 'out' | null>(null);
  const [query, setQuery] = useState('');
  const [i, setI] = useState(0);
  useShortcutRevision();
  const mac = isMac();
  const overrides = loadOverrides();

  useEffect(() => {
    ref.current?.showModal();
    // Focus after showModal, which would otherwise take it to the sheet's first button.
    // A phone gets the whole tree to look at, not a keyboard over half of it.
    if (matchMedia(PHONE).matches) ref.current?.focus({ preventScroll: true });
    else input.current?.focus();
    let live = true;
    void resolveTree().then((tree) => {
      if (!live) return;
      setRoot(tree);
      setStack([tree]);
    });
    return () => {
      live = false;
    };
  }, []);

  const here = stack.at(-1) ?? null;
  const hits = here && query.trim() ? searchTree(here, query) : null;
  const rows: Array<{ node: PaletteNode; trail: PaletteNode[] }> = hits ?? (here?.children ?? []).map((node) => ({ node, trail: [] }));
  const index = rows.length ? Math.min(i, rows.length - 1) : 0;
  const selected = rows[index];

  // Keep the selected row in view by scrolling the list only, and only when it is out of
  // view: scrollIntoView walked every scrolling ancestor on each keystroke.
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !row) return;
    const r = row.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    if (r.top < l.top) list.scrollTop -= l.top - r.top;
    else if (r.bottom > l.bottom) list.scrollTop += r.bottom - l.bottom;
  }, [index, rows.length, here]);

  const enter = (node: PaletteNode, trail: PaletteNode[] = []) => {
    setDrill('in');
    setStack((st) => [...st, ...trail, node]);
    setQuery('');
    setI(0);
  };
  const up = (levels = 1) => {
    if (stack.length < 2) return;
    const next = stack.slice(0, Math.max(1, stack.length - levels));
    const leaving = stack[next.length];
    setDrill('out');
    setStack(next);
    setQuery('');
    // Land on the category you came out of.
    setI(Math.max(0, (next.at(-1)?.children ?? []).indexOf(leaving)));
  };
  const choose = (row: { node: PaletteNode; trail: PaletteNode[] } | undefined) => {
    if (!row) return;
    if (row.node.children) return enter(row.node, row.trail);
    chosen.current = row.node;
    dismiss();
  };
  const caretAt = (pos: 'start' | 'end') => {
    const el = input.current;
    if (!el) return true;
    return el.selectionStart === el.selectionEnd && el.selectionStart === (pos === 'start' ? 0 : el.value.length);
  };

  return (
    <dialog
      ref={ref}
      className="dialog switcher commands palette-tree"
      aria-label="Command palette"
      tabIndex={-1}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      onKeyDown={(e) => {
        // A key typed with focus on the sheet itself (a phone's, opened with a tap) searches.
        if (e.target !== input.current && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          input.current?.focus();
          return;
        }
        // The palette is a dialog, so its own chord is not stolen by the global listener. Pressing it again closes.
        if (matchShortcut(e, 'app', overrides) === 'command-palette') {
          e.preventDefault();
          onClose();
          return;
        }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          const step = e.key === 'ArrowDown' ? 1 : -1;
          setI(() => (rows.length ? (index + step + rows.length) % rows.length : 0));
        } else if (e.key === 'ArrowRight' && selected?.node.children && caretAt('end')) {
          enter(selected.node, selected.trail);
        } else if (e.key === 'ArrowLeft' && stack.length > 1 && caretAt('start')) {
          up();
        } else if (e.key === 'Backspace' && !query && stack.length > 1) {
          up();
        } else if (e.key === 'Enter') {
          choose(selected);
        } else if (e.key === 'Escape' && query) {
          // First Escape clears the search; the next one closes.
          setQuery('');
          setI(0);
        } else if (e.key === 'Home' && !query) {
          setI(0);
        } else if (e.key === 'End' && !query) {
          setI(Math.max(0, rows.length - 1));
        } else return;
        e.preventDefault();
      }}
    >
      <SheetBar onClose={dismiss} title={here?.label ?? 'Commands'} onBack={stack.length > 1 ? () => up() : undefined} backLabel={stack.at(-2)?.label} />
      <nav className="palette-crumbs" aria-label="Where you are">
        {stack.map((n, at) => (
          <Fragment key={n.key + at}>
            {at > 0 && <span className="palette-sep" aria-hidden>›</span>}
            <button type="button" className={at === stack.length - 1 ? 'on' : ''} tabIndex={-1} onClick={() => up(stack.length - 1 - at)}>
              {n.label}
            </button>
          </Fragment>
        ))}
      </nav>
      <input
        ref={input}
        value={query}
        placeholder={here && stack.length > 1 ? `Search ${here.label}…` : 'Search commands and categories…'}
        enterKeyHint="go"
        aria-label="Search"
        aria-controls="palette-list"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setI(0);
        }}
      />
      {/* A new level slides in from the side it lives on: deeper from the right, back from the left. */}
      <ul ref={listRef} id="palette-list" role="listbox" key={stack.map((n) => n.key).join('/')} className={drill ? `drill-${drill}` : ''}>
        {rows.map((row, idx) => {
          const { node, trail } = row;
          const chord = node.command ? hintChord(node.command, mac, overrides) : null;
          return (
            <li key={[...trail.map((t) => t.key), node.key].join('/')}>
              <button
                type="button"
                tabIndex={-1}
                className={`cmd-row ${idx === index ? 'on' : ''} ${node.children ? 'group' : ''}`}
                role="option"
                aria-selected={idx === index}
                title={node.detail}
                onMouseMove={() => idx !== index && setI(idx)}
                onClick={() => choose(row)}
              >
                <span className="cmd-icon">
                  {node.agent !== undefined ? <AgentLogo id={node.agent} size={16} /> : <Icon name={nodeIcon(node)} size={16} />}
                </span>
                <span className="cmd-text">
                  {trail.length > 0 && <span className="cmd-trail">{trail.map((t) => t.label).join(' › ')} ›</span>}
                  <span className="name">{node.label}</span>
                  {node.detail && <span className="cmd-detail">{node.detail}</span>}
                </span>
                {chord && <Keycaps chord={chord} />}
                {node.children && (
                  <span className="cmd-more">
                    <span className="cmd-count">{leafCount(node)}</span>
                    <span aria-hidden>›</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {root && rows.length === 0 && <p className="cmd-empty">{query ? `Nothing in ${here?.label ?? 'here'} matches “${query}”.` : 'Nothing to run here right now.'}</p>}
      {!root && <p className="cmd-empty">Loading…</p>}
      <footer className="palette-keys" aria-hidden>
        <span><Keycaps keys={['↑', '↓']} /> move</span>
        <span><Keycaps keys={['→']} /> open</span>
        <span><Keycaps keys={['←']} /> back</span>
        <span><Keycaps keys={[returnKey()]} /> run</span>
        <span><Keycaps keys={['Esc']} /> {query ? 'clear' : 'close'}</span>
      </footer>
    </dialog>
  );
}

/** The shortcut table as a dialog, opened from its own shortcut. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(ref, onClose);
  useEffect(() => {
    ref.current?.showModal();
    // showModal focuses the first button (Close); the table opens to be searched.
    ref.current?.querySelector<HTMLInputElement>('.keymap-search input')?.focus();
  }, []);
  return (
    <dialog ref={ref} className="dialog keymap-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <header className="keymap-head">
        <h2>Keyboard shortcuts</h2>
        <button type="button" className="btn ghost small desk-close" onClick={onClose}>
          Close
        </button>
      </header>
      <ShortcutsPanel focusSearch />
    </dialog>
  );
}

/** ⌘↵ on a main button (confirm.ts presses it). Hidden on touch screens. */
export function ConfirmKeys() {
  return (
    <span className="keycaps confirm-keys" aria-hidden>
      <kbd>{MOD()}</kbd>
      <kbd>{returnKey()}</kbd>
    </span>
  );
}

/**
 * Which-key, like Omarchy's: hold ⌃⌥ or ⌃⇧ (⌘⇧ on a Mac) for a moment and the
 * chords that work right now appear, each with its key. Any other key, or
 * letting go, hides it; the chord itself still runs as usual.
 */
export function WhichKey() {
  const [shown, setShown] = useState<{ mods: string[]; items: ReturnType<typeof chordsFor> } | null>(null);
  useEffect(() => {
    let timer: number | undefined;
    const reset = () => {
      window.clearTimeout(timer);
      timer = undefined;
      setShown(null);
    };
    const down = (e: KeyboardEvent) => {
      const modOnly = ['Control', 'Alt', 'Shift', 'Meta'].includes(e.key);
      if (!modOnly || e.repeat) {
        if (!modOnly) reset();
        return;
      }
      const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };
      const pair = Object.values(mods).filter(Boolean).length === 2 && (mods.ctrl || mods.meta);
      window.clearTimeout(timer);
      if (!pair) return setShown(null);
      timer = window.setTimeout(() => {
        const items = chordsFor(mods, isMac(), loadOverrides());
        const caps = (['ctrl', 'shift', 'alt', 'meta'] as const).filter((m) => mods[m]).map((m) => modLabel(m));
        if (items.length) setShown({ mods: caps, items });
      }, 650);
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', reset, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', reset, true);
      window.removeEventListener('blur', reset);
      window.clearTimeout(timer);
    };
  }, []);
  if (!shown) return null;
  return (
    <div className="whichkey" role="status" aria-label="Shortcuts for these keys">
      <div className="whichkey-head">
        <Keycaps keys={shown.mods} /> <span>+</span>
      </div>
      <ul>
        {shown.items.map((it) => (
          <li key={it.id}>
            <kbd>{it.key}</kbd>
            <span>{it.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
