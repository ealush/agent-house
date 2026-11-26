// When a session has finished, as its alerts tell it: not the moment a turn ends, since an
// agent often stops for a breath (a background subagent's turn, a hook's retry) and goes
// straight back to work, but once it has stayed done a while. Shared by the host's push
// (server/push.ts) and the page's own notifications (web/App.tsx): no Node imports here.

/** A turn's end counts once nothing has moved for this long (seconds). */
export const FINISH_SETTLE_S = 30;
/** At most one "finished" per session this often (seconds); a later one waits, it isn't lost. */
export const FINISH_SPACING_S = 180;

type Seen = { uid: string; status: string; subagents?: { active: number } | null };

export class Finishes {
  private last = new Map<string, string>();
  /** Sessions whose turn ended and hasn't been told yet → since when it has been quiet. */
  private pending = new Map<string, number>();
  private told = new Map<string, number>();
  private settle: number;
  private spacing: number;

  constructor(settle = FINISH_SETTLE_S, spacing = FINISH_SPACING_S) {
    this.settle = settle;
    this.spacing = spacing;
  }

  /**
   * Every session as it is now (`now` in epoch seconds): the ones that finished and are due
   * an alert. A turn ends going from busy to attention; it's told once it has stayed there
   * `settle` seconds with none of its subagents at work and nothing told for it in the last
   * `spacing`. Working again, needing you, or being looked at (idle) calls it off.
   */
  observe(sessions: Seen[], now: number): string[] {
    const due: string[] = [];
    const present = new Set<string>();
    for (const s of sessions) {
      present.add(s.uid);
      const prev = this.last.get(s.uid);
      this.last.set(s.uid, s.status);
      if (s.status === 'attention' && prev === 'busy') this.pending.set(s.uid, now);
      if (!this.pending.has(s.uid)) continue;
      if (s.status !== 'attention') {
        this.pending.delete(s.uid);
        continue;
      }
      // Its subagents still at work: not done, and quiet only from when they stop.
      if ((s.subagents?.active ?? 0) > 0) {
        this.pending.set(s.uid, now);
        continue;
      }
      if (now - this.pending.get(s.uid)! < this.settle || now - (this.told.get(s.uid) ?? -Infinity) < this.spacing) continue;
      this.pending.delete(s.uid);
      this.told.set(s.uid, now);
      due.push(s.uid);
    }
    for (const map of [this.last, this.pending, this.told]) for (const uid of map.keys()) if (!present.has(uid)) map.delete(uid);
    return due;
  }

  /** When the next waiting finish could be due (epoch seconds), or null when none waits. */
  next(): number | null {
    let soonest: number | null = null;
    for (const [uid, since] of this.pending) {
      const at = Math.max(since + this.settle, (this.told.get(uid) ?? -Infinity) + this.spacing);
      if (soonest === null || at < soonest) soonest = at;
    }
    return soonest;
  }
}
