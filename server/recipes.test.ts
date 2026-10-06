import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated } from './db.ts';
import {
  RecipeStore,
  HandoffEngine,
  validateRecipe,
  validateRecipes,
  resolveTemplate,
  templateVars,
  runVars,
  effectiveRecipes,
  BUILT_IN_RECIPES,
  type RunRecord,
} from './recipes.ts';
import type { Preset } from './config.ts';

const presets: Preset[] = [
  { id: 'claude', name: 'Claude Code', command: 'claude' },
  { id: 'codex', name: 'Codex', command: 'codex' },
];

const pair = {
  id: 'pair',
  name: 'Pair',
  members: [
    { key: 'builder', preset: 'claude', title: 'Builder', prompt: '{brief}' },
    { key: 'reviewer', preset: 'codex', title: 'Reviewer', prompt: 'wait' },
  ],
  handoffs: [{ when: { session: 'builder', event: 'turn-end' }, sendTo: 'reviewer', template: 'review the work in {builder.worktree} on {builder.branch}' }],
};

test('validateRecipe accepts a well-formed recipe and normalizes it', () => {
  const v = validateRecipe(pair, presets);
  assert.deepEqual(v.errors, []);
  assert.equal(v.recipe?.members.length, 2);
  assert.equal(v.recipe?.handoffs?.[0].repeat, undefined);
});

test('validateRecipe names the specific problem', () => {
  const badVar = validateRecipe({ ...pair, members: [pair.members[0], { ...pair.members[1], prompt: 'see {nope.cwd}' }] }, presets);
  assert.ok(badVar.errors.some((e) => e.includes('{nope.cwd}')), badVar.errors.join('; '));

  const badPreset = validateRecipe({ ...pair, members: [{ ...pair.members[0], preset: 'nope' }, pair.members[1]] }, presets);
  assert.ok(badPreset.errors.some((e) => e.includes('unknown preset "nope"')));

  const dup = validateRecipe({ ...pair, members: [pair.members[0], { ...pair.members[1], key: 'builder' }] }, presets);
  assert.ok(dup.errors.some((e) => e.includes('duplicate member key')));

  const selfHandoff = validateRecipe({ ...pair, handoffs: [{ when: { session: 'builder', event: 'turn-end' }, sendTo: 'builder', template: 'x' }] }, presets);
  assert.ok(selfHandoff.errors.some((e) => e.includes('itself')));

  const badCwdFrom = validateRecipe({ ...pair, members: [pair.members[0], { ...pair.members[1], cwdFrom: 'ghost' }] }, presets);
  assert.ok(badCwdFrom.errors.some((e) => e.includes('cwdFrom points at unknown member')));

  const list = validateRecipes([pair, pair], presets);
  assert.ok(list.errors.some((e) => e.includes('duplicate recipe id')));
});

test('built-in recipes validate against the built-in presets they use', () => {
  for (const r of BUILT_IN_RECIPES) {
    const v = validateRecipe(r, presets);
    assert.deepEqual(v.errors, [], `${r.id}: ${v.errors.join('; ')}`);
  }
});

test('effectiveRecipes defaults to the built-ins and honors a saved list', () => {
  assert.equal(effectiveRecipes({} as never), BUILT_IN_RECIPES);
  const custom = [{ id: 'x', name: 'X', members: [] }];
  assert.equal(effectiveRecipes({ recipes: custom } as never), custom);
});

test('template variables resolve from a run', () => {
  assert.deepEqual(templateVars('a {brief} b {builder.cwd}'), ['brief', 'builder.cwd']);
  const run = {
    brief: 'do the thing',
    members: [
      { key: 'builder', uid: 'u1', title: 'Builder', preset: 'claude', cwd: '/repo/wt', branch: 'ah/x', worktree: '/repo/wt' },
      { key: 'reviewer', uid: 'u2', title: 'Reviewer', preset: 'codex', cwd: '/repo/wt', branch: null, worktree: null },
    ],
  } as RunRecord;
  const vars = runVars(run);
  assert.equal(resolveTemplate('review {builder.worktree} on {builder.branch}: {brief}', vars), 'review /repo/wt on ah/x: do the thing');
  assert.equal(vars['reviewer.worktree'], '/repo/wt', 'a member without a worktree resolves to its cwd');
});

async function freshStore(): Promise<RecipeStore> {
  const dir = await mkdtemp(join(tmpdir(), 'ah-recipes-'));
  const path = join(dir, 'ah.db');
  await ensureMigrated(path);
  const store = new RecipeStore(path);
  await store.ready();
  return store;
}

function makeRun(store: RecipeStore, handoffs: Array<Partial<Parameters<RecipeStore['addHandoff']>[0]>> = []) {
  const run: RunRecord = {
    runId: 'run1',
    recipeId: 'pair',
    name: 'Pair',
    host: 'h',
    cwd: '/repo',
    brief: 'do it',
    state: 'running',
    createdAt: 1000,
    members: [
      { key: 'builder', uid: 'u1', title: 'Builder', preset: 'claude', cwd: '/repo/wt', branch: 'ah/x', worktree: '/repo/wt' },
      { key: 'reviewer', uid: 'u2', title: 'Reviewer', preset: 'codex', cwd: '/repo/wt', branch: null, worktree: null },
    ],
    snapshot: validateRecipe(pair, presets).recipe!,
  };
  store.createRun(run);
  handoffs.forEach((h, i) =>
    store.addHandoff({
      id: `h${i}`,
      runId: 'run1',
      sourceUid: 'u1',
      targetUid: 'u2',
      sourceKey: 'builder',
      targetKey: 'reviewer',
      event: 'turn-end',
      template: 'review the work in {builder.worktree} on {builder.branch}',
      repeat: false,
      state: 'pending',
      armed: false,
      fires: 0,
      ...h,
    }),
  );
  return run;
}

