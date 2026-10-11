// Messages you sent from this device, shown before the server has them. The
// composer adds one the moment you press send; the GUI feed draws it as your
// bubble (or the queue tray as a queued row) until the transcript or the queue
// list has the real thing. A send that fails takes it back out.
import { useSyncExternalStore } from 'react';

export type Outgoing = {
  id: string;
  uid: string;
  text: string;
  at: number;
  /** sending: the request is in flight; sent: typed in, waiting for the transcript; queued: held until the agent is free. */
  state: 'sending' | 'sent' | 'queued';
  /** When the server answered. A queue fetch that started after this has the real row. */
  confirmedAt?: number;
};

const EMPTY: Outgoing[] = [];
let items: Outgoing[] = [];
const listeners = new Set<() => void>();
let n = 0;

function set(next: Outgoing[]) {
  items = next;
  byUid.clear();
  for (const fn of listeners) fn();
}

export function addOutgoing(uid: string, text: string, state: Outgoing['state']): string {
  const id = `out-${Date.now()}-${++n}`;
  set([...items, { id, uid, text, at: Date.now(), state }]);
  return id;
}

export function updateOutgoing(id: string, patch: Partial<Pick<Outgoing, 'state' | 'confirmedAt'>>) {
  if (!items.some((o) => o.id === id)) return;
  set(items.map((o) => (o.id === id ? { ...o, ...patch } : o)));
}

export function removeOutgoing(ids: string[]) {
  if (!ids.length) return;
  const drop = new Set(ids);
  set(items.filter((o) => !drop.has(o.id)));
}

// One stable array per session between changes, as useSyncExternalStore needs.
const byUid = new Map<string, Outgoing[]>();
function forUid(uid: string): Outgoing[] {
  let list = byUid.get(uid);
  if (!list) {
    const mine = items.filter((o) => o.uid === uid);
    list = mine.length ? mine : EMPTY;
    byUid.set(uid, list);
  }
  return list;
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useOutbox(uid: string): Outgoing[] {
  return useSyncExternalStore(subscribe, () => forUid(uid));
}

/** Whitespace-insensitive, the way an agent's transcript may reflow what was typed. */
export const sameText = (a: string, b: string) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
