// Checkouts' functional core (docs/spec/18-checkouts.md): pure decisions, lifecycle
// transitions, ownership checks, overlap detection, port allocation, and GC planning.
// Zero I/O: tested directly with plain values.
import { DomainError } from '../errors.ts';
import type { CheckoutsConfig } from './settings.ts';

export type CheckoutKind = 'main' | 'worktree';
export type CheckoutLifecycle = 'active' | 'retained' | 'archived' | 'reclaimed';

export type CheckoutErrorCode =
  | 'checkout_owned'
  | 'checkout_not_found'
  | 'checkout_busy'
  | 'checkout_dirty'
  | 'checkout_main_protected'
  | 'checkout_pinned'
  | 'checkout_branch_missing'
  | 'checkout_unborn_repo';

export class CheckoutError extends DomainError {
  declare readonly code: CheckoutErrorCode;
  readonly detail?: Record<string, unknown>;

  constructor(status: number, code: CheckoutErrorCode, message: string, detail?: Record<string, unknown>) {
    super(status, message, code);
    this.detail = detail;
  }
}

export type IntegrationStatus = {
  checkedAt: number;
  trunk: string;
  trunkSha: string;
  clean: boolean;
  conflicts: string[];
  error?: string;
};

export type CheckoutStatusSnapshot = {
  dirty?: number;
  ahead?: number;
  merged?: boolean;
  changedFiles?: string[];
  integration?: IntegrationStatus | null;
};

export type CheckoutOverlap = {
  checkoutId: string;
  branch: string | null;
  ownerUid: string | null;
  ownerTitle: string | null;
  files: string[];
};

export type CheckoutsState = {
  revision: number;
  active: number;
  overlaps: number;
  reclaimableCount: number;
  reclaimableBytes: number;
};

/** Whether a preset represents a writable coding agent (vs. a plain shell). */
export function isCodingAgentPreset(preset: { id: string; command: string }): boolean {
  return preset.id !== 'shell' && preset.command.trim().length > 0;
}

export type AutoIsolateInput = {
  config: Pick<CheckoutsConfig, 'autoIsolate'>;
  preset: { id: string; command: string };
  isGitRepo: boolean;
  hasHead: boolean;
  creatingDir: boolean;
  resumingInPlace: boolean;
  /** Caller's explicit choice: true forces worktree, false forces in-place, undefined uses default policy. */
  explicitWorktree?: boolean;
};

export type IsolationDecision =
  | { isolate: true }
  | { isolate: false; reason: 'disabled' | 'shell' | 'not_git' | 'unborn_repo' | 'creating_dir' | 'resuming' | 'explicit_opt_out' };

/** Pure policy: should this new session launch automatically get its own managed worktree? */
export function shouldAutoIsolate(input: AutoIsolateInput): IsolationDecision {
  if (input.creatingDir) return { isolate: false, reason: 'creating_dir' };
  if (input.resumingInPlace) return { isolate: false, reason: 'resuming' };
  if (input.explicitWorktree === false) return { isolate: false, reason: 'explicit_opt_out' };
  if (input.explicitWorktree === true) {
    if (!input.isGitRepo) return { isolate: false, reason: 'not_git' };
    if (!input.hasHead) return { isolate: false, reason: 'unborn_repo' };
    return { isolate: true };
  }
  if (!input.config.autoIsolate) return { isolate: false, reason: 'disabled' };
  if (!isCodingAgentPreset(input.preset)) return { isolate: false, reason: 'shell' };
  if (!input.isGitRepo) return { isolate: false, reason: 'not_git' };
  if (!input.hasHead) return { isolate: false, reason: 'unborn_repo' };
  return { isolate: true };
}

export type OwnershipCheck =
  | { ok: true; staleOwner: string | null }
  | { ok: false; ownerUid: string };

/**
 * Pure exclusive writer check: at most one live/starting writing session may own a
 * checkout at a time. A requester that already owns it is allowed (e.g. resume/relaunch),
 * as is an explicit hand-off (`handOffFromUid`) from the current owner (e.g. Continue in).
 * An owner no longer in `activeUids` is stale and may be safely reclaimed.
 */
