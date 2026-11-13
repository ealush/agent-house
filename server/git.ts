// Git helpers: per-session worktrees (one writing agent per checkout) and a
// read-only view of a session's changes for reviewing from a phone.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir, stat, lstat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cachedSize, invalidateSize, requestSize } from './size.ts';

const exec = promisify(execFile);

/**
 * ah reads the agents' working trees all the time (status, diffs, branches, polled
 * every few seconds): without optional locks a `git status` there never takes
 * index.lock to refresh the index, so it can't make an agent's own `git add` or
 * `commit` fail with "index.lock: File exists", and writes nothing. Writes still
 * take the locks they need.
 */
const gitEnvironment = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 15_000, env: gitEnvironment() });
  return stdout;
}

/** git with extra environment (temp index, snapshot identity). */
async function gitEnv(cwd: string, env: Record<string, string>, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    env: { ...gitEnvironment(), ...env },
  });
  return stdout;
}

/**
 * git with stdin, via spawn: execFile's `input` option does not close the
 * pipe in a way `checkout-index --stdin` accepts, and it waits for EOF forever.
 */
function gitStdin(cwd: string, env: Record<string, string>, args: string[], input: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn('git', ['-C', cwd, ...args], { env: { ...gitEnvironment(), ...env } });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), 60_000);
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new GitError(err.trim() || `git ${args[0]} failed`));
    });
    p.stdin.end(input);
  });
}

export class GitError extends Error {}

/** The main checkout of the repo containing `dir` (resolves linked worktrees). */
export async function mainRepo(dir: string): Promise<string> {
  try {
    const common = (await git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    return dirname(common);
  } catch {
    throw new GitError(`not a git repository: ${dir}`);
  }
}

/** Managed worktrees live beside the repo: <parent>/.worktrees/<repo>/<slug>. */
export function worktreeRoot(main: string): string {
  return join(dirname(main), '.worktrees', basename(main));
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'session'
  );
}

/** A fresh repository for a folder ah just created. */
export async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '--quiet');
}

export type Worktree = { path: string; branch: string; repo: string };

