import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set these before importing modules that resolve paths at module load time.
const dir = mkdtempSync(join(tmpdir(), 'ah-relaunch-'));
process.env.XDG_STATE_HOME = join(dir, 'state');
process.env.XDG_CONFIG_HOME = join(dir, 'config');
process.env.TMUX_TMPDIR = dir;
const { Core, CoreError } = await import('./core.ts');
const { loadConfig } = await import('./config.ts');
const { Registry } = await import('./registry.ts');
let sequence = 0;

type FakeWin = {
  uid: string;
  id: string;
  agent: string | null;
  status: string;
  queued: number;
  harnessId?: string | null;
  title?: string;
  cwd?: string;
};

// Relaunch guards throw before any tmux I/O, so stubbing current() keeps
// these unit tests hermetic (no windows are ever killed or created).
const core = (windows: FakeWin[] = []) => {
  const c: any = new Core(loadConfig(), new Map(), new Registry(join(dir, `sessions-${sequence++}.json`)));
  c.current = async () => ({ windows });
  return c;
};

const idle = (over: Partial<FakeWin> = {}): FakeWin => ({
  uid: 'u1',
  id: '@1',
  agent: 'codex',
  status: 'idle',
  queued: 0,
  harnessId: 'rid1',
  title: 's',
  cwd: '/tmp',
  ...over,
});

const statusOf = async (p: Promise<unknown>) => (await p.then(
  () => 'ok',
  (e: any) => e.status ?? `threw:${e.message}`,
));

test('relaunch takes at most one of model/effort; neither is a plain restart', async () => {
  const c = core([idle()]);
  assert.equal(await statusOf(c.relaunch('u1', { model: 'x', effort: 'high' })), 400);
  // A restart passes the change check and meets the same guards as a swap.
  assert.equal(await statusOf(core([idle({ harnessId: null })]).relaunch('u1', {})), 422);
  assert.equal(await statusOf(core([idle({ status: 'busy' })]).relaunch('u1', {})), 409);
});

test('envStale lists agent sessions on other values, with why one cannot restart yet', async () => {
  const windows = [idle(), idle({ uid: 'u2', status: 'busy' }), idle({ uid: 'u3', harnessId: null }), idle({ uid: 'u4', agent: null })];
  const c = core(windows);
  c.tick = c.current;
  // Nothing in the registry recorded an environment: matches an empty one.
  assert.deepEqual(await c.envStale({}), []);
  const stale = await c.envStale({ IMAGE_KEY: 'k' });
  assert.deepEqual(
    stale.map((s: any) => [s.uid, s.restart]),
    [
      ['u1', null],
      ['u2', 'working; restart when idle'],
      ['u3', 'no conversation to resume yet'],
    ],
  );
});

test('relaunch 404s unknown and non-agent sessions', async () => {
  assert.equal(await statusOf(core([idle()]).relaunch('nope', { model: 'x' })), 404);
  assert.equal(await statusOf(core([idle({ agent: null })]).relaunch('u1', { model: 'x' })), 404);
});

test('relaunch 409s busy, waiting, and queued sessions', async () => {
  assert.equal(await statusOf(core([idle({ status: 'busy' })]).relaunch('u1', { model: 'x' })), 409);
  assert.equal(await statusOf(core([idle({ status: 'waiting' })]).relaunch('u1', { model: 'x' })), 409);
  assert.equal(await statusOf(core([idle({ queued: 2 })]).relaunch('u1', { model: 'x' })), 409);
});

test('relaunch 422s when there is no conversation to resume', async () => {
  assert.equal(await statusOf(core([idle({ harnessId: null })]).relaunch('u1', { model: 'x' })), 422);
});

test('relaunch 400s malformed model ids instead of leaking a 500', async () => {
  const err: any = await core([idle()]).relaunch('u1', { model: '!!!' }).then(
    () => null,
    (e: any) => e,
  );
  assert.equal(err?.status, 400);
  assert.match(err?.message ?? '', /invalid model id/);
  // The HTTP layer only maps CoreError; a raw LaunchError would surface as a 500.
  assert.ok(err instanceof CoreError, `expected CoreError, got ${err?.constructor?.name}`);
});

test('relaunch 400s unsupported effort levels', async () => {
  assert.equal(await statusOf(core([idle()]).relaunch('u1', { effort: 'bogus' })), 400);
  // opencode has no effort setting at all.
  const opencode = idle({ agent: 'opencode' });
  assert.equal(await statusOf(core([opencode]).relaunch('u1', { effort: 'high' })), 400);
});

test('relaunch creates the new window before stopping the old one, and keeps the session’s place', async () => {
  const c = core([idle()]);
  c.registry.starting('u1', { harness: 'codex', harnessId: 'rid1', cwd: '/tmp', title: 's', tmux: { session: 'nope', windowId: '@1' } });
  c.registry.setMeta('u1', 'ah.pinned', true);
  c.registry.setMeta('u1', 'ah.order', 7);
  c.registry.setMeta('u1', 'ah.worktree', { path: '/tmp/wt', branch: 'ah/x' });
  c.registry.setMeta('u1', 'ah.launch.model', 'old-model');
  let launched: any = null;
  c.launch = async (o: any) => {
    launched = o;
    return { uid: 'u2', windowId: '@2' };
  };
  c.tick = async () => ({ windows: [] });
  const out = await c.relaunch('u1', { effort: 'high' });
  assert.deepEqual(out, { uid: 'u2', id: '@2' });
  assert.equal(typeof launched.beforeCommand, 'function', 'the old window is stopped from inside the launch, after the new one exists');
  assert.equal(launched.meta['ah.pinned'], true);
  assert.equal(launched.meta['ah.order'], 7);
  assert.deepEqual(launched.meta['ah.worktree'], { path: '/tmp/wt', branch: 'ah/x' });
  assert.equal(launched.meta['ah.queue'], undefined);
  assert.equal(launched.meta['ah.launch.effort'], 'high');
  // An old window that is already gone is fine (no tmux server here at all).
  await launched.beforeCommand();
});

test('relaunch takes a permission mode, one setting at a time, from the preset only', async () => {
  assert.equal(await statusOf(core([idle()]).relaunch('u1', { mode: 'auto', model: 'x' })), 400);
  assert.equal(await statusOf(core([idle()]).relaunch('u1', { mode: 'nope' })), 400);
});
