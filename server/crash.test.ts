import '../test/scratch.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Registry as RegistryType } from './registry.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Crash-recovery contract: a dead tmux server (or a dead ah) must never take
// the session records with it, and every ended record stays resumable.
// Everything here runs against an isolated tmux server (TMUX_TMPDIR) and
// throwaway databases — never the live ones.
const dir = mkdtempSync(join(tmpdir(), 'ah-crash-'));
process.env.XDG_STATE_HOME = join(dir, 'state');
process.env.XDG_CONFIG_HOME = join(dir, 'config');
process.env.TMUX_TMPDIR = dir;

const { ensureServer, listWindows, listSessions, capturePane, tmux } = await import('./tmux.ts');
const { Registry } = await import('./registry.ts');
const { ensureMigrated } = await import('./db.ts');
const { loadConfig } = await import('./config.ts');
const { Core } = await import('./core.ts');

after(async () => {
  // Only our isolated server listens under TMUX_TMPDIR.
  await tmux('kill-server').catch(() => {});
});

let dbSeq = 0;
async function freshRegistry() {
  const path = join(dir, `crash-${dbSeq++}.db`);
  await ensureMigrated(path);
  const r = new Registry(path);
  await r.ready();
  return { registry: r, path };
}

const coreWith = (registry: RegistryType, session: string, presets: any[] = []) => {
  const base = loadConfig();
  const c: any = new Core({ ...base, defaultSession: session, presets: [...base.presets, ...presets] }, new Map(), registry);
  // Recovery, not the ticker: no discovery scans, no snapshot pruning.
  c.tick = async () => ({ windows: [] });
  return c;
};

test('ensureServer is idempotent and keeps an empty server alive', async () => {
  await ensureServer();
  await ensureServer();
  const version = await tmux('display-message', '-p', '#{version}');
  assert.match(version.trim(), /^\d/, 'a server answers');
  assert.equal((await tmux('show-options', '-s', 'exit-empty')).trim(), 'exit-empty off');
});

test('a dead server is revived by ensureServer, not stranded on a stale socket', async () => {
  await tmux('kill-server').catch(() => {});
  await ensureServer();
  const version = await tmux('display-message', '-p', '#{version}');
  assert.match(version.trim(), /^\d/, 'server is back');
});

test('an empty-but-alive server reads as no windows, not a tick-crashing error', async () => {
  await tmux('kill-server').catch(() => {});
  await ensureServer();
  assert.deepEqual(await listWindows(), []);
  assert.deepEqual(await listSessions(), []);
});

test('total server loss ends records but keeps everything resume needs, on disk', async () => {
  const { registry, path } = await freshRegistry();
  const w1 = { session: 'agents', windowId: '@1' };
  registry.live('u1', { harness: 'claude', harnessId: 'conv-1', cwd: '/work/app', model: 'opus', title: 'fix bug', status: 'busy', tmux: w1, activity: 1000 });
  registry.live('u2', { harness: 'shell', cwd: '/work/app', title: 'shell', status: 'idle', tmux: { session: 'agents', windowId: '@2' }, activity: 1000 });
  // The tmux server is gone: nothing is alive anymore.
  registry.reconcile(new Set());
  await registry.settled();

  for (const [id, harnessId] of [['u1', 'conv-1'], ['u2', undefined]] as const) {
    const r = registry.get(id)!;
    assert.equal(r.lifecycle, 'ended');
    assert.equal(r.harnessId, harnessId);
    assert.equal(r.cwd, '/work/app');
  }

  // A new process after the crash reads the same database and can resume both.
  const reloaded = new Registry(path);
  await reloaded.ready();
  assert.equal(reloaded.get('u1')?.lifecycle, 'ended');
  assert.equal(reloaded.get('u1')?.harnessId, 'conv-1', 'exact conversation id survives');
  assert.equal(reloaded.get('u2')?.cwd, '/work/app', 'shell cwd survives');
});

test('resuming an ended shell reopens it in the same directory', async () => {
  const { registry } = await freshRegistry();
  const cwd = mkdtempSync(join(tmpdir(), 'ah-crash-cwd-'));
  registry.live('sh1', { harness: 'shell', cwd, title: 'deploy shell', status: 'idle', tmux: { session: 'crash-shell', windowId: '@99' }, activity: 1000 });
  registry.reconcile(new Set());
  assert.equal(registry.get('sh1')?.lifecycle, 'ended');

  const out = await coreWith(registry, 'crash-shell').resume('sh1');
  assert.equal(out.resumed, true);
  assert.equal(out.uid, 'sh1', 'same registry id, so history and queues follow it');
  const wins = await listWindows();
  const win = wins.find((w) => w.windowId === out.windowId);
  assert.ok(win, 'a live window exists again');
  assert.equal(win.path, cwd, 'reopened where it died');
  assert.equal(registry.get('sh1')?.lifecycle, 'starting', 'ticker will promote it to live');
  assert.equal(registry.get('sh1')?.pendingResume, true);
});

test('resuming an ended agent replays its exact conversation, not a fresh launch', async () => {
  const { registry } = await freshRegistry();
  const cwd = mkdtempSync(join(tmpdir(), 'ah-crash-cwd-'));
  // A harmless stand-in agent: echo can be typed into a shell with no side effects.
  const fake = { id: 'echo-agent', name: 'Echo', command: 'echo start', resumeId: 'echo --resume {id}' };
  registry.live('ag1', { harness: 'echo-agent', harnessId: 'conv-9', cwd, title: 'deep work', status: 'busy', tmux: { session: 'crash-agent', windowId: '@99' }, activity: 1000 });
  registry.reconcile(new Set());

  const out = await coreWith(registry, 'crash-agent', [fake]).resume('ag1');
  assert.equal(out.resumed, true);
  const rec = registry.get('ag1')!;
  assert.equal(rec.lifecycle, 'starting', 'ticker will promote it to live');
  assert.equal(rec.harnessId, 'conv-9', 'still bound to the same conversation');
  const screen = await capturePane(out.windowId, 20);
  assert.match(screen, /echo --resume conv-9/, 'the exact resume command was typed, not a fresh launch');
  const wins = await listWindows();
  assert.ok(wins.some((w) => w.windowId === out.windowId), 'a live window exists again');
});