export async function createWorktree(dir: string, name: string, fromRef?: string): Promise<Worktree> {
  const main = await mainRepo(dir);
  const slug = `${slugify(name)}-${randomBytes(2).toString('hex')}`;
  const path = join(worktreeRoot(main), slug);
  const branch = `ah/${slug}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    // `fromRef` pins the base (a fork starts from its parent's branch HEAD, which
    // may differ from the main checkout's HEAD when the parent is itself a worktree).
    await git(main, 'worktree', 'add', '-b', branch, path, ...(fromRef ? [fromRef] : []));
  } catch (err) {
    throw new GitError(String((err as { stderr?: string }).stderr ?? err).trim());
  }
  return { path, branch, repo: main };
}

export type HeadInfo = { branch: string | null; head: string; dirty: number };

/** Where a checkout stands: current branch, HEAD commit, uncommitted file count. */
export async function headInfo(dir: string): Promise<HeadInfo> {
  const root = await toplevel(dir);
  const [branch, head, status] = await Promise.all([
    git(root, 'branch', '--show-current').then((s) => s.trim() || null).catch(() => null),
    git(root, 'rev-parse', 'HEAD').then((s) => s.trim()).catch(() => ''),
    git(root, 'status', '--porcelain').catch(() => ''),
  ]);
  return { branch, head, dirty: status.split('\n').filter(Boolean).length };
}

export type WorktreeInfo = Worktree & {
  head: string;
  dirty: number;
  ahead: number;
  managed: boolean;
  /** Allocated on-disk size from the background size cache; null until measured (or too large to measure). */
  sizeBytes: number | null;
  logicalBytes: number | null;
  sizePartial: boolean;
  sizeTooLarge: boolean;
  /** Seconds since epoch of the cached measurement, null until measured. */
  sizeMeasuredAt: number | null;
  /** Seconds since epoch: directory mtime, refined by Core with the owning session's last activity. */
  lastActivityAt: number;
};


/** Worktrees of the given repos that ah manages, with enough state to decide cleanup. */
export async function listWorktrees(repos: string[]): Promise<WorktreeInfo[]> {
  const out: WorktreeInfo[] = [];
  for (const repo of new Set(repos)) {
    if (!existsSync(repo)) continue;
    const root = worktreeRoot(repo) + sep;
    const porcelain = await git(repo, 'worktree', 'list', '--porcelain').catch(() => '');
    const base = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => 'HEAD')).trim();
    for (const block of porcelain.split('\n\n')) {
      const path = block.match(/^worktree (.+)$/m)?.[1];
      if (!path || !path.startsWith(root)) continue;
      const branch = block.match(/^branch refs\/heads\/(.+)$/m)?.[1] ?? '(detached)';
      const head = block.match(/^HEAD (\w+)$/m)?.[1]?.slice(0, 7) ?? '';
      const [status, ahead] = await Promise.all([
        git(path, 'status', '--porcelain').catch(() => ''),
        git(repo, 'rev-list', '--count', `${base}..${branch}`).catch(() => '0'),
      ]);
      // Sizes come from the background cache (server/size.ts): this listing
      // never walks the tree itself. A miss starts a measurement and reports
      // nulls until it lands; the next listing carries the numbers.
      requestSize(path);
      const size = cachedSize(path);
      const mtime = await stat(path).then((s) => Math.floor(s.mtimeMs / 1000)).catch(() => 0);
      out.push({
        path,
        branch,
        repo,
        head,
        dirty: status.split('\n').filter(Boolean).length,
        ahead: Number(ahead.trim()) || 0,
        managed: true,
        sizeBytes: size?.sizeBytes ?? null,
        logicalBytes: size ? size.logicalBytes : null,
        sizePartial: size?.partial ?? false,
        sizeTooLarge: size?.tooLarge ?? false,
        sizeMeasuredAt: size?.measuredAt ?? null,
        lastActivityAt: mtime,
      });
    }
  }
  return out;
}

export async function removeWorktree(path: string, force: boolean): Promise<void> {
  const abs = resolve(path);
  // Only ever remove worktrees under a managed .worktrees directory.
  if (!abs.includes(`${sep}.worktrees${sep}`)) throw new GitError('not an ah-managed worktree');
  const main = await mainRepo(abs);
  if (!abs.startsWith(worktreeRoot(main) + sep) || abs !== await toplevel(abs)) throw new GitError('not an ah-managed worktree');
  try {
    await git(main, 'worktree', 'remove', ...(force ? ['--force'] : []), abs);
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err).trim();
    throw new GitError(/modified or untracked|is dirty/.test(msg) ? 'worktree has uncommitted changes' : msg);
  }
}

export type BulkRemoveResult = { path: string; ok: boolean; error?: string; gone?: boolean; reclaimedBytes: number };

/**
 * Bulk orphan cleanup. Every item is revalidated at removal time, never
 * trusted from the listing the user confirmed: a path already gone counts
 * as success, the managed-root guard runs inside removeWorktree, the
 * in-use check is the caller's fresh view (Core passes live windows), and
 * a worktree that turned dirty since listing fails its git removal unless
 * its path is in `force`. One item's failure never stops the rest.
 */
export async function removeWorktreesBulk(
  paths: string[],
  force: Set<string>,
  isInUse: (path: string) => boolean | Promise<boolean>,
): Promise<BulkRemoveResult[]> {
  const out: BulkRemoveResult[] = [];
  for (const raw of paths) {
    const path = resolve(raw);
    if (!existsSync(path)) {
      out.push({ path, ok: true, gone: true, reclaimedBytes: 0 });
      continue;
    }
    if (await isInUse(path)) {
      out.push({ path, ok: false, error: 'a live session is using this worktree', reclaimedBytes: 0 });
      continue;
    }
    const reclaimed = cachedSize(path)?.sizeBytes ?? 0;
    try {
      await removeWorktree(path, force.has(path) || force.has(raw));
      invalidateSize(path);
      out.push({ path, ok: true, reclaimedBytes: reclaimed });
    } catch (err) {
      out.push({ path, ok: false, error: (err as Error).message, reclaimedBytes: 0 });
    }
  }
  return out;
}

// ---------- branches

export type BranchInfo = {
  /** Short name, without any `origin/` prefix. */
  name: string;
  current: boolean;
  /** True for a remote-tracking branch with no local branch of the same name. */
  remote: boolean;
  /**
   * Path of another worktree that already has this branch checked out
   * (null when the branch is free to switch to). The current checkout is
   * never reported here: only a *different* worktree blocks `git switch`.
   */
  worktree?: string | null;
};

export type BranchList = { current: string | null; branches: BranchInfo[]; dirty: number };

export async function toplevel(dir: string): Promise<string> {
  try {
    return (await git(dir, 'rev-parse', '--show-toplevel')).trim();
  } catch {
    throw new GitError('not a git repository');
  }
}

/**
 * Branch -> path of a *different* worktree holding it checked out.
 * Parsed from `git worktree list --porcelain`; the caller's own checkout
 * never counts, since switching to its current branch is a no-op.
 */
async function otherWorktreesByBranch(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const porcelain = await git(root, 'worktree', 'list', '--porcelain').catch(() => '');
  let path = '';
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length).trim();
    else if (line.startsWith('branch refs/heads/')) {
      const branch = line.slice('branch refs/heads/'.length).trim();
      if (path && path !== root && branch && !out.has(branch)) out.set(branch, path);
    } else if (!line.trim()) path = '';
  }
  return out;
}

function friendlyWorktreeError(branch: string, path: string): string {
  return `branch '${branch}' is already checked out in worktree at '${path}' — open that worktree, or remove it (the branch itself is kept) to free the name`;
}

/** Local branches (most recently committed first), then remote-tracking ones. */
export async function listBranches(dir: string): Promise<BranchList> {
  const root = await toplevel(dir);
  const [current, locals, remotes, holders, status] = await Promise.all([
    git(root, 'branch', '--show-current').then((s) => s.trim() || null).catch(() => null),
    git(root, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/').catch(() => ''),
    git(root, 'for-each-ref', '--sort=refname', '--format=%(refname:short)', 'refs/remotes/').catch(() => ''),
    otherWorktreesByBranch(root),
    git(root, 'status', '--porcelain').catch(() => ''),
  ]);
  const localNames = locals.split('\n').map((s) => s.trim()).filter(Boolean);
  const localSet = new Set(localNames);
  const branches: BranchInfo[] = localNames.map((name) => ({
    name,
    current: name === current,
    remote: false,
    worktree: name === current ? null : (holders.get(name) ?? null),
  }));
  for (const full of remotes.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (full.endsWith('/HEAD')) continue; // symbolic ref (e.g. origin/HEAD), not a branch
    const slash = full.indexOf('/');
    if (slash < 0) continue;
    const name = full.slice(slash + 1);
    if (!name || localSet.has(name)) continue;
    branches.push({ name, current: false, remote: true, worktree: null });
  }
  return { current, branches, dirty: status.split('\n').filter(Boolean).length };
}

function gitMessage(err: unknown): string {
  const msg = String((err as { stderr?: string }).stderr ?? err);
  // Git explains itself on the first line ("Your local changes … would be
  // overwritten…"); later lines are file lists and an "Aborting" trailer.
  const line = msg.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? 'git failed';
  return line.replace(/^(error|fatal):\s*/i, '');
}

/**
 * Switch the checkout to `name`: an existing local branch, a remote-tracking
 * branch (checked out with tracking), or a brand-new branch. A dirty tree that
 * the switch would overwrite fails with git's own message.
 */
export async function switchBranch(dir: string, name: string): Promise<{ branch: string }> {
  const root = await toplevel(dir);
  const fail = (err: unknown, branch = name): never => {
    const raw = gitMessage(err);
    // Git's raw conflict ("'x' is already used by worktree at '...'") survives
    // terminating the session because the managed worktree is kept for resume.
    // Rewrite it into an actionable message instead of leaking the raw fatal.
    const m = raw.match(/^'(.+)' is already used by worktree at '(.+)'$/);
    if (m) throw new GitError(friendlyWorktreeError(m[1], m[2]));
    throw new GitError(raw);
  };
  try {
    await git(root, 'check-ref-format', '--branch', name);
  } catch {
    throw new GitError(`invalid branch name: ${name}`);
  }
  const local = await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`).then(() => true).catch(() => false);
  if (local) {
    // Fail fast with the worktree path before git does: the holder survives
    // session termination (it is kept so an ended session can resume there).
    const holder = (await otherWorktreesByBranch(root)).get(name);
    if (holder) throw new GitError(friendlyWorktreeError(name, holder));
    try {
      await git(root, 'switch', name);
    } catch (err) {
      fail(err);
    }
    return { branch: name };
  }
  const remotes = await git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/').catch(() => '');
  const matches = remotes
    .split('\n')
    .map((s) => s.trim())
    .filter((full) => !full.endsWith('/HEAD') && full.slice(full.indexOf('/') + 1) === name);
  if (matches.length > 1) throw new GitError(`branch ${name} exists on several remotes (${matches.join(', ')}); be more specific`);
  if (matches.length === 1) {
    try {
      await git(root, 'switch', '--track', matches[0]);
    } catch (err) {
      fail(err);
    }
    return { branch: name };
  }
  try {
    await git(root, 'switch', '--create', name);
  } catch (err) {
    fail(err);
  }
  return { branch: name };
}

