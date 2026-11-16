// Authorization matrix: one auth mistake here is a remote shell, so every route is
// exercised against every kind of caller.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, signIn, OWNER, TAILNET_DNS, type Ah } from '../helpers.ts';

let ah: Ah;
before(async () => {
  ah = await startAh();
});
after(() => cleanup(ah));

// Everything that must require a signed-in caller. Unknown paths too: default deny.
const PROTECTED: Array<[string, string, unknown?]> = [
  ['GET', '/api/state'],
  ['GET', '/api/capabilities'],
  ['GET', '/api/portable/capabilities'],
  ['GET', '/api/portable/conversations/abc'],
  ['GET', '/api/portable/conversations/abc/lineage'],
  ['POST', '/api/portable/conversations/abc/preview', { to: 'codex' }],
  ['POST', '/api/portable/conversations/abc/continue', { to: 'codex' }],
  ['GET', '/api/portable/operations'],
  ['GET', '/api/portable/operations/lk-00000000'],
  ['POST', '/api/portable/operations/lk-00000000/retry', {}],
  ['POST', '/api/portable/operations/lk-00000000/cancel', {}],
  ['GET', '/api/migrations'],
  ['POST', '/api/migrations/preview', { ref: 'abc', to: 'x' }],
  ['POST', '/api/migrations', { ref: 'abc', to: 'x' }],
  ['POST', '/api/migrations/incoming/preflight', { manifest: {} }],
  ['PUT', '/api/migrations/incoming/mg-00000000/files/transcript', {}],
  ['GET', '/api/jobs'],
  ['POST', '/api/jobs', { name: 'x', action: { kind: 'decide', title: 'x' }, trigger: { kind: 'manual' } }],
  ['POST', '/api/jobs/jb-00000000/run', {}],
  ['POST', '/api/jobs/runs/jr-00000000/decide', { approve: true }],
  ['GET', '/api/voice'],
  ['PUT', '/api/voice', { style: 'clean' }],
  ['POST', '/api/voice/models', { subscriptionId: 'x' }],
  ['POST', '/api/voice/dictate?name=speech.m4a', {}],
  ['POST', '/api/voice/refine', { text: 'x' }],
  ['GET', '/api/recovery'],
  ['GET', '/api/interruptions'],
  ['POST', '/api/interruptions/restore', { all: true }],
  ['POST', '/api/interruptions/dismiss', { all: true }],
  ['POST', '/api/sessions/abc/restore', {}],
  ['GET', '/api/usage'],
  ['GET', '/api/usage/limits'],
  ['GET', '/api/usage/export'],
  ['POST', '/api/usage/refresh', {}],
  ['GET', '/api/sessions/abc/usage'],
  ['GET', '/api/sessions/abc/recovery'],
  ['POST', '/api/sessions/abc/recovery', { action: 'retry' }],
  ['GET', '/api/events'],
  ['GET', '/api/projects'],
  ['POST', '/api/windows', {}],
  ['POST', '/api/sessions/abc/resume', {}],
  ['POST', '/api/sessions/abc/send', { text: 'x' }],
  ['POST', '/api/sessions/abc/answer', { answer: 'approve' }],
  ['POST', '/api/sessions/abc/switch', { effort: 'high' }],
  ['POST', '/api/sessions/abc/settings', { setting: 'mode' }],
  ['GET', '/api/sessions/abc/queue'],
  ['GET', '/api/sessions/abc/feed'],
  ['GET', '/api/sessions/claude:abc/feed/stream'],
  ['GET', '/api/sessions/abc/feed/prompts'],
  ['DELETE', '/api/sessions/abc/queue'],
  ['POST', '/api/sessions/abc/queue/q1/move', { to: 0 }],
  ['GET', '/api/sessions/abc/preview'],
  ['PUT', '/api/sessions/abc/preview', { target: 6006 }],
  ['DELETE', '/api/sessions/abc/preview'],
  ['POST', '/api/sessions/abc/pin', {}],
  ['DELETE', '/api/sessions/abc'],
  ['GET', '/api/fs/list'],
  ['GET', '/api/fs/file?path=/etc/passwd'],
  ['POST', '/api/fs/upload?dir=/tmp&name=x', {}],
  ['POST', '/api/fs/mkdir', { path: '/tmp/x' }],
  ['POST', '/api/upload?name=x', {}],
  ['GET', '/api/push/key'],
  ['POST', '/api/push/subscribe', {}],
  ['POST', '/api/push/unsubscribe', {}],
  ['POST', '/api/push/status', {}],
  ['GET', '/api/worktrees'],
  ['DELETE', '/api/worktrees', {}],
  ['GET', '/api/prompts'],
  ['DELETE', '/api/prompts'],
  ['POST', '/api/system/restart', {}],
  ['POST', '/api/system/rebuild', {}],
  ['POST', '/api/system/uploads/clear', {}],
  ['GET', '/api/windows/@1/changes'],
  ['GET', '/api/windows/@1/capture'],
  ['PATCH', '/api/windows/@1', { name: 'x' }],
  ['DELETE', '/api/windows/@1'],
  ['GET', '/api/auth/overview'],
  ['POST', '/api/auth/cache-key', {}],
  ['POST', '/api/auth/code', {}],
  ['DELETE', '/api/auth/sessions/abc'],
  ['POST', '/api/auth/signout-all', {}],
  ['DELETE', '/api/auth/passkeys/abc'],
  ['POST', '/api/auth/native/preview-session', {}],
  ['DELETE', '/api/auth/devices/abc'],
  ['POST', '/api/auth/tokens', { name: 'x' }],
  ['DELETE', '/api/auth/tokens/abc'],
  ['POST', '/api/auth/password', { password: 'whatever whatever' }],
  ['GET', '/api/does-not-exist'],
  ['POST', '/api/does-not-exist', {}],
  ['GET', '/h/some-peer/api/state'],
];

