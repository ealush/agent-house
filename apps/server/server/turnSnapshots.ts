// Per-turn snapshots (F39): the working tree as it was before each of an agent's turns,
// kept as git commits under the session's refs, so a turn can be rolled back. This owns
// when a turn starts (one snapshot per turn, however many signals say it started), the
// session's snapshot switch, the captures themselves and their retention. Restoring is
// Core's: it has to stop the agent and hold the session's input first.
//
// A snapshot must never block or break a turn: every failure here is a missing
// snapshot, not an error the turn sees.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { expandHome, type Config } from './config.ts';
import { createSnapshot, deleteSnapshotRef, mainRepo, snapshotDiff } from './git.ts';
import type { Registry } from './registry.ts';
import type { SnapshotInfo, SnapshotStore } from './snapshots.ts';

const now = () => Math.floor(Date.now() / 1000);
const isDir = async (p: string) => !!(await stat(p).catch(() => null))?.isDirectory();

type Stored = { enabled?: unknown; lastTurn?: unknown } | undefined;

/** A session's snapshot switch and its last turn number, from the stored meta. Pure. */
export function snapshotSettings(stored: Stored, globallyOn: boolean): { enabled: boolean; lastTurn: number } {
  return { enabled: globallyOn && stored?.enabled !== false, lastTurn: typeof stored?.lastTurn === 'number' ? stored.lastTurn : 0 };
}

export class TurnSnapshots {
  private registry: Registry;
  private store: SnapshotStore;
  private config: () => Config;
  private stateDir: string;
  /** Sessions inside a turn (busy, or waiting on a prompt): one snapshot per turn, taken at its start. */
  private inTurn = new Set<string>();
  private locks = new Map<string, Promise<unknown>>();

  constructor(registry: Registry, store: SnapshotStore, config: () => Config, stateDir: string) {
    this.registry = registry;
    this.store = store;
    this.config = config;
    this.stateDir = stateDir;
  }

  limits() {
    const c = this.config().snapshots;
    return { maxFileBytes: c?.maxFileBytes ?? 10 * 1024 * 1024, keepTurns: c?.keepTurns ?? 50, retentionDays: c?.retentionDays ?? 7 };
  }

  settings(uid: string): { enabled: boolean; lastTurn: number } {
    return snapshotSettings(this.registry.get(uid)?.meta['ah.snapshots'] as Stored, this.config().snapshots?.enabled !== false);
  }

  /**
   * A turn starts: snapshot the tree before it, once. Called from the send path (which
   * knows the prompt and runs before the paste) and from status transitions (turns typed
   * in the terminal, where the prompt is unknown).
   */
  turnStart(uid: string, promptText: string): Promise<SnapshotInfo | null> {
    if (this.inTurn.has(uid)) return Promise.resolve(null);
    this.inTurn.add(uid);
    return this.capture(uid, 'turn', promptText).catch((err) => {
      console.error(`snapshot capture for ${uid} failed:`, err);
      return null;
    });
  }

  /** The turn is over (stopped, or about to be replaced): the next one snapshots again. */
  turnOver(uid: string): void {
    this.inTurn.delete(uid);
  }

  /** Inside a turn already: what a restore or Send now marks, so no capture starts mid-way. */
  holdTurn(uid: string): void {
    this.inTurn.add(uid);
  }

  /**
   * A pass's windows: entering busy or waiting starts a turn, but only hook status is
   * exact enough to trust (activity-based busy also fires for a TUI merely drawing);
   * anything else ends it.
   */
  observe(windows: ReadonlyArray<{ uid: string; agent: string | null; status: string; statusSource?: string }>): void {
    for (const w of windows) {
      if (!w.agent) continue;
      if (w.status === 'busy' || w.status === 'waiting') {
        if (w.statusSource === 'hook' && !this.inTurn.has(w.uid)) void this.turnStart(w.uid, '');
      } else this.inTurn.delete(w.uid);
    }
  }

  setEnabled(uid: string, enabled: boolean): void {
    this.registry.setMeta(uid, 'ah.snapshots', { enabled, lastTurn: this.settings(uid).lastTurn });
    if (!enabled) this.inTurn.delete(uid);
  }

