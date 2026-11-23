import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkedPath, mediaKind } from '../web/media.ts';

test('linkedPath reads the host path out of a file:// URL or a local path, unescaped', () => {
  assert.equal(linkedPath('file:///home/me/Videos/agent-house-preview.mp4'), '/home/me/Videos/agent-house-preview.mp4');
  assert.equal(linkedPath('file://localhost/home/me/a%20b.mp4'), '/home/me/a b.mp4');
  assert.equal(linkedPath('FILE:///tmp/x.png?raw#frag'), '/tmp/x.png');
  assert.equal(linkedPath('~/Videos/a%20b.mp4'), '~/Videos/a b.mp4');
  assert.equal(linkedPath('/home/me/app.ts:12:3'), '/home/me/app.ts', 'a line and column are not part of the file');
  assert.equal(linkedPath('/home/me/100%.txt'), '/home/me/100%.txt', 'a stray % stays');
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