// ---------- pull request

export type PullRequest = { number: number; url: string } | null;

/**
 * The GitHub PR for the checked-out branch, if any. Quietly null when gh is
 * missing, not signed in, the repo isn't on GitHub, the HEAD is detached, or
 * the branch has no PR.
 */
export async function pullRequest(dir: string): Promise<PullRequest> {
  const root = await toplevel(dir);
  const current = await git(root, 'branch', '--show-current').then((s) => s.trim()).catch(() => '');
  if (!current) return null;
  // Asked on every session open (the header's PR pill) and each lookup is a GitHub round
  // trip (~0.5 s here): kept a minute, or 15 s while there's none (an agent may open one).
  const key = `${root}\0${current}`;
  const hit = prCache.get(key);
  if (hit && Date.now() - hit.at < (hit.pr ? 60_000 : 15_000)) return hit.value;
  const value = lookupPr(root, current);
  prCache.set(key, { at: Date.now(), pr: true, value });
  void value.then(
    (pr) => prCache.get(key)?.value === value && prCache.set(key, { at: Date.now(), pr: !!pr, value }),
    () => prCache.delete(key),
  );
  if (prCache.size > 200) prCache.delete(prCache.keys().next().value!);
  return value;
}

const prCache = new Map<string, { at: number; pr: boolean; value: Promise<PullRequest> }>();

