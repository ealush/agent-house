// Terminal WebSockets are the most direct path to a shell; attack them directly.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startAh, cleanup, http, signIn, until, OWNER, TAILNET_DNS, type Ah } from '../helpers.ts';

let ah: Ah;
let cookie: string;
let windowId: string;

before(async () => {
  ah = await startAh();
  cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'ws-target' } });
  assert.equal(res.status, 201, res.body);
  windowId = res.json().id;
});
after(() => cleanup(ah));

type Outcome = { opened: boolean; status?: number; close?: number; data: string };

function connect(opts: { path?: string; origin?: string | null; cookie?: string; host?: string; headers?: Record<string, string> } = {}): Promise<{ ws: WebSocket; result: Promise<Outcome> }> {
  const path = opts.path ?? `/ws/${encodeURIComponent(windowId)}?cols=80&rows=24`;
  const headers: Record<string, string> = { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers };
  // A browser calls back to the host its page came from, so Host and Origin agree.
  headers.host = opts.host ?? `localhost:${ah.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${ah.port}${path}`, {
    headers,
    ...(opts.origin === null ? {} : { origin: opts.origin ?? `http://localhost:${ah.port}` }),
  });
  const out: Outcome = { opened: false, data: '' };
  const result = new Promise<Outcome>((resolve) => {
    ws.on('open', () => (out.opened = true));
    ws.on('message', (d) => (out.data += d.toString()));
    ws.on('unexpected-response', (_req, res) => {
      out.status = res.statusCode;
      resolve(out);
    });
    ws.on('close', (code) => {
      out.close = code;
      resolve(out);
    });
    ws.on('error', () => resolve(out));
  });
  return Promise.resolve({ ws, result });
}

test('handshake is refused without a session, from a foreign origin, or a bad host', async () => {
  const cases: Array<[string, Parameters<typeof connect>[0], number]> = [
    ['anonymous', {}, 401],
    ['forged cookie', { cookie: 'ah_session=forged' }, 401],
    ['foreign origin', { cookie: '', origin: 'https://evil.example' }, 403],
    ['no origin', { origin: null }, 403],
    ['bad host', { host: 'evil.example' }, 421],
    ['serve host, no identity', { host: TAILNET_DNS, origin: `https://${TAILNET_DNS}` }, 403],
    ['serve host, wrong identity', { host: TAILNET_DNS, origin: `https://${TAILNET_DNS}`, headers: { 'tailscale-user-login': 'mallory@example.com' } }, 403],
    // A page on another port of our own name (a dev server, a preview) is another site.
    ['our name, another port (Serve)', { cookie: '', host: TAILNET_DNS, origin: `https://${TAILNET_DNS}:6006`, headers: { 'tailscale-user-login': OWNER } }, 403],
    ['localhost, another port', { cookie: '', origin: 'http://localhost:6006' }, 403],
    ['loopback, other name', { cookie: '', origin: `http://127.0.0.1:${ah.port}` }, 403],
  ];
  for (const [what, opts, status] of cases) {
    const c = await connect({ cookie: opts.cookie === '' ? cookie : opts.cookie, ...opts, ...(opts.cookie === '' ? { cookie } : {}) });
    const r = await c.result;
    assert.equal(r.opened, false, `${what}: must not open`);
    assert.equal(r.status, status, `${what}: status`);
  }
});

test('the owner through Serve, and a signed-in browser, get a working terminal', async () => {
  for (const opts of [{ cookie }, { cookie, host: TAILNET_DNS, origin: `https://${TAILNET_DNS}`, headers: { 'tailscale-user-login': OWNER } }]) {
    const { ws, result } = await connect(opts);
    await until(() => ws.readyState === WebSocket.OPEN, 5000, 'open');
    ws.send(JSON.stringify({ t: 'i', d: 'echo ws-$((6*7))-ok\r' }));
    await until(async () => (await http(ah, 'GET', `/api/windows/${encodeURIComponent(windowId)}/capture`, { cookie })).body.includes('ws-42-ok'), 5000, 'echo');
    ws.close();
    await result;
  }
});

test('unknown windows close with 4404; malformed paths are rejected', async () => {
  const gone = await (await connect({ cookie, path: '/ws/%409999?cols=80&rows=24' })).result;
  assert.equal(gone.close, 4404);
  for (const path of ['/ws/notawindow', '/ws/@1/../../etc', '/wsx/@1']) {
    const r = await (await connect({ cookie, path })).result;
    assert.equal(r.opened, false, path);
    assert.equal(r.status, 404, path);
  }
});

test('oversized frames close the socket instead of reaching tmux', async () => {
  const { ws, result } = await connect({ cookie });
  await until(() => ws.readyState === WebSocket.OPEN, 5000, 'open');
  ws.send(JSON.stringify({ t: 'i', d: 'x'.repeat(2 * 1024 * 1024) }));
  assert.equal((await result).close, 1009);
  // Regression: this used to crash the whole server (unhandled 'error' event).
  assert.equal(ah.proc.exitCode, null, 'server must survive');
  assert.equal((await http(ah, 'GET', '/api/hello')).status, 200);
});

test('revoking the session cuts its open terminals (4401)', async () => {
  const victim = await signIn(ah, 'victim');
  const { ws, result } = await connect({ cookie: victim });
  await until(() => ws.readyState === WebSocket.OPEN, 5000, 'open');
  const sessions = (await http(ah, 'GET', '/api/auth/overview', { token: ah.localToken() })).json().sessions;
  const id = sessions.find((s: any) => s.label === 'victim').id;
  await http(ah, 'DELETE', `/api/auth/sessions/${id}`, { token: ah.localToken() });
  assert.equal((await result).close, 4401);
});
