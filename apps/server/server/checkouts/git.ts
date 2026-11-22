// Imperative Git and filesystem operations for Checkouts (docs/spec/18-checkouts.md).
// Every read passes GIT_OPTIONAL_LOCKS=0 so inspecting checkouts never contends with
// an agent's own git add/commit.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, readlink, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { mainRepo, toplevel } from '../git.ts';
import type { IntegrationStatus } from './model.ts';

const exec = promisify(execFile);
const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: '0' });

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 20_000,
    env: gitEnv(),
  });
  return stdout;
}

export type RepoIdentity = {
  isGit: boolean;
  repoRoot: string | null;
  checkoutRoot: string | null;
  isWorktree: boolean;
  hasHead: boolean;
  headSha: string;
  branch: string | null;
  trunkBranch: string;
};

/** Fast filesystem check: does `dir` or any ancestor contain a `.git` entry? */
function hasGitAncestor(dir: string): boolean {
  let cur = resolve(dir);
  for (;;) {
    if (existsSync(join(cur, '.git'))) return true;
    const parent = dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

/** Inspects `dir` for Git repository identity without throwing on non-git or unborn repos. */
export async function repoIdentity(dir: string): Promise<RepoIdentity> {
  if (!existsSync(dir) || !hasGitAncestor(dir)) {
    return { isGit: false, repoRoot: null, checkoutRoot: null, isWorktree: false, hasHead: false, headSha: '', branch: null, trunkBranch: 'main' };
  }
  let repoRoot: string;
  let checkoutRoot: string;
  try {
    [repoRoot, checkoutRoot] = await Promise.all([mainRepo(dir), toplevel(dir)]);
  } catch {
    return { isGit: false, repoRoot: null, checkoutRoot: null, isWorktree: false, hasHead: false, headSha: '', branch: null, trunkBranch: 'main' };
  }
  const [headSha, branch, trunkBranch] = await Promise.all([
    git(checkoutRoot, 'rev-parse', '--verify', '-q', 'HEAD').then((s) => s.trim()).catch(() => ''),
    git(checkoutRoot, 'branch', '--show-current').then((s) => s.trim() || null).catch(() => null),
    detectTrunk(repoRoot),
  ]);
  return {
    isGit: true,
    repoRoot: resolve(repoRoot),
    checkoutRoot: resolve(checkoutRoot),
    isWorktree: resolve(repoRoot) !== resolve(checkoutRoot),
    hasHead: /^[0-9a-f]{40}$/.test(headSha),
    headSha,
    branch,
    trunkBranch,
  };
}

/** Detects the canonical integration branch (origin/HEAD, else main/master, else current branch). */
export async function detectTrunk(repoRoot: string): Promise<string> {
  const sym = (await git(repoRoot, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => '')).trim();
  if (sym.startsWith('origin/')) return sym.slice('origin/'.length);
  for (const name of ['main', 'master']) {
    const ok = await git(repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`).then(() => true).catch(() => false);
    if (ok) return name;
  }
  const current = (await git(repoRoot, 'branch', '--show-current').catch(() => '')).trim();
  return current || 'main';
}

const MAX_CHANGED_FILES = 300;

/**
 * Returns repo-relative paths changed in this checkout: committed changes since `baseSha`
 * (or merge-base with `trunkBranch`) plus working-tree modifications and untracked files.
 */
export async function changedFilesSinceBase(
  checkoutPath: string,
  baseSha: string,
  trunkBranch: string,
): Promise<{ files: string[]; dirty: number; ahead: number; branch: string | null }> {
  if (!existsSync(checkoutPath)) return { files: [], dirty: 0, ahead: 0, branch: null };
  const [statusOut, branch] = await Promise.all([
    git(checkoutPath, 'status', '--porcelain=v1', '--untracked-files=all').catch(() => ''),
    git(checkoutPath, 'branch', '--show-current').then((s) => s.trim() || null).catch(() => null),
  ]);
  const dirtyLines = statusOut.split('\n').filter(Boolean);
  const files = new Set<string>();
  for (const line of dirtyLines) {
    const raw = line.slice(3).trim();
    const renamed = raw.includes(' -> ') ? raw.split(' -> ').pop()! : raw;
    if (renamed) files.add(renamed);
  }

  let ref = baseSha;
  if (!ref) {
    ref = (await git(checkoutPath, 'merge-base', 'HEAD', trunkBranch).catch(() => '')).trim();
  }
  let ahead = 0;
  if (ref) {
    const [aheadOut, diffOut] = await Promise.all([
      git(checkoutPath, 'rev-list', '--count', `${ref}..HEAD`).catch(() => '0'),
      git(checkoutPath, 'diff', '--name-only', `${ref}...HEAD`).catch(() => ''),
    ]);
    ahead = Number(aheadOut.trim()) || 0;
    for (const f of diffOut.split('\n').map((s) => s.trim()).filter(Boolean)) files.add(f);
  }
  return {
    files: [...files].sort().slice(0, MAX_CHANGED_FILES),
    dirty: dirtyLines.length,
    ahead,
    branch,
  };
}

/** True when `branch` is an ancestor of `trunk` (or `origin/<trunk>`) and has no unique commits left. */
export async function isBranchMerged(repoRoot: string, branch: string | null, trunk: string, baseSha?: string): Promise<boolean> {
  if (!branch || branch === trunk) return false;
  const branchSha = (await git(repoRoot, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).catch(() => '')).trim();
  if (!branchSha) return false;
  // An ancestor of trunk has no commit trunk lacks: merged work, or a branch that never got any
  // (both are safe to reclaim on the shorter window; the second's branch is deleted with it).
  void baseSha;
  for (const target of [trunk, `origin/${trunk}`]) {
    const targetSha = (await git(repoRoot, 'rev-parse', '--verify', '-q', target).catch(() => '')).trim();
    if (!targetSha) continue;
    const isAnc = await git(repoRoot, 'merge-base', '--is-ancestor', branchSha, targetSha).then(() => true).catch(() => false);
    if (isAnc) return true;
  }
  return false;
}

/** Deletes an `ah/*` branch still at the commit it was made from (no work on it); keeps any other. */
export async function deleteUnusedBranch(repoRoot: string, branch: string | null, baseSha: string): Promise<boolean> {
  if (!branch || !branch.startsWith('ah/') || !/^[0-9a-f]{40}$/.test(baseSha)) return false;
  const tip = (await git(repoRoot, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`).catch(() => '')).trim();
  if (tip !== baseSha) return false;
  await git(repoRoot, 'branch', '-D', branch);
  return true;
}

/**
 * Whether any process runs in `dir` (or below it), by its working directory: a dev server,
 * editor or simulator an agent started outlives the tmux window. Linux reads /proc; elsewhere
 * nothing is known and the answer is false.
 */
export async function pathInUse(dir: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const root = resolve(dir);
  const pids = await readdir('/proc').catch(() => [] as string[]);
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => '');
    if (cwd === root || cwd.startsWith(root + '/')) return true;
  }
  return false;
}

/**
 * Non-destructive compatibility check against `trunk`: runs `git merge-tree --write-tree`
 * completely in Git's object database without modifying any working tree or index.
 */
export async function checkMergeCompatibility(repoRoot: string, trunk: string, branch: string): Promise<IntegrationStatus> {
  const checkedAt = Math.floor(Date.now() / 1000);
  const trunkSha = (await git(repoRoot, 'rev-parse', '--verify', '-q', trunk).catch(() => '')).trim();
  if (!trunkSha) {
    return { checkedAt, trunk, trunkSha: '', clean: false, conflicts: [], error: `integration branch '${trunk}' not found` };
  }
  try {
    await exec('git', ['-C', repoRoot, 'merge-tree', '--write-tree', '--name-only', trunk, branch], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 20_000,
      env: gitEnv(),
    });
    return { checkedAt, trunk, trunkSha: trunkSha.slice(0, 7), clean: true, conflicts: [] };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
    // Exit code 1 from `git merge-tree --write-tree --name-only`:
    // line 1 = tree oid, subsequent non-empty lines before blank line = conflicting paths.
    if (e.code === 1 && typeof e.stdout === 'string') {
      const lines = e.stdout.split('\n');
      const conflicts: string[] = [];
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) break;
        if (!line.startsWith('CONFLICT')) conflicts.push(line);
      }
      return { checkedAt, trunk, trunkSha: trunkSha.slice(0, 7), clean: false, conflicts: [...new Set(conflicts)].sort() };
    }
    return {
      checkedAt,
      trunk,
      trunkSha: trunkSha.slice(0, 7),
      clean: false,
      conflicts: [],
      error: (e.stderr || e.message || 'merge-tree failed').trim(),
    };
  }
}

/** Recreates a previously reclaimed worktree at its original path from its preserved branch or fallback commit. */
export async function recreateWorktree(
  repoRoot: string,
  targetPath: string,
  branch: string | null,
  fallbackSha: string,
): Promise<{ path: string; branch: string | null; recreated: boolean }> {
  if (existsSync(targetPath)) return { path: targetPath, branch, recreated: false };
  await mkdir(dirname(targetPath), { recursive: true });
  if (branch) {
    const hasBranch = await git(repoRoot, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true).catch(() => false);
    if (hasBranch) {
      await git(repoRoot, 'worktree', 'add', targetPath, branch);
      return { path: targetPath, branch, recreated: true };
    }
  }
  if (fallbackSha && /^[0-9a-f]{7,40}$/.test(fallbackSha)) {
    const hasCommit = await git(repoRoot, 'cat-file', '-e', `${fallbackSha}^{commit}`).then(() => true).catch(() => false);
    if (hasCommit) {
      if (branch) {
        await git(repoRoot, 'worktree', 'add', '-b', branch, targetPath, fallbackSha);
        return { path: targetPath, branch, recreated: true };
      }
      await git(repoRoot, 'worktree', 'add', '--detach', targetPath, fallbackSha);
      return { path: targetPath, branch: null, recreated: true };
    }
  }
  throw new Error('preserved branch and base commit are no longer in the repository');
}

/** Prunes stale worktree administrative files under `<repo>/.git/worktrees`. */
export async function pruneWorktrees(repoRoot: string): Promise<void> {
  if (!existsSync(repoRoot)) return;
  await git(repoRoot, 'worktree', 'prune').catch(() => {});
}

/** Available disk space in bytes on the filesystem containing `dir`, or null if unavailable. */
export async function diskFreeBytes(dir: string): Promise<number | null> {
  try {
    const st = await statfs(dir);
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

export type RepoWorkspaceManifest = {
  env: Record<string, string>;
};

/** Optional `.ah/workspace.json` at the repo root (read-only): env templates for each checkout. */
export async function readRepoWorkspaceManifest(repoRoot: string): Promise<RepoWorkspaceManifest | null> {
  const file = join(repoRoot, '.ah', 'workspace.json');
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { env?: unknown };
    const env: Record<string, string> = {};
    if (parsed.env && typeof parsed.env === 'object' && !Array.isArray(parsed.env)) {
      for (const [k, v] of Object.entries(parsed.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
    }
    return { env };
  } catch {
    return null;
  }
}
