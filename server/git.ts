// Git helpers: per-session worktrees (one writing agent per checkout) and a
// read-only view of a session's changes for reviewing from a phone.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { cachedSize, invalidateSize, requestSize } from './size.ts';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 });
  return stdout;
}

/** git with extra environment (temp index, snapshot identity). */
async function gitEnv(cwd: string, env: Record<string, string>, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return stdout;
}

/**
 * git with stdin, via spawn: execFile's `input` option does not close the
 * pipe in a way `checkout-index --stdin` accepts, and it waits for EOF forever.
 */
function gitStdin(cwd: string, env: Record<string, string>, args: string[], input: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const p = spawn('git', ['-C', cwd, ...args], { env: { ...process.env, ...env } });
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
};

export type BranchList = { current: string | null; branches: BranchInfo[] };

async function toplevel(dir: string): Promise<string> {
  try {
    return (await git(dir, 'rev-parse', '--show-toplevel')).trim();
  } catch {
    throw new GitError('not a git repository');
  }
}

/** Local branches (most recently committed first), then remote-tracking ones. */
export async function listBranches(dir: string): Promise<BranchList> {
  const root = await toplevel(dir);
  const [current, locals, remotes] = await Promise.all([
    git(root, 'branch', '--show-current').then((s) => s.trim() || null).catch(() => null),
    git(root, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads/').catch(() => ''),
    git(root, 'for-each-ref', '--sort=refname', '--format=%(refname:short)', 'refs/remotes/').catch(() => ''),
  ]);
  const localNames = locals.split('\n').map((s) => s.trim()).filter(Boolean);
  const localSet = new Set(localNames);
  const branches: BranchInfo[] = localNames.map((name) => ({ name, current: name === current, remote: false }));
  for (const full of remotes.split('\n').map((s) => s.trim()).filter(Boolean)) {
    if (full.endsWith('/HEAD')) continue; // symbolic ref (e.g. origin/HEAD), not a branch
    const slash = full.indexOf('/');
    if (slash < 0) continue;
    const name = full.slice(slash + 1);
    if (!name || localSet.has(name)) continue;
    branches.push({ name, current: false, remote: true });
  }
  return { current, branches };
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
  const fail = (err: unknown): never => {
    throw new GitError(gitMessage(err));
  };
  try {
    await git(root, 'check-ref-format', '--branch', name);
  } catch {
    throw new GitError(`invalid branch name: ${name}`);
  }
  const local = await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`).then(() => true).catch(() => false);
  if (local) {
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
  const [status, stat, patch] = await Promise.all([
    git(root, 'status', '--porcelain=v1', '-b', '--untracked-files=all'),
    git(root, 'diff', 'HEAD', '--stat=120').catch(() => ''),
    git(root, 'diff', 'HEAD', '--no-color', '--no-ext-diff').catch(() => ''),
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
    const st = await stat(join(root, rel)).catch(() => null);
    if (st?.isFile() && st.size > o.maxFileBytes) skipped.push(rel);
  }
  skipped.sort();

  await mkdir(dirname(o.indexFile), { recursive: true });
  await rm(o.indexFile, { force: true });
  const env = { GIT_INDEX_FILE: o.indexFile };
  try {
    await gitEnv(root, env, ['add', '-A', '--', '.', ...skipped.map((p) => `:(exclude)${p}`)]);
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

  if (toWrite.length) {
    await mkdir(dirname(o.indexFile), { recursive: true });
    await rm(o.indexFile, { force: true });
    const env = { GIT_INDEX_FILE: o.indexFile };
    try {
      await gitEnv(root, env, ['read-tree', o.target]);
      await gitStdin(root, env, ['checkout-index', '-f', '-z', '--stdin'], toWrite.join('\0') + '\0');
    } finally {
      await rm(o.indexFile, { force: true });
    }
  }
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
}

/** Drops a snapshot's ref; the commit then becomes collectable by git gc. */
export async function deleteSnapshotRef(dir: string, uid: string, turn: number): Promise<void> {
  await git(dir, 'update-ref', '-d', snapshotRef(uid, turn)).catch(() => {});
}