async function lookupPr(root: string, current: string): Promise<PullRequest> {
  let out: string;
  try {
    const res = await exec('gh', ['pr', 'list', '--head', current, '--json', 'number,url', '--limit', '1'], {
      cwd: root,
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    });
    out = res.stdout;
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(out);
  } catch {
    return null;
  }
  const pr = Array.isArray(parsed) ? parsed[0] : undefined;
  if (!pr || typeof pr !== 'object' || typeof (pr as { number?: unknown }).number !== 'number' || typeof (pr as { url?: unknown }).url !== 'string') return null;
  return { number: (pr as { number: number }).number, url: (pr as { url: string }).url };
}

// ---------- changes view

export type Changes = {
  root: string;
  branch: string;
  files: Array<{ code: string; path: string }>;
  stat: string;
  patch: string;
  truncated: boolean;
};

const PATCH_LIMIT = 400 * 1024;

export async function changes(dir: string): Promise<Changes> {
  let root: string;
  try {
    root = (await git(dir, 'rev-parse', '--show-toplevel')).trim();
  } catch {
    throw new GitError('not a git repository');
  }
  // Canonical prefixes: the caller's diff.mnemonicprefix (c/ w/) would
  // otherwise leak into the Diff view and every patch parser downstream.
  const [status, stat, patch] = await Promise.all([
    git(root, 'status', '--porcelain=v1', '-b', '--untracked-files=all'),
    git(root, 'diff', 'HEAD', '--stat=120').catch(() => ''),
    git(root, 'diff', 'HEAD', '--src-prefix=a/', '--dst-prefix=b/', '--no-color', '--no-ext-diff').catch(() => ''),
  ]);
  const lines = status.split('\n').filter(Boolean);
  const branch = (lines[0] ?? '').replace(/^## /, '').split('...')[0];
  const files = lines.slice(1).map((l) => ({ code: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  return {
    root,
    branch,
    files,
    stat,
    patch: patch.length > PATCH_LIMIT ? patch.slice(0, PATCH_LIMIT) : patch,
    truncated: patch.length > PATCH_LIMIT,
  };
}

// ---------- side-chat repo tools (all read-only)

// Raw material the side-chat tool loop slices per call; presentation caps
// live with the executor so one fetch serves many narrow questions.
const TOOL_FETCH_LIMIT = 400 * 1024;
const GH_TIMEOUT_MS = 15_000;

/** `gh` JSON that also arrives on a nonzero exit (`gh pr checks` fails red). */
async function ghJson(root: string, args: string[]): Promise<unknown | null> {
  try {
    return JSON.parse((await exec('gh', args, { cwd: root, maxBuffer: 8 * 1024 * 1024, timeout: GH_TIMEOUT_MS })).stdout);
  } catch (err) {
    const out = (err as { stdout?: unknown }).stdout;
    if (typeof out === 'string' && out.trim()) {
      try {
        return JSON.parse(out);
      } catch {
        return null;
      }
    }
    return null;
  }
}

function validSha(s: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(s);
}

/** Full `gh pr diff` output for the branch's PR, capped. Throws when gh fails. */
export async function prPatch(root: string, pr: number): Promise<string> {
  const { stdout } = await exec('gh', ['pr', 'diff', String(pr)], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
    timeout: GH_TIMEOUT_MS,
  });
  return stdout.length > TOOL_FETCH_LIMIT ? stdout.slice(0, TOOL_FETCH_LIMIT) : stdout;
}

export type PrChecks = { pass: number; fail: number; pending: number; failing: string[] };
export type PrMeta = {
  number: number;
  title: string;
  url: string;
  base: string;
  head: string;
  state: string;
  mergeable: string | null;
  checks: PrChecks | null;
};

/** PR metadata plus a compact checks rollup; null when gh can't see the PR. */
export async function prMeta(root: string, pr: number): Promise<PrMeta | null> {
  const v = (await ghJson(root, ['pr', 'view', String(pr), '--json', 'number,title,url,baseRefName,headRefName,state,mergeable'])) as {
    number?: unknown;
    title?: unknown;
    url?: unknown;
    baseRefName?: unknown;
    headRefName?: unknown;
    state?: unknown;
    mergeable?: unknown;
  } | null;
  if (!v || typeof v.number !== 'number') return null;
  const raw = await ghJson(root, ['pr', 'checks', String(pr), '--json', 'name,state']);
  let checks: PrChecks | null = null;
  if (Array.isArray(raw)) {
    const failing: string[] = [];
    let pass = 0;
    let fail = 0;
    let pending = 0;
    for (const c of raw) {
      if (!c || typeof c !== 'object') continue;
      const { name, state } = c as { name?: unknown; state?: unknown };
      if (state === 'SUCCESS' || state === 'SKIPPED' || state === 'NEUTRAL') pass++;
      else if (state === 'FAILURE' || state === 'CANCELLED' || state === 'TIMED_OUT' || state === 'ACTION_REQUIRED') {
        fail++;
        if (typeof name === 'string' && name && failing.length < 10) failing.push(name);
      } else pending++;
    }
    checks = { pass, fail, pending, failing };
  }
  return {
    number: v.number,
    title: typeof v.title === 'string' ? v.title : '',
    url: typeof v.url === 'string' ? v.url : '',
    base: typeof v.baseRefName === 'string' ? v.baseRefName : '',
    head: typeof v.headRefName === 'string' ? v.headRefName : '',
    state: typeof v.state === 'string' ? v.state : '',
    mergeable: typeof v.mergeable === 'string' ? v.mergeable : null,
    checks,
  };
}

/** Full uncommitted patch (`git diff HEAD`), capped, canonical prefixes. */
export async function workingPatch(root: string): Promise<string> {
  const patch = await git(root, 'diff', 'HEAD', '--src-prefix=a/', '--dst-prefix=b/', '--no-color', '--no-ext-diff').catch(() => '');
  return patch.length > TOOL_FETCH_LIMIT ? patch.slice(0, TOOL_FETCH_LIMIT) : patch;
}

/** validation for caller-supplied revisions: no flags, no shell, no traversal. */
function validRef(s: string): boolean {
  return /^(HEAD|[0-9a-f]{4,40}|[\w][\w./-]{0,99})$/.test(s) && !s.startsWith('-') && !s.includes('..');
}

/** Shortstat of the working tree, one line. */
export async function workingStat(root: string): Promise<string> {
  return (await git(root, 'diff', 'HEAD', '--shortstat').catch(() => '')).trim();
}

/** merge-base of HEAD with a branch name; null when the base isn't local. */
export async function mergeBase(root: string, branch: string): Promise<string | null> {
  if (!validRef(branch)) return null;
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      const sha = (await git(root, 'merge-base', 'HEAD', ref)).trim();
      if (/^[0-9a-f]{40}$/.test(sha)) return sha;
    } catch {
      continue;
    }
  }
  return null;
}

/** Capped file contents at a revision; throws GitError on bad input. */
export async function showAtRef(root: string, rev: string, path: string, limit: number): Promise<string> {
  if (!validRef(rev)) throw new GitError('invalid revision');
  if (path.startsWith('-') || path.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(path)) throw new GitError('path escapes the repo');
  const out = await git(root, 'show', `${rev}:${path}`).catch(() => {
    throw new GitError(`no such file at ${rev}: ${path}`);
  });
  return out.length > limit ? `${out.slice(0, limit)}\n... (truncated)` : out;
}

/** `git show` stat plus capped patch for one commit; throws on bad input. */
export async function commitShow(root: string, sha: string, patchLimit: number): Promise<{ stat: string; patch: string }> {
  if (!validSha(sha)) throw new GitError('invalid commit sha');
  const [stat, patch] = await Promise.all([
    git(root, 'show', '--no-color', '--stat=120', '--format=%h %s', sha),
    git(root, 'show', '--no-color', '--no-ext-diff', '--format=', sha).catch(() => ''),
  ]);
  return { stat: stat.trim(), patch: patch.length > patchLimit ? `${patch.slice(0, patchLimit)}\n... (truncated)` : patch };
}

// ---------- per-turn snapshots (F39)
//
// A snapshot is a commit built entirely with plumbing against a throwaway
// index (GIT_INDEX_FILE under ah's state dir): the user's own index, stash
// and branches are never touched. The commit is kept alive by a ref under
// refs/ah-snapshots/<uid>/<turn>, which also protects it from `git gc`.

export function snapshotRef(uid: string, turn: number): string {
  return `refs/ah-snapshots/${uid}/${turn}`;
}

export type SnapshotMade = {
  commit: string;
  tree: string;
  /** Branch checked out at capture time ('' when detached). */
  branch: string;
  /** Untracked files left out for exceeding the size cap, repo-relative. */
  skipped: string[];
  /** True when the tree contains submodules (recorded as commits, not recursed). */
  submodules: boolean;
};

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'ah',
  GIT_AUTHOR_EMAIL: 'ah@localhost',
  GIT_COMMITTER_NAME: 'ah',
  GIT_COMMITTER_EMAIL: 'ah@localhost',
};

