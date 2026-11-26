// Stack review: the loop of read → review → send findings to the agent that
// owns the branch → re-review what changed → merge → next (docs/stack-review.md).
// GitHub is the source of truth for PR state; ah.db holds the rest. Runtime
// (sessions, sending, notifications) comes in as narrow callbacks from main.ts.
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { PrismaClient, ReviewFinding, ReviewLayer, ReviewRevision, ReviewStack } from '@prisma/client';
import { mainRepo } from '../git.ts';
import type { SideChatStore } from '../sidechat.ts';
import {
  closePr,
  createPr,
  GhError,
  ghImage,
  hasGhStack,
  inMergeQueue,
  listPrs,
  linkStack,
  listStacks,
  markReady,
  mergePr,
  mergeStatus,
  repoInfo,
  replyAndResolve,
  requestMerge,
  retarget,
  reviewThreads,
  viewPr,
  type Checks,
  type GhImage,
  type GhPr,
  type MergeMethod,
  type MergeRequest,
  type NativeStack,
  type ReviewThread,
} from './gh.ts';
import { branchHead, branchRef, commitRefsIn, commitsOn, diff, diffStat, fetchStack, isAncestor, localStacks, mergeBase, patchId, pin, prRef, publishBranch, remoteFor, resolve, resolveCommit, sinceReview, unpinStack, validBranch, validSha } from './git.ts';
import {
  parseReply,
  parseVerdict,
  recheckMessages,
  REVIEW_TOOLS,
  reviewMessages,
  runReviewTool,
  summaryMessages,
  type FindingLite,
  type LayerCtx,
  type ReviewEnv,
  type Verdict,
} from './reviewer.ts';
import { defaultOrder, descendants, forest, planRoles, subtree, validOrder, type Tree } from './stack.ts';
import { resolveSession } from './owners.ts';
import { ACTIVE_DISPATCH, buildStackView, checksOf, label, linkPlan, OPEN_FINDING, verdictOf } from './view.ts';
export { linkPlan } from './view.ts';
import { DomainError } from '../errors.ts';
import type { BranchCommit } from './git.ts';

export class ReviewError extends DomainError {}

const now = () => Math.floor(Date.now() / 1000);
const PLAN_MAX = 200_000;
const THREAD_HISTORY = 24;
const SYNC_STALE_S = 20;
const NATIVE_STALE_S = 15;
/** After a stack merge GitHub retargets and rebases what's left; until then a layer looks off its base. */
const SETTLE_S = 180;
const MERGE_WAIT_MS = 90_000;
const MERGE_POLL_MS = 1000;

export type SessionLite = {
  uid: string;
  /** Conversation key (`harness:harnessId`, or the uid for shells): what a binding follows. */
  key: string;
  title: string;
  agent: string | null;
  status: string;
  cwd: string;
  branch: string | null;
  live: boolean;
  /** When it started (unix seconds): its Commits list counts what was committed since. */
  startedAt?: number;
};

export type ReviewDeps = {
  sessions: () => Promise<SessionLite[]>;
  /** `id` names the message: asked again with it, the session answers rather than types it twice. */
  send: (uid: string, text: string, id: string) => Promise<{ outcome: string; queueId?: string }>;
  /** A needs-you push to devices that asked for those. */
  alert: (p: { title: string; body: string; tag: string; url: string }) => void;
  /** Recompute the streamed state (the Inbox reads review alerts from it). */
  changed: () => void;
  /** Read a plan file the host allows (inside files.roots). */
  readPlan: (path: string) => Promise<string>;
  /**
   * Start an agent session for fixes: a new worktree of the repo at `fromRef`
   * (the layer's head), so it never shares a checkout with another agent.
   */
  launch: (p: { preset: string; root: string; label: string; fromRef: string }) => Promise<SessionLite>;
  /** A session's transcript as text: the human's messages, and the latest entries. null when there's none to read. */
  transcript: (uid: string) => Promise<{ prompts: { at: number; text: string }[]; entries: { role: string; at: number; text: string }[] } | null>;
};

export type LayerStatus = 'unreviewed' | 'changes' | 'fixing' | 'rereview' | 'approved' | 'merged' | 'closed' | 'skipped';
export type Gate = { key: 'reviewed' | 'findings' | 'checks' | 'mergeable' | 'base' | 'below' | 'order'; ok: boolean; label: string; detail?: string };

export type RevView = { id: number; baseSha: string; headSha: string; patchId: string; files: number; additions: number; deletions: number; summary: string | null; verdict: Verdict | null };
export type DispatchView = { id: number; pr: number; kind: string; state: string; targetUid: string; targetTitle: string | null; targetAgent: string | null; sentAt: number; doneAt: number | null; findings: number[]; text: string };
export type FindingView = {
  id: number;
  ownerPr: number;
  foundOnPr: number;
  title: string;
  body: string;
  severity: string;
  state: string;
  source: string;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  ghUrl: string | null;
  ghThread: boolean;
  note: string | null;
  messageId: number | null;
  dispatchId: number | null;
  createdAt: number;
  /** Who moved it to its state ("you", "reviewer", "github"), when, and at which head. */
  stateBy: string | null;
  stateAt: number;
  stateHead: string | null;
};
export type LayerView = {
  pr: number;
  role: string;
  position: number;
  title: string;
  url: string;
  author: string;
  state: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeable: string | null;
  checks: Checks;
  needs: string;
  status: LayerStatus;
  approved: boolean;
  /** Reviewed revision has the same patch as the current one (maybe on new commits). */
  samePatch: boolean;
  rebased: boolean;
  current: RevView | null;
  reviewed: RevView | null;
  open: number;
  /** Open findings whose layer already merged: they're fixed here, on the next open layer. */
  followups: number;
  blocking: number;
  dispatch: DispatchView | null;
  gates: Gate[];
  ownerUid: string | null;
  /** The GitHub stack the PR is in, and its place there (1 at the bottom): GitHub merges it with the PRs under it. */
  ghStack: number | null;
  ghPos: number | null;
};
export type Owner = { uid: string; key: string; title: string; agent: string | null; status: string; live: boolean; branch: string | null } | null;
export type StackView = {
  id: string;
  title: string;
  repo: string;
  repoRoot: string;
  trunk: string;
  mergeMethod: string;
  methods: MergeMethod[];
  source: 'tree' | 'manual' | 'native';
  /** The stack on GitHub this one follows (source "native"). */
  ghStack: number | null;
  /** The agent session that made it. */
  origin: Owner;
  /** Whether its open PRs can become a stack on GitHub (or go on top of one), and if not, why. null: nothing to link. */
  link: { ok: boolean; prs: number[]; onto: number | null; why: string | null } | null;
  planPath: string | null;
  state: string;
  syncedAt: number;
  syncError: string | null;
  syncing: boolean;
  owner: Owner;
  layers: LayerView[];
  next: number | null;
  decisions: { id: number; text: string; fromPr: number | null; at: number }[];
};
/** What a merge did: the PRs that landed, those GitHub retargeted onto the trunk, and whether GitHub is still at it. */
export type MergeOutcome = { next: number | null; retargeted: number[]; restack: number[]; merged: number[]; waiting: 'github' | 'queue' | null };
/** What merging the stack did: the PRs that landed, those left to restack, whether GitHub is still at it, and where it stopped and why. */
export type StackMergeOutcome = { merged: number[]; restack: number[]; waiting: 'github' | 'queue' | null; stopped: { pr: number; why: string } | null; next: number | null };
export type StackSummary = {
  id: string;
  title: string;
  repo: string;
  trunk: string;
  state: string;
  source: 'tree' | 'manual' | 'native';
  ghStack: number | null;
  layers: number;
  merged: number;
  needsYou: number;
  next: number | null;
  syncedAt: number;
  spine: { pr: number; role: string; status: LayerStatus }[];
  origin: Owner;
  owner: Owner;
  files: number;
  additions: number;
  deletions: number;
  openFindings: number;
  blockingFindings: number;
  checks: Checks;
  readyToMerge: boolean;
};
export type ReviewAlert = { kind: 'rereview' | 'nopush' | 'ready' | 'restack'; stackId: string; stackTitle: string; pr: number; role: string; title: string; at: number; /** nopush: the message asked it to merge, not to fix. */ merge?: boolean };
export type SessionReviewLink = {
  uid: string;
  key: string;
  stackId: string;
  stackTitle: string;
  pr: number | null;
  role: string;
  relation: 'fixing' | 'branch' | 'owner' | 'origin';
  status: LayerStatus | null;
  openFindings: number;
  readyToMerge: boolean;
  needsYou: number;
};
/** What the streamed state carries: Inbox alerts, session banners, session links and the PR → stack map for session headers. */
export type ReviewState = {
  alerts: ReviewAlert[];
  fixing: { uid: string; stackId: string; pr: number; role: string; count: number; /** Asked to merge the stack up to `pr`, not to fix it. */ merge?: boolean }[];
  branches: { repo: string; branch: string; stackId: string; pr: number; role: string; stackTitle: string }[];
  sessions: SessionReviewLink[];
};

/** A stack as the session building it sees it: its branches bottom to top, each with its PR once there is one. */
/** What a session committed: newest first, each on the branch (and so the layer) it's in. */
export type SessionCommits = {
  /** Commits before this (unix seconds) were there before the session; 0 when it's unknown. */
  since: number;
  stack: SessionStack;
  commits: (BranchCommit & { branch: string })[];
};

export type SessionStack = {
  repo: string | null;
  /** The repo's main checkout: where a review of it is started. */
  root: string;
  trunk: string;
  /** Where the branches come from: gh stack's own tracking, or PRs based on each other. */
  source: 'gh-stack' | 'chain' | null;
  branch: string | null;
  ghStack: number | null;
  branches: {
    branch: string;
    current: boolean;
    pr: { number: number; title: string; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean; checks: Checks; additions: number; deletions: number } | null;
    layer: { status: LayerStatus; role: string } | null;
  }[];
  review: { id: string; title: string } | null;
  /** How a review would start from here; null when there are no PRs yet. */
  start: { native: number } | { pr: number } | { prs: number[] } | null;
};

type Candidate = { number: number; title: string; headRefName: string; baseRefName: string; draft: boolean; author: string; additions: number; deletions: number; updatedAt: string; inStack: string | null };
export type CandidateTree = { pr: Candidate; children: CandidateTree[] };
/** A stack on GitHub with open PRs, bottom to top. */
export type CandidateStack = { number: number; base: string; prs: number[] };




function findingView(f: ReviewFinding, heads?: Map<number, string>): FindingView {
  return {
    id: f.id,
    ownerPr: f.ownerPr,
    foundOnPr: f.foundOnPr,
    title: f.title,
    body: f.body,
    severity: f.severity,
    state: f.state,
    source: f.source,
    path: f.path,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    ghUrl: f.ghUrl,
    ghThread: !!f.ghThread,
    note: f.note,
    messageId: f.messageId,
    dispatchId: f.dispatchId,
    createdAt: f.createdAt,
    stateBy: f.stateBy,
    stateAt: f.updatedAt,
    stateHead: f.stateRevId ? (heads?.get(f.stateRevId) ?? null) : null,
  };
}

export const threadKey = (stackId: string, pr: number | null) => (pr === null ? `review:${stackId}` : `review:${stackId}:${pr}`);

/** What a question to the reviewer points at, besides the layer you're on: a finding, lines of a layer's diff (as shown), a file. */
export type AskContext = { kind: 'finding'; id: number } | { kind: 'lines'; pr: number; path: string; start: number; end: number; text: string } | { kind: 'file'; pr: number; path: string };
/** An attachment as the thread keeps it: enough to show it as a chip and say what it was. */
export type SavedContext = { kind: 'finding'; id: number; pr: number; label: string } | { kind: 'lines'; pr: number; path: string; start: number; end: number; label: string } | { kind: 'file'; pr: number; path: string; label: string };
/** One message of a stack's conversation: the layer it was asked on (null: the whole stack), and what was attached. */
export type ThreadMessage = { id: number; role: 'user' | 'assistant'; text: string; at: number; pr: number | null; context: SavedContext[] };

function threadMessage(r: { id: number; uid: string; role: string; text: string; at: number; context: string | null }): ThreadMessage {
  let pr: number | null = null;
  let context: SavedContext[] = [];
  try {
    const c = r.context ? (JSON.parse(r.context) as { pr?: unknown; items?: unknown }) : null;
    if (c) {
      pr = typeof c.pr === 'number' ? c.pr : null;
      if (Array.isArray(c.items)) context = c.items as SavedContext[];
    } else {
      // Rows from the time each layer had its own thread: the key says which.
      const m = /^review:.+:(\d+)$/.exec(r.uid);
      pr = m ? Number(m[1]) : null;
    }
  } catch {}
  return { id: r.id, role: r.role === 'assistant' ? 'assistant' : 'user', text: r.text, at: r.at, pr, context };
}

export class ReviewService {
  private db: PrismaClient;
  private chat: SideChatStore;
  private deps: ReviewDeps;
  private claims = new Map<string, Promise<unknown>>();
  private syncs = new Map<string, Promise<void>>();
  private jobs = new Set<string>();
  private bodies = new Map<string, string>();
  private methods = new Map<string, MergeMethod[]>();
  private repoCache = new Map<string, { at: number; repo: string | null; trunk: string }>();
  private rootOf = new Map<string, string | null>();
  private snapshot: ReviewState = { alerts: [], fixing: [], branches: [], sessions: [] };
  private timer: NodeJS.Timeout | null = null;
  private lastPoll = 0;
  private alerted = new Set<string>();
  private native = new Map<string, { at: number; stacks: NativeStack[] }>();
  /** Stack merges GitHub is still running, by `stackId:pr` of the PR asked for. */
  private merging = new Map<string, { stackId: string; root: string; repo: string; pr: number; prs: number[]; uuid: string }>();
  /** When ah last merged in a stack: GitHub's retarget and rebase of the rest follow it. */
  private settle = new Map<string, number>();
  private ghStackTool: boolean | null = null;
  private prCache = new Map<string, { at: number; prs: Promise<GhPr[]> }>();
  /** The branches each session last built a stack of, so it still shows once the agent is back on the trunk. */
  private lastBuilt = new Map<string, { root: string; trunk: string; branches: string[]; source: 'gh-stack' | 'chain' }>();
  /** How long a merge request waits for GitHub before the watcher takes over. */
  private mergeWait = MERGE_WAIT_MS;

  constructor(db: PrismaClient, chat: SideChatStore, deps: ReviewDeps) {
    this.db = db;
    this.chat = chat;
    this.deps = deps;
  }

  // ---------- state for the stream

  /** Last computed alerts and banners (sync; the stream reads it every tick). */
  state(): ReviewState {
    return this.snapshot;
  }