const both = new Map([
  ['u1', 'idle'],
  ['u2', 'idle'],
]);
const aliveBoth = new Set(['u1', 'u2']);

test('runs and pending handoffs survive a store reload (restart persistence)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-recipes-'));
  const path = join(dir, 'ah.db');
  await ensureMigrated(path);
  const first = new RecipeStore(path);
  await first.ready();
  makeRun(first, [{}]);
  await first.settled();

  const second = new RecipeStore(path);
  await second.ready();
  assert.equal(second.getRun('run1')?.state, 'running');
  assert.equal(second.pendingHandoffs().length, 1);
  assert.equal(second.pendingHandoffs()[0].sourceUid, 'u1');
});

test('turn-end handoff arms on busy and fires exactly once, with variables resolved', async () => {
  const store = await freshStore();
  makeRun(store, [{}]);
  const sent: Array<{ uid: string; text: string; label: string }> = [];
  const engine = new HandoffEngine(store, async (uid, text, source) => {
    sent.push({ uid, text, label: source.label });
    return { outcome: 'delivered' as const };
  });
  await engine.observe(new Map([['u1', 'busy'], ['u2', 'idle']]), aliveBoth);
  assert.equal(sent.length, 0, 'no fire while the turn is still running');
  assert.equal(store.getHandoff('h0')?.armed, true);
  await engine.observe(both, aliveBoth);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].uid, 'u2');
  assert.equal(sent[0].text, 'review the work in /repo/wt on ah/x');
  assert.equal(sent[0].label, 'Recipe handoff from Builder');
  assert.equal(store.getHandoff('h0')?.state, 'delivered');
  await engine.observe(both, aliveBoth);
  assert.equal(sent.length, 1, 'a non-repeat handoff never fires twice');
});

test('a turn that ends while ah is down still fires once, from the persisted armed flag', async () => {
  const store = await freshStore();
  makeRun(store, [{ armed: true }]);
  const sent: string[] = [];
  const engine = new HandoffEngine(store, async (_uid, text) => {
    sent.push(text);
    return { outcome: 'delivered' as const };
  });
  // First observation after the restart: the source is already quiet.
  await engine.observe(new Map([['u1', 'attention'], ['u2', 'idle']]), aliveBoth);
  assert.equal(sent.length, 1);
  assert.equal(store.getHandoff('h0')?.state, 'delivered');
});

test('queued handoffs stay pending until the queue decides: delivered or cancelled', async () => {
  const store = await freshStore();
  makeRun(store, [{}, { id: 'h1' }]);
  const engine = new HandoffEngine(store, async () => ({ outcome: 'queued' as const, queueId: 'q1' }));
  store.updateHandoff('h0', { armed: true });
  await engine.observe(both, aliveBoth);
  assert.equal(store.getHandoff('h0')?.state, 'pending');
  assert.equal(store.getHandoff('h0')?.queueId, 'q1');
  engine.queueItemCancelled('q1');
  assert.equal(store.getHandoff('h0')?.state, 'cancelled');

  const engine2 = new HandoffEngine(store, async () => ({ outcome: 'queued' as const, queueId: 'q2' }));
  store.updateHandoff('h1', { armed: true });
  await engine2.observe(both, aliveBoth);
  engine2.queueItemDelivered('q2');
  assert.equal(store.getHandoff('h1')?.state, 'delivered');
});

test('repeat handoffs re-arm and fire again on the next turn', async () => {
  const store = await freshStore();
  makeRun(store, [{ repeat: true }]);
  let count = 0;
  const engine = new HandoffEngine(store, async () => {
    count++;
    return { outcome: 'delivered' as const };
  });
  const busy = new Map([['u1', 'busy'], ['u2', 'idle']]);
  await engine.observe(busy, aliveBoth);
  await engine.observe(both, aliveBoth);
  await engine.observe(busy, aliveBoth);
  await engine.observe(both, aliveBoth);
  assert.equal(count, 2);
  assert.equal(store.getHandoff('h0')?.state, 'pending');
  assert.equal(store.getHandoff('h0')?.fires, 2);
});

test('needs-you fires on entering waiting; a dead source is skipped, never sent', async () => {
  const store = await freshStore();
  makeRun(store, [{ event: 'needs-you' }, { id: 'h1' }]);
  const sent: string[] = [];
  const engine = new HandoffEngine(store, async (_uid, text) => {
    sent.push(text);
    return { outcome: 'delivered' as const };
  });
  await engine.observe(new Map([['u1', 'waiting'], ['u2', 'idle']]), aliveBoth);
  assert.equal(sent.length, 1);
  assert.equal(store.getHandoff('h0')?.state, 'delivered');

  await engine.observe(new Map([['u2', 'idle']]), new Set(['u2']));
  assert.equal(store.getHandoff('h1')?.state, 'skipped');
  assert.match(store.getHandoff('h1')?.reason ?? '', /source session ended/);
  assert.equal(sent.length, 1);
});
