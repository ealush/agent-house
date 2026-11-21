// The native app's device sign-in (server/auth.ts, "native app devices"): a device key
// enrolled with a host-issued code signs fresh challenges, and each sign-in is a bearer
// session. Everything here is adversarial: the browser's CSRF/Origin defenses must hold
// exactly as before, and a native credential must never stand in for a cookie or vice versa.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { request } from 'node:http';
import WebSocket from 'ws';
import { startAh, cleanup, http, signIn, until, OWNER, TAILNET_DNS, type Ah } from '../helpers.ts';

let ah: Ah;
before(async () => {
  ah = await startAh();
});
after(() => cleanup(ah));

type Device = { privateKey: KeyObject; publicKey: string };

function newDevice(): Device {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { privateKey, publicKey: point.toString('base64url') };
}

const message = (purpose: string, challenge: string, host: string, subject: string, label: string) =>
  Buffer.from([`ah-native-${purpose}-v1`, challenge, host, subject, label].join('\n'), 'utf8');
const signed = (d: Device, msg: Buffer) => sign('sha256', msg, { key: d.privateKey, dsaEncoding: 'der' }).toString('base64url');

/** The native app's request shape: X-AH, no Origin, no cookie. */
const native = (token?: string, extra: Parameters<typeof http>[3] = {}) => ({ origin: null, ...(token ? { token } : {}), ...extra });

async function code(): Promise<string> {
  return (await http(ah, 'POST', '/api/auth/code', { token: ah.localToken(), body: {} })).json().code;
}

async function enroll(d: Device, label = 'iPhone', setup?: string, host?: string): Promise<{ token: string; sessionId: string; deviceId: string }> {
  const opts = await http(ah, 'POST', '/api/auth/native/enroll/options', native(undefined, { body: { code: setup ?? (await code()) }, host }));
  assert.equal(opts.status, 200, opts.body);
  const { challengeId, challenge, host: signedHost } = opts.json();
  const res = await http(ah, 'POST', '/api/auth/native/enroll/verify', native(undefined, { host, body: { challengeId, publicKey: d.publicKey, label, signature: signed(d, message('enroll', challenge, signedHost, d.publicKey, label)) } }));
  assert.equal(res.status, 200, res.body);
  return res.json();
}

/** A shell window created by the native app itself (a native write). */
async function shell(token: string, label: string): Promise<string> {
  const res = await http(ah, 'POST', '/api/windows', native(token, { body: { preset: 'shell', cwd: `${ah.dir}/files`, label } }));
  assert.equal(res.status, 201, res.body);
  return res.json().id;
}

async function login(d: Device, deviceId: string, label = 'iPhone') {
  const { challengeId, challenge, host } = (await http(ah, 'POST', '/api/auth/native/login/options', native(undefined, { body: {} }))).json();
  return http(ah, 'POST', '/api/auth/native/login/verify', native(undefined, { body: { challengeId, deviceId, label, signature: signed(d, message('login', challenge, host, deviceId, label)) } }));
}

test('enrollment needs a host-issued code, spends it once, and returns a working bearer sign-in', async () => {
  const bad = await http(ah, 'POST', '/api/auth/native/enroll/options', native(undefined, { body: { code: 'AAAAA-AAAAA' } }));
  assert.equal(bad.status, 401);
  const setup = await code();
  const d = newDevice();
  const out = await enroll(d, 'iPhone', setup);
  assert.match(out.token, /^[\w-]{43}$/);
  assert.equal((await http(ah, 'GET', '/api/state', native(out.token))).status, 200);
  const again = await http(ah, 'POST', '/api/auth/native/enroll/options', native(undefined, { body: { code: setup } }));
  assert.equal(again.status, 401, 'the code was spent by the verified enrollment');
  const status = (await http(ah, 'GET', '/api/auth/status')).json();
  assert.equal(status.enrolled, true, 'a native device counts as a way in');
});

