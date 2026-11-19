// Subagents as sessions, end to end: the stand-in Claude Code and Codex
// (test/fixtures/fake-harness.js, SPAWN) write their children the way the real ones
// do, and ah shows them under the session that spawned them (server/subagents).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, http, until } from './helpers.ts';
import { launch, startBed, windows } from './fake-agents.ts';

const tree = async (ah: any, ref: string) => {
  const res = await http(ah, 'GET', `/api/sessions/${ref}/subagents`);
  assert.equal(res.status, 200, res.body);
  return res.json();
};

/** Every entry a feed page holds, as text. */
const feedText = async (ah: any, ref: string) => {
  const res = await http(ah, 'GET', `/api/sessions/${ref}/feed?limit=200`);
  if (res.status !== 200) return null;
  return JSON.stringify(res.json().entries);
};

test('claude subagents: live counts, a nested tree, their transcripts, read-only, and the same tree after a restart', async () => {
  let ah = await startBed();
  try {
    assert.equal((await http(ah, 'GET', '/api/hello')).json().features.subagents, 1);
    const w = await launch(ah, 'claude', ah.project);
    assert.deepEqual(w.subagents, { total: 0, active: 0, completed: 0, failed: 0, rev: '0' }, 'a Claude session says it has none yet');
    assert.equal((await http(ah, 'POST', `/api/sessions/${w.uid}/send`, { body: { text: 'SPAWN 2 3000 NEST' } })).status, 200);

    // While they work: the row counts them (the nested one too), and the tree has them.
    const busy = await until(async () => (await windows(ah)).find((x) => x.uid === w.uid)?.subagents?.active === 3 && (await windows(ah)).find((x) => x.uid === w.uid), 10000, 'three active');
    assert.equal(busy.subagents.total, 3);
    const live = await tree(ah, w.uid);
    assert.equal(live.root.ref, `claude:${w.harnessId}`);
    assert.equal(live.root.uid, w.uid);
    assert.deepEqual(live.nodes.map((n: any) => [n.depth, n.name]), [
      [1, 'Task 1'],
      [2, 'Check task 1'],
      [1, 'Task 2'],
    ]);
    // Task 1 waits on its own child first, so it runs longest.
    assert.equal(live.nodes[0].state, 'running');
    const [first, nested] = live.nodes;
    assert.equal(nested.parentRef, first.ref);
    assert.match(first.ref, new RegExp(`^claude:${w.harnessId}:a[0-9a-f]{16}$`));
    assert.deepEqual(first.capabilities, { transcript: true, live: true, send: false, cancel: false, continue: false });
    assert.equal(first.activity, 'Agent: Check task 1', 'what it did last: spawn its own child');

    // A child's conversation reads like any session's, by its ref.
    assert.match((await feedText(ah, first.ref))!, /Do task 1/);
    assert.match((await feedText(ah, nested.ref))!, /Do task 1\.1/);
    // Its tree, asked by the child's ref, is the whole tree, naming it.
    assert.equal((await tree(ah, nested.ref)).self, nested.ref);

    // Nothing reaches a child on its own: not a message, not a resume.
    const sent = await http(ah, 'POST', `/api/sessions/${first.ref}/send`, { body: { text: 'hello child' } });
    assert.equal(sent.status, 409);
    assert.equal(sent.json().code, 'subagent_read_only');
    assert.equal((await http(ah, 'POST', `/api/sessions/${first.ref}/resume`)).json().code, 'subagent_read_only');

    // They finish; the parent's turn ends after them.
    const done = await until(async () => {
      const t = await tree(ah, w.uid);
      return t.nodes.every((n: any) => n.state === 'completed') && t;
    }, 15000, 'all completed');
    assert.ok(done.nodes.every((n: any) => n.endedAt && n.capabilities.live === false));
    await until(async () => (await windows(ah)).find((x) => x.uid === w.uid)?.subagents?.completed === 3, 8000, 'row says completed');

    // The same children, the same refs, after ah restarts: nothing was kept but what the harness wrote.
    ah = await ah.restart();
    const again = await until(async () => {
      const t = await tree(ah, w.uid).catch(() => null);
      return t?.nodes.length === 3 && t;
    }, 15000, 'tree after restart');
    assert.deepEqual(again.nodes.map((n: any) => [n.ref, n.state]), done.nodes.map((n: any) => [n.ref, n.state]));
    assert.match((await feedText(ah, first.ref))!, /Task 1 done/);
  } finally {
    await cleanup(ah);
  }
});

