// Revision-pinned git for stack review. Everything here reads exact commits
// fetched into refs/ah-review/<stack>/…, never a checkout: the agent that owns
// the branch may be on another one, mid-fix, or rebasing. The refs also keep
// reviewed revisions alive through force-pushes and `git gc`, which
// range-diff needs later.
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
export const REVIEW_REFS = 'refs/ah-review';
/** Cap on any patch handed to the page or the model. */
export const PATCH_CAP = 400 * 1024;

async function git(root: string, args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args], { maxBuffer: 64 * 1024 * 1024, timeout, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  return stdout;
}

export function validSha(s: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(s);
}

/** Branch names as git accepts them, minus anything that could read as an option or a range. */
export function validBranch(s: string): boolean {
  return /^[\w./-]{1,200}$/.test(s) && !s.startsWith('-') && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
}

/** The remote that points at `owner/name` on GitHub; `origin` when none says so. */
export async function remoteFor(root: string, repo: string): Promise<string> {
  const out = await git(root, ['remote', '-v']).catch(() => '');
  const want = repo.toLowerCase();
  for (const line of out.split('\n')) {
    const [name, url] = line.split(/\s+/);
    if (!name || !url) continue;
    const path = url.toLowerCase().replace(/\.git$/, '');
    if (path.endsWith(`/${want}`) || path.endsWith(`:${want}`)) return name;
  }
  return 'origin';
}

export const prRef = (stack: string, pr: number) => `${REVIEW_REFS}/${stack}/pr/${pr}`;
export const branchRef = (stack: string, branch: string) => `${REVIEW_REFS}/${stack}/branch/${branch}`;
export const revRef = (stack: string, rev: number) => `${REVIEW_REFS}/${stack}/rev/${rev}`;

/**
 * Fetch every layer's PR head and every base branch into the stack's own
 * refs, in one round trip. A deleted branch fails the batch, so a failed
 * batch retries spec by spec and keeps what it can.
 */
export async function fetchStack(root: string, remote: string, stack: string, prs: number[], branches: string[]): Promise<{ failed: string[] }> {
  const specs = [
    ...prs.map((n) => `+refs/pull/${n}/head:${prRef(stack, n)}`),
    ...branches.filter(validBranch).map((b) => `+refs/heads/${b}:${branchRef(stack, b)}`),
  ];
  if (!specs.length) return { failed: [] };
  const fetch = (s: string[]) => git(root, ['-c', 'gc.auto=0', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remote, ...s], 120_000);
  try {
    await fetch(specs);
    return { failed: [] };
  } catch {
    const failed: string[] = [];
    for (const s of specs) await fetch([s]).catch(() => failed.push(s.split(':')[1]));
    return { failed };
  }
}

