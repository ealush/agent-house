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
