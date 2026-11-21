// Spaces in the web client (docs/spec/17-spaces.md): each host's list, read again when the
// hub says its list changed (state `spaces.revision`) or the hosts do. A host without the
// `spaces` feature (an older one) has no list; its projects still come from its sessions.
import { useCallback, useEffect, useState } from 'react';
import type { HostApi, SpaceView, SpacesList, State } from './api.ts';

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
export function removalText(s: Pick<SpaceView, 'kind' | 'conversations' | 'path'>): string {
  const n = s.conversations === 1 ? 'its conversation' : s.conversations ? `its ${s.conversations} conversations` : 'it';
  const files = s.kind === 'space' ? `Its folder moves to the Spaces archive, with its preferences and memory.` : `${s.kind === 'repo' ? 'The repository' : 'The folder'}${s.path ? ` (${s.path})` : ''} isn't touched.`;
  return `Takes ${n} out of the Inbox and History. ${files} Nothing is deleted: Restore it from Settings → Spaces, or start a session in it again.`;
}

/** "Repository", "Folder", "Space": what a Space is, in its settings. */
export const KIND_LABEL: Record<SpaceView['kind'], string> = { space: 'Space', repo: 'Repository', folder: 'Folder' };
