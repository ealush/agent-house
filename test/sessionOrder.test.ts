import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Win } from '../web/api.ts';
import { sidebarOrder, sortWindows } from '../web/sessionOrder.ts';

function win(partial: Pick<Win, 'key' | 'project' | 'host' | 'status' | 'activity'> & Partial<Win>): Win {
  return { pinned: false, order: null, run: null, ...partial } as Win;
}

test('sidebar order walks each project block instead of interleaving by status', () => {
  const windows = [
    win({ key: 'ah-wait', project: 'ah', host: 'local', status: 'waiting', activity: 1 }),
    win({ key: 'ah-idle', project: 'ah', host: 'local', status: 'idle', activity: 50 }),
    win({ key: 'code-busy', project: 'code', host: 'local', status: 'busy', activity: 40 }),
  ];
  // Flat sort is status rank: waiting, busy, idle — that jumps out of the ah block.
  assert.deepEqual(sortWindows(windows).map((w) => w.key), ['ah-wait', 'code-busy', 'ah-idle']);
  assert.deepEqual(sidebarOrder(windows, false).map((w) => w.key), ['ah-wait', 'ah-idle', 'code-busy']);
});

test('sidebar order keeps a pinned session with the rest of its project', () => {
  const windows = [
    win({ key: 'ah-pin', project: 'ah', host: 'local', status: 'idle', activity: 1, pinned: true }),
    win({ key: 'ah-idle', project: 'ah', host: 'local', status: 'idle', activity: 2 }),
    win({ key: 'code-wait', project: 'code', host: 'local', status: 'waiting', activity: 9 }),
  ];
  assert.deepEqual(sortWindows(windows).map((w) => w.key), ['ah-pin', 'code-wait', 'ah-idle']);
  assert.deepEqual(sidebarOrder(windows, false).map((w) => w.key), ['ah-pin', 'ah-idle', 'code-wait']);
});

test('sidebar order lists recipe runs before project blocks', () => {
  const run = { runId: 'run-1', recipeId: 'r', key: 'a', name: 'fleet' };
  const windows = [
    win({ key: 'plain', project: 'ah', host: 'local', status: 'waiting', activity: 5 }),
    win({ key: 'member', project: 'ah', host: 'local', status: 'idle', activity: 1, run }),
  ];
  assert.deepEqual(sidebarOrder(windows, false).map((w) => w.key), ['member', 'plain']);
});

test('multiple hosts group by host instead of project', () => {
  const windows = [
    win({ key: 'a-wait', project: 'ah', host: 'a', status: 'waiting', activity: 1 }),
    win({ key: 'b-busy', project: 'ah', host: 'b', status: 'busy', activity: 2 }),
    win({ key: 'a-idle', project: 'other', host: 'a', status: 'idle', activity: 3 }),
  ];
  assert.deepEqual(sidebarOrder(windows, true).map((w) => w.key), ['a-wait', 'a-idle', 'b-busy']);
});
