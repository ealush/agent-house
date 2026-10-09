import { useSyncExternalStore } from 'react';

/**
 * Device-local order of sidebar blocks. Empty until the user drags one.
 * Session order is separate and lives on the server (`ah.order`).
 */
export type SavedGroups = { project: string[]; host: string[] };

const KEY = 'ah.groupOrder.v1';

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function load(): SavedGroups {
  try {
    const raw = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '');
    if (!raw || typeof raw !== 'object') return { project: [], host: [] };
    return { project: ids(raw.project), host: ids(raw.host) };
  } catch {
    return { project: [], host: [] };
  }
}

let state: SavedGroups = load();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function getGroupOrder(): SavedGroups {
  return state;
}

export function setGroupList(kind: 'project' | 'host', next: string[]) {
  const prev = state[kind];
  if (prev.length === next.length && prev.every((id, i) => id === next[i])) return;
  state = { ...state, [kind]: next };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* Private mode: the order lasts until reload. */
  }
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGroupOrder(): SavedGroups {
  return useSyncExternalStore(subscribe, getGroupOrder, getGroupOrder);
}

export function useSavedGroups(multiHost: boolean): string[] {
  const saved = useGroupOrder();
  return multiHost ? saved.host : saved.project;
}
