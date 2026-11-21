// Spaces (docs/spec/17-spaces.md): where sessions belong. The decisions, as plain values:
// what a name may be, what a new Space's folder starts with, the list made from the
// sessions, History and the Spaces folder, and what a removal hides. No I/O here.
import { DomainError } from '../errors.ts';

export type SpaceKind = 'space' | 'repo' | 'folder';

export type SpaceView = {
  name: string;
  kind: SpaceKind;
  /** Its folder, short (`~/spaces/Trips`); null when no session says where it is. */
  path: string | null;
  exists: boolean;
  live: number;
  conversations: number;
  lastActivityAt: number;
};

/** A Space taken off the list (SPC-5), as spaces.json keeps it. */
export type Removed = {
  name: string;
  kind: SpaceKind;
  path: string | null;
  removedAt: number;
  conversations: number;
  /** Where a plain Space's folder went (absolute), or null when nothing moved. */
  archive: string | null;
  /** The conversations it hid (History refs): anything else in the Space is new and brings it back. */
  refs: string[];
};

export type RemovedView = Omit<Removed, 'archive' | 'refs'> & { archived: boolean };

/** What the state stream says: when `revision` moves, GET /api/spaces has a new list. */
export type SpacesState = { revision: number };

export class SpaceError extends DomainError {
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
  }
}

export const MAX_PREFERENCES = 65_536;
export const MAX_MEMORY = 262_144;
export const MAX_MEMORY_FILES = 200;
export const MEMORY_INDEX = 'MEMORY.md';
export const PREFERENCES_FILE = 'AGENTS.md';

const NAME = /^[A-Za-z0-9_-][A-Za-z0-9 ._-]{0,63}$/;
const MEMORY_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,76}\.md$/;

/** A plain Space's name, which is also its folder's. */
export function spaceName(v: unknown): string {
  if (typeof v !== 'string' || !NAME.test(v) || v.endsWith(' ') || v.includes('..')) {
    throw new SpaceError(400, 'invalid_space_name', 'a Space is named with 1–64 letters, digits, spaces, ".", "_" or "-", not starting with "." or a space');
  }
  return v;
}

export function memoryFile(v: unknown): string {
  if (typeof v !== 'string' || !MEMORY_FILE.test(v) || v.includes('..')) {
    throw new SpaceError(400, 'invalid_memory_file', 'a memory file is named with 1–80 letters, digits, ".", "_" or "-", ending in .md');
  }
  return v;
}

export function preferencesText(v: unknown): string {
  if (typeof v !== 'string') throw new SpaceError(400, 'invalid_preferences', 'preferences are text');
  if (v.length > MAX_PREFERENCES) throw new SpaceError(413, 'preferences_too_long', `preferences are at most ${MAX_PREFERENCES} characters`);
  return v;
}

export function memoryText(v: unknown): string {
  if (typeof v !== 'string') throw new SpaceError(400, 'invalid_memory', 'a memory file is text');
  if (v.length > MAX_MEMORY) throw new SpaceError(413, 'memory_too_long', `a memory file is at most ${MAX_MEMORY} characters`);
  return v;
}

/** What a new Space's AGENTS.md says when the person gave no preferences of their own. */
export function startingPreferences(name: string): string {
  return `# ${name}

This is a Space in Agent House: a place for conversations about one subject, with no
repository behind it. Every agent that works here reads this file, so what's written
below applies to all of them.

## Preferences

Write how you'd like agents to work in this Space: what it's for, the tone, what to
always or never do.

## Memory

This Space keeps a shared memory in \`memory/\`, for every agent and every conversation
here.

- At the start of a conversation, read \`memory/${MEMORY_INDEX}\` and the files it links to.
- When you learn something worth keeping (a decision, a preference, a fact about the
  work, an open question), write it down: one topic a file in \`memory/\`, linked from
  \`memory/${MEMORY_INDEX}\` with a one-line summary. Update a file rather than adding a
  second one about the same thing, and remove what turned out to be wrong.
- Never write secrets, passwords or tokens into memory.
`;
}

