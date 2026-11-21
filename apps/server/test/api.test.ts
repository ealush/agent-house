import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForWindow } from '../web/api.ts';

const win = (id: string, uid: string) => ({ id, uid });
const noopSleep = async (_ms: number) => {};

test('waitForWindow matches by uid on the first fetch', async () => {
  let calls = 0;
  const ok = await waitForWindow(
    async () => {
      calls++;
      return { windows: [win('@11', 'aaa'), win('@12', 'bbb')] };
    },
    { id: '@12', uid: 'bbb' },
    { sleep: noopSleep },
  );
  assert.equal(ok, true);
  assert.equal(calls, 1);
});

test('waitForWindow polls until the new window appears', async () => {
  let calls = 0;
  const ok = await waitForWindow(
    async () => {
      calls++;
      return calls < 3 ? { windows: [win('@11', 'aaa')] } : { windows: [win('@11', 'aaa'), win('@12', 'bbb')] };
    },
    { id: '@12', uid: 'bbb' },
    { sleep: noopSleep },
  );
  assert.equal(ok, true);
  assert.equal(calls, 3);
});

test('waitForWindow falls back to the window id', async () => {
  const ok = await waitForWindow(async () => ({ windows: [win('@12', 'other')] }), { id: '@12', uid: 'bbb' }, { sleep: noopSleep });
  assert.equal(ok, true);
});

test('waitForWindow gives up bounded and tolerates fetch errors', async () => {
  let calls = 0;
  const ok = await waitForWindow(
    async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return { windows: [win('@11', 'aaa')] };
    },
    { id: '@12', uid: 'bbb' },
    { tries: 3, sleep: noopSleep },
  );
  assert.equal(ok, false);
  assert.equal(calls, 3);
});
