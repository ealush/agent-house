import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry } from './registry.ts';
import { ensureMigrated } from './db.ts';
import { QueueManager, type QueueItem } from './queue.ts';
import { PasteError } from './tmux.ts';

async function setup(paste: () => Promise<void>) {
  const path = join(tmpdir(), `ah-queue-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await ensureMigrated(path);
  const registry = new Registry(path);
  registry.starting('u1', { harness: 'claude', harnessId: 'c1', cwd: '/tmp', title: 't', tmux: { session: 's', windowId: '@1' } });
  const q = new QueueManager(registry, {
    withInput: (_uid, fn) => fn(),
    justSent: () => false,
    markSent: () => {},
    captureTurnStart: async () => {},
    paste,
    applyLaunchChange: () => {},
  });
  const item = (id: string): QueueItem => ({ id, text: `say ${id}`, enter: true, at: 0 });
  q.enqueue('u1', item('a'));
  q.enqueue('u1', item('b'));
  const win = () => ({ uid: 'u1', id: '@1', status: 'idle', queued: q.items('u1').length, createdAt: 0 }) as any;
  return { q, win };
}

test('a follow-up whose paste typed nothing stays first in line', async () => {
  const { q, win } = await setup(async () => {
    throw new PasteError('tmux went away', false);
  });
  await q.deliverDue([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a', 'b']);
});

test('once any text landed, the follow-up counts as delivered (never typed twice)', async () => {
  const { q, win } = await setup(async () => {
    throw new PasteError('Enter failed', true);
  });
  await q.deliverDue([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
});

test('a delivered follow-up leaves the queue', async () => {
  const typed: string[] = [];
  const { q, win } = await setup(async () => {
    typed.push('x');
  });
  await q.deliverDue([win()]);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b']);
  assert.equal(typed.length, 1);
});

test('a taken item that fails before anything is typed goes back first in line', async () => {
  const { q } = await setup(async () => {});
  // send-now takes the item out before typing; an early failure (the agent
  // would not stop, the window went away, nothing reached it) must put the
  // follow-up back first — never lost, never duplicated.
  const taken = q.take('u1', 'b');
  assert.ok(taken);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a']);
  q.requeue('u1', taken.next);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b', 'a']);
  assert.equal(q.items('u1')[0].text, 'say b');
});

test('a queued item moves to a new position; the rest keep their order', async () => {
  const { q } = await setup(async () => {});
  q.enqueue('u1', { id: 'c', text: 'say c', enter: true, at: 0 });
  assert.deepEqual(q.move('u1', 'c', 0)?.map((i) => i.id), ['c', 'a', 'b']);
  assert.deepEqual(q.move('u1', 'c', 99)?.map((i) => i.id), ['a', 'b', 'c'], 'past the end clamps to last');
  assert.deepEqual(q.move('u1', 'a', 1)?.map((i) => i.id), ['b', 'a', 'c']);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['b', 'a', 'c'], 'persisted');
  assert.equal(q.move('u1', 'gone', 0), null, 'an item already sent is not there to move');
});

test('the next delivery takes whatever was moved to the front', async () => {
  const typed: string[] = [];
  const { q, win } = await setup(async (...args: unknown[]) => {
    typed.push(args[1] as string);
  });
  q.move('u1', 'b', 0);
  await q.deliverDue([win()]);
  assert.deepEqual(typed, ['say b']);
  assert.deepEqual(q.items('u1').map((i) => i.id), ['a']);
});