  /** Watch dispatches every few seconds, and poll GitHub for open stacks now and then. */
  start() {
    void this.refreshState();
    const loop = () => {
      this.timer = setTimeout(() => {
        this.watch()
          .catch((err) => console.error('review watch failed:', err))
          .finally(loop);
      }, 5000);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- repos and candidates

  private async repoOf(root: string): Promise<{ repo: string | null; trunk: string }> {
    const hit = this.repoCache.get(root);
    if (hit && now() - hit.at < 600) return hit;
    let out: { repo: string | null; trunk: string };
    try {
      const info = await repoInfo(root);
      this.methods.set(root, info.methods);
      out = { repo: info.repo, trunk: info.trunk };
    } catch {
      out = { repo: null, trunk: 'main' };
    }
    this.repoCache.set(root, { ...out, at: now() });
    return out;
  }

  /** GitHub's stacks in a repo, kept a few seconds. What gh last said when it can't say now. */
  private async nativeStacks(root: string, repo: string, force = false): Promise<NativeStack[] | null> {
    const hit = this.native.get(root);
    if (hit && !force && now() - hit.at < NATIVE_STALE_S) return hit.stacks;
    const stacks = await listStacks(root, repo);
    if (!stacks) return hit?.stacks ?? null;
    this.native.set(root, { at: now(), stacks });
    return stacks;
  }

  private async ghStackHere(root: string): Promise<boolean> {
    return (this.ghStackTool ??= await hasGhStack(root));
  }

  private mergingOf(stackId: string, pr: number) {
    return [...this.merging.values()].find((m) => m.stackId === stackId && m.prs.includes(pr)) ?? null;
  }

  private async mainOf(cwd: string): Promise<string | null> {
    if (this.rootOf.has(cwd)) return this.rootOf.get(cwd)!;
    const root = await mainRepo(cwd).catch(() => null);
    this.rootOf.set(cwd, root);
    return root;
  }

  /** GitHub repos your sessions work in, plus those with stacks. */
  async repos(): Promise<{ root: string; repo: string; trunk: string }[]> {
    const sessions = await this.deps.sessions();
    const roots = new Set<string>();
    for (const s of sessions) {
      const r = s.cwd ? await this.mainOf(s.cwd) : null;
      if (r) roots.add(r);
    }
    for (const s of await this.db.reviewStack.findMany({ select: { repoRoot: true } })) roots.add(s.repoRoot);
    const out: { root: string; repo: string; trunk: string }[] = [];
    for (const root of roots) {
      const { repo, trunk } = await this.repoOf(root);
      if (repo) out.push({ root, repo, trunk });
    }
    return out.sort((a, b) => a.repo.localeCompare(b.repo));
  }

  /** Open PRs in a repo as trees: each root and what's stacked on it. */
  async candidates(root: string): Promise<{ root: string; repo: string; trunk: string; trees: CandidateTree[]; stacks: { id: string; title: string }[]; native: CandidateStack[] }> {
    const main = await this.mainOf(root);
    if (!main) throw new ReviewError(400, 'not a git repository');
    const { repo, trunk } = await this.repoOf(main);
    if (!repo) throw new ReviewError(400, 'not a GitHub repository (or gh is not signed in)');
    const prs = (await this.gh(() => listPrs(main, 'open', 200))).filter((p) => !p.crossRepo);
    const taken = new Map<number, string>();
    const stacks = await this.db.reviewStack.findMany({ where: { repoRoot: main, state: 'open' }, select: { id: true, title: true }, orderBy: { createdAt: 'desc' } });
    for (const l of await this.db.reviewLayer.findMany({ where: { stackId: { in: stacks.map((s) => s.id) } } })) taken.set(l.pr, l.stackId);
    const toTree = (t: Tree<GhPr>): CandidateTree => ({
      pr: { number: t.pr.number, title: t.pr.title, headRefName: t.pr.headRefName, baseRefName: t.pr.baseRefName, draft: t.pr.isDraft, author: t.pr.author, additions: t.pr.additions, deletions: t.pr.deletions, updatedAt: t.pr.updatedAt, inStack: taken.get(t.pr.number) ?? null },
      children: t.children.map(toTree),
    });
    const open = new Set(prs.map((p) => p.number));
    const native = ((await this.nativeStacks(main, repo, true)) ?? [])
      .map((n) => ({ number: n.number, base: n.base, prs: n.prs.filter((p) => open.has(p.number)).map((p) => p.number) }))
      .filter((n) => n.prs.length);
    return { root: main, repo, trunk, trees: forest(prs).map(toTree), stacks, native };
  }

  // ---------- the stack a session builds

  /** Every PR in a repo, kept a few seconds: the session panels ask often. */
  private recentPrs(root: string): Promise<GhPr[]> {
    const hit = this.prCache.get(root);
    if (hit && now() - hit.at < 10) return hit.prs;
    const prs = listPrs(root, 'all', 200).catch(() => [] as GhPr[]);
    this.prCache.set(root, { at: now(), prs });
    return prs;
  }

  /**
   * The stack a session is building: the gh stack its branch is in, else the
   * chain of PRs its branch's PR is in, else the last one it was on. Each
   * branch with its PR and, when it's in review, its status there.
   */
  async sessionStack(uid: string): Promise<SessionStack> {
    const sess = (await this.deps.sessions()).find((x) => x.uid === uid);
    if (!sess) throw new ReviewError(404, 'session not found');
    const empty: SessionStack = { repo: null, root: '', trunk: 'main', source: null, branch: sess.branch, ghStack: null, branches: [], review: null, start: null };
    const root = sess.cwd ? await this.mainOf(sess.cwd) : null;
    if (!root) return empty;
    const { repo, trunk } = await this.repoOf(root);
    if (!repo) return empty;
    const prs = await this.recentPrs(root);
    const prOf = (branch: string) => prs.filter((p) => p.headRefName === branch && !p.crossRepo).sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number)[0] ?? null;
    let found: { trunk: string; branches: string[]; source: 'gh-stack' | 'chain' } | null = null;
    const local = (await localStacks(sess.cwd)).find((st) => sess.branch && st.branches.includes(sess.branch));
    if (local) found = { trunk: local.trunk || trunk, branches: local.branches, source: 'gh-stack' };
    else if (sess.branch && prOf(sess.branch)?.state === 'OPEN') {
      // PRs based on each other (including a single open PR): walk down to the base, then up through the session's branch.
      const open = prs.filter((p) => p.state === 'OPEN' && !p.crossRepo);
      const line: GhPr[] = [prOf(sess.branch)!];
      for (let p = open.find((x) => x.headRefName === line[0].baseRefName); p && !line.includes(p); p = open.find((x) => x.headRefName === line[0].baseRefName)) line.unshift(p);
      for (let p = open.find((x) => x.baseRefName === line.at(-1)!.headRefName); p && !line.includes(p); p = open.find((x) => x.baseRefName === line.at(-1)!.headRefName)) line.push(p);
      if (line.length >= 1) found = { trunk: line[0].baseRefName, branches: line.map((p) => p.headRefName), source: 'chain' };
    }
    if (found) this.lastBuilt.set(uid, { root, ...found });
    else {
      const last = this.lastBuilt.get(uid);
      if (last?.root === root) found = last;
    }
    if (!found) {
      // Fall back to any open review stack this session made or owns in this repo.
      const linked = await this.db.reviewStack.findFirst({
        where: {
          repoRoot: root,
          state: 'open',
          OR: [{ ownerKey: sess.key }, { ownerUid: sess.uid }, { originKey: sess.key }, { originUid: sess.uid }],
        },
        orderBy: { createdAt: 'desc' },
      });
      if (linked) {
        const lv = await this.view(linked.id, { autoSync: false });
        if (lv.layers.length) {
          found = { trunk: linked.trunk, branches: lv.layers.map((l) => l.headRef), source: 'chain' };
        }
      }
    }
    if (!found) return { ...empty, repo, root, trunk };
    const rows = found.branches.map((b) => ({ branch: b, pr: prOf(b) }));
    const numbers = rows.flatMap((r) => (r.pr ? [r.pr.number] : []));
    const natives = (await this.nativeStacks(root, repo)) ?? [];
    const ghStack = natives.find((n) => n.prs.some((p) => numbers.includes(p.number)))?.number ?? null;
    // The review these PRs are in, if any: open first.
    const layers = numbers.length ? await this.db.reviewLayer.findMany({ where: { pr: { in: numbers } } }) : [];
    const stacks = layers.length ? await this.db.reviewStack.findMany({ where: { id: { in: [...new Set(layers.map((l) => l.stackId))] }, repoRoot: root, state: { not: 'archived' } }, orderBy: { createdAt: 'desc' } }) : [];
    const rs = stacks.find((x) => x.state === 'open') ?? stacks[0] ?? null;
    const view = rs ? await this.view(rs.id, { autoSync: false }) : null;
    const open = rows.filter((r) => r.pr?.state === 'OPEN').map((r) => r.pr!.number);
    return {
      repo,
      root,
      trunk: found.trunk,
      source: found.source,
      branch: sess.branch,
      ghStack,
      branches: rows.map((r) => {
        const l = r.pr ? view?.layers.find((x) => x.pr === r.pr!.number) : undefined;
        return {
          branch: r.branch,
          current: r.branch === sess.branch,
          pr: r.pr ? { number: r.pr.number, title: r.pr.title, url: r.pr.url, state: r.pr.state, draft: r.pr.isDraft, checks: r.pr.checks, additions: r.pr.additions, deletions: r.pr.deletions } : null,
          layer: l ? { status: l.status, role: l.role } : null,
        };
      }),
      review: rs ? { id: rs.id, title: rs.title } : null,
      start: rs || !open.length ? null : ghStack !== null && natives.find((n) => n.number === ghStack)?.prs.some((p) => p.open) ? { native: ghStack } : open.length === 1 ? { pr: open[0] } : { prs: open },
    };
  }

  /**
   * The commits a session made: on each branch of its stack (bottom to top), what's on it and
   * not on trunk or the branch below, committed since the session started; then its own
   * branch's, when that isn't in the stack; then branches its transcript shows it committed
   * on, even in another worktree (`[branch sha]`). Each names its branch, so the layer it's in.
   */
  async sessionCommits(uid: string, max = 200): Promise<SessionCommits> {
    const sess = (await this.deps.sessions()).find((x) => x.uid === uid);
    if (!sess) throw new ReviewError(404, 'session not found');
    let stack = await this.sessionStack(uid);
    const since = sess.startedAt ?? 0;
    if (!stack.root) return { since, stack, commits: [] };
    stack = await this.withRecorded(uid, stack);
    const remote = stack.repo ? await remoteFor(stack.root, stack.repo) : 'origin';
    const trunk = (await Promise.all([`refs/heads/${stack.trunk}`, `refs/remotes/${remote}/${stack.trunk}`].map((ref) => resolve(stack.root, ref).catch(() => null)))).filter((x): x is string => !!x);
    const lines = stack.branches.map((b) => b.branch);
    if (sess.branch && sess.branch !== stack.trunk && !lines.includes(sess.branch)) lines.push(sess.branch);
    // Each branch leaves out every head below it, so a commit is listed once, on the lowest branch it's on.
    const below: string[] = [];
    let commits: SessionCommits['commits'] = [];
    for (const branch of lines) {
      const head = await branchHead(stack.root, branch, remote);
      if (!head) continue;
      const own = (await commitsOn(stack.root, head, [...trunk, ...below], max)).filter((c) => c.at >= since);
      commits = [...own.map((c) => ({ ...c, branch })), ...commits];
      below.push(head);
    }
    return { since, stack, commits: commits.slice(0, max) };
  }

  /**
   * Branches the session committed on that aren't its own checkout: git's `[branch sha]`
   * line in its transcript, resolved in this repo. A gh stack that contains one of them
   * is the stack, so the review is that stack and not only the branch it happened to name.
   */
  private async withRecorded(uid: string, stack: SessionStack): Promise<SessionStack> {
    const t = await this.deps.transcript(uid).catch(() => null);
    if (!t || !stack.root) return stack;
    const refs = commitRefsIn(t.entries.map((e) => e.text).join('\n'));
    if (!refs.length) return stack;
    const remote = stack.repo ? await remoteFor(stack.root, stack.repo) : 'origin';
    const named: string[] = [];
    for (const ref of refs) {
      if (named.includes(ref.branch) || ref.branch === stack.trunk) continue;
      const sha = await resolveCommit(stack.root, ref.sha);
      const head = sha ? await branchHead(stack.root, ref.branch, remote) : null;
      if (sha && head && (await isAncestor(stack.root, sha, head))) named.push(ref.branch);
    }
    if (!named.length) return stack;
    const local = (await localStacks(stack.root)).find((st) => named.some((b) => st.branches.includes(b)));
    const want = (local ? local.branches : named).filter((b) => b !== stack.trunk && !stack.branches.some((x) => x.branch === b));
    if (!want.length) return stack;
    const prs = stack.repo ? await this.recentPrs(stack.root) : [];
    const prOf = (branch: string) => prs.filter((p) => p.headRefName === branch && !p.crossRepo).sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number)[0] ?? null;
    const branches = [
      ...stack.branches,
      ...want.map((branch) => {
        const pr = prOf(branch);
        return {
          branch,
          current: branch === stack.branch,
          pr: pr ? { number: pr.number, title: pr.title, url: pr.url, state: pr.state, draft: pr.isDraft, checks: pr.checks, additions: pr.additions, deletions: pr.deletions } : null,
          layer: null,
        };
      }),
    ];
    const open = branches.flatMap((b) => (b.pr?.state === 'OPEN' ? [b.pr.number] : []));
    const start = stack.review || stack.start || !open.length ? stack.start : open.length === 1 ? { pr: open[0] } : { prs: open };
    return { ...stack, branches, start };
  }

