import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findMentions, mentionExists, removeMention, resolveMention } from '../web/mentions.ts';
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
