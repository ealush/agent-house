import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Http2Server, type ServerHttp2Stream } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'ah-apns-'));
const { Apns, apnsOrigin, apnsPayload, providerToken } = await import('./apns.ts');
const { Push } = await import('./push.ts');

const dir = mkdtempSync(join(tmpdir(), 'ah-apns-key-'));
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const keyFile = join(dir, 'AuthKey_TEST.p8');
writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }));
const config = { teamId: 'TEAM123456', keyId: 'KEY1234567', keyFile, topic: 'dev.ah.native' };
const TOKEN = 'a'.repeat(64);
const GONE = 'b'.repeat(64);

type Seen = { path: string; headers: Record<string, string>; body: any };

/** A plaintext HTTP/2 stand-in for Apple's provider API. */
async function fakeApple(answer: (path: string) => [number, string?] = () => [200]): Promise<{ server: Http2Server; origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer();
  server.on('stream', (stream: ServerHttp2Stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => (body += d));
    stream.on('end', () => {
      const path = String(headers[':path']);
      seen.push({ path, headers: headers as any, body: JSON.parse(body) });
      const [status, reason] = answer(path);
      stream.respond({ ':status': status, 'content-type': 'application/json' });
      stream.end(reason ? JSON.stringify({ reason }) : '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const device = (token: string, events = { waiting: true, done: true }, preview: 'full' | 'private' = 'full') => ({ token, environment: 'sandbox' as const, events, preview, sessionId: `s-${token[0]}`, deviceId: 'd1', label: 'iPhone' });

test('the provider token is an ES256 JWT Apple can verify with the key', () => {
  const jwt = providerToken(config, privateKey, 1_700_000_000);
  const [h, c, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString()), { alg: 'ES256', kid: config.keyId });
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url').toString()), { iss: config.teamId, iat: 1_700_000_000 });
  assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
});

test('only loopback http stands in for Apple; otherwise the real origins', () => {
  assert.equal(apnsOrigin('sandbox', ''), 'https://api.sandbox.push.apple.com');
  assert.equal(apnsOrigin('production', ''), 'https://api.push.apple.com');
  assert.equal(apnsOrigin('production', 'http://127.0.0.1:9'), 'http://127.0.0.1:9');
  assert.throws(() => apnsOrigin('sandbox', 'https://evil.example'));
  assert.throws(() => apnsOrigin('sandbox', 'http://10.0.0.1:443'));
});

test('payloads: full or private previews; approve/deny only for answerable asks', () => {
  const alert = { title: 'Fix login needs you', body: 'web · Wants to run pnpm test', tag: 'u1', route: 'u1', host: 'box', badge: 2, answerable: true };
  const full = apnsPayload(alert, 'waiting', 'full');
  assert.deepEqual(full.aps.alert, { title: alert.title, body: alert.body });
  assert.equal(full.aps.category, 'AH_APPROVAL');
  assert.equal(full.aps['interruption-level'], 'time-sensitive');
  assert.deepEqual(full.ah, { v: 1, host: 'box', route: 'u1', event: 'waiting' });
  const quiet = apnsPayload(alert, 'waiting', 'private');
  assert.deepEqual(quiet.aps.alert, { title: 'A session needs you' }, 'nothing about the session on the lock screen');
  assert.equal(apnsPayload({ ...alert, answerable: false }, 'waiting', 'full').aps.category, undefined);
  assert.equal(apnsPayload(alert, 'done', 'full').aps.category, undefined, 'a finished turn has nothing to approve');
});

test('registration needs configuration and a well-formed token; one per sign-in', () => {
  const off = new Apns(null, { file: join(dir, 'off.json') });
  assert.throws(() => off.register(device(TOKEN)), /not configured/);
  const apns = new Apns(config, { file: join(dir, 'reg.json'), transport: async () => ({ status: 200 }) });
  assert.throws(() => apns.register({ ...device(TOKEN), token: 'not-hex' }), /invalid device token/);
  assert.throws(() => apns.register({ ...device(TOKEN), environment: 'staging' as never }), /invalid environment/);
  apns.register(device(TOKEN));
  apns.register({ ...device('c'.repeat(64)), sessionId: 's-a' }); // a reinstall: same sign-in, new token
  assert.equal(apns.status('s-a').registration?.environment, 'sandbox');
  assert.equal((apns as any).devices.size, 1);
  apns.forgetSession('s-a');
  assert.equal(apns.status('s-a').registration, null);
});

test('delivers over HTTP/2 with the provider token, honors events, and forgets dead tokens', async () => {
  const apple = await fakeApple((path) => (path.endsWith(GONE) ? [410, 'Unregistered'] : [200]));
  process.env.AH_APNS_ORIGIN = apple.origin;
  try {
    const apns = new Apns(config, { file: join(dir, 'send.json') });
    apns.register(device(TOKEN));
    apns.register(device(GONE));
    apns.register(device('d'.repeat(64), { waiting: true, done: false }, 'private'));
    await apns.send('done', { title: 't finished', body: 'p · Claude Code', tag: 'u1', route: 'u1', host: 'box', badge: 0, answerable: false });
    assert.deepEqual(apple.seen.map((s) => s.path.slice(-64)[0]).sort(), ['a', 'b'], 'the waiting-only device skips "done"');
    const first = apple.seen.find((s) => s.path === `/3/device/${TOKEN}`)!;
    assert.equal(first.headers['apns-topic'], config.topic);
    assert.equal(first.headers['apns-push-type'], 'alert');
    assert.equal(first.headers['apns-collapse-id'], 'u1');
    const jwt = first.headers.authorization.replace(/^bearer /, '');
    const [h, c, s] = jwt.split('.');
    assert.ok(verify('sha256', Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
    assert.equal(first.body.ah.route, 'u1');
    assert.equal((apns as any).devices.has(GONE), false, 'Unregistered tokens are dropped');
    apple.seen.length = 0;
    await apns.send('waiting', { title: 'x needs you', body: 'p · Asks: ok?', tag: 'u2', route: 'u2', host: 'box', badge: 1, answerable: false });
    assert.equal(apple.seen.length, 2);
    const quiet = apple.seen.find((s) => s.path.endsWith('d'.repeat(64)))!;
    assert.deepEqual(quiet.body.aps.alert, { title: 'A session needs you' });
    assert.equal(quiet.headers['apns-priority'], '10');
  } finally {
    delete process.env.AH_APNS_ORIGIN;
    apple.server.close();
  }
});

test('Push alerts go to APNs on the same transitions as Web Push, with the badge and route', async () => {
  const push = new Push();
  const sent: Array<{ event: string; alert: any }> = [];
  push.apns = { send: async (event: string, alert: any) => void sent.push({ event, alert }), badge: () => {} } as never;
  const win = (uid: string, status: string, answerable = false) => ({ uid, id: '@1', name: uid, title: uid, project: 'p', agent: 'claude', command: 'claude', status, answerable }) as any;
  push.observe([win('a', 'busy'), win('b', 'busy')]);
  push.observe([win('a', 'waiting', true), win('b', 'attention')]);
  assert.deepEqual(
    sent.map((s) => [s.event, s.alert.route, s.alert.badge, s.alert.answerable]),
    [
      ['waiting', 'a', 1, true],
      ['done', 'b', 1, false],
    ],
  );
  push.alert({ title: '#4 ready', body: 'Stack · layer', tag: 'review-s1-4', url: '/#review/s1/4' });
  assert.equal(sent.at(-1)!.alert.route, 'review/s1/4');
  assert.equal(sent.at(-1)!.alert.tag, 'review-s1-4');
});

test('badge-only updates follow the needs-you count, coalesced', async () => {
  const sent: any[] = [];
  const apns = new Apns(config, { file: join(dir, 'badge.json'), transport: async (_o, _p, _h, body) => (sent.push(JSON.parse(body)), { status: 200 }) });
  apns.register(device(TOKEN));
  apns.badge(2);
  apns.badge(1);
  apns.badge(0);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent, [{ aps: { badge: 0 } }], 'one push with the latest count');
  await apns.send('waiting', { title: 't', body: 'b', tag: 'u', route: 'u', host: 'h', badge: 3, answerable: false });
  sent.length = 0;
  apns.badge(3);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(sent, [], 'an alert already carried this count');
});