  /** Jump straight from a session to its review: opens an existing linked review, or creates & binds one for its open PR/stack. */
  async openForSession(uid: string): Promise<{ stack: StackView; pr: number | null; created: boolean }> {
    const sess = (await this.deps.sessions()).find((x) => x.uid === uid);
    if (!sess) throw new ReviewError(404, 'session not found');
    const ss = await this.sessionStack(uid);
    if (ss.review) {
      const stack = await this.view(ss.review.id);
      const curPr = ss.branches.find((b) => b.current)?.pr?.number ?? null;
      const pr = curPr && stack.layers.some((l) => l.pr === curPr) ? curPr : stack.next;
      return { stack, pr, created: false };
    }
    // Check if the session already owns or originated any open stack (even if cwd changed).
    const existing = await this.db.reviewStack.findFirst({
      where: {
        state: 'open',
        OR: [{ ownerKey: sess.key }, { ownerUid: sess.uid }, { originKey: sess.key }, { originUid: sess.uid }],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      const stack = await this.view(existing.id);
      return { stack, pr: stack.next, created: false };
    }
    if (ss.start && ss.root) {
      const stack = await this.create(ss.root, ss.start, undefined, uid);
      const curPr = ss.branches.find((b) => b.current)?.pr?.number ?? null;
      const pr = curPr && stack.layers.some((l) => l.pr === curPr) ? curPr : stack.next ?? stack.layers[0]?.pr ?? null;
      return { stack, pr, created: true };
    }
    throw new ReviewError(404, 'no open pull request for this session yet');
  }

  /**
   * Open pull requests for branches this session committed on that don't have one,
   * then the review of them: the one it already has, or a new one it made.
   * One branch, or every such branch when none is named. The base is the branch
   * under it in what it committed, else the trunk — never the whole stack's diff.
   */
  async openPulls(uid: string, branch?: string): Promise<{ stack: StackView; pr: number | null; created: boolean; pulls: { branch: string; number: number; url: string; created: boolean }[] }> {
    const sess = (await this.deps.sessions()).find((x) => x.uid === uid);
    if (!sess) throw new ReviewError(404, 'session not found');
    if (branch !== undefined && !validBranch(branch)) throw new ReviewError(400, 'invalid branch');
    const listed = await this.sessionCommits(uid);
    const stack = listed.stack;
    if (!stack.root || !stack.repo) throw new ReviewError(400, 'not a GitHub repository (or gh is not signed in)');
    // The review's own trunk can be a branch mid-stack. A new pull request is based on the repository's.
    const trunk = (await this.repoOf(stack.root)).trunk;
    const committed = [...new Set(listed.commits.map((c) => c.branch))];
    const wanted = branch ? [branch] : committed;
    if (branch && !committed.includes(branch) && !stack.branches.some((b) => b.branch === branch)) throw new ReviewError(404, `${branch} is not a branch this session committed on`);
    if (!wanted.length) throw new ReviewError(409, 'nothing committed here to open a pull request for');
    const remote = await remoteFor(stack.root, stack.repo);
    const heads = new Map<string, string>();
    for (const name of [...new Set([...wanted, trunk, ...stack.branches.map((b) => b.branch)])]) {
      const head = await branchHead(stack.root, name, remote);
      if (head) heads.set(name, head);
    }
    const missing = wanted.find((name) => !heads.has(name));
    if (missing) throw new ReviewError(404, `${missing} is not in this repository`);
    const order = await this.bottomUp(stack.root, wanted, heads);
    const pulls: { branch: string; number: number; url: string; created: boolean }[] = [];
    this.prCache.delete(stack.root);
    let known = await this.gh(() => listPrs(stack.root, 'all', 200));
    // A branch that already has a pull request can be the one under this, even when this session didn't name it.
    for (const p of known) {
      if (p.crossRepo || p.state !== 'OPEN' || heads.has(p.headRefName)) continue;
      const head = await branchHead(stack.root, p.headRefName, remote);
      if (head) heads.set(p.headRefName, head);
    }
    const openOf = (name: string) => known.filter((p) => p.headRefName === name && !p.crossRepo && p.state === 'OPEN').sort((a, b) => b.number - a.number)[0];
    for (const name of order) {
      const existing = openOf(name);
      if (existing) {
        pulls.push({ branch: name, number: existing.number, url: existing.url, created: false });
        continue;
      }
      const base = await this.pullBase(stack.root, name, heads, trunk);
      try {
        await publishBranch(stack.root, name, remote);
      } catch (err) {
        throw new ReviewError(409, (err as Error).message);
      }
      const baseHead = heads.get(base) ?? (await branchHead(stack.root, base, remote));
      const own = await commitsOn(stack.root, heads.get(name)!, baseHead ? [baseHead] : [], 30);
      if (!own.length) throw new ReviewError(409, `${name} has no commits that aren't already on ${base}`);
      const title = (own[own.length - 1]?.subject || name).slice(0, 256);
      const body = own.slice().reverse().map((c) => c.subject).join('\n\n').slice(0, 60_000) || title;
      const made = await this.gh(() => createPr(stack.root, name, base, title, body));
      pulls.push({ branch: name, number: made.number, url: made.url, created: true });
      this.prCache.delete(stack.root);
      known = await this.gh(() => listPrs(stack.root, 'all', 200));
    }
    const numbers = pulls.map((p) => p.number);
    const focus = (branch ? pulls.find((p) => p.branch === branch)?.number : pulls.at(-1)?.number) ?? null;
    const opened = await this.reviewOf(uid, stack.root, numbers, focus);
    this.prCache.delete(stack.root);
    return { ...opened, pulls };
  }

  /** A branch before another when its head is an ancestor: bottom of the stack first. */
  private async bottomUp(root: string, names: string[], heads: Map<string, string>): Promise<string[]> {
    const under = new Map<string, string[]>();
    for (const name of names) {
      under.set(name, []);
      for (const other of names) {
        if (other === name) continue;
        const mine = heads.get(name);
        const theirs = heads.get(other);
        if (mine && theirs && theirs !== mine && (await isAncestor(root, theirs, mine))) under.get(name)!.push(other);
      }
    }
    const out: string[] = [];
    const visit = (name: string, seen: Set<string>) => {
      if (out.includes(name) || seen.has(name)) return;
      seen.add(name);
      for (const other of under.get(name) ?? []) visit(other, seen);
      out.push(name);
    };
    for (const name of names) visit(name, new Set());
    return out;
  }

  /** The branch this one sits on: the closest other branch here that contains none of its own commits, else the trunk. */
  private async pullBase(root: string, branch: string, heads: Map<string, string>, trunk: string): Promise<string> {
    const head = heads.get(branch);
    if (!head) return trunk;
    let best = trunk;
    let bestHead: string | null = null;
    const trunkHead = heads.get(trunk);
    if (trunkHead && (await isAncestor(root, trunkHead, head))) bestHead = trunkHead;
    for (const [name, sha] of heads) {
      if (name === branch || name === trunk || sha === head) continue;
      if (!(await isAncestor(root, sha, head))) continue;
      if (!bestHead || (await isAncestor(root, bestHead, sha))) {
        best = name;
        bestHead = sha;
      }
    }
    return best;
  }

  /** The review these pull requests belong in: the session's, one that already holds one, or a new one. */
  private async reviewOf(uid: string, root: string, numbers: number[], focus: number | null): Promise<{ stack: StackView; pr: number | null; created: boolean }> {
    const held = await this.db.reviewLayer.findMany({ where: { pr: { in: numbers } } });
    const open = held.length ? await this.db.reviewStack.findFirst({ where: { id: { in: [...new Set(held.map((l) => l.stackId))] }, repoRoot: root, state: 'open' }, orderBy: { createdAt: 'desc' } }) : null;
    const ss = await this.sessionStack(uid);
    const id = ss.review?.id ?? open?.id ?? null;
    if (id) {
      const have = new Set((await this.db.reviewLayer.findMany({ where: { stackId: id } })).map((l) => l.pr));
      const add = numbers.filter((n) => !have.has(n));
      const stack = add.length ? await this.addLayers(id, add) : await this.view(id, { autoSync: false });
      const pr = focus && stack.layers.some((l) => l.pr === focus) ? focus : stack.next;
      return { stack, pr, created: false };
    }
    const stack = await this.create(root, numbers.length === 1 ? { pr: numbers[0] } : { prs: numbers }, undefined, uid);
    const pr = focus && stack.layers.some((l) => l.pr === focus) ? focus : stack.next ?? numbers[0] ?? null;
    return { stack, pr, created: true };
  }

  // ---------- stacks

  /**
   * A stack from one PR (it and every PR GitHub stacks on it, which keep joining),
   * from PRs you pick, reviewed and merged in the order you give, or from a
   * stack on GitHub, whose PRs join and keep GitHub's order.
   */
  async create(root: string, input: { pr: number } | { prs: number[] } | { native: number }, title?: string, from?: string): Promise<StackView> {
    const main = await this.mainOf(root);
    if (!main) throw new ReviewError(400, 'not a git repository');
    const { repo, trunk } = await this.repoOf(main);
    if (!repo) throw new ReviewError(400, 'not a GitHub repository (or gh is not signed in)');
    let prs = (await this.gh(() => listPrs(main, 'open', 200))).filter((p) => !p.crossRepo);
    let order: number[];
    let base: string;
    let source: 'tree' | 'manual' | 'native';
    let ghStack: number | null = null;
    if ('native' in input) {
      const ns = ((await this.nativeStacks(main, repo, true)) ?? []).find((n) => n.number === input.native);
      if (!ns) throw new ReviewError(404, `${repo} has no stack #${input.native} on GitHub`);
      order = ns.prs.filter((p) => prs.some((x) => x.number === p.number)).map((p) => p.number);
      if (!order.length) throw new ReviewError(409, `stack #${input.native} has no open pull requests`);
      base = ns.base || trunk;
      source = 'native';
      ghStack = ns.number;
    } else if ('pr' in input) {
      const tree = subtree(prs, input.pr);
      if (tree) {
        order = defaultOrder(tree);
        base = tree.pr.baseRefName || trunk;
        source = 'tree';
      } else {
        // Already merged or closed: still a review, so a commit opens here rather than on GitHub.
        const found = (await this.gh(() => listPrs(main, 'all', 200))).find((p) => p.number === input.pr && !p.crossRepo);
        if (!found) throw new ReviewError(404, `#${input.pr} is not a pull request in ${repo}`);
        prs = [found];
        order = [found.number];
        base = found.baseRefName || trunk;
        source = 'tree';
      }
    } else {
      order = this.pickedOrder(prs, input.prs, repo);
      const heads = new Set(order.map((n) => prs.find((p) => p.number === n)!.headRefName));
      base = prs.find((p) => p.number === order.find((n) => !heads.has(prs.find((x) => x.number === n)!.baseRefName)))?.baseRefName || trunk;
      source = 'manual';
    }
    const first = prs.find((p) => p.number === order[0])!;
    const id = randomUUID().slice(0, 8);
    await this.claiming(main, async () => {
      await this.untaken(main, order);
      await this.db.reviewStack.create({ data: { id, repoRoot: main, repo, trunk: base, source, ghStack, title: (title?.trim() || first.title).slice(0, 120), createdAt: now() } });
      await this.db.reviewLayer.createMany({ data: order.map((n, i) => this.layerRow(id, prs.find((x) => x.number === n)!, i)) });
    });
    for (const p of prs) this.bodies.set(`${id}:${p.number}`, p.body);
    // The session it's started from made it and owns it; else the one session working on these branches, if exactly one is.
    const maker = from ? (await this.deps.sessions()).find((x) => x.uid === from) : undefined;
    if (from && !maker) throw new ReviewError(404, 'session not found');
    const sugg = await this.ownerSuggestions(id);
    const only = sugg.length && sugg[0].reason === 'branch' && sugg.filter((s) => s.reason === 'branch').length === 1 ? sugg[0] : null;
    const who = maker ?? only;
    if (who) await this.db.reviewStack.update({ where: { id }, data: { ownerUid: who.uid, ownerKey: who.key, originUid: who.uid, originKey: who.key } });
    await this.refreshState();
    // The first fetch of every layer can take a while on a big stack: the page opens now and fills in.
    void this.sync(id, true).catch((err) => console.error(`review sync ${id}:`, (err as Error).message));
    return this.view(id, { autoSync: false });
  }

  /** Picked PRs, checked: open, here, once each, and none before the PR it's built on. */
  private pickedOrder(prs: GhPr[], picked: number[], repo: string): number[] {
    if (!picked.length) throw new ReviewError(400, 'pick at least one pull request');
    if (picked.length > 60) throw new ReviewError(400, 'at most 60 pull requests in a stack');
    if (new Set(picked).size !== picked.length) throw new ReviewError(400, 'each pull request once');
    const missing = picked.find((n) => !prs.some((p) => p.number === n));
    if (missing) throw new ReviewError(404, `#${missing} is not an open pull request in ${repo}`);
    const nodes = picked.map((n) => prs.find((p) => p.number === n)!);
    for (const [i, p] of nodes.entries()) {
      const j = nodes.findIndex((x) => x.headRefName === p.baseRefName);
      if (j > i) throw new ReviewError(400, `#${p.number} is built on #${nodes[j].number}, so it has to come after it`);
    }
    return picked;
  }

  /**
   * "Not already under review" and taking the PRs are one step per repository: two
   * requests (or a request and a sync) checking at once can't both take the same PR.
   */
  private async claiming<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.claims.get(root) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(fn);
    this.claims.set(root, task);
    try {
      return await task;
    } finally {
      if (this.claims.get(root) === task) this.claims.delete(root);
    }
  }

  private async untaken(root: string, prs: number[]): Promise<void> {
    const open = (await this.db.reviewStack.findMany({ where: { repoRoot: root, state: 'open' }, select: { id: true } })).map((s) => s.id);
    const taken = await this.db.reviewLayer.findFirst({ where: { pr: { in: prs }, stackId: { in: open } } });
    if (taken) throw new ReviewError(409, `#${taken.pr} is already in a stack under review`);
  }

  private layerRow(stackId: string, p: GhPr, position: number) {
    return { stackId, pr: p.number, position, title: p.title, url: p.url, headRef: p.headRefName, baseRef: p.baseRefName, headSha: p.headRefOid, draft: p.isDraft, author: p.author };
  }

  /** More PRs at the end of a stack, in the order given. */
  async addLayers(id: string, picked: number[]): Promise<StackView> {
    const s = await this.stack(id);
    const prs = (await this.gh(() => listPrs(s.repoRoot, 'open', 200))).filter((p) => !p.crossRepo);
    const layers = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
    const dup = picked.find((n) => layers.some((l) => l.pr === n));
    if (dup) throw new ReviewError(409, `#${dup} is already in this stack`);
    const order = this.pickedOrder(prs, picked, s.repo);
    await this.claiming(s.repoRoot, async () => {
      await this.untaken(s.repoRoot, order);
      // Read again in the claim: a sync may have joined a layer since.
      const now = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
      const end = now.length ? now[now.length - 1].position + 1 : 0;
      await this.db.reviewLayer.createMany({ data: order.map((n, i) => this.layerRow(id, prs.find((x) => x.number === n)!, end + i)) });
    });
    for (const p of prs) this.bodies.set(`${id}:${p.number}`, p.body);
    if (s.state === 'done') await this.db.reviewStack.update({ where: { id }, data: { state: 'open' } });
    void this.sync(id, true).catch((err) => console.error(`review sync ${id}:`, (err as Error).message));
    return this.view(id, { autoSync: false });
  }

  /**
   * A PR out of the stack, with its findings and revisions. Nothing changes on
   * GitHub. The stack is yours from here: new PRs no longer join it by themselves.
   */
  async removeLayer(id: string, pr: number): Promise<StackView> {
    await this.layer(id, pr);
    if ((await this.db.reviewLayer.count({ where: { stackId: id } })) < 2) throw new ReviewError(409, 'a stack keeps at least one pull request; remove the stack instead');
    await this.db.$transaction([
      this.db.reviewFinding.deleteMany({ where: { stackId: id, ownerPr: pr } }),
      this.db.reviewDispatch.deleteMany({ where: { stackId: id, pr } }),
      this.db.reviewRevision.deleteMany({ where: { stackId: id, pr } }),
      this.db.chatMessage.deleteMany({ where: { uid: `review:${id}:${pr}` } }),
      this.db.reviewLayer.delete({ where: { stackId_pr: { stackId: id, pr } } }),
      this.db.reviewStack.update({ where: { id }, data: { source: 'manual', ghStack: null } }),
    ]);
    await this.refreshState();
    return this.view(id);
  }

  async list(): Promise<StackSummary[]> {
    const stacks = await this.db.reviewStack.findMany({ where: { state: { not: 'archived' } }, orderBy: { createdAt: 'desc' } });
    const out: StackSummary[] = [];
    for (const s of stacks) {
      const v = await this.view(s.id);
      const openLayers = v.layers.filter((l) => l.state === 'open');
      const nextLayer = v.next !== null ? v.layers.find((l) => l.pr === v.next) ?? null : openLayers[0] ?? null;
      const checks: Checks = { pass: 0, fail: 0, pending: 0, failing: [] };
      let files = 0;
      let additions = 0;
      let deletions = 0;
      let openFindings = 0;
      let blockingFindings = 0;
      for (const l of openLayers) {
        checks.pass += l.checks.pass;
        checks.fail += l.checks.fail;
        checks.pending += l.checks.pending;
        if (l.checks.failing.length) checks.failing.push(...l.checks.failing);
        files += l.current?.files ?? 0;
        additions += l.current?.additions ?? 0;
        deletions += l.current?.deletions ?? 0;
        openFindings += l.open;
        blockingFindings += l.blocking;
      }
      out.push({
        id: s.id,
        title: s.title,
        repo: s.repo,
        trunk: s.trunk,
        state: s.state,
        source: v.source,
        ghStack: v.ghStack,
        layers: v.layers.filter((l) => l.state !== 'skipped' && l.state !== 'closed').length,
        merged: v.layers.filter((l) => l.state === 'merged').length,
        needsYou: this.snapshot.alerts.filter((a) => a.stackId === s.id).length,
        next: v.next,
        syncedAt: s.syncedAt,
        spine: v.layers.filter((l) => l.state !== 'skipped' && l.state !== 'closed').map((l) => ({ pr: l.pr, role: l.role, status: l.status })),
        origin: v.origin,
        owner: v.owner,
        files,
        additions,
        deletions,
        openFindings,
        blockingFindings,
        checks,
        readyToMerge: !!nextLayer && nextLayer.gates.every((g) => g.ok),
      });
    }
    return out;
  }

  private async stack(id: string): Promise<ReviewStack> {
    const s = await this.db.reviewStack.findUnique({ where: { id } });
    if (!s) throw new ReviewError(404, 'stack not found');
    return s;
  }

  private async layer(id: string, pr: number): Promise<ReviewLayer> {
    const l = await this.db.reviewLayer.findUnique({ where: { stackId_pr: { stackId: id, pr } } });
    if (!l) throw new ReviewError(404, `#${pr} is not in this stack`);
    return l;
  }

  async view(id: string, { autoSync = true } = {}): Promise<StackView> {
    const s = await this.stack(id);
    // Opening a stack refreshes it in the background when it's stale.
    if (autoSync && s.state === 'open' && now() - s.syncedAt > SYNC_STALE_S && !this.syncs.has(id)) void this.sync(id).catch(() => {});
    const [layers, revs, findings, dispatches, decisions, sessions] = await Promise.all([
      this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } }),
      this.db.reviewRevision.findMany({ where: { stackId: id } }),
      this.db.reviewFinding.findMany({ where: { stackId: id } }),
      this.db.reviewDispatch.findMany({ where: { stackId: id }, orderBy: { id: 'desc' } }),
      this.db.reviewDecision.findMany({ where: { stackId: id }, orderBy: { id: 'asc' } }),
      this.deps.sessions(),
    ]);
    return buildStackView(s, { layers, revs, findings, dispatches, decisions }, { sessions, natives: this.native.get(s.repoRoot)?.stacks ?? [], methods: this.methods.get(s.repoRoot) ?? ['merge'], syncing: this.syncs.has(id) });
  }

  async update(id: string, patch: { title?: string; planPath?: string | null; mergeMethod?: string; order?: number[]; ownerUid?: string | null; originUid?: string | null; state?: string }): Promise<StackView> {
    const s = await this.stack(id);
    const data: Partial<ReviewStack> = {};
    if (patch.title !== undefined) {
      if (!patch.title.trim()) throw new ReviewError(400, 'title required');
      data.title = patch.title.trim().slice(0, 120);
    }
    if (patch.mergeMethod !== undefined) {
      if (!['merge', 'squash', 'rebase'].includes(patch.mergeMethod)) throw new ReviewError(400, 'merge method must be merge, squash or rebase');
      data.mergeMethod = patch.mergeMethod;
    }
    if (patch.state !== undefined) {
      if (!['open', 'done', 'archived'].includes(patch.state)) throw new ReviewError(400, 'invalid state');
      data.state = patch.state;
    }
    if (patch.planPath !== undefined) {
      if (patch.planPath) {
        const text = await this.deps.readPlan(patch.planPath).catch((err) => {
          throw new ReviewError(400, `can't read the plan: ${(err as Error).message}`);
        });
        data.planPath = patch.planPath;
        // A stack still named after its bottom PR takes the plan's own title.
        const root = await this.db.reviewLayer.findFirst({ where: { stackId: id }, orderBy: { position: 'asc' } });
        const h1 = text.match(/^#\s+(.+)$/m)?.[1].replace(/\s*[:\-–—]\s*(?:current\s+)?(?:feature\s+)?plan$/i, '').trim();
        if (h1 && patch.title === undefined && (!root || s.title === root.title)) data.title = h1.slice(0, 120);
        // The plan's owner table labels the layers it names (H0, F1…); labels you set stay.
        const roles = planRoles(text);
        for (const l of await this.db.reviewLayer.findMany({ where: { stackId: id } })) {
          const role = roles.get(l.pr);
          if (role && !l.role) await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr: l.pr } }, data: { role } });
        }
      } else data.planPath = null;
    }
    if (patch.ownerUid !== undefined) {
      if (patch.ownerUid) {
        const sess = (await this.deps.sessions()).find((x) => x.uid === patch.ownerUid);
        if (!sess) throw new ReviewError(404, 'session not found');
        data.ownerUid = sess.uid;
        data.ownerKey = sess.key;
      } else {
        data.ownerUid = null;
        data.ownerKey = null;
      }
    }
    if (patch.originUid !== undefined) {
      if (patch.originUid) {
        const sess = (await this.deps.sessions()).find((x) => x.uid === patch.originUid);
        if (!sess) throw new ReviewError(404, 'session not found');
        data.originUid = sess.uid;
        data.originKey = sess.key;
      } else {
        data.originUid = null;
        data.originKey = null;
      }
    }
    if (patch.order !== undefined) {
      const layers = await this.db.reviewLayer.findMany({ where: { stackId: id } });
      const nodes = layers.map((l) => ({ number: l.pr, headRefName: l.headRef, baseRefName: l.baseRef }));
      if (!validOrder(nodes, patch.order)) throw new ReviewError(400, 'every layer once, each after the one it sits on');
      await this.db.$transaction(patch.order.map((pr, i) => this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { position: i } })));
    }
    if (Object.keys(data).length) await this.db.reviewStack.update({ where: { id: s.id }, data });
    await this.refreshState();
    return this.view(id);
  }

  async remove(id: string): Promise<void> {
    const s = await this.stack(id);
    await this.db.$transaction([
      this.db.reviewLayer.deleteMany({ where: { stackId: id } }),
      this.db.reviewRevision.deleteMany({ where: { stackId: id } }),
      this.db.reviewFinding.deleteMany({ where: { stackId: id } }),
      this.db.reviewDispatch.deleteMany({ where: { stackId: id } }),
      this.db.reviewDecision.deleteMany({ where: { stackId: id } }),
      this.db.chatMessage.deleteMany({ where: { uid: { startsWith: `review:${id}` } } }),
      this.db.reviewStack.delete({ where: { id } }),
    ]);
    await unpinStack(s.repoRoot, id).catch(() => {});
    await this.refreshState();
  }

  async setLayer(id: string, pr: number, patch: { role?: string; skipped?: boolean; ownerUid?: string | null }): Promise<StackView> {
    const l = await this.layer(id, pr);
    const data: Partial<ReviewLayer> = {};
    if (patch.role !== undefined) data.role = patch.role.trim().slice(0, 16);
    if (patch.skipped !== undefined) {
      if (l.state !== 'open' && l.state !== 'skipped') throw new ReviewError(409, `#${pr} is ${l.state}`);
      data.state = patch.skipped ? 'skipped' : 'open';
    }
    if (patch.ownerUid !== undefined) {
      if (patch.ownerUid) {
        const sess = (await this.deps.sessions()).find((x) => x.uid === patch.ownerUid);
        if (!sess) throw new ReviewError(404, 'session not found');
        data.ownerUid = sess.uid;
        data.ownerKey = sess.key;
      } else {
        data.ownerUid = null;
        data.ownerKey = null;
      }
    }
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data });
    await this.refreshState();
    return this.view(id);
  }

  // ---------- sync with GitHub and git

  private async gh<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GhError) throw new ReviewError(502, err.message);
      throw err;
    }
  }

  /** Refresh one stack from GitHub and fetch its revisions. One at a time per stack. */
  sync(id: string, force = false): Promise<void> {
    const running = this.syncs.get(id);
    if (running) return running;
    const task = this.doSync(id, force).finally(() => this.syncs.delete(id));
    this.syncs.set(id, task);
    return task;
  }

  private async doSync(id: string, _force: boolean): Promise<void> {
    const s = await this.stack(id);
    try {
      const all = await listPrs(s.repoRoot, 'all', 200);
      let layers = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
      const byNumber = new Map(all.map((p) => [p.number, p]));
      for (const l of layers) if (!byNumber.has(l.pr)) {
        const p = await viewPr(s.repoRoot, l.pr);
        if (p) byNumber.set(p.number, p);
      }
      // New PRs stacked on an open layer join the stack, right after their parent's line; a stack you picked stays as picked.
      const heads = new Map(s.source !== 'tree' ? [] : layers.filter((l) => l.state === 'open').map((l) => [l.headRef, l]));
      // Joining checks and claims in one step, per repository: two stacks never take one PR.
      let elsewhere = new Set<number>();
      await this.claiming(s.repoRoot, async () => {
        const others = await this.db.reviewLayer.findMany({ where: { pr: { in: all.map((p) => p.number) }, stackId: { not: id } }, select: { pr: true } });
        elsewhere = new Set(others.map((o) => o.pr));
        for (const p of all) {
          if (p.state !== 'OPEN' || p.crossRepo || elsewhere.has(p.number) || layers.some((l) => l.pr === p.number)) continue;
          const parent = heads.get(p.baseRefName);
          if (!parent) continue;
          const nodes = layers.map((l) => ({ number: l.pr, headRefName: l.headRef, baseRefName: l.baseRef }));
          const order = layers.map((l) => l.pr);
          const tail = [parent.pr, ...descendants(nodes, parent.pr, order)];
          const at = Math.max(...tail.map((n) => order.indexOf(n))) + 1;
          await this.db.$transaction([
            ...layers.filter((l) => l.position >= at).map((l) => this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr: l.pr } }, data: { position: l.position + 1 } })),
            this.db.reviewLayer.create({ data: { stackId: id, pr: p.number, position: at, title: p.title, url: p.url, headRef: p.headRefName, baseRef: p.baseRefName, headSha: p.headRefOid, draft: p.isDraft, author: p.author } }),
          ]);
          layers = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
          heads.set(p.headRefName, layers.find((l) => l.pr === p.number)!);
        }
      });
      const natives = await this.nativeStacks(s.repoRoot, s.repo, _force);
      if (natives && s.source === 'native') layers = await this.follow(s, natives, layers, all, elsewhere);
      // GitHub's view of each layer.
      for (const l of layers) {
        const p = byNumber.get(l.pr);
        if (!p) continue;
        this.bodies.set(`${id}:${l.pr}`, p.body);
        const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : l.state === 'skipped' ? 'skipped' : 'open';
        await this.db.reviewLayer.updateMany({
          where: { stackId: id, pr: l.pr },
          data: { state, title: p.title, url: p.url, author: p.author, headRef: p.headRefName, baseRef: p.baseRefName, headSha: p.headRefOid, draft: p.isDraft, mergeable: p.mergeable, checksJson: JSON.stringify(p.checks) },
        });
      }
      // GitHub's own stacks: which layers GitHub merges together, from the bottom up.
      if (natives) {
        const at = new Map<number, { stack: number; pos: number }>();
        for (const ns of natives) ns.prs.forEach((p, i) => at.set(p.number, { stack: ns.number, pos: i + 1 }));
        for (const l of layers) {
          const w = at.get(l.pr) ?? null;
          if ((w?.stack ?? null) !== l.ghStack || (w?.pos ?? null) !== l.ghPos) await this.db.reviewLayer.updateMany({ where: { stackId: id, pr: l.pr }, data: { ghStack: w?.stack ?? null, ghPos: w?.pos ?? null } });
        }
      }
      layers = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
      const open = layers.filter((l) => l.state === 'open' || l.state === 'skipped');
      const mergedAt = layers.filter((l) => l.state === 'merged').map((l) => Math.floor(Date.parse(byNumber.get(l.pr)?.mergedAt ?? '') / 1000) || 0);
      const settling = now() - Math.max(this.settle.get(id) ?? 0, ...mergedAt) < SETTLE_S;
      const remote = await remoteFor(s.repoRoot, s.repo);
      const branches = [...new Set([s.trunk, ...open.map((l) => l.baseRef)])];
      await fetchStack(s.repoRoot, remote, id, open.map((l) => l.pr), branches);
      const mergedHeads = new Set(layers.filter((l) => l.state === 'merged').map((l) => l.headRef));
      for (const l of open) {
        const head = (await resolve(s.repoRoot, prRef(id, l.pr))) ?? (validSha(l.headSha) ? await resolve(s.repoRoot, l.headSha) : null);
        const baseTip = await resolve(s.repoRoot, branchRef(id, l.baseRef));
        const native = l.ghStack !== null;
        let needs = '';
        if (this.mergingOf(id, l.pr)) needs = 'merging';
        else if (l.needs === 'queued' && (await inMergeQueue(s.repoRoot, s.repo, l.pr)) !== false) needs = 'queued';
        // GitHub retargets what's left of its own stacks after a merge.
        else if (mergedHeads.has(l.baseRef)) needs = native ? '' : 'retarget';
        else if (l.mergeable === 'CONFLICTING') needs = 'conflict';
        else if (!native && l.needs === 'restack') needs = 'restack';
        if (!head || !baseTip) {
          await this.db.reviewLayer.updateMany({ where: { stackId: id, pr: l.pr }, data: { needs } });
          continue;
        }
        const base = (await mergeBase(s.repoRoot, baseTip, head)) ?? baseTip;
        // GitHub merges its stacks only when each branch sits on the one under it.
        if (native && !needs && !settling && l.baseRef !== s.trunk && base !== baseTip) needs = 'restack';
        let rev = await this.db.reviewRevision.findUnique({ where: { stackId_pr_baseSha_headSha: { stackId: id, pr: l.pr, baseSha: base, headSha: head } } });
        const fresh = !rev;
        if (!rev) {
          const [pid, st] = await Promise.all([patchId(s.repoRoot, base, head), diffStat(s.repoRoot, base, head)]);
          // The same patch on new commits keeps the summary it had.
          const prior = await this.db.reviewRevision.findFirst({ where: { stackId: id, pr: l.pr, patchId: pid, summary: { not: null } }, orderBy: { id: 'desc' } });
          rev = await this.db.reviewRevision.create({
            data: { stackId: id, pr: l.pr, baseSha: base, headSha: head, patchId: pid, files: st.files, additions: st.additions, deletions: st.deletions, summary: prior?.summary ?? null, summaryAt: prior?.summaryAt ?? null, createdAt: now() },
          });
          await pin(s.repoRoot, id, rev.id, head);
        }
        // A restack is done once the layer no longer repeats a merged parent: its patch is its own again.
        const done = !native && needs === 'restack' && l.reviewedRevId && fresh ? (await this.db.reviewRevision.findUnique({ where: { id: l.reviewedRevId } }))?.patchId === rev.patchId : false;
        await this.db.reviewLayer.updateMany({ where: { stackId: id, pr: l.pr }, data: { currentRevId: rev.id, baseSha: base, needs: done ? '' : needs } });
        if (fresh && l.reviewedRevId) {
          const reviewed = await this.db.reviewRevision.findUnique({ where: { id: l.reviewedRevId } });
          if (reviewed && reviewed.patchId !== rev.patchId) void this.recheck(id, l.pr).catch((err) => console.error(`review recheck #${l.pr}:`, err));
        }
      }
      const finished = layers.every((l) => l.state !== 'open');
      await this.db.reviewStack.update({ where: { id }, data: { syncedAt: now(), syncError: null, ...(finished && s.state === 'open' ? { state: 'done' } : {}) } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.db.reviewStack.update({ where: { id }, data: { syncedAt: now(), syncError: msg.slice(0, 300) } });
      throw err instanceof GhError ? new ReviewError(502, msg) : err;
    } finally {
      await this.refreshState();
    }
  }

  /**
   * A stack that follows one on GitHub: PRs added there join here, each right
   * above the PR under it in GitHub's order. One GitHub dissolved stops being
   * followed, and keeps its layers.
   */
  private async follow(s: ReviewStack, natives: NativeStack[], layers: ReviewLayer[], all: GhPr[], elsewhere: Set<number>): Promise<ReviewLayer[]> {
    const ns = natives.find((n) => n.number === s.ghStack);
    if (!ns) {
      await this.db.reviewStack.update({ where: { id: s.id }, data: { source: 'manual', ghStack: null } });
      return layers;
    }
    const byNumber = new Map(all.map((p) => [p.number, p]));
    for (const [i, np] of ns.prs.entries()) {
      const p = byNumber.get(np.number);
      if (!p || p.state !== 'OPEN' || p.crossRepo || elsewhere.has(p.number) || layers.some((l) => l.pr === p.number)) continue;
      const below = new Set(ns.prs.slice(0, i).map((x) => x.number));
      const at = Math.max(-1, ...layers.filter((l) => below.has(l.pr)).map((l) => l.position)) + 1;
      await this.db.$transaction([
        ...layers.filter((l) => l.position >= at).map((l) => this.db.reviewLayer.update({ where: { stackId_pr: { stackId: s.id, pr: l.pr } }, data: { position: l.position + 1 } })),
        this.db.reviewLayer.create({ data: this.layerRow(s.id, p, at) }),
      ]);
      layers = await this.db.reviewLayer.findMany({ where: { stackId: s.id }, orderBy: { position: 'asc' } });
    }
    return layers;
  }

  // ---------- one layer

  async layerDiff(id: string, pr: number, mode: 'this' | 'since' | 'cumulative'): Promise<{ kind: 'patch' | 'range'; text: string; truncated: boolean; from: string; to: string }> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    const cur = l.currentRevId ? await this.db.reviewRevision.findUnique({ where: { id: l.currentRevId } }) : null;
    if (!cur) throw new ReviewError(409, `#${pr} has not been fetched yet`);
    if (mode === 'this') {
      const d = await diff(s.repoRoot, cur.baseSha, cur.headSha);
      return { kind: 'patch', text: d.patch, truncated: d.truncated, from: cur.baseSha, to: cur.headSha };
    }
    if (mode === 'cumulative') {
      const tip = await resolve(s.repoRoot, branchRef(id, s.trunk));
      const from = tip ? await mergeBase(s.repoRoot, tip, cur.headSha) : null;
      if (!from) throw new ReviewError(409, `${s.trunk} is not available locally`);
      const d = await diff(s.repoRoot, from, cur.headSha);
      return { kind: 'patch', text: d.patch, truncated: d.truncated, from, to: cur.headSha };
    }
    const rev = l.reviewedRevId ? await this.db.reviewRevision.findUnique({ where: { id: l.reviewedRevId } }) : null;
    if (!rev) throw new ReviewError(409, 'not reviewed yet');
    if (rev.headSha === cur.headSha && rev.baseSha === cur.baseSha) return { kind: 'patch', text: '', truncated: false, from: rev.headSha, to: cur.headSha };
    const d = await sinceReview(s.repoRoot, { base: rev.baseSha, head: rev.headSha }, { base: cur.baseSha, head: cur.headSha });
    return { ...d, from: rev.headSha, to: cur.headSha };
  }

  /** Mark the current revision reviewed: the checkpoint "since review" diffs from, and a merge gate. */
  async approve(id: string, pr: number, approved = true, head?: string): Promise<StackView> {
    const l = await this.layer(id, pr);
    if (!l.currentRevId) throw new ReviewError(409, `#${pr} has not been fetched yet`);
    if (approved && head) {
      const cur = await this.db.reviewRevision.findUnique({ where: { id: l.currentRevId } });
      if (cur && cur.headSha !== head) {
        throw new ReviewError(409, `#${pr} moved on (${cur.headSha.slice(0, 7)}) — refresh and review it first`);
      }
    }
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: approved ? { approved: true, reviewedRevId: l.currentRevId } : { approved: false } });
    await this.refreshState();
    return this.view(id);
  }

  // ---------- findings

  async findings(id: string, pr?: number): Promise<FindingView[]> {
    const rows = await this.db.reviewFinding.findMany({ where: { stackId: id, ...(pr === undefined ? {} : { OR: [{ ownerPr: pr }, { foundOnPr: pr }] }) }, orderBy: { id: 'asc' } });
    const revs = await this.db.reviewRevision.findMany({ where: { id: { in: rows.map((f) => f.stateRevId).filter((x): x is number => x !== null) } }, select: { id: true, headSha: true } });
    const heads = new Map(revs.map((r) => [r.id, r.headSha.slice(0, 7)]));
    return rows.map((f) => findingView(f, heads));
  }

  async addFinding(
    id: string,
    input: { ownerPr: number; foundOnPr?: number; title: string; body?: string; severity?: string; path?: string | null; lineStart?: number | null; lineEnd?: number | null; source?: string; state?: string; messageId?: number | null },
  ): Promise<FindingView> {
    await this.layer(id, input.ownerPr);
    const title = input.title.trim();
    if (!title) throw new ReviewError(400, 'title required');
    const l = await this.layer(id, input.foundOnPr ?? input.ownerPr);
    const f = await this.db.reviewFinding.create({
      data: {
        stackId: id,
        ownerPr: input.ownerPr,
        foundOnPr: l.pr,
        revisionId: l.currentRevId,
        messageId: input.messageId ?? null,
        title: title.slice(0, 140),
        body: (input.body ?? '').slice(0, 4000),
        severity: ['blocking', 'should', 'nit'].includes(input.severity ?? '') ? input.severity! : 'should',
        path: input.path ?? null,
        lineStart: input.lineStart ?? null,
        lineEnd: input.lineEnd ?? input.lineStart ?? null,
        source: input.source ?? 'you',
        state: input.state ?? 'open',
        stateBy: input.source === 'reviewer' ? 'reviewer' : 'you',
        stateRevId: l.currentRevId,
        createdAt: now(),
        updatedAt: now(),
      },
    });
    await this.refreshState();
    return findingView(f);
  }

  async updateFinding(id: string, fid: number, patch: { state?: string; severity?: string; title?: string; body?: string; ownerPr?: number; note?: string | null }): Promise<FindingView> {
    const f = await this.db.reviewFinding.findFirst({ where: { id: fid, stackId: id } });
    if (!f) throw new ReviewError(404, 'finding not found');
    const data: Partial<ReviewFinding> = { updatedAt: now() };
    if (patch.state !== undefined) {
      if (!['open', 'sent', 'addressed', 'wontfix', 'dismissed'].includes(patch.state)) throw new ReviewError(400, 'invalid state');
      // Waiving a blocking finding lets the layer merge, so it takes a reason, kept on the finding.
      const note = patch.note !== undefined ? patch.note : f.note;
      if (patch.state === 'wontfix' && (patch.severity ?? f.severity) === 'blocking' && !note?.trim()) throw new ReviewError(400, 'say why to waive a blocking finding');
      if (patch.state !== f.state) {
        data.state = patch.state;
        data.stateBy = 'you';
        data.stateRevId = (await this.layer(id, f.ownerPr)).currentRevId;
      }
    }
    if (patch.severity !== undefined) {
      if (!['blocking', 'should', 'nit'].includes(patch.severity)) throw new ReviewError(400, 'invalid severity');
      data.severity = patch.severity;
    }
    if (patch.title !== undefined) data.title = patch.title.trim().slice(0, 140) || f.title;
    if (patch.body !== undefined) data.body = patch.body.slice(0, 4000);
    if (patch.note !== undefined) data.note = patch.note ? patch.note.slice(0, 1000) : null;
    if (patch.ownerPr !== undefined) {
      await this.layer(id, patch.ownerPr);
      data.ownerPr = patch.ownerPr;
    }
    const out = await this.db.reviewFinding.update({ where: { id: fid }, data });
    await this.refreshState();
    return findingView(out);
  }

  async deleteFinding(id: string, fid: number): Promise<void> {
    const f = await this.db.reviewFinding.findFirst({ where: { id: fid, stackId: id } });
    if (!f) throw new ReviewError(404, 'finding not found');
    await this.db.reviewFinding.delete({ where: { id: fid } });
    await this.refreshState();
  }

  /** GitHub review threads on a layer become findings (once each); resolved ones arrive addressed. */
  async importThreads(id: string, pr: number): Promise<{ added: number }> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    const threads = await reviewThreads(s.repoRoot, s.repo, pr);
    const known = new Set((await this.db.reviewFinding.findMany({ where: { stackId: id, ghThread: { not: null } }, select: { ghThread: true } })).map((f) => f.ghThread));
    let added = 0;
    for (const t of threads) {
      if (known.has(t.id) || !t.comments.length) continue;
      const first = t.comments[0];
      const bot = /\[bot\]$|^chatgpt-codex-connector|^coderabbit/i.test(first.author);
      const { title, text, level, markdown } = threadTitle(first.body);
      // GitHub's markdown as written (the page renders it as GitHub does); each reply under a marker
      // naming who wrote it and when, so it reads as its own comment.
      const replies = t.comments.slice(1).map((c) => `${replyMark(c.author, c.at)}\n${c.body.replace(/<!--[\s\S]*?-->/g, '').trim()}`).join('\n\n');
      await this.db.reviewFinding.create({
        data: {
          stackId: id,
          ownerPr: pr,
          foundOnPr: pr,
          revisionId: l.currentRevId,
          title,
          body: `${markdown}${replies ? `\n\n${replies}` : ''}`.slice(0, 12000),
          severity: level ?? (/critical|blocking/i.test(text.slice(0, 200)) ? 'blocking' : 'should'),
          path: t.path,
          lineStart: t.startLine ?? t.line,
          lineEnd: t.line,
          source: `${bot ? 'bot' : 'gh'}:${first.author}`,
          ghThread: t.id,
          ghUrl: first.url || null,
          state: t.resolved ? 'addressed' : 'open',
          stateBy: 'github',
          stateRevId: l.currentRevId,
          createdAt: now(),
          updatedAt: now(),
        },
      });
      added++;
    }
    if (added) await this.refreshState();
    return { added };
  }

  /** Close the GitHub thread behind a finding: optional reply, then resolve. */
  async resolveThread(id: string, fid: number, body: string): Promise<FindingView> {
    const s = await this.stack(id);
    const f = await this.db.reviewFinding.findFirst({ where: { id: fid, stackId: id } });
    if (!f?.ghThread) throw new ReviewError(404, 'this finding has no GitHub thread');
    await this.gh(() => replyAndResolve(s.repoRoot, f.ghThread!, body));
    const out = await this.db.reviewFinding.update({ where: { id: fid }, data: { note: f.note ?? (body.trim() || null), updatedAt: now(), ...(OPEN_FINDING.includes(f.state) ? { state: 'addressed', stateBy: 'you', stateRevId: (await this.layer(id, f.ownerPr)).currentRevId } : {}) } });
    await this.refreshState();
    return findingView(out);
  }

  // ---------- decisions

  async addDecision(id: string, text: string, fromPr: number | null): Promise<StackView> {
    await this.stack(id);
    const t = text.trim();
    if (!t) throw new ReviewError(400, 'text required');
    await this.db.reviewDecision.create({ data: { stackId: id, text: t.slice(0, 500), fromPr, at: now() } });
    return this.view(id);
  }

  async removeDecision(id: string, did: number): Promise<StackView> {
    await this.db.reviewDecision.deleteMany({ where: { id: did, stackId: id } });
    return this.view(id);
  }

  // ---------- owner and dispatch

  /** Sessions that could own the stack, best first: on one of its branches, then in its repo. */
  async ownerSuggestions(id: string): Promise<(SessionLite & { reason: 'branch' | 'repo'; origin: boolean })[]> {
    const s = await this.stack(id);
    const made = (x: SessionLite) => !!((s.originKey && x.key === s.originKey) || (s.originUid && x.uid === s.originUid));
    const heads = new Set((await this.db.reviewLayer.findMany({ where: { stackId: id }, select: { headRef: true } })).map((l) => l.headRef));
    const out: (SessionLite & { reason: 'branch' | 'repo'; origin: boolean })[] = [];
    for (const sess of await this.deps.sessions()) {
      if (!sess.agent) continue;
      const root = sess.cwd ? await this.mainOf(sess.cwd) : null;
      // The session that made the stack counts even after it ended, or when it works elsewhere now.
      if (root !== s.repoRoot && !made(sess)) continue;
      out.push({ ...sess, reason: sess.branch && heads.has(sess.branch) ? 'branch' : 'repo', origin: made(sess) });
    }
    // The maker first (its live run before an ended one), then sessions on the stack's branches, then the rest of the repo.
    return out
      .filter((x, _, all) => !x.origin || x.live || !all.some((y) => y.origin && y.live))
      .sort((a, b) => Number(b.origin) - Number(a.origin) || (a.reason === b.reason ? Number(b.live) - Number(a.live) : a.reason === 'branch' ? -1 : 1));
  }

  /** Who a layer's findings go to: its own owner, else the stack's owner, else the session that made it. Follows the conversation across resumes. */
  private async target(s: ReviewStack, l: ReviewLayer): Promise<SessionLite | null> {
    const key = l.ownerKey ?? s.ownerKey ?? s.originKey;
    const uid = l.ownerUid ?? s.ownerUid ?? s.originUid;
    if (!key && !uid) return null;
    return resolveSession(await this.deps.sessions(), key, uid);
  }

  /** The message for the agent: findings with locations, the plan's constraints, and the restack of the layers above. */
  async dispatchText(id: string, pr: number, findingIds: number[], extra = '', fresh = false): Promise<string> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    const layers = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
    const picked = findingIds.length ? await this.db.reviewFinding.findMany({ where: { stackId: id, id: { in: findingIds } }, orderBy: { id: 'asc' } }) : [];
    const decisions = await this.db.reviewDecision.findMany({ where: { stackId: id }, orderBy: { id: 'asc' } });
    const short = l.headSha.slice(0, 8);
    const lines: string[] = [];
    // A session started for this knows nothing yet: where it is, how to push, and why the stack exists.
    if (fresh) {
      lines.push(
        `You're a new session, started to fix a pull request in ${s.repo}, in a fresh worktree at ${l.headRef}'s head (${short}) on a branch of its own. When you've fixed it, push it to ${l.headRef}: git push --force-with-lease origin HEAD:${l.headRef}. If git says a stack branch is checked out in another worktree, work on a detached HEAD of origin/<branch> and push the same way.`,
      );
      const why = await this.originText(s, null).catch(() => null);
      if (why) lines.push('', 'The stack was made in another session. Background, from that conversation:', why.split('\n').slice(0, 30).join('\n').slice(0, 4000));
      lines.push('');
    }
    lines.push(`Review of ${label(l)} "${l.title}" (branch ${l.headRef}) at ${short}.${picked.length ? ' Please fix:' : ''}`, '');
    picked.forEach((f, i) => {
      const where = f.path ? ` ${f.path}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ''}` : ''}` : '';
      const from = f.ownerPr !== pr ? layers.find((x) => x.pr === f.ownerPr) : undefined;
      lines.push(`${i + 1}. [${f.severity}] ${f.title.replace(/[.!?:;]+$/, '')}.${where}${from ? ` (Found on ${label(from)}, already merged: fix it in this layer.)` : ''}`);
      const body = f.body.split(/\n---\n|<!-- ah:reply /)[0].trim(); // the comment, not its replies
      if (body) lines.push(...body.split('\n').slice(0, 12).map((x) => `   ${x}`));
      if (f.ghUrl) lines.push(`   (GitHub thread: ${f.ghUrl})`);
    });
    if (extra.trim()) lines.push(...(picked.length ? [''] : []), extra.trim());
    const rules: string[] = [];
    if (decisions.length) rules.push(...decisions.map((d) => `- ${d.text}`));
    rules.push(`- Keep the change within ${l.role || `#${l.pr}`}; check out ${l.headRef} first if you're on another branch.`);
    const nodes = layers.map((x) => ({ number: x.pr, headRefName: x.headRef, baseRefName: x.baseRef }));
    const above = descendants(nodes, pr, layers.map((x) => x.pr))
      .map((n) => layers.find((x) => x.pr === n)!)
      .filter((x) => x.state === 'open');
    lines.push('', 'Constraints:', ...rules);
    // A GitHub stack is restacked with gh stack, when this host has it; anything else above, by hand.
    // A new session's worktree can't check out branches another checkout has, so it goes by hand too.
    const tool = !fresh && l.ghStack !== null && (await this.ghStackHere(s.repoRoot));
    const stacked = tool ? above.filter((x) => x.ghStack === l.ghStack) : [];
    const rest = above.filter((x) => !stacked.includes(x));
    if (tool) {
      lines.push(
        '',
        `Commit on ${l.headRef}, then push with gh stack: gh stack rebase --upstack, then gh stack push${stacked.length ? `, which restacks ${stacked.map((x) => label(x)).join(', ')} on it` : ''}. It's GitHub stack #${l.ghStack}; if this checkout doesn't track it, run gh stack checkout ${l.pr} first.`,
      );
    } else lines.push('', `Commit and push ${l.headRef}.`);
    if (rest.length) {
      lines.push(
        `Then restack the layers above it${stacked.length ? ' that are outside the GitHub stack' : ''}, in this order, pushing each with --force-with-lease against the head shown: ${rest.map((x) => `${x.headRef} (${label(x)}, ${x.headSha.slice(0, 8)}) on ${x.baseRef}`).join('; ')}.`,
      );
    }
    lines.push('Reply with the new heads.', `(ah review ${s.id}/${pr})`);
    return lines.join('\n');
  }

  async dispatch(
    id: string,
    pr: number,
    input: {
      findingIds: number[];
      text?: string;
      targetUid?: string;
      newSession?: { preset: string };
      kind?: 'fix' | 'merge';
      comment?: { title: string; body?: string; severity?: string; path?: string | null; lineStart?: number | null; lineEnd?: number | null };
    },
  ): Promise<{ dispatch: DispatchView; outcome: string; finding?: FindingView }> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    let createdFinding: FindingView | undefined;
    const findingIds = [...input.findingIds];
    if (input.comment) {
      createdFinding = await this.addFinding(id, {
        ownerPr: pr,
        foundOnPr: pr,
        title: input.comment.title,
        body: input.comment.body,
        severity: input.comment.severity,
        path: input.comment.path ?? null,
        lineStart: input.comment.lineStart ?? null,
        lineEnd: input.comment.lineEnd ?? input.comment.lineStart ?? null,
      });
      findingIds.push(createdFinding.id);
    }
    const text = (input.text?.trim() || (findingIds.length ? await this.dispatchText(id, pr, findingIds, '', !!input.newSession) : '')).trim();
    if (!text) throw new ReviewError(400, 'text required');
    let target: SessionLite | null = null;
    if (input.newSession) {
      // A new agent session for this layer's fixes: they go to it from now on, through the normal send path.
      if (!validSha(l.headSha)) throw new ReviewError(409, `#${pr} has not been fetched yet`);
      target = await this.deps.launch({ preset: input.newSession.preset, root: s.repoRoot, label: `Fix ${label(l)}`, fromRef: l.headSha }).catch((err) => {
        throw new ReviewError(502, `couldn't start the session: ${(err as Error).message}`);
      });
      if (!s.ownerKey) await this.db.reviewStack.update({ where: { id }, data: { ownerUid: target.uid, ownerKey: target.key } });
      else await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { ownerUid: target.uid, ownerKey: target.key } });
    } else if (input.targetUid) {
      target = (await this.deps.sessions()).find((x) => x.uid === input.targetUid) ?? null;
      if (!target) throw new ReviewError(404, 'session not found');
      // The first send binds the stack to that conversation.
      if (!s.ownerKey && !l.ownerKey) await this.db.reviewStack.update({ where: { id }, data: { ownerUid: target.uid, ownerKey: target.key } });
    } else target = await this.target(s, l);
    if (!target) {
      if (createdFinding) await this.db.reviewFinding.delete({ where: { id: createdFinding.id } }).catch(() => {});
      throw new ReviewError(409, 'choose the session that owns this stack first');
    }
    // The record first, then the message, named after it: a dispatch that reached the
    // agent is never unrecorded (and so never sent twice by a retry), and one that
    // fails to go out leaves nothing behind.
    let d = await this.db.reviewDispatch.create({
      data: { stackId: id, pr, kind: input.kind ?? 'fix', targetUid: target.uid, targetKey: target.key, text, fromRevId: l.currentRevId, fromHead: l.headSha, queueId: null, sentAt: now() },
    });
    let sent: { outcome: string; queueId?: string };
    try {
      sent = await this.deps.send(target.uid, text, `rd-${d.id}`);
    } catch (err) {
      // Refused, or nothing typed: nothing went out, so no dispatch. Some of it landed
      // (a paste that failed half way): the agent has it, so the record stays.
      const typed = (err as { typed?: unknown }).typed === true;
      if (!typed) {
        await this.db.reviewDispatch.delete({ where: { id: d.id } }).catch(() => {});
        if (createdFinding) await this.db.reviewFinding.delete({ where: { id: createdFinding.id } }).catch(() => {});
      }
      throw err;
    }
    if (sent.queueId) d = await this.db.reviewDispatch.update({ where: { id: d.id }, data: { queueId: sent.queueId } });
    // The revision the findings were written against is the checkpoint the fix is compared with.
    if (input.kind !== 'merge') await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { reviewedRevId: l.currentRevId ?? l.reviewedRevId } });
    if (findingIds.length) {
      // Sent to this layer, they're its to fix: a follow-up from a merged layer moves here.
      await this.db.reviewFinding.updateMany({ where: { stackId: id, id: { in: findingIds } }, data: { state: 'sent', ownerPr: pr, dispatchId: d.id, stateBy: 'you', stateRevId: l.currentRevId, updatedAt: now() } });
    }
    await this.refreshState();
    const v = await this.view(id);
    return { dispatch: v.layers.find((x) => x.pr === pr)!.dispatch!, outcome: sent.outcome, ...(createdFinding ? { finding: createdFinding } : {}) };
  }

  /** Dispatches in flight: did the agent work, finish, and push? Runs every few seconds. */
  private async watch(): Promise<void> {
    if (this.merging.size) await this.watchMerges();
    const active = await this.db.reviewDispatch.findMany({ where: { state: { in: ACTIVE_DISPATCH } } });
    const due = now() - this.lastPoll > (active.length ? 60 : 300);
    if (active.length) {
      const sessions = await this.deps.sessions();
      const ended = new Set<string>();
      const checkFast = new Set<string>();
      for (const d of active) {
        const sess = sessions.find((x) => x.key === d.targetKey && x.live) ?? sessions.find((x) => x.uid === d.targetUid);
        const working = !!sess?.live && (sess.status === 'busy' || sess.status === 'waiting');
        if (working && !d.sawWork) await this.db.reviewDispatch.update({ where: { id: d.id }, data: { sawWork: true, state: 'working' } });
        // A turn that started and stopped, or a session that went away after working, is done.
        if (d.sawWork && !working) ended.add(d.stackId);
        // Fast turn completed between 5s watch ticks: check GitHub head/merge state once idle past a short grace window.
        else if (!d.sawWork && !working && now() - d.sentAt > 30) checkFast.add(d.stackId);
      }
      for (const stackId of ended) {
        await this.sync(stackId).catch(() => {});
        for (const d of active.filter((x) => x.stackId === stackId && x.sawWork)) {
          const l = await this.db.reviewLayer.findUnique({ where: { stackId_pr: { stackId, pr: d.pr } } });
          // A fix is done when the head moved; a merge when the layer landed.
          const pushed = !!l && (d.kind === 'merge' ? l.state === 'merged' : l.headSha !== d.fromHead);
          await this.db.reviewDispatch.update({ where: { id: d.id }, data: { state: pushed ? 'done' : 'no-push', doneAt: now() } });
        }
      }
      let fastChanged = false;
      for (const stackId of checkFast) {
        if (ended.has(stackId)) continue;
        if (due) await this.sync(stackId).catch(() => {});
        for (const d of active.filter((x) => x.stackId === stackId && !x.sawWork)) {
          const l = await this.db.reviewLayer.findUnique({ where: { stackId_pr: { stackId, pr: d.pr } } });
          const pushed = !!l && (d.kind === 'merge' ? l.state === 'merged' : l.headSha !== d.fromHead);
          if (pushed) {
            await this.db.reviewDispatch.update({ where: { id: d.id }, data: { state: 'done', doneAt: now() } });
            fastChanged = true;
          } else if (now() - d.sentAt > 1800) {
            await this.db.reviewDispatch.update({ where: { id: d.id }, data: { state: 'no-push', doneAt: now() } });
            fastChanged = true;
          }
        }
      }
      if (ended.size || fastChanged) await this.refreshState();
    }
    if (due) {
      this.lastPoll = now();
      for (const s of await this.db.reviewStack.findMany({ where: { state: 'open' }, select: { id: true } })) await this.sync(s.id).catch(() => {});
    }
  }

  // ---------- merge & next

  /**
   * Merge one layer: every gate re-checked against a fresh sync, then `gh pr
   * merge --match-head-commit` with the head you reviewed, then the layers that
   * sat on it are pointed at the trunk. Returns the next layer in order.
   */
  async merge(id: string, pr: number, opts: { outOfOrder?: boolean; expectedHead?: string; approveHead?: boolean } = {}): Promise<MergeOutcome> {
    await this.sync(id, true);
    const s = await this.stack(id);
    let v = await this.view(id, { autoSync: false });
    let l = v.layers.find((x) => x.pr === pr);
    if (!l) throw new ReviewError(404, `#${pr} is not in this stack`);
    if (l.state !== 'open') throw new ReviewError(409, `#${pr} is ${l.state}`);
    const head = l.current?.headSha ?? l.headSha;
    if (opts.expectedHead && head !== opts.expectedHead) {
      throw new ReviewError(409, `a new commit landed on #${pr} (${head.slice(0, 7)}) — refresh and review it first`);
    }
    if (opts.approveHead) {
      if (!opts.expectedHead || head !== opts.expectedHead) throw new ReviewError(400, 'approveHead requires matching expectedHead');
      if (!l.current) throw new ReviewError(409, `#${pr} has not been fetched yet`);
      const nonReviewFailing = l.gates.filter((g) => !g.ok && g.key !== 'reviewed' && !(g.key === 'order' && opts.outOfOrder));
      if (nonReviewFailing.length) throw new ReviewError(409, `${nonReviewFailing[0].label}: ${nonReviewFailing[0].detail ?? 'not yet'}`);
      await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { approved: true, reviewedRevId: l.current.id } });
      v = await this.view(id, { autoSync: false });
      l = v.layers.find((x) => x.pr === pr)!;
    }
    const failing = l.gates.filter((g) => !g.ok && !(g.key === 'order' && opts.outOfOrder));
    if (failing.length) throw new ReviewError(409, `${failing[0].label}: ${failing[0].detail ?? 'not yet'}`);
    const reviewedHead = l.current!.headSha;
    if (!/^[0-9a-f]{40}$/.test(reviewedHead)) throw new ReviewError(409, 'the reviewed head is unknown');
    if (l.ghStack !== null) return this.mergeNative(s, v, l, reviewedHead);
    await this.gh(() => mergePr(s.repoRoot, pr, s.mergeMethod as MergeMethod, reviewedHead));
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { state: 'merged' } });
    const { retargeted, restack } = await this.retargetOnto(s, v.layers.filter((x) => x.state === 'open' && x.baseRef === l.headRef));
    await this.sync(id, true).catch(() => {});
    const after = await this.view(id);
    return { next: after.next, retargeted, restack, merged: [pr], waiting: null };
  }

  /** Reject and close a layer's PR on GitHub, with an optional comment. Optionally removes the stack if no open layers remain. */
  async closeLayer(id: string, pr: number, opts: { comment?: string; removeIfDone?: boolean } = {}): Promise<{ stack: StackView | null; removed: boolean }> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    if (l.state === 'merged') throw new ReviewError(409, `#${pr} is already merged`);
    if (l.state !== 'closed') {
      await this.gh(() => closePr(s.repoRoot, pr, opts.comment));
      await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { state: 'closed', needs: '' } });
    }
    await this.db.reviewDispatch.updateMany({ where: { stackId: id, pr, state: { in: ACTIVE_DISPATCH } }, data: { state: 'done', doneAt: now() } });
    const remaining = await this.db.reviewLayer.count({ where: { stackId: id, state: 'open' } });
    if (remaining === 0) {
      if (opts.removeIfDone) {
        await this.remove(id);
        return { stack: null, removed: true };
      }
      await this.db.reviewStack.update({ where: { id }, data: { state: 'done' } });
    }
    await this.refreshState();
    return { stack: await this.view(id, { autoSync: false }), removed: false };
  }

  /**
   * Merge the stack, bottom up, up to a layer (all of it by default), in as few
   * steps as GitHub allows: a run of layers in one GitHub stack lands through
   * one stack merge of its top, any other layer through its own merge, each
   * step re-checked by merge() against a fresh sync. Before the first step
   * every layer must pass its gates, bar merge order, the layers under it and
   * targeting a layer below it (the steps take care of those) and, with
   * markReviewed, your review mark, which it then sets at the current heads.
   * It stops at the first step that fails, that GitHub hasn't finished, or that
   * leaves the next layer to restack (squash or rebase on a chain: ah doesn't
   * rewrite branches).
   */
  async mergeStack(id: string, opts: { method?: string; markReviewed?: boolean; upTo?: number } = {}): Promise<StackMergeOutcome> {
    if (opts.method) await this.update(id, { mergeMethod: opts.method });
    await this.sync(id, true);
    const v = await this.view(id);
    const open = v.layers.filter((l) => l.state === 'open');
    const end = opts.upTo === undefined ? open.length - 1 : open.findIndex((l) => l.pr === opts.upTo);
    if (end < 0) throw new ReviewError(opts.upTo === undefined ? 409 : 404, opts.upTo === undefined ? 'nothing left to merge' : `#${opts.upTo} is not an open layer of this stack`);
    const todo = open.slice(0, end + 1);
    const heads = new Set<string>();
    for (const l of todo) {
      const bad = l.gates.find((g) => !g.ok && g.key !== 'order' && g.key !== 'below' && g.key !== 'reviewed' && !(g.key === 'base' && heads.has(l.baseRef)));
      if (bad) throw new ReviewError(409, `${label(l)}: ${bad.detail ?? bad.label}`);
      if (!opts.markReviewed && l.gates.some((g) => g.key === 'reviewed' && !g.ok)) throw new ReviewError(409, `${label(l)}: not marked reviewed at its current head`);
      heads.add(l.headRef);
    }
    if (opts.markReviewed) for (const l of todo) if (l.gates.some((g) => g.key === 'reviewed' && !g.ok)) await this.approve(id, l.pr, true);
    const out: StackMergeOutcome = { merged: [], restack: [], waiting: null, stopped: null, next: null };
    for (let i = 0; i < todo.length; ) {
      let j = i;
      if (todo[i].ghStack !== null) while (j + 1 < todo.length && todo[j + 1].ghStack === todo[i].ghStack && (todo[j + 1].ghPos ?? 0) > (todo[j].ghPos ?? 0)) j++;
      const moved = todo.slice(i, j + 1).find((x) => out.restack.includes(x.pr));
      if (moved) {
        out.stopped = { pr: moved.pr, why: `it needs a restack onto ${v.trunk} first` };
        break;
      }
      try {
        const step = await this.merge(id, todo[j].pr, { outOfOrder: true });
        out.merged.push(...step.merged);
        out.restack.push(...step.restack);
        if (step.waiting) {
          out.waiting = step.waiting;
          break;
        }
      } catch (err) {
        out.stopped = { pr: todo[j].pr, why: err instanceof Error ? err.message : String(err) };
        break;
      }
      i = j + 1;
    }
    out.next = (await this.view(id)).next;
    return out;
  }

  /**
   * Layers that sat on a merged branch now target the trunk. With a merge commit their
   * patch is unchanged; with squash or rebase they repeat the parent's commits until restacked.
   */
  private async retargetOnto(s: ReviewStack, children: LayerView[]): Promise<{ retargeted: number[]; restack: number[] }> {
    const retargeted: number[] = [];
    const restack: number[] = [];
    for (const c of children) {
      try {
        await retarget(s.repoRoot, c.pr, s.trunk);
        retargeted.push(c.pr);
        if (s.mergeMethod !== 'merge') {
          restack.push(c.pr);
          await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: s.id, pr: c.pr } }, data: { needs: 'restack' } });
        }
      } catch (err) {
        console.error(`retarget #${c.pr}:`, err);
      }
    }
    return { retargeted, restack };
  }

  /**
   * A layer of a GitHub stack lands through GitHub's stack merge, with every
   * unmerged layer under it, all or nothing (the gates held for each of them
   * on the sync just before). GitHub checks the head of the PR asked for, then
   * retargets and rebases what's left itself, so ah doesn't.
   */
  private async mergeNative(s: ReviewStack, v: StackView, l: LayerView, head: string): Promise<MergeOutcome> {
    const prs = [...v.layers.filter((x) => x.ghStack === l.ghStack && x.ghPos! < l.ghPos! && x.state === 'open').map((x) => x.pr), l.pr];
    let r: MergeRequest = await this.gh(() => requestMerge(s.repoRoot, s.repo, l.pr, s.mergeMethod as MergeMethod, head));
    for (const until = Date.now() + this.mergeWait; r.status === 'pending' && r.uuid && Date.now() < until; ) {
      await new Promise((res) => setTimeout(res, MERGE_POLL_MS));
      const uuid = r.uuid;
      r = (await this.gh(() => mergeStatus(s.repoRoot, s.repo, l.pr, uuid))) ?? { ...r, uuid: null };
    }
    this.settle.set(s.id, now());
    let moved = { retargeted: [] as number[], restack: [] as number[] };
    if (r.status === 'merged') {
      await this.db.reviewLayer.updateMany({ where: { stackId: s.id, pr: { in: prs } }, data: { state: 'merged', needs: '' } });
      // GitHub moves the rest of its stack; layers outside it that sat on what landed are ah's to move.
      const heads = new Set(v.layers.filter((x) => prs.includes(x.pr)).map((x) => x.headRef));
      moved = await this.retargetOnto(s, v.layers.filter((x) => x.state === 'open' && !prs.includes(x.pr) && heads.has(x.baseRef) && x.ghStack !== l.ghStack));
    } else {
      if (r.status === 'pending' && r.uuid) this.merging.set(`${s.id}:${l.pr}`, { stackId: s.id, root: s.repoRoot, repo: s.repo, pr: l.pr, prs, uuid: r.uuid });
      await this.db.reviewLayer.updateMany({ where: { stackId: s.id, pr: { in: prs } }, data: { needs: r.status === 'enqueued' ? 'queued' : 'merging' } });
    }
    await this.sync(s.id, true).catch(() => {});
    const after = await this.view(s.id);
    return { next: after.next, ...moved, merged: r.status === 'merged' ? prs : [], waiting: r.status === 'merged' ? null : r.status === 'enqueued' ? 'queue' : 'github' };
  }

  /** Stack merges that outlasted the request: landed, queued, or failed (said in a push). */
  private async watchMerges(): Promise<void> {
    for (const [key, m] of this.merging) {
      let r: MergeRequest | null;
      let failed: string | null = null;
      try {
        r = await mergeStatus(m.root, m.repo, m.pr, m.uuid);
      } catch (err) {
        if (!(err instanceof GhError)) continue;
        r = null;
        failed = err.message;
      }
      if (r?.status === 'pending') continue;
      this.merging.delete(key);
      if (r?.status === 'enqueued') await this.db.reviewLayer.updateMany({ where: { stackId: m.stackId, pr: { in: m.prs } }, data: { needs: 'queued' } });
      if (failed) {
        const st = await this.db.reviewStack.findUnique({ where: { id: m.stackId } });
        this.deps.alert({ title: `#${m.pr} didn't merge`, body: `${st?.title ?? 'Stack review'} · ${failed}`, tag: `review-${m.stackId}-${m.pr}`, url: `/#review/${m.stackId}/${m.pr}` });
      }
      await this.sync(m.stackId, true).catch(() => {});
    }
  }

  /**
   * Make the stack's open PRs a stack on GitHub (or put the rest on top of the
   * one its bottom layers are in). Then GitHub merges them bottom-up and
   * rebases them, and the review follows that stack.
   */
  async link(id: string): Promise<StackView> {
    await this.sync(id, true);
    const s = await this.stack(id);
    const plan = (await this.view(id)).link;
    if (!plan) throw new ReviewError(409, 'its open pull requests are a stack on GitHub already');
    if (!plan.ok) throw new ReviewError(409, plan.why ?? "these pull requests can't be a stack on GitHub");
    const ns = await this.gh(() => linkStack(s.repoRoot, s.repo, plan.prs, plan.onto));
    await this.db.reviewStack.update({ where: { id }, data: { source: 'native', ghStack: ns.number } });
    this.native.delete(s.repoRoot);
    await this.sync(id, true).catch(() => {});
    return this.view(id);
  }

  /** Point a layer whose parent already merged at the trunk. */
  async retargetLayer(id: string, pr: number): Promise<StackView> {
    const s = await this.stack(id);
    await this.layer(id, pr);
    await this.gh(() => retarget(s.repoRoot, pr, s.trunk));
    await this.sync(id, true).catch(() => {});
    return this.view(id);
  }

  async ready(id: string, pr: number): Promise<StackView> {
    const s = await this.stack(id);
    await this.layer(id, pr);
    await this.gh(() => markReady(s.repoRoot, pr));
    await this.sync(id, true).catch(() => {});
    return this.view(id);
  }

  /** The instruction for a layer that repeats its merged parent's commits (squash/rebase merges). */
  /**
   * The message asking the agent to merge the stack up to a layer (all of it
   * by default): bottom up, with the method you picked, each at the head you
   * reviewed. A run of a GitHub stack goes through gh stack merge (or the
   * stack merge API without it); a layer of a chain is merged, the next one
   * retargeted and, after a squash or rebase, restacked before its turn. A
   * layer a gate holds back is where it stops and asks.
   */
  async mergeText(id: string, method: string, upTo?: number): Promise<string> {
    const s = await this.stack(id);
    const v = await this.view(id);
    const open = v.layers.filter((l) => l.state === 'open');
    const end = upTo === undefined ? open.length - 1 : open.findIndex((l) => l.pr === upTo);
    if (end < 0) throw new ReviewError(upTo === undefined ? 409 : 404, upTo === undefined ? 'nothing left to merge' : `#${upTo} is not an open layer of this stack`);
    const todo = open.slice(0, end + 1);
    const how = method === 'squash' || method === 'rebase' ? method : 'merge';
    const tool = todo.some((l) => l.ghStack !== null) && (await this.ghStackHere(s.repoRoot));
    const head = (l: LayerView) => (l.current?.headSha ?? '').slice(0, 12);
    const lines = [
      `Please merge the stack "${s.title}" (${s.repo}) into ${s.trunk}, bottom up, with ${how === 'merge' ? 'merge commits' : how === 'squash' ? 'squash merges' : 'rebase merges'}. Merge each pull request at the head I reviewed; if a branch has moved since, stop and tell me.`,
      '',
      ...todo.map((l, i) => `${i + 1}. ${label(l)} "${l.title}": ${l.headRef} at ${head(l)}${l.ghStack !== null ? `, in GitHub stack #${l.ghStack}` : ''}`),
      '',
    ];
    // How each run lands, bottom up.
    const heads = new Set<string>();
    for (let i = 0; i < todo.length; ) {
      let j = i;
      if (todo[i].ghStack !== null) while (j + 1 < todo.length && todo[j + 1].ghStack === todo[i].ghStack && (todo[j + 1].ghPos ?? 0) > (todo[j].ghPos ?? 0)) j++;
      const run = todo.slice(i, j + 1);
      const top = todo[j];
      const held = run.find((l) => l.gates.some((g) => !g.ok && g.key !== 'order' && g.key !== 'below' && g.key !== 'reviewed' && !(g.key === 'base' && heads.has(l.baseRef))));
      if (held) {
        const g = held.gates.find((x) => !x.ok && x.key !== 'order' && x.key !== 'below' && x.key !== 'reviewed' && !(x.key === 'base' && heads.has(held.baseRef)))!;
        lines.push(`- Stop before ${label(held)}: ${(g.detail ?? g.label).replace(/^./, (c) => c.toLowerCase())}. Tell me what's left instead of merging past it.`);
        break;
      }
      if (top.ghStack !== null) {
        const clash = v.layers.some((l) => l.ghStack === top.pr);
        lines.push(
          tool
            ? `- ${run.map(label).join(', ')}: gh stack merge ${top.pr} --${how} --yes lands ${run.length > 1 ? 'them' : 'it'} with the rest of GitHub stack #${top.ghStack} under ${top.pr}, all or none.${clash ? ` (${top.pr} is also a stack's number, which gh stack takes first: check it picks the PR.)` : ''}`
            : `- ${run.map(label).join(', ')}: through GitHub's stack merge (plain gh pr merge refuses stacked PRs): gh api -X PUT repos/${s.repo}/pulls/${top.pr}/merge-async -f merge_method=${how} -f sha=${top.current?.headSha ?? ''}, then wait until it lands.`,
        );
      } else {
        const sat = i > 0 && heads.has(top.baseRef);
        lines.push(
          `- ${label(top)}: ${sat ? `point it at ${s.trunk} (gh pr edit ${top.pr} --base ${s.trunk})${how !== 'merge' ? `, rebase its own commits onto origin/${s.trunk} (git rebase --onto origin/${s.trunk} ${top.current?.baseSha.slice(0, 12) ?? top.baseRef} ${top.headRef}), run the tests, push with --force-with-lease and wait for its checks` : ''}, then ` : ''}gh pr merge ${top.pr} --${how} --match-head-commit ${how !== 'merge' && sat ? '<its new head>' : top.current?.headSha ?? ''}.`,
        );
      }
      for (const l of run) heads.add(l.headRef);
      i = j + 1;
    }
    lines.push('', 'If GitHub refuses a merge or a check fails, stop there and tell me why. Reply with what merged.', `(ah review ${s.id}/merge)`);
    return lines.join('\n');
  }

  async restackText(id: string, pr: number): Promise<string> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    if (l.ghStack !== null) {
      const tool = await this.ghStackHere(s.repoRoot);
      return [
        `${label(l)} (${l.headRef}) is in GitHub stack #${l.ghStack} but no longer sits on top of ${l.baseRef}, and GitHub merges a stack only when each branch is on the one under it.`,
        tool
          ? `Restack it with gh stack: gh stack checkout ${l.pr} if this checkout doesn't track the stack, then gh stack rebase and gh stack push. Resolve conflicts and run the tests on the way.`
          : `Rebase its own commits onto ${l.baseRef}: git fetch, then git rebase --onto origin/${l.baseRef} ${l.baseSha.slice(0, 12)} ${l.headRef}. Resolve conflicts, run the tests, push with --force-with-lease, and restack the layers above it the same way.`,
        'Reply with the new heads.',
        `(ah review ${s.id}/${pr})`,
      ].join('\n');
    }
    const reviewed = l.reviewedRevId ? await this.db.reviewRevision.findUnique({ where: { id: l.reviewedRevId } }) : null;
    const old = reviewed?.baseSha ?? l.baseSha;
    return [
      `${label(l)} (${l.headRef}) now targets ${s.trunk}, but still carries the commits of the layer below, which was merged as a ${s.mergeMethod}.`,
      `Rebase only its own commits onto ${s.trunk}: git fetch, then git rebase --onto origin/${s.trunk} ${old.slice(0, 12)} ${l.headRef}. Resolve conflicts, run the tests, and push with --force-with-lease.`,
      'Then restack any layers above it the same way. Reply with the new heads.',
      `(ah review ${s.id}/${pr})`,
    ].join('\n');
  }

  // ---------- the reviewer

  private async env(s: ReviewStack): Promise<ReviewEnv> {
    const [layers, revs] = await Promise.all([this.db.reviewLayer.findMany({ where: { stackId: s.id }, orderBy: { position: 'asc' } }), this.db.reviewRevision.findMany({ where: { stackId: s.id } })]);
    const byId = new Map(revs.map((r) => [r.id, r]));
    let planText: Promise<string | null> | null = null;
    const ctx: LayerCtx[] = layers.map((l) => {
      const cur = l.currentRevId ? byId.get(l.currentRevId) : undefined;
      const rev = l.reviewedRevId ? byId.get(l.reviewedRevId) : undefined;
      return {
        pr: l.pr,
        role: l.role,
        title: l.title,
        url: l.url,
        state: l.state,
        draft: l.draft,
        headRef: l.headRef,
        baseRef: l.baseRef,
        base: cur?.baseSha ?? null,
        head: cur?.headSha ?? null,
        reviewed: rev ? { base: rev.baseSha, head: rev.headSha } : null,
        stat: cur ? { files: cur.files, additions: cur.additions, deletions: cur.deletions } : null,
        checks: checksOf(l),
      };
    });
    return {
      root: s.repoRoot,
      repo: s.repo,
      trunk: s.trunk,
      title: s.title,
      order: layers.map((l) => l.pr),
      layers: ctx,
      trunkTip: () => resolve(s.repoRoot, branchRef(s.id, s.trunk)),
      plan: () => (planText ??= this.planText(s)),
      body: async (pr) => this.bodies.get(`${s.id}:${pr}`) ?? (await viewPr(s.repoRoot, pr))?.body ?? '',
      findings: async () =>
        (await this.db.reviewFinding.findMany({ where: { stackId: s.id, state: { not: 'proposed' } }, orderBy: { id: 'asc' } })).map(
          (f): FindingLite => ({ id: f.id, ownerPr: f.ownerPr, title: f.title, body: f.body, severity: f.severity, state: f.state, path: f.path, lineStart: f.lineStart, source: f.source }),
        ),
      decisions: async () => (await this.db.reviewDecision.findMany({ where: { stackId: s.id }, orderBy: { id: 'asc' } })).map((d) => d.text),
      threads: (pr): Promise<ReviewThread[]> => reviewThreads(s.repoRoot, s.repo, pr),
      originTitle: s.originUid || s.originKey ? ((await this.originSession(s))?.title ?? null) : null,
      origin: (query) => this.originText(s, query),
    };
  }

  private async originSession(s: ReviewStack): Promise<SessionLite | null> {
    if (!s.originUid && !s.originKey) return null;
    return resolveSession(await this.deps.sessions(), s.originKey, s.originUid);
  }

  /** What the reviewer's origin tool reads: the human's messages to the session that made the stack, or passages that mention a query. */
  private async originText(s: ReviewStack, query: string | null): Promise<string | null> {
    const sess = await this.originSession(s);
    const uid = sess?.uid ?? s.originUid;
    if (!uid) return null;
    const t = await this.deps.transcript(uid).catch(() => null);
    if (!t) return null;
    const when = (at: number) => (at ? new Date(at).toISOString().slice(0, 16).replace('T', ' ') : '');
    const head = `Session "${sess?.title ?? 'ended session'}"${sess?.agent ? ` (${sess.agent})` : ''}.`;
    if (!query) return [head, 'What the human asked it, oldest first:', ...t.prompts.map((p) => `- ${when(p.at)} ${p.text.replace(/\s+/g, ' ')}`)].join('\n');
    const q = query.toLowerCase();
    const hits = t.entries.filter((e) => e.text.toLowerCase().includes(q));
    if (!hits.length) return `${head}\nNothing in its transcript mentions "${query}".`;
    const near = (text: string) => {
      const i = text.toLowerCase().indexOf(q);
      const from = Math.max(0, i - 300);
      return `${from ? '…' : ''}${text.slice(from, i + q.length + 300).replace(/\s+/g, ' ')}${i + q.length + 300 < text.length ? '…' : ''}`;
    };
    return [head, `${hits.length === 1 ? '1 passage mentions' : `${hits.length} passages mention`} "${query}"${hits.length > 20 ? '; the latest 20' : ''}:`, ...hits.slice(-20).map((e) => `[${e.role} ${when(e.at)}] ${near(e.text)}`)].join('\n\n');
  }

  /** The plan file, else the root layer's PR description. */
  private async planText(s: ReviewStack): Promise<string | null> {
    if (s.planPath) {
      const text = await this.deps.readPlan(s.planPath).catch(() => null);
      if (text) return text.slice(0, PLAN_MAX);
    }
    const root = await this.db.reviewLayer.findFirst({ where: { stackId: s.id }, orderBy: { position: 'asc' } });
    const body = root ? (this.bodies.get(`${s.id}:${root.pr}`) ?? (await viewPr(s.repoRoot, root.pr))?.body ?? '') : '';
    return body.trim() ? `(No plan file; this is the root PR's description.)\n${body}` : null;
  }

  /** A layer's pull request description, as GitHub has it now (the list keeps the last synced copy). */
  async description(id: string, pr: number): Promise<{ body: string; url: string }> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    const fresh = await viewPr(s.repoRoot, pr);
    if (fresh) this.bodies.set(`${id}:${pr}`, fresh.body);
    return { body: fresh?.body ?? this.bodies.get(`${id}:${pr}`) ?? '', url: l.url };
  }

  /** An image in GitHub's markdown for this stack's pages, read with this host's gh login (gh.ts ghImage). */
  async image(id: string, src: string): Promise<GhImage | null> {
    const s = await this.stack(id);
    return ghImage(s.repoRoot, src);
  }

  async plan(id: string): Promise<{ path: string | null; text: string | null }> {
    const s = await this.stack(id);
    return { path: s.planPath, text: await this.planText(s) };
  }

  /** Every row of a stack's conversation: the stack's own key, and the per-layer keys threads used to have. */
  private threadRows(id: string, take?: number) {
    const where = { OR: [{ uid: threadKey(id, null) }, { uid: { startsWith: `review:${id}:` } }] };
    return take ? this.db.chatMessage.findMany({ where, orderBy: { id: 'desc' }, take }).then((r) => r.reverse()) : this.db.chatMessage.findMany({ where, orderBy: { id: 'asc' } });
  }

  /**
   * The stack's one conversation with the reviewer, oldest first. Each question
   * says which layer you were on and what you attached; the reviewer's proposals
   * come with it.
   */
  async thread(id: string): Promise<{ messages: ThreadMessage[]; findings: FindingView[]; subscriptionId: string | null }> {
    await this.stack(id);
    const rows = await this.threadRows(id);
    const ids = rows.map((r) => r.id);
    const proposed = ids.length ? await this.db.reviewFinding.findMany({ where: { stackId: id, messageId: { in: ids } }, orderBy: { id: 'asc' } }) : [];
    return { messages: rows.map(threadMessage), findings: proposed.map((f) => findingView(f)), subscriptionId: await this.chat.picked(threadKey(id, null)) };
  }

  /** Pick the subscription the stack's reviewer answers with, before asking it anything. */
  async pickThread(id: string, subscriptionId: string): Promise<void> {
    await this.stack(id);
    await this.chat.pick(threadKey(id, null), subscriptionId);
  }

  async clearThread(id: string): Promise<void> {
    await this.db.reviewFinding.deleteMany({ where: { stackId: id, state: 'proposed', messageId: { not: null } } });
    const keys = [...new Set((await this.threadRows(id)).map((r) => r.uid)), threadKey(id, null)];
    for (const k of keys) await this.chat.clear(k);
  }

  /** What you attached, spelled out for the reviewer: the finding, the lines as the diff showed them, the file's change. */
  private async attachments(s: ReviewStack, env: ReviewEnv, items: AskContext[]): Promise<{ text: string; saved: SavedContext[] }> {
    const parts: string[] = [];
    const saved: SavedContext[] = [];
    const layerName = (pr: number) => {
      const l = env.layers.find((x) => x.pr === pr);
      return l ? label(l) : `#${pr}`;
    };
    for (const c of items) {
      if (c.kind === 'finding') {
        const f = await this.db.reviewFinding.findFirst({ where: { id: c.id, stackId: s.id } });
        if (!f) continue;
        const where = f.path ? ` (${f.path}${f.lineStart ? `:${f.lineStart}` : ''})` : '';
        parts.push(`Finding F${f.id} [${f.severity}, ${f.state}, from ${f.source}] owned by ${layerName(f.ownerPr)}: ${f.title}${where}${f.body ? `\n${f.body.slice(0, 3000)}` : ''}`);
        saved.push({ kind: 'finding', id: f.id, pr: f.ownerPr, label: f.title });
      } else {
        const l = env.layers.find((x) => x.pr === c.pr);
        if (!l) continue;
        if (c.kind === 'lines') {
          const span = c.end > c.start ? `${c.start}–${c.end}` : `${c.start}`;
          parts.push(`Lines ${c.path}:${span} of ${label(l)}, as the diff shows them:\n\`\`\`diff\n${c.text.slice(0, 6000)}\n\`\`\``);
          saved.push({ kind: 'lines', pr: c.pr, path: c.path, start: c.start, end: c.end, label: `${c.path.split('/').pop()}:${span}` });
        } else {
          const d = l.base && l.head ? await diff(s.repoRoot, l.base, l.head, [c.path]).catch(() => null) : null;
          const patch = d?.patch ?? '';
          parts.push(
            patch && patch.length <= 12_000
              ? `The file ${c.path}, as ${label(l)} changes it:\n\`\`\`diff\n${patch}\n\`\`\``
              : `The file ${c.path} in ${label(l)}${patch ? ` (its change is ${Math.round(patch.length / 1000)}k characters: read it with layer_diff and paths)` : ''}.`,
          );
          saved.push({ kind: 'file', pr: c.pr, path: c.path, label: c.path.split('/').pop() ?? c.path });
        }
      }
    }
    return { text: parts.length ? `\n\nAttached:\n\n${parts.join('\n\n')}` : '', saved };
  }

  /**
   * One turn with the reviewer. A stack has one conversation; `pr` is the layer
   * you're on (null: the stack as a whole), and what you attach is spelled out
   * for it. The model sees the last few turns, each with where it was asked.
   * Proposed findings are stored as `proposed` until you keep or dismiss them.
   */
  async ask(id: string, pr: number | null, text: string, subscriptionId?: string, attach: AskContext[] = []) {
    const s = await this.stack(id);
    if (pr !== null) await this.layer(id, pr);
    const key = threadKey(id, null);
    const sub = await this.chat.subscription(subscriptionId ?? (await this.chat.picked(key)) ?? undefined);
    if (subscriptionId) await this.chat.pick(key, subscriptionId);
    const env = await this.env(s);
    const prior = await this.threadRows(id, THREAD_HISTORY);
    const cur = pr === null ? null : await this.currentRev(id, pr);
    const { text: attached, saved: items } = await this.attachments(s, env, attach);
    const where = (m: ThreadMessage) => {
      const l = m.pr === null ? null : env.layers.find((x) => x.pr === m.pr);
      const what = m.context.map((c) => (c.kind === 'finding' ? `finding F${c.id}` : c.kind === 'lines' ? `${c.path}:${c.start}${c.end > c.start ? `–${c.end}` : ''}` : c.path));
      return `[${l ? `On ${label(l)}` : 'On the whole stack'}${what.length ? ` · attached ${what.join(', ')}` : ''}] `;
    };
    const history = prior.map(threadMessage).map((m) => ({ role: m.role, text: m.role === 'user' ? where(m) + m.text : m.text }));
    const messages = await reviewMessages(env, { pr }, history, text + attached, cur?.summary ?? null);
    const raw = await this.chat.converse(sub, messages, REVIEW_TOOLS, (name, args) => runReviewTool(env, name, args), { rounds: 10, timeoutMs: 180_000 });
    const reply = parseReply(raw, env.order);
    const at = now();
    const context = JSON.stringify({ pr, items } satisfies { pr: number | null; items: SavedContext[] });
    const asked = await this.db.chatMessage.create({ data: { uid: key, role: 'user', text, at, context } });
    const saved = await this.db.chatMessage.create({ data: { uid: key, role: 'assistant', text: reply.content, at, context: JSON.stringify({ pr, items: [] }) } });
    const findings: FindingView[] = [];
    for (const f of reply.findings) {
      const owner = f.ownerPr ?? pr ?? env.order.find((n) => env.layers.find((x) => x.pr === n)?.state === 'open') ?? env.order[0];
      findings.push(
        await this.addFinding(id, { ownerPr: owner, foundOnPr: pr ?? owner, title: f.title, body: f.body, severity: f.severity, path: f.path, lineStart: f.lineStart, lineEnd: f.lineEnd, source: 'reviewer', state: 'proposed', messageId: saved.id }),
      );
    }
    return { asked: threadMessage(asked), message: threadMessage(saved), followups: reply.followups, findings };
  }

  private async currentRev(id: string, pr: number): Promise<ReviewRevision | null> {
    const l = await this.layer(id, pr);
    return l.currentRevId ? this.db.reviewRevision.findUnique({ where: { id: l.currentRevId } }) : null;
  }

  /** Whether a summary or re-check is running for a layer. */
  busy(id: string, pr: number): { summarizing: boolean; rechecking: boolean } {
    return { summarizing: this.jobs.has(`sum:${id}:${pr}`), rechecking: this.jobs.has(`chk:${id}:${pr}`) };
  }

  /** The layer's briefing, cached per patch. Runs in the background; returns at once. */
  async summarize(id: string, pr: number, force = false): Promise<{ started: boolean; reason?: string }> {
    const key = `sum:${id}:${pr}`;
    if (this.jobs.has(key)) return { started: true };
    const cur = await this.currentRev(id, pr);
    if (!cur) return { started: false, reason: 'not fetched yet' };
    if (cur.summary && !force) return { started: false, reason: 'cached' };
    if (!(await this.chat.defaultId())) return { started: false, reason: 'no subscription' };
    this.jobs.add(key);
    void (async () => {
      try {
        const s = await this.stack(id);
        const env = await this.env(s);
        const sub = await this.chat.subscription(await this.summaryModel());
        const raw = await this.chat.converse(sub, await summaryMessages(env, pr), REVIEW_TOOLS, (n, a) => runReviewTool(env, n, a), { rounds: 4, timeoutMs: 180_000, finalNudge: 'Tool budget spent. Write the briefing now.' });
        const text = raw.trim().replace(/^```(?:markdown|md)?\s*/, '').replace(/\s*```$/, '');
        await this.db.reviewRevision.updateMany({ where: { stackId: id, pr, patchId: cur.patchId }, data: { summary: text, summaryAt: now() } });
      } catch (err) {
        console.error(`review summary #${pr}:`, (err as Error).message);
      } finally {
        this.jobs.delete(key);
      }
    })();
    return { started: true };
  }

  /** Settings → Subscriptions: which subscription writes briefings and re-checks (null: the default). */
  async settings(): Promise<{ summaryId: string | null }> {
    return { summaryId: (await this.summaryModel()) ?? null };
  }

  async setSummaryModel(id: string | null): Promise<{ summaryId: string | null }> {
    if (id === null) await this.db.setting.deleteMany({ where: { key: 'review.summaryId' } });
    else {
      if (!(await this.chat.list()).some((s) => s.id === id)) throw new ReviewError(404, 'subscription not found');
      await this.db.setting.upsert({ where: { key: 'review.summaryId' }, create: { key: 'review.summaryId', value: id }, update: { value: id } });
    }
    return this.settings();
  }

  /** Settings → Subscriptions: the model for briefings and re-checks, when set apart from chat. */
  private async summaryModel(): Promise<string | undefined> {
    const row = await this.db.setting.findUnique({ where: { key: 'review.summaryId' } });
    const subs = await this.chat.list();
    return row && subs.some((s) => s.id === row.value) ? row.value : undefined;
  }

  /** After a fix: which sent findings the new revision addresses. Stored on the revision as its verdict. */
  async recheck(id: string, pr: number): Promise<void> {
    const key = `chk:${id}:${pr}`;
    if (this.jobs.has(key)) return;
    const sent = await this.db.reviewFinding.findMany({ where: { stackId: id, ownerPr: pr, state: 'sent' }, orderBy: { id: 'asc' } });
    if (!sent.length || !(await this.chat.defaultId())) return;
    const cur = await this.currentRev(id, pr);
    if (!cur || cur.verdictJson) return;
    this.jobs.add(key);
    try {
      const s = await this.stack(id);
      const env = await this.env(s);
      const sub = await this.chat.subscription(await this.summaryModel());
      const lite = sent.map((f): FindingLite => ({ id: f.id, ownerPr: f.ownerPr, title: f.title, body: f.body, severity: f.severity, state: f.state, path: f.path, lineStart: f.lineStart, source: f.source }));
      const raw = await this.chat.converse(sub, await recheckMessages(env, pr, lite), REVIEW_TOOLS, (n, a) => runReviewTool(env, n, a), { rounds: 4, timeoutMs: 180_000 });
      const verdict = parseVerdict(raw, sent.map((f) => f.id));
      if (verdict) await this.db.reviewRevision.update({ where: { id: cur.id }, data: { verdictJson: JSON.stringify(verdict) } });
    } finally {
      this.jobs.delete(key);
      await this.refreshState();
    }
  }

  /** Apply a re-check's verdicts: addressed findings close; the rest go back to open. */
  async acceptVerdict(id: string, pr: number, overrides: Record<number, 'addressed' | 'open'> = {}): Promise<StackView> {
    const cur = await this.currentRev(id, pr);
    const verdict = verdictOf(cur);
    // A verdict that's there but unreadable decides nothing: every finding would reopen.
    if (cur?.verdictJson && !verdict) throw new ReviewError(409, "the re-check's verdict can't be read; run the re-check again");
    const sent = await this.db.reviewFinding.findMany({ where: { stackId: id, ownerPr: pr, state: 'sent' } });
    for (const f of sent) {
      const v = verdict?.items?.find((i) => i.id === f.id);
      const state = overrides[f.id] ?? (v?.verdict === 'addressed' ? 'addressed' : 'open');
      await this.db.reviewFinding.update({ where: { id: f.id }, data: { state, note: v?.evidence || f.note, stateBy: overrides[f.id] ? 'you' : 'reviewer', stateRevId: cur?.id ?? null, updatedAt: now() } });
    }
    // Accepting the fixes reviews the new revision.
    const l = await this.layer(id, pr);
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { reviewedRevId: l.currentRevId } });
    await this.refreshState();
    return this.view(id);
  }

  // ---------- alerts

  /** Recompute Inbox alerts, session banners, session links and the branch map; push what's new. */
  async refreshState(): Promise<void> {
    try {
      const [stacks, sessions] = await Promise.all([
        this.db.reviewStack.findMany({ where: { state: 'open' } }),
        this.deps.sessions(),
      ]);
      const sessionRoots = new Map<string, string | null>();
      for (const sess of sessions) {
        if (sess.cwd) sessionRoots.set(sess.uid, await this.mainOf(sess.cwd));
      }
      const next: ReviewState = { alerts: [], fixing: [], branches: [], sessions: [] };
      const rank: Record<SessionReviewLink['relation'], number> = { fixing: 0, branch: 1, owner: 2, origin: 3 };
      const links = new Map<string, SessionReviewLink>();
      const putLink = (link: SessionReviewLink) => {
        const k = `${link.uid}:${link.stackId}`;
        const prev = links.get(k);
        if (!prev || rank[link.relation] < rank[prev.relation]) links.set(k, link);
      };
      for (const s of stacks) {
        const v = await this.view(s.id, { autoSync: false });
        const stackAlerts: ReviewAlert[] = [];
        for (const l of v.layers) {
          if (l.state === 'open') next.branches.push({ repo: s.repo, branch: l.headRef, stackId: s.id, pr: l.pr, role: l.role, stackTitle: s.title });
          const base = { stackId: s.id, stackTitle: s.title, pr: l.pr, role: l.role, title: l.title };
          if (l.dispatch && ACTIVE_DISPATCH.includes(l.dispatch.state)) next.fixing.push({ uid: l.dispatch.targetUid, stackId: s.id, pr: l.pr, role: l.role, count: l.dispatch.findings.length, ...(l.dispatch.kind === 'merge' ? { merge: true } : {}) });
          if (l.state !== 'open') continue;
          if (l.status === 'rereview') stackAlerts.push({ ...base, kind: 'rereview', at: l.current ? (await this.db.reviewRevision.findUnique({ where: { id: l.current.id } }))?.createdAt ?? 0 : 0 });
          else if (l.dispatch?.state === 'no-push') stackAlerts.push({ ...base, kind: 'nopush', at: l.dispatch.doneAt ?? 0, ...(l.dispatch.kind === 'merge' ? { merge: true } : {}) });
          else if (l.needs === 'restack') stackAlerts.push({ ...base, kind: 'restack', at: s.syncedAt });
          else if (v.next === l.pr && l.gates.every((g) => g.ok)) stackAlerts.push({ ...base, kind: 'ready', at: s.syncedAt });
        }
        next.alerts.push(...stackAlerts);
        const openLayers = v.layers.filter((l) => l.state === 'open');
        const openFindings = openLayers.reduce((n, l) => n + l.open, 0);
        const nextLayer = v.next !== null ? v.layers.find((l) => l.pr === v.next) ?? null : openLayers[0] ?? null;
        const readyToMerge = !!nextLayer && nextLayer.gates.every((g) => g.ok);
        const needsYou = stackAlerts.length;
        const makeLink = (uid: string, key: string, relation: SessionReviewLink['relation'], layer: LayerView | null): SessionReviewLink => ({
          uid,
          key,
          stackId: s.id,
          stackTitle: s.title,
          pr: layer?.pr ?? nextLayer?.pr ?? null,
          role: layer?.role ?? nextLayer?.role ?? '',
          relation,
          status: layer?.status ?? nextLayer?.status ?? null,
          openFindings: layer ? layer.open : openFindings,
          readyToMerge: layer ? layer.gates.every((g) => g.ok) : readyToMerge,
          needsYou,
        });
        for (const l of openLayers) {
          if (l.dispatch && ACTIVE_DISPATCH.includes(l.dispatch.state)) {
            const target = sessions.find((x) => x.uid === l.dispatch!.targetUid);
            putLink(makeLink(l.dispatch.targetUid, target?.key ?? l.dispatch.targetUid, 'fixing', l));
          }
          for (const sess of sessions) {
            if (sess.live && sess.branch === l.headRef && sessionRoots.get(sess.uid) === s.repoRoot) {
              putLink(makeLink(sess.uid, sess.key, 'branch', l));
            }
          }
          if (l.ownerUid) {
            const lo = sessions.find((x) => x.uid === l.ownerUid);
            if (lo) putLink(makeLink(lo.uid, lo.key, 'owner', l));
          }
        }
        if (v.owner) putLink(makeLink(v.owner.uid, v.owner.key, 'owner', nextLayer));
        if (v.origin) putLink(makeLink(v.origin.uid, v.origin.key, 'origin', nextLayer));
      }
      next.sessions = [...links.values()].sort((a, b) => rank[a.relation] - rank[b.relation]);
      next.alerts.sort((a, b) => b.at - a.at);
      for (const a of next.alerts) {
        const tag = `${a.kind}:${a.stackId}:${a.pr}:${a.at}`;
        if (this.alerted.has(tag)) continue;
        this.alerted.add(tag);
        if (!this.snapshotPrimed) continue;
        const who = a.role || `#${a.pr}`;
        const title = a.kind === 'rereview' ? `${who} updated: ready to re-review` : a.kind === 'nopush' ? `${who}: the agent finished without ${a.merge ? 'merging' : 'pushing'}` : a.kind === 'restack' ? `${who} needs a restack` : `${who} is ready to merge`;
        this.deps.alert({ title, body: `${a.stackTitle} · ${a.title}`, tag: `review-${a.stackId}-${a.pr}`, url: `/#review/${a.stackId}/${a.pr}` });
      }
      this.snapshotPrimed = true;
      this.snapshot = next;
      this.deps.changed();
    } catch (err) {
      console.error('review state failed:', err);
    }
  }
  private snapshotPrimed = false;
}


