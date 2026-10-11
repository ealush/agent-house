import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasLegacy, isLegacyKey, upgradeKey, upgradeLayout, upgradeSpaces } from '../web/sessionKeys.ts';
import { leaves, pickKey, type LayoutNode } from '../web/layout.ts';

const leaf = (k: string): LayoutNode => ({ type: 'session', sessionKey: k });
const pair = (a: string, b: string): LayoutNode => ({ type: 'split', direction: 'horizontal', ratio: 0.5, first: leaf(a), second: leaf(b) });
const windows = [
  { id: '@2', key: '5e8a1308' },
  { id: '@2', key: 'mac/77aa0011' },
  { id: '@7', key: 'c0ffee12' },
];

test('window ids are legacy keys; uids are not', () => {
  assert.ok(isLegacyKey('@12'));
  assert.ok(isLegacyKey('mac/@12'));
  assert.ok(!isLegacyKey('5e8a1308'));
  assert.ok(!isLegacyKey('mac/5e8a1308'));
  assert.ok(!isLegacyKey(pickKey('@3').replace('@3', '')));
});

test('a window id becomes the uid key of the same window on the same host', () => {
  assert.equal(upgradeKey('@2', windows), '5e8a1308');
  assert.equal(upgradeKey('mac/@2', windows), 'mac/77aa0011');
  assert.equal(upgradeKey('@99', windows), null, 'a window that is gone has no key');
  assert.equal(upgradeKey('c0ffee12', windows), 'c0ffee12', 'current keys pass through');
});

test('saved layouts and workspaces move to uids; a gone window becomes a chooser', () => {
  const layout = upgradeLayout(pair('@7', '@99'), windows)!;
  assert.deepEqual(leaves(layout), ['c0ffee12', pickKey()]);
  const spaces = upgradeSpaces({ current: 1, slots: { 2: { layout: null, selected: 'mac/@2' }, 3: { layout: pair('@2', 'c0ffee12'), selected: null } } }, windows);
  assert.equal(spaces.slots[2].selected, 'mac/77aa0011');
  assert.deepEqual(leaves(spaces.slots[3].layout!), ['5e8a1308', 'c0ffee12']);
  assert.ok(!hasLegacy(layout, spaces, 'c0ffee12'));
  assert.ok(hasLegacy(null, { current: 1, slots: {} }, '@3'));
});