test('a failed enrollment does not spend the code', async () => {
  const setup = await code();
  const d = newDevice();
  const { challengeId, challenge, host } = (await http(ah, 'POST', '/api/auth/native/enroll/options', native(undefined, { body: { code: setup } }))).json();
  const other = newDevice();
  const res = await http(ah, 'POST', '/api/auth/native/enroll/verify', native(undefined, { body: { challengeId, publicKey: d.publicKey, label: 'x', signature: signed(other, message('enroll', challenge, host, d.publicKey, 'x')) } }));
  assert.equal(res.status, 401, 'a key that is not the registered one is refused');
  await enroll(d, 'still valid', setup);
});

test('signatures are bound to purpose, Host, challenge, label and key', async () => {
  const d = newDevice();
  const { deviceId } = await enroll(d);
  const opts = (await http(ah, 'POST', '/api/auth/native/login/options', native(undefined, { body: {} }))).json();
  const verify = (signature: string, label = 'iPhone', challengeId = opts.challengeId) =>
    http(ah, 'POST', '/api/auth/native/login/verify', native(undefined, { body: { challengeId, deviceId, label, signature } }));
  assert.equal((await verify(signed(d, message('enroll', opts.challenge, opts.host, deviceId, 'iPhone')))).status, 401, 'wrong purpose');
  const o2 = (await http(ah, 'POST', '/api/auth/native/login/options', native(undefined, { body: {} }))).json();
  assert.equal((await verify(signed(d, message('login', o2.challenge, `evil.example`, deviceId, 'iPhone')), 'iPhone', o2.challengeId)).status, 401, 'another Host');
  const o3 = (await http(ah, 'POST', '/api/auth/native/login/options', native(undefined, { body: {} }))).json();
  assert.equal((await verify(signed(d, message('login', o3.challenge, o3.host, deviceId, 'iPhone')), 'Renamed', o3.challengeId)).status, 401, 'label not as signed');
  const o4 = (await http(ah, 'POST', '/api/auth/native/login/options', native(undefined, { body: {} }))).json();
  assert.equal((await verify(signed(newDevice(), message('login', o4.challenge, o4.host, deviceId, 'iPhone')), 'iPhone', o4.challengeId)).status, 401, 'another key');
  const o5 = (await http(ah, 'POST', '/api/auth/native/login/options', native(undefined, { body: {} }))).json();
  const good = signed(d, message('login', o5.challenge, o5.host, deviceId, 'iPhone'));
  assert.equal((await verify(good, 'iPhone', o5.challengeId)).status, 200);
  assert.equal((await verify(good, 'iPhone', o5.challengeId)).status, 401, 'a challenge is single-use');
  // A challenge issued for one Host can't be completed through another.
  const local = (await http(ah, 'POST', '/api/auth/native/login/options', native(undefined, { body: {} }))).json();
  const serve = { host: TAILNET_DNS, headers: { 'tailscale-user-login': OWNER } };
  const cross = await http(ah, 'POST', '/api/auth/native/login/verify', native(undefined, { ...serve, body: { challengeId: local.challengeId, deviceId, label: 'iPhone', signature: signed(d, message('login', local.challenge, local.host, deviceId, 'iPhone')) } }));
  assert.equal(cross.status, 401);
});

test('through Serve, native sign-in still needs the owner identity', async () => {
  const d = newDevice();
  const setup = await code();
  const anon = await http(ah, 'POST', '/api/auth/native/enroll/options', native(undefined, { host: TAILNET_DNS, body: { code: setup } }));
  assert.equal(anon.status, 403, 'no Tailscale identity');
  const out = await enroll(d, 'iPad', setup, TAILNET_DNS).catch((e) => e);
  assert.ok(out instanceof Error, 'the helper sends no identity, so it must fail');
  const serve = { host: TAILNET_DNS, headers: { 'tailscale-user-login': OWNER } };
  const opts = await http(ah, 'POST', '/api/auth/native/enroll/options', native(undefined, { ...serve, body: { code: setup } }));
  assert.equal(opts.status, 200);
  const { challengeId, challenge, host } = opts.json();
  assert.equal(host, TAILNET_DNS);
  const res = await http(ah, 'POST', '/api/auth/native/enroll/verify', native(undefined, { ...serve, body: { challengeId, publicKey: d.publicKey, label: 'iPad', signature: signed(d, message('enroll', challenge, host, d.publicKey, 'iPad')) } }));
  assert.equal(res.status, 200, res.body);
  const token = res.json().token;
  assert.equal((await http(ah, 'GET', '/api/state', native(token, serve))).status, 200);
  assert.equal((await http(ah, 'GET', '/api/state', native(token, { host: TAILNET_DNS, headers: { 'tailscale-user-login': 'mallory@example.com' } }))).status, 403);
});

