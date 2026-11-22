import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import {
  CheckoutError,
  allocatePortBlock,
  classifyLifecycle,
  computeOverlaps,
  evaluateOwnership,
  interpolateWorkspaceEnv,
  planReclamation,
  shouldAutoIsolate,
  summarizeStorage,
  type LifecycleFacts,
} from './checkouts/model.ts';
import { DEFAULT_CHECKOUTS, type CheckoutsConfig } from './checkouts/settings.ts';
import { CheckoutsService, type LiveSessionFact, type SessionRecordFact } from './checkouts/service.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function makeRepo(parent: string, name = 'repo'): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'shared.txt'), 'line 1\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

async function makeDb(dir: string): Promise<PrismaClient> {
  const url = `file:${join(dir, 'test.db')}`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  await db.$executeRawUnsafe(`
    CREATE TABLE "Checkout" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "repoRoot" TEXT NOT NULL,
      "path" TEXT NOT NULL,
      "kind" TEXT NOT NULL DEFAULT 'worktree',
      "managed" BOOLEAN NOT NULL DEFAULT false,
      "branch" TEXT,
      "baseSha" TEXT NOT NULL DEFAULT '',
      "baseBranch" TEXT NOT NULL DEFAULT '',
      "ownerUid" TEXT,
      "lifecycle" TEXT NOT NULL DEFAULT 'active',
      "pinned" BOOLEAN NOT NULL DEFAULT false,
      "portStart" INTEGER,
      "portEnd" INTEGER,
      "tempDir" TEXT,
      "statusJson" TEXT NOT NULL DEFAULT '{}',
      "createdAt" INTEGER NOT NULL DEFAULT 0,
      "lastActivityAt" INTEGER NOT NULL DEFAULT 0,
      "archivedAt" INTEGER,
      "reclaimedAt" INTEGER
    );
  `);
  await db.$executeRawUnsafe(`CREATE UNIQUE INDEX "Checkout_path_key" ON "Checkout"("path");`);
  return db;
}

// ---------- pure functional core tests

test('shouldAutoIsolate enforces automatic isolation defaults and safe opt-outs', () => {
  const cfg = { autoIsolate: true };
  const agent = { id: 'claude', command: 'claude' };
  const shell = { id: 'shell', command: '' };

  assert.deepEqual(shouldAutoIsolate({ config: cfg, preset: agent, isGitRepo: true, hasHead: true, creatingDir: false, resumingInPlace: false }), { isolate: true });
  assert.deepEqual(shouldAutoIsolate({ config: cfg, preset: shell, isGitRepo: true, hasHead: true, creatingDir: false, resumingInPlace: false }), { isolate: false, reason: 'shell' });
  assert.deepEqual(shouldAutoIsolate({ config: cfg, preset: agent, isGitRepo: false, hasHead: false, creatingDir: false, resumingInPlace: false }), { isolate: false, reason: 'not_git' });
  assert.deepEqual(shouldAutoIsolate({ config: cfg, preset: agent, isGitRepo: true, hasHead: false, creatingDir: false, resumingInPlace: false }), { isolate: false, reason: 'unborn_repo' });
  assert.deepEqual(shouldAutoIsolate({ config: cfg, preset: agent, isGitRepo: true, hasHead: true, creatingDir: true, resumingInPlace: false }), { isolate: false, reason: 'creating_dir' });
  assert.deepEqual(shouldAutoIsolate({ config: cfg, preset: agent, isGitRepo: true, hasHead: true, creatingDir: false, resumingInPlace: true }), { isolate: false, reason: 'resuming' });
  assert.deepEqual(shouldAutoIsolate({ config: cfg, preset: agent, isGitRepo: true, hasHead: true, creatingDir: false, resumingInPlace: false, explicitWorktree: false }), { isolate: false, reason: 'explicit_opt_out' });
  assert.deepEqual(shouldAutoIsolate({ config: { autoIsolate: false }, preset: agent, isGitRepo: true, hasHead: true, creatingDir: false, resumingInPlace: false }), { isolate: false, reason: 'disabled' });
});

test('evaluateOwnership enforces single active writer and allows stale owner takeover', () => {
  const live = new Set(['u1']);
  assert.deepEqual(evaluateOwnership(null, 'u2', live), { ok: true, staleOwner: null });
  assert.deepEqual(evaluateOwnership('u1', 'u1', live), { ok: true, staleOwner: null });
  assert.deepEqual(evaluateOwnership('u1', 'u2', live), { ok: false, ownerUid: 'u1' });
  assert.deepEqual(evaluateOwnership('dead', 'u2', live), { ok: true, staleOwner: 'dead' });
});