export function evaluateOwnership(
  currentOwnerUid: string | null,
  requesterUid: string,
  activeUids: ReadonlySet<string>,
  handOffFromUid?: string | null,
): OwnershipCheck {
  if (!currentOwnerUid || currentOwnerUid === requesterUid) return { ok: true, staleOwner: null };
  if (handOffFromUid && currentOwnerUid === handOffFromUid) return { ok: true, staleOwner: null };
  if (!activeUids.has(currentOwnerUid)) return { ok: true, staleOwner: currentOwnerUid };
  return { ok: false, ownerUid: currentOwnerUid };
}

export type LifecycleFacts = {
  id: string;
  kind: CheckoutKind;
  /** ah made this worktree for a session; one found on disk (made by hand or before Checkouts) is never reclaimed automatically. */
  managed: boolean;
  exists: boolean;
  pinned: boolean;
  hasActiveOwner: boolean;
  hasLiveProcess: boolean;
  hasResumableSession: boolean;
  dirty: number;
  merged: boolean;
  lastActivityAt: number;
  sizeBytes: number | null;
};

export type LifecycleClassification = {
  lifecycle: CheckoutLifecycle;
  /** Eligible under normal retention timers right now. */
  eligibleNow: boolean;
  /** Safe to reclaim immediately under disk pressure or disk budget (clean, unpinned, inactive). */
  eligibleUnderPressure: boolean;
  reason:
    | 'main_checkout'
    | 'active'
    | 'reclaimed'
    | 'pinned'
    | 'adopted'
    | 'dirty'
    | 'merged_expired'
    | 'merged_grace'
    | 'unmerged_expired'
    | 'retained_resumable'
    | 'retained_window';
};

/** Disk pressure never takes a checkout that was in use within the last hour. */
export const PRESSURE_MIN_IDLE_SEC = 3600;

/**
 * Evaluates a checkout's lifecycle state and reclamation eligibility from fresh facts.
 * Invariant: main checkouts, active/in-use checkouts, worktrees ah didn't make, pinned
 * checkouts and dirty checkouts are NEVER eligible for automatic reclamation — not even
 * under disk pressure. A resumable session's checkout waits out its retention window.
 */
export function classifyLifecycle(
  f: LifecycleFacts,
  policy: Pick<CheckoutsConfig, 'mergedRetentionHours' | 'unmergedRetentionDays'>,
  nowSec: number,
): LifecycleClassification {
  if (f.kind === 'main') {
    return {
      lifecycle: f.hasActiveOwner || f.hasLiveProcess ? 'active' : 'retained',
      eligibleNow: false,
      eligibleUnderPressure: false,
      reason: 'main_checkout',
    };
  }
  if (!f.exists) {
    return { lifecycle: 'reclaimed', eligibleNow: false, eligibleUnderPressure: false, reason: 'reclaimed' };
  }
  if (f.hasActiveOwner || f.hasLiveProcess) {
    return { lifecycle: 'active', eligibleNow: false, eligibleUnderPressure: false, reason: 'active' };
  }
  if (!f.managed) {
    return { lifecycle: 'retained', eligibleNow: false, eligibleUnderPressure: false, reason: 'adopted' };
  }
  if (f.pinned) {
    return { lifecycle: 'retained', eligibleNow: false, eligibleUnderPressure: false, reason: 'pinned' };
  }
  if (f.dirty > 0) {
    return { lifecycle: 'retained', eligibleNow: false, eligibleUnderPressure: false, reason: 'dirty' };
  }

  const idleSec = Math.max(0, nowSec - f.lastActivityAt);
  const mergedSec = Math.max(0, policy.mergedRetentionHours) * 3600;
  const unmergedSec = Math.max(0, policy.unmergedRetentionDays) * 86400;
  // Pressure may cut a retention window short, but never for a conversation that can still be
  // resumed, nor for a checkout in use within the hour.
  const pressureOk = !f.hasResumableSession && idleSec >= PRESSURE_MIN_IDLE_SEC;

  if (f.merged) {
    if (idleSec >= mergedSec) {
      return { lifecycle: 'archived', eligibleNow: true, eligibleUnderPressure: true, reason: 'merged_expired' };
    }
    return { lifecycle: 'archived', eligibleNow: false, eligibleUnderPressure: pressureOk, reason: 'merged_grace' };
  }

  if (idleSec >= unmergedSec) {
    return { lifecycle: 'retained', eligibleNow: true, eligibleUnderPressure: true, reason: 'unmerged_expired' };
  }

  // Clean, unmerged, unpinned, inactive: retained during the window. Under disk pressure it may
  // go early (its commits stay on its branch and resume recreates it), unless resumable or recent.
  return {
    lifecycle: 'retained',
    eligibleNow: false,
    eligibleUnderPressure: pressureOk,
    reason: f.hasResumableSession ? 'retained_resumable' : 'retained_window',
  };
}

