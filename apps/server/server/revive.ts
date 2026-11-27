// Bringing back, on its own, what a tmux server's death or a host restart cut off (CND-8):
// every interrupted session of that incident, working or not, in its own conversation with
// its own launch choices (Interruptions.restore). Mid-turn ones first, each told where it
// stopped; idle ones come back saying nothing, so no turn is spent. Paced, one after
// another. A failure stays on the session (`interrupted.failed`), for you to restore or
// dismiss. If tmux keeps dying (`maxCrashes` in `crashWindowMinutes`), ah stops: one alert,
// and the rest is yours, so a crash loop never becomes a revive loop.
// A window closed under a working agent (`window`) is restored by hand, as before.
import type { InterruptCause, InterruptedSession, Restored } from './interruptions.ts';
import type { ReviveConfig } from './revive/settings.ts';

/** The causes ah brings back from on its own. */
export const REVIVES: ReadonlySet<InterruptCause> = new Set(['tmux_server', 'host_restart']);

export { DEFAULT_REVIVE, reviveConfig, type ReviveConfig } from './revive/settings.ts';

/**
 * Whether tmux died too often to keep bringing sessions back: `deaths` are when it did
 * (epoch seconds), newest last. Pure.
 */
export function crashLooping(deaths: number[], now: number, c: Pick<ReviveConfig, 'maxCrashes' | 'crashWindowMinutes'>): boolean {
  if (c.maxCrashes <= 0) return false;
  return deaths.filter((t) => now - t <= c.crashWindowMinutes * 60).length >= c.maxCrashes;
}

/**
 * Who comes back from these incidents, in order: interrupted by a revived cause, not failed
 * already, mid-turn first (the list's own order), then the newest. Pure.
 */
export function toRevive(list: InterruptedSession[], incidents: ReadonlySet<string>): InterruptedSession[] {
  return list.filter((s) => incidents.has(s.incident) && REVIVES.has(s.cause) && !s.failed);
}

export type ReviveDeps = {
  config: () => ReviveConfig;
  list: () => InterruptedSession[];
  restore: (uid: string) => Promise<Restored>;
  /** Whether its conversation is on disk: an agent that never got a message (Claude Code) saved none to resume. */
  hasConversation: (uid: string) => Promise<boolean>;
  /** A tmux server to come back into, before anything is restored (true once there is one). */
  tmux: () => Promise<boolean>;
  failed: (uid: string, error: string) => void;
  alert: (p: { title: string; body: string; tag: string; url: string }) => void;
  changed: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class Revival {
  private deps: ReviveDeps;
  private deaths: number[] = [];
  private incidents = new Set<string>();
  private running: Promise<void> | null = null;
  private halted = false;
  private told = false;

  constructor(deps: ReviveDeps) {
    this.deps = deps;
  }

  private now() {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Interruptions.tick: what it just noticed, one incident at a time. */
  noticed(incident: { id: string; cause: InterruptCause; count: number }) {
    if (!REVIVES.has(incident.cause)) return;
    const c = this.deps.config();
    if (incident.cause === 'tmux_server') this.deaths = [...this.deaths, this.now()].slice(-50);
    if (crashLooping(this.deaths, this.now(), c)) {
      this.halted = true;
      if (!this.told) {
        this.told = true;
        console.warn(`revive: tmux stopped ${c.maxCrashes} times in ${c.crashWindowMinutes} minutes; not bringing sessions back on my own`);
        this.deps.alert({
          title: 'tmux keeps stopping',
          body: `It stopped ${c.maxCrashes} times in ${c.crashWindowMinutes} minutes, so ah stopped bringing sessions back by itself. Restore them in ah once it's steady.`,
          tag: 'revive-halted',
          url: '/#interrupted',
        });
      }
      return;
    }
    // A quiet spell since the last loop: bringing back resumes, and a new loop is told again.
    this.halted = false;
    this.told = false;
    if (!c.autoRestore) return;
    this.incidents.add(incident.id);
    this.running ??= this.run().finally(() => (this.running = null));
  }

  /** Whether ah is bringing this incident's sessions back by itself (its alert says so). */
  reviving(cause: InterruptCause): boolean {
    return REVIVES.has(cause) && this.deps.config().autoRestore && !this.halted;
  }

  /** Waits for the current run (tests). */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private async run() {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // A server first: restoring into none would make one in ah's own cgroup, set up as ah's.
    for (let i = 0; !(await this.deps.tmux().catch(() => false)); i++) {
      if (i >= 10 || this.halted) return void console.warn('revive: no tmux server to bring sessions back into; restore them in ah');
      await sleep(2000);
    }
    let first = true;
    const tried = new Set<string>();
    for (;;) {
      if (this.halted || !this.deps.config().autoRestore) return;
      // Each once a run: one that's still listed after its restore is left for you.
      const next = toRevive(this.deps.list(), this.incidents).find((s) => !tried.has(s.uid));
      if (!next) break;
      tried.add(next.uid);
      if (!first) await sleep(this.deps.config().paceSeconds * 1000);
      first = false;
      // Nothing to resume (never used: no conversation saved): left for you, said why.
      if (!(await this.deps.hasConversation(next.uid).catch(() => true))) {
        this.deps.failed(next.uid, 'it had no saved conversation to come back to (it was never sent a message)');
        continue;
      }
      try {
        const r = await this.deps.restore(next.uid);
        console.log(`revive: ${next.uid} back in ${r.windowId}${r.noted ? ', told where it stopped' : ''}`);
      } catch (err) {
        const error = (err as Error).message || 'it could not be restored';
        console.warn(`revive: ${next.uid} didn't come back: ${error}`);
        this.deps.failed(next.uid, error);
      }
      this.deps.changed();
    }
    this.incidents.clear();
  }
}
