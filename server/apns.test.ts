import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Http2Server, type ServerHttp2Stream } from 'node:http2';
import { generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'ah-apns-'));
const { Apns, activityState, apnsOrigin, apnsPayload, providerToken } = await import('./apns.ts');
const { Push, askLine } = await import('./push.ts');

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
  assert.equal(apnsPayload(alert, 'done', 'full').aps.category, 'AH_REPLY', 'a finished turn takes a reply, nothing to approve');
  assert.equal(apnsPayload({ ...alert, route: 'review/s1/101' }, 'done', 'full').aps.category, undefined, 'a review layer has no session to reply to');
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
  push.apns = { send: async (event: string, alert: any) => void sent.push({ event, alert }), badge: () => {}, follow: () => {} } as never;
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

const ACT = 'e'.repeat(64);
const view = (uid: string, status: string, extra: Record<string, unknown> = {}) => ({ uid, status, detail: null, limit: null, ask: null, answerable: false, ...extra }) as any;

test('a Live Activity says what the session is doing, asks or hit, in one short line', () => {
  assert.deepEqual(activityState(view('u', 'busy', { detail: 'Editing server/apns.ts\nmore' }), askLine, 9), { phase: 'working', detail: 'Editing server/apns.ts', answerable: false, since: 9 });
  const ask = { kind: 'command', text: 'Bash command\npnpm test' };
  assert.deepEqual(activityState(view('u', 'waiting', { ask, answerable: true }), askLine, 9), { phase: 'waiting', detail: 'Wants to run pnpm test', answerable: true, since: 9 });
  assert.equal(activityState(view('u', 'attention', { limit: 'Session limit · resets 12am' }), askLine, 9).phase, 'limited');
  assert.equal(activityState(view('u', 'attention'), askLine, 9).phase, 'finished');
  assert.equal(activityState(view('u', 'idle'), askLine, 9).phase, 'finished');
  assert.equal(activityState(view('u', 'busy', { detail: 'x'.repeat(300) }), askLine, 9).detail!.length, 120);
});

