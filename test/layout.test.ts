import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLeaf, replaceLeaf, closeLeaf, setRatio, parseLayout, leaves, paneLeaves, nodeAt, neighborPane, type LayoutNode, type Path } from '../web/layout.ts';

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

const row = (first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode => ({ type: 'split', direction: 'horizontal', ratio, first, second });
const col = (first: LayoutNode, second: LayoutNode, ratio = 0.5): LayoutNode => ({ type: 'split', direction: 'vertical', ratio, first, second });

test('neighbor follows the shared edge, not a corner or a farther pane', () => {
  // a | (b / c). Right from the full-height pane lands on the top of the stack.
  const stack = row(leaf('a'), col(leaf('b'), leaf('c')));
  assert.deepEqual(neighborPane(stack, ['first'], 'right'), ['second', 'first']);
  assert.equal(neighborPane(stack, ['first'], 'down'), null);
  assert.deepEqual(neighborPane(stack, ['second', 'first'], 'left'), ['first']);
  assert.deepEqual(neighborPane(stack, ['second', 'first'], 'down'), ['second', 'second']);
  assert.deepEqual(neighborPane(stack, ['second', 'second'], 'left'), ['first']);
  assert.deepEqual(neighborPane(stack, ['second', 'second'], 'up'), ['second', 'first']);

  // 2×2. Right from the top-left is the top-right, not the pane that only meets the corner.
  const grid = col(row(leaf('tl'), leaf('tr')), row(leaf('bl'), leaf('br')));
  const topLeft: Path = ['first', 'first'];
  assert.deepEqual(neighborPane(grid, topLeft, 'right'), ['first', 'second']);
  assert.deepEqual(neighborPane(grid, topLeft, 'down'), ['second', 'first']);
  assert.equal(neighborPane(grid, topLeft, 'left'), null);
  assert.equal(neighborPane(grid, topLeft, 'up'), null);

  // Uneven edges: the bottom-left shares its right edge with the tall bottom-right, not the short top-right.
  const uneven = row(col(leaf('a'), leaf('b'), 0.7), col(leaf('c'), leaf('d'), 0.4), 0.3);
  assert.deepEqual(neighborPane(uneven, ['first', 'second'], 'right'), ['second', 'second']);
  assert.deepEqual(neighborPane(uneven, ['first', 'first'], 'right'), ['second', 'first']);

  const columns = row(leaf('a'), row(leaf('b'), leaf('c')), 1 / 3);
  assert.deepEqual(neighborPane(columns, ['first'], 'right'), ['second', 'first']);
  assert.equal(neighborPane(leaf('a'), [], 'right'), null);
  assert.equal(neighborPane(stack, ['first', 'second'], 'left'), null);
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
