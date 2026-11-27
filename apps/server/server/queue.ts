// Durable prompt queue (F22): follow-ups for a session that can't take input
// right now, persisted in the registry under the conversation identity so they
// follow adoption and resume. Core owns typing and turn state; this module owns
// queue state and the flush policy (deliver at the next idle — never into a
// waiting session, where typed text would answer the agent's prompt). It takes
// its runtime as narrow callbacks: the registry on one side, Core's input path
// on the other.
import { IMAGE_PATH } from './imagePaths.ts';
import { needleFor, type ConversationMark } from './feed/landed.ts';
import { devlog } from './devlog.ts';
import { piBridged } from './pi/bridge.ts';
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
  /** Typed in, but the agent's conversation never showed it (QueueManager.unsent): not queued. */
  unsent?: boolean;
  /** Times ah typed it again because its conversation never showed it: kept with it, across restarts. */
  retyped?: number;
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
  /** `w`, `id`: the session and the message, for an agent that takes messages other than typed (pi's bridge). */
  paste(windowId: string, text: string, enter: boolean, w?: WindowView, id?: string): Promise<void>;
  /** Its agent isn't in its window any more, its shell left behind (Core.agentGone): nothing is typed there. */
  agentGone?: (w: WindowView) => boolean;
  /** Apply a validated model/effort switch alongside the delivery. */
  applyLaunchChange(uid: string, change: LaunchChange): void;
  /** Where the window's conversation ends now, or null when its agent has none ah reads. */
  transcriptMark(w: WindowView): Promise<ConversationMark | null>;
  /** Whether the session's conversation has `text` from the user after `mark` (yes when it can't be told). */
  landed(uid: string, mark: ConversationMark, text: string): Promise<boolean>;
  /** The transcript was written a moment ago: the agent may be starting a turn of its own. */
  writing(w: WindowView): Promise<boolean>;
  /** What sits unsent in the window's input box ('' empty, null unreadable). */
  inputBox(windowId: string): Promise<string | null>;
  /** The window's screen holds still a moment (no spinner: the agent isn't working). */
  still(windowId: string): Promise<boolean>;
  /** Empty the window's input box; whether it's empty now. */
  clearInput(windowId: string): Promise<boolean>;
  /** Press Enter in the window (out of tmux's scrollback first). */
  press(windowId: string): Promise<void>;
};


/** A delivery not yet seen in the transcript, and where to look for it. */
type Unconfirmed = { item: QueueItem; mark: ConversationMark; at: number; nudged?: boolean };

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

