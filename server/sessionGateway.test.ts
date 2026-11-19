import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Preset } from './config.ts';
import type { Core } from './core.ts';
import { LaunchError } from './launch.ts';
import { SessionGateway } from './sessionGateway.ts';
import { uidOfRef, type SessionRecord } from './registry.ts';

const config = loadConfig();
// No live model catalog: the test never reads an agent CLI's own files.
const gemini = config.presets.find((p) => p.id === 'gemini')!;

type Launched = Parameters<Core['launch']>[0];

function fakeCore() {
  const launched: Launched[] = [];
  let order = 0;
  let refreshed = 0;
  const core = {
    preset: (id: string): Preset => {
      if (id !== gemini.id) throw new Error(`unknown preset ${id}`);
      return gemini;
    },
    launch: async (o: Launched) => {
      launched.push(o);
      return { uid: o.uid ?? 'fresh-uid', windowId: '@9' };
    },
    nextOrder: () => ++order,
    refreshTmuxPath: async () => void refreshed++,
  } as unknown as Core;
  return { core, launched, refreshed: () => refreshed };
}

test('an agent starts last in the list, in the default session, as a new conversation', async () => {
  const f = fakeCore();
  const out = await new SessionGateway(f.core, config).startAgent({ preset: 'gemini', cwd: '/p', name: 'job', uid: 'u1', meta: { 'ah.job': 'jb-1' } });
  assert.deepEqual({ uid: out.uid, windowId: out.windowId, worktree: out.worktree }, { uid: 'u1', windowId: '@9', worktree: null });
  const l = f.launched[0];
  assert.equal(l.session, config.defaultSession);
  assert.equal(l.cwd, '/p');
  assert.equal(l.pendingResume, false);
  assert.equal(l.harnessId, undefined);
  assert.equal(l.meta?.['ah.job'], 'jb-1');
  assert.equal(l.meta?.['ah.order'], 1);
  assert.equal(f.refreshed(), 1, 'the new window’s PATH is read after it starts');
});

test('resuming names the conversation, and the launch says it is one', async () => {
  const f = fakeCore();
  await new SessionGateway(f.core, config).startAgent({ preset: 'gemini', cwd: '/p', name: 'c', resume: 'conv-7', selection: { mode: 'yolo' } });
  const l = f.launched[0];
  assert.equal(l.harnessId, 'conv-7');
  assert.equal(l.pendingResume, true);
  assert.equal(l.meta?.['ah.launch.mode'], 'yolo', 'the launch choices are recorded with it');
});

test('a choice the agent would refuse fails before anything is made: no worktree, no window', async () => {
  // Worktrees go beside the repository (<parent>/.worktrees/<repo>): all of it in one temp dir.
  const parent = mkdtempSync(join(tmpdir(), 'ah-gw-'));
  const repo = join(parent, 'repo');
  try {
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
    const f = fakeCore();
    await assert.rejects(new SessionGateway(f.core, config).startAgent({ preset: 'gemini', cwd: repo, name: 'nope', selection: { mode: 'no-such-mode' }, worktree: {} }), LaunchError);
    assert.equal(f.launched.length, 0);
    assert.equal(existsSync(join(parent, '.worktrees')), false, 'no worktree for a launch that never happens');
    // The same start with a valid choice does make one, on a branch named for the session.
    const out = await new SessionGateway(f.core, config).startAgent({ preset: 'gemini', cwd: repo, name: 'fix-it', worktree: {} });
    assert.ok(out.worktree && existsSync(out.worktree.path) && out.worktree.path.startsWith(join(parent, '.worktrees')));
    assert.equal(f.launched[0].cwd, out.worktree.path);
    assert.deepEqual(f.launched[0].meta?.['ah.worktree'], out.worktree);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('checkLaunch says whether the choice is a dangerous one, or throws why it is refused', async () => {
  const gw = new SessionGateway(fakeCore().core, config);
  assert.deepEqual(await gw.checkLaunch('gemini', { mode: 'yolo' }), { dangerous: true });
  assert.deepEqual(await gw.checkLaunch('gemini', {}), { dangerous: false });
  await assert.rejects(gw.checkLaunch('gemini', { mode: 'nope' }), LaunchError);
});

const rec = (id: string, harness: string, harnessId?: string) => ({ id, harness, harnessId }) as SessionRecord;

test('a ref is a uid, or the harness:conversation of a session ah knows', () => {
  const records = [rec('u1', 'claude', 'c1'), rec('u2', 'codex', 'x:y'), rec('u3', 'shell')];
  assert.equal(uidOfRef(records, 'u3'), 'u3');
  assert.equal(uidOfRef(records, 'claude:c1'), 'u1');
  assert.equal(uidOfRef(records, 'codex:x:y'), 'u2', 'everything after the first colon is the conversation id');
  assert.equal(uidOfRef(records, 'codex:c1'), null, 'the harness must match too');
  assert.equal(uidOfRef(records, 'nobody'), null);
  assert.equal(uidOfRef(records, ':c1'), null);
});
