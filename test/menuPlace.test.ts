import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeFloatingMenu } from '../web/menuPlace.ts';

const viewport = { width: 1200, height: 800 };
const menu = { width: 210, height: 300 };

test('opens below the anchor when there is room', () => {
  const anchor = { top: 40, right: 1150, bottom: 64 };
  assert.deepEqual(placeFloatingMenu(anchor, menu, viewport), { top: 70, left: 940 });
});

test('flips above the anchor near the viewport bottom (short split panes)', () => {
  const anchor = { top: 600, right: 1150, bottom: 624 };
  assert.deepEqual(placeFloatingMenu(anchor, menu, viewport), { top: 294, left: 940 });
});

test('clamps to the margin when the menu is taller than the viewport', () => {
  const anchor = { top: 100, right: 1150, bottom: 124 };
  const tall = { width: 210, height: 1000 };
  assert.deepEqual(placeFloatingMenu(anchor, tall, viewport), { top: 8, left: 940 });
});

test('clamps horizontally near the left edge', () => {
  const anchor = { top: 40, right: 100, bottom: 64 };
  assert.deepEqual(placeFloatingMenu(anchor, menu, viewport), { top: 70, left: 8 });
});