export function startingMemory(name: string): string {
  return `# ${name}: memory

One line per file in this folder: what it holds. Agents keep this list current.
`;
}

/** The files a new Space's folder starts with, relative to it. */
export function startingFiles(name: string, preferences?: string): Array<{ file: string; text: string }> {
  return [
    { file: PREFERENCES_FILE, text: preferences?.trim() ? preferences : startingPreferences(name) },
    // Claude Code and Gemini CLI read their own file; both import AGENTS.md.
    { file: 'CLAUDE.md', text: `@${PREFERENCES_FILE}\n` },
    { file: 'GEMINI.md', text: `@${PREFERENCES_FILE}\n` },
    { file: `memory/${MEMORY_INDEX}`, text: startingMemory(name) },
  ];
}

/** A session or conversation as the list counts it: its Space's name and folder. */
export type Placed = { project: string; projectPath: string | null; at: number };

export type ListInput = {
  /** Folders in the Spaces folder (not the archive), with their short paths. */
  plain: Array<{ name: string; path: string; at: number }>;
  live: Placed[];
  history: Placed[];
  removed: Removed[];
  kindOf: (path: string | null) => SpaceKind;
  exists: (path: string | null) => boolean;
};

/** Every Space with something in it, and every plain one, by name; removed ones left out. */
export function listSpaces(i: ListInput): SpaceView[] {
  const gone = new Set(i.removed.map((r) => r.name));
  const by = new Map<string, SpaceView>();
  const at = (name: string, path: string | null): SpaceView => {
    let s = by.get(name);
    if (!s) {
      s = { name, kind: i.kindOf(path), path, exists: false, live: 0, conversations: 0, lastActivityAt: 0 };
      by.set(name, s);
    } else if (!s.path && path) {
      s.path = path;
      s.kind = i.kindOf(path);
    }
    return s;
  };
  for (const p of i.plain) {
    const s = at(p.name, p.path);
    s.path = p.path;
    s.kind = 'space';
  }
  for (const w of i.live) {
    if (!w.project) continue;
    const s = at(w.project, w.projectPath);
    s.live++;
    s.lastActivityAt = Math.max(s.lastActivityAt, w.at);
  }
  for (const h of i.history) {
    if (!h.project) continue;
    const s = at(h.project, h.projectPath);
    s.conversations++;
    s.lastActivityAt = Math.max(s.lastActivityAt, h.at);
  }
  return [...by.values()]
    .filter((s) => !gone.has(s.name))
    .map((s) => ({ ...s, exists: i.exists(s.path) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.name.localeCompare(b.name));
}

export function removedView(r: Removed): RemovedView {
  const { archive, refs, ...rest } = r;
  return { ...rest, archived: !!archive };
}

/**
 * The removals still in force, given what's live and in History now (SPC-5). Removing
 * hides the conversations that were there; a Space with a session started since, or a
 * conversation it didn't hide, is used again and comes back. A window from before (one
 * ending as it was removed) doesn't count: removing waits for none to run.
 */
export function stillRemoved(removed: Removed[], live: Array<{ project: string; createdAt: number }>, history: Array<{ project: string; ref: string }>): Removed[] {
  return removed.filter((r) => !live.some((w) => w.project === r.name && w.createdAt >= r.removedAt) && !history.some((h) => h.project === r.name && !r.refs.includes(h.ref)));
}

/** Whether History shows this conversation: not one a removal hid. */
export function shown(removed: Removed[], h: { project: string; ref: string }): boolean {
  return !removed.some((r) => r.name === h.project && r.refs.includes(h.ref));
}

/** Where a removed plain Space's folder goes: `<archive>/<name>`, else `<name> 2`, `<name> 3`… */
export function archiveName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; ; n++) if (!taken(`${name} ${n}`)) return `${name} ${n}`;
}
