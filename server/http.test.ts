import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { send } from './http.ts';

function get(port: number, path: string, accept?: string): Promise<{ headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: accept ? { 'accept-encoding': accept } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('send compresses JSON over 1 KB for a client that takes it, and only then', async () => {
  const big = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, title: `session ${i}` })) };
  const server = createServer((req, res) => send(res, 200, req.url === '/small' ? { ok: true } : big));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    const br = await get(port, '/', 'gzip, deflate, br');
    assert.equal(br.headers['content-encoding'], 'br');
    assert.equal(br.headers.vary, 'accept-encoding');
    assert.deepEqual(JSON.parse(brotliDecompressSync(br.body).toString()), big);
    const gz = await get(port, '/', 'gzip');
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.deepEqual(JSON.parse(gunzipSync(gz.body).toString()), big);
    const plain = await get(port, '/');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.deepEqual(JSON.parse(plain.body.toString()), big);
    const small = await get(port, '/small', 'br');
    assert.equal(small.headers['content-encoding'], undefined, 'not worth it under 1 KB');
    assert.deepEqual(JSON.parse(small.body.toString()), { ok: true });
  } finally {
    server.close();
  }
});

test('a peer proxy relays a compressed answer whole, not cut at its compressed length', async () => {
  const { proxyHttp } = await import('./peers.ts');
  const big = { items: Array.from({ length: 300 }, (_, i) => ({ id: i, title: `peer session ${i}` })) };
  const peer = createServer((_req, res) => {
    const body = gzipSync(JSON.stringify(big));
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length });
    res.end(body);
  });
  await new Promise<void>((r) => peer.listen(0, '127.0.0.1', r));
  const peerPort = (peer.address() as AddressInfo).port;
  const hub = createServer((req, res) => void proxyHttp({ name: 'p', url: `http://127.0.0.1:${peerPort}`, token: '' } as never, '/api/state', req, res));
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  try {
    const got = await get((hub.address() as AddressInfo).port, '/');
    assert.deepEqual(JSON.parse(got.body.toString()), big);
  } finally {
    peer.close();
    hub.close();
  }
});