/** The commit a ref or sha names, or null when it doesn't exist here. */
export async function resolve(root: string, ref: string): Promise<string | null> {
  try {
    return (await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim() || null;
  } catch {
    return null;
  }
}

export async function mergeBase(root: string, a: string, b: string): Promise<string | null> {
  try {
    return (await git(root, ['merge-base', a, b])).trim() || null;
  } catch {
    return null;
  }
}

/** The layer's own patch: what GitHub shows for the PR, base...head with canonical prefixes. */
export async function diff(root: string, base: string, head: string, paths?: string[]): Promise<{ patch: string; truncated: boolean }> {
  if (!validSha(base) || !validSha(head)) throw new Error('invalid revision');
  const out = await git(root, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', `${base}..${head}`, ...(paths?.length ? ['--', ...paths] : [])]);
  return out.length > PATCH_CAP ? { patch: out.slice(0, PATCH_CAP), truncated: true } : { patch: out, truncated: false };
}

export type DiffStat = { files: number; additions: number; deletions: number; paths: string[] };

export async function diffStat(root: string, base: string, head: string): Promise<DiffStat> {
  const out = await git(root, ['diff', '--numstat', '--no-renames', `${base}..${head}`]);
  const stat: DiffStat = { files: 0, additions: 0, deletions: 0, paths: [] };
  for (const line of out.split('\n')) {
    const [add, del, path] = line.split('\t');
    if (!path) continue;
    stat.files++;
    stat.additions += Number(add) || 0;
    stat.deletions += Number(del) || 0;
    stat.paths.push(path);
  }
  return stat;
}

/**
 * `git patch-id --stable` of the layer's patch: the same change keeps its id
 * when it's rebased onto new commits. "empty" for a layer with no changes.
 */
export async function patchId(root: string, base: string, head: string): Promise<string> {
  if (!validSha(base) || !validSha(head)) throw new Error('invalid revision');
  return new Promise((resolve, reject) => {
    const d = spawn('git', ['-C', root, 'diff', '--no-color', '--no-ext-diff', '--full-index', `${base}..${head}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    const p = spawn('git', ['-C', root, 'patch-id', '--stable'], { stdio: ['pipe', 'pipe', 'ignore'] });
    d.stdout.pipe(p.stdin);
    let out = '';
    p.stdout.on('data', (c) => (out += c));
    const timer = setTimeout(() => {
      d.kill();
      p.kill();
      reject(new Error('patch-id timed out'));
    }, GIT_TIMEOUT_MS);
    p.on('error', reject);
    d.on('error', reject);
    p.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim().split(/\s+/)[0] || 'empty');
    });
  });
}

/**
 * What changed in a layer between two revisions. Same base: the plain diff of
 * the heads, exact. Rebased: `git range-diff`, which pairs the commits and shows
 * how each one's patch changed, so the upstream moving doesn't read as the
 * layer changing.
 */
export async function sinceReview(
  root: string,
  from: { base: string; head: string },
  to: { base: string; head: string },
): Promise<{ kind: 'patch' | 'range'; text: string; truncated: boolean }> {
  for (const s of [from.base, from.head, to.base, to.head]) if (!validSha(s)) throw new Error('invalid revision');
  if (from.base === to.base) {
    const d = await diff(root, from.head, to.head);
    return { kind: 'patch', text: d.patch, truncated: d.truncated };
  }
  const out = await git(root, ['range-diff', '--no-color', `${from.base}..${from.head}`, `${to.base}..${to.head}`]);
  return out.length > PATCH_CAP ? { kind: 'range', text: out.slice(0, PATCH_CAP), truncated: true } : { kind: 'range', text: out, truncated: false };
}

/** One file at an exact commit; a note instead of a throw when it isn't there. */
export async function showAt(root: string, sha: string, path: string, limit: number): Promise<string> {
  if (!validSha(sha)) return 'Invalid revision.';
  if (!path || path.startsWith('/') || path.split('/').includes('..') || path.length > 500) return 'Path must be repo-relative.';
  let text: string;
  try {
    text = await git(root, ['show', `${sha}:${path}`]);
  } catch {
    return `${path} does not exist at ${sha.slice(0, 8)}.`;
  }
  if (text.includes('\0')) return 'Binary file, not shown.';
  return text.length > limit ? `${text.slice(0, limit)}\n... (truncated)` : text;
}

/** One line per commit in base..head, oldest first. */
export async function commits(root: string, base: string, head: string, max = 50): Promise<string> {
  if (!validSha(base) || !validSha(head)) return '';
  return (await git(root, ['log', '--reverse', '--format=%h %s', `-${max}`, `${base}..${head}`]).catch(() => '')).trim();
}

/** Keep a reviewed revision reachable after the branch is force-pushed. */
export async function pin(root: string, stack: string, rev: number, sha: string): Promise<void> {
  if (!validSha(sha)) throw new Error('invalid revision');
  await git(root, ['update-ref', revRef(stack, rev), sha]);
}

/** Drop every ref a stack holds (the stack was removed). */
export async function unpinStack(root: string, stack: string): Promise<void> {
  const out = await git(root, ['for-each-ref', '--format=%(refname)', `${REVIEW_REFS}/${stack}/`]).catch(() => '');
  const refs = out.split('\n').filter(Boolean);
  if (!refs.length) return;
  await new Promise<void>((resolve, reject) => {
    const p = spawn('git', ['-C', root, 'update-ref', '--stdin'], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`update-ref exited ${code}`))));
    p.stdin.end(refs.map((r) => `delete ${r}\n`).join(''));
  });
}

/**
 * The stacks gh stack tracks in a checkout's repo (it keeps them in the git
 * common dir, shared by every worktree): each a trunk and its branches,
 * bottom to top. [] when there are none or the file can't be read.
 */
export async function localStacks(cwd: string): Promise<{ trunk: string; branches: string[] }[]> {
  try {
    const dir = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000)).trim();
    const v = JSON.parse(await readFile(join(dir, 'gh-stack'), 'utf8')) as { stacks?: { trunk?: { branch?: unknown }; branches?: { branch?: unknown }[] }[] };
    return (v.stacks ?? []).map((st) => ({
      trunk: typeof st.trunk?.branch === 'string' ? st.trunk.branch : '',
      branches: (st.branches ?? []).map((b) => b.branch).filter((b): b is string => typeof b === 'string' && validBranch(b)),
    })).filter((st) => st.branches.length);
  } catch {
    return [];
  }
}
