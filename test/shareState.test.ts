import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shareState, type State } from '../web/api.ts';

const state = (windows: Array<Record<string, unknown>>): State =>
  ({ hostname: 'box', hosts: [{ name: 'box', self: true, online: true }], windows, history: [] }) as unknown as State;

test('a patch keeps the sessions it did not change, and their list when none changed', () => {
  const a = state([{ uid: 'a1', status: 'idle' }, { uid: 'b2', status: 'working', detail: 'tick 1' }]);
  const b = state([{ uid: 'a1', status: 'idle' }, { uid: 'b2', status: 'working', detail: 'tick 2' }]);
  const out = shareState(a, b);
  assert.equal(out.windows[0], a.windows[0], 'unchanged session: same object');
  assert.notEqual(out.windows[1], a.windows[1], 'changed session: the new one');
  assert.equal(out.windows[1].detail, 'tick 2');
  assert.equal(out.hosts, a.hosts, 'nothing changed: same list');

  const c = shareState(out, state([{ uid: 'a1', status: 'idle' }, { uid: 'b2', status: 'working', detail: 'tick 2' }]));
  assert.equal(c.windows, out.windows, 'a patch that changed nothing in the list keeps the list');

  // Reordered: same objects, new order.
  const d = shareState(c, state([{ uid: 'b2', status: 'working', detail: 'tick 2' }, { uid: 'a1', status: 'idle' }]));
  assert.equal(d.windows[0], c.windows[1]);
  assert.notEqual(d.windows, c.windows);
});
