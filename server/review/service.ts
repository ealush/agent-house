// Stack review: the loop of read → review → send findings to the agent that
// owns the branch → re-review what changed → merge → next (docs/stack-review.md).
// GitHub is the source of truth for PR state; ah.db holds the rest. Runtime
// (sessions, sending, notifications) comes in as narrow callbacks from main.ts.
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { PrismaClient, ReviewFinding, ReviewLayer, ReviewRevision, ReviewStack } from '@prisma/client';
import { mainRepo } from '../git.ts';
import type { SideChatStore } from '../sidechat.ts';
import { GhError, listPrs, markReady, mergePr, repoInfo, replyAndResolve, retarget, reviewThreads, viewPr, type Checks, type GhPr, type MergeMethod, type ReviewThread } from './gh.ts';
import { branchRef, diff, diffStat, fetchStack, mergeBase, patchId, pin, prRef, remoteFor, resolve, sinceReview, unpinStack, validSha } from './git.ts';
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

export class ReviewError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const PLAN_MAX = 200_000;
const THREAD_HISTORY = 24;
const SYNC_STALE_S = 20;

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
};

export type ReviewDeps = {
  sessions: () => Promise<SessionLite[]>;
  send: (uid: string, text: string) => Promise<{ outcome: string; queueId?: string }>;
  /** A needs-you push to devices that asked for those. */
  alert: (p: { title: string; body: string; tag: string; url: string }) => void;
  /** Recompute the streamed state (the Inbox reads review alerts from it). */
  changed: () => void;
  /** Read a plan file the host allows (inside files.roots). */
  readPlan: (path: string) => Promise<string>;
};

export type LayerStatus = 'unreviewed' | 'changes' | 'fixing' | 'rereview' | 'approved' | 'merged' | 'closed' | 'skipped';
export type Gate = { key: 'reviewed' | 'findings' | 'checks' | 'mergeable' | 'base' | 'order'; ok: boolean; label: string; detail?: string };

export type RevView = { id: number; baseSha: string; headSha: string; patchId: string; files: number; additions: number; deletions: number; summary: string | null; verdict: Verdict | null };
export type DispatchView = { id: number; pr: number; state: string; targetUid: string; targetTitle: string | null; sentAt: number; doneAt: number | null; findings: number[]; text: string };
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
  blocking: number;
  dispatch: DispatchView | null;
  gates: Gate[];
  ownerUid: string | null;
};
export type Owner = { uid: string; key: string; title: string; agent: string | null; status: string; live: boolean } | null;
export type StackView = {
  id: string;
  title: string;
  repo: string;
  repoRoot: string;
  trunk: string;
  mergeMethod: string;
  methods: MergeMethod[];
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
export type StackSummary = { id: string; title: string; repo: string; trunk: string; state: string; layers: number; merged: number; needsYou: number; next: number | null; syncedAt: number };
export type ReviewAlert = { kind: 'rereview' | 'nopush' | 'ready' | 'restack'; stackId: string; stackTitle: string; pr: number; role: string; title: string; at: number };
/** What the streamed state carries: Inbox alerts, session banners, and the PR → stack map for session headers. */
export type ReviewState = {
  alerts: ReviewAlert[];
  fixing: { uid: string; stackId: string; pr: number; role: string; count: number }[];
  branches: { repo: string; branch: string; stackId: string; pr: number; role: string; stackTitle: string }[];
};

type Candidate = { number: number; title: string; headRefName: string; baseRefName: string; draft: boolean; author: string; inStack: string | null };
export type CandidateTree = { pr: Candidate; children: CandidateTree[] };

function checksOf(l: ReviewLayer): Checks {
  try {
    const c = JSON.parse(l.checksJson) as Checks;
    return { pass: c.pass ?? 0, fail: c.fail ?? 0, pending: c.pending ?? 0, failing: c.failing ?? [] };
  } catch {
    return { pass: 0, fail: 0, pending: 0, failing: [] };
  }
}

function revView(r: ReviewRevision | undefined | null): RevView | null {
  if (!r) return null;
  let verdict: Verdict | null = null;
  try {
    verdict = r.verdictJson ? (JSON.parse(r.verdictJson) as Verdict) : null;
  } catch {}
  return { id: r.id, baseSha: r.baseSha, headSha: r.headSha, patchId: r.patchId, files: r.files, additions: r.additions, deletions: r.deletions, summary: r.summary, verdict };
}

function findingView(f: ReviewFinding): FindingView {
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
  };
}

