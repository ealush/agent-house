import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inWindow, parseMode } from '../web/windowControls.ts';

// iPad Pro 11: iPadOS reports the screen in portrait.
const ipad = { standalone: true, ipad: true, screenW: 834, screenH: 1194 };

test('full screen, either way round, has no window buttons', () => {
  assert.equal(inWindow({ ...ipad, innerW: 1194, innerH: 834 }), false);
  assert.equal(inWindow({ ...ipad, innerW: 834, innerH: 1194 }), false);
});

test('a home-screen app a shim short of the screen is still full screen', () => {
  assert.equal(inWindow({ ...ipad, innerW: 834, innerH: 1134 }), false);
});

test('a Stage Manager window, a tiled half and a short window are windows', () => {
  assert.equal(inWindow({ ...ipad, innerW: 900, innerH: 700 }), true);
  assert.equal(inWindow({ ...ipad, innerW: 590, innerH: 834 }), true);
  assert.equal(inWindow({ ...ipad, innerW: 1194, innerH: 600 }), true);
});

test('only a home-screen app on an iPad: Safari draws its own bar, a Mac has none', () => {
  assert.equal(inWindow({ ...ipad, standalone: false, innerW: 900, innerH: 700 }), false);
  assert.equal(inWindow({ ...ipad, ipad: false, innerW: 900, innerH: 700 }), false);
});

test('the setting reads back as auto unless on or off', () => {
  assert.equal(parseMode('on'), 'on');
  assert.equal(parseMode('off'), 'off');
  assert.equal(parseMode(null), 'auto');
  assert.equal(parseMode('yes'), 'auto');
});