const PUBLIC: Array<[string, string, unknown?]> = [
  ['GET', '/api/hello'],
  ['GET', '/api/auth/status'],
  ['POST', '/api/auth/register/options', { code: 'AAAAA-AAAAA' }],
  ['POST', '/api/auth/register/verify', { challengeId: 'x', response: {} }],
  ['POST', '/api/auth/login/options', {}],
  ['POST', '/api/auth/login/verify', { challengeId: 'x', response: {} }],
  ['POST', '/api/auth/password/login', { password: 'nope' }],
  ['POST', '/api/auth/logout', {}],
  ['POST', '/api/auth/native/enroll/options', { code: 'AAAAA-AAAAA' }],
  ['POST', '/api/auth/native/enroll/verify', { challengeId: 'x', publicKey: 'x', signature: 'x' }],
  ['POST', '/api/auth/native/login/options', {}],
  ['POST', '/api/auth/native/login/verify', { challengeId: 'x', deviceId: 'x', signature: 'x' }],
];

test('every protected route refuses anonymous callers, also via /h/<self>/', async () => {
  for (const [method, path, body] of PROTECTED) {
    const res = await http(ah, method, path, { body });
    assert.equal(res.status, 401, `${method} ${path} → ${res.status} ${res.body}`);
    if (path.startsWith('/api/')) {
      const viaSelf = await http(ah, method, `/h/${(await http(ah, 'GET', '/api/hello')).json().hostname}${path}`, { body });
      assert.equal(viaSelf.status, 401, `${method} /h/self${path} → ${viaSelf.status}`);
    }
  }
});

test('garbage credentials are anonymous', async () => {
  for (const opts of [{ cookie: 'ah_session=forged' }, { cookie: '__Host-ah_session=forged' }, { token: 'not-a-token' }, { headers: { authorization: 'Basic Zm9vOmJhcg==' } }]) {
    assert.equal((await http(ah, 'GET', '/api/state', opts)).status, 401, JSON.stringify(opts));
  }
});

test('public routes are exactly the sign-in surface', async () => {
  for (const [method, path, body] of PUBLIC) {
    const res = await http(ah, method, path, { body });
    // Reachable = not stopped by the gate (it may still reject the bogus code/password itself).
    assert.ok(!(res.status === 401 && /sign in required/.test(res.body)), `${method} ${path} should be reachable before sign-in`);
  }
  // /api/hello says nothing sensitive: who it is, whether sign-in is on, and which
  // feature versions it speaks (numbers only, no limits or paths).
  const hello = (await http(ah, 'GET', '/api/hello')).json();
  assert.deepEqual(Object.keys(hello).sort(), ['ah', 'auth', 'features', 'hostname']);
  assert.ok(Object.values(hello.features).every((v) => typeof v === 'number'), JSON.stringify(hello.features));
});

test('signed-in browsers and the host token get through; the password stays host-only', async () => {
  const cookie = await signIn(ah);
  for (const [method, path, body] of PROTECTED) {
    // Streams never end, signout-all revokes our own cookie, and a real
    // restart or rebuild would bounce the daemon or delete dist mid-suite
    // (test/system.test.ts covers both with a stubbed command instead).
    if (path === '/api/events' || path.endsWith('/feed/stream') || path === '/api/auth/signout-all' || path === '/api/system/restart' || path === '/api/system/rebuild') continue;
    const asBrowser = await http(ah, method, path, { body, cookie });
    const asHost = await http(ah, method, path, { body, token: ah.localToken() });
    if (path === '/api/auth/password') {
      assert.equal(asBrowser.status, 403, 'a browser session must not change the master password');
      continue;
    }
    for (const [who, res] of [['browser', asBrowser], ['host', asHost]] as const) {
      // Past the gate: handlers may still say 400/403/404 for their own reasons.
      const gated = res.status === 401 || /"forbidden"|another Tailscale user/.test(res.body);
      assert.ok(!gated, `${who}: ${method} ${path} → ${res.status} ${res.body}`);
    }
  }
});

