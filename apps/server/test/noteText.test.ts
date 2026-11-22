import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteMarkdown, shownText, tokenPaths } from '../web/noteText.ts';

const up = (name: string, stamp = '2026-11-22T10-00-00-000Z') => `/home/me/.cache/ah/uploads/${stamp}-${name}`;

test('a note shows each upload as its token, and its Markdown keeps the path', () => {
  const md = `Why is ${up('shot.png')} red, next to ${up('paste.png', '2026-11-22T10-00-01-000Z')}?\n\n- and ${up('paste.png', '2026-11-22T10-00-02-000Z')}, see ${up('log.txt')}.`;
  const known = new Map<string, string>();
  const shown = shownText(md, known);
  assert.equal(shown.text, 'Why is @shot.png red, next to @paste.png?\n\n- and @paste-2.png, see @log.txt.');
  assert.deepEqual(
    shown.uploads.map((u) => [u.token, u.name, u.image]),
    [
      ['shot.png', 'shot.png', true],
      ['paste.png', 'paste.png', true],
      ['paste-2.png', 'paste.png', true],
      ['log.txt', 'log.txt', false],
    ],
  );
  assert.equal(noteMarkdown(shown.text, tokenPaths(known, shown.uploads)), md, 'back to the same Markdown');
});

test("a chip keeps its name when another of the same name is taken out", () => {
  const a = up('paste.png', '2026-11-22T10-00-01-000Z');
  const b = up('paste.png', '2026-11-22T10-00-02-000Z');
  const known = new Map<string, string>();
  assert.equal(shownText(`${a} ${b}`, known).text, '@paste.png @paste-2.png');
  // The first chip's × took it out: the second is still "paste-2.png", so the box doesn't change under the caret.
  assert.equal(shownText(b, known).text, '@paste-2.png');
  assert.equal(shownText(`x ${b} ${a}`, known).text, 'x @paste-2.png @paste.png', 'moved: each keeps its own');
});

test('words typed against a chip break it into text; typed apart again, it is the file again', () => {
  const a = up('shot.png');
  const known = new Map<string, string>();
  const shown = shownText(`see ${a}`, known);
  const paths = () => tokenPaths(known, shown.uploads);
  assert.equal(noteMarkdown('see @shot.pngs', paths()), 'see @shot.pngs');
  const broken = shownText('see @shot.pngs', known);
  assert.equal(noteMarkdown('see @shot.png', tokenPaths(known, broken.uploads)), `see ${a}`);
  // Only the first of each is the file, as in a message.
  assert.equal(noteMarkdown('@shot.png and @shot.png', paths()), `${a} and @shot.png`);
});

test("an upload's path inside other words, in code or quoted, is left as it is", () => {
  const known = new Map<string, string>();
  for (const md of [`x${up('a.png')}`, `\`${up('a.png')}\``, `[a](${up('a.png')})`, `${up('a.png')}x/y`]) {
    assert.equal(shownText(md, known).text, md, md);
  }
  // Quoted as a message quotes a path with a space in it.
  const quoted = `'/home/my me/.cache/ah/uploads/2026-11-22T10-00-00-000Z-a.png'`;
  const shown = shownText(`look ${quoted}`, known);
  assert.equal(shown.text, 'look @a.png');
  assert.equal(noteMarkdown(shown.text, tokenPaths(known, shown.uploads)), `look ${quoted}`);
});

test('tokens still on their way are not taken again', () => {
  const known = new Map<string, string>();
  assert.equal(shownText(`${up('paste.png')} @paste.png`, known, ['paste.png']).text, '@paste-2.png @paste.png');
});