/** A message shown as not sent: as it was typed, and where its conversation was then. */
type NotSent = { item: QueueItem; mark: ConversationMark };
/** Times a delivery its conversation never showed is typed again before it's shown as not sent. */
const UNSEEN_RETRIES = 1;

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
  /**
   * Per session: what the agent never took, and ah couldn't take back to type again. Kept in
   * the session's record too (`ah.unsent`), so ah restarting still shows it as not sent.
   */
  private notSent = new Map<string, NotSent[]>();
  /** Item id → times its Enter didn't take and it was taken back out of the box. */
  private stuck = new Map<string, number>();
  /** Items shown as not sent whose Send again is checking their conversation right now. */
  private resending = new Set<string>();
  private graceMs: number;

  constructor(registry: Registry, rt: QueueRuntime, opts: { confirmGraceMs?: number } = {}) {
    this.registry = registry;
    this.rt = rt;
    this.graceMs = opts.confirmGraceMs ?? CONFIRM_GRACE_MS;
  }

  /** The session's messages shown as not sent: from memory, else from its record (after a restart). */
  private notSentOf(uid: string): NotSent[] {
    const known = this.notSent.get(uid);
    if (known) return known;
    const saved = this.registry.get(uid)?.meta['ah.unsent'];
    const list = Array.isArray(saved) ? (saved as NotSent[]).filter((u) => u && typeof u.item?.id === 'string' && typeof u.item.text === 'string' && u.mark) : [];
    if (list.length) this.notSent.set(uid, list);
    return list;
  }

  private setNotSent(uid: string, list: NotSent[]): void {
    if (list.length) this.notSent.set(uid, list);
    else this.notSent.delete(uid);
    if (this.registry.get(uid)) this.registry.setMeta(uid, 'ah.unsent', list.length ? list : undefined);
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
    devlog.event('queue', { action: 'queued', uid, item: item.id, chars: item.text.length, position: items.length });
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
    devlog.event('queue', { action: 'moved', uid, item: itemId, to });
    return items;
  }

  /** Put an item back at the front: its delivery failed before anything was typed. */
  requeue(uid: string, item: QueueItem): void {
    this.store(uid, [item, ...this.items(uid).filter((q) => q.id !== item.id)]);
  }

  /** Drop one item or the whole queue; returns what was removed. */
  clear(uid: string, itemId?: string): QueueItem[] {
    const shown = this.notSentOf(uid);
    const kept = itemId ? shown.filter((u) => u.item.id !== itemId) : [];
    if (kept.length !== shown.length) this.setNotSent(uid, kept);
    const before = this.items(uid);
    const rest = itemId ? before.filter((q) => q.id !== itemId) : [];
    const removed = itemId ? before.filter((q) => q.id === itemId) : before;
    this.store(uid, rest);
    if (removed.length) devlog.event('queue', { action: 'removed', uid, items: removed.map((q) => q.id) });
    return removed;
  }

  /** Before typing `item`: where to look for it afterwards (only what can be confirmed). */
  async markFor(w: WindowView, item: QueueItem): Promise<ConversationMark | null> {
    return confirmable(item) ? this.rt.transcriptMark(w).catch(() => null) : null;
  }

  /** `item` was typed in: watch for it in the transcript from `mark`. */
  delivered(uid: string, item: QueueItem, mark: ConversationMark | null): void {
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
    if (await this.rt.landed(uid, pending.mark, pending.item.text).catch(() => true)) {
      this.stuck.delete(pending.item.id);
      return null;
    }
    // Typed again once already and still not seen: the conversation ah reads may not be the
    // one the agent writes (an agent that couldn't resume its own started another), and
    // typing it a third time would tell no more. It shows as not sent, to send again or let go.
    // Counted on the item itself: it goes with the session's queue, and survives ah restarting.
    const again = pending.item.retyped ?? 0;
    if (again >= UNSEEN_RETRIES) {
      console.warn(`queue: ${uid}'s follow-up still isn't in its conversation after it was typed again; shown as not sent`);
      devlog.event('queue', { action: 'not-sent', uid, item: pending.item.id, why: 'never reached the conversation, typed again' });
      this.setNotSent(uid, [...this.notSentOf(uid).filter((u) => u.item.id !== pending.item.id), { item: pending.item, mark: pending.mark }]);
      return null;
    }
    const item = { ...pending.item, retyped: again + 1 };
    console.warn(`queue: ${uid}'s delivered follow-up never reached the conversation; it's queued again`);
    devlog.event('queue', { action: 'requeued', uid, item: item.id, why: 'never reached the conversation' });
    this.requeue(uid, item);
    return item;
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
        if (await this.rt.landed(w.uid, pending.mark, pending.item.text).catch(() => true)) {
          this.unconfirmed.delete(w.uid);
          this.stuck.delete(pending.item.id);
          devlog.event('queue', { action: 'confirmed', uid: w.uid, item: pending.item.id, afterMs: Date.now() - pending.at });
          return;
        }
        if (Date.now() - pending.at < this.graceMs || (await this.rt.writing(w).catch(() => true))) return;
        const box = await this.rt.inputBox(w.id).catch(() => null);
        // A first message (no conversation when it went in, none now): whether it was taken can't
        // be read from one. Only what shows counts: still in a box ah reads (typed again, below), or
        // one more Enter where it can't read the box (Grok's start screen took the first). Past
        // that it was delivered, never typed again or "not sent" on no evidence (an agent whose
        // conversation ah can't find).
        if (pending.mark.file === null && !(box !== null && box !== '' && boxHolds(box, pending.item.text)) && !(box === null && !pending.nudged && !piBridged(w))) {
          this.unconfirmed.delete(w.uid);
          this.stuck.delete(pending.item.id);
          devlog.event('queue', { action: 'confirmed', uid: w.uid, item: pending.item.id, afterMs: Date.now() - pending.at, unread: true });
          return;
        }
        if (box !== '') {
          const tries = this.stuck.get(pending.item.id) ?? 0;
          if (box !== null && boxHolds(box, pending.item.text) && tries < STUCK_RETRIES && (await this.rt.clearInput(w.id).catch(() => false))) {
            this.stuck.set(pending.item.id, tries + 1);
            devlog.event('queue', { action: 'requeued', uid: w.uid, item: pending.item.id, why: 'sat in the input box unsent', retry: tries + 1 });
            this.unconfirmed.delete(w.uid);
            console.warn(`queue: ${w.uid}'s follow-up sat in the input box unsent (Enter didn't take); taken back out and queued first again (${tries + 1}/${STUCK_RETRIES})`);
            this.requeue(w.uid, pending.item);
            w.queued += 1;
            return;
          }
          // A box ah can't read (most agents but Claude Code's): an Enter lost on the way
          // (a redraw, a paste still being taken in) left it there, or it's gone. One more
          // Enter sends what's there and does nothing to an empty box. Not into pi over ah's
          // bridge: its messages never go through the box, and an Enter could take a dialog.
          if (box === null && !pending.nudged && !piBridged(w)) {
            if (!(await this.rt.still(w.id).catch(() => false))) return;
            await this.rt.press(w.id);
            pending.nudged = true;
            pending.at = Date.now();
            devlog.event('queue', { action: 'enter-again', uid: w.uid, item: pending.item.id });
            console.warn(`queue: ${w.uid}'s message isn't in its conversation yet; pressed Enter again`);
            return;
          }
          // Still not seen, and it can't be typed again safely (whatever's in the box would
          // go in twice): said, not dropped. It shows as not sent, to send again or let go.
          console.warn(`queue: ${w.uid}'s message never reached its conversation (${box === null ? 'its box unreadable' : boxHolds(box, pending.item.text) ? `still in the box after ${tries} retries` : 'other text in the box'}); shown as not sent`);
          this.unconfirmed.delete(w.uid);
          this.stuck.delete(pending.item.id);
          this.setNotSent(w.uid, [...this.notSentOf(w.uid).filter((u) => u.item.id !== pending.item.id), { item: pending.item, mark: pending.mark }]);
          devlog.event('queue', { action: 'not-sent', uid: w.uid, item: pending.item.id, why: box === null ? 'box unreadable' : boxHolds(box, pending.item.text) ? 'still in the box' : 'other text in the box' });
          w.unsent = this.unsent(w.uid).length;
          return;
        }
        // A turn whose status never said so (one the agent started itself) animates its
        // spinner: what it holds still goes in when that turn ends. Typed twice, it'd be
        // two turns.
        if (!(await this.rt.still(w.id).catch(() => false))) return;
        if (await this.recover(w.uid)) w.queued += 1;
        // Or not sent, when it had been typed again already.
        w.unsent = this.unsent(w.uid).length;
      });
    }
    // One shown as not sent that the conversation has now (sent by hand from the
    // terminal, or with the next message) isn't one any more.
    for (const w of windows) {
      const shown = this.notSentOf(w.uid);
      if (!shown.length || w.status === 'busy') continue;
      const landed = new Set<string>();
      for (const u of shown) if (await this.rt.landed(w.uid, u.mark, u.item.text).catch(() => false)) landed.add(u.item.id);
      if (!landed.size) continue;
      // From what's there now: one added or sent again while this read stays as it is.
      const still = this.notSentOf(w.uid).filter((u) => !landed.has(u.item.id));
      this.setNotSent(w.uid, still);
      w.unsent = still.length;
    }
  }

  /** Messages typed into the session that its conversation never showed, oldest first. */
  unsent(uid: string): QueueItem[] {
    return this.notSentOf(uid).map((u) => ({ ...u.item, unsent: true }));
  }

  /**
   * One shown as not sent goes back first in line, to be sent again: 'queued'. One its
   * conversation has by now went in after all, and typed again it'd be a second turn: it's
   * let go instead, 'landed'. Null when it isn't one.
   */
  async sendAgain(uid: string, itemId: string): Promise<'queued' | 'landed' | null> {
    const one = this.notSentOf(uid).find((u) => u.item.id === itemId);
    // A second Send again while its conversation is checked finds it on its way, never
    // queues it twice.
    if (!one || this.resending.has(itemId)) return null;
    this.resending.add(itemId);
    try {
      // Left where it is (on disk) while that's read: a restart meanwhile can't lose it.
      const landed = await this.rt.landed(uid, one.mark, one.item.text).catch(() => false);
      // Let go of meanwhile (from another device): gone, not brought back.
      const shown = this.notSentOf(uid);
      if (!shown.some((u) => u.item.id === itemId)) return null;
      const left = shown.filter((u) => u.item.id !== itemId);
      if (landed) {
        this.setNotSent(uid, left);
        devlog.event('queue', { action: 'landed-after-all', uid, item: itemId });
        return 'landed';
      }
      // Sent again at your word: counted afresh. Out of "not sent" and into the queue in one
      // write: a crash between two would lose it from both.
      const { retyped: _retyped, unsent: _unsent, ...item } = one.item;
      if (left.length) this.notSent.set(uid, left);
      else this.notSent.delete(uid);
      this.registry.setMetas(uid, { 'ah.unsent': left.length ? left : undefined, 'ah.queue': [item, ...this.items(uid).filter((q) => q.id !== item.id)] });
      return 'queued';
    } finally {
      this.resending.delete(itemId);
    }
  }

  /** A delivery to the session is still waiting to be seen in its conversation. */
  watching(uid: string): boolean {
    return this.unconfirmed.has(uid);
  }

  /** The delivery to the session still waiting to be seen in its conversation, as it was sent. */
  watched(uid: string): QueueItem | null {
    return this.unconfirmed.get(uid)?.item ?? null;
  }

  /** Forget a session's watched delivery (it ended, or was replaced). */
  forget(uid: string): void {
    this.unconfirmed.delete(uid);
    this.setNotSent(uid, []);
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
      // An agent session whose agent is gone, its shell left behind: a follow-up typed now
      // would run as a command there. It waits for an agent in the window.
      if (this.rt.agentGone?.(w)) continue;
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
          await this.rt.paste(w.id, next.text, next.enter, w, next.id);
          this.delivered(w.uid, next, mark);
          devlog.event('queue', { action: 'delivered', uid: w.uid, item: next.id, window: w.id, chars: next.text.length, left: rest.length, watched: !!mark });
          if (next.launchChange) this.rt.applyLaunchChange(w.uid, next.launchChange);
        } catch (err) {
          console.error(`queue delivery to ${w.id} failed:`, err);
          devlog.event('queue', { action: 'failed', uid: w.uid, item: next.id, window: w.id, typed: (err as { typed?: boolean }).typed !== false, error: (err as Error).message });
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
