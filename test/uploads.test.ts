import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitUploads, uploadSummary } from '../web/uploads.ts';

const dir = '/home/me/.cache/ah/uploads';

test('splitUploads takes upload paths out of the text, quoted or not', () => {
  const { uploads, rest } = splitUploads(`${dir}/2026-10-12T18-08-27-998Z-image.png '/home/me/my cache/ah/uploads/2026-10-12T18-09-00-000Z-log.txt' what is in these?`);
  assert.deepEqual(uploads, [
    { path: `${dir}/2026-10-12T18-08-27-998Z-image.png`, name: 'image.png', image: true },
    { path: '/home/me/my cache/ah/uploads/2026-10-12T18-09-00-000Z-log.txt', name: 'log.txt', image: false },
  ]);
  assert.equal(rest, 'what is in these?');
});

test('splitUploads leaves other paths and plain text alone', () => {
  const text = 'look at /home/me/code/ah/web/a.png and src/ah/uploads.ts';
  assert.deepEqual(splitUploads(text), { uploads: [], rest: text });
});

test('uploadSummary counts what a queued message carries', () => {
  assert.equal(uploadSummary(`${dir}/a.png ${dir}/b.jpg why?`), '2 images · why?');
  assert.equal(uploadSummary(`${dir}/a.png ${dir}/notes.txt`), '1 image, 1 file');
  assert.equal(uploadSummary('plain'), 'plain');
});