test('claude background subagents run on after the parent goes idle, and finish by their task notification', async () => {
  const ah = await startBed();
  try {
    const w = await launch(ah, 'claude', ah.project);
    await http(ah, 'POST', `/api/sessions/${w.uid}/send`, { body: { text: 'SPAWN 2 4000 BG' } });
    const t = await until(async () => {
      const t = await tree(ah, w.uid);
      return t.nodes.length === 2 && t;
    }, 10000, 'two children');
    assert.ok(t.nodes.every((n: any) => n.background && n.state === 'running'), 'the launch acknowledgement is not an ending');
    await until(async () => (await tree(ah, w.uid)).nodes.every((n: any) => n.state === 'completed'), 15000, 'completed by notification');
  } finally {
    await cleanup(ah);
  }
});

test('codex subagents: spawned threads hang from their root, stay out of history, and continue on their own only once the tree stops', async () => {
  const ah = await startBed();
  try {
    const w = await launch(ah, 'codex', ah.project);
    await http(ah, 'POST', `/api/sessions/${w.uid}/send`, { body: { text: 'SPAWN 2 1500' } });
    const t = await until(async () => {
      const t = await tree(ah, w.uid);
      return t.nodes.length === 2 && t;
    }, 10000, 'two threads');
    assert.deepEqual(t.nodes.map((n: any) => n.name), ['Agent 1', 'Agent 2']);
    assert.ok(t.nodes.every((n: any) => n.ref.startsWith('codex:') && n.parentRef === `codex:${w.harnessId}`));
    await until(async () => (await tree(ah, w.uid)).nodes.every((n: any) => n.state === 'completed'), 15000, 'completed');
    const child = t.nodes[0];
    assert.match((await feedText(ah, child.ref))!, /Task 1 done/);
    // Not a conversation of its own in history.
    const history = (await http(ah, 'GET', '/api/state')).json().history as any[];
    assert.ok(!history.some((h) => t.nodes.some((n: any) => n.ref === h.ref)));
    // While its parent runs, it doesn't go on without it.
    assert.equal((await tree(ah, w.uid)).nodes[0].capabilities.continue, false);
    const r = await http(ah, 'POST', `/api/sessions/${child.ref}/resume`);
    assert.equal(r.status, 409);
    assert.equal(r.json().code, 'subagent_running');
  } finally {
    await cleanup(ah);
  }
});

test('a guessed or malformed child ref names nothing', async () => {
  const ah = await startBed();
  try {
    const w = await launch(ah, 'claude', ah.project);
    for (const ref of [`claude:${w.harnessId}:aaaaaaaaaaaaaaaa`, `claude:${w.harnessId}:..`, 'claude:not-a-session:a1']) {
      const t = await http(ah, 'GET', `/api/sessions/${encodeURIComponent(ref)}/subagents`);
      assert.ok([200, 404].includes(t.status), `${ref}: ${t.status}`);
      if (t.status === 200) assert.deepEqual(t.json().nodes, []);
      assert.equal(await feedText(ah, ref), null, `${ref} has no feed`);
    }
    // A shell has none to read.
    const shell = (await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: ah.project } })).json();
    const r = await http(ah, 'GET', `/api/sessions/${shell.uid}/subagents`);
    assert.equal(r.status, 404);
    assert.equal(r.json().code, 'no_subagents');
  } finally {
    await cleanup(ah);
  }
});
