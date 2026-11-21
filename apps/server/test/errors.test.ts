// Errors as people read them: a request that never reached the host says so,
// in every browser's wording, instead of "Failed to fetch".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorText, isNetworkError, reachText } from '../web/errors.ts';

test('a network failure reads the same in every browser', () => {
  for (const m of ['Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.']) {
    assert.ok(isNetworkError(new TypeError(m)), m);
    assert.match(errorText(new TypeError(m)), /can't be reached/);
    assert.equal(reachText(new TypeError(m)), "Can't reach the host. Reconnecting…");
  }
});

test("the host's own errors pass through", () => {
  assert.equal(isNetworkError(new Error('Failed to fetch')), false, 'only a TypeError is the network');
  assert.equal(errorText(new Error('Session not found')), 'Session not found');
  assert.equal(reachText(new Error('unauthorized')), "Can't reach server: unauthorized");
  assert.equal(errorText('plain'), 'plain');
});
