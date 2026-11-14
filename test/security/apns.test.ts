// Native push registration: only a native sign-in registers, and its token is forgotten the
// moment that sign-in ends, so a revoked or removed phone stops receiving alerts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, signIn, until, type Ah } from '../helpers.ts';

let ah: Ah;
const keyDir = mkdtempSync(join(tmpdir(), 'ah-apns-it-'));
before(async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const keyFile = join(keyDir, 'AuthKey.p8');
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  ah = await startAh({ apns: { teamId: 'TEAM123456', keyId: 'KEY1234567', keyFile, topic: 'dev.ah.native' } });
});
after(() => cleanup(ah));

async function nativeSignIn(label: string): Promise<{ token: string; sessionId: string; deviceId: string }> {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
  const code = (await http(ah, 'POST', '/api/auth/code', { token: ah.localToken(), body: {} })).json().code;
  const { challengeId, challenge, host } = (await http(ah, 'POST', '/api/auth/native/enroll/options', { origin: null, body: { code } })).json();
  const msg = Buffer.from(['ah-native-enroll-v1', challenge, host, point, label].join('\n'));
  const signature = sign('sha256', msg, { key: privateKey, dsaEncoding: 'der' }).toString('base64url');
  return (await http(ah, 'POST', '/api/auth/native/enroll/verify', { origin: null, body: { challengeId, publicKey: point, label, signature } })).json();
}

const TOKEN = 'f'.repeat(64);
const apnsFile = () => join(ah.dir, 'state', 'ah', 'apns.json');
/** What's on disk now; null while a write is in flight (polled until it settles). */
const stored = (): Array<{ token: string }> | null => {
  try {
    return existsSync(apnsFile()) ? JSON.parse(readFileSync(apnsFile(), 'utf8')) : [];
  } catch {
    return null;
  }
};
const has = (t: string) => stored()?.some((d) => d.token === t) ?? null;

test('only a native sign-in registers; the registration is reported back and stored owner-only', async () => {
  const cookie = await signIn(ah, 'browser');
  assert.equal((await http(ah, 'PUT', '/api/push/apns', { cookie, body: { token: TOKEN, environment: 'sandbox' } })).status, 403);
  assert.equal((await http(ah, 'PUT', '/api/push/apns', { token: ah.localToken(), body: { token: TOKEN, environment: 'sandbox' } })).status, 403);
  const { token } = await nativeSignIn('push phone');
  const res = await http(ah, 'PUT', '/api/push/apns', { token, origin: null, body: { token: TOKEN, environment: 'sandbox', events: { waiting: true, done: true }, preview: 'private' } });
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(res.json().registration.events, { waiting: true, done: true });
  assert.equal(res.json().registration.preview, 'private');
  assert.equal((await http(ah, 'GET', '/api/push/apns', { token, origin: null })).json().configured, true);
  await until(() => has(TOKEN), 4000, 'apns.json');
  assert.equal(statSync(apnsFile()).mode & 0o777, 0o600);
  assert.equal((await http(ah, 'PUT', '/api/push/apns', { token, origin: null, body: { token: 'xyz', environment: 'sandbox' } })).status, 400);
});

test('signing out, revocation and device removal forget the device token', async () => {
  const a = await nativeSignIn('revoke me');
  await http(ah, 'PUT', '/api/push/apns', { token: a.token, origin: null, body: { token: '1'.repeat(64), environment: 'production' } });
  await http(ah, 'DELETE', `/api/auth/sessions/${a.sessionId}`, { token: ah.localToken() });
  await until(() => has('1'.repeat(64)) === false, 4000, 'revoked token dropped');

  const b = await nativeSignIn('sign me out');
  await http(ah, 'PUT', '/api/push/apns', { token: b.token, origin: null, body: { token: '2'.repeat(64), environment: 'production' } });
  await http(ah, 'POST', '/api/auth/logout', { token: b.token, origin: null, body: {} });
  await until(() => has('2'.repeat(64)) === false, 4000, 'signed-out token dropped');

  const c = await nativeSignIn('remove me');
  await http(ah, 'PUT', '/api/push/apns', { token: c.token, origin: null, body: { token: '3'.repeat(64), environment: 'production' } });
  await http(ah, 'DELETE', `/api/auth/devices/${c.deviceId}`, { token: ah.localToken() });
  await until(() => has('3'.repeat(64)) === false, 4000, 'removed device token dropped');
});

test('only a native sign-in registers a Live Activity; ending the sign-in forgets it', async () => {
  const ACT = '2'.repeat(64);
  const file = join(ah.dir, 'state', 'ah', 'apns-activities.json');
  const activities = (): Array<{ token: string }> | null => {
    try {
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
    } catch {
      return null;
    }
  };
  const cookie = await signIn(ah, 'browser');
  const body = { uid: 'u-live', token: ACT, environment: 'sandbox' };
  assert.equal((await http(ah, 'PUT', '/api/push/apns/activity', { cookie, body })).status, 403);
  assert.equal((await http(ah, 'PUT', '/api/push/apns/activity', { token: ah.localToken(), body })).status, 403);
  const a = await nativeSignIn('live phone');
  assert.equal((await http(ah, 'PUT', '/api/push/apns/activity', { token: a.token, origin: null, body: { ...body, token: 'nope' } })).status, 400);
  const res = await http(ah, 'PUT', '/api/push/apns/activity', { token: a.token, origin: null, body });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.json().activities, 1);
  await until(() => activities()?.some((x) => x.token === ACT) ?? null, 4000, 'apns-activities.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  await http(ah, 'DELETE', `/api/auth/sessions/${a.sessionId}`, { token: ah.localToken() });
  await until(() => (activities() === null ? null : !activities()!.some((x) => x.token === ACT)), 4000, 'revoked activity');
});