  /** A safety snapshot of the tree as it is (before a restore): taken even with snapshots off. */
  safety(uid: string, why: string): Promise<SnapshotInfo | null> {
    return this.capture(uid, 'safety', why);
  }

  /** Captures and restores of one session never overlap. */
  async exclusive<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(uid) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(fn);
    this.locks.set(uid, task);
    try {
      return await task;
    } finally {
      if (this.locks.get(uid) === task) this.locks.delete(uid);
    }
  }

  private capture(uid: string, kind: 'turn' | 'safety', promptText: string): Promise<SnapshotInfo | null> {
    return this.exclusive(uid, async () => {
      const rec = this.registry.get(uid);
      if (!rec || !rec.harness || rec.harness === 'shell') return null;
      const settings = this.settings(uid);
      if (kind !== 'safety' && !settings.enabled) return null;
      const cwd = expandHome(rec.cwd);
      if (!(await isDir(cwd))) return null;
      const latest = await this.store.latest(uid).catch(() => null);
      const turn = Math.max(settings.lastTurn, latest?.turn ?? 0) + 1;
      let made;
      try {
        made = await createSnapshot(cwd, {
          uid,
          turn,
          indexFile: join(this.stateDir, 'snapshots', uid, `index-${turn}`),
          parent: latest?.commit ?? null,
          maxFileBytes: this.limits().maxFileBytes,
        });
      } catch {
        return null; // not a git repo, or git refused: snapshots are unavailable here
      }
      const diff = await snapshotDiff(cwd, latest?.commit ?? null, made.commit).catch(() => ({ filesChanged: 0, insertions: 0, deletions: 0 }));
      const info = await this.store.create({
        uid,
        turn,
        commit: made.commit,
        repoRoot: await mainRepo(cwd),
        kind,
        promptExcerpt: promptText.replace(/\s+/g, ' ').trim().slice(0, 120),
        branch: made.branch,
        createdAt: now(),
        ...diff,
        skipped: made.skipped,
        submodules: made.submodules,
      });
      // The session's own switch as it is now, not as it was when this capture began:
      // turning snapshots off meanwhile stays off (and a safety snapshot taken while
      // they're off everywhere doesn't switch this session off for good).
      const stored = this.registry.get(uid)?.meta['ah.snapshots'] as Stored;
      this.registry.setMeta(uid, 'ah.snapshots', { enabled: stored?.enabled !== false, lastTurn: turn });
      return info;
    });
  }

  list(uid: string): Promise<SnapshotInfo[]> {
    return this.store.list(uid).catch(() => []);
  }

  get(uid: string, turn: number): Promise<SnapshotInfo | null> {
    return this.store.get(uid, turn).catch(() => null);
  }

  /** Relaunch moves a conversation to a new uid: its snapshots follow. */
  async rekey(from: string, to: string): Promise<void> {
    await this.store.rekey(from, to).catch(() => {});
  }

  /**
   * Retention: snapshots live for the session's life plus retentionDays after it ends,
   * and each session keeps at most keepTurns of them. Pruned rows lose their git refs
   * too, so their commits become collectable.
   */
  async prune(): Promise<void> {
    const { keepTurns, retentionDays } = this.limits();
    const rows = await this.store.all().catch(() => []);
    const byUid = new Map<string, SnapshotInfo[]>();
    for (const r of rows) byUid.set(r.uid, [...(byUid.get(r.uid) ?? []), r]);
    for (const [uid, list] of byUid) {
      const rec = this.registry.get(uid);
      const last = list[list.length - 1];
      const expired = rec?.endedAt ? now() - rec.endedAt > retentionDays * 86_400 : !rec && last && now() - last.createdAt > retentionDays * 86_400;
      const doomed = expired ? list : list.slice(0, Math.max(0, list.length - keepTurns));
      for (const row of doomed) {
        const repo = row.repoRoot || (rec ? expandHome(rec.cwd) : null);
        if (repo) await deleteSnapshotRef(repo, uid, row.turn);
        await this.store.remove(uid, row.turn).catch(() => {});
      }
    }
  }
}