/**
 * Captures the worktree's current state as a snapshot commit. Ignored files
 * are excluded by git's own rules; untracked files over `maxFileBytes` are
 * excluded by pathspec and reported in `skipped`. `parent` is the previous
 * snapshot commit when there is one, else the worktree HEAD (or no parent
 * for a repo with no commits yet).
 */
export async function createSnapshot(
  dir: string,
  o: { uid: string; turn: number; indexFile: string; parent: string | null; maxFileBytes: number },
): Promise<SnapshotMade> {
  const root = await toplevel(dir);
  const branch = (await git(root, 'branch', '--show-current').catch(() => '')).trim();
  const head = (await git(root, 'rev-parse', '--verify', '-q', 'HEAD').catch(() => '')).trim() || null;

  // Oversized untracked files: left out, and named so the UI can say so.
  const skipped: string[] = [];
  const others = await git(root, 'ls-files', '--others', '--exclude-standard', '-z').catch(() => '');
  for (const rel of others.split('\0').filter(Boolean)) {
    const st = await lstat(join(root, rel)).catch(() => null);
    if (st?.isFile() && st.size > o.maxFileBytes) skipped.push(rel);
  }
  skipped.sort();

  await mkdir(dirname(o.indexFile), { recursive: true, mode: 0o700 });
  await rm(o.indexFile, { force: true });
  const env = { GIT_INDEX_FILE: o.indexFile };
  try {
    if (head) await gitEnv(root, env, ['read-tree', head]);
    await gitEnv(root, env, ['add', '-A', '--', '.', ...skipped.map((p) => `:(exclude,literal)${p}`)]);
    const tree = (await gitEnv(root, env, ['write-tree'])).trim();
    const parent = o.parent ?? head;
    const commit = (
      await gitEnv(root, { ...env, ...SNAPSHOT_IDENTITY }, [
        'commit-tree',
        tree,
        ...(parent ? ['-p', parent] : []),
        '-m',
        `ah snapshot ${o.uid} turn ${o.turn} ${new Date().toISOString()}`,
      ])
    ).trim();
    await git(root, 'update-ref', snapshotRef(o.uid, o.turn), commit);
    const staged = await git(root, 'ls-tree', '-r', commit).catch(() => '');
    return { commit, tree, branch, skipped, submodules: /^160000 /m.test(staged) };
  } finally {
    await rm(o.indexFile, { force: true });
  }
}