test('activity registration needs configuration, a token and a session; one per session per sign-in', () => {
  const off = new Apns(null, { file: join(dir, 'act-off.json') });
  assert.throws(() => off.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' }), /not configured/);
  const apns = new Apns(config, { file: join(dir, 'act-reg.json'), transport: async () => ({ status: 200 }) });
  assert.throws(() => apns.registerActivity({ uid: 'u1', token: 'zz', environment: 'sandbox', sessionId: 's1' }), /invalid activity token/);
  assert.throws(() => apns.registerActivity({ uid: 'u1', token: ACT, environment: 'development' as never, sessionId: 's1' }), /invalid environment/);
  apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
  apns.registerActivity({ uid: 'u1', token: 'f'.repeat(64), environment: 'sandbox', sessionId: 's1' }); // a newer message
  apns.registerActivity({ uid: 'u2', token: '1'.repeat(64), environment: 'sandbox', sessionId: 's1' });
  assert.equal(apns.activityCount('s1'), 2);
  apns.unregisterActivity('s1', 'u2');
  assert.equal(apns.activityCount('s1'), 1);
  apns.forgetSession('s1');
  assert.equal(apns.activityCount('s1'), 0, 'signing out forgets its activities');
});

test('a Live Activity follows its session: working, needs you, then ends lingering', async () => {
  const apple = await fakeApple();
  process.env.AH_APNS_ORIGIN = apple.origin;
  try {
    const file = join(dir, 'act-follow.json');
    const apns = new Apns(config, { file });
    apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
    const tick = async (w: any) => (apns.follow([w, view('other', 'busy')], askLine), await new Promise((r) => setTimeout(r, 20)));
    await tick(view('u1', 'attention'));
    assert.equal(apple.seen.length, 0, 'the message has not reached it yet: nothing ends it');
    await tick(view('u1', 'busy', { detail: 'Reading files' }));
    assert.equal(apple.seen.length, 1);
    const first = apple.seen[0];
    assert.equal(first.path, `/3/device/${ACT}`);
    assert.equal(first.headers['apns-push-type'], 'liveactivity');
    assert.equal(first.headers['apns-topic'], `${config.topic}.push-type.liveactivity`);
    assert.equal(first.body.aps.event, 'update');
    assert.equal(first.body.aps['content-state'].phase, 'working');
    assert.equal(first.body.aps['content-state'].detail, 'Reading files');
    assert.equal(typeof first.body.aps.timestamp, 'number');
    await tick(view('u1', 'busy', { detail: 'Reading files' }));
    await tick(view('u1', 'busy', { detail: 'Editing a file' }));
    assert.equal(apple.seen.length, 1, 'no change, then a new line within 15 s: nothing sent');
    await tick(view('u1', 'waiting', { ask: { kind: 'command', text: 'rm -rf build' }, answerable: true }));
    assert.equal(apple.seen.length, 2, 'needing you goes out at once');
    assert.equal(apple.seen[1].headers['apns-priority'], '10');
    assert.deepEqual(apple.seen[1].body.aps['content-state'], { phase: 'waiting', detail: 'Wants to run rm -rf build', answerable: true, since: apple.seen[1].body.aps['content-state'].since });
    await tick(view('u1', 'attention'));
    assert.equal(apple.seen.length, 3);
    assert.equal(apple.seen[2].body.aps.event, 'end');
    assert.equal(apple.seen[2].body.aps['content-state'].phase, 'finished');
    assert.ok(apple.seen[2].body.aps['dismissal-date'] > apple.seen[2].body.aps.timestamp, 'it lingers showing it finished');
    assert.equal(apns.activityCount('s1'), 0, 'an ended activity is forgotten');
    await tick(view('u1', 'busy'));
    assert.equal(apple.seen.length, 3);
  } finally {
    delete process.env.AH_APNS_ORIGIN;
    apple.server.close();
  }
});

test('private previews keep what it is doing off the Lock Screen; dead activity tokens are dropped', async () => {
  const apple = await fakeApple(() => [410, 'Unregistered']);
  process.env.AH_APNS_ORIGIN = apple.origin;
  try {
    const apns = new Apns(config, { file: join(dir, 'act-private.json') });
    apns.register({ ...device(TOKEN, { waiting: true, done: true }, 'private'), sessionId: 's1' });
    apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
    apns.follow([view('u1', 'busy', { detail: 'Editing secrets.ts' })], askLine);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(apple.seen[0].body.aps['content-state'].detail, null);
    assert.equal(apns.activityCount('s1'), 0, 'Apple said the activity is gone');
  } finally {
    delete process.env.AH_APNS_ORIGIN;
    apple.server.close();
  }
});

test('activities survive a host restart, and a session that is gone ends its activity', async () => {
  const sent: any[] = [];
  const transport = async (_o: string, _p: string, h: Record<string, string>, body: string) => (sent.push({ h, body: JSON.parse(body) }), { status: 200 });
  const file = join(dir, 'act-restart.json');
  const before = new Apns(config, { file, transport });
  before.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
  before.follow([view('u1', 'busy')], askLine);
  await new Promise((r) => setTimeout(r, 50)); // let the write land
  const after = new Apns(config, { file, transport });
  assert.equal(after.activityCount('s1'), 1);
  after.follow([], askLine);
  assert.equal(sent.at(-1).body.aps.event, 'end');
  assert.equal(after.activityCount('s1'), 0);
});

test('recovery shows on the Lock Screen: carrying on after a limit, picking up again, failing, signing in', () => {
  const rec = (state: string, extra: Record<string, unknown> = {}) => ({ state, reason: 'rate_limit', evidence: 'Session limit · resets 5:20pm', attempts: 0, maxAttempts: 5, nextAttemptAt: 1800, resetsAt: 1790, auto: true, updatedAt: 1, ...extra });
  assert.deepEqual(activityState(view('u', 'attention', { limit: 'Session limit · resets 5:20pm', recovery: rec('scheduled') }), askLine, 9), { phase: 'limited', detail: 'Going on after the reset (Session limit · resets 5:20pm)', answerable: false, since: 9, until: 1800 });
  assert.deepEqual(activityState(view('u', 'attention', { limit: 'Session limit · resets 5:20pm', limitResetsAt: 1790 }), askLine, 9), { phase: 'limited', detail: 'Session limit · resets 5:20pm', answerable: false, since: 9, until: 1790 }, 'no plan: the reset, and it ends');
  assert.equal(activityState(view('u', 'idle', { recovery: rec('resuming') }), askLine, 9).phase, 'starting');
  assert.deepEqual(activityState(view('u', 'idle', { recovery: rec('failed', { reason: 'provider_error', evidence: 'API Error: 529 overloaded' }) }), askLine, 9), { phase: 'failed', detail: 'API Error: 529 overloaded', answerable: false, since: 9 });
  assert.equal(activityState(view('u', 'idle', { recovery: rec('needs_user', { reason: 'credentials' }) }), askLine, 9).detail, 'Sign the agent in again');
  assert.equal(activityState(view('u', 'busy', { detail: 'Reading', recovery: rec('resuming') }), askLine, 9).phase, 'working', 'working again: recovery is history');
});

test('a limit that ah will carry on from keeps the activity; it ends when the work does', async () => {
  const sent: any[] = [];
  const transport = async (_o: string, path: string, _h: Record<string, string>, body: string) => (sent.push({ path, body: JSON.parse(body) }), { status: 200 });
  const apns = new Apns(config, { file: join(dir, 'act-recover.json'), transport });
  apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
  const rec = (state: string) => ({ state, reason: 'rate_limit', evidence: 'limit', attempts: 0, maxAttempts: 5, nextAttemptAt: 1800, resetsAt: 1790, auto: true, updatedAt: 1 });
  const states = () => sent.map((s) => `${s.body.aps.event}:${s.body.aps['content-state'].phase}`);
  apns.follow([view('u1', 'busy')], askLine);
  apns.follow([view('u1', 'attention', { limit: 'limit', recovery: rec('scheduled') })], askLine);
  assert.deepEqual(states(), ['update:working', 'update:limited'], 'scheduled to go on: not ended');
  assert.equal(sent[1].body.aps['content-state'].until, 1800);
  apns.follow([view('u1', 'idle', { recovery: rec('resuming') })], askLine);
  apns.follow([view('u1', 'busy')], askLine);
  apns.follow([view('u1', 'attention')], askLine);
  assert.deepEqual(states(), ['update:working', 'update:limited', 'update:starting', 'update:working', 'end:finished']);
  assert.equal(apns.activityCount('s1'), 0);

  // Without a plan to go on, a limit ends it, as before.
  sent.length = 0;
  apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
  apns.follow([view('u1', 'busy')], askLine);
  apns.follow([view('u1', 'attention', { limit: 'limit', recovery: rec('waiting_capacity') })], askLine);
  assert.deepEqual(states(), ['update:working', 'end:limited']);
});

test('a rotated activity token carries the activity on; a new activity starts over', async () => {
  const sent: any[] = [];
  const transport = async (_o: string, path: string, _h: Record<string, string>, body: string) => (sent.push({ path, body: JSON.parse(body) }), { status: 200 });
  const apns = new Apns(config, { file: join(dir, 'act-rotate.json'), transport });
  const NEXT = 'f'.repeat(64);
  apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
  apns.follow([view('u1', 'busy', { detail: 'Reading' })], askLine);
  apns.registerActivity({ uid: 'u1', token: NEXT, environment: 'sandbox', sessionId: 's1', rotated: true });
  assert.equal(apns.activityCount('s1'), 1, 'the old token is gone');
  apns.follow([view('u1', 'busy', { detail: 'Reading' })], askLine);
  assert.equal(sent.length, 1, 'nothing new to say: the device already shows it');
  apns.follow([view('u1', 'attention')], askLine);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].path, `/3/device/${NEXT}`, 'updates go to the new token');
  assert.equal(sent[1].body.aps.event, 'end');

  // A fresh registration (not rotated) waits for its message to reach the session.
  sent.length = 0;
  apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
  apns.follow([view('u1', 'idle')], askLine);
  assert.equal(sent.length, 0);
});

