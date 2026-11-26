import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderOf, isMarkdownPath, linkedPath, linkedPathIn, mediaKind } from '../web/media.ts';

test('linkedPath reads the host path out of a file:// URL or a local path, unescaped', () => {
  assert.equal(linkedPath('file:///home/me/Videos/agent-house-preview.mp4'), '/home/me/Videos/agent-house-preview.mp4');
  assert.equal(linkedPath('file://localhost/home/me/a%20b.mp4'), '/home/me/a b.mp4');
  assert.equal(linkedPath('FILE:///tmp/x.png?raw#frag'), '/tmp/x.png');
  assert.equal(linkedPath('~/Videos/a%20b.mp4'), '~/Videos/a b.mp4');
  assert.equal(linkedPath('/home/me/app.ts:12:3'), '/home/me/app.ts', 'a line and column are not part of the file');
  assert.equal(linkedPath('/home/me/100%.txt'), '/home/me/100%.txt', 'a stray % stays');
  assert.equal(linkedPath('/docs/notes.md#details'), '/docs/notes.md', 'an anchor is no part of the file');
  assert.equal(linkedPath('~/shot.png?raw'), '~/shot.png');
  assert.equal(linkedPath('/docs/a%23b.md#c'), '/docs/a#b.md', 'an escaped # is the name');
  assert.equal(linkedPath('/home/me/app.ts:12#L3'), '/home/me/app.ts');
  for (const href of ['https://example.com/a.mp4', '//cdn.example.com/a.mp4', 'file://server/share/a.mp4', 'relative/a.mp4', 'javascript:alert(1)', '']) {
    assert.equal(linkedPath(href), null, href);
  }
});

test('mediaKind tells pictures, video and sound apart, and nothing else is media', () => {
  assert.equal(mediaKind('/a/Clip.MP4'), 'video');
  assert.equal(mediaKind('/a/b.mov'), 'video');
  assert.equal(mediaKind('/a/b.webm'), 'video');
  assert.equal(mediaKind('/a/b.jpeg'), 'image');
  assert.equal(mediaKind('/a/b.m4a'), 'audio');
  for (const path of ['/a/b.svg', '/a/b.txt', '/a/mp4', '/a/b.mp4.txt']) assert.equal(mediaKind(path), null, path);
});

test('a Markdown document is known by its extension', () => {
  for (const path of ['/a/README.md', '/a/b.MD', '/a/notes.markdown']) assert.equal(isMarkdownPath(path), true, path);
  for (const path of ['/a/b.mdx.txt', '/a/md', '/a/b.txt']) assert.equal(isMarkdownPath(path), false, path);
});

test("linkedPathIn reads a document's links where the document is", () => {
  const dir = '/home/me/.gemini/antigravity-cli/brain/c0ffee';
  assert.equal(linkedPathIn('evidence/shot%201.png', dir), `${dir}/evidence/shot 1.png`);
  assert.equal(linkedPathIn('./evidence/clip.mp4?raw#t=2', dir), `${dir}/evidence/clip.mp4`);
  assert.equal(linkedPathIn('../other/README.md', dir), '/home/me/.gemini/antigravity-cli/brain/other/README.md');
  assert.equal(linkedPathIn('../../../../../../../etc/passwd', dir), '/etc/passwd', 'the host decides what it serves');
  assert.equal(linkedPathIn('file:///tmp/x.png', dir), '/tmp/x.png');
  assert.equal(linkedPathIn('/home/me/a.md', dir), '/home/me/a.md');
  assert.equal(linkedPathIn('~/a.md', dir), '~/a.md');
  for (const href of ['https://example.com/a.png', 'mailto:a@b.c', '#section', '//cdn.example.com/a.png', '', 'javascript:alert(1)']) {
    assert.equal(linkedPathIn(href, dir), null, href);
  }
  assert.equal(folderOf(`${dir}/review.md`), dir);
  assert.equal(folderOf('/review.md'), '/');
});