export type DiffStat = { filesChanged: number; insertions: number; deletions: number };

/** Line stats between two snapshot commits (either may be a tree hash). */
export async function snapshotDiff(dir: string, from: string | null, to: string): Promise<DiffStat> {
  if (!from) return { filesChanged: 0, insertions: 0, deletions: 0 };
  const root = await toplevel(dir);
  const out = await git(root, 'diff', '--numstat', '-z', from, to).catch(() => '');
  const stat: DiffStat = { filesChanged: 0, insertions: 0, deletions: 0 };
  for (const tok of out.split('\0')) {
    const m = tok.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue; // rename path halves carry no counts
    stat.filesChanged++;
    if (m[1] !== '-') stat.insertions += Number(m[1]);
    if (m[2] !== '-') stat.deletions += Number(m[2]);
  }
  return stat;
}

type TreeEntry = { mode: string; path: string };

async function treeEntries(root: string, treeish: string): Promise<TreeEntry[]> {
  const out = await git(root, 'ls-tree', '-r', '-z', treeish);
  return out
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t');
      return { mode: e.slice(0, e.indexOf(' ')), path: e.slice(tab + 1) };
    });
}

/**
 * Returns the worktree to `target`'s tree. Only files that differ between the
 * `current` snapshot and the target are written (through a temp index, via
 * checkout-index), and only files present in `current` but absent in the
 * target are deleted: untracked files no snapshot ever captured (including
 * oversized skipped files) are left alone. The user's real index is never
 * read or written by any of this.
 */
