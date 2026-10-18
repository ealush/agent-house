// GitHub through the `gh` CLI, for stack review. Reads degrade to null or [];
// the few writes (merge, retarget, ready, resolve) throw GhError with gh's own
// words, and only ever run from an explicit action in the page — never from
// the reviewer model.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const GH_TIMEOUT_MS = 30_000;

export class GhError extends Error {}

const opts = (root: string, timeout: number) => ({
  cwd: root,
  maxBuffer: 32 * 1024 * 1024,
  timeout,
  env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' },
});
const lastWords = (text: string) => (text.trim().split('\n').filter(Boolean).pop() ?? 'gh failed').replace(/^(?:error|X|!)\s*[:]?\s*/i, '');

async function gh(root: string, args: string[], timeout = GH_TIMEOUT_MS): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, opts(root, timeout));
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new GhError('gh is not installed on this host');
    throw new GhError(lastWords(e.stderr || e.stdout || e.message));
  }
}

/**
 * `gh api` with the HTTP status. The stack endpoints say things with it: 404
 * when stacks are off in a repo, 409 with the merge that's already running.
 */
async function ghApi(root: string, args: string[]): Promise<{ status: number; body: Record<string, unknown> | unknown[] | null }> {
  let out: string;
  try {
    out = (await exec('gh', ['api', '--include', ...args], opts(root, GH_TIMEOUT_MS))).stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message: string; code?: string };
    if (e.code === 'ENOENT') throw new GhError('gh is not installed on this host');
    if (!e.stdout?.startsWith('HTTP/')) throw new GhError(lastWords(e.stderr || e.stdout || e.message));
    out = e.stdout;
  }
  const status = Number(out.match(/^HTTP\/[\d.]+ (\d{3})/)?.[1] ?? 0);
  const at = out.search(/\r?\n\r?\n/);
  const text = at < 0 ? '' : out.slice(at).trim();
  let body: Record<string, unknown> | unknown[] | null = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}
  return { status, body };
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
  mergedAt: string;
};

const FIELDS = 'number,title,url,body,state,isDraft,headRefName,baseRefName,headRefOid,baseRefOid,isCrossRepository,mergeable,mergeStateStatus,author,statusCheckRollup,additions,deletions,updatedAt,mergedAt';

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
    mergedAt: s('mergedAt'),
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

// GitHub's own stacks (gh stack, or Stack in the PR page): a line of PRs, each
// on the one below, that GitHub merges bottom-up, retargets and rebases itself.
// Reference: https://github.github.com/gh-stack/reference/rest-api/

export type NativePr = { number: number; open: boolean; merged: boolean; draft: boolean; headRef: string; headSha: string };
/** A stack on GitHub, its PRs bottom to top. `number` is the one GitHub shows. */
export type NativeStack = { number: number; base: string; open: boolean; prs: NativePr[] };

function toStack(v: unknown): NativeStack | null {
  if (!v || typeof v !== 'object') return null;
  const x = v as { number?: unknown; base?: { ref?: unknown }; open?: unknown; pull_requests?: unknown };
  if (typeof x.number !== 'number' || !Array.isArray(x.pull_requests)) return null;
  const prs = x.pull_requests.flatMap((p): NativePr[] => {
    if (!p || typeof p !== 'object') return [];
    const y = p as { number?: unknown; state?: unknown; draft?: unknown; merged_at?: unknown; head?: { ref?: unknown; sha?: unknown } };
    if (typeof y.number !== 'number') return [];
    return [{ number: y.number, open: y.state === 'open', merged: typeof y.merged_at === 'string' && !!y.merged_at, draft: y.draft === true, headRef: String(y.head?.ref ?? ''), headSha: String(y.head?.sha ?? '') }];
  });
  return { number: x.number, base: String(x.base?.ref ?? ''), open: x.open !== false, prs };
}

/** The repo's stacks on GitHub. [] when stacks are off there; null when gh can't say. */
export async function listStacks(root: string, repo: string): Promise<NativeStack[] | null> {
  const out: NativeStack[] = [];
  try {
    for (let page = 1; page <= 5; page++) {
      const r = await ghApi(root, [`repos/${repo}/stacks?per_page=100&page=${page}`]);
      if (r.status === 404) return [];
      if (r.status !== 200 || !Array.isArray(r.body)) return null;
      out.push(...r.body.map(toStack).filter((x): x is NativeStack => !!x));
      if (r.body.length < 100) break;
    }
  } catch {
    return null;
  }
  return out;
}

