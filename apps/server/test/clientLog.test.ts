// This device's developer log (web/clientLog.ts): what's kept, the bundle's time window,
// and what a request or a message leaves in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asJsonl, kept, KEEP_MS, lastMinutes, messageDetail, redactedUrl, TEXT_KEEP, within, type ClientEntry } from '../web/clientLog.ts';

const at = (t: number, kind = 'request'): ClientEntry => ({ at: new Date(t).toISOString(), kind });
const NOW = Date.parse('2026-11-22T12:00:00Z');

test('three days are kept, and at most the newest entries', () => {
  const list = [at(NOW - KEEP_MS - 1), at(NOW - KEEP_MS + 1), at(NOW - 1000), at(NOW)];
  assert.deepEqual(kept(list, NOW), list.slice(1));
  assert.deepEqual(kept(list, NOW, 2), list.slice(2));
});

test('a bundle holds the last n minutes, everything, or a range', () => {
  const list = [at(NOW - 90 * 60_000), at(NOW - 20 * 60_000), at(NOW - 5 * 60_000), at(NOW)];
  assert.equal(within(list, lastMinutes(15, NOW)).length, 2);
  assert.equal(within(list, lastMinutes(60, NOW)).length, 3);
  assert.equal(within(list, lastMinutes(null, NOW)).length, 4);
  assert.deepEqual(within(list, { from: NOW - 30 * 60_000, to: NOW - 10 * 60_000 }), [list[1]]);
});

test('a request keeps its path and query, never a secret in it', () => {
  assert.equal(redactedUrl('/api/fs/file?path=/a/b.png&download=1'), '/api/fs/file?path=%2Fa%2Fb.png&download=1');
  assert.equal(redactedUrl('https://box.ts.net/api/auth/setup?code=123456&x=y'), '/api/auth/setup?code=…&x=y');
  assert.equal(redactedUrl('/h/other/api/state?token=t'), '/h/other/api/state?token=…');
});

test("a message keeps its words, capped, and its attachments' sizes as this device sent them", () => {
  const sizes = new Map([['/home/me/.cache/ah/uploads/shot.png', 2048]]);
  const d = messageDetail('see /home/me/.cache/ah/uploads/shot.png and ~/notes/x.md', sizes);
  assert.deepEqual(d.attachments, [
    { ext: 'png', bytes: 2048 },
    { ext: 'md', bytes: null },
  ]);
  assert.equal(d.attachmentBytes, 2048);
  assert.equal(messageDetail('plain words', sizes).attachments, undefined);
  const long = messageDetail('y'.repeat(TEXT_KEEP + 5), sizes);
  assert.equal(long.chars, TEXT_KEEP + 5);
  assert.equal((long.text as string).length, TEXT_KEEP + 1);
});

test('a download is the bundle as the host keeps one: a header line, then an entry a line', () => {
  const out = asJsonl([at(NOW)], { app: 'web', device: 'iPad' });
  const [header, entry] = out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(header, { kind: 'bundle', app: 'web', device: 'iPad', entries: 1 });
  assert.equal(entry.kind, 'request');
});
