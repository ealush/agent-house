// The wire shapes ah-native and the web client read, pinned (docs/spec/wire-shapes.txt).
// A running host answers; every field the manifest lists must still be there with the
// same type. Fields may be added (clients ignore what they don't know), never removed
// or retyped without a feature version (server/features.ts). A field seen only as null
// is listed as `null`: it must exist, of any type.
//
// After a deliberate, additive change: AH_UPDATE_CONTRACT=1 node --test test/contract.test.ts
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

const MANIFEST = fileURLToPath(new URL('../docs/spec/wire-shapes.txt', import.meta.url));

/** Every field path with its JSON type; an array's elements merged into `[]`. */
function shape(v: unknown, path: string, out: Map<string, string>) {
  const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  const prev = out.get(path);
  out.set(path, prev && prev !== t ? (prev === 'null' ? t : t === 'null' ? prev : `${prev}|${t}`) : t);
  if (Array.isArray(v)) for (const x of v) shape(x, `${path}[]`, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) shape(x, `${path}.${k}`, out);
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
  ah = await startAh();
  cookie = await signIn(ah);
});
after(() => cleanup(ah));

test('the shapes clients read are still all there', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'contract' } });
  assert.equal(created.status, 201, created.body);
  const { uid } = created.json();
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie })).json().windows.some((w: { uid: string }) => w.uid === uid), 8000, 'session in state');

  const seen = new Map<string, string>();
  shape(created.json(), 'POST /api/windows', seen);
  shape((await http(ah, 'GET', '/api/hello')).json(), 'GET /api/hello', seen);
  shape((await http(ah, 'GET', '/api/auth/status', { cookie })).json(), 'GET /api/auth/status', seen);
  shape((await http(ah, 'GET', '/api/state', { cookie })).json(), 'GET /api/state', seen);
  shape((await http(ah, 'GET', '/api/capabilities', { cookie })).json(), 'GET /api/capabilities', seen);
  shape((await http(ah, 'POST', `/api/sessions/${uid}/send`, { cookie, body: { text: 'true' } })).json(), 'POST /api/sessions/:uid/send', seen);
  shape((await http(ah, 'GET', `/api/sessions/${uid}/queue`, { cookie })).json(), 'GET /api/sessions/:uid/queue', seen);
  const first = await firstEvent(ah, '/api/events', cookie);
  assert.equal(first.event, 'state');
  shape(first.data, 'SSE /api/events state', seen);
  // A refusal: the error body every client reads.
  shape((await http(ah, 'GET', '/api/sessions/nope/queue/x', { cookie })).json(), 'error', seen);
  shape((await http(ah, 'POST', '/api/sessions/nope/send', { cookie, body: { text: 'x', id: 'bad id' } })).json(), 'error', seen);

  const now = [...seen].map(([k, v]) => `${k}: ${v}`).sort();
  if (process.env.AH_UPDATE_CONTRACT === '1') {
    writeFileSync(MANIFEST, `# Wire shapes clients read (test/contract.test.ts). Every line must keep existing with its\n# type; additions are fine. \`null\`: present, any type. Regenerate after an additive change.\n${now.join('\n')}\n`);
  }
  const want = readFileSync(MANIFEST, 'utf8').split('\n').filter((l) => l && !l.startsWith('#'));
  const missing: string[] = [];
  for (const line of want) {
    const i = line.lastIndexOf(': ');
    const [path, type] = [line.slice(0, i), line.slice(i + 2)];
    const got = seen.get(path);
    // Paths under an array that was empty this time can't be checked.
    const unseenArray = !got && [...path.matchAll(/\[\]/g)].some((m) => !seen.has(path.slice(0, m.index! + 2)));
    if (unseenArray) continue;
    if (got === undefined) missing.push(`${path}: gone`);
    else if (type !== 'null' && !got.split('|').every((g) => g === 'null' || type.split('|').includes(g))) missing.push(`${path}: ${type} → ${got}`);
  }
  assert.deepEqual(missing, []);
});
