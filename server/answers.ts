// One answer per prompt. Approving is typing keys into an agent, and the screen goes on
// showing the prompt for a moment after it's answered (the agent hasn't redrawn, its
// hook hasn't fired): a second tap, a second device, or a notification acted on late
// would type the keys again — into whatever comes next. The guard remembers which
// prompt (by its fingerprint, WindowView.askId) each session was just answered on, and
// refuses another answer to it until a pass sees the session leave that prompt, or a
// while has passed (an agent can ask the very same thing again).
//
// Pure state: the caller passes the time and the windows it read.

/** How long an answer holds without a pass seeing the prompt go. */
export const ANSWER_HOLD_MS = 15_000;

type Held = { askId: string | null; at: number };

export class AnswerGuard {
  private held = new Map<string, Held>();

  /** True, and the prompt counts as answered, if it hasn't been answered already. */
  claim(uid: string, askId: string | null, now: number): boolean {
    const h = this.held.get(uid);
    if (h && h.askId === askId && now - h.at < ANSWER_HOLD_MS) return false;
    this.held.set(uid, { askId, at: now });
    return true;
  }

  /** The keys never went out: the prompt is still unanswered. */
  release(uid: string, askId: string | null): void {
    if (this.held.get(uid)?.askId === askId) this.held.delete(uid);
  }

  /** A pass's windows: a session that no longer shows the prompt it was answered on can be answered again. */
  observe(windows: ReadonlyArray<{ uid: string; status: string; askId?: string | null }>): void {
    for (const [uid, h] of this.held) {
      const w = windows.find((x) => x.uid === uid);
      if (!w || w.status !== 'waiting' || (w.askId ?? null) !== h.askId) this.held.delete(uid);
    }
  }
}
