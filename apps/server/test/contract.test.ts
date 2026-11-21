// The wire shapes ah-native and the web client read, pinned (docs/spec/wire-shapes.txt).
// A running host answers; every field the manifest lists must still be there with the
// same type. Fields may be added (clients ignore what they don't know), never removed,
// retyped, or made nullable without a feature version (server/features.ts): the native
// app decodes non-optional fields strictly, so a field that turns null breaks the whole
// state for it. A field only ever seen null is listed as `null`: it must exist, of any
// type. Maps keyed by data (a preset's mode ids) are pinned as `{*}`, not key by key.
//
// After a deliberate, additive change: AH_UPDATE_CONTRACT=1 node --test test/contract.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PRESETS } from '../server/config.ts';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

const MANIFEST = fileURLToPath(new URL('../../../docs/spec/wire-shapes.txt', import.meta.url));
const PICKER = fileURLToPath(new URL('./fixtures/picker.js', import.meta.url));

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
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'contract' } });
  assert.equal(created.status, 201, created.body);
  const { uid } = created.json();
  shape(created.json(), 'POST /api/windows', seen);
  const asking = (await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'test-asker', cwd: `${ah.dir}/files` } })).json().uid;
  const state = async () => (await http(ah, 'GET', '/api/state', { cookie })).json();
  await until(async () => {
    const s = await state();
    return s.windows.some((w: { uid: string }) => w.uid === uid) && s.windows.find((w: { uid: string }) => w.uid === asking)?.ask?.options?.length;
  }, 15000, 'a shell, and an agent asking permission');
  // A message for the asking agent waits behind its picker: a queue with an item in it.
  shape((await http(ah, 'POST', `/api/sessions/${asking}/send`, { cookie, body: { text: 'after that, run the tests', id: 'contract-1' } })).json(), 'POST /api/sessions/:uid/send', seen);
  shape((await http(ah, 'GET', `/api/sessions/${asking}/queue`, { cookie })).json(), 'GET /api/sessions/:uid/queue', seen);
  shape((await http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text: 'true' } })).json(), 'POST /api/sessions/:uid/send', seen);

  shape((await http(ah, 'GET', '/api/hello')).json(), 'GET /api/hello', seen);
  shape((await http(ah, 'GET', '/api/auth/status', { cookie })).json(), 'GET /api/auth/status', seen);
  shape(await state(), 'GET /api/state', seen);
  shape((await http(ah, 'GET', '/api/capabilities', { cookie })).json(), 'GET /api/capabilities', seen);
  const first = await firstEvent(ah, '/api/events', cookie);
  assert.equal(first.event, 'state');
  shape(first.data, 'SSE /api/events state', seen);
  // Refusals: the error body every client reads, with and without a code.
  const askId = (await state()).windows.find((w: { uid: string }) => w.uid === asking).askId;
  assert.equal((await http(ah, 'POST', `/api/sessions/${asking}/answer`, { cookie, body: { answer: 'approve', prompt: askId } })).status, 200);
  const again = await http(ah, 'POST', `/api/sessions/${asking}/answer`, { cookie, body: { answer: 'approve', prompt: askId } });
  assert.equal(again.json().code, 'already_answered');
  shape(again.json(), 'error', seen);
  shape((await http(ah, 'POST', '/api/sessions/nope/send', { cookie, body: { text: 'x', id: 'bad id' } })).json(), 'error', seen);

  const now = [...seen].map(([k, v]) => `${k}: ${[...v].sort().join('|')}`).sort();
  if (process.env.AH_UPDATE_CONTRACT === '1') {
    writeFileSync(MANIFEST, `# Wire shapes clients read (test/contract.test.ts). Every line must keep existing with its\n# type; additions are fine; a type without \`null\` must not turn null. \`null\` alone: present,\n# any type. \`{*}\`: a map's values. Regenerate after an additive change.\n${now.join('\n')}\n`);
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
