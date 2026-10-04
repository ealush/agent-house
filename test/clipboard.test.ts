import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipboardFiles, withName, type ClipboardLike } from '../web/clipboard.ts';

const file = (name: string, type = 'image/png', size = 10): File => ({ name, type, size, lastModified: 1 }) as unknown as File;
const item = (f: File | null, kind = 'file') => ({ kind, type: (f as any)?.type ?? '', getAsFile: () => f });
const dt = (files: File[], items: Array<{ kind: string; type: string; getAsFile: () => File | null }>): ClipboardLike =>
  ({ files, items }) as unknown as ClipboardLike;

test('files alone still work (existing behavior)', () => {
  const f = file('a.png');
  assert.deepEqual(clipboardFiles(dt([f], [])).map((x) => x.name), ['a.png']);
});

test('screenshot in items but not files is picked up', () => {
  const f = file('image.png');
  const out = clipboardFiles(dt([], [item(f)]));
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'image.png');
});

test('present in both is uploaded once', () => {
  const inFiles = file('image.png', 'image/png', 42);
  const viaItems = file('image.png', 'image/png', 42);
  assert.equal(clipboardFiles(dt([inFiles], [item(viaItems)])).length, 1);
});

test('nameless clipboard image gets a screenshot filename', () => {
  const f = file('', 'image/png');
  const out = clipboardFiles(dt([], [item(f)]));
  assert.equal(out.length, 1);
  assert.match(out[0].name, /^screenshot-.*\.png$/);
});

test('string items and null files are ignored', () => {
  const out = clipboardFiles(dt([], [{ kind: 'string', type: 'text/plain', getAsFile: () => null }, item(null)]));
  assert.equal(out.length, 0);
});

test('withName keeps real names and types fallbacks', () => {
  assert.equal(withName(file('a.png'), 'x').name, 'a.png');
  assert.match(withName(file('', 'image/jpeg'), 'shot').name, /^shot\.jpg$/);
});

test('Paste button reads text with a text-only browser', async () => {
  const { readClipboard } = await import('../web/clipboard.ts');
  const clipboard = { readText: async () => 'first\nsecond' } as unknown as Clipboard;
  assert.deepEqual(await readClipboard(clipboard), { text: 'first\nsecond', files: [] });
});

test('Paste button uploads rich clipboard screenshots once, preserving their type', async () => {
  const { readClipboard } = await import('../web/clipboard.ts');
  const clipboard = { read: async () => [{
    types: ['image/png', 'text/html'],
    getType: async (type: string) => new Blob(['image'], { type }),
  }] } as unknown as Clipboard;
  const result = await readClipboard(clipboard);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].type, 'image/png');
  assert.match(result.files[0].name, /^screenshot-.*\.png$/);
  assert.equal(await result.files[0].text(), 'image');
});

test('Paste button falls back to text reads and reports unavailable or denied access', async () => {
  const { readClipboard } = await import('../web/clipboard.ts');
  const clipboard = { read: async () => { throw new Error('Denied'); }, readText: async () => 'text' } as Clipboard;
  assert.deepEqual(await readClipboard(clipboard), { text: 'text', files: [] });
  await assert.rejects(readClipboard(undefined), /unavailable/i);
  await assert.rejects(readClipboard({ ...clipboard, readText: async () => { throw new Error('Denied'); } }), /Denied/);
});
