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

/**
 * Whether a session has a conversation to resume. Not found proves none only when ah could
 * have found one: its agent's transcripts are read (a feed) and a transcript of it would be
 * newer than discovery's 30-day horizon (it was created since). Otherwise it can't be told:
 * it's resumed, and whether its agent starts says the rest. Pure.
 */
export function hasConversation(o: { feed: boolean; found: boolean; createdAt: number; now: number }): boolean {
  if (o.found || !o.feed) return true;
  return o.now - o.createdAt >= 30 * 86400 - 3600;
}

export type ReviveDeps = {
  config: () => ReviveConfig;
  list: () => InterruptedSession[];
  /** Restores it, still interrupted by `incident` (else it's someone else's now: refused). */
  restore: (uid: string, incident: string) => Promise<Restored>;
  /** Whether its conversation is on disk: an agent that never got a message (Claude Code) saved none to resume. */
  hasConversation: (uid: string) => Promise<boolean>;
  /** A tmux server to come back into, before anything is restored (true once there is one). */
  tmux: () => Promise<boolean>;
  /**
   * Whether the agent came up in its window and stayed (a missing executable, or a resume it
   * refused, leaves the shell); true when it can't be told.
   */
  started?: (uid: string, windowId: string) => Promise<boolean>;
  /** It didn't: its window goes, and it's interrupted again as it was, with why. */
  notStarted?: (s: InterruptedSession, windowId: string, error: string) => Promise<void>;
  failed: (uid: string, error: string) => void;
  alert: (p: { title: string; body: string; tag: string; url: string }) => void;
  changed: () => void;
  /** What it's in the middle of, kept across ah restarts (a restart mid-batch picks it up). */
  store?: { load: () => Partial<ReviveSaved> | null; save: (s: ReviveSaved) => void };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

/** What a Revival keeps across ah restarts. */
export type ReviveSaved = { deaths: number[]; incidents: string[]; halted: boolean; told: boolean };

export class Revival {
  private deps: ReviveDeps;
  private deaths: number[] = [];
  private incidents = new Set<string>();
  private running: Promise<void> | null = null;
  private halted = false;
  private told = false;

  constructor(deps: ReviveDeps) {
    this.deps = deps;
    const saved = deps.store?.load();
    if (saved) {
      this.deaths = Array.isArray(saved.deaths) ? saved.deaths.filter((t) => typeof t === 'number') : [];
      this.incidents = new Set(Array.isArray(saved.incidents) ? saved.incidents.filter((i) => typeof i === 'string') : []);
      this.halted = saved.halted === true;
      this.told = saved.told === true;
    }
  }

  private now() {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private save() {
    try {
      this.deps.store?.save({ deaths: this.deaths, incidents: [...this.incidents], halted: this.halted, told: this.told });
    } catch (err) {
      console.error('revive: could not save what it is bringing back:', (err as Error).message);
    }
  }

  /** Stops bringing back what it was: those sessions are yours (restore or dismiss them). */
  private abandon() {
    this.incidents.clear();
    this.save();
  }

  /** At ah's start: what an ah restart cut short is brought back the rest of the way. */
  start() {
    if (!this.incidents.size) return;
    if (this.halted || !this.deps.config().autoRestore) return this.abandon();
    this.running ??= this.run().finally(() => (this.running = null));
  }

  /** Interruptions.tick: what it just noticed, one incident at a time. */
  noticed(incident: { id: string; cause: InterruptCause; count: number }) {
    if (!REVIVES.has(incident.cause)) return;
    const c = this.deps.config();
    if (incident.cause === 'tmux_server') this.deaths = [...this.deaths, this.now()].slice(-50);
    if (crashLooping(this.deaths, this.now(), c)) {
      this.halted = true;
      // What it was still bringing back is left to you too: a later incident doesn't revive it.
      this.incidents.clear();
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
      return this.save();
    }
    // A quiet spell since the last loop: bringing back resumes, and a new loop is told again.
    this.halted = false;
    this.told = false;
    if (!c.autoRestore) return this.save();
    this.incidents.add(incident.id);
    this.save();
    this.running ??= this.run().finally(() => (this.running = null));
  }

  /**
   * Whether ah is bringing this incident's sessions back by itself (its alert and the apps say
   * so): one it took on and hasn't finished or let go, never just one of a cause it revives.
   */
  reviving(incident: string): boolean {
    return this.incidents.has(incident) && this.deps.config().autoRestore && !this.halted;
  }

  /** Waits for the current run (tests). */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** A tmux server to come back into, waited for a while (it may be starting). */
  private async server(sleep: (ms: number) => Promise<void>): Promise<boolean> {
    for (let i = 0; !(await this.deps.tmux().catch(() => false)); i++) {
      if (i >= 10 || this.halted) return false;
      await sleep(2000);
    }
    return true;
  }

  private async run() {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // A server first: restoring into none would make one in ah's own cgroup, set up as ah's.
    if (!(await this.server(sleep))) {
      console.warn('revive: no tmux server to bring sessions back into; restore them in ah');
      return this.abandon();
    }
    let first = true;
    // Each once per incident: one cut off again by a later incident gets its own turn.
    const tried = new Set<string>();
    const pick = () => toRevive(this.deps.list(), this.incidents).find((s) => !tried.has(`${s.incident}\u0000${s.uid}`));
    for (;;) {
      if (!pick()) break;
      // The pause first, then who's next: what it read before pausing may be stale by now.
      if (!first) await sleep(this.deps.config().paceSeconds * 1000);
      first = false;
      if (this.halted || !this.deps.config().autoRestore) return this.abandon();
      // tmux may have died again meanwhile: a server first, every time.
      if (!(await this.server(sleep))) {
        console.warn('revive: the tmux server is gone again; restore the rest in ah');
        return this.abandon();
      }
      // Read after the server: one whose old server answered again is running, not interrupted.
      const next = pick();
      if (!next) break;
      tried.add(`${next.incident}\u0000${next.uid}`);
      // Nothing to resume (never used: no conversation saved): left for you, said why.
      if (!(await this.deps.hasConversation(next.uid).catch(() => true))) {
        this.deps.failed(next.uid, 'it had no saved conversation to come back to (it was never sent a message)');
        continue;
      }
      try {
        const r = await this.deps.restore(next.uid, next.incident);
        // Typed is not started: an agent that isn't there, or refused its resume, leaves a shell.
        if (this.deps.started && !(await this.deps.started(next.uid, r.windowId).catch(() => true))) {
          console.warn(`revive: ${next.uid} didn't start in ${r.windowId}`);
          await this.deps.notStarted?.(next, r.windowId, "its agent didn't start (it may be missing, or it couldn't resume this conversation)");
        } else console.log(`revive: ${next.uid} back in ${r.windowId}${r.noted ? ', told where it stopped' : ''}`);
      } catch (err) {
        const error = (err as Error).message || 'it could not be restored';
        console.warn(`revive: ${next.uid} didn't come back: ${error}`);
        this.deps.failed(next.uid, error);
      }
      this.deps.changed();
    }
    // Done with every incident that has no one left to bring back (one noticed meanwhile stays).
    const left = new Set(toRevive(this.deps.list(), this.incidents).map((s) => s.incident));
    for (const id of [...this.incidents]) if (!left.has(id)) this.incidents.delete(id);
    this.save();
  }
}
