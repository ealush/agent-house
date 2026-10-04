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

export async function createWorktree(dir: string, name: string): Promise<Worktree> {
  const main = await mainRepo(dir);
  const slug = `${slugify(name)}-${randomBytes(2).toString('hex')}`;
  const path = join(worktreeRoot(main), slug);
  const branch = `ah/${slug}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await git(main, 'worktree', 'add', '-b', branch, path);
  } catch (err) {
    throw new GitError(String((err as { stderr?: string }).stderr ?? err).trim());
  }
  return { path, branch, repo: main };
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
