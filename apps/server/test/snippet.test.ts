import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainSnippet } from '../web/snippet.ts';

test('a search snippet reads as prose: no headings, emphasis, code ticks or bullets', () => {
  const s = '## Summary 1\n\nI \u0001changed\u0002 `b` in **App1.tsx** and ran the tests. One still fails:\n\n- `renders header` expects 2 items\n- the fixture has 3…';
  assert.equal(plainSnippet(s), 'Summary 1 I \u0001changed\u0002 b in App1.tsx and ran the tests. One still fails: renders header expects 2 items the fixture has 3…');
});

test('markers at a line start survive the markup they sit before', () => {
  assert.equal(plainSnippet('\u0001## Plan\u0002\n1. [x] **ship** it'), '\u0001Plan\u0002 ship it');
  assert.equal(plainSnippet('> quoted [link](https://x.y/z) text'), 'quoted link text');
});

test('code fences go, identifiers with underscores stay', () => {
  assert.equal(plainSnippet('```ts\nconst __init__ = snake_case;\n```'), 'const __init__ = snake_case;');
  assert.equal(plainSnippet('call __dirname and a__b'), 'call __dirname and a__b');
});
