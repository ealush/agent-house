import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'ah-auth-'));
const { Auth, AuthError } = await import('./auth.ts');

const cfg = { mode: 'passkey' as const, idleHours: 24, maxDays: 30 };
const req = (headers: Record<string, string> = {}) => ({ headers: { origin: 'https://box.tail.ts.net', ...headers }, socket: { remoteAddress: '127.0.0.1' } }) as any;
const cookieOf = (setCookie: string) => setCookie.split(';')[0];

test('nothing gets in without a session or token', () => {
  const auth = new Auth(cfg);
  assert.equal(auth.identify(req()), null);
  assert.equal(auth.identify(req({ cookie: '__Host-ah_session=forged' })), null);
  assert.equal(auth.identify(req({ authorization: 'Bearer nope' })), null);
  assert.equal(new Auth({ ...cfg, mode: 'off' }).identify(req())?.kind, 'open');
});

test('the local CLI token works; peer tokens are revocable', () => {
  const auth = new Auth(cfg);
  assert.equal(auth.identify(req({ authorization: `Bearer ${auth.localToken}` }))?.kind, 'token');
  const t = auth.createToken('mac');
  const caller = auth.identify(req({ authorization: `Bearer ${t}` }));
  assert.equal(caller?.kind === 'token' && caller.token.name, 'mac');
  auth.removeToken(auth.overview(null).tokens[0].id);
  assert.equal(auth.identify(req({ authorization: `Bearer ${t}` })), null);
});

test('setup codes: single use, normalized, required to enroll', async () => {
  const auth = new Auth(cfg);
  await assert.rejects(auth.registrationOptions(req(), null, 'WRONG-CODE1'), (e: InstanceType<typeof AuthError>) => e.status === 401);
  const code = auth.issueCode('test');
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const { options } = await auth.registrationOptions(req(), null, code.toLowerCase().replace('-', ' '));
  assert.equal(options.rp.id, 'box.tail.ts.net');
  assert.equal(options.authenticatorSelection?.userVerification, 'required');
  await assert.rejects(auth.registrationOptions(req({ origin: 'http://100.1.2.3:7681' }), null, code), /domain name/);
});

test('master password: scrypt, wrong password counts toward throttling', async () => {
  const auth = new Auth(cfg);
  await assert.rejects(auth.setPassword('short'), /12 characters/);
  await auth.setPassword('correct horse battery');
  const { cookie } = await auth.passwordLogin(req(), 'correct horse battery', 'test');
  assert.match(cookie, /^__Host-ah_session=.+; Path=\/; HttpOnly; Secure; SameSite=Strict/);
  assert.equal(auth.identify(req({ cookie: cookieOf(cookie) }))?.kind, 'session');
  for (let i = 0; i < 10; i++) await assert.rejects(auth.passwordLogin(req(), 'nope', 'x'), /wrong password/);
  await assert.rejects(auth.passwordLogin(req(), 'correct horse battery', 'x'), (e: InstanceType<typeof AuthError>) => e.status === 429);
});

test('sessions: idle expiry, revocation closes live connections', async () => {
  const auth = new Auth(cfg);
  await auth.setPassword('correct horse battery');
  const { cookie, session } = await auth.passwordLogin(req(), 'correct horse battery', 'phone');
  const caller = auth.identify(req({ cookie: cookieOf(cookie) }))!;
  let closed = 0;
  auth.track(caller, { close: () => closed++ });
  auth.endSession(session.id, 'revoked');
  assert.equal(closed, 1);
  assert.equal(auth.identify(req({ cookie: cookieOf(cookie) })), null);

  const again = await auth.passwordLogin(req(), 'correct horse battery', 'laptop');
  again.session.lastSeenAt -= 25 * 3600_000; // idle past 24h
  assert.equal(auth.identify(req({ cookie: cookieOf(again.cookie) })), null);
});

test('the last way in cannot be removed', async () => {
  const auth = new Auth(cfg);
  (auth as any).store.password = undefined; // state file is shared across tests
  (auth as any).store.passkeys.push({ id: 'k1', publicKey: '', counter: 0, rpID: 'x', label: 'only', createdAt: 0, lastUsedAt: 0 });
  assert.throws(() => auth.removePasskey('k1'), /last way in/);
});

test('a failed passkey registration does not burn the setup code', async () => {
  const auth = new Auth(cfg);
  const code = auth.issueCode('test');
  const first = await auth.registrationOptions(req(), null, code);
  await assert.rejects(auth.verifyRegistration(req(), first.challengeId, { id: 'x', rawId: 'x', type: 'public-key', response: {} } as any, 'x'), /passkey not accepted/);
  // Still valid: the next attempt can use it.
  const again = await auth.registrationOptions(req(), null, code);
  assert.ok(again.challengeId);
});

test('throttling is per mechanism: password guessing never locks out setup codes or passkeys', async () => {
  const auth = new Auth(cfg);
  (auth as any).store.password = undefined;
  await auth.setPassword('correct horse battery');
  for (let i = 0; i < 10; i++) await assert.rejects(auth.passwordLogin(req(), 'nope', 'x'));
  await assert.rejects(auth.passwordLogin(req(), 'correct horse battery', 'x'), (e: InstanceType<typeof AuthError>) => e.status === 429);
  // Other mechanisms are unaffected.
  const code = auth.issueCode('test');
  assert.ok((await auth.registrationOptions(req(), null, code)).challengeId);
  assert.ok((await auth.authenticationOptions(req())).challengeId);
  // A different source still has its own budget.
  const { cookie } = await auth.passwordLogin(req({ 'tailscale-user-login': 'other@example.com' }), 'correct horse battery', 'y');
  assert.ok(cookie);
});

test('an unreadable auth store refuses to start rather than starting empty', async () => {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(process.env.XDG_STATE_HOME!, 'ah', 'auth.json'), '{ not json');
  assert.throws(() => new Auth(cfg), /unreadable/);
});
