// One GUI viewer's stream: a snapshot, then appends. The session's transcript is
// re-resolved every few seconds, so a fresh session whose transcript appears later,
// or a /clear that starts a new one, turns into a new snapshot rather than a stall.
import type { FeedMessage, FeedPage } from './schema.ts';
import { feedFor, type AnyFeed } from './feed.ts';

export type Source = { adapter: string; harness: string; file: string | null } | 'no-adapter' | null;
export type Resolve = (fresh: boolean) => Promise<Source>;

const POLL_MS = 400;
const RESOLVE_MS = 2500;
export const SNAPSHOT = 200;

type Open = { feed: AnyFeed; harness: string } | { reason: 'no-adapter' | 'no-transcript' | 'not-found' };

async function openFeed(resolve: Resolve, fresh: boolean): Promise<Open> {
  const src = await resolve(fresh);
  if (src === null) return { reason: 'not-found' };
  if (src === 'no-adapter') return { reason: 'no-adapter' };
  const feed = src.file ? feedFor(src.file, src.adapter) : null;
  return feed ? { feed, harness: src.harness } : { reason: 'no-transcript' };
}

/** Runs until `signal` aborts. `send` writes one message to the client. */
export async function streamFeed(resolve: Resolve, send: (msg: FeedMessage) => void, signal: AbortSignal) {
  let feed: AnyFeed | null = null;
  let harness = '';
  let generation = -1;
  let head = 0;
  let unavailable = '';
  let resolvedAt = 0;
  let shown = false;

  while (!signal.aborted) {
    try {
      if (!feed || Date.now() - resolvedAt > RESOLVE_MS) {
        resolvedAt = Date.now();
        // While nothing is found yet, look harder: the transcript may have just appeared.
        const next = await openFeed(resolve, !feed);
        if ('reason' in next) {
          feed = null;
          if (next.reason !== unavailable) send({ type: 'unavailable', reason: next.reason });
          unavailable = next.reason;
        } else if (next.feed !== feed) {
          feed = next.feed;
          harness = next.harness;
          generation = -1;
          unavailable = '';
        }
      }
      if (feed) {
        await feed.update();
        if (feed.generation !== generation) {
          const page = feed.page(Infinity, SNAPSHOT);
          const reason = !shown ? 'initial' : generation === -1 ? 'rotated' : 'truncated';
          send({ type: 'snapshot', reason, harness, entries: page.entries, floor: feed.floor, head: feed.head, hasOlder: page.hasOlder });
          generation = feed.generation;
          head = feed.head;
          shown = true;
        } else if (feed.head > head) {
          const entries = feed.after(head);
          head = feed.head;
          if (entries.length) send({ type: 'append', entries, head });
        }
      }
    } catch (err) {
      console.warn(`feed: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

export async function feedPage(resolve: Resolve, before: number, limit: number): Promise<FeedPage | null> {
  const open = await openFeed(resolve, false);
  if ('reason' in open) return null;
  await open.feed.update();
  return open.feed.page(before, limit);
}