const OPEN_FINDING = ['open', 'sent'];
const ACTIVE_DISPATCH = ['sent', 'working'];
const label = (l: { role: string; pr: number }) => (l.role ? `${l.role} #${l.pr}` : `#${l.pr}`);
export const threadKey = (stackId: string, pr: number | null) => (pr === null ? `review:${stackId}` : `review:${stackId}:${pr}`);

export class ReviewService {
  private db: PrismaClient;
  private chat: SideChatStore;
  private deps: ReviewDeps;
  private syncs = new Map<string, Promise<void>>();
  private jobs = new Set<string>();
  private bodies = new Map<string, string>();
  private methods = new Map<string, MergeMethod[]>();
  private repoCache = new Map<string, { at: number; repo: string | null; trunk: string }>();
  private rootOf = new Map<string, string | null>();
  private snapshot: ReviewState = { alerts: [], fixing: [], branches: [] };
  private timer: NodeJS.Timeout | null = null;
  private lastPoll = 0;
  private alerted = new Set<string>();

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
  async candidates(root: string): Promise<{ root: string; repo: string; trunk: string; trees: CandidateTree[] }> {
    const main = await this.mainOf(root);
    if (!main) throw new ReviewError(400, 'not a git repository');
    const { repo, trunk } = await this.repoOf(main);
    if (!repo) throw new ReviewError(400, 'not a GitHub repository (or gh is not signed in)');
    const prs = (await this.gh(() => listPrs(main, 'open', 200))).filter((p) => !p.crossRepo);
    const taken = new Map<number, string>();
    for (const l of await this.db.reviewLayer.findMany({ where: { stackId: { in: (await this.db.reviewStack.findMany({ where: { repoRoot: main, state: 'open' }, select: { id: true } })).map((s) => s.id) } } })) {
      taken.set(l.pr, l.stackId);
    }
    const toTree = (t: Tree<GhPr>): CandidateTree => ({
      pr: { number: t.pr.number, title: t.pr.title, headRefName: t.pr.headRefName, baseRefName: t.pr.baseRefName, draft: t.pr.isDraft, author: t.pr.author, inStack: taken.get(t.pr.number) ?? null },
      children: t.children.map(toTree),
    });
    return { root: main, repo, trunk, trees: forest(prs).map(toTree) };
  }

  // ---------- stacks

  async create(root: string, pr: number, title?: string): Promise<StackView> {
    const main = await this.mainOf(root);
    if (!main) throw new ReviewError(400, 'not a git repository');
    const { repo, trunk } = await this.repoOf(main);
    if (!repo) throw new ReviewError(400, 'not a GitHub repository (or gh is not signed in)');
    const prs = (await this.gh(() => listPrs(main, 'open', 200))).filter((p) => !p.crossRepo);
    const tree = subtree(prs, pr);
    if (!tree) throw new ReviewError(404, `#${pr} is not an open pull request in ${repo}`);
    const order = defaultOrder(tree);
    const taken = await this.db.reviewLayer.findFirst({ where: { pr: { in: order }, stackId: { in: (await this.db.reviewStack.findMany({ where: { repoRoot: main, state: 'open' }, select: { id: true } })).map((s) => s.id) } } });
    if (taken) throw new ReviewError(409, `#${taken.pr} is already in a stack under review`);
    const id = randomUUID().slice(0, 8);
    await this.db.reviewStack.create({ data: { id, repoRoot: main, repo, trunk: tree.pr.baseRefName || trunk, title: (title?.trim() || tree.pr.title).slice(0, 120), createdAt: now() } });
    await this.db.reviewLayer.createMany({
      data: order.map((n, i) => {
        const p = prs.find((x) => x.number === n)!;
        return { stackId: id, pr: n, position: i, title: p.title, url: p.url, headRef: p.headRefName, baseRef: p.baseRefName, headSha: p.headRefOid, draft: p.isDraft, author: p.author };
      }),
    });
    for (const p of prs) this.bodies.set(`${id}:${p.number}`, p.body);
    // The owner is the one session working on these branches, if exactly one is.
    const sugg = await this.ownerSuggestions(id);
    if (sugg.length && sugg[0].reason === 'branch' && sugg.filter((s) => s.reason === 'branch').length === 1) {
      await this.db.reviewStack.update({ where: { id }, data: { ownerUid: sugg[0].uid, ownerKey: sugg[0].key } });
    }
    // The first fetch of every layer can take a while on a big stack: the page opens now and fills in.
    void this.sync(id, true).catch((err) => console.error(`review sync ${id}:`, (err as Error).message));
    return this.view(id, { autoSync: false });
  }

