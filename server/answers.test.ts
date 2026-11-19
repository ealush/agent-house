import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AnswerGuard, ANSWER_HOLD_MS } from './answers.ts';

test('a prompt is answered once', () => {
  const g = new AnswerGuard();
  assert.equal(g.claim('u1', 'ask-a', 0), true);
  assert.equal(g.claim('u1', 'ask-a', 100), false, 'a second tap on the same prompt');
  assert.equal(g.claim('u2', 'ask-a', 100), true, 'another session’s prompt is its own');
});

test('the next prompt can be answered at once', () => {
  const g = new AnswerGuard();
  g.claim('u1', 'ask-a', 0);
  assert.equal(g.claim('u1', 'ask-b', 50), true);
});

test('a pass that sees the session leave the prompt lets the same prompt be answered again', () => {
  const g = new AnswerGuard();
  g.claim('u1', 'ask-a', 0);
  g.observe([{ uid: 'u1', status: 'waiting', askId: 'ask-a' }]);
  assert.equal(g.claim('u1', 'ask-a', 10), false, 'still on screen: still answered');
  g.observe([{ uid: 'u1', status: 'busy', askId: null }]);
  assert.equal(g.claim('u1', 'ask-a', 20), true, 'it moved on, then asked the same thing again');
  g.observe([]);
  assert.equal(g.claim('u1', 'ask-a', 30), true, 'the session is gone');
});

test('an answer holds only so long without a pass seeing it land', () => {
  const g = new AnswerGuard();
  g.claim('u1', 'ask-a', 0);
  assert.equal(g.claim('u1', 'ask-a', ANSWER_HOLD_MS - 1), false);
  assert.equal(g.claim('u1', 'ask-a', ANSWER_HOLD_MS), true);
});

test('keys that never went out leave the prompt unanswered', () => {
  const g = new AnswerGuard();
  g.claim('u1', 'ask-a', 0);
  g.release('u1', 'ask-a');
  assert.equal(g.claim('u1', 'ask-a', 1), true);
  g.release('u1', 'ask-other');
  assert.equal(g.claim('u1', 'ask-a', 2), false, 'releasing another prompt changes nothing');
});

test('a prompt ah couldn’t read (no fingerprint) is never held: the next one may differ', () => {
  const g = new AnswerGuard();
  assert.equal(g.claim('u1', null, 0), true);
  assert.equal(g.claim('u1', null, 10), true);
});
