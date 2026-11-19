import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createSnapshot, snapshotRef } from './git.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated } from './db.ts';
import { SnapshotStore } from './snapshots.ts';
import { Core } from './core.ts';
import { Registry } from './registry.ts';
import { PromptStore } from './prompts.ts';
import { loadConfig } from './config.ts';

async function freshDb() {
  const path = join(tmpdir(), `ah-snap-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await ensureMigrated(path);
  return path;
}

const row = (uid: string, turn: number, at = 1000) => ({
  uid,
  turn,
  commit: `c${turn}`,
  kind: 'turn' as const,
  promptExcerpt: `prompt ${turn}`,
  branch: 'main',
  createdAt: at,
  filesChanged: turn,
  insertions: turn,
  deletions: 0,
  skipped: turn === 2 ? ['fat.txt'] : [],
  submodules: false,
});

test('SnapshotStore: create, list newest first, latest, get, remove', async () => {
  const store = new SnapshotStore(await freshDb());
  await store.create(row('u1', 1));
  const two = await store.create(row('u1', 2));
  await store.create(row('u2', 1));
  assert.equal(two.id > 0, true);
  assert.deepEqual((await store.list('u1')).map((s) => s.turn), [2, 1]);
  assert.equal((await store.latest('u1'))?.turn, 2);
  assert.deepEqual((await store.get('u1', 2))?.skipped, ['fat.txt']);
  assert.equal(await store.get('u1', 99), null);
  await store.remove('u1', 1);
  assert.deepEqual((await store.list('u1')).map((s) => s.turn), [2]);
  assert.deepEqual((await store.all()).map((s) => s.uid), ['u1', 'u2']);
});

test('SnapshotStore.rekey moves rows to the hot-swap replacement uid', async () => {
  const store = new SnapshotStore(await freshDb());
  await store.create(row('old1', 1));
  await store.create(row('old1', 2));
  await store.create(row('other', 1));
  assert.equal(await store.rekey('old1', 'new1'), 2);
  assert.deepEqual((await store.list('new1')).map((s) => s.turn), [2, 1]);
  assert.deepEqual(await store.list('old1'), []);
  assert.deepEqual((await store.list('other')).map((s) => s.turn), [1]);
  assert.equal(await store.rekey('missing', 'new2'), 0);
});

test('Core.pruneSnapshots: turn cap keeps the newest, rows of vanished sessions expire', async () => {
  const path = await freshDb();
  const store = new SnapshotStore(path);
  const config = { ...loadConfig(), snapshots: { maxFileBytes: 1024, keepTurns: 3, retentionDays: 7 } };
  const core = new Core(config, new Map(), new Registry(path), new PromptStore(path), store);
  const old = Math.floor(Date.now() / 1000) - 8 * 86_400;
  const recent = Math.floor(Date.now() / 1000);
  for (let turn = 1; turn <= 6; turn++) await store.create(row('live1', turn, recent));
  for (let turn = 1; turn <= 2; turn++) await store.create(row('gone1', turn, old));
  await core.pruneSnapshots();
  assert.deepEqual((await store.list('live1')).map((s) => s.turn), [6, 5, 4], 'cap keeps newest 3');
  assert.deepEqual(await store.list('gone1'), [], 'session gone and rows older than retention: pruned');
});


test('expired snapshots of forgotten sessions also release their git refs', async () => {
  const path = await freshDb();
  const repo = await mkdtemp(join(tmpdir(), 'ah-snapshot-retention-'));
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(join(repo, 'a.txt'), 'captured');
  const made = await createSnapshot(repo, { uid: 'forgotten', turn: 1, indexFile: join(repo, '.git', 'test-index'), parent: null, maxFileBytes: 1024 });
  const store = new SnapshotStore(path);
  await store.create({ ...row('forgotten', 1, Math.floor(Date.now() / 1000) - 8 * 86400), commit: made.commit, repoRoot: repo });
  const core = new Core({ ...loadConfig(), snapshots: { maxFileBytes: 1024, keepTurns: 3, retentionDays: 7 } }, new Map(), new Registry(path), new PromptStore(path), store);
  await core.pruneSnapshots();
  assert.deepEqual(await store.list('forgotten'), []);
  assert.throws(() => execFileSync('git', ['-C', repo, 'rev-parse', '--verify', snapshotRef('forgotten', 1)], { stdio: 'ignore' }));
});