export async function restoreSnapshot(dir: string, o: { target: string; current: string; indexFile: string }): Promise<void> {
  const root = await toplevel(dir);
  const [targetEntries, currentEntries] = await Promise.all([treeEntries(root, o.target), treeEntries(root, o.current)]);
  const targetPaths = new Map(targetEntries.filter((e) => e.mode !== '160000').map((e) => [e.path, e]));
  const currentPaths = new Map(currentEntries.filter((e) => e.mode !== '160000').map((e) => [e.path, e]));
  const changed = new Set((await git(root, 'diff', '--name-only', '-z', o.current, o.target)).split('\0').filter(Boolean));
  const toWrite = [...changed].filter((p) => targetPaths.has(p));
  const toDelete = [...currentPaths.keys()].filter((p) => !targetPaths.has(p));

  for (const rel of toDelete) {
    await rm(join(root, rel), { force: true });
    // Prune directories the deletion emptied, up to (never including) the root.
    let d = dirname(join(root, rel));
    while (d.startsWith(root + sep) || d === root) {
      if (d === root) break;
      if (!(await rmdir(d).then(() => true).catch(() => false))) break;
      d = dirname(d);
    }
  }
  if (toWrite.length) {
    await mkdir(dirname(o.indexFile), { recursive: true, mode: 0o700 });
    await rm(o.indexFile, { force: true });
    const env = { GIT_INDEX_FILE: o.indexFile };
    try {
      await gitEnv(root, env, ['read-tree', o.target]);
      await gitStdin(root, env, ['checkout-index', '-f', '-z', '--stdin'], toWrite.join('\0') + '\0');
    } finally {
      await rm(o.indexFile, { force: true });
    }
  }

}

/** Drops a snapshot's ref; the commit then becomes collectable by git gc. */
export async function deleteSnapshotRef(dir: string, uid: string, turn: number): Promise<void> {
  await git(dir, 'update-ref', '-d', snapshotRef(uid, turn)).catch(() => {});
}
