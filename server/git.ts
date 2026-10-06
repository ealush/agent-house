// Git helpers: per-session worktrees (one writing agent per checkout) and a
// read-only view of a session's changes for reviewing from a phone.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 15_000 });
  return stdout;
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

export type WorktreeInfo = Worktree & { head: string; dirty: number; ahead: number; managed: boolean };

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
      out.push({
        path,
        branch,
        repo,
        head,
        dirty: status.split('\n').filter(Boolean).length,
        ahead: Number(ahead.trim()) || 0,
        managed: true,
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
  try {
    await git(main, 'worktree', 'remove', ...(force ? ['--force'] : []), abs);
  } catch (err) {
    const msg = String((err as { stderr?: string }).stderr ?? err).trim();
    throw new GitError(/modified or untracked|is dirty/.test(msg) ? 'worktree has uncommitted changes' : msg);
  }
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
