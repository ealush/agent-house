// Durable prompt queue (F22): follow-ups for a session that can't take input
// right now, persisted in the registry under the conversation identity so they
// follow adoption and resume. Core owns typing and turn state; this module owns
// queue state and the flush policy (deliver at the next idle — never into a
// waiting session, where typed text would answer the agent's prompt). It takes
// its runtime as narrow callbacks: the registry on one side, Core's input path
// on the other.
import { open, stat } from 'node:fs/promises';
import type { Registry } from './registry.ts';
import type { WindowView } from './sessions.ts';

export type LaunchChange = { model?: string; effort?: string };

export type QueueItem = {
  id: string;
  text: string;
  enter: boolean;
  at: number;
  launchChange?: LaunchChange;
  /** Its id is its sender's (an idempotency id), not one ah made up: remembered once delivered. */
  named?: boolean;
};

const now = () => Math.floor(Date.now() / 1000);

/**
 * A freshly (re)started agent is still drawing its UI, and its terminal may not
 * be in raw mode yet: typed text lands in the input but Enter arrives as a bare
 * newline and never submits. Input waits until it has settled.
 */
export function starting(w: Pick<WindowView, 'createdAt'>, t = now()): boolean {
  return t - (w.createdAt || 0) < 5;
}

/** The Core input operations a queue delivery needs. */
export type QueueRuntime = {
  /** Serialize paste + Enter as one operation per session. */
  withInput<T>(uid: string, fn: () => Promise<T>): Promise<T>;
  /** True within the submit grace period after a delivery. */
  justSent(uid: string): boolean;
  /** Record a delivery (starts the grace period). */
  markSent(uid: string): void;
  /** Snapshot the turn start unless one is already open (F39). */
  captureTurnStart(uid: string, text: string): Promise<unknown>;
  /** Type text into the window, submitting with Enter when asked. */
  paste(windowId: string, text: string, enter: boolean): Promise<void>;
  /** Apply a validated model/effort switch alongside the delivery. */
  applyLaunchChange(uid: string, change: LaunchChange): void;
  /** Where the window's transcript ends now, or null when there's none to read. */
  transcriptMark(w: WindowView): Promise<TranscriptMark | null>;
  /** Whether `text` was written to the transcript after `mark`. */
  landed(mark: TranscriptMark, text: string): Promise<boolean>;
  /** The transcript was written a moment ago: the agent may be starting a turn of its own. */
  writing(w: WindowView): Promise<boolean>;
  /** What sits unsent in the window's input box ('' empty, null unreadable). */
  inputBox(windowId: string): Promise<string | null>;
  /** The window's screen holds still a moment (no spinner: the agent isn't working). */
  still(windowId: string): Promise<boolean>;
  /** Empty the window's input box; whether it's empty now. */
  clearInput(windowId: string): Promise<boolean>;
};

/** An image file's path, which Claude Code swaps for "[Image #1]" as it takes the prompt. */
const IMAGE_PATH = /(?:^|\s)(?:~|\.{0,2})\/\S+\.(?:png|jpe?g|gif|webp|heic|heif|bmp|tiff?)(?=\s|$)/gi;

/**
 * What to look for in the transcript to know `text` arrived: its longest line of words,
 * image paths left out, as the transcript's JSON spells it. Null when nothing's left to
 * tell it by (only paths, or a few characters).
 */
export function needleFor(text: string): string | null {
  const lines = text.split(IMAGE_PATH).flatMap((piece) => piece.split('\n')).map((l) => l.trim());
  const longest = lines.reduce((a, b) => (b.length > a.length ? b : a), '');
  return longest.length >= 4 ? JSON.stringify(longest.slice(0, 60)).slice(1, -1) : null;
}

/** Whether `text` was written to the transcript after `mark`. */
export async function transcriptHas(mark: TranscriptMark, text: string): Promise<boolean> {
  const needle = needleFor(text);
  if (!needle) return true;
  const s = await stat(mark.file).catch(() => null);
  if (!s || s.size < mark.size) return true; // rewritten: nobody can tell, so never type it twice
  if (s.size === mark.size) return false;
  // What came after the mark, in one read (a prompt lands near the start of it).
  const length = Math.min(s.size - mark.size, LANDED_READ);
  const fh = await open(mark.file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, mark.size);
    return buf.subarray(0, bytesRead).toString('utf8').includes(needle) || s.size - mark.size > LANDED_READ;
  } finally {
    await fh.close();
  }
}
const LANDED_READ = 64 << 20;

