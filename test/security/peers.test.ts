// Multi-host proxying: the hub must only ever hand a peer its own token, never the
// browser's cookie, and never let a peer bounce that token somewhere else.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startAh, cleanup, http, signIn, until, type Ah } from '../helpers.ts';

let peer: Ah;
let hub: Ah;
let evil: Server;
let fake: Server;
const evilSaw: string[] = [];
const peerSaw: Array<{ cookie?: string; auth?: string }> = [];

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

before(async () => {
  peer = await startAh();
  const token = (await http(peer, 'POST', '/api/auth/tokens', { token: peer.localToken(), body: { name: 'hub' } })).json().token;

  // A server that records any credential it receives.
  evil = createServer((req, res) => {
    evilSaw.push(String(req.headers.authorization ?? '') + String(req.headers.cookie ?? ''));
    res.end('{}');
  });
  const evilPort = await listen(evil);
  // A malicious "peer": answers hello like ah, then redirects real requests to evil.
  fake = createServer((req, res) => {
    peerSaw.push({ cookie: req.headers.cookie, auth: req.headers.authorization });
    if (req.url === '/api/hello') return res.end(JSON.stringify({ ah: true }));
    res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/steal` });
    res.end();
  });
  const fakePort = await listen(fake);

  hub = await startAh({
    peers: [
      { name: 'peer', url: `http://127.0.0.1:${peer.port}`, token },
      { name: 'fake', url: `http://127.0.0.1:${fakePort}`, token: 'token-for-fake' },
      { name: 'lan', url: 'http://10.0.0.1:7681', token: 'should-never-be-used' },
    ],
  });
});
after(async () => {
  await cleanup(hub);
  await cleanup(peer);
  evil.close();
  fake.close();
});

const online = async (name: string) => (await http(hub, 'GET', '/api/state', { token: hub.localToken() })).json().hosts.find((h: any) => h.name === name)?.online;

test('the hub reaches a peer with the peer-issued token, and only for signed-in callers', async () => {
  await until(() => online('peer'), 10_000, 'peer online');
  const cookie = await signIn(hub);
  assert.equal((await http(hub, 'GET', '/h/peer/api/state', { cookie })).status, 200);
  assert.equal((await http(hub, 'GET', '/h/peer/api/state')).status, 401, 'anonymous at the hub');
});

test("the browser's hub cookie is never forwarded to a peer", async () => {
  await until(() => online('fake'), 10_000, 'fake online');
  const cookie = await signIn(hub);
  peerSaw.length = 0;
  await http(hub, 'GET', '/h/fake/api/state', { cookie });
  assert.ok(peerSaw.length > 0);
  for (const r of peerSaw) {
    assert.equal(r.cookie, undefined, 'cookie leaked to peer');
    assert.equal(r.auth, 'Bearer token-for-fake');
  }
});

test("a peer's redirect is passed back, not followed (the token must not travel)", async () => {
  const cookie = await signIn(hub);
  evilSaw.length = 0;
  const res = await http(hub, 'GET', '/h/fake/api/state', { cookie });
  assert.equal(res.status, 302);
  assert.deepEqual(evilSaw, [], 'credentials reached the redirect target');
});

test('plain-http peers off loopback are never contacted', async () => {
  await new Promise((r) => setTimeout(r, 1000));
  assert.ok(!(await online('lan')));
  const cookie = await signIn(hub);
  assert.equal((await http(hub, 'GET', '/h/lan/api/state', { cookie })).status, 502);
});

test("revoking the peer's token cuts the hub off, even with a valid hub session", async () => {
  const cookie = await signIn(hub);
  const tokens = (await http(peer, 'GET', '/api/auth/overview', { token: peer.localToken() })).json().tokens;
  await http(peer, 'DELETE', `/api/auth/tokens/${tokens[0].id}`, { token: peer.localToken() });
  assert.equal((await http(hub, 'GET', '/h/peer/api/state', { cookie })).status, 401);
});
