import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMentions, MENTION_HREF, mentionExists, remarkMentions, removeMention, resolveMention } from '../web/mentions.ts';
import type { FsListing, HostApi } from '../web/api.ts';

test('findMentions finds each @path, not the sentence around it', () => {
  const text = '@rust.md first, then @apps/server/http.ts, (see @docs/a.md) and mail me@example.com or `@code`';
  assert.deepEqual(
    findMentions(text).map((m) => [m.path, text.slice(m.start, m.end)]),
    [
      ['rust.md', '@rust.md'],
      ['apps/server/http.ts', '@apps/server/http.ts'],
      ['docs/a.md', '@docs/a.md'],
    ],
  );
  // Not an address (no space before its @), nor code in backticks; a closing ")" or "." isn't the name.
  assert.deepEqual(findMentions('look at @a.md.\n@b.ts'), [
    { start: 8, end: 13, path: 'a.md' },
    { start: 15, end: 20, path: 'b.ts' },
  ]);
});

test('resolveMention reads a path in the session folder unless it is absolute or ~', () => {
  assert.equal(resolveMention('/work/my repo/', 'src/a.ts'), '/work/my repo/src/a.ts');
  assert.equal(resolveMention('/work', './a.ts'), '/work/a.ts');
  assert.equal(resolveMention('/work', '/etc/hosts'), '/etc/hosts');
  assert.equal(resolveMention('/work', '~/notes.md'), '~/notes.md');
});

test('removeMention takes one space with it, after it or else before it', () => {
  const at = (text: string, path: string) => removeMention(text, findMentions(text).find((m) => m.path === path)!);
  assert.deepEqual(at('read @a.md and go', 'a.md'), { text: 'read and go', caret: 5 });
  assert.deepEqual(at('read @a.md, then', 'a.md'), { text: 'read, then', caret: 4 });
  assert.deepEqual(at('read @a.md', 'a.md'), { text: 'read', caret: 4 });
  assert.deepEqual(at('@a.md', 'a.md'), { text: '', caret: 0 });
});

test('mentionExists asks once per folder, and only files count', async () => {
  const asked: string[] = [];
  const fs = {
    url: () => 'host-a',
    list: async (path: string) => {
      asked.push(path);
      if (path === '/gone') throw new Error('not found');
      return { path, parent: null, entries: [{ name: 'a.md', type: 'file', size: 1, mtime: 0 }, { name: 'src', type: 'dir', size: 0, mtime: 0 }] } satisfies FsListing;
    },
  } as unknown as HostApi['fs'];
  assert.equal(await mentionExists(fs, '/w', 'a.md'), true);
  assert.equal(await mentionExists(fs, '/w', 'b.md'), false);
  assert.equal(await mentionExists(fs, '/w', 'src'), false);
  assert.equal(await mentionExists(fs, '/gone', 'a.md'), false);
  assert.deepEqual(asked, ['/w', '/gone']);
});

test('remarkMentions links a known file in prose, never in code or inside a link', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  // As web/Markdown.tsx renders it: GFM, then this.
  const { default: ReactMarkdown } = await import('react-markdown');
  const { default: remarkGfm } = await import('remark-gfm');
  const text = 'Read @a.md and @gone.md, **@a.md** again, `@a.md` in code, [see @a.md](https://x.test)\n\n```\n@a.md\n```';
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkMentions(new Map([['a.md', '/w/a.md']]))] }, text));
  const links = [...html.matchAll(/<a href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(links, [
    [`${MENTION_HREF}${encodeURIComponent('/w/a.md')}`, '@a.md'],
    [`${MENTION_HREF}${encodeURIComponent('/w/a.md')}`, '@a.md'],
    ['https://x.test', 'see @a.md'],
  ]);
  assert.match(html, /<code>@a\.md<\/code>/);
  assert.match(html, /@gone\.md/);
});

test('moveMention takes a chip out with a space and puts it in with one each side', async () => {
  const { moveMention } = await import('../web/mentions.ts');
  const text = 'read @a.md then fix it';
  const [a] = findMentions(text);
  assert.deepEqual(moveMention(text, a, text.length), { text: 'read then fix it @a.md ', caret: 23 });
  assert.deepEqual(moveMention(text, a, 0), { text: '@a.md read then fix it', caret: 6 });
  // Mid-word: it lands with a space each side.
  assert.equal(moveMention(text, a, text.indexOf('fix') + 1).text, 'read then f @a.md ix it');
  // On itself, nothing moves.
  assert.equal(moveMention(text, a, a.start + 2).text, text);
  // Inside another chip: at that one's nearer end.
  const two = 'see @a.md and @bb/long.md';
  const [x, y] = findMentions(two);
  assert.equal(moveMention(two, x, y.start + 2, [y]).text, 'see and @a.md @bb/long.md');
  assert.equal(moveMention(two, x, y.end - 1, [y]).text, 'see and @bb/long.md @a.md ');
});