test('native writes: X-AH always required; Origin may be absent only with nothing ambient', async () => {
  const { token } = await enroll(newDevice());
  assert.equal((await http(ah, 'POST', '/api/auth/code', native(token, { body: {} }))).status, 200, 'bearer, X-AH, no Origin');
  assert.equal((await http(ah, 'POST', '/api/auth/code', native(token, { body: {}, csrf: false }))).status, 403, 'no X-AH');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { token, body: {}, origin: 'https://evil.example' })).status, 403, 'a foreign Origin');
  const cookie = await signIn(ah, 'ambient');
  assert.equal((await http(ah, 'POST', '/api/auth/code', native(token, { body: {}, cookie }))).status, 403, 'a cookie rides along');
  // Unchanged for everyone else: a browser cookie, the host CLI and peer tokens still need Origin.
  assert.equal((await http(ah, 'POST', '/api/auth/code', { cookie, body: {}, origin: null })).status, 403, 'browser without Origin');
  assert.equal((await http(ah, 'POST', '/api/auth/code', { token: ah.localToken(), body: {}, origin: null })).status, 403, 'host token without Origin');
  const peer = (await http(ah, 'POST', '/api/auth/tokens', { token: ah.localToken(), body: { name: 'peer' } })).json().token;
  assert.equal((await http(ah, 'POST', '/api/auth/code', { token: peer, body: {}, origin: null })).status, 403, 'peer token without Origin');
  // The pre-sign-in exemption covers exactly the native sign-in routes.
  assert.equal((await http(ah, 'POST', '/api/auth/password/login', native(undefined, { body: { password: 'x' } }))).status, 403, 'other sign-in routes keep the Origin check');
});

test('a native secret is never a cookie, and a cookie is never a bearer', async () => {
  const { token } = await enroll(newDevice());
  assert.equal((await http(ah, 'GET', '/api/state', { cookie: `ah_session=${token}` })).status, 401);
  assert.equal((await http(ah, 'GET', '/api/state', { cookie: `__Host-ah_session=${token}` })).status, 401);
  const cookie = await signIn(ah, 'cookie as bearer');
  assert.equal((await http(ah, 'GET', '/api/state', native(cookie.split('=')[1]))).status, 401);
});

test('revoking a native sign-in cuts its event stream and terminals; removing the device ends every sign-in', async () => {
  const d = newDevice();
  const { token, sessionId, deviceId } = await enroll(d, 'revoked phone');
  // An open event stream ends when the session is revoked.
  const ended = new Promise<void>((resolve) => {
    const req = request({ host: '127.0.0.1', port: ah.port, path: '/api/events', headers: { host: `localhost:${ah.port}`, authorization: `Bearer ${token}` } }, (res) => {
      assert.equal(res.statusCode, 200);
      res.on('data', () => {});
      res.on('end', () => resolve());
    });
    req.on('error', () => resolve());
    req.end();
  });
  // A terminal (no Origin, bearer) attaches, then closes with 4401 on revoke.
  const windowId = await shell(token, 'native-term');
  const ws = new WebSocket(`ws://127.0.0.1:${ah.port}/ws/${encodeURIComponent(windowId)}?cols=80&rows=24`, { headers: { host: `localhost:${ah.port}`, authorization: `Bearer ${token}` } });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) => reject(new Error(`ws ${res.statusCode}`)));
  });
  const closed = new Promise<number>((resolve) => ws.once('close', (c) => resolve(c)));
  assert.equal((await http(ah, 'DELETE', `/api/auth/sessions/${sessionId}`, { token: ah.localToken() })).status, 200);
  await ended;
  assert.equal(await closed, 4401);
  assert.equal((await http(ah, 'GET', '/api/state', native(token))).status, 401);
  // The device key still signs in, until the device is removed.
  const again = await login(d, deviceId, 'revoked phone');
  assert.equal(again.status, 200);
  const second = again.json().token;
  const overview = (await http(ah, 'GET', '/api/auth/overview', native(second))).json();
  assert.ok(overview.devices.some((x: any) => x.id === deviceId && x.current));
  assert.ok(overview.sessions.some((s: any) => s.native && s.deviceId === deviceId && s.current));
  assert.equal((await http(ah, 'DELETE', `/api/auth/devices/${deviceId}`, { token: ah.localToken() })).status, 200);
  assert.equal((await http(ah, 'GET', '/api/state', native(second))).status, 401, 'removing the device ends its sign-ins');
  assert.equal((await login(d, deviceId, 'revoked phone')).status, 401, 'and its key no longer signs in');
  assert.match(ah.log(), /auth\.device_removed/);
});

