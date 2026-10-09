import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Win } from '../web/api.ts';
import { applyGroupOrder, movedSessionOrders, saveGroupMove, sidebarOrder, sortWindows } from '../web/sessionOrder.ts';

function win(partial: Pick<Win, 'key' | 'project' | 'host' | 'status' | 'activity'> & Partial<Win>): Win {
  return { pinned: false, order: null, run: null, createdAt: 0, ...partial } as Win;
}

const keys = (windows: Win[]) => windows.map((w) => w.key);

test('sidebar order keeps each project together in opening order', () => {
  const windows = [
    win({ key: 'ah-new', project: 'ah', host: 'local', status: 'idle', activity: 1, createdAt: 30 }),
    win({ key: 'code', project: 'code', host: 'local', status: 'waiting', activity: 99, createdAt: 20 }),
    win({ key: 'ah-old', project: 'ah', host: 'local', status: 'busy', activity: 50, createdAt: 10 }),
  ];
  // A flat sort follows opening time, so code sits between the two ah rows.
  assert.deepEqual(keys(sortWindows(windows)), ['ah-old', 'code', 'ah-new']);
  assert.deepEqual(keys(sidebarOrder(windows, false)), ['ah-old', 'ah-new', 'code']);
});

test('a pin stays inside its project and does not float the block', () => {
  const windows = [
    win({ key: 'ah-pin', project: 'ah', host: 'local', status: 'idle', activity: 1, createdAt: 20, pinned: true }),
    win({ key: 'ah-old', project: 'ah', host: 'local', status: 'idle', activity: 2, createdAt: 10 }),
    win({ key: 'code-wait', project: 'code', host: 'local', status: 'waiting', activity: 9, createdAt: 5 }),
  ];
  assert.deepEqual(keys(sortWindows(windows)), ['ah-pin', 'code-wait', 'ah-old']);
  assert.deepEqual(keys(sidebarOrder(windows, false)), ['code-wait', 'ah-pin', 'ah-old']);
});

test('sidebar order lists recipe runs before project blocks, oldest run first', () => {
  const run = { runId: 'run-1', recipeId: 'r', key: 'a', name: 'fleet' };
  const later = { runId: 'run-2', recipeId: 'r', key: 'b', name: 'other' };
  const windows = [
    win({ key: 'plain', project: 'ah', host: 'local', status: 'waiting', activity: 5, createdAt: 1 }),
    win({ key: 'later', project: 'ah', host: 'local', status: 'busy', activity: 9, createdAt: 4, run: later }),
    win({ key: 'member', project: 'ah', host: 'local', status: 'idle', activity: 1, createdAt: 3, run }),
  ];
  assert.deepEqual(keys(sidebarOrder(windows, false)), ['member', 'later', 'plain']);
});

test('drag order stays inside the project block', () => {
  const before = [
    win({ key: 'ah-a', project: 'ah', host: 'local', status: 'idle', activity: 10, createdAt: 10, order: 100 }),
    win({ key: 'ah-b', project: 'ah', host: 'local', status: 'idle', activity: 5, createdAt: 11, order: 300 }),
    win({ key: 'code', project: 'code', host: 'local', status: 'waiting', activity: 99, createdAt: 20, order: 200 }),
  ];
  assert.deepEqual(keys(sortWindows(before)), ['ah-a', 'code', 'ah-b']);
  assert.deepEqual(keys(sidebarOrder(before, false)), ['ah-a', 'ah-b', 'code']);

  const after = before.map((w) => (w.key === 'ah-a' ? { ...w, order: 400 } : w));
  assert.deepEqual(keys(sortWindows(after)), ['code', 'ah-b', 'ah-a']);
  assert.deepEqual(keys(sidebarOrder(after, false)), ['ah-b', 'ah-a', 'code']);
});

test('status and activity never reorder sessions or projects', () => {
  const quiet = [
    win({ key: 'ah-old', project: 'ah', host: 'local', status: 'idle', activity: 1, createdAt: 10 }),
    win({ key: 'ah-new', project: 'ah', host: 'local', status: 'idle', activity: 2, createdAt: 20 }),
    win({ key: 'code', project: 'code', host: 'local', status: 'idle', activity: 3, createdAt: 30 }),
  ];
  const hot = quiet.map((w) => (w.key === 'code' ? { ...w, status: 'waiting' as const, activity: 999 } : w.key === 'ah-new' ? { ...w, status: 'busy' as const, activity: 500 } : w));
  assert.deepEqual(keys(sidebarOrder(quiet, false)), ['ah-old', 'ah-new', 'code']);
  assert.deepEqual(keys(sidebarOrder(hot, false)), ['ah-old', 'ah-new', 'code']);
});

