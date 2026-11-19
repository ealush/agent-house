import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Set these before importing modules that resolve paths at module load time.
const dir = mkdtempSync(join(tmpdir(), 'ah-order-'));
process.env.XDG_STATE_HOME = join(dir, 'state');
process.env.XDG_CONFIG_HOME = join(dir, 'config');
process.env.TMUX_TMPDIR = dir;
const { Core } = await import('./core.ts');
const { loadConfig } = await import('./config.ts');
const { Registry } = await import('./registry.ts');
let sequence = 0;

const core = (uids: string[] = []) => {
  const c = new Core(loadConfig(), new Map(), new Registry(join(dir, `sessions-${sequence++}.json`)));
  // Reordering needs no tmux I/O in these unit tests.
  c.tick = async () => ({} as Awaited<ReturnType<typeof c.tick>>);
  for (const id of uids) {
    c.registry.starting(id, { harness: 'shell', cwd: '/tmp', title: id, tmux: { session: 's', windowId: '@1' } });
  }
  return c;
};

test('new sessions land at the end (max + 100)', () => {
  const c = core();
  assert.equal(c.nextOrder(), 100);
  c.registry.setMeta('x', 'ah.order', 100);
  const d = core();
  d.registry.starting('a', { harness: 'shell', cwd: '/tmp', title: 'a', tmux: { session: 's', windowId: '@1' } });
  d.registry.setMeta('a', 'ah.order', 300);
  assert.equal(d.nextOrder(), 400);
});

test('setOrder persists a sparse key; unknown uid is 404', () => {
  const c = core(['u1', 'u2']);
  c.setOrder('u1', 100);
  c.setOrder('u2', 200);
  assert.equal(c.registry.get('u1')!.meta['ah.order'], 100);
  // Inserting between neighbors needs no rewrite of the others.
  c.setOrder('u1', 150);
  assert.equal(c.registry.get('u2')!.meta['ah.order'], 200);
  assert.throws(() => c.setOrder('nope', 1), (e: any) => e.status === 404);
  assert.throws(() => c.setOrder('u1', Number.NaN), (e: any) => e.status === 400);
});

test('Core is connected once, by the composition root, and hands session ends on', () => {
  const c = core();
  const ended: string[] = [];
  const views = { review: () => null, jobs: () => null, notes: () => null, interruptions: () => null, recoveryOf: () => null };
  const connections = { harnesses: { probe: () => null, custom: () => [] }, peers: { list: () => [] }, apns: {}, launchEnv: async () => ({}), views, copied: () => {}, ended: (r: { id: string }) => void ended.push(r.id) } as unknown as Parameters<typeof c.connect>[0];
  c.connect(connections);
  assert.throws(() => c.connect(connections), /already connected/);
  c.registry.onEnd?.({ id: 'u1' } as never, 'idle');
  assert.deepEqual(ended, ['u1']);
});
