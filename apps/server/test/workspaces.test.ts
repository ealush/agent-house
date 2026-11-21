import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY, occupied, sendTo, switchTo, type Spaces } from '../web/workspaces.ts';
import { paneLeaves, type LayoutNode } from '../web/layout.ts';

const leaf = (k: string): LayoutNode => ({ type: 'session', sessionKey: k });
const pair = (a: string, b: string): LayoutNode => ({ type: 'split', direction: 'horizontal', ratio: 0.5, first: leaf(a), second: leaf(b) });

test('switching keeps what you leave and brings back what was there', () => {
  let s: Spaces = { current: 1, slots: {} };
  const one = { layout: null, selected: '@1' };
  const a = switchTo(s, 2, one);
  assert.deepEqual(a.show, EMPTY, 'an unused workspace is empty');
  s = a.spaces;
  const b = switchTo(s, 1, { layout: pair('@2', '@3'), selected: null });
  assert.deepEqual(b.show, one);
  assert.ok(occupied(b.spaces.slots[2]));
});

test('sending a pane closes it here and tiles it there', () => {
  const s: Spaces = { current: 1, slots: { 2: { layout: null, selected: '@9' } } };
  const r = sendTo(s, 2, '@3', { layout: pair('@2', '@3'), selected: null }, ['second']);
  assert.deepEqual(r.show, { layout: null, selected: '@2' }, 'one pane left: that session alone');
  assert.deepEqual(paneLeaves(r.spaces.slots[2].layout!).map((p) => p.sessionKey), ['@9', '@3']);
  const alone = sendTo(s, 3, '@1', { layout: null, selected: '@1' }, null);
  assert.deepEqual(alone.show, EMPTY);
  assert.deepEqual(alone.spaces.slots[3], { layout: null, selected: '@1' });
});
