import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imagePieces } from '../server/imagePaths.ts';

test('imagePieces cuts a message where its pictures are, in order', () => {
  // A note: words over lines, then its pictures.
  assert.deepEqual(imagePieces('Something I noticed:\n\nanswers never show\n/up/a.png /up/b.png'), [
    { text: 'Something I noticed:\n\nanswers never show\n', images: 0 },
    { text: '/up/a.png /up/b.png', images: 2 },
  ]);
  // Pictures inside a sentence keep their places, with the spaces around them.
  assert.deepEqual(imagePieces('compare ~/a.png with ./b.JPG please'), [
    { text: 'compare ', images: 0 },
    { text: '~/a.png', images: 1 },
    { text: ' with ', images: 0 },
    { text: './b.JPG', images: 1 },
    { text: ' please', images: 0 },
  ]);
});

test('imagePieces leaves alone a message with no pictures, or only pictures', () => {
  assert.equal(imagePieces('no pictures here, a.png is a name'), null);
  assert.equal(imagePieces('/up/a.png /up/b.png'), null);
  assert.equal(imagePieces(' /up/a.png\n'), null);
  // Not a path: inside a word.
  assert.equal(imagePieces('see x/a.png'), null);
});
