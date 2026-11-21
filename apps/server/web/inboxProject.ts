// The Inbox's project filter: the title's menu narrows every list on the page (cards,
// sections, blocks, the search) to one project. A project is its name on a host: two
// machines' checkouts of the same repository are two projects, as the sidebar's blocks are.

export type InboxProject = { name: string; host: string };

type Placed = { project: string; host: string };

/** Every Space with a live session or a past conversation, and every plain one (`plain`, docs/spec/17-spaces.md), once each, by name (then host). */
export function inboxProjects(windows: Placed[], history: Placed[], plain: Placed[] = []): InboxProject[] {
  const seen = new Map<string, InboxProject>();
  for (const x of [...windows, ...history, ...plain]) {
    if (!x.project) continue;
    const key = `${x.host}\n${x.project}`;
    if (!seen.has(key)) seen.set(key, { name: x.project, host: x.host });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.host.localeCompare(b.host));
}

/** In the chosen project; everything is, with none chosen. */
export function inProject(x: Placed, p: InboxProject | null): boolean {
  return !p || (x.project === p.name && x.host === p.host);
}

/** Its name; with several hosts, the host too, as the same name can be on each. */
export function projectLabel(p: InboxProject, multiHost: boolean): string {
  return multiHost ? `${p.name} — ${p.host}` : p.name;
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
export function projectFolder(p: InboxProject, windows: (Placed & { projectPath: string })[], history: (Placed & { cwd: string; at: number })[]): { cwd: string; host: string } | null {
  const live = windows.find((w) => inProject(w, p) && w.projectPath);
  if (live) return { cwd: live.projectPath, host: p.host };
  const past = history.filter((h) => inProject(h, p) && h.cwd).sort((a, b) => b.at - a.at)[0];
  return past ? { cwd: past.cwd, host: p.host } : null;
}
