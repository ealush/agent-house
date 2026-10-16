// GitHub through the `gh` CLI, for stack review. Reads degrade to null or [];
// the few writes (merge, retarget, ready, resolve) throw GhError with gh's own
// words, and only ever run from an explicit action in the page — never from
// the reviewer model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;

export class GhError extends Error {}

async function gh(root: string, args: string[], timeout = GH_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      timeout,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new GhError('gh is not installed on this host');
    const said = (e.stderr || e.stdout || e.message).trim().split('\n').filter(Boolean).pop() ?? 'gh failed';
    throw new GhError(said.replace(/^(?:error|X|!)\s*[:]?\s*/i, ''));
  }
}

async function ghJson<T>(root: string, args: string[]): Promise<T> {
  const out = await gh(root, args);
  try {
    return JSON.parse(out) as T;
  } catch {
    throw new GhError('gh returned something that is not JSON');
  }
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type RepoInfo = { repo: string; trunk: string; methods: MergeMethod[] };

export async function repoInfo(root: string): Promise<RepoInfo> {
  const v = await ghJson<{ nameWithOwner?: string; defaultBranchRef?: { name?: string }; mergeCommitAllowed?: boolean; squashMergeAllowed?: boolean; rebaseMergeAllowed?: boolean }>(root, [
    'repo',
    'view',
    '--json',
    'nameWithOwner,defaultBranchRef,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed',
  ]);
  if (!v.nameWithOwner) throw new GhError('not a GitHub repository');
  const methods: MergeMethod[] = [];
  if (v.mergeCommitAllowed !== false) methods.push('merge');
  if (v.squashMergeAllowed) methods.push('squash');
  if (v.rebaseMergeAllowed) methods.push('rebase');
  return { repo: v.nameWithOwner, trunk: v.defaultBranchRef?.name || 'main', methods };
}

export type Checks = { pass: number; fail: number; pending: number; failing: string[] };
export type GhPr = {
  number: number;
  title: string;
  url: string;
  body: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  baseRefOid: string;
  crossRepo: boolean;
  mergeable: string | null;
  mergeState: string | null;
  author: string;
  checks: Checks;
  additions: number;
  deletions: number;
  updatedAt: string;
};

const FIELDS = 'number,title,url,body,state,isDraft,headRefName,baseRefName,headRefOid,baseRefOid,isCrossRepository,mergeable,mergeStateStatus,author,statusCheckRollup,additions,deletions,updatedAt';

/** Check rollup as GitHub reports it: check runs (status + conclusion) and commit statuses (state). */
export function rollup(items: unknown): Checks {
  const c: Checks = { pass: 0, fail: 0, pending: 0, failing: [] };
  if (!Array.isArray(items)) return c;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const x = it as { name?: string; context?: string; status?: string; conclusion?: string; state?: string };
    const name = x.name || x.context || 'check';
    const verdict = x.conclusion || (x.status && x.status !== 'COMPLETED' ? 'PENDING' : x.state) || 'PENDING';
    if (['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(verdict)) c.pass++;
    else if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(verdict)) {
      c.fail++;
      if (c.failing.length < 10) c.failing.push(name);
    } else c.pending++;
  }
  return c;
}

function toPr(v: Record<string, unknown>): GhPr | null {
  if (typeof v.number !== 'number') return null;
  const s = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
  const state = s('state').toUpperCase();
  return {
    number: v.number,
    title: s('title'),
    url: s('url'),
    body: s('body'),
    state: state === 'MERGED' ? 'MERGED' : state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    isDraft: v.isDraft === true,
    headRefName: s('headRefName'),
    baseRefName: s('baseRefName'),
    headRefOid: s('headRefOid'),
    baseRefOid: s('baseRefOid'),
    crossRepo: v.isCrossRepository === true,
    mergeable: s('mergeable') || null,
    mergeState: s('mergeStateStatus') || null,
    author: typeof v.author === 'object' && v.author ? String((v.author as { login?: unknown }).login ?? '') : '',
    checks: rollup(v.statusCheckRollup),
    additions: typeof v.additions === 'number' ? v.additions : 0,
    deletions: typeof v.deletions === 'number' ? v.deletions : 0,
    updatedAt: s('updatedAt'),
  };
}

/** Pull requests in the repo, newest first. */
export async function listPrs(root: string, state: 'open' | 'all' = 'open', limit = 100): Promise<GhPr[]> {
  const raw = await ghJson<unknown[]>(root, ['pr', 'list', '--state', state, '--limit', String(limit), '--json', FIELDS]);
  return (Array.isArray(raw) ? raw : []).map((v) => (v && typeof v === 'object' ? toPr(v as Record<string, unknown>) : null)).filter((p): p is GhPr => !!p);
}

export async function viewPr(root: string, n: number): Promise<GhPr | null> {
  try {
    return toPr(await ghJson<Record<string, unknown>>(root, ['pr', 'view', String(n), '--json', FIELDS]));
  } catch {
    return null;
  }
}

/**
 * Merge one PR, refusing unless its head is still `headSha`. GitHub checks
 * that at merge time, so a push that lands after the review fails the merge
 * instead of merging code nobody looked at. Never deletes the branch: layers
 * above may still target it until they're retargeted.
 */
export async function mergePr(root: string, n: number, method: MergeMethod, headSha: string): Promise<void> {
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new GhError('merge needs the full head commit');
  await gh(root, ['pr', 'merge', String(n), `--${method}`, '--match-head-commit', headSha], 120_000);
}

/** Point a PR at another base branch. */
export async function retarget(root: string, n: number, base: string): Promise<void> {
  await gh(root, ['pr', 'edit', String(n), '--base', base]);
}

/** Take a PR out of draft. */
export async function markReady(root: string, n: number): Promise<void> {
  await gh(root, ['pr', 'ready', String(n)]);
}

export type ThreadComment = { author: string; body: string; url: string; at: string };
export type ReviewThread = { id: string; resolved: boolean; outdated: boolean; path: string | null; line: number | null; startLine: number | null; comments: ThreadComment[] };

const THREADS = `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{id isResolved isOutdated path line startLine comments(first:30){nodes{author{login} body url createdAt}}}}}}}`;

/** Review threads on a PR (people and bots), oldest first. [] when gh can't say. */
export async function reviewThreads(root: string, repo: string, n: number): Promise<ReviewThread[]> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return [];
  let v: { data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown[] } } } } };
  try {
    v = await ghJson(root, ['api', 'graphql', '-f', `query=${THREADS}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `n=${n}`]);
  } catch {
    return [];
  }
  const nodes = v.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.flatMap((t) => {
    if (!t || typeof t !== 'object') return [];
    const x = t as { id?: string; isResolved?: boolean; isOutdated?: boolean; path?: string; line?: number; startLine?: number; comments?: { nodes?: unknown[] } };
    if (!x.id) return [];
    const comments = (x.comments?.nodes ?? []).flatMap((c) => {
      if (!c || typeof c !== 'object') return [];
      const y = c as { author?: { login?: string }; body?: string; url?: string; createdAt?: string };
      return [{ author: y.author?.login ?? 'ghost', body: y.body ?? '', url: y.url ?? '', at: y.createdAt ?? '' }];
    });
    return [{ id: x.id, resolved: !!x.isResolved, outdated: !!x.isOutdated, path: x.path ?? null, line: x.line ?? null, startLine: x.startLine ?? null, comments }];
  });
}

/** Reply to a review thread (when there's something to say), then resolve it. */
export async function replyAndResolve(root: string, threadId: string, body: string): Promise<void> {
  if (!/^[\w=-]{4,200}$/.test(threadId)) throw new GhError('invalid thread id');
  if (body.trim()) {
    await gh(root, [
      'api',
      'graphql',
      '-f',
      'query=mutation($id:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$id,body:$body}){comment{id}}}',
      '-f',
      `id=${threadId}`,
      '-f',
      `body=${body.trim()}`,
    ]);
  }
  await gh(root, ['api', 'graphql', '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', '-f', `id=${threadId}`]);
}