test('a session cut off by a crash ends its activity as interrupted, saying what happened', async () => {
  const sent: any[] = [];
  const transport = async (_o: string, _p: string, _h: Record<string, string>, body: string) => (sent.push(JSON.parse(body)), { status: 200 });
  const apns = new Apns(config, { file: join(dir, 'act-interrupted.json'), transport });
  apns.goneAs = (uid) => (uid === 'u1' ? { phase: 'interrupted', detail: 'The tmux server stopped. Restore it in ah.' } : null);
  apns.registerActivity({ uid: 'u1', token: ACT, environment: 'sandbox', sessionId: 's1' });
  apns.registerActivity({ uid: 'u2', token: 'f'.repeat(64), environment: 'sandbox', sessionId: 's1' });
  apns.follow([view('u1', 'busy', { detail: 'Reading' }), view('u2', 'busy')], askLine);
  apns.follow([], askLine);
  const ends = sent.filter((s) => s.aps.event === 'end').map((s) => s.aps['content-state']);
  assert.deepEqual(ends.map((c) => [c.phase, c.detail]), [['interrupted', 'The tmux server stopped. Restore it in ah.'], ['finished', null]]);
});

test('registrations land whole: a reader never sees half a file, whatever is mid-write', async () => {
  const file = join(dir, 'whole.json');
  const activities = file.replace(/\.json$/, '-activities.json');
  const apns = new Apns(config, { file, transport: async () => ({ status: 200 }) });
  let torn = 0;
  let reads = 0;
  let writing = true;
  const reader = (async () => {
    while (writing) {
      for (const f of [file, activities]) {
        if (!existsSync(f)) continue;
        reads++;
        try {
          JSON.parse(readFileSync(f, 'utf8'));
        } catch {
          torn++;
        }
      }
      await new Promise((r) => setImmediate(r));
    }
  })();
  // Each registration rewrites its file (a long one: many devices, many activities).
  for (let i = 0; i < 150; i++) {
    const hex = i.toString(16).padStart(4, '0').repeat(16);
    apns.register({ ...device(hex, { waiting: true, done: true }), sessionId: `s${i}` });
    apns.registerActivity({ uid: `u${i}`, token: hex.split('').reverse().join(''), environment: 'sandbox', sessionId: `s${i}` });
    await new Promise((r) => setImmediate(r));
  }
  // Until the last writes land (queued one after another; slower on a busy machine).
  const count = (f: string) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8')).length;
    } catch {
      return -1;
    }
  };
  for (let t = Date.now(); Date.now() - t < 15_000 && (count(file) !== 150 || count(activities) !== 150); ) await new Promise((r) => setTimeout(r, 20));
  writing = false;
  await reader;
  assert.ok(reads > 50, `read while writing (${reads})`);
  assert.equal(torn, 0, 'never half a file');
  assert.equal(count(file), 150);
  assert.equal(count(activities), 150);
});
