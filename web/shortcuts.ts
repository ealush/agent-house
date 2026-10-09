// UI shortcuts for ah itself: navigation, sessions, splits. Terminal bytes
// (arrows into the pty, the touch key bar) stay in keyboard.ts.
//
// Defaults live here. A device may override them in localStorage (`ah.shortcuts.v1`).
// A chord needs Ctrl, Alt, or Super, so a plain letter still reaches the agent.
// Matching uses the character the layout produces (Colemak included), except
// digits and punctuation, which stay on the physical key so Shift does not turn
// "1" into "!" or "\" into "|".

export type Scope = 'app' | 'terminal' | 'field' | 'dialog' | 'ask';

export type Chord = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

export type CommandId =
  | 'switcher'
  | 'new-session'
  | 'cycle-prev'
  | 'cycle-next'
  | 'toggle-sidebar'
  | 'go-inbox'
  | 'go-history'
  | 'go-settings'
  | 'toggle-view'
  | 'toggle-panel'
  | 'reply'
  | 'approve'
  | 'deny'
  | 'split-right'
  | 'split-below'
  | 'close-pane'
  | 'focus-next-pane'
  | 'focus-prev-pane'
  | 'show-shortcuts';

export type CommandGroup = 'Navigate' | 'Session' | 'Workspace';

export type Command = {
  id: CommandId;
  group: CommandGroup;
  label: string;
  detail: string;
  chords: Chord[];
  /** Where the chord is allowed to steal the key. `ask` is never listed: those dialogs own the keyboard. */
  scopes: Array<Exclude<Scope, 'ask'>>;
};

const nav: Array<Exclude<Scope, 'ask'>> = ['app', 'terminal'];
const session: Array<Exclude<Scope, 'ask'>> = ['app', 'terminal'];

