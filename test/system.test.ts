// Settings → System → Restart server: the endpoint needs a signed-in caller,
// answers before restarting, and runs the restart through AH_RESTART_CMD so
// tests can stub the side effect instead of bouncing a real systemd unit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

let ah: Ah;
let flag: string;
before(async () => {
  flag = join(mkdtempSync(join(tmpdir(), 'ah-restart-')), 'restarted');
  process.env.AH_RESTART_CMD = `touch ${flag}`;
  ah = await startAh();
});
after(async () => {
  delete process.env.AH_RESTART_CMD;
  await cleanup(ah);
});

test('anonymous callers are refused and nothing restarts', async () => {
  const res = await http(ah, 'POST', '/api/system/restart', { body: {} });
  assert.equal(res.status, 401);
  assert.ok(!existsSync(flag));
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
