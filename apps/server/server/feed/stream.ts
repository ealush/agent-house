// One GUI viewer's stream: a snapshot, then appends. The session's transcript is
// re-resolved every few seconds, so a fresh session whose transcript appears later,
// or a /clear that starts a new one, turns into a new snapshot rather than a stall.
import type { Entry, FeedMessage, FeedPage, FeedPrompt } from './schema.ts';
import { feedFor, type AnyFeed } from './feed.ts';

/** `from`: the first line that is this conversation's (server/subagents' spawned Codex threads). */
export type Source = { adapter: string; harness: string; file: string | null; from?: number } | 'no-adapter' | null;
export type Resolve = (fresh: boolean) => Promise<Source>;

const POLL_MS = 400;
const RESOLVE_MS = 2500;
export const SNAPSHOT = 200;

type Open = { feed: AnyFeed; harness: string } | { reason: 'no-adapter' | 'no-transcript' | 'not-found' };

async function openFeed(resolve: Resolve, fresh: boolean): Promise<Open> {
  const src = await resolve(fresh);
  if (src === null) return { reason: 'not-found' };
  if (src === 'no-adapter') return { reason: 'no-adapter' };
  const feed = src.file ? feedFor(src.file, src.adapter, src.from) : null;
  return feed ? { feed, harness: src.harness } : { reason: 'no-transcript' };
}

/**
 * Where a viewer that already holds the transcript up to some entry asks to carry on
 * from (`?after=<seq>&id=<its id>&harness=<id>`): a device coming back to a session
 * it showed a moment or a day ago, instead of the newest page again, megabytes of it.
 */
export type Resume = { after: number; id: string; harness: string };

/** Only what came after `resume`, when that entry is still this transcript's and not too much came since. */
export function resumeFrom(feed: AnyFeed, harness: string, resume: Resume | null): Entry[] | null {
  if (!resume || resume.harness !== harness) return null;
  const at = feed.entries.find((e) => e.seq === resume.after);
  if (!at || at.id !== resume.id) return null;
  const since = feed.after(resume.after);
  return since.length <= SNAPSHOT ? since : null;
}

/** Runs until `signal` aborts. `send` writes one message to the client. */
export async function streamFeed(resolve: Resolve, send: (msg: FeedMessage) => void, signal: AbortSignal, resume: Resume | null = null) {
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
        const since = !shown ? resumeFrom(feed, harness, resume) : null;
        if (since) {
          // The viewer's copy carries on: the entries after it, not the newest page.
          send({ type: 'snapshot', reason: 'resume', harness, entries: since, floor: feed.floor, head: feed.head, hasOlder: true });
          generation = feed.generation;
          head = feed.head;
          shown = true;
        } else if (feed.generation !== generation) {
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

/** The GUI's rail of your messages needs all of them, not just the pages loaded so far. */
export async function feedPrompts(resolve: Resolve): Promise<FeedPrompt[] | null> {
  const open = await openFeed(resolve, false);
  if ('reason' in open) return null;
  await open.feed.update();
  // The same test the GUI's projection uses for a user block: a user entry with more than notices and tool results.
  return open.feed.entries
    .filter((e) => e.role === 'user' && e.parts.some((p) => p.type !== 'notice' && p.type !== 'tool_result'))
    .map((e) => ({
      seq: e.seq,
      at: e.at,
      text: e.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').slice(0, 300),
    }));
}