export type ReclamationCandidate = {
  id: string;
  reason: 'policy' | 'budget' | 'pressure';
  sizeBytes: number;
  lastActivityAt: number;
};

export type ReclamationPlan = {
  candidates: ReclamationCandidate[];
  underPressure: boolean;
  overBudget: boolean;
  reclaimableCount: number;
  reclaimableBytes: number;
};

/**
 * Pure oldest-eligible-first GC planner:
 * 1. Schedules everything eligible under normal retention timers (`policy`).
 * 2. If disk free space is below `minFreeBytes` (`pressure`) or remaining managed bytes
 *    exceed `diskBudgetBytes` (`budget`), schedules additional clean/unpinned/inactive
 *    checkouts oldest-first until thresholds are satisfied.
 */
export function planReclamation(
  items: Array<LifecycleFacts & { classification: LifecycleClassification }>,
  policy: Pick<CheckoutsConfig, 'diskBudgetBytes' | 'minFreeBytes'>,
  diskFreeBytes: number | null,
): ReclamationPlan {
  const worktrees = items.filter((i) => i.kind === 'worktree' && i.exists);
  // The budget is over what ah could reclaim: a worktree made by hand can't be, so it doesn't count.
  const managedBytes = worktrees.filter((i) => i.managed).reduce((n, i) => n + (i.sizeBytes ?? 0), 0);
  const candidates: ReclamationCandidate[] = [];
  const picked = new Set<string>();

  const byOldest = [...worktrees].sort((a, b) => a.lastActivityAt - b.lastActivityAt || a.id.localeCompare(b.id));

  for (const item of byOldest) {
    if (item.classification.eligibleNow) {
      picked.add(item.id);
      candidates.push({
        id: item.id,
        reason: 'policy',
        sizeBytes: item.sizeBytes ?? 0,
        lastActivityAt: item.lastActivityAt,
      });
    }
  }

  const totalBytes = managedBytes;
  let reclaimedSoFar = candidates.reduce((n, c) => n + c.sizeBytes, 0);
  const underPressure = policy.minFreeBytes !== null && diskFreeBytes !== null && diskFreeBytes < policy.minFreeBytes;
  const overBudget = policy.diskBudgetBytes !== null && totalBytes > policy.diskBudgetBytes;

  if (underPressure || overBudget) {
    for (const item of byOldest) {
      // An unmeasured size can't show progress toward the threshold: skip it rather than take everything.
      if (picked.has(item.id) || !item.classification.eligibleUnderPressure || item.sizeBytes === null) continue;
      const stillPressure = policy.minFreeBytes !== null && diskFreeBytes !== null && diskFreeBytes + reclaimedSoFar < policy.minFreeBytes;
      const stillBudget = policy.diskBudgetBytes !== null && totalBytes - reclaimedSoFar > policy.diskBudgetBytes;
      if (!stillPressure && !stillBudget) break;
      picked.add(item.id);
      const size = item.sizeBytes ?? 0;
      reclaimedSoFar += size;
      candidates.push({
        id: item.id,
        reason: stillPressure ? 'pressure' : 'budget',
        sizeBytes: size,
        lastActivityAt: item.lastActivityAt,
      });
    }
  }

  const reclaimableItems = worktrees.filter((i) => picked.has(i.id));
  return {
    candidates,
    underPressure,
    overBudget,
    reclaimableCount: reclaimableItems.length,
    reclaimableBytes: reclaimableItems.reduce((n, i) => n + (i.sizeBytes ?? 0), 0),
  };
}

