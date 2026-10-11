import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { Previews, downstreamHeaders, staleMappings, stripCookies, upstreamHeaders } from './preview.ts';

/** A stand-in dev server that echoes what it was sent, with headers a real one might set. */
async function devServer() {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', "default-src 'self'; frame-ancestors 'none'");
    res.setHeader('set-cookie', ['__Host-ah_session=stolen; Path=/; Secure', 'sb-theme=dark; Path=/']);
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, req) => ws.send(JSON.stringify({ hmr: true, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie ?? null })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { port: (server.address() as AddressInfo).port, seen, close: () => new Promise<void>((r) => { wss.close(); server.closeAllConnections(); server.close(() => r()); }) };
}

function get(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: IncomingMessage['headers']; body: string }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function setup(opts: { signedIn?: boolean } = {}) {
  const published: string[] = [];
  const previews = new Previews({
    authorize: (req) => (opts.signedIn === false || !/ah_session=good/.test(req.headers.cookie ?? '') ? { status: 401, reason: 'sign in required' } : null),
    frameAncestors: () => ['https://box.test.ts.net', 'http://localhost:7681'],
    publish: { add: async (p) => void published.push(`+${p}`), remove: async (p) => void published.push(`-${p}`) },
    range: [47600, 47640],
  });
  return { previews, published };
}

test('upstream requests lose ah’s cookie and Tailscale identity, and look local', () => {
  const h = upstreamHeaders({ host: 'box.test.ts.net:47600', cookie: '__Host-ah_session=secret; sb=1; ah_session=x', 'tailscale-user-login': 'me@example.com', origin: 'https://box.test.ts.net:47600', referer: 'https://box.test.ts.net:47600/iframe.html?id=a', accept: '*/*' }, 6006);
  assert.equal(h.host, 'localhost:6006');
  assert.equal(h.cookie, 'sb=1');
  assert.equal(h['tailscale-user-login'], undefined);
  assert.equal(h.origin, 'http://localhost:6006');
  assert.equal(h.referer, 'http://localhost:6006/iframe.html?id=a');
  assert.equal(h.accept, '*/*');
  assert.equal(upstreamHeaders({ cookie: 'ah_session=x' }, 1).cookie, undefined, 'no empty cookie header');
  assert.equal(stripCookies('a=1;  __Host-ah_session=s ;b=2'), 'a=1; b=2');
});

test('responses are framable by ah only and can’t set ah’s cookie', () => {
  const h = downstreamHeaders({ 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'set-cookie': ['ah_session=x; Path=/', 'theme=dark'] }, ['https://box.test.ts.net']);
  assert.equal(h['x-frame-options'], undefined);
  assert.equal(h['content-security-policy'], "default-src 'self'; frame-ancestors https://box.test.ts.net");
  assert.deepEqual(h['set-cookie'], ['theme=dark']);
  assert.equal(downstreamHeaders({}, ['https://a'])['content-security-policy'], 'frame-ancestors https://a');
});

test('a preview proxies its dev server for a signed-in browser, and nobody else', async () => {
  const dev = await devServer();
  const { previews, published } = setup();
  try {
    const p = await previews.start('u1', dev.port);
    assert.ok(p.port >= 47600 && p.port <= 47640);
    assert.deepEqual(published, [`+${p.port}`]);

    const anon = await get(p.port, '/');
    assert.equal(anon.status, 401);
    assert.match(anon.body, /Sign in to ah first/);
    assert.equal(dev.seen.length, 0, 'an anonymous request never reaches the dev server');

    const ok = await get(p.port, '/iframe.html?id=button', { cookie: 'ah_session=good; sb=1' });
    assert.equal(ok.status, 200);
    const echoed = JSON.parse(ok.body);
    assert.equal(echoed.url, '/iframe.html?id=button');
    assert.equal(echoed.headers.host, `localhost:${dev.port}`);
    assert.equal(echoed.headers.cookie, 'sb=1', 'the dev server never sees the ah cookie');
    assert.equal(ok.headers['x-frame-options'], undefined);
    assert.equal(ok.headers['content-security-policy'], "default-src 'self'; frame-ancestors https://box.test.ts.net http://localhost:7681");
    assert.deepEqual(ok.headers['set-cookie'], ['sb-theme=dark; Path=/']);
  } finally {
    await previews.stopAll();
    await dev.close();
  }
});

test('live reload: the WebSocket goes through, rewritten, and only when signed in', async () => {
  const dev = await devServer();
  const { previews } = setup();
  try {
    const p = await previews.start('u1', dev.port);
    const open = (cookie?: string) =>
      new Promise<{ msg?: any; status?: number }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${p.port}/storybook-server-channel`, { headers: { host: `localhost:${p.port}`, ...(cookie ? { cookie } : {}) }, origin: `http://localhost:${p.port}` });
        ws.on('message', (d) => {
          resolve({ msg: JSON.parse(d.toString()) });
          ws.close();
        });
        ws.on('unexpected-response', (_q, res) => resolve({ status: res.statusCode }));
        ws.on('error', () => resolve({}));
      });
    assert.equal((await open()).status, 401);
    const { msg } = await open('ah_session=good; sb=1');
    assert.deepEqual(msg, { hmr: true, host: `localhost:${dev.port}`, origin: `http://localhost:${dev.port}`, cookie: 'sb=1' });
  } finally {
    await previews.stopAll();
    await dev.close();
  }
});

test('nothing listening yet answers a page that says so; one preview per session keeps its port', async () => {
  const { previews, published } = setup();
  try {
    const p = await previews.start('u1', 1); // nothing listens on port 1
    const res = await get(p.port, '/', { cookie: 'ah_session=good' });
    assert.equal(res.status, 502);
    assert.match(res.body, /Nothing on port 1 yet/);
    const again = await previews.start('u1', 2);
    assert.equal(again.port, p.port, 'pointing the preview elsewhere keeps its URL');
    assert.equal(again.target, 2);
    const other = await previews.start('u2', 3);
    assert.notEqual(other.port, p.port, 'another session gets its own');
    await assert.rejects(previews.start('u3', other.port), /preview itself/);
    await previews.stop('u1');
    assert.equal(previews.get('u1'), null);
    assert.deepEqual(published, [`+${p.port}`, `+${other.port}`, `-${p.port}`]);
  } finally {
    await previews.stopAll();
  }
});

test('only preview mappings ah made are cleaned up after a crash', () => {
  const status = {
    Web: {
      'box.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:7681' } } },
      'box.ts.net:47601': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47601' } } },
      'box.ts.net:47602': { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } },
      'box.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8443' } } },
    },
  };
  assert.deepEqual(staleMappings(status, [47600, 47699]), [47601]);
  assert.deepEqual(staleMappings(null, [1, 2]), []);
});
