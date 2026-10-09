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

test('relaunch needs exactly one of model/effort', async () => {
  const c = core([idle()]);
  assert.equal(await statusOf(c.relaunch('u1', { model: 'x', effort: 'high' })), 400);
  assert.equal(await statusOf(c.relaunch('u1', {})), 400);
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
  const gemini = idle({ agent: 'gemini' });
  assert.equal(await statusOf(core([gemini]).relaunch('u1', { effort: 'high' })), 400);
});