// What the routes answer (GET /api/checkouts …), shared with the web client.
export type CheckoutView = {
  id: string;
  repoRoot: string;
  repoName: string;
  path: string;
  kind: CheckoutKind;
  /** ah made it for a session (only these are reclaimed automatically); false for one found on disk. */
  managed: boolean;
  branch: string | null;
  baseSha: string;
  baseBranch: string;
  lifecycle: CheckoutLifecycle;
  pinned: boolean;
  exists: boolean;
  owner: { uid: string; title: string; agent: string; status: string; live: boolean } | null;
  liveSessions: Array<{ uid: string; id: string; name: string; agent: string | null; status: string }>;
  dirty: number;
  ahead: number;
  merged: boolean;
  changedFiles: string[];
  overlaps: CheckoutOverlap[];
  integration: IntegrationStatus | null;
  ports: { start: number; end: number } | null;
  sizeBytes: number | null;
  sizePartial: boolean;
  sizeTooLarge: boolean;
  reclaimable: boolean;
  reclaimReason: string;
  createdAt: number;
  lastActivityAt: number;
  archivedAt: number | null;
  reclaimedAt: number | null;
};

export type RepositoryConcurrencyView = {
  repoRoot: string;
  name: string;
  trunk: string;
  activeCount: number;
  overlapCount: number;
  checkouts: CheckoutView[];
  storage: StorageSummary;
};

export type CheckoutsOverview = {
  repositories: RepositoryConcurrencyView[];
  checkouts: CheckoutView[];
  storage: StorageSummary;
  policy: CheckoutsConfig;
};

export type GcItemResult = {
  id: string;
  path: string;
  branch: string | null;
  reason: 'policy' | 'budget' | 'pressure';
  reclaimedBytes: number;
  ok: boolean;
  error?: string;
};

export type GcRunResult = {
  dryRun: boolean;
  reclaimed: GcItemResult[];
  skipped: GcItemResult[];
  reclaimedBytes: number;
  underPressure: boolean;
  overBudget: boolean;
  diskFreeBytes: number | null;
};

export type OverlapInput = {
  id: string;
  repoRoot: string;
  branch: string | null;
  ownerUid: string | null;
  ownerTitle: string | null;
  lifecycle: CheckoutLifecycle;
  changedFiles: string[];
};

/** Computes pairwise file overlaps across non-reclaimed checkouts of the same repository. */
export function computeOverlaps(checkouts: OverlapInput[]): Map<string, CheckoutOverlap[]> {
  const result = new Map<string, CheckoutOverlap[]>();
  for (const c of checkouts) result.set(c.id, []);

  const byRepo = new Map<string, OverlapInput[]>();
  for (const c of checkouts) {
    if (c.lifecycle === 'reclaimed' || c.changedFiles.length === 0) continue;
    const list = byRepo.get(c.repoRoot) ?? [];
    list.push(c);
    byRepo.set(c.repoRoot, list);
  }

  for (const group of byRepo.values()) {
    if (group.length < 2) continue;
    const sets = group.map((c) => new Set(c.changedFiles));
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const shared: string[] = [];
        for (const f of sets[i]) {
          if (sets[j].has(f)) shared.push(f);
        }
        if (!shared.length) continue;
        shared.sort();
        const a = group[i];
        const b = group[j];
        result.get(a.id)!.push({
          checkoutId: b.id,
          branch: b.branch,
          ownerUid: b.ownerUid,
          ownerTitle: b.ownerTitle,
          files: shared,
        });
        result.get(b.id)!.push({
          checkoutId: a.id,
          branch: a.branch,
          ownerUid: a.ownerUid,
          ownerTitle: a.ownerTitle,
          files: shared,
        });
      }
    }
  }
  return result;
}

