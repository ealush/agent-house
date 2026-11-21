import { test } from 'node:test';
import assert from 'node:assert/strict';
import { swipeLeaves } from '../web/useSwipeBack.ts';

const W = 393;
test("a release goes where the finger was headed, as an iPhone's back swipe does", () => {
  assert.equal(swipeLeaves(0.48 * W, W, -0.6), false, 'dragged past half, flicked back: stays');
  assert.equal(swipeLeaves(0.27 * W, W, 1.5), true, 'a flick from a quarter: goes');
  assert.equal(swipeLeaves(0.4 * W, W, 0), false, 'a slow stop short of half: stays');
  assert.equal(swipeLeaves(0.6 * W, W, 0), true, 'past half, let go: goes');
});
