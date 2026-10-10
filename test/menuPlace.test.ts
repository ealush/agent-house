import { test } from 'node:test';
import assert from 'node:assert/strict';
import { menuViewport, placeFloatingMenu } from '../web/menuPlace.ts';

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

test('keeps a tall menu inside a keyboard-shrunk visual viewport', () => {
  const anchor = { top: 320, right: 400, bottom: 348 };
  const tall = { width: 210, height: 800 };
  const keyboard = { top: 200, left: 0, width: 844, height: 240 };
  assert.deepEqual(placeFloatingMenu(anchor, tall, keyboard), { top: 208, left: 190 });
});

test('opens below the anchor inside an offset visual viewport', () => {
  const anchor = { top: 210, right: 400, bottom: 234 };
  const keyboard = { top: 200, left: 0, width: 844, height: 400 };
  assert.deepEqual(placeFloatingMenu(anchor, menu, keyboard), { top: 240, left: 190 });
});

test('flips above the anchor inside an offset visual viewport', () => {
  const anchor = { top: 600, right: 400, bottom: 624 };
  const keyboard = { top: 200, left: 0, width: 844, height: 500 };
  assert.deepEqual(placeFloatingMenu(anchor, menu, keyboard), { top: 294, left: 190 });
});

test('menuViewport uses the visual band, and the layout viewport while zoomed', () => {
  const layout = { width: 844, height: 390 };
  assert.deepEqual(menuViewport(layout, null), { top: 0, left: 0, width: 844, height: 390 });
  assert.deepEqual(
    menuViewport(layout, { width: 844, height: 220, offsetTop: 80, offsetLeft: 0, scale: 1 }),
    { top: 80, left: 0, width: 844, height: 220 },
  );
  assert.deepEqual(
    menuViewport(layout, { width: 400, height: 200, offsetTop: 10, scale: 2 }),
    { top: 0, left: 0, width: 844, height: 390 },
  );
});
