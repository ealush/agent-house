// Checkouts' imperative shell (docs/spec/18-checkouts.md): atomic exclusive writer
// ownership in SQLite, automatic worktree isolation & rollback, runtime port/temp
// allocation, overlap & merge-tree integration checks, resume recreation, and
// startup + periodic disk-pressure-aware worktree garbage collection.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { PrismaClient, Checkout as CheckoutRow } from '@prisma/client';
import { createWorktree, removeWorktree, type Worktree } from '../git.ts';
import { cachedSize, invalidateSize, requestSize } from '../size.ts';
import type { CheckoutsConfig } from './settings.ts';
import {
  CheckoutError,
  allocatePortBlock,
  classifyLifecycle,
  computeOverlaps,
  evaluateOwnership,
  interpolateWorkspaceEnv,
  isCodingAgentPreset,
  planReclamation,
  shouldAutoIsolate,
  summarizeStorage,
  type CheckoutKind,
  type CheckoutLifecycle,
  type CheckoutStatusSnapshot,
  type CheckoutsOverview,
  type CheckoutsState,
  type CheckoutView,
  type GcItemResult,
  type GcRunResult,
  type IntegrationStatus,
  type LifecycleClassification,
  type LifecycleFacts,
  type RepositoryConcurrencyView,
} from './model.ts';
import {
  changedFilesSinceBase,
  checkMergeCompatibility,
  deleteUnusedBranch,
  detectTrunk,
  diskFreeBytes,
  isBranchMerged,
  pathInUse,
  pruneWorktrees,
  readRepoWorkspaceManifest,
  recreateWorktree,
  repoIdentity,
  worktreesOnDisk,
} from './git.ts';

export type LiveSessionFact = {
  uid: string;
  id: string;
  name: string;
  title: string;
  agent: string | null;
  status: string;
  cwd: string;
};

export type SessionRecordFact = {
  id: string;
  title: string;
  harness: string;
  harnessId?: string;
  cwd: string;
  lifecycle: string;
  lastActivityAt: number;
  worktree?: Worktree;
};

export type CheckoutsDeps = {
  config: () => CheckoutsConfig;
  tempRoot: string;
  liveWindows: () => Promise<LiveSessionFact[]>;
  records: () => SessionRecordFact[];
  changed: () => void;
  now?: () => number;
};

export type AcquireLaunchInput = {
  uid: string;
  preset: { id: string; command: string };
  cwd: string;
  name: string;
  creatingDir?: boolean;
  resumingInPlace?: boolean;
  /** true = force worktree, false = opt out to requested checkout, undefined = follow config.autoIsolate */
  explicitWorktree?: boolean;
  fromRef?: string;
  /** Explicit conversation handoff (e.g. Continue in another agent): allowed to take ownership from this uid. */
  handOffFromUid?: string | null;
  /**
   * A conversation continued in another agent: it stays in the source's checkout, whatever
   * the policy, and never fails on ownership (it shares the checkout if a third session owns it).
   */
  continuation?: boolean;
};

export type AcquiredCheckout = {
  checkoutId: string | null;
  worktree: Worktree | null;
  cwd: string;
  env: Record<string, string>;
  ports: { start: number; end: number } | null;
  rollback: () => Promise<void>;
};

export type ResumeAcquireInput = {
  uid: string;
  preset: { id: string; command: string };
  cwd: string;
  worktreeMeta?: Worktree;
};

export type AcquiredResume = {
  checkoutId: string | null;
  cwd: string;
  recreated: boolean;
  env: Record<string, string>;
  rollback: () => Promise<void>;
};

export type { CheckoutView, CheckoutsOverview, GcItemResult, GcRunResult, RepositoryConcurrencyView } from './model.ts';

function parseStatus(json: string): CheckoutStatusSnapshot {
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as CheckoutStatusSnapshot) : {};
  } catch {
    return {};
  }
}

/** How long a fresh claim counts as live before its window shows up in tmux. */
const CLAIM_GRACE_SEC = 30;

function freshId(): string {
  return `ck-${randomBytes(4).toString('hex')}`;
}

export class CheckoutsService {
  private db: PrismaClient;
  private deps: CheckoutsDeps;
  private revision = 0;
  private summary: CheckoutsState = { revision: 0, active: 0, overlaps: 0, reclaimableCount: 0, reclaimableBytes: 0 };
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private gcInFlight: Promise<GcRunResult> | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private lastReconcileAt = Date.now();

  constructor(db: PrismaClient, deps: CheckoutsDeps) {
    this.db = db;
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Math.floor(Date.now() / 1000);
  }

  private bump(): void {
    this.revision++;
    this.summary = { ...this.summary, revision: this.revision };
    this.deps.changed();
  }

  /** Lightweight summary for the state stream (SSE). */
  state(): CheckoutsState {
    return { ...this.summary };
  }

