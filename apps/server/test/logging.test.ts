// Settings → System → Developer: the host's log, on and off from Settings, kept by day,
// and devices' bundles beside it, against a real host.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

let ah: Ah;
let cookie: string;
const logFile = () => join(ah.dir, 'state', 'ah', 'logs', today(), 'server.jsonl');
const entries = () => (existsSync(logFile()) ? readFileSync(logFile(), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

before(async () => {
  // Never the real unit: the restart test asks for one.
  process.env.AH_RESTART_CMD = 'true';
  ah = await startAh({
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  cookie = await signIn(ah);
});
after(async () => {
  delete process.env.AH_RESTART_CMD;
  await cleanup(ah);
});

test('anonymous callers can neither read, turn on, nor send to the log', async () => {
  assert.equal((await http(ah, 'GET', '/api/system/logging')).status, 401);
  assert.equal((await http(ah, 'PUT', '/api/system/logging', { body: { server: true } })).status, 401);
  assert.equal((await http(ah, 'POST', '/api/system/logging/client', { body: { entries: [] } })).status, 401);
});

test('the log is off until turned on, then requests go in with their secrets redacted', async () => {
  const off = await http(ah, 'GET', '/api/system/logging', { cookie });
  assert.equal(off.status, 200);
  assert.equal(off.json().server, false);
  assert.equal(off.json().keepDays, 3);
  assert.deepEqual(off.json().days, []);
  assert.equal((await http(ah, 'PUT', '/api/system/logging', { cookie, body: { server: 'yes' } })).status, 400);

  const on = await http(ah, 'PUT', '/api/system/logging', { cookie, body: { server: true } });
  assert.equal(on.json().server, true);
  await http(ah, 'GET', '/api/state?token=hunter2&x=1', { cookie });
  await http(ah, 'GET', '/api/nothing-here', { cookie });
  const logged = await until(() => {
    const e = entries();
    return e.some((l) => l.path === '/api/nothing-here') && e;
  }, 5000, 'requests logged');
  const state = logged.find((l) => l.kind === 'request' && l.path.startsWith('/api/state'));
  assert.equal(state.path, '/api/state?token=…&x=1');
  assert.equal(state.status, 200);
  assert.equal(typeof state.ms, 'number');
  assert.equal(logged.find((l) => l.path === '/api/nothing-here').status, 404);
  assert.equal(logged.find((l) => l.path === '/api/nothing-here').error, 'not found');
  assert.ok(!readFileSync(logFile(), 'utf8').includes('hunter2'));
  assert.ok(!readFileSync(logFile(), 'utf8').includes(cookie.split('=')[1]), 'never the cookie');
});

test('a sent message goes in with its words and its attachments’ sizes, and the queue’s moves', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
  assert.equal(created.status, 201, created.body);
  const { uid } = created.json();
  await until(async () => {
    const w = (await http(ah, 'GET', '/api/state', { cookie })).json().windows.find((w: any) => w.uid === uid);
    return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
  }, 15000, 'agent detected');
  const picture = join(ah.dir, 'files', 'shot.png');
  writeFileSync(picture, Buffer.alloc(4321));
  const sent = await Promise.all([`look at ${picture}`, 'and then this'].map((text) => http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text } })));
  for (const r of sent) assert.equal(r.status, 200, r.body);
  const logged = await until(() => {
    const e = entries();
    return e.filter((l) => l.kind === 'send').length === 2 && e;
  }, 5000, 'sends logged');
  const withPicture = logged.find((l) => l.kind === 'send' && l.text.startsWith('look at'));
  assert.equal(withPicture.ref, uid);
  assert.equal(withPicture.chars, `look at ${picture}`.length);
  assert.deepEqual(withPicture.attachments, [{ ext: 'png', bytes: 4321 }]);
  assert.equal(withPicture.attachmentBytes, 4321);
  assert.ok(['delivered', 'queued'].includes(withPicture.outcome));
  if (sent.some((r) => r.json().outcome === 'queued')) {
    assert.ok(logged.some((l) => l.kind === 'queue' && l.action === 'queued' && l.uid === uid));
    await until(() => entries().some((l) => l.kind === 'queue' && l.action === 'delivered' && l.uid === uid), 15000, 'queued follow-up delivered');
  }
});

test("a device's bundle is kept in today's folder, and listed", async () => {
  assert.equal((await http(ah, 'POST', '/api/system/logging/client', { cookie, body: { entries: 'no' } })).status, 400);
  assert.equal((await http(ah, 'POST', '/api/system/logging/client', { cookie, body: { entries: [1] } })).status, 400);
  const res = await http(ah, 'POST', '/api/system/logging/client', {
    cookie,
    body: { client: { app: 'web', device: 'Pixel/../9', version: '1', build: '2' }, note: 'send vanished', entries: [{ at: '2026-11-22T10:00:00Z', kind: 'request', path: '/api/state', status: 0, error: 'offline' }] },
  });
  assert.equal(res.status, 201, res.body);
  const { file, entries: n } = res.json();
  assert.equal(n, 1);
  assert.ok(file.startsWith(join(ah.dir, 'state', 'ah', 'logs', today(), 'client-')));
  assert.match(file, /-web-Pixel-\.\.-9\.jsonl$/);
  const [header, entry] = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(header.note, 'send vanished');
  assert.equal(header.from, 'local');
  assert.equal(entry.error, 'offline');
  const status = (await http(ah, 'GET', '/api/system/logging', { cookie })).json();
  assert.ok(status.days[0].files.some((f: { name: string }) => file.endsWith(f.name)));
  assert.ok(status.days[0].files.some((f: { name: string }) => f.name === 'server.jsonl'));
});

test('a restart is logged, with how the run before it ended, and the log stays on', async () => {
  const restart = await http(ah, 'POST', '/api/system/restart', { cookie, body: {} });
  assert.equal(restart.status, 200);
  await ah.restart();
  ah = ah.next!;
  const logged = await until(() => {
    const e = entries();
    return e.filter((l) => l.kind === 'start').length >= 1 && e;
  }, 8000, 'start logged');
  assert.ok(logged.some((l) => l.kind === 'restart'));
  const stop = logged.find((l) => l.kind === 'stop');
  assert.equal(stop.signal, 'SIGTERM');
  const start = logged.findLast((l) => l.kind === 'start');
  assert.equal(start.previous.ended, 'cleanly');
  assert.equal(start.previous.signal, 'SIGTERM');
  assert.equal((await http(ah, 'GET', '/api/system/logging', { cookie })).json().server, true);
});
