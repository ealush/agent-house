// The wire shapes the native app and the web client read, pinned (packages/protocol/wire-shapes.txt).
// A running host answers; every field the manifest lists must still be there with the
// same type. Fields may be added (clients ignore what they don't know), never removed,
// retyped, or made nullable without a feature version (server/features.ts): the native
// app decodes non-optional fields strictly, so a field that turns null breaks the whole
// state for it. A field only ever seen null is listed as `null`: it must exist, of any
// type. Maps keyed by data (a preset's mode ids) are pinned as `{*}`, not key by key.
//
// The answers the manifest was read from are kept too (packages/protocol/fixtures, secrets
// and machine details scrubbed): the app's tests decode them with its own decoders, so what
// this server sends is checked against what the app reads without a host or a Mac
// (test/protocol.test.ts keeps them in step with the manifest).
//
// After a deliberate, additive change (packages/protocol/README.md), from apps/server:
//   AH_UPDATE_CONTRACT=1 node --test --test-concurrency=1 test/contract.test.ts test/protocol.test.ts
// (mise run protocol:update does that and the routes).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir, hostname, userInfo } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS } from '../server/config.ts';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

const MANIFEST = fileURLToPath(new URL('../../../packages/protocol/wire-shapes.txt', import.meta.url));
const PICKER = fileURLToPath(new URL('./fixtures/picker.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../../../packages/protocol/fixtures/', import.meta.url));
const REPO = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

/** Objects keyed by data, not by field names. */
const MAPS = [/\.modeCycle\.detect$/];

/** Every field path with the set of JSON types seen there; an array's elements merged into `[]`. */
function shape(v: unknown, path: string, out: Map<string, Set<string>>) {
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (!out.has(path)) out.set(path, new Set());
  out.get(path)!.add(t);
  if (Array.isArray(v)) for (const x of v) shape(x, `${path}[]`, out);
  else if (v && typeof v === 'object') {
    const map = MAPS.some((re) => re.test(path));
    for (const [k, x] of Object.entries(v)) shape(x, `${path}.${map ? '{*}' : k}`, out);
  }
}

/** The first event of a server-sent stream, then hang up. */
function firstEvent(ah: Ah, path: string, cookie: string): Promise<{ event: string; data: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ah.port, path, headers: { host: `localhost:${ah.port}`, cookie }, agent: false }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        const end = buf.indexOf('\n\n');
        if (end < 0) return;
        const frame = buf.slice(0, end);
        const event = /^event: (.*)$/m.exec(frame)?.[1] ?? '';
        const data = /^data: (.*)$/m.exec(frame)?.[1] ?? 'null';
        req.destroy();
        resolve({ event, data: JSON.parse(data) });
      });
    });
    req.on('error', (err) => (err.message.includes('socket hang up') ? null : reject(err)));
    req.end();
  });
}

/** The raw server-sent stream until `done` says it has what it needs (or 15 s pass), then hang up. */
function streamUntil(ah: Ah, path: string, cookie: string, done: (text: string) => boolean, onOpen: () => Promise<unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let opened = false;
    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`no complete stream from ${path} in 15 s:\n${buf.slice(0, 2000)}`));
    }, 15000);
    const req = request({ host: '127.0.0.1', port: ah.port, path, headers: { host: `localhost:${ah.port}`, cookie }, agent: false }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        buf += d;
        if (!opened && buf.includes('\n\n')) {
          opened = true;
          onOpen().catch(reject);
        }
        if (done(buf)) {
          clearTimeout(timer);
          req.destroy();
          resolve(buf.slice(0, buf.lastIndexOf('\n\n') + 2));
        }
      });
    });
    req.on('error', (err) => (err.message.includes('socket hang up') ? null : reject(err)));
    req.end();
  });
}

/** A captured answer as the fixtures keep it: no paths, names or ports of this machine.
 * Only string values change, never keys (a hostname can be a field's name too). */
