import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffState, NO_FINGERPRINTS, StateStream } from './stateStream.ts';

const w = (uid: string, status = 'idle') => ({ uid, status });
const state = (windows: Array<{ uid: string; status: string }>, extra: Record<string, unknown> = {}) => ({ api: 28, history: [{ ref: 'h1' }], windows, ...extra });

test('the first pass sends everything', () => {
  const s = state([w('a'), w('b')]);
  const { frames } = diffState(NO_FINGERPRINTS, s);
  assert.equal(frames?.full, JSON.stringify(s));
  assert.deepEqual(JSON.parse(frames!.patch), s);
  assert.deepEqual(JSON.parse(frames!.slim), { api: 28, history: [{ ref: 'h1' }], windowsDelta: { changed: [w('a'), w('b')], order: ['a', 'b'] } });
});

test('a pass that changed nothing sends nothing', () => {
  const { next } = diffState(NO_FINGERPRINTS, state([w('a')]));
  assert.equal(diffState(next, state([w('a')])).frames, null);
});

test('one window working: the patch is the windows, the slim frame only that window', () => {
  const { next } = diffState(NO_FINGERPRINTS, state([w('a'), w('b')]));
  const { frames } = diffState(next, state([w('a'), w('b', 'busy')]));
  assert.deepEqual(JSON.parse(frames!.patch), { windows: [w('a'), w('b', 'busy')] });
  assert.deepEqual(JSON.parse(frames!.slim), { windowsDelta: { changed: [w('b', 'busy')], order: ['a', 'b'] } });
});

test('a window gone: no window changed, but the order says who is left', () => {
  const { next } = diffState(NO_FINGERPRINTS, state([w('a'), w('b')]));
  const { frames } = diffState(next, state([w('b')]));
  assert.deepEqual(JSON.parse(frames!.slim), { windowsDelta: { changed: [], order: ['b'] } });
});

test('a change outside the windows: the slim frame is the patch', () => {
  const { next } = diffState(NO_FINGERPRINTS, state([w('a')]));
  const { frames } = diffState(next, state([w('a')], { history: [] }));
  assert.equal(frames!.slim, frames!.patch);
  assert.deepEqual(JSON.parse(frames!.patch), { history: [] });
});

test('the last pass’s fingerprints are never changed by the next', () => {
  const first = diffState(NO_FINGERPRINTS, state([w('a')])).next;
  const before = JSON.stringify([...first.fields, ...first.windows]);
  diffState(first, state([w('a', 'busy')], { history: [] }));
  assert.equal(JSON.stringify([...first.fields, ...first.windows]), before);
  assert.equal(NO_FINGERPRINTS.fields.size + NO_FINGERPRINTS.windows.size, 0);
});

test('a subscriber gets the whole state when it joins, then each change', () => {
  const stream = new StateStream();
  const early: Array<[string, string | null]> = [];
  stream.subscribe((full, patch) => early.push([full, patch]));
  assert.equal(early.length, 0, 'nothing to send before the first pass');
  stream.publish(state([w('a')]));
  stream.publish(state([w('a')]));
  stream.publish(state([w('a', 'busy')]));
  assert.equal(early.length, 2, 'the unchanged pass sent nothing');
  const late: Array<[string, string | null]> = [];
  const stop = stream.subscribe((full, patch) => late.push([full, patch]));
  assert.deepEqual(late, [[JSON.stringify(state([w('a', 'busy')])), null]]);
  stop();
  stream.publish(state([w('a')]));
  assert.equal(late.length, 1, 'unsubscribed');
});
