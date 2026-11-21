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
  const diff = searchTree(tree, 'panels diff')[0];
  assert.equal(diff.node.command, 'panel-diff');
  assert.deepEqual(diff.trail.map((t) => t.key), ['session', 'panels']);
  // Scoped: inside Workspace, nothing from Session matches.
  const workspace = tree.children!.find((c) => c.key === 'workspace')!;
  assert.ok(searchTree(workspace, 'diff').every((h) => !h.node.command?.startsWith('panel')));
  assert.deepEqual(searchTree(tree, '   '), []);
});

test("Go to has Search and no History: History lives in Search", async () => {
  const tree = await resolveTree(undefined, { active: all, provide: none });
  const go = tree.children!.find((c) => c.key === 'go')!.children!.map((c) => c.command);
  assert.ok(go.includes('go-search'));
  assert.ok(!go.includes('go-history' as never));
  assert.equal(searchTree(tree, 'history')[0]?.node.command, 'go-search');
});

test('a category counts the commands under it', async () => {
  const tree = await resolveTree(undefined, { active: all, provide: none });
  const move = tree.children!.find((c) => c.key === 'workspace')!.children!.find((c) => c.key === 'move')!;
  assert.equal(leafCount(move), 4);
});

test('a name match stays above a match on a related word', async () => {
  const tree = await resolveTree(undefined, { active: all, provide: none });
  const right = searchTree(tree, 'right');
  const splitRight = right.find((h) => h.node.command === 'split-right');
  assert.ok(splitRight);
  assert.equal(splitRight.related, false);

  const pane = searchTree(tree, 'pane');
  const byName = pane.find((h) => h.node.command === 'focus-pane-left');
  const byTerm = pane.find((h) => h.node.command === 'split-right');
  const below = pane.find((h) => h.node.command === 'split-below');
  assert.ok(byName && byTerm && below);
  assert.equal(byName.related, false);
  assert.equal(byTerm.related, true);
  assert.equal(below.related, true);
  const firstRelated = pane.findIndex((h) => h.related);
  assert.ok(firstRelated > 0);
  assert.ok(pane.slice(0, firstRelated).every((h) => !h.related));
  assert.ok(pane.slice(firstRelated).every((h) => h.related));
  assert.ok(pane.indexOf(byName) < pane.indexOf(byTerm));
});

test('a breadcrumb matches word by word, never as a loose subsequence', async () => {
  const tree = await resolveTree(undefined, {
    active: all,
    provide: async (id) => (id === 'efforts' ? [{ key: 'efforts', label: 'Reasoning effort', children: [{ key: 'low', label: 'low', run: () => {} }] }] : []),
  });
  assert.ok(!searchTree(tree, 'diff').some((h) => h.node.key === 'low'), '"diff" is not in "Model and effort Reasoning effort low"');
  assert.equal(searchTree(tree, 'effort low')[0]?.node.key, 'low');
});

test('every command in the catalog has a place in the palette tree', async () => {
  const { TREE } = await import('../web/palette.ts');
  const { COMMANDS } = await import('../web/shortcuts.ts');
  const placed = new Set<string>();
  const walk = (s: any) => s.children.forEach((c: any) => (typeof c === 'string' ? placed.add(c) : 'children' in c ? walk(c) : null));
  walk(TREE);
  const missing = COMMANDS.map((c) => c.id).filter((id) => id !== 'command-palette' && !placed.has(id));
  assert.deepEqual(missing, []);
});

test('settings live under their own category, searchable from the top', async () => {
  const tree = await resolveTree(undefined, {
    active: all,
    provide: async (id) =>
      id === 'settings'
        ? [
            { key: 'restart-server', label: 'Restart server', run: () => {} },
            { key: 'pages', label: 'Open settings', children: [{ key: 'settings:environment', label: 'Environment', detail: 'Variables every session starts with', run: () => {} }] },
          ]
        : [],
  });
  const settings = tree.children!.find((c) => c.key === 'settings')!;
  assert.deepEqual(settings.children!.map((c) => c.key), ['restart-server', 'pages']);
  assert.equal(searchTree(tree, 'restart server')[0].node.key, 'restart-server');
  const env = searchTree(tree, 'environment')[0];
  assert.equal(env.node.key, 'settings:environment');
  assert.deepEqual(env.trail.map((t) => t.key), ['settings', 'pages']);
});