/**
 * Make a stack on GitHub of PRs, bottom to top, each based on the one before;
 * or put them on top of stack `onto`. GitHub checks the chain.
 */
export async function linkStack(root: string, repo: string, prs: number[], onto: number | null): Promise<NativeStack> {
  const r = await ghApi(root, ['--method', 'POST', onto === null ? `repos/${repo}/stacks` : `repos/${repo}/stacks/${onto}/add`, ...prs.flatMap((n) => ['-F', `pull_requests[]=${n}`])]);
  const b = (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {}) as { message?: unknown; errors?: { message?: unknown }[] };
  if (r.status === 404) throw new GhError(onto === null ? `stacked pull requests are off in ${repo}` : `${repo} has no stack #${onto}`);
  if (r.status >= 400) throw new GhError(String(b.errors?.[0]?.message ?? b.message ?? `GitHub refused the stack (${r.status})`));
  const st = toStack(r.body);
  if (!st) throw new GhError('GitHub answered without the stack');
  return st;
}

export type MergeRequest = { status: 'merged' | 'enqueued' | 'pending'; uuid: string | null; message: string };

function mergeReply(r: { status: number; body: unknown }, what: string): MergeRequest {
  const b = (r.body && typeof r.body === 'object' && !Array.isArray(r.body) ? r.body : {}) as { status?: unknown; message?: unknown; details?: { message?: unknown; uuid?: unknown } };
  const message = String(b.details?.message ?? b.message ?? '');
  if (r.status === 404) throw new GhError(`GitHub has no stack merge for ${what}`);
  if (b.status === 'failed' || (r.status >= 400 && r.status !== 409)) throw new GhError(message || `GitHub refused the merge (${r.status})`);
  const status = b.status === 'merged' || b.status === 'enqueued' ? b.status : 'pending';
  return { status, uuid: typeof b.details?.uuid === 'string' ? b.details.uuid : null, message };
}

/**
 * Ask GitHub to merge a PR of a stack, and with it every unmerged PR under
 * it, all or nothing. GitHub refuses unless the PR's head is still `headSha`.
 * The legacy merge endpoint (gh pr merge) can't merge a stacked PR at all.
 */
export async function requestMerge(root: string, repo: string, n: number, method: MergeMethod, headSha: string): Promise<MergeRequest> {
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new GhError('merge needs the full head commit');
  const r = await ghApi(root, ['--method', 'PUT', `repos/${repo}/pulls/${n}/merge-async`, '-f', `merge_method=${method}`, '-f', `sha=${headSha}`]);
  // 409: a merge of this PR is already running, maybe asked for at another head.
  const running = r.status === 409 && r.body && !Array.isArray(r.body) ? (r.body as { details?: { expected_head_sha?: unknown } }).details?.expected_head_sha : null;
  if (typeof running === 'string' && running && running !== headSha) throw new GhError(`a merge of #${n} at ${running.slice(0, 7)} is already running on GitHub`);
  return mergeReply(r, `#${n}`);
}

/** Where a merge request stands; null once GitHub forgot it (after a day). Throws GitHub's reason when it failed. */
export async function mergeStatus(root: string, repo: string, n: number, uuid: string): Promise<MergeRequest | null> {
  if (!/^[\w-]{8,64}$/.test(uuid)) throw new GhError('invalid merge request id');
  const r = await ghApi(root, [`repos/${repo}/pulls/${n}/merge-async/${uuid}`]);
  if (r.status === 404) return null;
  return mergeReply(r, `#${n}`);
}

/** Whether a PR waits in its base branch's merge queue; null when gh can't say. */
export async function inMergeQueue(root: string, repo: string, n: number): Promise<boolean | null> {
  const [owner, name] = repo.split('/');
  try {
    const v = await ghJson<{ data?: { repository?: { pullRequest?: { isInMergeQueue?: boolean } } } }>(root, [
      'api',
      'graphql',
      '-f',
      'query=query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){isInMergeQueue}}}',
      '-F',
      `owner=${owner}`,
      '-F',
      `name=${name}`,
      '-F',
      `n=${n}`,
    ]);
    const q = v.data?.repository?.pullRequest?.isInMergeQueue;
    return typeof q === 'boolean' ? q : null;
  } catch {
    return null;
  }
}

