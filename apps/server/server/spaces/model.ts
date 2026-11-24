// Spaces (docs/spec/17-spaces.md): where sessions belong. The decisions, as plain values:
// what a name may be, what a new Space's folder starts with, the list made from the
// sessions, History and the Spaces folder, and what a removal hides. No I/O here.
import { DomainError } from '../errors.ts';

export type SpaceKind = 'space' | 'repo' | 'folder';

export type SpaceView = {
  /** Stable server-side identifier (`sp-xxxxxxxx`), independent of folder basename. */
  id?: string;
  name: string;
  kind: SpaceKind;
  /** Its primary folder, short (`~/spaces/Trips`); null when no session says where it is. */
  path: string | null;
  /** Space-owned context directory (preferences, memory/, knowledge/, artifacts/), short path. */
  contextPath?: string | null;
  /** Distinct repo/folder roots attached to sessions in this Space (supports multi-repo Spaces). */
  roots?: string[];
  /**
   * The projects (repositories and folders, short paths; a worktree stands for its repository)
   * attached to this Space: a session started in one is in this Space unless it was put in
   * another. A project is attached to one Space at most (`spaces` 3).
   */
  projects?: string[];
  exists: boolean;
  live: number;
  conversations: number;
  lastActivityAt: number;
};

/** Persistent catalog entry for a Space in spaces.json (gives every Space a stable id & roots). */
export type SpaceCatalogEntry = {
  id: string;
  name: string;
  kind?: SpaceKind;
  path?: string | null;
  roots?: string[];
  /** Attached projects (SpaceView.projects). */
  projects?: string[];
  createdAt: number;
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
export const CONTEXT_FILE = '.ah-space-context.md';
export const MAX_CONTEXT_FILE_CHARS = 16_000;

export type SpaceArtifact = {
  name: string;
  path: string;
  shortPath: string;
  bytes: number;
  updatedAt: number;
};

export type SpaceContextNote = {
  id: string;
  title: string;
  updatedAt: number;
};

export type SpaceContextView = {
  space: string;
  kind: SpaceKind;
  path: string | null;
  contextPath: string;
  memoryDir: string;
  artifactsDir: string;
  contextFile: string;
  roots: string[];
  preferences: string;
  memoryIndex: string;
  memoryFiles: Array<{ name: string; summary: string; bytes: number; updatedAt: number }>;
  artifacts: SpaceArtifact[];
  notes: SpaceContextNote[];
  hasCustomContext: boolean;
  pointer: string;
  markdown: string;
};

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
export function startingPreferences(name: string, kind: SpaceKind = 'space'): string {
  const intro =
    kind === 'space'
      ? `This is a Space in Agent House: a place for conversations about one subject, with no repository behind it. Every agent that works here reads this file, so what's written below applies to all of them.`
      : `This is Space-level context for "${name}" in Agent House, stored outside the repository so your personal instructions, memory, and artifacts never pollute git history.`;
  return `# ${name}

${intro}

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
    // Claude Code and Gemini's agy read their own file; both import AGENTS.md.
    { file: 'CLAUDE.md', text: `@${PREFERENCES_FILE}\n` },
    { file: 'GEMINI.md', text: `@${PREFERENCES_FILE}\n` },
    { file: `memory/${MEMORY_INDEX}`, text: startingMemory(name) },
  ];
}

/** Formats a promoted note/artifact/result for Space memory with provenance metadata. */
export function formatPromotedKnowledge(o: { title: string; markdown: string; source?: string; promotedAt: number; by?: string | null }): string {
  const stamp = new Date(o.promotedAt * 1000).toISOString();
  const meta = [`Source: ${o.source?.trim() || 'manual'}`, `Promoted: ${stamp}`, ...(o.by ? [`By: ${o.by}`] : [])].join(' · ');
  const body = o.markdown.trim();
  const hasHeading = /^#\s+/.test(body);
  return `${hasHeading ? '' : `# ${o.title.trim()}\n\n`}> ${meta}\n\n${body}\n`;
}

/** Updates MEMORY.md index text with a one-line link for `file` if not already listed. */
export function upsertMemoryIndex(current: string, spaceName: string, file: string, summary: string): string {
  const base = current.trim() ? current.trimEnd() : startingMemory(spaceName).trimEnd();
  const cleanSummary = summary.replace(/\s+/g, ' ').trim().slice(0, 140) || file.replace(/\.md$/i, '');
  const entry = `- [${file}](./${file}) — ${cleanSummary}`;
  const lines = base.split('\n');
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const idx = lines.findIndex((l) => new RegExp(`\\(\\.\\/${escaped}\\)|\\b${escaped}\\b`).test(l));
  if (idx >= 0) lines[idx] = entry;
  else lines.push(entry);
  return `${lines.join('\n')}\n`;
}

/** Builds a safe `.md` memory filename from an arbitrary title. */
export function slugMemoryFile(title: string): string {
  const base = title
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9_-]+/, '')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .slice(0, 72)
    .replace(/[-.]+$/, '');
  return `${base || 'knowledge'}.md`;
}

function clipText(s: string, max: number): string {
  const trimmed = s.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function firstHeadingOrLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim());
  return line ? line.replace(/^#+\s*/, '').trim().slice(0, 120) : 'Empty';
}

/**
 * Compact one-paragraph system-prompt pointer passed via harness CLI flags (`--append-system-prompt` / `--rules`)
 * so harnesses immediately know where Space preferences, memory, artifacts, and `ah space context` live
 * without bloating the launch command line.
 */
export function renderSpacePointer(o: {
  space: string;
  kind: SpaceKind;
  contextDir: string;
  memoryDir: string;
  artifactsDir: string;
  contextFile: string;
  artifactCount: number;
  memoryFileCount: number;
  noteCount: number;
}): string {
  const counts = [
    o.memoryFileCount > 0 ? `${o.memoryFileCount} memory file${o.memoryFileCount === 1 ? '' : 's'}` : null,
    o.artifactCount > 0 ? `${o.artifactCount} artifact${o.artifactCount === 1 ? '' : 's'}` : null,
    o.noteCount > 0 ? `${o.noteCount} note${o.noteCount === 1 ? '' : 's'}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return [
    `Agent House Space "${o.space}" (${o.kind}${counts ? `; ${counts}` : ''}).`,
    `Space context dir: ${o.contextDir} (preferences: ${o.contextDir}/${PREFERENCES_FILE}, shared memory: ${o.memoryDir}/${MEMORY_INDEX}, shared artifacts: ${o.artifactsDir}/).`,
    `Full Space context snapshot: ${o.contextFile}.`,
    `Run \`ah space context\` anytime for live Space preferences, memory, notes, and artifacts, or \`ah space artifacts\` to list/add deliverables.`,
  ].join(' ');
}

/**
 * Full Space context Markdown snapshot written to `<contextDir>/.ah-space-context.md`,
 * returned by `GET /api/spaces/:name/context` / `ah space context`, and injected into
 * Claude Code's `SessionStart` hook (`additionalContext`).
 */
export function renderSpaceContextMarkdown(o: {
  space: string;
  kind: SpaceKind;
  path: string | null;
  contextDir: string;
  memoryDir: string;
  artifactsDir: string;
  roots: string[];
  preferences: string;
  memoryIndex: string;
  memoryFiles: Array<{ name: string; summary: string; bytes: number }>;
  artifacts: SpaceArtifact[];
  notes: SpaceContextNote[];
}): string {
  const lines: string[] = [
    `# Agent House Space: ${o.space}`,
    '',
    `- Kind: ${o.kind}`,
    ...(o.path ? [`- Primary folder: ${o.path}`] : []),
    ...(o.roots.length > 1 ? [`- Attached roots: ${o.roots.join(', ')}`] : []),
    `- Space context dir: \`${o.contextDir}\` (\`$AH_SPACE_DIR\`)`,
    `- Shared memory: \`${o.memoryDir}/${MEMORY_INDEX}\` (\`$AH_SPACE_MEMORY_DIR\`)`,
    `- Shared artifacts: \`${o.artifactsDir}/\` (\`$AH_SPACE_ARTIFACTS_DIR\`)`,
    '',
  ];
  const prefs = clipText(o.preferences, 6_000);
  if (prefs) {
    lines.push('## Space Preferences (`AGENTS.md`)', '', prefs, '');
  }
  const memIdx = clipText(o.memoryIndex, 4_000);
  if (memIdx || o.memoryFiles.length > 0) {
    lines.push('## Shared Space Memory (`memory/`)', '');
    if (memIdx) lines.push(memIdx, '');
    const extra = o.memoryFiles.filter((f) => f.name !== MEMORY_INDEX);
    if (extra.length > 0) {
      lines.push('Topic files:');
      for (const f of extra.slice(0, 40)) {
        lines.push(`- \`${o.memoryDir}/${f.name}\` — ${f.summary}`);
      }
      lines.push('');
    }
  }
  if (o.artifacts.length > 0) {
    lines.push('## Space Artifacts (`artifacts/`)', '');
    for (const a of o.artifacts.slice(0, 50)) {
      lines.push(`- \`${a.path}\` (${a.bytes} B)`);
    }
    lines.push('');
  }
  if (o.notes.length > 0) {
    lines.push('## Space Notes', '');
    for (const n of o.notes.slice(0, 20)) {
      lines.push(`- ${n.title} (\`${n.id}\`)`);
    }
    lines.push('');
  }
  lines.push(
    '## Space CLI Tools',
    '',
    '- `ah space context` — reload fresh Space preferences, memory, artifacts, and notes',
    '- `ah space artifacts` — list artifacts; `ah space artifacts add <file>` to publish a deliverable',
    '- `ah space promote --title "<title>" "<markdown>"` — promote durable knowledge into Space memory',
    '- `ah notes --space "$AH_SPACE"` / `ah tasks --space "$AH_SPACE"` — inspect Space notes and tasks',
    '',
  );
  return clipText(lines.join('\n'), MAX_CONTEXT_FILE_CHARS) + '\n';
}

export { firstHeadingOrLine };

/** A session or conversation as the list counts it: the Space it's in (none: null) and its project. */
export type Placed = { space: string | null; projectPath: string | null; at: number };

export type ListInput = {
  /** Folders in the Spaces folder (not the archive, not repositories), with their short paths. */
  plain: Array<{ name: string; path: string; at: number }>;
  live: Placed[];
  history: Placed[];
  removed: Removed[];
  exists: (path: string | null) => boolean;
};

const WORKTREE_SLUG_RE = /^(?:claude|codex|gemini|agy|grok|opencode|muse|hermes)-[0-9a-f]{4}$/i;
const MANGLED_CACHE_RE = /^home-[^/]+-\.cache-/i;

/**
 * Ephemeral worktree slugs or cache dirs that should never appear as projects once idle. The
 * name is only a guess when there's no path: a real repository may be called `codex-cafe`.
 */
export function isNoiseSpace(name: string, path: string | null): boolean {
  if (!path) return WORKTREE_SLUG_RE.test(name) || MANGLED_CACHE_RE.test(name);
  return path.includes('/.worktrees/') || path.includes('/.cache/');
}

/**
 * The Spaces: every one made in the Spaces folder (`spaces` 3: a repository or a folder is a
 * project, never a Space), removed ones left out, by name. A session or conversation counts in
 * the Space it's in.
 */
export function listSpaces(i: ListInput): SpaceView[] {
  const gone = new Set(i.removed.map((r) => r.name));
  const by = new Map<string, SpaceView>();
  for (const p of i.plain) {
    if (gone.has(p.name)) continue;
    by.set(p.name, { name: p.name, kind: 'space', path: p.path, exists: false, live: 0, conversations: 0, lastActivityAt: 0 });
  }
  for (const w of i.live) {
    const s = w.space ? by.get(w.space) : undefined;
    if (!s) continue;
    s.live++;
    s.lastActivityAt = Math.max(s.lastActivityAt, w.at);
  }
  for (const h of i.history) {
    const s = h.space ? by.get(h.space) : undefined;
    if (!s) continue;
    s.conversations++;
    s.lastActivityAt = Math.max(s.lastActivityAt, h.at);
  }
  return [...by.values()]
    .map((s) => ({ ...s, exists: i.exists(s.path) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.name.localeCompare(b.name));
}

/**
 * Which Space a session is in: the one it was put in (`chosen`; null: taken out of every
 * Space), else the Space its project is attached to (`attached`: project path → Space), else none.
 */
export function spaceFor(chosen: string | null | undefined, projectPath: string | null, attached: ReadonlyMap<string, string>): string | null {
  if (chosen !== undefined) return chosen;
  return projectPath ? (attached.get(projectPath) ?? null) : null;
}

/** A project to attach: a folder's path (absolute or `~/…`), at most 1024 characters. */
export function projectPathOf(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 1024 || !(v.startsWith('/') || v === '~' || v.startsWith('~/')) || v.split('/').includes('..')) {
    throw new SpaceError(400, 'invalid_project', 'a project is a folder\'s path: absolute or under ~');
  }
  return v.trim().replace(/\/+$/, '') || '/';
}

export const MAX_PROJECTS = 50;

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
export function stillRemoved(removed: Removed[], live: Array<{ space?: string | null; createdAt: number }>, history: Array<{ space?: string | null; ref: string }>): Removed[] {
  return removed.filter((r) => !live.some((w) => w.space === r.name && w.createdAt >= r.removedAt) && !history.some((h) => h.space === r.name && !r.refs.includes(h.ref)));
}

/**
 * Whether History shows this conversation: not one a removal hid (by its ref: once a Space's
 * folder is archived, what ran there is in no Space, and stays hidden all the same).
 */
export function shown(removed: Removed[], h: { space?: string | null; ref: string }): boolean {
  return !removed.some((r) => r.refs.includes(h.ref));
}

/** Where a removed plain Space's folder goes: `<archive>/<name>`, else `<name> 2`, `<name> 3`… */
export function archiveName(name: string, taken: (candidate: string) => boolean): string {
  if (!taken(name)) return name;
  for (let n = 2; ; n++) if (!taken(`${name} ${n}`)) return `${name} ${n}`;
}
