import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from '../web/useSideSwipe.ts';

test('a slow release settles by how much of the sidebar shows', () => {
  assert.equal(settle(0.7, 0), true);
  assert.equal(settle(0.3, 0), false);
});

test('a flick decides alone, either way', () => {
  assert.equal(settle(0.15, 0.8), true);
  assert.equal(settle(0.9, -0.8), false);
});

test('a slow drift the other way still settles by position', () => {
  assert.equal(settle(0.7, -0.1), true);
  assert.equal(settle(0.3, 0.1), false);
});
