// Backend reliability: session creation under concurrent requests from different
// clients, and uploads streamed to disk with explicit limits (black box).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startAh, cleanup, http, until, sleep, type Ah } from './helpers.ts';

const uploads = (ah: Ah) => join(ah.dir, 'cache', 'ah', 'uploads');
const rssKb = (pid: number) => Number(readFileSync(`/proc/${pid}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)![1]);

/**
 * Streams `total` bytes to a route without ever holding them: `chunked` leaves out
 * Content-Length; `stopAfter` hangs up (or `stall`s) after that many bytes.
 */
function upload(ah: Ah, path: string, total: number, o: { chunked?: boolean; stopAfter?: number; stall?: boolean } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `localhost:${ah.port}`, origin: `http://localhost:${ah.port}`, 'x-ah': '1', 'content-type': 'application/octet-stream' };
    if (!o.chunked) headers['content-length'] = String(total);
    const req = request({ host: '127.0.0.1', port: ah.port, method: 'POST', path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (err) => (o.stopAfter !== undefined ? resolve({ status: 0, body: String(err) }) : reject(err)));
    const chunk = Buffer.alloc(1 << 20, 0x61);
    let sent = 0;
    const pump = () => {
      while (sent < total) {
        if (o.stopAfter !== undefined && sent >= o.stopAfter) {
          if (o.stall) return; // keep the connection open, send nothing more
          req.destroy();
          return resolve({ status: 0, body: 'hung up' });
        }
        const n = Math.min(chunk.length, total - sent);
        sent += n;
        if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return void req.once('drain', pump);
      }
      req.end();
    };
    pump();
  });
}

const leftovers = (dir: string) => readdirSync(dir).filter((n) => n.includes('.part-'));

test('concurrent session creation from different clients never collides on the tmux session', async () => {
  const ah = await startAh({ auth: { mode: 'off' } });
  try {
    // Ten clients at once, into a session that doesn't exist yet: each must get its own window.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files`, session: 'race', label: `r${i}` } })),
    );
    for (const r of results) assert.equal(r.status, 201, r.body);
    const created = results.map((r) => r.json());
    assert.equal(new Set(created.map((c) => c.uid)).size, 10, 'every session has its own uid');
    assert.equal(new Set(created.map((c) => c.id)).size, 10, 'every session has its own window');
    const windows = ah.tmux('list-windows', '-t', '=race', '-F', '#{window_id}').trim().split('\n');
    for (const c of created) assert.ok(windows.includes(c.id), `${c.id} is in the race session`);
    const state = (await http(ah, 'GET', '/api/state')).json();
    const orders = state.windows.filter((w: any) => created.some((c) => c.uid === w.uid)).map((w: any) => w.order);
    assert.equal(new Set(orders).size, 10, `each new session gets its own sidebar place: ${orders}`);
  } finally {
    await cleanup(ah);
  }
});

test('an upload far past the old 50 MB cap streams to disk without growing the server', async () => {
  const ah = await startAh({ auth: { mode: 'off' } });
  try {
    // Warm up first (the first state pass allocates), then measure across the upload.
    for (let i = 0; i < 3; i++) await http(ah, 'GET', '/api/state');
    const before = rssKb(ah.proc.pid!);
    const total = 256 * 1024 * 1024;
    const res = await upload(ah, '/api/upload?name=recording.mov', total);
    assert.equal(res.status, 201, res.body);
    const { path, bytes } = JSON.parse(res.body);
    assert.equal(bytes, total);
    assert.equal(statSync(path).size, total);
    assert.equal(statSync(path).mode & 0o777, 0o600, 'owner-only');
    assert.ok(path.startsWith(uploads(ah)), path);
    const grew = (rssKb(ah.proc.pid!) - before) / 1024;
    // Buffering would add the whole upload (256 MB and more); streaming adds a few
    // chunks plus whatever the heap does meanwhile, which a busy machine makes noisy.
    assert.ok(grew < (total >> 20) * 0.35, `server memory grew ${grew.toFixed(1)} MB for a ${total >> 20} MB upload`);
    assert.deepEqual(leftovers(uploads(ah)), []);
  } finally {
    await cleanup(ah);
  }
});

test('oversized, interrupted, stalled and over-quota uploads are refused and leave nothing behind', async () => {
  const MB = 1024 * 1024;
  const ah = await startAh({ auth: { mode: 'off' }, uploads: { maxBytes: 4 * MB, maxTotalBytes: 6 * MB, idleMs: 800 } });
  try {
    const dir = uploads(ah);
    mkdirSync(dir, { recursive: true });
    const caps = (await http(ah, 'GET', '/api/capabilities')).json();
    assert.equal(caps.uploads.maxBytes, 4 * MB);
    assert.equal(caps.features.uploads, 2);

    // Declared too large: refused before a byte is read, with a code to branch on.
    const big = await upload(ah, '/api/upload?name=big.bin', 5 * MB);
    assert.equal(big.status, 413, big.body);
    assert.equal(JSON.parse(big.body).code, 'upload_too_large');

    // Chunked (no length): refused once it passes the limit, mid-stream.
    const chunked = await upload(ah, '/api/upload?name=chunked.bin', 5 * MB, { chunked: true });
    assert.ok(chunked.status === 413 || chunked.status === 0, `${chunked.status} ${chunked.body}`);

    // A client that hangs up halfway, and one that stops sending.
    await upload(ah, '/api/upload?name=cut.bin', 3 * MB, { stopAfter: MB });
    await upload(ah, '/api/upload?name=stall.bin', 3 * MB, { stopAfter: MB, stall: true }).catch(() => null);
    await until(() => leftovers(dir).length === 0 && readdirSync(dir).length === 0, 8000, `no part files (have ${readdirSync(dir)})`);

    // The folder quota counts what's already there.
    writeFileSync(join(dir, 'old.bin'), Buffer.alloc(3 * MB));
    const over = await upload(ah, '/api/upload?name=more.bin', 4 * MB);
    assert.equal(over.status, 507, over.body);
    assert.equal(JSON.parse(over.body).code, 'upload_quota');

    // Names can't climb out of the upload folder.
    const sneaky = await upload(ah, `/api/upload?name=${encodeURIComponent('../../../evil.sh')}`, 10);
    assert.equal(sneaky.status, 201, sneaky.body);
    assert.ok(JSON.parse(sneaky.body).path.startsWith(dir + '/'), sneaky.body);
    assert.deepEqual(leftovers(dir), []);

    // Files uploads stream with the same per-file limit, and stay inside the roots.
    const files = `${ah.dir}/files`;
    const fsBig = await upload(ah, `/api/fs/upload?dir=${encodeURIComponent(files)}&name=x.bin`, 5 * MB);
    assert.equal(fsBig.status, 413, fsBig.body);
    const fsOk = await upload(ah, `/api/fs/upload?dir=${encodeURIComponent(files)}&name=x.bin`, 2 * MB);
    assert.equal(fsOk.status, 201, fsOk.body);
    const fsTwice = await upload(ah, `/api/fs/upload?dir=${encodeURIComponent(files)}&name=x.bin`, 10);
    assert.match(JSON.parse(fsTwice.body).path, /x \(1\)\.bin$/);
    const outside = await upload(ah, `/api/fs/upload?dir=${encodeURIComponent('/etc')}&name=x.bin`, 10);
    assert.equal(outside.status, 403, outside.body);
    assert.deepEqual(leftovers(files), []);
    await sleep(50);
  } finally {
    await cleanup(ah);
  }
});