/** Whether the gh stack extension is installed here, so agents can be told to use it. */
export async function hasGhStack(root: string): Promise<boolean> {
  try {
    await gh(root, ['stack', '--version'], 10_000);
    return true;
  } catch {
    return false;
  }
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

// ---------- images in GitHub's markdown

export type GhImage = { type: string; body: Buffer };
export type ImageSource = { kind: 'file'; repo: string; parts: string[] } | { kind: 'upload'; url: string };

const IMAGE_MAX = 10 * 1024 * 1024;
const EXT_TYPE: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml' };
const NAME = /^[\w.-]{1,100}$/;

/**
 * Where an image in a PR description or review comment lives on GitHub: a file
 * in a repo (`github.com/o/r/blob/<ref>/<path>?raw=true`, `/raw/`, or
 * raw.githubusercontent.com), or an upload (user-attachments, user-images).
 * Anything else isn't GitHub's, and ah doesn't fetch it.
 */
export function imageSource(src: string): ImageSource | null {
  let u: URL;
  try {
    u = new URL(src);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const seg = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  if (seg.some((s) => s === '..' || s === '.' || /[/\\\0]/.test(s))) return null;
  if (u.hostname === 'github.com') {
    if (seg[0] === 'user-attachments' && seg[1] === 'assets' && seg.length === 3) return { kind: 'upload', url: u.href };
    if (seg.length >= 5 && NAME.test(seg[0]) && NAME.test(seg[1]) && seg[2] === 'assets') return { kind: 'upload', url: u.href };
    if (seg.length >= 5 && NAME.test(seg[0]) && NAME.test(seg[1]) && (seg[2] === 'blob' || seg[2] === 'raw')) return { kind: 'file', repo: `${seg[0]}/${seg[1]}`, parts: seg.slice(3) };
    return null;
  }
  if (u.hostname === 'raw.githubusercontent.com' && seg.length >= 4 && NAME.test(seg[0]) && NAME.test(seg[1])) {
    const rest = seg.slice(2);
    return { kind: 'file', repo: `${seg[0]}/${seg[1]}`, parts: rest[0] === 'refs' && rest[1] === 'heads' ? rest.slice(2) : rest };
  }
  if (u.hostname === 'user-images.githubusercontent.com' || u.hostname === 'private-user-images.githubusercontent.com') return { kind: 'upload', url: u.href };
  return null;
}

function imageType(name: string, body: Buffer): string | null {
  const ext = EXT_TYPE[name.split('.').pop()?.toLowerCase() ?? ''];
  if (ext) return ext;
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg';
  if (body.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

let token: { value: string; at: number } | null = null;
async function ghToken(root: string): Promise<string | null> {
  if (token && Date.now() - token.at < 10 * 60_000) return token.value;
  const value = (await gh(root, ['auth', 'token']).catch(() => '')).trim();
  token = value ? { value, at: Date.now() } : null;
  return value || null;
}

/**
 * An image from GitHub's markdown, read with this host's `gh` login, for a page
 * that only loads images from ah. A file comes through the contents API (a ref
 * with slashes is tried a segment at a time); an upload is fetched with gh's
 * token, which isn't sent on past GitHub (fetch drops it on a cross-origin
 * redirect). Null when it isn't GitHub's, isn't an image, or can't be read.
 */
export async function ghImage(root: string, src: string): Promise<GhImage | null> {
  const where = imageSource(src);
  if (!where) return null;
  if (where.kind === 'file') {
    for (let i = 1; i < Math.min(where.parts.length, 5); i++) {
      const ref = where.parts.slice(0, i).join('/');
      const path = where.parts.slice(i).map(encodeURIComponent).join('/');
      try {
        const { stdout } = await exec('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${where.repo}/contents/${path}?ref=${encodeURIComponent(ref)}`], { ...opts(root, GH_TIMEOUT_MS), encoding: 'buffer', maxBuffer: IMAGE_MAX });
        const type = imageType(where.parts.at(-1)!, stdout);
        return type ? { type, body: stdout } : null;
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') throw new GhError('gh is not installed on this host');
      }
    }
    return null;
  }
  const t = await ghToken(root);
  try {
    const r = await fetch(where.url, { headers: t ? { authorization: `token ${t}` } : {}, signal: AbortSignal.timeout(GH_TIMEOUT_MS) });
    const type = (r.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!r.ok || !/^image\//.test(type) || Number(r.headers.get('content-length') ?? 0) > IMAGE_MAX) return null;
    const body = Buffer.from(await r.arrayBuffer());
    return body.length > IMAGE_MAX ? null : { type, body };
  } catch {
    return null;
  }
}