test('classifyLifecycle and planReclamation protect active, dirty, pinned, main and found-on-disk checkouts even under disk pressure', () => {
  const now = 1_700_000_000;
  const policy: CheckoutsConfig = { ...DEFAULT_CHECKOUTS, mergedRetentionHours: 24, unmergedRetentionDays: 7, minFreeBytes: 1000, diskBudgetBytes: 1900 };

  const base: Omit<LifecycleFacts, 'id'> = {
    kind: 'worktree',
    managed: true,
    exists: true,
    pinned: false,
    hasActiveOwner: false,
    hasLiveProcess: false,
    hasResumableSession: false,
    dirty: 0,
    merged: false,
    lastActivityAt: now - 3600,
    sizeBytes: 300,
  };

  const rows: LifecycleFacts[] = [
    { ...base, id: 'main', kind: 'main' },
    { ...base, id: 'active', hasActiveOwner: true },
    { ...base, id: 'pinned', pinned: true, merged: true, lastActivityAt: now - 10 * 86400 },
    { ...base, id: 'dirty', dirty: 2, merged: true, lastActivityAt: now - 10 * 86400 },
    { ...base, id: 'merged-old', merged: true, lastActivityAt: now - 25 * 3600 },
    { ...base, id: 'unmerged-recent', merged: false, lastActivityAt: now - 2 * 3600 },
    { ...base, id: 'unmerged-older', merged: false, lastActivityAt: now - 48 * 3600 },
    // Never automatic: a worktree ah didn't make, however old and merged.
    { ...base, id: 'adopted', managed: false, merged: true, lastActivityAt: now - 30 * 86400 },
    // Pressure skips these, though each is older than unmerged-older:
    { ...base, id: 'resumable', hasResumableSession: true, lastActivityAt: now - 60 * 3600 },
    { ...base, id: 'unmeasured', sizeBytes: null, lastActivityAt: now - 72 * 3600 },
    { ...base, id: 'fresh', lastActivityAt: now - 600 },
  ];

  const classified = rows.map((r) => ({ ...r, classification: classifyLifecycle(r, policy, now) }));
  const byId = new Map(classified.map((c) => [c.id, c.classification]));
  assert.equal(byId.get('main')!.eligibleUnderPressure, false);
  assert.equal(byId.get('active')!.eligibleUnderPressure, false);
  assert.equal(byId.get('pinned')!.eligibleUnderPressure, false);
  assert.equal(byId.get('dirty')!.eligibleUnderPressure, false);
  assert.equal(byId.get('merged-old')!.eligibleNow, true);
  assert.equal(byId.get('unmerged-recent')!.eligibleNow, false);
  assert.equal(byId.get('unmerged-recent')!.eligibleUnderPressure, true);
  assert.equal(byId.get('adopted')!.eligibleNow, false);
  assert.equal(byId.get('adopted')!.eligibleUnderPressure, false);
  assert.equal(byId.get('adopted')!.reason, 'adopted');
  assert.equal(byId.get('resumable')!.eligibleUnderPressure, false);
  assert.equal(byId.get('fresh')!.eligibleUnderPressure, false);

  // Under low free disk (500 < 1000): merged-old goes by policy, then unmerged-older (oldest-first) by pressure.
  const plan = planReclamation(classified, policy, 500);
  assert.equal(plan.underPressure, true);
  assert.deepEqual(plan.candidates.map((c) => [c.id, c.reason]), [
    ['merged-old', 'policy'],
    ['unmerged-older', 'pressure'],
  ]);
  assert.equal(plan.reclaimableCount, 2);
  const storage = summarizeStorage(classified, plan, policy, 500);
  assert.equal(storage.activeBytes, 300);
  assert.equal(storage.reclaimableBytes, 600);

  // Expired resumable conversations still go on their timer: resume recreates the checkout.
  const expired = classifyLifecycle({ ...base, id: 'r', hasResumableSession: true, lastActivityAt: now - 8 * 86400 }, policy, now);
  assert.equal(expired.eligibleNow, true);
});

