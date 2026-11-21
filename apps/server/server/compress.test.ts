import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { encoded, pickEncoding } from './compress.ts';

test('picks brotli, then gzip, and honours a refusal', () => {
  assert.equal(pickEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip'), 'gzip');
  assert.equal(pickEncoding('*'), 'br');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(undefined), null);
});

test('compresses text once per content and leaves fonts and small files alone', async () => {
  const js = Buffer.from('export const x = 1;\n'.repeat(500));
  const a = await encoded('/dist/assets/a.js', js, 'text/javascript', 'gzip, br');
  assert.equal(a.encoding, 'br');
  assert.ok(a.body.length < js.length / 10);
  assert.deepEqual(brotliDecompressSync(a.body), js);
  assert.equal((await encoded('/dist/assets/a.js', js, 'text/javascript', 'gzip, br')).body, a.body, 'kept, not redone');

  const g = await encoded('/dist/assets/a.js', js, 'text/javascript', 'gzip');
  assert.deepEqual(gunzipSync(g.body), js);

  // A rebuild changes the bytes behind the same name.
  const next = Buffer.from('export const y = 2;\n'.repeat(500));
  assert.deepEqual(brotliDecompressSync((await encoded('/dist/assets/a.js', next, 'text/javascript', 'br')).body), next);

  const font = Buffer.alloc(4096, 7);
  assert.equal((await encoded('/dist/assets/f.woff2', font, 'font/woff2', 'br')).encoding, null);
  assert.equal((await encoded('/dist/index.html', Buffer.from('<p>hi</p>'), 'text/html; charset=utf-8', 'br')).encoding, null);
});
