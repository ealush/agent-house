// Spaces in the web client (docs/spec/17-spaces.md): each host's list, read again when the
// hub says its list changed (state `spaces.revision`) or the hosts do. A host without the
// `spaces` feature (an older one) has no list; its projects still come from its sessions.
import { useCallback, useEffect, useState } from 'react';
import type { HostApi, SpaceView, SpacesList, State } from './api.ts';
import { canonicalProjectPath } from './inboxProject.ts';

export type HostSpaces = { host: string; list: SpacesList };

/** Every host's Spaces list that answered, and a way to read them again now. */
export function useSpaces(state: State, clientFor: (host: string) => HostApi): { lists: HostSpaces[]; reload: () => void } {
  const [lists, setLists] = useState<HostSpaces[]>([]);
  const [bump, setBump] = useState(0);
  const hosts = state.hosts.filter((h) => h.online).map((h) => h.name);
  // The hub's own list is offered only when it says it has one; a peer is asked and may not.
  const asked = hosts.filter((h) => h !== state.hostname || (state.features?.spaces ?? 0) > 0);
  const key = `${state.spaces?.revision ?? ''}|${asked.join(',')}|${bump}`;
  useEffect(() => {
    let live = true;
    void Promise.all(asked.map((host) => clientFor(host).spaces().then((list) => ({ host, list }), () => null))).then((got) => {
      if (live) setLists(got.filter((x): x is HostSpaces => !!x));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const reload = useCallback(() => setBump((n) => n + 1), []);
  return { lists, reload };
}

/** The plain Spaces, as the Inbox's menu places them: empty ones are Spaces too. */
export function plainSpaces(lists: HostSpaces[]): Array<{ project: string; host: string }> {
  return lists.flatMap((l) => l.list.spaces.filter((s) => s.kind === 'space').map((s) => ({ project: s.name, host: l.host })));
}

/** A Space as its host lists it, if it does. */
export function spaceOn(lists: HostSpaces[], host: string, name: string): SpaceView | null {
  return lists.find((l) => l.host === host)?.list.spaces.find((s) => s.name === name) ?? null;
}

/** What a removal does to this Space, said before it does it (SPC-5). */
export function removalText(s: Pick<SpaceView, 'kind' | 'conversations' | 'path' | 'projects'>): string {
  if (s.projects) {
    const n = s.conversations === 1 ? 'its conversation' : s.conversations ? `its ${s.conversations} conversations` : 'it';
    return `Takes ${n} out of the Inbox and History, and its folder (preferences, memory, artifacts) to the Spaces archive. Its projects aren't touched; their sessions are in no Space until you attach them to another. Nothing is deleted: Restore it from Settings → Spaces.`;
  }
  const n = s.conversations === 1 ? 'its conversation' : s.conversations ? `its ${s.conversations} conversations` : 'it';
  const files = s.kind === 'space' ? `Its folder moves to the Spaces archive, with its preferences and memory.` : `${s.kind === 'repo' ? 'The repository' : 'The folder'}${s.path ? ` (${s.path})` : ''} isn't touched.`;
  return `Takes ${n} out of the Inbox and History. ${files} Nothing is deleted: Restore it from Settings → Spaces, or start a session in it again.`;
}

/** "Repository", "Folder", "Space": what a Space is, in its settings. */
export const KIND_LABEL: Record<SpaceView['kind'], string> = { space: 'Space', repo: 'Repository', folder: 'Folder' };

/**
 * The projects to offer for attaching to a Space (SPC-8): the folders sessions work in and New
 * session offers, worktrees folded into their repository, without the Spaces folder's own
 * Spaces or caches, by name. `taken`: attached already (left out).
 */
export function knownProjects(paths: Array<string | null | undefined>, spacesRoot: string, taken: string[] = []): string[] {
  const root = spacesRoot.replace(/\/+$/, '');
  const out = new Set<string>();
  for (const raw of paths) {
    if (!raw) continue;
    const p = canonicalProjectPath(raw.replace(/\/+$/, '') || '/');
    if (p === root || p.startsWith(`${root}/`) || p.includes('/.cache/') || taken.includes(p)) continue;
    out.add(p);
  }
  return [...out].sort((a, b) => (a.split('/').pop() ?? a).localeCompare(b.split('/').pop() ?? b, undefined, { sensitivity: 'base' }) || a.localeCompare(b));
}

/** A project's name, as lists show it: its folder's. */
export const projectName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;

/** A short (`~/…`) or absolute path, absolute, without a trailing slash. */
function absolute(p: string, home: string): string {
  const h = home.replace(/\/+$/, '');
  const x = p.trim().replace(/\/+$/, '') || '/';
  return x === '~' ? h : x.startsWith('~/') ? `${h}/${x.slice(2)}` : x;
}

/**
 * The Space a session started in `cwd` joins by itself (`spaces` 3): the one its project is
 * attached to (`cwd` in it or below it, a worktree counting as its repository), or the Space
 * whose own folder it is. None: null.
 */
export function attachedSpaceFor(spaces: Pick<SpaceView, 'name' | 'path' | 'projects'>[], cwd: string, home: string): string | null {
  if (!cwd.trim()) return null;
  const at = absolute(canonicalProjectPath(cwd), home);
  const inside = (root: string) => at === root || at.startsWith(`${root}/`);
  let best: { name: string; len: number } | null = null;
  for (const s of spaces) {
    for (const p of [...(s.projects ?? []), ...(s.path ? [s.path] : [])]) {
      const root = absolute(p, home);
      if (inside(root) && (!best || root.length > best.len)) best = { name: s.name, len: root.length };
    }
  }
  return best?.name ?? null;
}

/**
 * What New session sends as `space`: nothing when the folder's own Space is the one chosen
 * (`attached`), '' for no Space when the folder would put it in one, else the Space chosen.
 */
export function spaceToSend(chosen: string, attached: string | null): string | undefined {
  if (chosen === (attached ?? '')) return undefined;
  return chosen;
}
