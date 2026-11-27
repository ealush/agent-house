// Where each live session's checkout stands in source control, for lists to show at a glance:
// how many files it has uncommitted, and its branch's pull request (open, draft, merged or
// closed, and how its checks went). Read in the background and carried by the next pass, as
// replies.ts does for the last thing said: a tick only peeks. `git status` per checkout every
// few seconds, and one `gh pr list` per repository a minute for every branch at once, never one
// per session. Off with `sourceControl: false` in the config.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rollup } from './review/gh.ts';

const exec = promisify(execFile);

/** A branch's pull request as lists show it. `checks`: null when it has none (or none reported). */
export type ScmPull = { number: number; url: string; state: 'open' | 'draft' | 'merged' | 'closed'; checks: 'pass' | 'fail' | 'pending' | null };
/** `dirty`: files with uncommitted changes, untracked ones too. `pull`: its branch's, or null. */
export type ScmView = { dirty: number; pull: ScmPull | null };

/** One pull request of a repository, as `gh pr list` gave it. */
export type RepoPull = { number: number; url: string; state: string; draft: boolean; head: string; crossRepo: boolean; checks: ScmPull['checks'] };

/** A live session's checkout: its folder (the worktree's root), its repository's main checkout, and its branch. */
export type ScmTarget = { uid: string; root: string; main: string; branch: string | null };

export type ScmPorts = {
  /** Files with uncommitted changes in a checkout; null when git can't say. */
  dirty: (root: string) => Promise<number | null>;
  /** The repository's pull requests, newest first; null when gh can't say (none installed, not GitHub, signed out). */
  pulls: (main: string) => Promise<RepoPull[] | null>;
};

const DIRTY_TTL_MS = 10_000;
const PULLS_TTL_MS = 60_000;
/** A repository gh couldn't answer for (not on GitHub, gh signed out) is asked again after this. */
const PULLS_FAIL_TTL_MS = 5 * 60_000;

/**
 * The pull request lists show for a branch: its open one (a draft counts), else the newest
 * merged or closed one. Never one from a fork that happens to use the same branch name.
 */
export function pullOf(pulls: RepoPull[], branch: string | null): ScmPull | null {
  if (!branch) return null;
  const mine = pulls.filter((p) => p.head === branch && !p.crossRepo).sort((a, b) => b.number - a.number);
  const pick = mine.find((p) => p.state === 'OPEN') ?? mine[0];
  if (!pick) return null;
  const state = pick.state === 'MERGED' ? 'merged' : pick.state === 'CLOSED' ? 'closed' : pick.draft ? 'draft' : 'open';
  return { number: pick.number, url: pick.url, state, checks: pick.checks };
}

/** A check rollup in one word: any failure fails it, else anything still running keeps it pending. */
export function checksWord(c: { pass: number; fail: number; pending: number }): ScmPull['checks'] {
  if (c.fail > 0) return 'fail';
  if (c.pending > 0) return 'pending';
  return c.pass > 0 ? 'pass' : null;
}

async function gitDirty(root: string): Promise<number | null> {
  try {
    // No optional locks: a status here never takes the index lock an agent's own git needs.
    const { stdout } = await exec('git', ['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=normal'], { cwd: root, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 });
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

async function ghPulls(main: string): Promise<RepoPull[] | null> {
  // No remote, no pull requests: gh would only say so, and a `gh` that's a wrapper (an
  // installer, a version manager's shim) can cost far more than the answer.
  const remotes = await exec('git', ['remote'], { cwd: main, timeout: 5000 }).then((r) => r.stdout.trim(), () => '');
  if (!remotes) return [];
  try {
    const { stdout } = await exec('gh', ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'number,url,state,isDraft,headRefName,isCrossRepository,statusCheckRollup'], {
      cwd: main,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    const raw = JSON.parse(stdout) as unknown;
    if (!Array.isArray(raw)) return null;
    return raw.flatMap((v): RepoPull[] => {
      if (!v || typeof v !== 'object' || typeof v.number !== 'number') return [];
      const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
      return [{ number: v.number, url: s('url'), state: s('state').toUpperCase(), draft: v.isDraft === true, head: s('headRefName'), crossRepo: v.isCrossRepository === true, checks: checksWord(rollup(v.statusCheckRollup)) }];
    });
  } catch {
    return null;
  }
}

type Cached<T> = { at: number; value: T; running: boolean; ok: boolean };

export class SourceControl {
  private ports: ScmPorts;
  private now: () => number;
  private dirtyOf = new Map<string, Cached<number | null>>();
  private pullsOf = new Map<string, Cached<RepoPull[] | null>>();

  constructor(ports: Partial<ScmPorts> = {}, now: () => number = Date.now) {
    this.ports = { dirty: ports.dirty ?? gitDirty, pulls: ports.pulls ?? ghPulls };
    this.now = now;
  }

  /** What's known for a session's checkout now; null until its status has been read. */
  peek(t: ScmTarget): ScmView | null {
    const dirty = this.dirtyOf.get(t.root)?.value;
    if (dirty === undefined || dirty === null) return null;
    return { dirty, pull: pullOf(this.pullsOf.get(t.main)?.value ?? [], t.branch) };
  }

  /**
   * Starts reading what's stale for these checkouts, in the background; the next pass peeks at
   * it. Checkouts and repositories no live session is in any more are forgotten.
   */
  refresh(targets: ScmTarget[]): Promise<void> {
    const roots = new Set(targets.map((t) => t.root));
    const mains = new Set(targets.filter((t) => t.branch).map((t) => t.main));
    for (const k of this.dirtyOf.keys()) if (!roots.has(k)) this.dirtyOf.delete(k);
    for (const k of this.pullsOf.keys()) if (!mains.has(k)) this.pullsOf.delete(k);
    const work: Promise<unknown>[] = [];
    for (const root of roots) work.push(this.read(this.dirtyOf, root, () => this.ports.dirty(root), DIRTY_TTL_MS, DIRTY_TTL_MS));
    for (const main of mains) work.push(this.read(this.pullsOf, main, () => this.ports.pulls(main), PULLS_TTL_MS, PULLS_FAIL_TTL_MS));
    return Promise.all(work).then(() => {});
  }

  private async read<T>(cache: Map<string, Cached<T | null>>, key: string, load: () => Promise<T | null>, ttl: number, failTtl: number): Promise<void> {
    const hit = cache.get(key);
    if (hit && (hit.running || this.now() - hit.at < (hit.ok ? ttl : failTtl))) return;
    cache.set(key, { at: hit?.at ?? 0, value: hit?.value ?? null, running: true, ok: hit?.ok ?? false });
    const value = await load().catch(() => null);
    // Forgotten meanwhile (no session there any more): not brought back.
    if (!cache.has(key)) return;
    // What gh last said stays while it can't say now.
    cache.set(key, { at: this.now(), value: value ?? hit?.value ?? null, running: false, ok: value !== null });
  }
}
