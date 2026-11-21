// packages/protocol is what the app and the server agree on; these keep the server's side of
// it honest without a running host. versions.json is the API version and every feature's
// version, exactly as this server announces them; the fixtures (real answers captured by
// test/contract.test.ts) hold the shapes the manifest pins, no more, no less: the app's tests
// decode them, so a fixture that drifted from the manifest would test the app against a
// server that doesn't exist.
//
// After a deliberate change: AH_UPDATE_CONTRACT=1 node --test --test-concurrency=1 test/contract.test.ts
// test/protocol.test.ts (in that order: the first writes the fixtures), or mise run protocol:update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_VERSION } from '../server/core.ts';
import { FEATURES } from '../server/features.ts';

const PROTOCOL = fileURLToPath(new URL('../../../packages/protocol/', import.meta.url));
const VERSIONS = `${PROTOCOL}versions.json`;
const FIXTURES = `${PROTOCOL}fixtures/`;

/** Which manifest path each fixture is pinned under (contract.test.ts takes them there). */
const PINNED: Record<string, string> = {
  'hello.json': 'GET /api/hello',
  'auth-status.json': 'GET /api/auth/status',
  'state.json': 'GET /api/state',
  'capabilities.json': 'GET /api/capabilities',
  'window-created.json': 'POST /api/windows',
  'send-queued.json': 'POST /api/sessions/:uid/send',
  'send-delivered.json': 'POST /api/sessions/:uid/send',
  'queue.json': 'GET /api/sessions/:uid/queue',
  'error-code.json': 'error',
  'error.json': 'error',
};

/** As in contract.test.ts: every field path with the JSON types seen there. */
const MAPS = [/\.modeCycle\.detect$/];
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

/** Server-sent frames as `{ event, data }`. */
function frames(text: string) {
  return text.split('\n\n').filter((f) => f.trim()).map((f) => ({ event: /^event: (.*)$/m.exec(f)?.[1] ?? 'message', data: JSON.parse(/^data: (.*)$/m.exec(f)?.[1] ?? 'null') }));
}

test('the API version is still the one installed apps accept', () => {
  // Every installed app accepts exactly 28 (HubStateDTO.supportedAPIVersion) and refuses a
  // host that sends anything else: changing it here and in the app together still strands
  // every phone that hasn't updated. New abilities are features (server/features.ts).
  assert.equal(API_VERSION, 28);
});

test('versions.json is the API version and the features this server announces', () => {
  const now = { api: API_VERSION, features: Object.fromEntries(Object.entries(FEATURES).sort(([a], [b]) => a.localeCompare(b))) };
  if (process.env.AH_UPDATE_CONTRACT === '1') writeFileSync(VERSIONS, `${JSON.stringify(now, null, 2)}\n`);
  assert.deepEqual(JSON.parse(readFileSync(VERSIONS, 'utf8')), now, 'regenerate with AH_UPDATE_CONTRACT=1 (and read packages/protocol/README.md first: installed apps accept one API version)');
});

test('the fixtures hold exactly the shapes the manifest pins', () => {
  const files = readdirSync(FIXTURES).sort();
  assert.deepEqual(files, [...Object.keys(PINNED), 'state-stream.sse'].sort(), 'a fixture without a manifest path, or one missing');
  const seen = new Map<string, Set<string>>();
  for (const [file, path] of Object.entries(PINNED)) shape(JSON.parse(readFileSync(`${FIXTURES}${file}`, 'utf8')), path, seen);
  // The stream the app reads (?delta=1): its snapshot is the pinned state frame, then
  // patches with nothing but the state's own fields and the windows' delta.
  const stream = frames(readFileSync(`${FIXTURES}state-stream.sse`, 'utf8'));
  assert.equal(stream[0]?.event, 'state');
  shape(stream[0].data, 'SSE /api/events state', seen);
  const patches = stream.filter((f) => f.event === 'patch');
  assert.ok(patches.some((p) => p.data.windowsDelta), 'the stream fixture has a patch carrying windowsDelta');
  for (const p of patches) for (const k of Object.keys(p.data)) assert.ok(k === 'windowsDelta' || k in stream[0].data, `patch field ${k} isn't in the state`);

  const manifest = new Map(readFileSync(`${PROTOCOL}wire-shapes.txt`, 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
    const i = l.lastIndexOf(': ');
    return [l.slice(0, i), new Set(l.slice(i + 2).split('|'))] as const;
  }));
  const unpinned: string[] = [];
  for (const [path, types] of seen) {
    const want = manifest.get(path);
    if (!want) unpinned.push(`${path}: not in the manifest`);
    else if (!(want.size === 1 && want.has('null')) && [...types].some((t) => !want.has(t))) unpinned.push(`${path}: ${[...types].join('|')}, pinned ${[...want].join('|')}`);
  }
  assert.deepEqual(unpinned, [], 'the fixtures are older or newer than the manifest: regenerate both with AH_UPDATE_CONTRACT=1');
  const missing = [...manifest.keys()].filter((path) => !seen.has(path) && ![...path.matchAll(/\[\]/g)].some((m) => !seen.has(path.slice(0, m.index! + 2))));
  assert.deepEqual(missing, [], 'pinned fields no fixture holds: regenerate the fixtures with AH_UPDATE_CONTRACT=1');
});
