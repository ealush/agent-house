import type { HostApi, QueueItem } from './api.ts';

/**
 * Edit takes a queued message out into the box, and sent again it's queued at the
 * end, behind everything (that's the server's queue). Its place is the message
 * that came after it, which it goes back in front of. The last one's place is the
 * end already, so it has none.
 */
export function placeOf(items: QueueItem[], id: string): string | undefined {
  const at = items.findIndex((q) => q.id === id);
  return at < 0 ? undefined : items[at + 1]?.id;
}

/** The index that puts `id` back in front of `before`: null when it's there already, or either has gone. */
export function placeBack(items: QueueItem[], id: string, before: string): number | null {
  const to = items.findIndex((q) => q.id === before);
  const at = items.findIndex((q) => q.id === id);
  return to >= 0 && at > to ? to : null;
}

/**
 * A message queued again goes back to its place. Quietly: if the queue moved on
 * meanwhile (the one it went before was sent), it stays where the server put it.
 */
export async function putBack(client: Pick<HostApi, 'queue' | 'moveQueued'>, uid: string, id: string, before: string): Promise<void> {
  try {
    const to = placeBack(await client.queue(uid), id, before);
    if (to !== null) await client.moveQueued(uid, id, to);
  } catch {}
}
