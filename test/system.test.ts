// Settings → System: restart and rebuild need a signed-in caller, answer before
// any restart, and run through AH_RESTART_CMD / AH_REBUILD_CMD so tests stub
// the side effect instead of bouncing systemd or deleting dist.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

let ah: Ah;
let flag: string;
let rebuilt: string;
let failFlag: string;
before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-restart-'));
  flag = join(dir, 'restarted');
  rebuilt = join(dir, 'rebuilt');
  failFlag = join(dir, 'fail');
  process.env.AH_RESTART_CMD = `touch ${flag}`;
  process.env.AH_REBUILD_CMD = `if [ -f ${failFlag} ]; then echo build-broke >&2; exit 1; else touch ${rebuilt}; fi`;
  ah = await startAh();
});
after(async () => {
  delete process.env.AH_RESTART_CMD;
  delete process.env.AH_REBUILD_CMD;
  await cleanup(ah);
});

test('anonymous callers are refused and nothing restarts', async () => {
  const res = await http(ah, 'POST', '/api/system/restart', { body: {} });
  assert.equal(res.status, 401);
  assert.ok(!existsSync(flag));
});

test('anonymous callers are refused and nothing rebuilds', async () => {
  const res = await http(ah, 'POST', '/api/system/rebuild', { body: {} });
  assert.equal(res.status, 401);
  assert.ok(!existsSync(rebuilt));
});

test('a signed-in device gets 200 and the restart command runs', async () => {
  const cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/system/restart', { body: {}, cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true });
  await until(() => existsSync(flag), 8000, 'restart command');
  const state = await http(ah, 'GET', '/api/state', { cookie });
  assert.equal(state.status, 200);
});

test('the restart is audited', async () => {
  const overview = await http(ah, 'GET', '/api/auth/overview', { token: ah.localToken() });
  assert.equal(overview.status, 200);
  assert.ok(overview.json().audit.some((a: { event: string }) => a.event === 'system.restart'));
});

test('a failed rebuild is reported and the server stays up', async () => {
  writeFileSync(failFlag, '1');
  try {
    const cookie = await signIn(ah);
    const res = await http(ah, 'POST', '/api/system/rebuild', { body: {}, cookie });
    assert.equal(res.status, 500);
    assert.match(res.json().error, /build-broke/);
    assert.ok(!existsSync(rebuilt));
    const state = await http(ah, 'GET', '/api/state', { cookie });
    assert.equal(state.status, 200);
  } finally {
    unlinkSync(failFlag);
  }
});

test('a signed-in device gets 200 and the rebuild command runs', async () => {
  const cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/system/rebuild', { body: {}, cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true });
  await until(() => existsSync(rebuilt), 8000, 'rebuild command');
  const state = await http(ah, 'GET', '/api/state', { cookie });
  assert.equal(state.status, 200);
});

test('the rebuild is audited', async () => {
  const overview = await http(ah, 'GET', '/api/auth/overview', { token: ah.localToken() });
  assert.equal(overview.status, 200);
  assert.ok(overview.json().audit.some((a: { event: string }) => a.event === 'system.rebuild'));
});