test('computeOverlaps detects pairwise changed files within a repo only', () => {
  const overlaps = computeOverlaps([
    { id: 'c1', repoRoot: '/r1', branch: 'ah/a', ownerUid: 'u1', ownerTitle: 'Auth', lifecycle: 'active', changedFiles: ['src/auth.ts', 'src/index.ts'] },
    { id: 'c2', repoRoot: '/r1', branch: 'ah/b', ownerUid: 'u2', ownerTitle: 'Voice', lifecycle: 'active', changedFiles: ['src/index.ts', 'src/voice.ts'] },
    { id: 'c3', repoRoot: '/r2', branch: 'ah/c', ownerUid: 'u3', ownerTitle: 'Other', lifecycle: 'active', changedFiles: ['src/index.ts'] },
    { id: 'c4', repoRoot: '/r1', branch: 'ah/old', ownerUid: null, ownerTitle: null, lifecycle: 'reclaimed', changedFiles: ['src/index.ts'] },
  ]);
  assert.deepEqual(overlaps.get('c1'), [{ checkoutId: 'c2', branch: 'ah/b', ownerUid: 'u2', ownerTitle: 'Voice', files: ['src/index.ts'] }]);
  assert.deepEqual(overlaps.get('c2'), [{ checkoutId: 'c1', branch: 'ah/a', ownerUid: 'u1', ownerTitle: 'Auth', files: ['src/index.ts'] }]);
  assert.deepEqual(overlaps.get('c3'), []);
  assert.deepEqual(overlaps.get('c4'), []);
});

test('allocatePortBlock and interpolateWorkspaceEnv behave deterministically', () => {
  const cfg = { portRange: [41000, 41007] as [number, number], portsPerCheckout: 4 };
  const p1 = allocatePortBlock([], cfg);
  assert.deepEqual(p1, { portStart: 41000, portEnd: 41003 });
  const p2 = allocatePortBlock([p1!], cfg);
  assert.deepEqual(p2, { portStart: 41004, portEnd: 41007 });
  assert.equal(allocatePortBlock([p1!, p2!], cfg), null);

  assert.deepEqual(
    interpolateWorkspaceEnv({ PORT: '${AH_PORT}', CACHE_DIR: '${AH_TEMP_DIR}/build', 'bad-key': 'x' }, { AH_PORT: '41000', AH_TEMP_DIR: '/tmp/ck-1' }),
    { PORT: '41000', CACHE_DIR: '/tmp/ck-1/build' },
  );
  // A repository can't reach into what the agent's shell runs or loads, nor ah's own variables.
  assert.deepEqual(
    interpolateWorkspaceEnv({ PATH: '/evil', LD_PRELOAD: '/evil.so', NODE_OPTIONS: '--require x', GIT_DIR: '/x', AH_PORT: '1', APP: 'ok' }, {}),
    { APP: 'ok' },
  );
});

// ---------- CheckoutsService integration (real SQLite + real Git repos)

