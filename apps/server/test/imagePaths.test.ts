import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxHolds, imagePieces } from '../server/imagePaths.ts';

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

test('boxHolds knows a handed-back prompt for the message ah typed, pictures and all', () => {
  // The owner's report (2026-11-24): two screenshots and a line, handed back by a stop.
  const sent = '/up/a.png /up/b.png\nClause code - most recent message did not appear.';
  assert.equal(boxHolds('[Image #1] [Image #2] Clause code - most recent message did not appear.', sent), true);
  assert.equal(boxHolds('[Image #1] [Image #2]', '/up/a.png /up/b.png'), true);
  assert.equal(boxHolds('see [Pasted text #1 +40 lines] please', 'see\nline one\nline two please'), true);
  assert.equal(boxHolds('something else entirely', sent), false);
  assert.equal(boxHolds('', sent), false);
});
