import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, conversationKey } from './registry.ts';
import { ensureMigrated } from './db.ts';

const db = () => join(tmpdir(), `ah-registry-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);

async function freshRegistry() {
  const path = db();
  await ensureMigrated(path);
  return new Registry(path);
}

const tmux = { session: 'agents', windowId: '@1' };

test('conversationKey binds harness conversations, uid otherwise', () => {
  assert.equal(conversationKey('muse', 'abc', 'u1'), 'muse:abc');
  assert.equal(conversationKey('shell', undefined, 'u1'), 'u1');
});

test('adopting a conversation inherits its queued follow-ups', async () => {
  const r = await freshRegistry();
  await r.ready();
  r.starting('ended', { harness: 'muse', harnessId: 'conv1', cwd: '/p', title: 'old', tmux });
  r.setMeta('ended', 'ah.queue', [{ id: 'q1', text: 'review the diff', enter: true, at: 1 }]);
  r.starting('fresh', { harness: 'muse', cwd: '/p', title: 'new', tmux: { session: 'agents', windowId: '@2' } });
  r.adopt('fresh', 'conv1');
  assert.deepEqual(r.get('fresh')?.meta['ah.queue'], [{ id: 'q1', text: 'review the diff', enter: true, at: 1 }]);
  assert.equal(r.get('ended')?.meta['ah.queue'], undefined, 'queue moves with the conversation');
  await r.settled();
});

test('resuming under a new uid inherits the conversation queue', async () => {
  const r = await freshRegistry();
  await r.ready();
  r.starting('ended', { harness: 'codex', harnessId: 'c9', cwd: '/p', title: 'old', tmux });
  r.setMeta('ended', 'ah.queue', [{ id: 'q1', text: 'check tests', enter: true, at: 1 }]);
  // Resume of a discovered conversation creates a new record with the same id.
  r.starting('resumed', { harness: 'codex', harnessId: 'c9', cwd: '/p', title: 'old', tmux: { session: 'agents', windowId: '@3' } });
  assert.deepEqual((r.get('resumed')?.meta['ah.queue'] as unknown[])?.length, 1);
  assert.equal(r.get('ended')?.meta['ah.queue'], undefined);
  await r.settled();
});

test('a forked copy keeps no queue from its parent conversation', async () => {
  const r = await freshRegistry();
  await r.ready();
  r.starting('parent', { harness: 'claude', harnessId: 'p1', cwd: '/p', title: 'parent', tmux });
  r.setMeta('parent', 'ah.queue', [{ id: 'q1', text: 'later', enter: true, at: 1 }]);
  // Forks get a new conversation id: the parent keeps its queue.
  r.starting('fork', { harness: 'claude', harnessId: 'p2', cwd: '/w', title: 'fork', tmux: { session: 'agents', windowId: '@4' } });
  assert.equal(r.get('fork')?.meta['ah.queue'], undefined);
  assert.equal((r.get('parent')?.meta['ah.queue'] as unknown[])?.length, 1);
  await r.settled();
});

test('the registry reads nothing until loaded, so it can be built before migrations run', async () => {
  const path = db();
  const before = new Registry(path); // no schema yet: building it must not query
  await ensureMigrated(path);
  const seed = new Registry(path);
  await seed.ready();
  seed.starting('kept', { harness: 'shell', cwd: '/p', title: 'kept', tmux });
  seed.flush();
  await seed.settled();
  await before.load();
  assert.equal(before.get('kept')?.title, 'kept', 'rows written before the load are read by it');
});

test('a failed load rejects instead of leaving an empty registry', async () => {
  const r = new Registry(db()); // never migrated: the Session table is missing
  await assert.rejects(r.load());
});

// A start that fails before its agent runs (Core.launch's catch) undoes exactly what it did.
const q = (id: string) => ({ id, text: id, enter: true, at: 1 });

test('a resume that fails leaves the session as it was: ended, queued, pinned, never deleted', async () => {
  const path = db();
  await ensureMigrated(path);
  const r = new Registry(path);
  await r.ready();
  r.starting('u1', { harness: 'codex', harnessId: 'c1', cwd: '/p', title: 'mine', tmux });
  r.setMeta('u1', 'ah.queue', [q('q1')]);
  r.setMeta('u1', 'ah.pinned', true);
  r.setMeta('u1', 'ah.worktree', { path: '/wt', branch: 'b', repo: '/r' });
  r.reconcile(new Set());
  await new Promise((done) => setTimeout(done, 10));
  // Ended a while ago: past the starting grace, it's ended.
  const ended = r.get('u1')!;
  ended.lifecycle = 'ended';
  ended.status = 'ended';
  const before = structuredClone(r.get('u1')!);

  const undo = r.starting('u1', { harness: 'codex', harnessId: 'c1', cwd: '/p', title: 'mine', tmux: { session: 'agents', windowId: '@7' }, pendingResume: true, meta: { 'ah.env': 'x' } });
  assert.equal(r.get('u1')!.lifecycle, 'starting');
  r.abandonStart(undo);
  assert.deepEqual(r.get('u1'), before);
  // On disk too: a restart finds it.
  await r.settled();
  const again = new Registry(path);
  await again.load();
  assert.deepEqual(again.get('u1')?.meta['ah.queue'], [q('q1')]);
  assert.equal(again.get('u1')?.meta['ah.pinned'], true);
});

test('follow-ups a failed start took from the conversation’s other record go back to it', async () => {
  const r = await freshRegistry();
  await r.ready();
  r.starting('old', { harness: 'codex', harnessId: 'c1', cwd: '/p', title: 'old', tmux });
  r.setMeta('old', 'ah.queue', [q('q1'), q('q2')]);
  const undo = r.starting('new', { harness: 'codex', harnessId: 'c1', cwd: '/p', title: 'new', tmux: { session: 'agents', windowId: '@2' } });
  assert.deepEqual(r.get('new')?.meta['ah.queue'], [q('q1'), q('q2')], 'taken while starting');
  r.abandonStart(undo);
  assert.equal(r.get('new'), undefined, 'a new record that never ran goes');
  assert.deepEqual(r.get('old')?.meta['ah.queue'], [q('q1'), q('q2')]);
  await r.settled();
});

test('something queued while it was starting is kept, never dropped with the failed start', async () => {
  const r = await freshRegistry();
  await r.ready();
  // A new session: the message waits on a record kept ended.
  const undo = r.starting('new', { harness: 'codex', cwd: '/p', title: 'new', tmux });
  r.setMeta('new', 'ah.queue', [q('late')]);
  r.abandonStart(undo);
  assert.equal(r.get('new')?.lifecycle, 'ended');
  assert.equal(r.get('new')?.tmux, undefined);
  assert.deepEqual(r.get('new')?.meta['ah.queue'], [q('late')]);
  // A resumed one: after its own, on the record as it was.
  r.setMeta('new', 'ah.queue', [q('own')]);
  const undo2 = r.starting('new', { harness: 'codex', cwd: '/p', title: 'new', tmux });
  r.setMeta('new', 'ah.queue', [...(r.get('new')!.meta['ah.queue'] as unknown[]), q('late2')]);
  r.abandonStart(undo2);
  assert.deepEqual(r.get('new')?.meta['ah.queue'], [q('own'), q('late2')]);
  await r.settled();
});
