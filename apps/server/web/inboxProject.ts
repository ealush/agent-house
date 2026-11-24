// The Inbox's Space filter: the title's menu narrows every list on the page (cards, sections,
// blocks, the search) to one Space (docs/spec/17-spaces.md), or to the sessions in none. A Space
// is its name on a host: two machines' Spaces of the same name are two, as the sidebar's
// blocks are. (An older host's entries are its projects, as before `spaces` 3.)

export type InboxProject = { name: string; host: string };

/** The menu's entry for sessions in no Space (`spaces` 3): its name is ''. */
export const NOT_IN_A_SPACE = 'Not in a Space';

type Placed = { project: string; space?: string | null; host: string; cwd?: string | null; projectPath?: string | null };

/**
 * The hosts whose state says which Space each session is in (`spaces` 3, docs/spec/17-spaces.md):
 * there `space` is the whole answer (absent: none). An older host sends `space` only for a
 * session put in one, and its sessions are grouped by their `project` as before.
 */
export type SpacedHosts = ReadonlySet<string>;

/** The Space it's in: on a `spaces` 3 host its `space` ('' for none), else its Space or project. */
export const placedSpace = (x: Placed, spaced: SpacedHosts = new Set()) => (spaced.has(x.host) ? (x.space ?? '') : x.space || x.project);

const WORKTREE_SLUG_RE = /^(?:claude|codex|gemini|agy|grok|opencode|muse|hermes)-[0-9a-f]{4}$/i;
const MANGLED_CACHE_RE = /^home-[^/]+-\.cache-/i;

/** Collapses `<parent>/.worktrees/<repo>/<slug>[/sub]` back to `<parent>/<repo>` so worktrees never leak into pickers or headers. */
export function canonicalProjectPath(path: string): string {
  const m = path.match(/^(.*)\/\.worktrees\/([^/]+)\/[^/]+(?:\/.*)?$/);
  return m ? `${m[1]}/${m[2]}` : path;
}

/** True for orphaned worktree slugs or ephemeral cache folders that shouldn't clutter the Space menu when idle. */
export function isNoiseSpaceName(name: string, path?: string | null): boolean {
  if (WORKTREE_SLUG_RE.test(name) || MANGLED_CACHE_RE.test(name)) return true;
  if (!path) return false;
  return path.includes('/.worktrees/') || path.includes('/.cache/');
}

/**
 * The menu's entries, once each, by name (then host). On a `spaces` 3 host: its Spaces (`made`,
 * empty ones too) and, when a session or conversation there is in none, Not in a Space (name
 * ''), last. On an older host: every Space or project with a live session or a past
 * conversation, and its plain Spaces, worktrees and caches left out once idle.
 */
export function inboxProjects(windows: Placed[], history: Placed[], made: Array<{ project: string; host: string }> = [], spaced: SpacedHosts = new Set()): InboxProject[] {
  const seen = new Map<string, InboxProject>();
  const add = (name: string, host: string) => {
    const key = `${host}\n${name}`;
    if (!seen.has(key)) seen.set(key, { name, host });
  };
  for (const m of made) add(m.project, m.host);
  for (const x of [...windows, ...history]) {
    if (spaced.has(x.host)) {
      if (!x.space) add('', x.host);
      continue;
    }
    const name = placedSpace(x);
    if (!name) continue;
    // An older host's worktrees and caches: only while a session runs there.
    if (!windows.includes(x) && isNoiseSpaceName(name, x.projectPath ?? x.cwd)) continue;
    add(name, x.host);
  }
  return [...seen.values()].sort((a, b) => Number(!a.name) - Number(!b.name) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.host.localeCompare(b.host));
}

/** In the chosen Space (Not in a Space: in none); everything is, with none chosen. */
export function inProject(x: Placed, p: InboxProject | null, spaced: SpacedHosts = new Set()): boolean {
  return !p || (placedSpace(x, spaced) === p.name && x.host === p.host);
}

/** Its name; with several hosts, the host too, as the same name can be on each. */
export function projectLabel(p: InboxProject, multiHost: boolean): string {
  const name = p.name || NOT_IN_A_SPACE;
  return multiHost ? `${name} — ${p.host}` : name;
}

/** The stored choice (localStorage), if it is still one of the projects; else none: All Projects. */
export function chosenProject(stored: string | null, projects: InboxProject[]): InboxProject | null {
  if (!stored) return null;
  try {
    const p = JSON.parse(stored) as Partial<InboxProject>;
    return projects.find((x) => x.name === p.name && x.host === p.host) ?? null;
  } catch {
    return null;
  }
}

export const storedProject = (p: InboxProject | null): string => (p ? JSON.stringify({ name: p.name, host: p.host }) : '');

/**
 * Where a new session in the project starts: the project's folder from one of its live
 * sessions, else the folder of its newest conversation. None when it has neither.
 */
export function projectFolder(p: InboxProject, windows: (Placed & { projectPath: string })[], history: (Placed & { cwd: string; at: number })[], spaced: SpacedHosts = new Set()): { cwd: string; host: string } | null {
  const live = windows.find((w) => inProject(w, p, spaced) && w.projectPath);
  if (live) return { cwd: canonicalProjectPath(live.projectPath), host: p.host };
  const past = history.filter((h) => inProject(h, p, spaced) && h.cwd).sort((a, b) => b.at - a.at)[0];
  return past ? { cwd: canonicalProjectPath(past.cwd), host: p.host } : null;
}