  async list(): Promise<StackSummary[]> {
    const stacks = await this.db.reviewStack.findMany({ where: { state: { not: 'archived' } }, orderBy: { createdAt: 'desc' } });
    const out: StackSummary[] = [];
    for (const s of stacks) {
      const v = await this.view(s.id);
      out.push({
        id: s.id,
        title: s.title,
        repo: s.repo,
        trunk: s.trunk,
        state: s.state,
        layers: v.layers.filter((l) => l.state !== 'skipped' && l.state !== 'closed').length,
        merged: v.layers.filter((l) => l.state === 'merged').length,
        needsYou: this.snapshot.alerts.filter((a) => a.stackId === s.id).length,
        next: v.next,
        syncedAt: s.syncedAt,
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
    const revById = new Map(revs.map((r) => [r.id, r]));
    const ownerOf = (uid: string | null, key: string | null): Owner => {
      if (!uid && !key) return null;
      const sess = sessions.find((x) => (key && x.key === key && x.live) || x.uid === uid) ?? sessions.find((x) => key && x.key === key);
      return sess ? { uid: sess.uid, key: sess.key, title: sess.title, agent: sess.agent, status: sess.status, live: sess.live } : { uid: uid ?? '', key: key ?? '', title: 'Ended session', agent: null, status: 'ended', live: false };
    };
    const firstOpen = layers.find((l) => l.state === 'open')?.pr ?? null;
    const views: LayerView[] = layers.map((l) => {
      const current = l.currentRevId ? revById.get(l.currentRevId) : undefined;
      const reviewed = l.reviewedRevId ? revById.get(l.reviewedRevId) : undefined;
      const mine = findings.filter((f) => f.ownerPr === l.pr && OPEN_FINDING.includes(f.state));
      const blocking = mine.filter((f) => f.severity === 'blocking').length;
      const d = dispatches.find((x) => x.pr === l.pr);
      const samePatch = !!current && !!reviewed && current.patchId === reviewed.patchId;
      const rebased = samePatch && (current!.headSha !== reviewed!.headSha || current!.baseSha !== reviewed!.baseSha);
      const active = !!d && ACTIVE_DISPATCH.includes(d.state);
      const status: LayerStatus =
        l.state !== 'open'
          ? (l.state as LayerStatus)
          : active
            ? 'fixing'
            : reviewed && !samePatch
              ? 'rereview'
              : l.approved && samePatch
                ? 'approved'
                : mine.length
                  ? 'changes'
                  : 'unreviewed';
      const checks = checksOf(l);
      const gates: Gate[] =
        l.state !== 'open'
          ? []
          : [
              {
                key: 'reviewed',
                ok: l.approved && samePatch,
                label: 'Reviewed revision is current',
                detail: !reviewed || !l.approved ? 'Not marked reviewed yet' : !samePatch ? 'Changed since your review' : rebased ? 'Rebased since your review, same patch' : undefined,
              },
              { key: 'findings', ok: blocking === 0, label: 'No open blocking findings', detail: blocking ? `${blocking} blocking` : mine.length ? `${mine.length} open, none blocking` : undefined },
              {
                key: 'checks',
                ok: checks.fail === 0 && checks.pending === 0,
                label: 'Checks passed',
                detail: checks.fail ? `Failing: ${checks.failing.join(', ')}` : checks.pending ? `${checks.pending} check${checks.pending === 1 ? '' : 's'} running` : checks.pass ? undefined : 'No checks reported',
              },
              { key: 'mergeable', ok: !l.draft && l.mergeable !== 'CONFLICTING', label: l.draft ? 'Draft' : 'Mergeable', detail: l.draft ? 'Mark it ready first' : l.mergeable === 'CONFLICTING' ? `Conflicts with ${l.baseRef}` : undefined },
              { key: 'base', ok: l.baseRef === s.trunk, label: `Targets ${s.trunk}`, detail: l.baseRef === s.trunk ? undefined : `Targets ${l.baseRef}` },
              { key: 'order', ok: firstOpen === l.pr, label: 'Next in merge order', detail: firstOpen === l.pr ? undefined : `#${firstOpen} comes first` },
            ];
      const dv: DispatchView | null = d
        ? { id: d.id, pr: d.pr, state: d.state, targetUid: d.targetUid, targetTitle: ownerOf(d.targetUid, d.targetKey)?.title ?? null, sentAt: d.sentAt, doneAt: d.doneAt, findings: findings.filter((f) => f.dispatchId === d.id).map((f) => f.id), text: d.text }
        : null;
      return {
        pr: l.pr,
        role: l.role,
        position: l.position,
        title: l.title,
        url: l.url,
        author: l.author,
        state: l.state,
        draft: l.draft,
        headRef: l.headRef,
        baseRef: l.baseRef,
        headSha: l.headSha,
        mergeable: l.mergeable,
        checks,
        needs: l.needs,
        status,
        approved: l.approved,
        samePatch,
        rebased,
        current: revView(current),
        reviewed: revView(reviewed),
        open: mine.length,
        blocking,
        dispatch: dv,
        gates,
        ownerUid: l.ownerUid,
      };
    });
    return {
      id: s.id,
      title: s.title,
      repo: s.repo,
      repoRoot: s.repoRoot,
      trunk: s.trunk,
      mergeMethod: s.mergeMethod,
      methods: this.methods.get(s.repoRoot) ?? ['merge'],
      planPath: s.planPath,
      state: s.state,
      syncedAt: s.syncedAt,
      syncError: s.syncError,
      syncing: this.syncs.has(id),
      owner: ownerOf(s.ownerUid, s.ownerKey),
      layers: views,
      next: firstOpen,
      decisions: decisions.map((d) => ({ id: d.id, text: d.text, fromPr: d.fromPr, at: d.at })),
    };
  }

  async update(id: string, patch: { title?: string; planPath?: string | null; mergeMethod?: string; order?: number[]; ownerUid?: string | null; state?: string }): Promise<StackView> {
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
      // New PRs stacked on an open layer join the stack, right after their parent's line.
      const heads = new Map(layers.filter((l) => l.state === 'open').map((l) => [l.headRef, l]));
      const others = await this.db.reviewLayer.findMany({ where: { pr: { in: all.map((p) => p.number) }, stackId: { not: id } }, select: { pr: true } });
      const elsewhere = new Set(others.map((o) => o.pr));
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
      // GitHub's view of each layer.
      for (const l of layers) {
        const p = byNumber.get(l.pr);
        if (!p) continue;
        this.bodies.set(`${id}:${l.pr}`, p.body);
        const state = p.state === 'MERGED' ? 'merged' : p.state === 'CLOSED' ? 'closed' : l.state === 'skipped' ? 'skipped' : 'open';
        await this.db.reviewLayer.update({
          where: { stackId_pr: { stackId: id, pr: l.pr } },
          data: { state, title: p.title, url: p.url, author: p.author, headRef: p.headRefName, baseRef: p.baseRefName, headSha: p.headRefOid, draft: p.isDraft, mergeable: p.mergeable, checksJson: JSON.stringify(p.checks) },
        });
      }
      layers = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
      const open = layers.filter((l) => l.state === 'open' || l.state === 'skipped');
      const remote = await remoteFor(s.repoRoot, s.repo);
      const branches = [...new Set([s.trunk, ...open.map((l) => l.baseRef)])];
      await fetchStack(s.repoRoot, remote, id, open.map((l) => l.pr), branches);
      const mergedHeads = new Set(layers.filter((l) => l.state === 'merged').map((l) => l.headRef));
      for (const l of open) {
        const head = (await resolve(s.repoRoot, prRef(id, l.pr))) ?? (validSha(l.headSha) ? await resolve(s.repoRoot, l.headSha) : null);
        const baseTip = await resolve(s.repoRoot, branchRef(id, l.baseRef));
        const needs = mergedHeads.has(l.baseRef) ? 'retarget' : l.mergeable === 'CONFLICTING' ? 'conflict' : l.needs === 'restack' ? 'restack' : '';
        if (!head || !baseTip) {
          await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr: l.pr } }, data: { needs } });
          continue;
        }
        const base = (await mergeBase(s.repoRoot, baseTip, head)) ?? baseTip;
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
        const done = needs === 'restack' && l.reviewedRevId && fresh ? (await this.db.reviewRevision.findUnique({ where: { id: l.reviewedRevId } }))?.patchId === rev.patchId : false;
        await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr: l.pr } }, data: { currentRevId: rev.id, baseSha: base, needs: done ? '' : needs } });
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
  async approve(id: string, pr: number, approved = true): Promise<StackView> {
    const l = await this.layer(id, pr);
    if (!l.currentRevId) throw new ReviewError(409, `#${pr} has not been fetched yet`);
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: approved ? { approved: true, reviewedRevId: l.currentRevId } : { approved: false } });
    await this.refreshState();
    return this.view(id);
  }

  // ---------- findings

  async findings(id: string, pr?: number): Promise<FindingView[]> {
    const rows = await this.db.reviewFinding.findMany({ where: { stackId: id, ...(pr === undefined ? {} : { OR: [{ ownerPr: pr }, { foundOnPr: pr }] }) }, orderBy: { id: 'asc' } });
    return rows.map(findingView);
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
      data.state = patch.state;
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
      const { title, text, level } = threadTitle(first.body);
      const reply = t.comments.slice(1).map((c) => `${c.author}: ${c.body}`).join('\n\n');
      await this.db.reviewFinding.create({
        data: {
          stackId: id,
          ownerPr: pr,
          foundOnPr: pr,
          revisionId: l.currentRevId,
          title,
          body: `${text}${reply ? `\n\n---\n${reply}` : ''}`.slice(0, 4000),
          severity: level ?? (/critical|blocking/i.test(text.slice(0, 200)) ? 'blocking' : 'should'),
          path: t.path,
          lineStart: t.startLine ?? t.line,
          lineEnd: t.line,
          source: `${bot ? 'bot' : 'gh'}:${first.author}`,
          ghThread: t.id,
          ghUrl: first.url || null,
          state: t.resolved ? 'addressed' : 'open',
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
    const out = await this.db.reviewFinding.update({ where: { id: fid }, data: { note: f.note ?? (body.trim() || null), updatedAt: now(), ...(OPEN_FINDING.includes(f.state) ? { state: 'addressed' } : {}) } });
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
  async ownerSuggestions(id: string): Promise<(SessionLite & { reason: 'branch' | 'repo' })[]> {
    const s = await this.stack(id);
    const heads = new Set((await this.db.reviewLayer.findMany({ where: { stackId: id }, select: { headRef: true } })).map((l) => l.headRef));
    const out: (SessionLite & { reason: 'branch' | 'repo' })[] = [];
    for (const sess of await this.deps.sessions()) {
      if (!sess.agent) continue;
      const root = sess.cwd ? await this.mainOf(sess.cwd) : null;
      if (root !== s.repoRoot) continue;
      out.push({ ...sess, reason: sess.branch && heads.has(sess.branch) ? 'branch' : 'repo' });
    }
    return out.sort((a, b) => (a.reason === b.reason ? Number(b.live) - Number(a.live) : a.reason === 'branch' ? -1 : 1));
  }

  /** Who a layer's findings go to: its own owner, else the stack's. Follows the conversation across resumes. */
  private async target(s: ReviewStack, l: ReviewLayer): Promise<SessionLite | null> {
    const key = l.ownerKey ?? s.ownerKey;
    const uid = l.ownerUid ?? s.ownerUid;
    if (!key && !uid) return null;
    const sessions = await this.deps.sessions();
    return sessions.find((x) => key && x.key === key && x.live) ?? sessions.find((x) => key && x.key === key) ?? sessions.find((x) => x.uid === uid) ?? null;
  }

  /** The message for the agent: findings with locations, the plan's constraints, and the restack of the layers above. */
  async dispatchText(id: string, pr: number, findingIds: number[], extra = ''): Promise<string> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    const layers = await this.db.reviewLayer.findMany({ where: { stackId: id }, orderBy: { position: 'asc' } });
    const picked = findingIds.length ? await this.db.reviewFinding.findMany({ where: { stackId: id, id: { in: findingIds } }, orderBy: { id: 'asc' } }) : [];
    const decisions = await this.db.reviewDecision.findMany({ where: { stackId: id }, orderBy: { id: 'asc' } });
    const short = l.headSha.slice(0, 8);
    const lines: string[] = [`Review of ${label(l)} "${l.title}" (branch ${l.headRef}) at ${short}.${picked.length ? ' Please fix:' : ''}`, ''];
    picked.forEach((f, i) => {
      const where = f.path ? ` ${f.path}${f.lineStart ? `:${f.lineStart}${f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ''}` : ''}` : '';
      lines.push(`${i + 1}. [${f.severity}] ${f.title.replace(/[.!?:;]+$/, '')}.${where}`);
      const body = f.body.split('\n---\n')[0].trim();
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
    lines.push('', `Commit and push ${l.headRef}.`);
    if (above.length) {
      lines.push(
        `Then restack the layers above it, in this order, pushing each with --force-with-lease against the head shown: ${above.map((x) => `${x.headRef} (${label(x)}, ${x.headSha.slice(0, 8)}) on ${x.baseRef}`).join('; ')}.`,
      );
    }
    lines.push('Reply with the new heads.', `(ah review ${s.id}/${pr})`);
    return lines.join('\n');
  }

  async dispatch(id: string, pr: number, input: { findingIds: number[]; text: string; targetUid?: string }): Promise<{ dispatch: DispatchView; outcome: string }> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
    const text = input.text.trim();
    if (!text) throw new ReviewError(400, 'text required');
    let target: SessionLite | null = null;
    if (input.targetUid) {
      target = (await this.deps.sessions()).find((x) => x.uid === input.targetUid) ?? null;
      if (!target) throw new ReviewError(404, 'session not found');
      // The first send binds the stack to that conversation.
      if (!s.ownerKey && !l.ownerKey) await this.db.reviewStack.update({ where: { id }, data: { ownerUid: target.uid, ownerKey: target.key } });
    } else target = await this.target(s, l);
    if (!target) throw new ReviewError(409, 'choose the session that owns this stack first');
    const sent = await this.deps.send(target.uid, text);
    const d = await this.db.reviewDispatch.create({
      data: { stackId: id, pr, targetUid: target.uid, targetKey: target.key, text, fromRevId: l.currentRevId, fromHead: l.headSha, queueId: sent.queueId ?? null, sentAt: now() },
    });
    // The revision the findings were written against is the checkpoint the fix is compared with.
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { reviewedRevId: l.currentRevId ?? l.reviewedRevId } });
    if (input.findingIds.length) {
      await this.db.reviewFinding.updateMany({ where: { stackId: id, id: { in: input.findingIds } }, data: { state: 'sent', dispatchId: d.id, updatedAt: now() } });
    }
    await this.refreshState();
    const v = await this.view(id);
    return { dispatch: v.layers.find((x) => x.pr === pr)!.dispatch!, outcome: sent.outcome };
  }

  /** Dispatches in flight: did the agent work, finish, and push? Runs every few seconds. */
  private async watch(): Promise<void> {
    const active = await this.db.reviewDispatch.findMany({ where: { state: { in: ACTIVE_DISPATCH } } });
    const due = now() - this.lastPoll > (active.length ? 60 : 300);
    if (active.length) {
      const sessions = await this.deps.sessions();
      const ended = new Set<string>();
      for (const d of active) {
        const sess = sessions.find((x) => x.key === d.targetKey && x.live) ?? sessions.find((x) => x.uid === d.targetUid);
        const working = !!sess?.live && (sess.status === 'busy' || sess.status === 'waiting');
        if (working && !d.sawWork) await this.db.reviewDispatch.update({ where: { id: d.id }, data: { sawWork: true, state: 'working' } });
        // A turn that started and stopped, or a session that went away after working, is done.
        if (d.sawWork && !working) ended.add(d.stackId);
        else if (!d.sawWork && now() - d.sentAt > 1800) await this.db.reviewDispatch.update({ where: { id: d.id }, data: { state: 'no-push', doneAt: now() } });
      }
      for (const stackId of ended) {
        await this.sync(stackId).catch(() => {});
        for (const d of active.filter((x) => x.stackId === stackId && x.sawWork)) {
          const l = await this.db.reviewLayer.findUnique({ where: { stackId_pr: { stackId, pr: d.pr } } });
          const pushed = !!l && l.headSha !== d.fromHead;
          await this.db.reviewDispatch.update({ where: { id: d.id }, data: { state: pushed ? 'done' : 'no-push', doneAt: now() } });
        }
      }
      if (ended.size) await this.refreshState();
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
  async merge(id: string, pr: number, opts: { outOfOrder?: boolean } = {}): Promise<{ next: number | null; retargeted: number[]; restack: number[] }> {
    await this.sync(id, true);
    const s = await this.stack(id);
    const v = await this.view(id);
    const l = v.layers.find((x) => x.pr === pr);
    if (!l) throw new ReviewError(404, `#${pr} is not in this stack`);
    if (l.state !== 'open') throw new ReviewError(409, `#${pr} is ${l.state}`);
    const failing = l.gates.filter((g) => !g.ok && !(g.key === 'order' && opts.outOfOrder));
    if (failing.length) throw new ReviewError(409, `${failing[0].label}: ${failing[0].detail ?? 'not yet'}`);
    const reviewedHead = l.current!.headSha;
    if (!/^[0-9a-f]{40}$/.test(reviewedHead)) throw new ReviewError(409, 'the reviewed head is unknown');
    await this.gh(() => mergePr(s.repoRoot, pr, s.mergeMethod as MergeMethod, reviewedHead));
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { state: 'merged' } });
    // Layers that sat on the merged branch now target the trunk. With a merge commit their
    // patch is unchanged; with squash or rebase they repeat the parent's commits until restacked.
    const retargeted: number[] = [];
    const restack: number[] = [];
    for (const c of v.layers.filter((x) => x.state === 'open' && x.baseRef === l.headRef)) {
      try {
        await retarget(s.repoRoot, c.pr, s.trunk);
        retargeted.push(c.pr);
        if (s.mergeMethod !== 'merge') {
          restack.push(c.pr);
          await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr: c.pr } }, data: { needs: 'restack' } });
        }
      } catch (err) {
        console.error(`retarget #${c.pr}:`, err);
      }
    }
    await this.sync(id, true).catch(() => {});
    const after = await this.view(id);
    return { next: after.next, retargeted, restack };
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
  async restackText(id: string, pr: number): Promise<string> {
    const s = await this.stack(id);
    const l = await this.layer(id, pr);
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
    };
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

  async plan(id: string): Promise<{ path: string | null; text: string | null }> {
    const s = await this.stack(id);
    return { path: s.planPath, text: await this.planText(s) };
  }

  async thread(id: string, pr: number | null): Promise<{ messages: { role: string; text: string; at: number; id: number }[]; findings: FindingView[] }> {
    await this.stack(id);
    if (pr !== null) await this.layer(id, pr);
    const rows = await this.db.chatMessage.findMany({ where: { uid: threadKey(id, pr) }, orderBy: { id: 'asc' } });
    const ids = rows.map((r) => r.id);
    const proposed = ids.length ? await this.db.reviewFinding.findMany({ where: { stackId: id, messageId: { in: ids } }, orderBy: { id: 'asc' } }) : [];
    return { messages: rows.map((r) => ({ role: r.role, text: r.text, at: r.at, id: r.id })), findings: proposed.map(findingView) };
  }

  async clearThread(id: string, pr: number | null): Promise<void> {
    await this.db.reviewFinding.deleteMany({ where: { stackId: id, state: 'proposed', messageId: { not: null } } });
    await this.db.chatMessage.deleteMany({ where: { uid: threadKey(id, pr) } });
  }

  /**
   * One turn with the reviewer. The thread is kept whole (side chat keeps 30);
   * the model sees the last few turns. Proposed findings are stored as
   * `proposed` until you keep or dismiss them.
   */
  async ask(id: string, pr: number | null, text: string, subscriptionId?: string) {
    const s = await this.stack(id);
    if (pr !== null) await this.layer(id, pr);
    const sub = await this.chat.subscription(subscriptionId);
    const env = await this.env(s);
    const key = threadKey(id, pr);
    const prior = (await this.db.chatMessage.findMany({ where: { uid: key }, orderBy: { id: 'desc' }, take: THREAD_HISTORY })).reverse();
    const cur = pr === null ? null : await this.currentRev(id, pr);
    const messages = await reviewMessages(env, { pr }, prior.map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text })), text, cur?.summary ?? null);
    const raw = await this.chat.converse(sub, messages, REVIEW_TOOLS, (name, args) => runReviewTool(env, name, args), { rounds: 10, timeoutMs: 180_000 });
    const reply = parseReply(raw, env.order);
    const at = now();
    await this.db.chatMessage.create({ data: { uid: key, role: 'user', text, at } });
    const saved = await this.db.chatMessage.create({ data: { uid: key, role: 'assistant', text: reply.content, at } });
    const findings: FindingView[] = [];
    for (const f of reply.findings) {
      const owner = f.ownerPr ?? pr ?? env.order.find((n) => env.layers.find((x) => x.pr === n)?.state === 'open') ?? env.order[0];
      findings.push(
        await this.addFinding(id, { ownerPr: owner, foundOnPr: pr ?? owner, title: f.title, body: f.body, severity: f.severity, path: f.path, lineStart: f.lineStart, lineEnd: f.lineEnd, source: 'reviewer', state: 'proposed', messageId: saved.id }),
      );
    }
    return { message: { role: 'assistant', text: reply.content, at, id: saved.id }, followups: reply.followups, findings };
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
    const verdict = cur?.verdictJson ? (JSON.parse(cur.verdictJson) as Verdict) : null;
    const sent = await this.db.reviewFinding.findMany({ where: { stackId: id, ownerPr: pr, state: 'sent' } });
    for (const f of sent) {
      const v = verdict?.items.find((i) => i.id === f.id);
      const state = overrides[f.id] ?? (v?.verdict === 'addressed' ? 'addressed' : 'open');
      await this.db.reviewFinding.update({ where: { id: f.id }, data: { state, note: v?.evidence || f.note, updatedAt: now() } });
    }
    // Accepting the fixes reviews the new revision.
    const l = await this.layer(id, pr);
    await this.db.reviewLayer.update({ where: { stackId_pr: { stackId: id, pr } }, data: { reviewedRevId: l.currentRevId } });
    await this.refreshState();
    return this.view(id);
  }

  // ---------- alerts

  /** Recompute Inbox alerts, session banners and the branch map; push what's new. */
  async refreshState(): Promise<void> {
    try {
      const stacks = await this.db.reviewStack.findMany({ where: { state: 'open' } });
      const next: ReviewState = { alerts: [], fixing: [], branches: [] };
      for (const s of stacks) {
        const v = await this.view(s.id, { autoSync: false });
        for (const l of v.layers) {
          if (l.state === 'open') next.branches.push({ repo: s.repo, branch: l.headRef, stackId: s.id, pr: l.pr, role: l.role, stackTitle: s.title });
          const base = { stackId: s.id, stackTitle: s.title, pr: l.pr, role: l.role, title: l.title };
          if (l.dispatch && ACTIVE_DISPATCH.includes(l.dispatch.state)) next.fixing.push({ uid: l.dispatch.targetUid, stackId: s.id, pr: l.pr, role: l.role, count: l.dispatch.findings.length });
          if (l.state !== 'open') continue;
          if (l.status === 'rereview') next.alerts.push({ ...base, kind: 'rereview', at: l.current ? (await this.db.reviewRevision.findUnique({ where: { id: l.current.id } }))?.createdAt ?? 0 : 0 });
          else if (l.dispatch?.state === 'no-push') next.alerts.push({ ...base, kind: 'nopush', at: l.dispatch.doneAt ?? 0 });
          else if (l.needs === 'restack') next.alerts.push({ ...base, kind: 'restack', at: s.syncedAt });
          else if (v.next === l.pr && l.gates.every((g) => g.ok)) next.alerts.push({ ...base, kind: 'ready', at: s.syncedAt });
        }
      }
      next.alerts.sort((a, b) => b.at - a.at);
      for (const a of next.alerts) {
        const tag = `${a.kind}:${a.stackId}:${a.pr}:${a.at}`;
        if (this.alerted.has(tag)) continue;
        this.alerted.add(tag);
        if (!this.snapshotPrimed) continue;
        const who = a.role || `#${a.pr}`;
        const title = a.kind === 'rereview' ? `${who} updated: ready to re-review` : a.kind === 'nopush' ? `${who}: the agent finished without pushing` : a.kind === 'restack' ? `${who} needs a restack` : `${who} is ready to merge`;
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
export function threadTitle(body: string): { title: string; text: string; level: 'blocking' | 'should' | 'nit' | null } {
  const badge = body.match(/\bP([0-3])\b(?:\s*Badge)?/);
  const level = badge ? (badge[1] === '0' || badge[1] === '1' ? 'blocking' : badge[1] === '2' ? 'should' : 'nit') : null;
  const text = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\bP[0-3]\s*Badge\b/g, '')
    .trim();
  const line = text.split('\n').map((x) => x.replace(/^[#>*\s-]+|\*\*|__/g, '').trim()).find((x) => x.length > 3) ?? 'Review comment';
  const sentence = line.match(/^(.{8,}?[.!?])(\s|$)/)?.[1] ?? line;
  return { title: sentence.slice(0, 140), text, level };
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
