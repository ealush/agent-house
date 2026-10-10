import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leafCount, resolveTree, searchTree, type PaletteNode } from '../web/palette.ts';

const all = () => true;
const none = async () => [] as PaletteNode[];

test('the tree drops commands that cannot run and prunes empty categories', async () => {
  const tree = await resolveTree(undefined, { active: (id) => id === 'go-inbox' || id === 'panel-diff', provide: none });
  assert.deepEqual(tree.children!.map((c) => c.key), ['go', 'session']);
  const session = tree.children!.find((c) => c.key === 'session')!;
  assert.deepEqual(session.children!.map((c) => c.key), ['panels']);
  assert.deepEqual(session.children![0].children!.map((c) => c.command), ['panel-diff']);
});

test('live branches land where the static tree says', async () => {
  const tree = await resolveTree(undefined, {
    active: all,
    provide: async (id) => (id === 'queue' ? [{ key: 'queued:a', label: 'fix the tests', children: [{ key: 'send', label: 'Send now', run: () => {} }] }] : []),
  });
  const turn = tree.children!.find((c) => c.key === 'session')!.children!.find((c) => c.key === 'turn')!;
  assert.deepEqual(turn.children!.map((c) => c.key), ['interrupt', 'send-now', 'queued:a', 'clear-queue']);
});

test('search finds categories and commands below the scope, with their breadcrumb', async () => {
  const tree = await resolveTree(undefined, { active: all, provide: none });
  const [first] = searchTree(tree, 'panels');
  assert.equal(first.node.key, 'panels');
  assert.deepEqual(first.trail.map((t) => t.key), ['session']);
  const diff = searchTree(tree, 'panel: diff')[0];
  assert.equal(diff.node.command, 'panel-diff');
  assert.deepEqual(diff.trail.map((t) => t.key), ['session', 'panels']);
  // Scoped: inside Workspace, nothing from Session matches.
  const workspace = tree.children!.find((c) => c.key === 'workspace')!;
  assert.ok(searchTree(workspace, 'diff').every((h) => !h.node.command?.startsWith('panel')));
  assert.deepEqual(searchTree(tree, '   '), []);
});

test('a category counts the commands under it', async () => {
  const tree = await resolveTree(undefined, { active: all, provide: none });
  const move = tree.children!.find((c) => c.key === 'workspace')!.children!.find((c) => c.key === 'move')!;
  assert.equal(leafCount(move), 4);
});

test('a breadcrumb matches word by word, never as a loose subsequence', async () => {
  const tree = await resolveTree(undefined, {
    active: all,
    provide: async (id) => (id === 'efforts' ? [{ key: 'efforts', label: 'Reasoning effort', children: [{ key: 'low', label: 'low', run: () => {} }] }] : []),
  });
  assert.ok(!searchTree(tree, 'diff').some((h) => h.node.key === 'low'), '"diff" is not in "Model and effort Reasoning effort low"');
  assert.equal(searchTree(tree, 'effort low')[0]?.node.key, 'low');
});
