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

test('an attachment goes by its name in the text, numbered when it is taken, nothing that would end it', async () => {
  const { uploadToken } = await import('../web/uploads.ts');
  const taken = new Set<string>();
  assert.equal(uploadToken('paste.png', taken), 'paste.png');
  assert.equal(uploadToken('paste.png', taken), 'paste-2.png');
  assert.equal(uploadToken('my "draft" notes.txt', taken), 'my-draft-notes.txt');
  assert.equal(uploadToken('README', taken), 'README');
  assert.equal(uploadToken('README', taken), 'README-2');
});

test('placeUploads leaves each upload where it is in the text, as its token', async () => {
  const { placeUploads } = await import('../web/uploads.ts');
  const placed = placeUploads(`compare ${dir}/2026-10-12T18-08-27-998Z-paste.png with '/home/me/my cache/ah/uploads/2026-10-12T18-09-00-000Z-paste.png' please`);
  assert.equal(placed.text, 'compare @paste.png with @paste-2.png please');
  assert.deepEqual(placed.uploads.map((u) => [u.token, u.path]), [
    ['paste.png', `${dir}/2026-10-12T18-08-27-998Z-paste.png`],
    ['paste-2.png', '/home/me/my cache/ah/uploads/2026-10-12T18-09-00-000Z-paste.png'],
  ]);
  assert.deepEqual(placeUploads('no files here'), { uploads: [], text: 'no files here' });
  assert.equal(placeUploads(`${dir}/2026-10-12T18-08-27-998Z-a.png`, new Set(['a.png'])).text, '@a-2.png', 'a token already in the box is taken');
});

test('withAttachments puts each path where its chip is, and the rest in front', async () => {
  const { withAttachments, attachmentChips } = await import('../web/attachmentText.ts');
  const files = [
    { id: 1, name: 'a.png', image: true, path: `${dir}/x-a.png`, token: 'a.png' },
    { id: 2, name: 'my log.txt', image: false, path: '/home/me/my cache/ah/uploads/x-log.txt', token: 'my-log.txt' },
    { id: 3, name: 'b.png', image: true, path: `${dir}/x-b.png` },
  ];
  const text = 'see @a.png, then @my-log.txt and @a.png again';
  assert.deepEqual(attachmentChips(files, text).map((c) => [c.file.id, c.start]), [[1, 4], [2, 17]]);
  assert.equal(withAttachments(files, text), `${dir}/x-b.png see ${dir}/x-a.png, then '/home/me/my cache/ah/uploads/x-log.txt' and @a.png again`);
  // A chip deleted as text: its file still goes, in front.
  assert.equal(withAttachments(files.slice(0, 1), 'just words'), `${dir}/x-a.png just words`);
});