test('CheckoutsService: auto-isolation, rollback, exclusive ownership, overlaps, merge-tree, GC and resume recreation', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ah-checkouts-svc-'));
  const repo = makeRepo(parent, 'proj');
  mkdirSync(join(repo, '.ah'), { recursive: true });
  writeFileSync(join(repo, '.ah', 'workspace.json'), JSON.stringify({ env: { APP_PORT: '${AH_PORT}', WORK_ID: '${AH_WORKSPACE_ID}' } }));
  git(repo, 'add', '.ah/workspace.json');
  git(repo, 'commit', '-qm', 'add workspace manifest');

  const db = await makeDb(parent);
  let nowSec = Math.floor(Date.now() / 1000) + 60;
  let live: LiveSessionFact[] = [];
  let records: SessionRecordFact[] = [];
  let cfg: CheckoutsConfig = { ...DEFAULT_CHECKOUTS, minFreeBytes: null, mergedRetentionHours: 24, unmergedRetentionDays: 7 };

  const svc = new CheckoutsService(db, {
    config: () => cfg,
    tempRoot: join(parent, 'tmp'),
    liveWindows: async () => live,
    records: () => records,
    changed: () => {},
    now: () => nowSec,
  });

  try {
    const claude = { id: 'claude', command: 'claude' };
    const shell = { id: 'shell', command: '' };

    // 1. Automatic isolation + runtime port & manifest env allocation
    const acq1 = await svc.acquireForLaunch({ uid: 'u1', preset: claude, cwd: repo, name: 'Auth' });
    assert.ok(acq1.checkoutId && acq1.worktree && existsSync(acq1.worktree.path));
    assert.equal(acq1.ports?.start, 41000);
    assert.equal(acq1.env.AH_PORT, '41000');
    assert.equal(acq1.env.APP_PORT, '41000');
    assert.equal(acq1.env.WORK_ID, acq1.checkoutId);
    assert.ok(existsSync(acq1.env.AH_TEMP_DIR));

    live.push({ uid: 'u1', id: '@1', name: 'Auth', title: 'Auth', agent: 'claude', status: 'idle', cwd: acq1.cwd });
    records.push({ id: 'u1', title: 'Auth', harness: 'claude', harnessId: 'conv-1', cwd: acq1.cwd, lifecycle: 'live', lastActivityAt: nowSec, worktree: acq1.worktree });

    // 2. Rollback on failed launch cleans up worktree, tempDir, and DB row immediately
    const acqFail = await svc.acquireForLaunch({ uid: 'u-fail', preset: claude, cwd: repo, name: 'Broken' });
    assert.ok(existsSync(acqFail.cwd));
    await acqFail.rollback();
    assert.equal(existsSync(acqFail.cwd), false, 'worktree removed on rollback');
    assert.equal(existsSync(acqFail.env.AH_TEMP_DIR), false, 'tempDir removed on rollback');
    await assert.rejects(svc.get(acqFail.checkoutId!), CheckoutError);

    // 3. Second parallel agent gets its own worktree and disjoint port block
    const acq2 = await svc.acquireForLaunch({ uid: 'u2', preset: claude, cwd: repo, name: 'Voice' });
    assert.ok(acq2.worktree && acq2.worktree.path !== acq1.worktree.path);
    assert.equal(acq2.ports?.start, 41004);
    live.push({ uid: 'u2', id: '@2', name: 'Voice', title: 'Voice', agent: 'claude', status: 'idle', cwd: acq2.cwd });
    records.push({ id: 'u2', title: 'Voice', harness: 'claude', harnessId: 'conv-2', cwd: acq2.cwd, lifecycle: 'live', lastActivityAt: nowSec, worktree: acq2.worktree });

    // 4. The main checkout is shared: writers there are tracked, never refused, and never own it.
    const mainAcq = await svc.acquireForLaunch({ uid: 'u-main', preset: claude, cwd: repo, name: 'MainWork', explicitWorktree: false });
    assert.equal(mainAcq.cwd, repo);
    live.push({ uid: 'u-main', id: '@3', name: 'MainWork', title: 'MainWork', agent: 'claude', status: 'idle', cwd: repo });
    records.push({ id: 'u-main', title: 'MainWork', harness: 'claude', cwd: repo, lifecycle: 'live', lastActivityAt: nowSec });
    const mainAcq2 = await svc.acquireForLaunch({ uid: 'u-main-2', preset: claude, cwd: repo, name: 'Second', explicitWorktree: false });
    assert.equal(mainAcq2.cwd, repo);
    assert.equal(mainAcq2.checkoutId, mainAcq.checkoutId);
    await svc.reconcile();
    const mainView = (await svc.list(repo)).checkouts.find((c) => c.kind === 'main')!;
    assert.equal(mainView.owner, null);
    assert.equal(mainView.lifecycle, 'active');
    assert.ok(mainView.liveSessions.some((w) => w.uid === 'u-main'));

    // A worktree has one writer: a second new launch into acq1's is refused…
    await assert.rejects(
      svc.acquireForLaunch({ uid: 'u-intruder', preset: claude, cwd: acq1.cwd, name: 'Intruder', explicitWorktree: false }),
      (err: unknown) => err instanceof CheckoutError && err.status === 409 && err.code === 'checkout_owned',
    );
    // …but a conversation continued in another agent stays in it, and so does a resume (recovery).
    const cont = await svc.acquireForLaunch({ uid: 'u-cont', preset: claude, cwd: acq1.cwd, name: 'Continued', explicitWorktree: false, continuation: true });
    assert.equal(cont.cwd, acq1.cwd);
    const res2 = await svc.ensureForResume({ uid: 'u-other', preset: claude, cwd: acq1.cwd });
    assert.equal(res2.cwd, acq1.cwd);
    assert.equal((await svc.get(acq1.checkoutId!)).owner?.uid, 'u1', 'sharing leaves the owner');

    // A claim whose window isn't listed yet still holds the worktree (it is starting).
    const starting = await svc.acquireForLaunch({ uid: 'u-starting', preset: claude, cwd: repo, name: 'Starting' });
    await assert.rejects(
      svc.acquireForLaunch({ uid: 'u-race', preset: claude, cwd: starting.cwd, name: 'Race', explicitWorktree: false }),
      (err: unknown) => err instanceof CheckoutError && err.code === 'checkout_owned',
    );
    await starting.rollback();

    // Plain shell (observer) is allowed in an owned checkout without stealing ownership
    const shellAcq = await svc.acquireForLaunch({ uid: 'u-sh', preset: shell, cwd: acq1.cwd, name: 'shell' });
    assert.equal(shellAcq.cwd, acq1.cwd);

    // Asked outright for a worktree of a folder that isn't a repository: refused, as before Checkouts.
    const plain = join(parent, 'plain');
    mkdirSync(plain);
    await assert.rejects(svc.acquireForLaunch({ uid: 'u-plain', preset: claude, cwd: plain, name: 'Plain', explicitWorktree: true }));

    // 5. Overlap detection + non-destructive merge-tree conflict check
    writeFileSync(join(acq1.cwd, 'shared.txt'), 'auth change\n');
    git(acq1.cwd, 'add', 'shared.txt');
    git(acq1.cwd, 'commit', '-qm', 'auth edit');

    writeFileSync(join(acq2.cwd, 'shared.txt'), 'voice change\n');
    git(acq2.cwd, 'add', 'shared.txt');
    git(acq2.cwd, 'commit', '-qm', 'voice edit');

    const overview = await svc.list(repo);
    assert.equal(overview.repositories.length, 1);
    assert.equal(overview.repositories[0].overlapCount, 1);
    const v1 = overview.checkouts.find((c) => c.id === acq1.checkoutId)!;
    assert.equal(v1.overlaps.length, 1);
    assert.deepEqual(v1.overlaps[0].files, ['shared.txt']);

    // Advance main with a conflicting edit to shared.txt, then check integration of acq1
    writeFileSync(join(repo, 'shared.txt'), 'main change\n');
    git(repo, 'add', 'shared.txt');
    git(repo, 'commit', '-qm', 'main edit');

    const checked = await svc.checkIntegration(acq1.checkoutId!);
    assert.equal(checked.integration?.clean, false);
    assert.deepEqual(checked.integration?.conflicts, ['shared.txt']);

    // 6. Automatic GC: active & dirty are protected; clean expired worktree is reclaimed while keeping its branch
    // An empty one ah made (no commits) goes too, with its branch; one made by hand never does.
    const empty = await svc.acquireForLaunch({ uid: 'u-empty', preset: claude, cwd: repo, name: 'Empty' });
    const byHand = join(parent, '.worktrees', 'proj', 'by-hand');
    git(repo, 'worktree', 'add', '-q', '-b', 'by-hand', byHand);
    // End every session; leave acq2 dirty, acq1 clean.
    live = [];
    records = records.map((r) => ({ ...r, lifecycle: 'ended' }));
    for (const uid of ['u1', 'u2', 'u-empty']) await svc.releaseOwner(uid);
    writeFileSync(join(acq2.cwd, 'uncommitted.txt'), 'keep me\n');
    const found = (await svc.list(repo)).checkouts.find((c) => c.path === byHand)!;
    assert.equal(found.managed, false);
    assert.equal(found.branch, 'by-hand');

    // Advance clock past unmergedRetentionDays (8 days)
    nowSec += 8 * 86400;
    const dry = await svc.runGc({ dryRun: true });
    assert.deepEqual(dry.reclaimed.map((r) => r.id).sort(), [acq1.checkoutId, empty.checkoutId].sort());
    assert.equal(existsSync(acq1.cwd), true, 'dryRun touches nothing');

    const gc = await svc.runGc();
    assert.deepEqual(gc.reclaimed.map((r) => r.id).sort(), [acq1.checkoutId, empty.checkoutId].sort());
    assert.equal(existsSync(acq1.cwd), false, 'clean expired worktree reclaimed');
    assert.equal(existsSync(acq2.cwd), true, 'dirty worktree preserved by GC');
    assert.equal(existsSync(byHand), true, 'a worktree ah did not make is never reclaimed');
    assert.equal(git(repo, 'branch', '--list', empty.worktree!.branch).trim(), '', 'an unused ah/* branch goes with its checkout');
    assert.notEqual(git(repo, 'branch', '--list', acq1.worktree.branch).trim(), '', 'a branch with work stays');

    // 7. Resume after reclamation recreates the worktree at its original path from its preserved branch
    const resumed = await svc.ensureForResume({ uid: 'u1', preset: claude, cwd: acq1.cwd, worktreeMeta: acq1.worktree });
    assert.equal(resumed.recreated, true);
    assert.equal(resumed.cwd, acq1.cwd);
    assert.equal(existsSync(join(acq1.cwd, 'shared.txt')), true);
  } finally {
    await db.$disconnect();
    rmSync(parent, { recursive: true, force: true });
  }
});
