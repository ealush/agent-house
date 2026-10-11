// Durable prompt queue (F22): follow-ups for a session that can't take input
// right now, persisted in the registry under the conversation identity so they
// follow adoption and resume. Core owns typing and turn state; this module owns
// queue state and the flush policy (deliver at the next idle — never into a
// waiting session, where typed text would answer the agent's prompt). It takes
// its runtime as narrow callbacks: the registry on one side, Core's input path
// on the other.
import type { Registry } from './registry.ts';
import type { WindowView } from './sessions.ts';

export type LaunchChange = { model?: string; effort?: string };

export type QueueItem = {
  id: string;
  text: string;
  enter: boolean;
  at: number;
  launchChange?: LaunchChange;
};

const now = () => Math.floor(Date.now() / 1000);

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
};

export class QueueManager {
  private registry: Registry;
  private rt: QueueRuntime;

  constructor(registry: Registry, rt: QueueRuntime) {
    this.registry = registry;
    this.rt = rt;
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

  /**
   * Type the oldest queued item into every session that went idle. Waiting
   * sessions are skipped on purpose: they are blocked on a prompt, and an
   * older follow-up must not answer it — an explicit send delivers there.
   */
  async deliverDue(windows: WindowView[]): Promise<void> {
    const t0 = now();
    for (const w of windows) {
      if (!w.queued || (w.status !== 'idle' && w.status !== 'attention')) continue;
      // Freshly (re)started agents render their UI first; don't type into a half-drawn TUI.
      if (t0 - (w.createdAt || 0) < 5) continue;
      await this.rt.withInput(w.uid, async () => {
        if (this.rt.justSent(w.uid)) return;
        const taken = this.take(w.uid);
        if (!taken) return;
        const { next, rest } = taken;
        this.rt.markSent(w.uid);
        if (next.enter) await this.rt.captureTurnStart(w.uid, next.text);
        try {
          await this.rt.paste(w.id, next.text, next.enter);
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
        }
        w.queued = rest.length;
        w.status = 'busy';
      });
    }
  }
}
