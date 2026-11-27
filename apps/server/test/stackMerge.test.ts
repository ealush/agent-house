import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeUpTo, planStackMerge } from '../web/review/stackMerge.ts';
import type { Gate, Layer, Stack } from '../web/reviewApi.ts';

const ok = (key: Gate['key']): Gate => ({ key, ok: true, label: key });
const no = (key: Gate['key'], detail: string): Gate => ({ key, ok: false, label: key, detail });
function layer(pr: number, head: string, base: string, extra: Partial<Layer> = {}, gates: Gate[] = []): Layer {
  const keys: Gate['key'][] = ['reviewed', 'findings', 'checks', 'mergeable', 'base', 'order'];
  const all = keys.map((k) => gates.find((g) => g.key === k) ?? ok(k));
  return { pr, role: `L${pr}`, state: 'open', headRef: head, baseRef: base, ghStack: null, ghPos: null, gates: all, ...extra } as Layer;
}
const stack = (layers: Layer[]) => ({ layers, trunk: 'main' }) as unknown as Stack;

test('a chain lands whole; layers on the one under them only need it to land first', () => {
  const p = planStackMerge(stack([layer(1, 'a', 'main'), layer(2, 'b', 'a', {}, [no('base', 'Targets a'), no('order', '#1 comes first'), no('reviewed', 'Not marked reviewed yet')])]), 'merge');
  assert.deepEqual(p.lands.map((l) => l.pr), [1, 2]);
  assert.deepEqual(p.review.map((l) => l.pr), [2]);
  assert.equal(p.stop, null);
});

test('a held layer stops the merge there; the ones above it wait', () => {
  const p = planStackMerge(stack([layer(1, 'a', 'main'), layer(2, 'b', 'a', {}, [no('findings', '1 blocking')]), layer(3, 'c', 'b')]), 'merge');
  assert.deepEqual(p.lands.map((l) => l.pr), [1]);
  assert.deepEqual(p.rows.map((r) => [r.layer.pr, r.state, r.why]), [[1, 'ready', null], [2, 'held', '1 blocking'], [3, 'waits', 'Waits for L2']]);
});

test('a layer that targets something outside the stack is held', () => {
  const p = planStackMerge(stack([layer(1, 'a', 'release', {}, [no('base', 'Targets release')])]), 'merge');
  assert.equal(p.upTo, null);
  assert.equal(p.stop?.why, 'Targets release');
});

test('squash on a chain lands the bottom; the next needs a restack', () => {
  const p = planStackMerge(stack([layer(1, 'a', 'main'), layer(2, 'b', 'a', {}, [no('base', 'Targets a')])]), 'squash');
  assert.deepEqual(p.lands.map((l) => l.pr), [1]);
  assert.equal(p.stop?.state, 'restack');
});

test('squash in a GitHub stack lands it all: GitHub restacks its own', () => {
  const gh = (n: number) => ({ ghStack: 7, ghPos: n });
  const p = planStackMerge(stack([layer(1, 'a', 'main', gh(1)), layer(2, 'b', 'a', gh(2)), layer(3, 'c', 'b', gh(3))]), 'squash');
  assert.deepEqual(p.lands.map((l) => l.pr), [1, 2, 3]);
  assert.deepEqual(p.rows.map((r) => r.step), [1, 1, 1], 'one stack merge');
});

test('squash with a layer outside the GitHub stack: it needs a restack, the GitHub stack above it doesn\'t', () => {
  const gh = (n: number) => ({ ghStack: 7, ghPos: n });
  const p = planStackMerge(stack([layer(1, 'a', 'main', gh(1)), layer(5, 'o', 'a'), layer(2, 'b', 'a', gh(2))]), 'squash');
  assert.deepEqual(p.rows.map((r) => [r.layer.pr, r.state]), [[1, 'ready'], [5, 'restack'], [2, 'waits']]);
  const m = planStackMerge(stack([layer(1, 'a', 'main', gh(1)), layer(5, 'o', 'main'), layer(2, 'b', 'a', gh(2))]), 'squash');
  assert.deepEqual(m.lands.map((l) => l.pr), [1, 5, 2], 'one on the trunk already moves nothing');
});

test('merging only the next layer: it lands, and the rest stays in review', () => {
  const p = mergeUpTo(planStackMerge(stack([layer(1, 'a', 'main', {}, [no('reviewed', 'Not marked reviewed yet')]), layer(2, 'b', 'a', {}, [no('reviewed', 'Not marked reviewed yet')]), layer(3, 'c', 'b', {}, [no('findings', '1 blocking')])]), 'merge'), 1);
  assert.deepEqual(p.lands.map((l) => l.pr), [1]);
  assert.equal(p.upTo?.pr, 1);
  assert.deepEqual(p.review.map((l) => l.pr), [1], 'only what lands is marked reviewed');
  assert.deepEqual(p.rows.map((r) => [r.layer.pr, r.state]), [[1, 'review'], [2, 'stays'], [3, 'stays']]);
  assert.equal(p.stop, null, 'a held layer above where it stops holds nothing');
});

test('stopping at a layer that cannot land changes nothing', () => {
  const p = planStackMerge(stack([layer(1, 'a', 'main'), layer(2, 'b', 'a', {}, [no('findings', '1 blocking')])]), 'merge');
  assert.equal(mergeUpTo(p, 2), p);
});