export const COMMANDS: Command[] = [
  {
    id: 'switcher',
    group: 'Navigate',
    label: 'Search or jump',
    detail: 'Open the switcher. Also works while a text field or another dialog is open.',
    chords: [{ key: 'k', meta: true }, { key: 'k', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field', 'dialog'],
  },
  {
    id: 'cycle-prev',
    group: 'Navigate',
    label: 'Previous session',
    detail: 'The previous session in sidebar order. From the inbox, this opens the last one. Also works while a text field is focused.',
    chords: [{ key: 'ArrowUp', alt: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'cycle-next',
    group: 'Navigate',
    label: 'Next session',
    detail: 'The next session in sidebar order. From the inbox, this opens the first one. Also works while a text field is focused.',
    chords: [{ key: 'ArrowDown', alt: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'new-session',
    group: 'Navigate',
    label: 'New session',
    detail: 'Open the new-session dialog.',
    chords: [{ key: 'Enter', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'toggle-sidebar',
    group: 'Navigate',
    label: 'Toggle sidebar',
    detail: 'Show or hide the sidebar.',
    chords: [{ key: 'e', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'go-inbox',
    group: 'Navigate',
    label: 'Inbox',
    detail: 'Leave the session or split and show the inbox.',
    chords: [{ key: '1', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'go-history',
    group: 'Navigate',
    label: 'History',
    detail: 'Open the history page.',
    chords: [{ key: '2', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'go-settings',
    group: 'Navigate',
    label: 'Settings',
    detail: 'Open settings.',
    chords: [{ key: '3', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'show-shortcuts',
    group: 'Navigate',
    label: 'Keyboard shortcuts',
    detail: 'Open the shortcut table.',
    chords: [{ key: '/', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'toggle-view',
    group: 'Session',
    label: 'Terminal / GUI',
    detail: 'Switch the focused session between the terminal and the transcript GUI.',
    chords: [{ key: 'g', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'toggle-panel',
    group: 'Session',
    label: 'Toggle side panel',
    detail: 'Show or hide the session side panel.',
    chords: [{ key: 'p', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'reply',
    group: 'Session',
    label: 'Reply',
    detail: 'Focus the composer, or the terminal when that is the current view.',
    chords: [{ key: 'r', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'approve',
    group: 'Session',
    label: 'Approve',
    detail: 'Approve the prompt on the focused session, when it is waiting for one.',
    chords: [{ key: 'Enter', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'deny',
    group: 'Session',
    label: 'Deny',
    detail: 'Deny the prompt on the focused session, when it is waiting for one.',
    chords: [{ key: 'Backspace', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'split-right',
    group: 'Workspace',
    label: 'Split right',
    detail: 'Open another session to the right of the focused one.',
    chords: [{ key: '\\', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'split-below',
    group: 'Workspace',
    label: 'Split below',
    detail: 'Open another session below the focused one.',
    chords: [{ key: '-', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'close-pane',
    group: 'Workspace',
    label: 'Close pane',
    detail: 'Close the focused split pane without stopping the session.',
    chords: [{ key: 'Backspace', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'focus-next-pane',
    group: 'Workspace',
    label: 'Next pane',
    detail: 'Move keyboard focus to the next pane in the split.',
    chords: [{ key: 'ArrowRight', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'focus-prev-pane',
    group: 'Workspace',
    label: 'Previous pane',
    detail: 'Move keyboard focus to the previous pane in the split.',
    chords: [{ key: 'ArrowLeft', ctrl: true, shift: true }],
    scopes: session,
  },
];

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/** Shifted glyphs we still want to name as the unshifted key. */
const CODE_CHAR: Record<string, string> = {
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

export function eventKey(e: { key: string; code: string }): string {
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (CODE_CHAR[e.code] && e.key.length === 1) return CODE_CHAR[e.code];
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

export function chordFromEvent(e: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Chord | null {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  return {
    key: eventKey(e),
    meta: e.metaKey || undefined,
    ctrl: e.ctrlKey || undefined,
    alt: e.altKey || undefined,
    shift: e.shiftKey || undefined,
  };
}

export function chordUsable(c: Chord): boolean {
  return !!(c.meta || c.ctrl || c.alt);
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return a.key === b.key && !!a.meta === !!b.meta && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift;
}

export type Overrides = Partial<Record<CommandId, Chord[] | null>>;

function parseChord(value: unknown): Chord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || !v.key) return null;
  const chord: Chord = { key: v.key };
  if (v.meta === true) chord.meta = true;
  if (v.ctrl === true) chord.ctrl = true;
  if (v.alt === true) chord.alt = true;
  if (v.shift === true) chord.shift = true;
  return chord;
}

/** Parse a stored override blob. Unknown ids and bare-key chords are dropped. */
export function readOverrides(raw: string | null): Overrides {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};
  const out: Overrides = {};
  for (const cmd of COMMANDS) {
    if (!Object.prototype.hasOwnProperty.call(data, cmd.id)) continue;
    const value = (data as Record<string, unknown>)[cmd.id];
    if (value === null) {
      out[cmd.id] = null;
      continue;
    }
    if (!Array.isArray(value)) continue;
    out[cmd.id] = value.map(parseChord).filter((c): c is Chord => !!c && chordUsable(c));
  }
  return out;
}

export function resolveChords(id: CommandId, overrides: Overrides = {}): Chord[] {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] ?? [];
  return BY_ID.get(id)?.chords ?? [];
}

export function matchShortcut(
  e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  scope: Scope,
  overrides: Overrides = {},
): CommandId | null {
  if (scope === 'ask') return null;
  const chord = chordFromEvent(e);
  if (!chord || !chordUsable(chord)) return null;
  for (const cmd of COMMANDS) {
    if (!cmd.scopes.includes(scope)) continue;
    if (resolveChords(cmd.id, overrides).some((c) => chordsEqual(c, chord))) return cmd.id;
  }
  return null;
}

/** Short "when" clause for the shortcut table. Confirm dialogs always own the keyboard. */
export function whenLabel(id: CommandId): string {
  const scopes = BY_ID.get(id)?.scopes ?? [];
  const has = (s: Exclude<Scope, 'ask'>) => scopes.includes(s);
  if (has('dialog') && has('field')) return 'Anywhere except a confirm';
  if (has('field')) return 'Not in a dialog';
  return 'Not while typing or in a dialog';
}

export function hintChord(id: CommandId, mac: boolean, overrides: Overrides = {}): Chord | null {
  const chords = resolveChords(id, overrides);
  if (!chords.length) return null;
  return chords.find((c) => (mac ? !!c.meta : !c.meta)) ?? chords[0];
}

const KEY_LABEL: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Backspace: '⌫',
  Escape: 'Esc',
  ' ': 'Space',
};

export function formatChord(c: Chord, mac: boolean): string {
  const key = KEY_LABEL[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  if (mac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`;
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

export function bindingError(id: CommandId, chord: Chord, overrides: Overrides, mac = false): string | null {
  if (!chordUsable(chord)) return 'Use Ctrl, Alt, or Super together with another key.';
  for (const cmd of COMMANDS) {
    if (cmd.id === id) continue;
    if (resolveChords(cmd.id, overrides).some((c) => chordsEqual(c, chord))) return `${formatChord(chord, mac)} is already ${cmd.label}.`;
  }
  return null;
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const STORAGE_KEY = 'ah.shortcuts.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadOverrides(): Overrides {
  return readOverrides(storage()?.getItem(STORAGE_KEY) ?? null);
}

const listeners = new Set<() => void>();

export function subscribeShortcuts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function writeOverrides(next: Overrides) {
  const store = storage();
  if (!store) return;
  try {
    if (Object.keys(next).length) store.setItem(STORAGE_KEY, JSON.stringify(next));
    else store.removeItem(STORAGE_KEY);
  } catch {
    // Private mode and full disks keep the defaults.
  }
  listeners.forEach((fn) => fn());
}

/**
 * Bind `chords` on this device. `null` unbinds the command. Picking any default
 * chord clears the override, so both defaults (⌘K and Ctrl+Shift+K) come back.
 * Returns an error string and changes nothing when the chord is illegal or taken.
 */
export function setOverride(id: CommandId, chords: Chord[] | null): string | null {
  const chord = chords?.[0] ?? null;
  const current = loadOverrides();
  if (chord) {
    const error = bindingError(id, chord, current, isMac());
    if (error) return error;
  }
  const next: Overrides = { ...current };
  const def = BY_ID.get(id)?.chords ?? [];
  if (!chord) next[id] = null;
  else if (def.some((c) => chordsEqual(c, chord))) delete next[id];
  else next[id] = [chord];
  writeOverrides(next);
  return null;
}

export function resetOverride(id: CommandId) {
  const next = { ...loadOverrides() };
  delete next[id];
  writeOverrides(next);
}

export function resetAllOverrides() {
  writeOverrides({});
}

export function isOverridden(id: CommandId, overrides: Overrides = loadOverrides()): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, id);
}

export function shortcutContext(target: EventTarget | null, root: { querySelector(sel: string): unknown } | null = typeof document === 'undefined' ? null : document): Scope {
  if (root?.querySelector('dialog.ask[open]')) return 'ask';
  if (root?.querySelector('dialog[open]')) return 'dialog';
  const candidate = target as unknown as { closest?: (sel: string) => unknown } | null;
  if (candidate && typeof candidate.closest === 'function') {
    if (candidate.closest('.xterm')) return 'terminal';
    if (candidate.closest('input, textarea, select, [contenteditable="true"]')) return 'field';
  }
  return 'app';
}

type Handler = () => void;
const handlers = new Map<CommandId, Set<Handler>>();

export function registerCommand(id: CommandId, fn: Handler): () => void {
  let set = handlers.get(id);
  if (!set) handlers.set(id, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

/** Run the most recently registered handler. False when nothing is listening. */
export function runCommand(id: CommandId): boolean {
  const set = handlers.get(id);
  const fn = set && [...set].at(-1);
  if (!fn) return false;
  fn();
  return true;
}

let capture: ((e: KeyboardEvent) => void) | null = null;

/** While set, the shortcut listener hands the next key here instead of running a command. */
export function setShortcutCapture(fn: ((e: KeyboardEvent) => void) | null) {
  capture = fn;
}

export function handleShortcutKey(e: KeyboardEvent) {
  if (e.repeat || e.isComposing) return;
  if (capture) {
    capture(e);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const id = matchShortcut(e, shortcutContext(e.target), loadOverrides());
  if (!id || !runCommand(id)) return;
  e.preventDefault();
  e.stopPropagation();
}