/**
 * A review comment's title: its first sentence, without the badge images,
 * HTML and markdown that bots wrap it in. Codex's P0–P3 badges set severity.
 */
/** The line that starts a reply in an imported thread's body: who wrote it and when (web/review/GitHubText.tsx reads it). */
export const replyMark = (author: string, at: string) => `<!-- ah:reply ${author.replace(/[^\w.[\]-]/g, '')} ${at.replace(/[^\w:.+-]/g, '')} -->`;

/**
 * A GitHub review comment as a finding: its title (the comment's own bold
 * heading if it has one, as Codex and CodeRabbit write them, else its first
 * sentence), a severity from a P0–P3 badge, the plain text (for matching), and
 * the markdown to show, without the badge and the heading that became the title.
 */
export function threadTitle(body: string): { title: string; text: string; level: 'blocking' | 'should' | 'nit' | null; markdown: string } {
  const badge = body.match(/\bP([0-3])\b(?:\s*Badge)?/);
  const level = badge ? (badge[1] === '0' || badge[1] === '1' ? 'blocking' : badge[1] === '2' ? 'should' : 'nit') : null;
  let md = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[P[0-3] Badge\]\([^)]*\)/gi, '')
    .replace(/(\*\*|__)P[0-3] Badge\1\s*/g, '');
  for (let i = 0; i < 3; i++) md = md.replace(/<(sub|sup)>\s*<\/\1>/g, '');
  const plain = (x: string) => x.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<[^>]+>/g, '').replace(/\bP[0-3]\s*Badge\b/g, '');
  const text = plain(md).trim();
  const lines = md.split('\n');
  const heading = lines
    .map((l, i) => ({ i, m: /^\s*(\*\*|__)(.+)\1\s*$/.exec(plain(l)) }))
    .filter((x) => lines[x.i].trim())
    .slice(0, 6)
    .find((x) => x.m && x.m[2].replace(/[`*_]/g, '').trim().length > 3);
  let title: string;
  if (heading) {
    title = heading.m![2].replace(/[`*_]/g, '').trim();
    lines.splice(heading.i, lines[heading.i + 1]?.trim() === '' ? 2 : 1);
    md = lines.join('\n');
  } else {
    const line = text.split('\n').map((x) => x.replace(/^[#>*\s-]+|\*\*|__|`/g, '').trim()).find((x) => x.length > 3) ?? 'Review comment';
    title = line.match(/^(.{8,}?[.!?])(\s|$)/)?.[1] ?? line;
  }
  return { title: title.slice(0, 140), text, level, markdown: md.trim() };
}

/** Read a plan file: a regular text file, capped. The caller decides which paths are allowed. */
export async function readTextFile(path: string): Promise<string> {
  const st = await stat(path);
  if (!st.isFile()) throw new Error('not a file');
  if (st.size > PLAN_MAX * 4) throw new Error('file too large');
  const text = await readFile(path, 'utf8');
  if (text.includes('\0')) throw new Error('not a text file');
  return text;
}