  /** Starts startup reconciliation + startup GC + periodic GC sweeps. */
  start(): void {
    if (this.timer || this.startupTimer) return;
    // Defer the initial startup sweep slightly so boot & immediate first-session launches stay crisp.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.reconcile()
        .then(() => (this.deps.config().gcEnabled ? this.runGc() : undefined))
        .catch((err) => console.warn('checkouts startup sweep:', err));
    }, 3000);
    this.startupTimer.unref();
    const sec = Math.max(30, this.deps.config().gcIntervalSeconds || 900);
    this.timer = setInterval(() => {
      if (!this.deps.config().gcEnabled) return;
      void this.runGc().catch((err) => console.warn('checkouts gc:', err));
    }, sec * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Throttled reconcile hook called after Core ticks. */
  tick(): void {
    const t = Date.now();
    if (this.reconcileInFlight || t - this.lastReconcileAt < 15_000) return;
    void this.reconcile().catch(() => {});
  }

  /** Builds checkout-scoped environment variables (plus optional `.ah/workspace.json`). */
  private async buildEnv(row: {
    id: string;
    repoRoot: string;
    path: string;
    portStart: number | null;
    portEnd: number | null;
    tempDir: string | null;
  }): Promise<Record<string, string>> {
    const base: Record<string, string> = {
      AH_WORKSPACE_ID: row.id,
      AH_WORKSPACE_ROOT: row.path,
      AH_REPO_ROOT: row.repoRoot,
    };
    if (row.portStart !== null) base.AH_PORT = String(row.portStart);
    if (row.portEnd !== null) base.AH_PORT_END = String(row.portEnd);
    if (row.tempDir) {
      await mkdir(row.tempDir, { recursive: true, mode: 0o700 }).catch(() => {});
      base.AH_TEMP_DIR = row.tempDir;
    }
    const manifest = await readRepoWorkspaceManifest(row.repoRoot);
    if (manifest) {
      Object.assign(base, interpolateWorkspaceEnv(manifest.env, base));
    }
    return base;
  }

  /** Active session uids (live coding-agent windows plus `starting` registry records). */
  private async activeWriterUids(): Promise<{ activeUids: Set<string>; titles: Map<string, string> }> {
    const [live, records] = await Promise.all([this.deps.liveWindows(), Promise.resolve(this.deps.records())]);
    const activeUids = new Set<string>();
    const titles = new Map<string, string>();
    const liveUids = new Set(live.map((w) => w.uid));
    for (const r of records) {
      if (r.title) titles.set(r.id, r.title);
      const isWriter = !!r.harness && r.harness !== 'shell';
      if (isWriter && (r.lifecycle === 'starting' || liveUids.has(r.id))) {
        activeUids.add(r.id);
      }
    }
    for (const w of live) {
      if (w.title || w.name) titles.set(w.uid, w.title || w.name);
      // Only coding-agent windows hold writer ownership; plain shells are observers.
      if (w.agent && w.agent !== 'shell') activeUids.add(w.uid);
    }
    return { activeUids, titles };
  }

  /** Allocates a non-overlapping port block against all non-reclaimed checkouts in SQLite. */
  private async nextPortBlock(tx: Pick<PrismaClient, 'checkout'>): Promise<{ portStart: number; portEnd: number } | null> {
    const rows = await tx.checkout.findMany({
      where: { lifecycle: { not: 'reclaimed' }, portStart: { not: null }, portEnd: { not: null } },
      select: { portStart: true, portEnd: true },
    });
    const used = rows
      .filter((r): r is { portStart: number; portEnd: number } => r.portStart !== null && r.portEnd !== null)
      .map((r) => ({ portStart: r.portStart, portEnd: r.portEnd }));
    return allocatePortBlock(used, this.deps.config());
  }

  /**
   * Acquires or creates a Checkout for a new session launch, enforcing automatic
   * worktree isolation and atomic exclusive writer ownership.
   */
  async acquireForLaunch(input: AcquireLaunchInput): Promise<AcquiredCheckout> {
    const absCwd = resolve(input.cwd);
    const id = await repoIdentity(absCwd);
    if (!id.isGit || !id.repoRoot || !id.checkoutRoot) {
      // Asked outright for a worktree of a folder that isn't a repository: refuse, as before Checkouts.
      if (input.explicitWorktree === true && !input.creatingDir && !input.continuation) await createWorktree(absCwd, input.name, input.fromRef);
      return { checkoutId: null, worktree: null, cwd: absCwd, env: {}, ports: null, rollback: async () => {} };
    }

    const decision = input.continuation ? ({ isolate: false, reason: 'resuming' } as const) : shouldAutoIsolate({
      config: this.deps.config(),
      preset: input.preset,
      isGitRepo: id.isGit,
      hasHead: id.hasHead,
      creatingDir: !!input.creatingDir,
      resumingInPlace: !!input.resumingInPlace,
      explicitWorktree: input.explicitWorktree,
    });

    if (input.explicitWorktree === true && !decision.isolate && decision.reason === 'unborn_repo') {
      throw new CheckoutError(409, 'checkout_unborn_repo', 'Cannot create an isolated worktree until this repository has at least one commit.');
    }

    const nowSec = this.now();

    if (decision.isolate) {
      const wt = await createWorktree(absCwd, input.name, input.fromRef);
      const checkoutId = freshId();
      const tempDir = join(this.deps.tempRoot, checkoutId);
      const wtIdentity = await repoIdentity(wt.path);
      let row: CheckoutRow;
      try {
        const wtPath = resolve(wt.path);
        const ownerUid = isCodingAgentPreset(input.preset) ? input.uid : null;
        row = await this.db.$transaction(async (tx) => {
          const ports = await this.nextPortBlock(tx);
          // Use upsert so a background reconcile() tick discovering the freshly created git
          // worktree between createWorktree() and this transaction cannot trip P2002 on `path`.
          return tx.checkout.upsert({
            where: { path: wtPath },
            update: {
              repoRoot: resolve(wt.repo),
              kind: 'worktree',
              managed: true,
              branch: wt.branch,
              baseSha: wtIdentity.headSha || id.headSha,
              baseBranch: id.trunkBranch,
              ownerUid,
              lifecycle: 'active',
              portStart: ports?.portStart ?? null,
              portEnd: ports?.portEnd ?? null,
              tempDir,
              lastActivityAt: nowSec,
            },
            create: {
              id: checkoutId,
              repoRoot: resolve(wt.repo),
              path: wtPath,
              kind: 'worktree',
              managed: true,
              branch: wt.branch,
              baseSha: wtIdentity.headSha || id.headSha,
              baseBranch: id.trunkBranch,
              ownerUid,
              lifecycle: 'active',
              pinned: false,
              portStart: ports?.portStart ?? null,
              portEnd: ports?.portEnd ?? null,
              tempDir,
              statusJson: '{}',
              createdAt: nowSec,
              lastActivityAt: nowSec,
            },
          });
        });
      } catch (err) {
        await removeWorktree(wt.path, true).catch(() => {});
        await pruneWorktrees(wt.repo).catch(() => {});
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        throw err;
      }

      const env = await this.buildEnv(row);
      this.bump();
      const rollback = async () => {
        await removeWorktree(wt.path, true).catch(() => {});
        await pruneWorktrees(wt.repo).catch(() => {});
        await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        invalidateSize(wt.path);
        await this.db.checkout.delete({ where: { id: row.id } }).catch(() => {});
        this.bump();
      };
      return {
        checkoutId: row.id,
        worktree: wt,
        cwd: wt.path,
        env,
        ports: row.portStart !== null && row.portEnd !== null ? { start: row.portStart, end: row.portEnd } : null,
        rollback,
      };
    }

    // In-place launch (main checkout, explicit opt-out, shell, or unborn repo).
    const kind: CheckoutKind = id.isWorktree ? 'worktree' : 'main';
    const isWriter = isCodingAgentPreset(input.preset);

    // Shells are observers: never claim or collide with writer ownership, just track the row if present.
    if (!isWriter) {
      const existing = await this.db.checkout.findUnique({ where: { path: id.checkoutRoot } });
      if (!existing) {
        return { checkoutId: null, worktree: null, cwd: absCwd, env: { AH_WORKSPACE_ROOT: id.checkoutRoot, AH_REPO_ROOT: id.repoRoot }, ports: null, rollback: async () => {} };
      }
      const env = await this.buildEnv(existing);
      return {
        checkoutId: existing.id,
        worktree: kind === 'worktree' && existing.branch ? { path: existing.path, branch: existing.branch, repo: existing.repoRoot } : null,
        cwd: absCwd,
        env,
        ports: existing.portStart !== null && existing.portEnd !== null ? { start: existing.portStart, end: existing.portEnd } : null,
        rollback: async () => {},
      };
    }

    // Writer acquiring an existing checkout: enforce atomic exclusive ownership in SQLite.
    const claimed = await this.claimExistingCheckout({
      uid: input.uid,
      repoRoot: id.repoRoot,
      path: id.checkoutRoot,
      kind,
      branch: id.branch,
      headSha: id.headSha,
      trunkBranch: id.trunkBranch,
      handOffFromUid: input.handOffFromUid,
      shared: input.continuation,
    });
    const env = await this.buildEnv(claimed);
    this.bump();
    const rollback = async () => {
      await this.db.checkout
        .updateMany({
          where: { id: claimed.id, ownerUid: input.uid },
          data: { ownerUid: null, lifecycle: 'retained', lastActivityAt: this.now() },
        })
        .catch(() => {});
      this.bump();
    };
    return {
      checkoutId: claimed.id,
      worktree: kind === 'worktree' && claimed.branch ? { path: claimed.path, branch: claimed.branch, repo: claimed.repoRoot } : null,
      cwd: absCwd,
      env,
      ports: claimed.portStart !== null && claimed.portEnd !== null ? { start: claimed.portStart, end: claimed.portEnd } : null,
      rollback,
    };
  }

  /** Atomically claims `ownerUid` on an existing checkout path inside a SQLite transaction. */
  private async claimExistingCheckout(o: {
    uid: string;
    repoRoot: string;
    path: string;
    kind: CheckoutKind;
    branch: string | null;
    headSha: string;
    trunkBranch: string;
    handOffFromUid?: string | null;
    /** Never refuse: share the checkout with its owner instead (continuations, resume and recovery). */
    shared?: boolean;
  }): Promise<CheckoutRow> {
    const { activeUids, titles } = await this.activeWriterUids();
    const nowSec = this.now();

    return this.db.$transaction(async (tx) => {
      const row = await tx.checkout.findUnique({ where: { path: o.path } });
      // The main checkout is where people (and agents they start on purpose) work together:
      // it's tracked, and the clients warn about the writers in it, but it has no owner.
      if (o.kind === 'main') {
        if (row) {
          await tx.checkout.update({ where: { id: row.id }, data: { lifecycle: 'active', lastActivityAt: nowSec } });
          return (await tx.checkout.findUnique({ where: { id: row.id } }))!;
        }
        return tx.checkout.create({
          data: { id: freshId(), repoRoot: o.repoRoot, path: o.path, kind: 'main', branch: o.branch, baseSha: o.headSha, baseBranch: o.trunkBranch, ownerUid: null, lifecycle: 'active', createdAt: nowSec, lastActivityAt: nowSec },
        });
      }
      if (!row) {
        const checkoutId = freshId();
        const ports = await this.nextPortBlock(tx);
        const tempDir = join(this.deps.tempRoot, checkoutId);
        return tx.checkout.create({
          data: {
            id: checkoutId,
            repoRoot: o.repoRoot,
            path: o.path,
            kind: o.kind,
            branch: o.branch,
            baseSha: o.headSha,
            baseBranch: o.trunkBranch,
            ownerUid: o.uid,
            lifecycle: 'active',
            pinned: false,
            portStart: ports?.portStart ?? null,
            portEnd: ports?.portEnd ?? null,
            tempDir,
            statusJson: '{}',
            createdAt: nowSec,
            lastActivityAt: nowSec,
          },
        });
      }

      // An owner claimed moments ago may still be starting (its window isn't listed yet): it's live.
      const live = new Set(activeUids);
      if (row.ownerUid && nowSec - row.lastActivityAt < CLAIM_GRACE_SEC) live.add(row.ownerUid);
      const check = evaluateOwnership(row.ownerUid, o.uid, live, o.handOffFromUid);
      if (!check.ok && o.shared) {
        await tx.checkout.update({ where: { id: row.id }, data: { lifecycle: 'active', lastActivityAt: nowSec } });
        return (await tx.checkout.findUnique({ where: { id: row.id } }))!;
      }
      if (!check.ok) {
        const ownerTitle = titles.get(check.ownerUid) ?? check.ownerUid;
        throw new CheckoutError(
          409,
          'checkout_owned',
          `This checkout is already owned by active session "${ownerTitle}" (${check.ownerUid}). Start in an isolated checkout or open the existing session.`,
          { checkoutId: row.id, ownerUid: check.ownerUid, ownerTitle, path: row.path, branch: row.branch },
        );
      }

      const ports = row.kind === 'worktree' && row.portStart === null ? await this.nextPortBlock(tx) : null;
      const tempDir = row.kind === 'worktree' && !row.tempDir ? join(this.deps.tempRoot, row.id) : row.tempDir;

      // Conditional update acts as an atomic CAS under SQLite's write lock.
      const updated = await tx.checkout.updateMany({
        where: { id: row.id, ownerUid: row.ownerUid },
        data: {
          ownerUid: o.uid,
          lifecycle: 'active',
          branch: o.branch ?? row.branch,
          reclaimedAt: null,
          lastActivityAt: nowSec,
          ...(ports ? { portStart: ports.portStart, portEnd: ports.portEnd } : {}),
          ...(tempDir !== row.tempDir ? { tempDir } : {}),
        },
      });
      if (updated.count !== 1) {
        throw new CheckoutError(409, 'checkout_owned', 'This checkout was just claimed by another session. Retry or start in an isolated checkout.');
      }
      return (await tx.checkout.findUnique({ where: { id: row.id } }))!;
    });
  }

  /**
   * Prepares a session's checkout for resume:
   * - If its managed worktree was previously reclaimed, recreates it at the original path
   *   from its preserved branch or commit (so harness transcripts match without rehoming).
   * - Acquires exclusive writer ownership for coding agents.
   */
  async ensureForResume(input: ResumeAcquireInput): Promise<AcquiredResume> {
    const absCwd = resolve(input.cwd);
    let recreated = false;

    if (!existsSync(absCwd)) {
      const row = await this.db.checkout.findUnique({ where: { path: absCwd } });
      const repoRoot = row?.repoRoot ?? input.worktreeMeta?.repo;
      const branch = row?.branch ?? input.worktreeMeta?.branch ?? null;
      const baseSha = row?.baseSha ?? '';
      if (repoRoot && existsSync(repoRoot) && (row?.kind === 'worktree' || !!input.worktreeMeta)) {
        try {
          const res = await recreateWorktree(repoRoot, absCwd, branch, baseSha);
          recreated = res.recreated;
        } catch (err) {
          // Resume still works, in the home folder as it always did when a folder was gone.
          console.warn(`checkouts: could not recreate ${absCwd} for resume: ${(err as Error).message}`);
        }
      }
    }

    if (!existsSync(absCwd)) {
      return { checkoutId: null, cwd: absCwd, recreated: false, env: {}, rollback: async () => {} };
    }

    const id = await repoIdentity(absCwd);
    if (!id.isGit || !id.repoRoot || !id.checkoutRoot) {
      return { checkoutId: null, cwd: absCwd, recreated, env: {}, rollback: async () => {} };
    }

    if (!isCodingAgentPreset(input.preset)) {
      const existing = await this.db.checkout.findUnique({ where: { path: id.checkoutRoot } });
      const env = existing ? await this.buildEnv(existing) : { AH_WORKSPACE_ROOT: id.checkoutRoot, AH_REPO_ROOT: id.repoRoot };
      return { checkoutId: existing?.id ?? null, cwd: absCwd, recreated, env, rollback: async () => {} };
    }

    const claimed = await this.claimExistingCheckout({
      uid: input.uid,
      repoRoot: id.repoRoot,
      path: id.checkoutRoot,
      kind: id.isWorktree ? 'worktree' : 'main',
      branch: id.branch,
      headSha: id.headSha,
      trunkBranch: id.trunkBranch,
      // Resume, restore and crash recovery bring back every session that was there, together.
      shared: true,
    });
    const env = await this.buildEnv(claimed);
    this.bump();
    const rollback = async () => {
      await this.db.checkout
        .updateMany({
          where: { id: claimed.id, ownerUid: input.uid },
          data: { ownerUid: null, lifecycle: 'retained', lastActivityAt: this.now() },
        })
        .catch(() => {});
      this.bump();
    };
    return { checkoutId: claimed.id, cwd: absCwd, recreated, env, rollback };
  }

  /** Releases exclusive writer ownership when a session ends. */
  async releaseOwner(uid: string): Promise<void> {
    const res = await this.db.checkout.updateMany({
      where: { ownerUid: uid },
      data: { ownerUid: null, lifecycle: 'retained', lastActivityAt: this.now() },
    });
    if (res.count > 0) this.bump();
  }

  /** Transfers exclusive writer ownership across a session relaunch (old uid → new uid). */
  async transferOwner(fromUid: string, toUid: string): Promise<void> {
    const res = await this.db.checkout.updateMany({
      where: { ownerUid: fromUid },
      data: { ownerUid: toUid, lifecycle: 'active', lastActivityAt: this.now() },
    });
    if (res.count > 0) this.bump();
  }

  /**
   * Reconciles durable SQLite Checkout rows with tmux windows, registry records, and
   * on-disk Git worktrees: registers untracked ah worktrees, clears crashed owners,
   * and marks vanished checkouts as reclaimed.
   */
  async reconcile(): Promise<void> {
    if (this.reconcileInFlight) return this.reconcileInFlight;
    const task = this.reconcileOnce();
    this.reconcileInFlight = task;
    try {
      await task;
    } finally {
      this.lastReconcileAt = Date.now();
      if (this.reconcileInFlight === task) this.reconcileInFlight = null;
    }
  }

  private async reconcileOnce(): Promise<void> {
    const nowSec = this.now();
    const [live, records, rows] = await Promise.all([
      this.deps.liveWindows(),
      Promise.resolve(this.deps.records()),
      this.db.checkout.findMany(),
    ]);
    const { activeUids } = await this.activeWriterUids();

    const repos = new Set<string>();
    for (const r of rows) if (existsSync(r.repoRoot)) repos.add(r.repoRoot);
    for (const r of records) {
      if (r.worktree?.repo && existsSync(r.worktree.repo)) repos.add(resolve(r.worktree.repo));
    }
    for (const w of live) {
      const id = await repoIdentity(w.cwd);
      if (id.isGit && id.repoRoot) repos.add(id.repoRoot);
    }

    const byPath = new Map<string, CheckoutRow>(rows.map((r) => [resolve(r.path), r]));

    // Ensure every discovered repo's main checkout & managed worktrees are represented in SQLite.
    for (const repoRoot of repos) {
      const trunk = await detectTrunk(repoRoot);
      if (!byPath.has(repoRoot) && existsSync(repoRoot)) {
        const id = await repoIdentity(repoRoot);
        const created = await this.db.checkout
          .upsert({
            where: { path: repoRoot },
            create: {
              id: freshId(),
              repoRoot,
              path: repoRoot,
              kind: 'main',
              branch: id.branch,
              baseSha: id.headSha,
              baseBranch: trunk,
              ownerUid: null,
              lifecycle: 'retained',
              createdAt: nowSec,
              lastActivityAt: nowSec,
            },
            update: {},
          })
          .catch(() => null);
        if (created) byPath.set(repoRoot, created);
      }
    }

    const onDiskWorktrees = await worktreesOnDisk([...repos]);
    for (const wt of onDiskWorktrees) {
      const p = resolve(wt.path);
      if (byPath.has(p)) continue;
      const trunk = await detectTrunk(wt.repo);
      const ownerRec = records.find((r) => r.worktree?.path && resolve(r.worktree.path) === p && activeUids.has(r.id));
      // Found on disk (made by hand, or by ah before Checkouts): shown and owned, never reclaimed (managed: false).
      const created = await this.db.checkout
        .upsert({
          where: { path: p },
          create: {
            id: freshId(),
            repoRoot: resolve(wt.repo),
            path: p,
            kind: 'worktree',
            managed: false,
            branch: wt.branch,
            // Unknown base: overlaps measure from the merge-base with trunk.
            baseSha: '',
            baseBranch: trunk,
            ownerUid: ownerRec?.id ?? null,
            lifecycle: ownerRec ? 'active' : 'retained',
            createdAt: wt.lastActivityAt || nowSec,
            lastActivityAt: wt.lastActivityAt || nowSec,
          },
          update: {},
        })
        .catch(() => null);
      if (created) byPath.set(p, created);
    }

    // Reconcile ownership & existence for every row.
    let activeCount = 0;
    for (const row of byPath.values()) {
      const exists = existsSync(row.path);
      // Grace period for claims whose tmux window is still mid-launch between acquireForLaunch and Core.launch.
      const recentlyClaimed = !!row.ownerUid && nowSec - row.lastActivityAt < 10;
      const staleOwner = row.ownerUid && !activeUids.has(row.ownerUid) && !recentlyClaimed;
      const liveHere = live.filter((w) => w.cwd === row.path || w.cwd.startsWith(row.path + '/'));
      const liveWriter = liveHere.find((w) => w.agent && w.agent !== 'shell');

      let nextOwner = staleOwner || row.kind === 'main' ? null : row.ownerUid;
      if (!nextOwner && liveWriter && row.kind !== 'main') nextOwner = liveWriter.uid;

      let nextLifecycle: CheckoutLifecycle = row.lifecycle as CheckoutLifecycle;
      if (!exists && row.kind === 'worktree') {
        nextLifecycle = 'reclaimed';
        nextOwner = null;
      } else if (nextOwner || liveHere.length > 0) {
        nextLifecycle = 'active';
      } else if (nextLifecycle === 'active') {
        nextLifecycle = 'retained';
      }

      if (nextLifecycle === 'active') activeCount++;

      if (nextOwner !== row.ownerUid || nextLifecycle !== row.lifecycle) {
        await this.db.checkout
          .update({
            where: { id: row.id },
            data: {
              ownerUid: nextOwner,
              lifecycle: nextLifecycle,
              lastActivityAt: nextLifecycle === 'active' ? nowSec : row.lastActivityAt,
              ...(nextLifecycle === 'reclaimed' && !row.reclaimedAt ? { reclaimedAt: nowSec, portStart: null, portEnd: null } : {}),
            },
          })
          .catch(() => {});
      }
    }

    if (this.summary.active !== activeCount) {
      this.summary = { ...this.summary, active: activeCount };
    }
  }

  /** Full repository-level concurrency, overlap, and storage overview. */
  async list(repoFilter?: string): Promise<CheckoutsOverview> {
    return (await this.survey(repoFilter, true)).overview;
  }

  /**
   * The overview, plus the lifecycle facts it was classified from (the GC plans on those).
   * `measureAll` starts size measurements for every worktree (the overview shows them); the
   * sweep measures only those it may reclaim (ah's own), never walking the rest each time.
   */
  private async survey(repoFilter?: string, measureAll = false): Promise<{
    overview: CheckoutsOverview;
    planItems: Array<LifecycleFacts & { classification: LifecycleClassification }>;
  }> {
    await this.reconcile();
    const nowSec = this.now();
    const policy = this.deps.config();
    const [live, records, rows] = await Promise.all([
      this.deps.liveWindows(),
      Promise.resolve(this.deps.records()),
      this.db.checkout.findMany({
        ...(repoFilter ? { where: { repoRoot: resolve(repoFilter) } } : {}),
        orderBy: [{ createdAt: 'desc' }],
      }),
    ]);

    const liveByUid = new Map(live.map((w) => [w.uid, w]));
    const recByUid = new Map(records.map((r) => [r.id, r]));

    // Cache trunk per repo.
    const trunkByRepo = new Map<string, string>();
    for (const repo of new Set(rows.map((r) => r.repoRoot))) {
      trunkByRepo.set(repo, existsSync(repo) ? await detectTrunk(repo) : 'main');
    }

    // Gather live git facts + cached disk sizes for every row.
    type Enriched = {
      row: CheckoutRow;
      exists: boolean;
      branch: string | null;
      dirty: number;
      ahead: number;
      merged: boolean;
      changedFiles: string[];
      integration: IntegrationStatus | null;
      liveSessions: LiveSessionFact[];
      facts: LifecycleFacts;
      classification: ReturnType<typeof classifyLifecycle>;
      sizePartial: boolean;
      sizeTooLarge: boolean;
    };

    const enriched: Enriched[] = await Promise.all(
      rows.map(async (row) => {
        const exists = existsSync(row.path);
        const trunk = trunkByRepo.get(row.repoRoot) ?? row.baseBranch ?? 'main';
        const saved = parseStatus(row.statusJson);

        let dirty = 0;
        let ahead = 0;
        let changedFiles: string[] = [];
        let branch = row.branch;
        let merged = false;

        if (exists) {
          const info = await changedFilesSinceBase(row.path, row.baseSha, trunk);
          dirty = info.dirty;
          ahead = info.ahead;
          changedFiles = info.files;
          branch = info.branch ?? row.branch;
          if (row.kind === 'worktree') {
            merged = await isBranchMerged(row.repoRoot, branch, trunk, row.baseSha);
            if (measureAll || row.managed) requestSize(row.path);
          }
        }

        const size = exists && row.kind === 'worktree' ? cachedSize(row.path) : null;
        const mtime = exists ? await stat(row.path).then((s) => Math.floor(s.mtimeMs / 1000)).catch(() => 0) : 0;

        const liveSessions = live.filter(
          (w) =>
            w.cwd === row.path ||
            w.cwd.startsWith(row.path + '/') ||
            w.uid === row.ownerUid,
        );
        const relatedRecs = records.filter(
          (r) =>
            r.id === row.ownerUid ||
            (r.worktree?.path && resolve(r.worktree.path) === row.path) ||
            resolve(r.cwd) === row.path,
        );
        const hasActiveOwner = !!row.ownerUid && (liveByUid.has(row.ownerUid) || recByUid.get(row.ownerUid)?.lifecycle === 'starting');
        const hasLiveProcess = liveSessions.length > 0;
        const hasResumableSession = relatedRecs.some((r) => !!r.harnessId || r.lifecycle === 'starting');
        const lastActivityAt = Math.max(
          row.lastActivityAt,
          mtime,
          ...relatedRecs.map((r) => r.lastActivityAt),
        );

        const facts: LifecycleFacts = {
          id: row.id,
          kind: row.kind as CheckoutKind,
          managed: row.managed,
          exists,
          pinned: row.pinned,
          hasActiveOwner,
          hasLiveProcess,
          hasResumableSession,
          dirty,
          merged,
          lastActivityAt,
          sizeBytes: size?.sizeBytes ?? null,
        };
        const classification = classifyLifecycle(facts, policy, nowSec);

        return {
          row,
          exists,
          branch,
          dirty,
          ahead,
          merged,
          changedFiles,
          integration: saved.integration ?? null,
          liveSessions,
          facts,
          classification,
          sizePartial: size?.partial ?? false,
          sizeTooLarge: size?.tooLarge ?? false,
        };
      }),
    );

    const overlapsMap = computeOverlaps(
      enriched.map((e) => {
        const ownerLive = e.row.ownerUid ? liveByUid.get(e.row.ownerUid) : undefined;
        const ownerRec = e.row.ownerUid ? recByUid.get(e.row.ownerUid) : undefined;
        return {
          id: e.row.id,
          repoRoot: e.row.repoRoot,
          branch: e.branch,
          ownerUid: e.row.ownerUid,
          ownerTitle: ownerLive?.title ?? ownerLive?.name ?? ownerRec?.title ?? null,
          lifecycle: e.classification.lifecycle,
          changedFiles: e.changedFiles,
        };
      }),
    );

    const sampleDir = enriched.find((e) => e.exists)?.row.repoRoot ?? this.deps.tempRoot;
    const freeBytes = await diskFreeBytes(existsSync(sampleDir) ? sampleDir : process.cwd());
    const planItems = enriched.map((e) => ({ ...e.facts, classification: e.classification }));
    const hostPlan = planReclamation(planItems, policy, freeBytes);
    const hostStorage = summarizeStorage(planItems, hostPlan, policy, freeBytes);
    const hostReclaimSet = new Set(hostPlan.candidates.map((c) => c.id));

    const checkouts: CheckoutView[] = enriched.map((e) => {
      const ownerUid = e.row.ownerUid;
      const ownerLive = ownerUid ? liveByUid.get(ownerUid) : undefined;
      const ownerRec = ownerUid ? recByUid.get(ownerUid) : undefined;
      return {
        id: e.row.id,
        repoRoot: e.row.repoRoot,
        repoName: basename(e.row.repoRoot),
        path: e.row.path,
        kind: e.row.kind as CheckoutKind,
        managed: e.row.managed,
        branch: e.branch,
        baseSha: e.row.baseSha,
        baseBranch: e.row.baseBranch || trunkByRepo.get(e.row.repoRoot) || 'main',
        lifecycle: e.classification.lifecycle,
        pinned: e.row.pinned,
        exists: e.exists,
        owner: ownerUid
          ? {
              uid: ownerUid,
              title: ownerLive?.title ?? ownerLive?.name ?? ownerRec?.title ?? ownerUid,
              agent: ownerLive?.agent ?? ownerRec?.harness ?? 'agent',
              status: ownerLive?.status ?? (ownerRec?.lifecycle === 'starting' ? 'busy' : 'ended'),
              live: !!ownerLive,
            }
          : null,
        liveSessions: e.liveSessions.map((w) => ({ uid: w.uid, id: w.id, name: w.name, agent: w.agent, status: w.status })),
        dirty: e.dirty,
        ahead: e.ahead,
        merged: e.merged,
        changedFiles: e.changedFiles,
        overlaps: overlapsMap.get(e.row.id) ?? [],
        integration: e.integration,
        ports: e.row.portStart !== null && e.row.portEnd !== null ? { start: e.row.portStart, end: e.row.portEnd } : null,
        sizeBytes: e.facts.sizeBytes,
        sizePartial: e.sizePartial,
        sizeTooLarge: e.sizeTooLarge,
        reclaimable: e.classification.eligibleNow || hostReclaimSet.has(e.row.id),
        reclaimReason: e.classification.reason,
        createdAt: e.row.createdAt,
        lastActivityAt: e.facts.lastActivityAt,
        archivedAt: e.row.archivedAt,
        reclaimedAt: e.row.reclaimedAt,
      };
    });

    // Group into RepositoryConcurrencyViews.
    const byRepo = new Map<string, { views: CheckoutView[]; planItems: typeof planItems }>();
    for (let i = 0; i < checkouts.length; i++) {
      const c = checkouts[i];
      const bucket = byRepo.get(c.repoRoot) ?? { views: [], planItems: [] };
      bucket.views.push(c);
      bucket.planItems.push(planItems[i]);
      byRepo.set(c.repoRoot, bucket);
    }

    const repositories: RepositoryConcurrencyView[] = [...byRepo.entries()]
      .map(([repoRoot, bucket]) => {
        const repoPlan = planReclamation(bucket.planItems, policy, freeBytes);
        const repoStorage = summarizeStorage(bucket.planItems, repoPlan, policy, freeBytes);
        // Count unique overlapping pairs within the repo.
        const overlapPairs = new Set<string>();
        for (const c of bucket.views) {
          for (const ov of c.overlaps) overlapPairs.add([c.id, ov.checkoutId].sort().join(':'));
        }
        return {
          repoRoot,
          name: basename(repoRoot),
          trunk: trunkByRepo.get(repoRoot) ?? 'main',
          activeCount: bucket.views.filter((c) => c.lifecycle === 'active').length,
          overlapCount: overlapPairs.size,
          checkouts: bucket.views.sort((a, b) => Number(a.kind === 'main') - Number(b.kind === 'main') || b.lastActivityAt - a.lastActivityAt),
          storage: repoStorage,
        };
      })
      .sort((a, b) => b.activeCount - a.activeCount || a.name.localeCompare(b.name));

    const totalOverlaps = repositories.reduce((n, r) => n + r.overlapCount, 0);
    this.summary = {
      revision: this.revision,
      active: checkouts.filter((c) => c.lifecycle === 'active').length,
      overlaps: totalOverlaps,
      reclaimableCount: hostStorage.counts.reclaimable,
      reclaimableBytes: hostStorage.reclaimableBytes,
    };

    return { overview: { repositories, checkouts, storage: hostStorage, policy }, planItems };
  }

  /** Fetches a single checkout view by id. */
  async get(id: string): Promise<CheckoutView> {
    const row = await this.db.checkout.findUnique({ where: { id } });
    if (!row) throw new CheckoutError(404, 'checkout_not_found', 'No checkout with that id.');
    const overview = await this.list(row.repoRoot);
    const view = overview.checkouts.find((c) => c.id === id);
    if (!view) throw new CheckoutError(404, 'checkout_not_found', 'No checkout with that id.');
    return view;
  }

  /** Pins or unpins a checkout (pinned checkouts are exempt from automatic GC). */
  async setPinned(id: string, pinned: boolean): Promise<CheckoutView> {
    const row = await this.db.checkout.findUnique({ where: { id } });
    if (!row) throw new CheckoutError(404, 'checkout_not_found', 'No checkout with that id.');
    await this.db.checkout.update({ where: { id }, data: { pinned } });
    this.bump();
    return this.get(id);
  }

  /** Runs a non-destructive `git merge-tree --write-tree` check against trunk and persists the verdict. */
  async checkIntegration(id: string): Promise<CheckoutView> {
    const row = await this.db.checkout.findUnique({ where: { id } });
    if (!row) throw new CheckoutError(404, 'checkout_not_found', 'No checkout with that id.');
    if (!existsSync(row.repoRoot)) throw new CheckoutError(404, 'checkout_not_found', 'Repository directory no longer exists.');
    const trunk = await detectTrunk(row.repoRoot);
    const branch = row.branch || trunk;
    const integration = await checkMergeCompatibility(row.repoRoot, trunk, branch);
    const prev = parseStatus(row.statusJson);
    await this.db.checkout.update({
      where: { id },
      data: { statusJson: JSON.stringify({ ...prev, integration }) },
    });
    this.bump();
    return this.get(id);
  }

  /** Recreates a reclaimed worktree checkout from its preserved branch/commit. */
  async recreate(id: string): Promise<CheckoutView> {
    const row = await this.db.checkout.findUnique({ where: { id } });
    if (!row) throw new CheckoutError(404, 'checkout_not_found', 'No checkout with that id.');
    if (row.kind === 'main') return this.get(id);
    if (!existsSync(row.path)) {
      try {
        await recreateWorktree(row.repoRoot, row.path, row.branch, row.baseSha);
      } catch (err) {
        throw new CheckoutError(409, 'checkout_branch_missing', `Cannot recreate checkout: ${(err as Error).message}`);
      }
    }
    await this.db.$transaction(async (tx) => {
      const ports = row.portStart === null ? await this.nextPortBlock(tx) : null;
      await tx.checkout.update({
        where: { id },
        data: {
          lifecycle: 'retained',
          reclaimedAt: null,
          lastActivityAt: this.now(),
          ...(ports ? { portStart: ports.portStart, portEnd: ports.portEnd } : {}),
        },
      });
    });
    this.bump();
    return this.get(id);
  }

  /** Manually removes a managed worktree checkout after fresh revalidation; preserves its Git branch. */
  async remove(id: string, force: boolean): Promise<{ id: string; path: string; reclaimedBytes: number }> {
    const row = await this.db.checkout.findUnique({ where: { id } });
    if (!row) throw new CheckoutError(404, 'checkout_not_found', 'No checkout with that id.');
    if (row.kind === 'main') {
      throw new CheckoutError(409, 'checkout_main_protected', 'The canonical repository checkout cannot be removed.');
    }
    const [live, records] = await Promise.all([this.deps.liveWindows(), Promise.resolve(this.deps.records())]);
    const inUse =
      live.some((w) => w.uid === row.ownerUid || w.cwd === row.path || w.cwd.startsWith(row.path + '/')) ||
      records.some((r) => r.id === row.ownerUid && r.lifecycle === 'starting') ||
      (await pathInUse(row.path));
    if (inUse) {
      throw new CheckoutError(409, 'checkout_busy', 'An active session is currently using this checkout.');
    }
    if (row.pinned && !force) {
      throw new CheckoutError(409, 'checkout_pinned', 'This checkout is pinned. Unpin it or force removal.');
    }

    const reclaimedBytes = existsSync(row.path) ? (cachedSize(row.path)?.sizeBytes ?? 0) : 0;
    if (existsSync(row.path)) {
      try {
        await removeWorktree(row.path, force);
      } catch (err) {
        const msg = (err as Error).message;
        if (/uncommitted changes/i.test(msg)) {
          throw new CheckoutError(409, 'checkout_dirty', 'Checkout has uncommitted changes. Commit, archive, or remove with force.');
        }
        throw err;
      }
      await pruneWorktrees(row.repoRoot);
      invalidateSize(row.path);
    }
    if (row.tempDir) await rm(row.tempDir, { recursive: true, force: true }).catch(() => {});

    await this.db.checkout.update({
      where: { id },
      data: {
        ownerUid: null,
        lifecycle: 'reclaimed',
        reclaimedAt: this.now(),
        portStart: null,
        portEnd: null,
      },
    });
    this.bump();
    return { id: row.id, path: row.path, reclaimedBytes };
  }

  /**
   * Automatic garbage collection sweep (policy retention + disk budget + disk pressure).
   * Revalidates ownership, live sessions, pins, and dirty state immediately before every
   * deletion, and NEVER uses `--force` or discards dirty/active/pinned/main checkouts.
   */
  async runGc(options: { dryRun?: boolean } = {}): Promise<GcRunResult> {
    if (this.gcInFlight && !options.dryRun) return this.gcInFlight;
    const task = this.runGcOnce(!!options.dryRun);
    if (!options.dryRun) this.gcInFlight = task;
    try {
      return await task;
    } finally {
      if (this.gcInFlight === task) this.gcInFlight = null;
    }
  }

  private async runGcOnce(dryRun: boolean): Promise<GcRunResult> {
    const { overview, planItems } = await this.survey();
    const policy = this.deps.config();
    const freeBytes = overview.storage.diskFreeBytes;
    const plan = planReclamation(planItems, policy, freeBytes);
    const byId = new Map(overview.checkouts.map((c) => [c.id, c]));

    if (dryRun) {
      const planned: GcItemResult[] = plan.candidates.map((cand) => {
        const c = byId.get(cand.id);
        return {
          id: cand.id,
          path: c?.path ?? '',
          branch: c?.branch ?? null,
          reason: cand.reason,
          reclaimedBytes: cand.sizeBytes,
          ok: true,
        };
      });
      return {
        dryRun: true,
        reclaimed: planned,
        skipped: [],
        reclaimedBytes: planned.reduce((n, r) => n + r.reclaimedBytes, 0),
        underPressure: plan.underPressure,
        overBudget: plan.overBudget,
        diskFreeBytes: freeBytes,
      };
    }

    const reclaimed: GcItemResult[] = [];
    const skipped: GcItemResult[] = [];
    const prunedRepos = new Set<string>();

    for (const cand of plan.candidates) {
      const freshRow = await this.db.checkout.findUnique({ where: { id: cand.id } });
      if (!freshRow || freshRow.kind === 'main' || !freshRow.managed || freshRow.pinned || !existsSync(freshRow.path)) {
        skipped.push({
          id: cand.id,
          path: freshRow?.path ?? '',
          branch: freshRow?.branch ?? null,
          reason: cand.reason,
          reclaimedBytes: 0,
          ok: false,
          error: !freshRow ? 'gone' : freshRow.pinned ? 'pinned' : !freshRow.managed || freshRow.kind === 'main' ? 'not made by ah' : 'already removed',
        });
        continue;
      }

      // Fresh revalidation right before removal: live windows, starting records, dirty git status.
      const [live, records] = await Promise.all([this.deps.liveWindows(), Promise.resolve(this.deps.records())]);
      const busy =
        live.some((w) => w.uid === freshRow.ownerUid || w.cwd === freshRow.path || w.cwd.startsWith(freshRow.path + '/')) ||
        records.some((r) => r.id === freshRow.ownerUid && r.lifecycle === 'starting') ||
        // A dev server, editor or simulator started there outlives its tmux window.
        (await pathInUse(freshRow.path));
      if (busy) {
        skipped.push({ id: freshRow.id, path: freshRow.path, branch: freshRow.branch, reason: cand.reason, reclaimedBytes: 0, ok: false, error: 'came back into use' });
        continue;
      }
      const trunk = await detectTrunk(freshRow.repoRoot);
      const gitState = await changedFilesSinceBase(freshRow.path, freshRow.baseSha, trunk);
      if (gitState.dirty > 0) {
        skipped.push({ id: freshRow.id, path: freshRow.path, branch: freshRow.branch, reason: cand.reason, reclaimedBytes: 0, ok: false, error: 'uncommitted changes appeared' });
        continue;
      }

      const bytes = cachedSize(freshRow.path)?.sizeBytes ?? cand.sizeBytes;
      try {
        // Automatic GC NEVER passes force=true.
        await removeWorktree(freshRow.path, false);
        prunedRepos.add(freshRow.repoRoot);
        invalidateSize(freshRow.path);
        // A branch ah made that never got a commit is noise; one with work stays for resume.
        await deleteUnusedBranch(freshRow.repoRoot, freshRow.branch, freshRow.baseSha).catch(() => {});
        if (freshRow.tempDir) await rm(freshRow.tempDir, { recursive: true, force: true }).catch(() => {});
        await this.db.checkout.update({
          where: { id: freshRow.id },
          data: {
            ownerUid: null,
            lifecycle: 'reclaimed',
            reclaimedAt: this.now(),
            portStart: null,
            portEnd: null,
          },
        });
        reclaimed.push({ id: freshRow.id, path: freshRow.path, branch: freshRow.branch, reason: cand.reason, reclaimedBytes: bytes, ok: true });
      } catch (err) {
        skipped.push({ id: freshRow.id, path: freshRow.path, branch: freshRow.branch, reason: cand.reason, reclaimedBytes: 0, ok: false, error: (err as Error).message });
      }
    }

    for (const repo of prunedRepos) await pruneWorktrees(repo);
    if (reclaimed.length > 0) this.bump();

    return {
      dryRun: false,
      reclaimed,
      skipped,
      reclaimedBytes: reclaimed.reduce((n, r) => n + r.reclaimedBytes, 0),
      underPressure: plan.underPressure,
      overBudget: plan.overBudget,
      diskFreeBytes: freeBytes,
    };
  }
}