test('a revoked browser session is anonymous again', async () => {
  const cookie = await signIn(ah, 'to revoke');
  const sessions = (await http(ah, 'GET', '/api/auth/overview', { token: ah.localToken() })).json().sessions;
  const mine = sessions.find((s: any) => s.label === 'to revoke');
  assert.equal((await http(ah, 'DELETE', `/api/auth/sessions/${mine.id}`, { token: ah.localToken() })).status, 200);
  assert.equal((await http(ah, 'GET', '/api/state', { cookie })).status, 401);
});

test('the conversation cache key belongs to one sign-in and dies with it', async () => {
  const a = await signIn(ah, 'cache a');
  const b = await signIn(ah, 'cache b');
  const key = async (cookie: string) => (await http(ah, 'POST', '/api/auth/cache-key', { cookie, body: {} })).json().key as string;
  const ka = await key(a);
  assert.match(ka, /^[\w-]{43}$/);
  assert.equal(await key(a), ka, 'stable for the same sign-in');
  assert.notEqual(await key(b), ka, 'another device gets another key');
  assert.equal((await http(ah, 'POST', '/api/auth/cache-key', { token: ah.localToken(), body: {} })).status, 404, 'the host CLI has no cache');
  const sessions = (await http(ah, 'GET', '/api/auth/overview', { token: ah.localToken() })).json().sessions;
  const mine = sessions.find((s: any) => s.label === 'cache a');
  await http(ah, 'DELETE', `/api/auth/sessions/${mine.id}`, { token: ah.localToken() });
  assert.equal((await http(ah, 'POST', '/api/auth/cache-key', { cookie: a, body: {} })).status, 401, 'revoked: no key');
  assert.equal((await http(ah, 'POST', '/api/auth/cache-key', { cookie: a, body: {}, csrf: false })).status, 403, 'a write: needs X-AH');
});

test('CSRF: writes need X-AH and a same-site Origin, even with a valid session', async () => {
  const cookie = await signIn(ah);
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {}, csrf: false })).status, 403, 'missing X-AH');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {}, origin: 'https://evil.example' })).status, 403, 'foreign Origin');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {}, origin: null })).status, 403, 'no Origin');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {}, origin: `http://${TAILNET_DNS}.evil.example` })).status, 403, 'lookalike Origin');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {}, origin: `http://localhost:${ah.port + 1}` })).status, 403, 'our name, another port');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {}, origin: `https://localhost:${ah.port}` })).status, 403, 'https on the http port is another origin');
  const serve = { host: TAILNET_DNS, headers: { 'tailscale-user-login': OWNER } };
  assert.equal((await http(ah, 'POST', '/api/auth/code', { ...serve, cookie, body: {}, origin: `https://${TAILNET_DNS}:6006` })).status, 403, 'Serve name, another port');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { ...serve, cookie, body: {}, origin: `https://${TAILNET_DNS}` })).status, 200, 'Serve control');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {} })).status, 200, 'control');
});

test('Host allowlist: only loopback names and our ts.net name', async () => {
  for (const host of ['evil.example', '100.64.0.1', `${TAILNET_DNS}.evil.example`, 'box', `localhost.evil.example`]) {
    const res = await http(ah, 'GET', '/api/hello', { host });
    assert.equal(res.status, 421, `Host: ${host} → ${res.status}`);
  }
  assert.equal((await http(ah, 'GET', '/h/self/h/other/api/state')).status, 401);
});

test('via Serve (ts.net Host) the owner identity is required; loopback ignores the header', async () => {
  const cookie = await signIn(ah);
  const serve = (who?: string) => http(ah, 'GET', '/api/state', { host: TAILNET_DNS, origin: `https://${TAILNET_DNS}`, cookie, headers: who ? { 'tailscale-user-login': who } : {} });
  assert.equal((await serve()).status, 403, 'no identity (e.g. tagged device)');
  assert.equal((await serve('mallory@example.com')).status, 403, 'someone else');
  assert.equal((await serve(OWNER)).status, 200, 'the owner');
  // A local caller can't use the header to get anywhere: it's simply not consulted.
  assert.equal((await http(ah, 'GET', '/api/state', { headers: { 'tailscale-user-login': OWNER } })).status, 401);
});

test('static files are read-only', async () => {
  assert.equal((await http(ah, 'POST', '/', { body: {} })).status, 405);
  const page = await http(ah, 'GET', '/');
  assert.match(String(page.headers['content-security-policy']), /default-src 'self'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
});

test('the server refuses to listen anywhere but loopback', () => {
  const main = fileURLToPath(new URL('../../server/main.ts', import.meta.url));
  for (const host of ['0.0.0.0', '::', '100.64.0.1', '192.168.1.10']) {
    const r = spawnSync(process.execPath, [main, '--port', '0', '--host', host], { env: { ...process.env, XDG_CONFIG_HOME: '/nonexistent' }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.status, 1, `--host ${host} should be refused`);
    assert.match(r.stderr, /only listens on loopback/);
  }
});