function scrub(value: unknown, ah: Ah): unknown {
  const user = userInfo().username;
  const host = hostname();
  const word = (s: string) => new RegExp(`\\b${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  const text = (s: string) => {
    if (s === host) return 'host';
    const out = s
      .replaceAll(ah.dir, '/home/me/ah-host')
      .replaceAll(REPO, '/repo')
      .replaceAll(process.execPath, '/usr/bin/node')
      .replaceAll(homedir(), '/home/me')
      .replaceAll(`localhost:${ah.port}`, 'localhost:7681')
      .replaceAll(`127.0.0.1:${ah.port}`, '127.0.0.1:7681')
      // A shell prompt on screen (an ask's context) says who's signed in where.
      .replace(word(host), 'host')
      .replace(word(user), 'me');
    for (const leak of [homedir(), ah.dir]) assert.ok(!out.includes(leak), `a fixture still holds ${leak}`);
    for (const name of [host, user]) assert.ok(!word(name).test(out), `a fixture still holds ${name}`);
    return out;
  };
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map((v) => scrub(v, ah));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, ah)]));
  return value;
}

/** Server-sent frames, each one's data scrubbed and written back as the server wrote it. */
function scrubStream(stream: string, ah: Ah): string {
  return stream.split('\n\n').filter((f) => f.trim()).map((f) => {
    const event = /^event: (.*)$/m.exec(f)?.[1];
    const data = /^data: (.*)$/m.exec(f)?.[1];
    return data === undefined ? f : `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(scrub(JSON.parse(data), ah))}`;
  }).join('\n\n') + '\n\n';
}

let ah: Ah;
let cookie: string;
before(async () => {
  // The built-in agents, and a stand-in that asks permission (a picker on screen).
  const asker = { id: 'test-asker', name: 'Asker', command: `exec ${process.execPath} ${PICKER} permission /dev/null`, match: '^node$', waitingPatterns: ['Do you want to proceed'], approveKeys: ['Enter'], denyKeys: ['Escape'] };
  ah = await startAh({ presets: [...DEFAULT_PRESETS, asker] });
  cookie = await signIn(ah);
});
after(() => cleanup(ah));

test('the shapes clients read are still all there', async () => {
  const seen = new Map<string, Set<string>>();
  // What each fixture holds: the answer, under the manifest path it's pinned at.
  const samples = new Map<string, unknown>();
  const take = (file: string, path: string, value: unknown) => {
    shape(value, path, seen);
    samples.set(file, value);
    return value;
  };
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'contract' } });
  assert.equal(created.status, 201, created.body);
  const { uid } = created.json();
  take('window-created.json', 'POST /api/windows', created.json());
  const asking = (await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'test-asker', cwd: `${ah.dir}/files` } })).json().uid;
  const state = async () => (await http(ah, 'GET', '/api/state', { cookie })).json();
  await until(async () => {
    const s = await state();
    return s.windows.some((w: { uid: string }) => w.uid === uid) && s.windows.find((w: { uid: string }) => w.uid === asking)?.ask?.options?.length;
  }, 15000, 'a shell, and an agent asking permission');
  // A message for the asking agent waits behind its picker: a queue with an item in it.
  take('send-queued.json', 'POST /api/sessions/:uid/send', (await http(ah, 'POST', `/api/sessions/${asking}/send`, { cookie, body: { text: 'after that, run the tests', id: 'contract-1' } })).json());
  take('queue.json', 'GET /api/sessions/:uid/queue', (await http(ah, 'GET', `/api/sessions/${asking}/queue`, { cookie })).json());
  take('send-delivered.json', 'POST /api/sessions/:uid/send', (await http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text: 'true' } })).json());

  take('hello.json', 'GET /api/hello', (await http(ah, 'GET', '/api/hello')).json());
  take('auth-status.json', 'GET /api/auth/status', (await http(ah, 'GET', '/api/auth/status', { cookie })).json());
  take('state.json', 'GET /api/state', await state());
  take('capabilities.json', 'GET /api/capabilities', (await http(ah, 'GET', '/api/capabilities', { cookie })).json());
  // A plain Space, and the list with it (docs/spec/17-spaces.md).
  assert.equal((await http(ah, 'POST', '/api/spaces', { cookie, body: { name: 'Contract' } })).status, 201);
  take('spaces.json', 'GET /api/spaces', (await http(ah, 'GET', '/api/spaces', { cookie })).json());
  const first = await firstEvent(ah, '/api/events', cookie);
  assert.equal(first.event, 'state');
  // The stream as the app reads it (?delta=1): the same whole state first (the frame every
  // subscriber gets, pinned from here), then a session starting arrives as a patch carrying
  // windowsDelta.
  const stream = await streamUntil(ah, '/api/events?delta=1', cookie, (text) => /event: patch\ndata: .*"windowsDelta"/.test(text) && text.endsWith('\n\n'),
    () => http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'contract stream' } }));
  assert.match(stream, /^event: state\n/);
  shape(JSON.parse(/^data: (.*)$/m.exec(stream)![1]), 'SSE /api/events state', seen);
  // Refusals: the error body every client reads, with and without a code.
  const askId = (await state()).windows.find((w: { uid: string }) => w.uid === asking).askId;
  assert.equal((await http(ah, 'POST', `/api/sessions/${asking}/answer`, { cookie, body: { answer: 'approve', prompt: askId } })).status, 200);
  const again = await http(ah, 'POST', `/api/sessions/${asking}/answer`, { cookie, body: { answer: 'approve', prompt: askId } });
  assert.equal(again.json().code, 'already_answered');
  take('error-code.json', 'error', again.json());
  take('error.json', 'error', (await http(ah, 'POST', '/api/sessions/nope/send', { cookie, body: { text: 'x', id: 'bad id' } })).json());

  const now = [...seen].map(([k, v]) => `${k}: ${[...v].sort().join('|')}`).sort();
  if (process.env.AH_UPDATE_CONTRACT === '1') {
    writeFileSync(MANIFEST, `# Wire shapes clients read (test/contract.test.ts). Every line must keep existing with its\n# type; additions are fine; a type without \`null\` must not turn null. \`null\` alone: present,\n# any type. \`{*}\`: a map's values. Regenerate after an additive change.\n${now.join('\n')}\n`);
    mkdirSync(dirname(`${FIXTURES}x`), { recursive: true });
    for (const [file, value] of samples) writeFileSync(`${FIXTURES}${file}`, `${JSON.stringify(scrub(value, ah), null, 2)}\n`);
    writeFileSync(`${FIXTURES}state-stream.sse`, scrubStream(stream, ah));
  }
  const want = readFileSync(MANIFEST, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const broken: string[] = [];
  for (const line of want) {
    const i = line.lastIndexOf(': ');
    const [path, type] = [line.slice(0, i), new Set(line.slice(i + 2).split('|'))];
    const got = seen.get(path);
    // Paths under an array that was empty this time can't be checked.
    const unseenArray = !got && [...path.matchAll(/\[\]/g)].some((m) => !seen.has(path.slice(0, m.index! + 2)));
    if (unseenArray) continue;
    if (!got) broken.push(`${path}: gone`);
    else if (!(type.size === 1 && type.has('null')) && [...got].some((g) => !type.has(g))) broken.push(`${path}: ${[...type].join('|')} → ${[...got].join('|')}`);
  }
  assert.deepEqual(broken, []);
  // What this scenario has to cover, or the manifest pins less than it claims.
  for (const p of ['GET /api/state.windows[].ask.options[].label', 'GET /api/state.windows[].askId', 'GET /api/sessions/:uid/queue[].id', 'GET /api/sessions/:uid/queue[].named', 'error.code']) assert.ok(seen.has(p), `not covered: ${p}`);
});
