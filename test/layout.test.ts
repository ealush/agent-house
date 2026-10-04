import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLeaf, replaceLeaf, closeLeaf, setRatio, parseLayout, leaves, paneLeaves, nodeAt, type LayoutNode } from '../web/layout.ts';

const leaf = (k: string): LayoutNode => ({ type: 'session', sessionKey: k });

test('two and three live sessions', () => {
  let l: LayoutNode = leaf('a');
  l = splitLeaf(l, 'a', 'horizontal', 'b');
  assert.deepEqual(leaves(l), ['a', 'b']);
  l = splitLeaf(l, 'b', 'vertical', 'c');
  assert.deepEqual(leaves(l), ['a', 'b', 'c']);
});

test('same session twice is allowed', () => {
  const l = splitLeaf(leaf('a'), 'a', 'horizontal', 'a');
  assert.deepEqual(leaves(l), ['a', 'a']);
});

test('pane paths distinguish duplicate viewers when closing, replacing, and splitting', () => {
  const l = splitLeaf(leaf('a'), [], 'horizontal', 'a');
  assert.deepEqual(paneLeaves(l), [{ sessionKey: 'a', path: ['first'] }, { sessionKey: 'a', path: ['second'] }]);
  assert.deepEqual(closeLeaf(l, ['first']), leaf('a'));
  assert.deepEqual(leaves(replaceLeaf(l, ['second'], 'b')), ['a', 'b']);
  const split = splitLeaf(l, ['second'], 'vertical', 'b');
  assert.deepEqual(leaves(split), ['a', 'a', 'b']);
  assert.deepEqual(nodeAt(split, ['second', 'second']), leaf('b'));
  assert.equal(nodeAt(l, ['first', 'second']), null);
  assert.equal(closeLeaf(l, ['first', 'second']), l, 'stale paths leave the layout alone');
});

test('replace and close collapse', () => {
  let l = splitLeaf(leaf('a'), 'a', 'horizontal', 'b');
  l = replaceLeaf(l, 'b', 'c');
  assert.deepEqual(leaves(l), ['a', 'c']);
  const closed = closeLeaf(l, 'a');
  assert.deepEqual(closed, leaf('c'));
  assert.equal(closeLeaf(leaf('a'), 'a'), null);
});

test('close of unknown key leaves layout alone', () => {
  const l = splitLeaf(leaf('a'), 'a', 'horizontal', 'b');
  assert.deepEqual(closeLeaf(l, 'zzz'), l);
});

test('ratio is clamped and targeted', () => {
  let l = splitLeaf(leaf('a'), 'a', 'horizontal', 'b');
  l = setRatio(l, [], 0.99);
  assert.equal((l as { ratio: number }).ratio, 0.85);
  l = setRatio(l, [], 0.01);
  assert.equal((l as { ratio: number }).ratio, 0.15);
});

test('parseLayout rejects garbage, clamps ratios', () => {
  assert.equal(parseLayout(null), null);
  assert.equal(parseLayout({ type: 'nope' }), null);
  assert.deepEqual(parseLayout({ type: 'session', sessionKey: 'a' }), leaf('a'));
  const bad = parseLayout({ type: 'split', direction: 'sideways', ratio: 9, first: leaf('a'), second: leaf('b') });
  assert.equal(bad, null);
  const l = parseLayout({ type: 'split', direction: 'horizontal', ratio: 9, first: leaf('a'), second: leaf('b') });
  assert.equal((l as { ratio: number }).ratio, 0.85);
  // A split with one dead side collapses to the live side.
  assert.deepEqual(parseLayout({ type: 'split', direction: 'horizontal', first: leaf('a'), second: null }), leaf('a'));
});
