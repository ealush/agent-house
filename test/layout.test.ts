import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLeaf, replaceLeaf, closeLeaf, setRatio, parseLayout, leaves, paneLeaves, nodeAt, neighborPane, moveLeaf, toggleSplit, dockLeaf, moveLeafTo, normalizeSplit, type LayoutNode, type Path } from '../web/layout.ts';

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

test('one pane is not a split', () => {
  const pair = splitLeaf(leaf('a'), 'a', 'horizontal', 'b');
  assert.equal(normalizeSplit(pair), pair);
  assert.equal(normalizeSplit(closeLeaf(pair, 'b')), null);
  assert.equal(normalizeSplit(leaf('a')), null);
  assert.equal(normalizeSplit(null), null);
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

test('moving the bottom-right pane down makes it a full-width row', () => {
  // a | (b / c). c is the pane stuck at the bottom of the right column.
  const stack = row(leaf('a'), col(leaf('b'), leaf('c')));
  const moved = moveLeaf(stack, ['second', 'second'], 'down');
  assert.deepEqual(moved.layout, col(row(leaf('a'), leaf('b')), leaf('c')));
  assert.deepEqual(moved.path, ['second']);
  // Once it spans the bottom, another down leaves the split and its ratio alone.
  const sized = col(row(leaf('a'), leaf('b')), leaf('c'), 0.7);
  assert.equal(moveLeaf(sized, ['second'], 'down').layout, sized);
});

test('moving toward a sibling swaps the two halves', () => {
  const pair = row(leaf('a'), leaf('b'), 0.7);
  const moved = moveLeaf(pair, ['first'], 'right');
  assert.deepEqual(moved.layout, row(leaf('b'), leaf('a'), 0.7));
  assert.deepEqual(moved.path, ['second']);
  // Up from the full-width bottom pane stacks it on top.
  const below = col(row(leaf('a'), leaf('b')), leaf('c'));
  assert.deepEqual(moveLeaf(below, ['second'], 'up').layout, col(leaf('c'), row(leaf('a'), leaf('b'))));
});

test('moving sideways steps into the neighbor instead of spanning the edge', () => {
  const stack = row(leaf('a'), col(leaf('b'), leaf('c')));
  const moved = moveLeaf(stack, ['second', 'second'], 'left');
  assert.deepEqual(moved.layout, row(row(leaf('c'), leaf('a')), leaf('b')));
  assert.deepEqual(moved.path, ['first', 'first']);
});

test('flip split turns the parent the other way', () => {
  const pair = row(leaf('a'), leaf('b'), 0.7);
  assert.deepEqual(toggleSplit(pair, ['second']), col(leaf('a'), leaf('b'), 0.7));
  assert.deepEqual(toggleSplit(leaf('a'), []), leaf('a'));
});

test('docking on the bottom edge spans the workspace', () => {
  const stack = row(leaf('a'), col(leaf('b'), leaf('c'), 0.4), 0.3);
  const docked = dockLeaf(stack, ['second', 'second'], 'down');
  assert.deepEqual(docked.layout, col(row(leaf('a'), leaf('b'), 0.3), leaf('c')));
  assert.deepEqual(docked.path, ['second']);
  assert.equal(dockLeaf(docked.layout, ['second'], 'down').layout, docked.layout);
});

test('dropping a pane splits the target and keeps the one left behind', () => {
  const stack = row(leaf('a'), col(leaf('b'), leaf('c')));
  // c leaves the right column, so that column collapses to b, and a splits below.
  const dropped = moveLeafTo(stack, ['second', 'second'], ['first'], 'bottom');
  assert.deepEqual(dropped.layout, row(col(leaf('a'), leaf('c')), leaf('b')));
  assert.deepEqual(dropped.path, ['first', 'second']);
  const swapped = moveLeafTo(stack, ['second', 'second'], ['first'], 'center');
  assert.deepEqual(swapped.layout, row(leaf('c'), col(leaf('b'), leaf('a'))));
  assert.deepEqual(swapped.path, ['first']);
  assert.equal(moveLeafTo(stack, ['first'], ['first'], 'left').layout, stack);
});

test('keyboard resize moves the nearest divider of the arrow’s kind', async () => {
  const { nudgeDivider } = await import('../web/layout.ts');
  // [A | [B / C]]: B is stacked over C, beside A.
  const tree = { type: 'split', direction: 'horizontal', ratio: 0.5, first: { type: 'session', sessionKey: 'A' }, second: { type: 'split', direction: 'vertical', ratio: 0.5, first: { type: 'session', sessionKey: 'B' }, second: { type: 'session', sessionKey: 'C' } } } as const;
  const right = nudgeDivider(tree as any, ['second', 'first'], 'right') as any;
  assert.equal(right.ratio, 0.55, '→ from B moves the A|B divider right');
  const down = nudgeDivider(tree as any, ['second', 'first'], 'down') as any;
  assert.equal(down.second.ratio, 0.55, '↓ from B moves the B/C divider down');
  assert.equal(nudgeDivider(tree as any, ['first'], 'up'), tree, 'A has no stacked divider above it');
  let far: any = tree;
  for (let i = 0; i < 20; i++) far = nudgeDivider(far, ['first'], 'left');
  assert.equal(far.ratio, 0.15, 'clamped like a drag');
});

test('a chooser pane remembers what it replaced, and a split’s chooser nothing', async () => {
  const { pickKey, isPick, pickPrevious } = await import('../web/layout.ts');
  assert.equal(isPick(pickKey()), true);
  assert.equal(pickPrevious(pickKey()), null, 'a new split closes on cancel');
  assert.equal(pickPrevious(pickKey('@4')), '@4', 'Replace pane puts the session back on cancel');
  assert.equal(isPick('@4'), false);
});