test('terminals: native bearer without Origin works; a cookie or another credential without Origin does not', async () => {
  const { token } = await enroll(newDevice());
  const windowId = await shell(token, 'native-ws');
  const cookie = await signIn(ah, 'ws cookie');
  const attempt = (headers: Record<string, string>) =>
    new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${ah.port}/ws/${encodeURIComponent(windowId)}?cols=80&rows=24`, { headers: { host: `localhost:${ah.port}`, ...headers } });
      ws.once('open', () => {
        ws.close();
        resolve(101);
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.once('error', () => {});
    });
  assert.equal(await attempt({ authorization: `Bearer ${token}` }), 101);
  assert.equal(await attempt({ authorization: `Bearer ${token}`, cookie }), 403, 'a cookie rides along');
  assert.equal(await attempt({ authorization: `Bearer ${token}`, origin: 'https://evil.example' }), 403, 'a foreign Origin');
  assert.equal(await attempt({ cookie }), 403, 'a browser cookie needs Origin');
  assert.equal(await attempt({ authorization: `Bearer ${ah.localToken()}` }), 403, 'the host token needs Origin');
  assert.equal(await attempt({ authorization: 'Bearer forged' }), 403, 'garbage is anonymous');
});

test('the preview web view gets a short-lived cookie that ends with its native sign-in', async () => {
  const { token, sessionId } = await enroll(newDevice(), 'preview phone');
  const cookie = await signIn(ah, 'not native');
  assert.equal((await http(ah, 'POST', '/api/auth/native/preview-session', { cookie, body: {} })).status, 403, 'only native sign-ins');
  const res = await http(ah, 'POST', '/api/auth/native/preview-session', native(token, { body: {} }));
  assert.equal(res.status, 200);
  const preview = res.json();
  assert.equal(preview.names.http, 'ah_session');
  assert.ok(preview.expiresAt <= Date.now() + 12 * 3600_000 + 1000);
  assert.equal((await http(ah, 'GET', '/api/state', { cookie: `ah_session=${preview.value}` })).status, 200);
  assert.equal((await http(ah, 'GET', '/api/state', native(preview.value))).status, 401, 'a cookie session is never a bearer');
  await http(ah, 'POST', '/api/auth/logout', native(token, { body: {} }));
  assert.equal((await http(ah, 'GET', '/api/state', native(token))).status, 401, 'signed out');
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie: `ah_session=${preview.value}` })).status === 401, 3000, 'preview cookie to end');
  assert.match(ah.log(), new RegExp(`"session":"${sessionId}"`));
});

test('enrollment attempts with bad codes are throttled like setup codes', async () => {
  const fresh = await startAh();
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await http(fresh, 'POST', '/api/auth/native/enroll/options', native(undefined, { body: { code: `BAD${i}` } }))).status;
    assert.equal(last, 429);
  } finally {
    await cleanup(fresh);
  }
});