/** Allocates the first non-overlapping contiguous port block within `portRange`, or null if exhausted. */
export function allocatePortBlock(
  used: Array<{ portStart: number; portEnd: number }>,
  config: Pick<CheckoutsConfig, 'portRange' | 'portsPerCheckout'>,
): { portStart: number; portEnd: number } | null {
  const [lo, hi] = config.portRange;
  const width = Math.max(1, Math.floor(config.portsPerCheckout));
  for (let start = lo; start + width - 1 <= hi; start += width) {
    const end = start + width - 1;
    const collides = used.some((u) => !(end < u.portStart || start > u.portEnd));
    if (!collides) return { portStart: start, portEnd: end };
  }
  return null;
}

export type StorageSummary = {
  totalBytes: number;
  activeBytes: number;
  retainedBytes: number;
  reclaimableBytes: number;
  counts: { total: number; active: number; retained: number; archived: number; reclaimed: number; reclaimable: number };
  gcEnabled: boolean;
  diskFreeBytes: number | null;
  diskBudgetBytes: number | null;
  minFreeBytes: number | null;
  underPressure: boolean;
  overBudget: boolean;
};

/** Summarizes storage consumption across managed worktree checkouts for the repository or host view. */
export function summarizeStorage(
  items: Array<LifecycleFacts & { classification: LifecycleClassification }>,
  plan: ReclamationPlan,
  policy: Pick<CheckoutsConfig, 'gcEnabled' | 'diskBudgetBytes' | 'minFreeBytes'>,
  diskFreeBytes: number | null,
): StorageSummary {
  let totalBytes = 0;
  let activeBytes = 0;
  let retainedBytes = 0;
  let reclaimableBytes = 0;
  const counts = { total: 0, active: 0, retained: 0, archived: 0, reclaimed: 0, reclaimable: 0 };

  const reclaimSet = new Set(plan.candidates.map((c) => c.id));
  for (const item of items) {
    if (item.kind !== 'worktree') continue;
    const lc = item.classification.lifecycle;
    if (lc === 'reclaimed') {
      counts.reclaimed++;
      continue;
    }
    counts.total++;
    const size = item.sizeBytes ?? 0;
    totalBytes += size;
    const isReclaimable = item.classification.eligibleNow || reclaimSet.has(item.id);
    if (lc === 'active') {
      counts.active++;
      activeBytes += size;
    } else if (isReclaimable) {
      if (lc === 'archived') counts.archived++;
      else counts.retained++;
      counts.reclaimable++;
      reclaimableBytes += size;
    } else if (lc === 'archived') {
      counts.archived++;
      retainedBytes += size;
    } else {
      counts.retained++;
      retainedBytes += size;
    }
  }

  return {
    totalBytes,
    activeBytes,
    retainedBytes,
    reclaimableBytes,
    counts,
    gcEnabled: policy.gcEnabled,
    diskFreeBytes,
    diskBudgetBytes: policy.diskBudgetBytes,
    minFreeBytes: policy.minFreeBytes,
    underPressure: plan.underPressure,
    overBudget: plan.overBudget,
  };
}

/**
 * Variables a repository's `.ah/workspace.json` may not set: what decides which programs run
 * and what they load (a cloned repo must not reach into the agent's shell), and ah's own.
 */
const RESERVED_ENV = /^(PATH|HOME|SHELL|USER|LOGNAME|ENV|BASH_ENV|ZDOTDIR|PROMPT_COMMAND|IFS|NODE_OPTIONS|NODE_PATH|RUBYOPT|RUBYLIB|LD_.*|DYLD_.*|PYTHON.*|PERL5.*|GIT_.*|SSH_.*|TMUX.*|AH_.*)$/;

/** Expands `${VAR}` placeholders in `.ah/workspace.json` env entries using only known checkout variables. */
export function interpolateWorkspaceEnv(
  template: Record<string, string>,
  vars: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(template)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || RESERVED_ENV.test(k)) continue;
    out[k] = v.replace(/\$\{(AH_[A-Z0-9_]+)\}/g, (_, name: string) => vars[name] ?? '');
  }
  return out;
}