/** An append-only transcript's file and its length at one moment. */
export type TranscriptMark = { file: string; size: number };

/** A delivery not yet seen in the transcript, and where to look for it. */
type Unconfirmed = { item: QueueItem; mark: TranscriptMark; at: number };

/** Claude Code's stand-ins for what it was given: a long paste, an image's path. */
const PLACEHOLDER = /\[(?:Pasted text #\d+(?: \+\d+ lines?)?|Image #\d+)\]/g;

/**
 * Whether the input box holds `text` as ah typed it and nothing else: its words, however
 * the box wrapped them, a long paste or an image as Claude Code shows it ("[Pasted text
 * #1 +12 lines]", "[Image #1]"). Something else in it (your own typing) isn't ah's.
 */
export function boxHolds(box: string, text: string): boolean {
  const squash = (s: string) => s.replace(/\s+/g, '');
  const shown = squash(box.replace(PLACEHOLDER, ''));
  const typed = squash(text.replace(IMAGE_PATH, ' '));
  const placeheld = box.match(PLACEHOLDER) !== null;
  if (!shown) return placeheld && typed.length > 0;
  return shown === typed || (placeheld && typed.includes(shown));
}

/** How often a follow-up left sitting in the input box is taken back and typed again. */
const STUCK_RETRIES = 3;

/**
 * A typed follow-up is only safe once the agent has taken it. One typed into an
 * agent that had just started a turn of its own sits in the agent's input queue,
 * and an interrupt (Send Now's Escape) throws that away; ah, which removes an item
 * before typing it, would never know. So a delivery is watched until its text shows
 * in the transcript, and put back first in line if the agent settles without it.
 */
const CONFIRM_GRACE_MS = 10_000;

/** Slash commands answer on screen and may never reach the transcript as typed. */
export const confirmable = (item: QueueItem) => item.enter && !/^\/[\w-]+(\s|$)/.test(item.text.trimStart()) && needleFor(item.text) !== null;

/** How many delivered message ids a session remembers (QueueManager.noteDelivered). */
export const DELIVERED_KEEP = 64;

/** The ledger with `id` as its newest entry, oldest dropped past `keep`. Pure. */
export function withDelivered(ledger: readonly string[], id: string, keep = DELIVERED_KEEP): string[] {
  return [...ledger.filter((x) => x !== id), id].slice(-keep);
}

export class QueueManager {
  private registry: Registry;
  private rt: QueueRuntime;
  private unconfirmed = new Map<string, Unconfirmed>();
  /** Item id → times its Enter didn't take and it was taken back out of the box. */
  private stuck = new Map<string, number>();
  private graceMs: number;

  constructor(registry: Registry, rt: QueueRuntime, opts: { confirmGraceMs?: number } = {}) {
    this.registry = registry;
    this.rt = rt;
    this.graceMs = opts.confirmGraceMs ?? CONFIRM_GRACE_MS;
  }

  /** A copy of the session's queued items, oldest first. */
  items(uid: string): QueueItem[] {
    return [...((this.registry.get(uid)?.meta['ah.queue'] as QueueItem[] | undefined) ?? [])];
  }

  private store(uid: string, items: QueueItem[]): void {
    this.registry.setMeta(uid, 'ah.queue', items.length ? items : undefined);
  }

  /** Append an item; returns the new queue length. */
  enqueue(uid: string, item: QueueItem): number {
    const items = this.items(uid);
    items.push(item);
    this.store(uid, items);
    return items.length;
  }

  /**
   * Remove one item by id for immediate delivery (send-now), or the oldest
   * item when no id is given (ticker flush). Returns the item and what stays
   * queued, or null when the id isn't there. Removal lands before any typing:
   * at-most-once, never a duplicate turn (F16).
   */
  take(uid: string, itemId?: string): { next: QueueItem; rest: QueueItem[] } | null {
    const items = this.items(uid);
    const at = itemId === undefined ? 0 : items.findIndex((q) => q.id === itemId);
    if (at < 0 || at >= items.length) return null;
    const [next] = items.splice(at, 1);
    this.store(uid, items);
    return { next, rest: items };
  }

  /**
   * Move one item to position `to` (clamped), the rest keeping their order.
   * Synchronous, like take(), so a delivery never sees a half-moved queue.
   * Returns the new order, or null when the id isn't there (already sent).
   */
  move(uid: string, itemId: string, to: number): QueueItem[] | null {
    const items = this.items(uid);
    const at = items.findIndex((q) => q.id === itemId);
    if (at < 0) return null;
    const [item] = items.splice(at, 1);
    items.splice(Math.max(0, Math.min(items.length, to)), 0, item);
    this.store(uid, items);
    return items;
  }

  /** Put an item back at the front: its delivery failed before anything was typed. */
  requeue(uid: string, item: QueueItem): void {
    this.store(uid, [item, ...this.items(uid).filter((q) => q.id !== item.id)]);
  }

  /** Drop one item or the whole queue; returns what was removed. */
  clear(uid: string, itemId?: string): QueueItem[] {
    const before = this.items(uid);
    const rest = itemId ? before.filter((q) => q.id !== itemId) : [];
    const removed = itemId ? before.filter((q) => q.id === itemId) : before;
    this.store(uid, rest);
    return removed;
  }

  /** Before typing `item`: where to look for it afterwards (only what can be confirmed). */
  async markFor(w: WindowView, item: QueueItem): Promise<TranscriptMark | null> {
    return confirmable(item) ? this.rt.transcriptMark(w).catch(() => null) : null;
  }

  /** `item` was typed in: watch for it in the transcript from `mark`. */
  delivered(uid: string, item: QueueItem, mark: TranscriptMark | null): void {
    if (mark) this.unconfirmed.set(uid, { item, mark, at: Date.now() });
    else this.unconfirmed.delete(uid);
    if (item.named) this.noteDelivered(uid, item.id);
  }

  /**
   * A message the caller named (an idempotency id) was typed into the session. The last
   * DELIVERED_KEEP ids stay in the session's record, so asking again with the same id —
   * a retry after a lost answer, or after a restart — is "delivered", not a second turn.
   */
  noteDelivered(uid: string, id: string): void {
    const r = this.registry.get(uid);
    if (r) this.registry.setMeta(uid, 'ah.delivered', withDelivered((r.meta['ah.delivered'] as string[] | undefined) ?? [], id));
  }

  wasDelivered(uid: string, id: string): boolean {
    return ((this.registry.get(uid)?.meta['ah.delivered'] as string[] | undefined) ?? []).includes(id);
  }

  /**
   * Settle the session's watched delivery: seen in the transcript, it's done;
   * not seen, it goes back first in line (returned). Send Now calls this once its
   * interrupt has landed, which is when held input is gone for good.
   */
  async recover(uid: string): Promise<QueueItem | null> {
    const pending = this.unconfirmed.get(uid);
    if (!pending) return null;
    this.unconfirmed.delete(uid);
    if (await this.rt.landed(pending.mark, pending.item.text).catch(() => true)) {
      this.stuck.delete(pending.item.id);
      return null;
    }
    console.warn(`queue: ${uid}'s delivered follow-up never reached the conversation; it's queued again`);
    this.requeue(uid, pending.item);
    return pending.item;
  }

  /**
   * Watched deliveries into sessions that have settled since: an agent idle a
   * while after the delivery has taken whatever it was going to. One still in
   * the input box as typed (its Enter didn't take: the agent drawing its turn's
   * end, a paste still being taken in) is taken back out and queued first again,
   * so the queue never shows it sent while it sits there unsent; after
   * STUCK_RETRIES it's left in the box. Anything else there isn't ah's to touch.
   */
  async confirmDeliveries(windows: WindowView[]): Promise<void> {
    for (const w of windows) {
      const pending = this.unconfirmed.get(w.uid);
      if (!pending) continue;
      // Read while it works, the transcript grows by megabytes: looked at once it stops.
      if (w.status === 'busy' || w.status === 'waiting') continue;
      await this.rt.withInput(w.uid, async () => {
        if (this.unconfirmed.get(w.uid) !== pending) return;
        if (await this.rt.landed(pending.mark, pending.item.text).catch(() => true)) {
          this.unconfirmed.delete(w.uid);
          this.stuck.delete(pending.item.id);
          return;
        }
        if (Date.now() - pending.at < this.graceMs || (await this.rt.writing(w).catch(() => true))) return;
        const box = await this.rt.inputBox(w.id).catch(() => null);
        if (box !== '') {
          const tries = this.stuck.get(pending.item.id) ?? 0;
          if (box !== null && boxHolds(box, pending.item.text) && tries < STUCK_RETRIES && (await this.rt.clearInput(w.id).catch(() => false))) {
            this.stuck.set(pending.item.id, tries + 1);
            this.unconfirmed.delete(w.uid);
            console.warn(`queue: ${w.uid}'s follow-up sat in the input box unsent (Enter didn't take); taken back out and queued first again (${tries + 1}/${STUCK_RETRIES})`);
            this.requeue(w.uid, pending.item);
            w.queued += 1;
            return;
          }
          if (box !== null && boxHolds(box, pending.item.text)) console.warn(`queue: ${w.uid}'s follow-up is still in the input box after ${tries} retries; left there to send by hand`);
          // Unreadable, someone else's typing, or past its retries: not ah's to type again.
          this.unconfirmed.delete(w.uid);
          this.stuck.delete(pending.item.id);
          return;
        }
        // A turn whose status never said so (one the agent started itself) animates its
        // spinner: what it holds still goes in when that turn ends. Typed twice, it'd be
        // two turns.
        if (!(await this.rt.still(w.id).catch(() => false))) return;
        if (await this.recover(w.uid)) w.queued += 1;
      });
    }
  }

  /** Forget a session's watched delivery (it ended, or was replaced). */
  forget(uid: string): void {
    this.unconfirmed.delete(uid);
  }

  /**
   * Type the oldest queued item into every session that went idle. Waiting
   * sessions are skipped on purpose: they are blocked on a prompt, and an
   * older follow-up must not answer it — an explicit send delivers there.
   */
  async deliverDue(windows: WindowView[]): Promise<void> {
    const t0 = now();
    for (const w of windows) {
      if (!w.queued || (w.status !== 'idle' && w.status !== 'attention')) continue;
      if (starting(w, t0)) continue;
      await this.rt.withInput(w.uid, async () => {
        if (this.rt.justSent(w.uid)) return;
        // Idle by its status, but its transcript is being written: a turn of its own
        // (a background task reporting back) is starting, and what's typed now would
        // wait in its input queue. Next tick.
        if (await this.rt.writing(w).catch(() => false)) return;
        // The one before it isn't confirmed yet: settle that first, in order.
        if (this.unconfirmed.has(w.uid)) return;
        const first = this.items(w.uid)[0];
        if (!first) return;
        const mark = await this.markFor(w, first);
        // The turn's snapshot first (it can take seconds), with the follow-up still in
        // the queue on disk: a restart meanwhile delivers it after, rather than lose it.
        if (first.enter) await this.rt.captureTurnStart(w.uid, first.text);
        const taken = this.take(w.uid, first.id);
        if (!taken) return;
        const { next, rest } = taken;
        this.rt.markSent(w.uid);
        try {
          await this.rt.paste(w.id, next.text, next.enter);
          this.delivered(w.uid, next, mark);
          if (next.launchChange) this.rt.applyLaunchChange(w.uid, next.launchChange);
        } catch (err) {
          console.error(`queue delivery to ${w.id} failed:`, err);
          // Nothing reached the window: the follow-up is still owed, so it goes
          // back first in line. Once any text landed it stays delivered (never twice).
          if ((err as { typed?: boolean }).typed === false) {
            this.requeue(w.uid, next);
            w.queued = rest.length + 1;
            return;
          }
          if (next.named) this.noteDelivered(w.uid, next.id);
        }
        w.queued = rest.length;
        w.status = 'busy';
      });
    }
  }
}