test('multiple hosts group by host in opening order', () => {
  const windows = [
    win({ key: 'a-wait', project: 'ah', host: 'a', status: 'waiting', activity: 1, createdAt: 20 }),
    win({ key: 'b-busy', project: 'ah', host: 'b', status: 'busy', activity: 2, createdAt: 10 }),
    win({ key: 'a-idle', project: 'other', host: 'a', status: 'idle', activity: 3, createdAt: 30 }),
  ];
  assert.deepEqual(keys(sidebarOrder(windows, true)), ['b-busy', 'a-wait', 'a-idle']);
});

test('a saved block order wins, and a newly opened project appends', () => {
  const windows = [
    win({ key: 'a', project: 'ah', host: 'local', status: 'idle', activity: 1, createdAt: 10 }),
    win({ key: 'c', project: 'code', host: 'local', status: 'waiting', activity: 9, createdAt: 20 }),
    win({ key: 'e', project: 'emoji', host: 'local', status: 'busy', activity: 8, createdAt: 30 }),
  ];
  assert.deepEqual(applyGroupOrder(['ah', 'code', 'emoji'], ['emoji', 'ah']), ['emoji', 'ah', 'code']);
  assert.deepEqual(keys(sidebarOrder(windows, false, ['emoji', 'ah'])), ['e', 'a', 'c']);
});

test('dragging a block keeps closed blocks in their saved slots', () => {
  assert.deepEqual(saveGroupMove(['ah', 'code', 'emoji'], ['ah', 'hidden', 'code', 'emoji'], 'ah', 'emoji', true), ['code', 'hidden', 'emoji', 'ah']);
  assert.deepEqual(saveGroupMove(['ah', 'code'], [], 'code', 'ah', false), ['code', 'ah']);
});

test('a session that was never arranged keeps its opening place', () => {
  const windows = [
    win({ key: 'http', project: 'cwd', host: 'local', status: 'idle', activity: 80, createdAt: 21, order: 5200 }),
    win({ key: 'verify', project: 'cwd', host: 'local', status: 'idle', activity: 70, createdAt: 15 }),
    win({ key: 'rebuild', project: 'emoji', host: 'local', status: 'busy', activity: 100, createdAt: 10, order: 4400 }),
    win({ key: 'fix', project: 'ah', host: 'local', status: 'busy', activity: 100, createdAt: 40, order: 5600 }),
  ];
  const expected = ['rebuild', 'verify', 'http', 'fix'];
  assert.deepEqual(keys(sidebarOrder(windows, false)), expected);
  const hot = windows.map((w) => (w.key === 'fix' ? { ...w, status: 'waiting' as const, activity: 999 } : w));
  assert.deepEqual(keys(sidebarOrder(hot, false)), expected);
});

test('a session drag can land after the last row, and unarranged rows get stable keys', () => {
  const list = [
    win({ key: 'a', project: 'ah', host: 'local', status: 'idle', activity: 1, createdAt: 10, order: 100, uid: 'a' }),
    win({ key: 'b', project: 'ah', host: 'local', status: 'busy', activity: 9, createdAt: 20, order: 200, uid: 'b' }),
    win({ key: 'c', project: 'ah', host: 'local', status: 'waiting', activity: 8, createdAt: 30, order: 300, uid: 'c' }),
  ];
  assert.deepEqual(movedSessionOrders(list, 'a', 'c', true), [{ key: 'a', order: 400 }]);
  assert.deepEqual(movedSessionOrders(list, 'c', 'a', false), [{ key: 'c', order: 0 }]);

  const holes = list.map((w) => (w.key === 'b' ? { ...w, order: null } : w));
  assert.deepEqual(movedSessionOrders(holes, 'c', 'a', false), [
    { key: 'c', order: 100 },
    { key: 'a', order: 200 },
    { key: 'b', order: 300 },
  ]);
});
