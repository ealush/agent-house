// The product's core promise: tmux owns the processes. Viewers come and go, ah can
// crash or restart, and the real sessions don't notice.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startAh, cleanup, http, signIn, until, sleep, type Ah } from './helpers.ts';

let ah: Ah;
let cookie: string;

before(async () => {
  ah = await startAh();
  cookie = await signIn(ah);
});
after(() => cleanup(ah));

function viewer(windowId: string, cols = 80, rows = 24) {
  const ws = new WebSocket(`ws://127.0.0.1:${ah.port}/ws/${encodeURIComponent(windowId)}?cols=${cols}&rows=${rows}&device=Test`, { headers: { cookie }, origin: `http://localhost:${ah.port}` });
  let data = '';
  ws.on('message', (d) => (data += d.toString()));
  ws.on('error', () => {});
  return { ws, seen: () => data, opened: until(() => ws.readyState === WebSocket.OPEN, 5000, 'viewer open') };
}

const viewerSessions = () =>
  ah
    .tmux('list-sessions', '-F', '#{session_name}')
    .split('\n')
    .filter((s) => s.startsWith('ah-v-'));

test('create, attach two viewers, type, resize, detach, SIGKILL ah, restart: the session survives', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'durable' } });
  assert.equal(created.status, 201, created.body);
  const { id, uid } = created.json();

  // Two devices on the same window, independently.
  const a = viewer(id, 100, 30);
  const b = viewer(id, 60, 20);
  await a.opened;
  await b.opened;
  await until(() => viewerSessions().length === 2, 5000, 'two viewer sessions');
  // Presence shows up on the next state tick.
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie })).json().windows.find((w: any) => w.id === id)?.devices.length === 2, 5000, 'presence');

  a.ws.send(JSON.stringify({ t: 'i', d: 'echo marker-$((40+2))\r' }));
  await until(() => a.seen().includes('marker-42') && b.seen().includes('marker-42'), 5000, 'both viewers see output');

  // Resize from the most recent typist; tmux follows (window-size latest).
  b.ws.send(JSON.stringify({ t: 'r', c: 70, r: 22 }));
  b.ws.send(JSON.stringify({ t: 'i', d: '\r' }));
  await until(() => ah.tmux('display', '-p', '-t', id, '#{window_width}').trim() === '70', 5000, 'resize');

  // A device leaving removes only its throwaway viewer session.
  a.ws.close();
  await until(() => viewerSessions().length === 1, 5000, 'viewer A reaped');

  // ah dies hard. The window and its shell live on; orphaned viewers go away with their PTYs.
  const pid = ah.tmux('display', '-p', '-t', id, '#{pane_pid}').trim();
  await ah.stop('SIGKILL');
  await sleep(300);
  assert.equal(ah.tmux('display', '-p', '-t', id, '#{pane_pid}').trim(), pid, 'same shell process');
  await until(() => viewerSessions().length === 0, 5000, 'viewers reaped after crash');

  // Restarted, ah rediscovers everything from tmux and its registry.
  ah = await ah.restart();
  const after = (await http(ah, 'GET', '/api/state', { cookie })).json();
  const w = after.windows.find((w: any) => w.id === id);
  assert.ok(w, 'window rediscovered');
  assert.equal(w.uid, uid, 'same registry identity');
  assert.match(ah.tmux('capture-pane', '-p', '-t', id), /marker-42/, 'scrollback intact');
});

test('killing a session ends it in the registry; resume brings it back with the same id', async () => {
  const { id, uid } = (await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'phoenix' } })).json();
  assert.equal((await http(ah, 'DELETE', `/api/windows/${encodeURIComponent(id)}`, { cookie })).status, 200);
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie })).json().history.some((h: any) => h.ref === uid), 8000, 'ended in history');
  const resumed = await http(ah, 'POST', `/api/sessions/${uid}/resume`, { cookie, body: {} });
  assert.equal(resumed.status, 201, resumed.body);
  assert.equal(resumed.json().uid, uid);
});

test('concurrent resumes create one window with the original identity', async () => {
  const { id, uid } = (await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'one-resume' } })).json();
  await http(ah, 'DELETE', `/api/windows/${encodeURIComponent(id)}`, { cookie });
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie })).json().history.some((h: any) => h.ref === uid), 8000, 'ended');
  const results = await Promise.all(Array.from({ length: 4 }, () => http(ah, 'POST', `/api/sessions/${uid}/resume`, { cookie, body: {} })));
  for (const result of results) assert.ok(result.status === 200 || result.status === 201, result.body);
  assert.equal(new Set(results.map((r) => r.json().id)).size, 1);
  await until(async () => (await http(ah, 'GET', '/api/state', { cookie })).json().windows.filter((w: any) => w.uid === uid).length === 1, 5000, 'one window');
});

test('concurrent shell sends keep each paste and Enter together', async () => {
  const { id, uid } = (await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'serial-input' } })).json();
  const results = await Promise.all(['first', 'second'].map((marker) => http(ah, 'POST', `/api/sessions/${uid}/send`, {
    cookie, body: { text: `echo ${marker}-$(printf isolated)`, enter: true },
  })));
  for (const result of results) assert.equal(result.status, 200, result.body);
  await until(() => {
    const lines = ah.tmux('capture-pane', '-p', '-t', id).split('\n');
    return lines.includes('first-isolated') && lines.includes('second-isolated');
  }, 5000, 'two separately executed commands');
});
