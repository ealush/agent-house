import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated } from './db.ts';
import { loadConfig } from './config.ts';
import { Registry } from './registry.ts';
import { SnapshotStore, type SnapshotInfo } from './snapshots.ts';
import { TurnSnapshots, snapshotSettings } from './turnSnapshots.ts';

test('a session’s snapshot switch: on unless it or the host turned it off', () => {
  assert.deepEqual(snapshotSettings(undefined, true), { enabled: true, lastTurn: 0 });
  assert.deepEqual(snapshotSettings({ enabled: false, lastTurn: 4 }, true), { enabled: false, lastTurn: 4 });
  assert.deepEqual(snapshotSettings({ enabled: true, lastTurn: 'x' }, false), { enabled: false, lastTurn: 0 });
});

async function bed(hostSnapshots = true) {
  const dir = await mkdtemp(join(tmpdir(), 'ah-turnsnap-'));
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  await writeFile(join(repo, 'a.txt'), 'a');
  const db = join(dir, 'ah.db');
  await ensureMigrated(db);
  const registry = new Registry(db);
  await registry.ready();
  registry.starting('u1', { harness: 'claude', harnessId: 'c1', cwd: repo, title: 't', tmux: { session: 's', windowId: '@1' } });
  const store = new SnapshotStore(db);
  const base = loadConfig();
  const config = hostSnapshots ? base : { ...base, snapshots: { ...base.snapshots, enabled: false } };
  return { dir, repo, registry, store, snaps: new TurnSnapshots(registry, store, () => config, join(dir, 'state')) };
}

test('one snapshot per turn, however many signals say it started', async () => {
  const b = await bed();
  try {
    const first = await b.snaps.turnStart('u1', 'fix the bug');
    assert.equal(first?.turn, 1);
    assert.equal(first?.promptExcerpt, 'fix the bug');
    // The hook reports busy too: same turn, nothing new.
    b.snaps.observe([{ uid: 'u1', agent: 'claude', status: 'busy', statusSource: 'hook' }]);
    assert.equal(await b.snaps.turnStart('u1', 'again'), null);
    // Idle ends the turn; the next one snapshots.
    b.snaps.observe([{ uid: 'u1', agent: 'claude', status: 'idle', statusSource: 'hook' }]);
    assert.equal((await b.snaps.turnStart('u1', 'next'))?.turn, 2);
    assert.equal(b.snaps.settings('u1').lastTurn, 2);
  } finally {
    await b.registry.settled();
    await rm(b.dir, { recursive: true, force: true });
  }
});

test('turning snapshots off during a capture stays off', async () => {
  const b = await bed();
  try {
    // The capture's row write waits until the switch has been flipped.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = b.store.create.bind(b.store);
    b.store.create = async (row: Omit<SnapshotInfo, 'id'>) => {
      await gate;
      return create(row);
    };
    const capturing = b.snaps.turnStart('u1', 'work');
    await new Promise((r) => setTimeout(r, 300));
    b.snaps.setEnabled('u1', false);
    release();
    assert.equal((await capturing)?.turn, 1);
    assert.equal(b.snaps.settings('u1').enabled, false, 'the capture that was in flight did not switch it back on');
    assert.equal(b.snaps.settings('u1').lastTurn, 1);
    b.snaps.turnOver('u1');
    assert.equal(await b.snaps.turnStart('u1', 'more'), null, 'off: no more captures');
  } finally {
    await b.registry.settled();
    await rm(b.dir, { recursive: true, force: true });
  }
});

test('a safety snapshot is taken with snapshots off, and leaves the switch as it was', async () => {
  const b = await bed();
  try {
    b.snaps.setEnabled('u1', false);
    assert.equal((await b.snaps.safety('u1', 'Before restoring turn 1'))?.kind, 'safety');
    assert.equal(b.snaps.settings('u1').enabled, false);
    b.snaps.setEnabled('u1', true);
    assert.equal((await b.snaps.safety('u1', 'again'))?.turn, 2);
    assert.equal(b.snaps.settings('u1').enabled, true);
  } finally {
    await b.registry.settled();
    await rm(b.dir, { recursive: true, force: true });
  }
});

test('a safety snapshot taken while the host has snapshots off leaves the session’s own switch on', async () => {
  const b = await bed(false);
  try {
    assert.equal(b.snaps.settings('u1').enabled, false, 'off for the whole host');
    assert.equal((await b.snaps.safety('u1', 'Before restoring turn 1'))?.kind, 'safety');
    // The host's switch back on: the session's own was never turned off.
    assert.notEqual((b.registry.get('u1')?.meta['ah.snapshots'] as { enabled?: boolean })?.enabled, false);
  } finally {
    await b.registry.settled();
    await rm(b.dir, { recursive: true, force: true });
  }
});
