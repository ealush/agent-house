import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { safePath, list, receive, FsError, setRoots } from './files.ts';

// Tests browse under the system temp dir; nothing else is a root.
setRoots([tmpdir()]);

test('paths are confined to the configured roots, symlinks included', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fs-'));
  await symlink('/etc', join(dir, 'escape'));
  await assert.rejects(safePath('/etc/passwd'), (e: FsError) => e.status === 403);
  await assert.rejects(safePath(join(dir, 'escape/passwd')), (e: FsError) => e.status === 403);
  await assert.rejects(safePath('relative/path'), (e: FsError) => e.status === 400);
  assert.equal(await safePath(dir), dir);
});

test('listing hides dotfiles unless asked, folders first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fs-'));
  await writeFile(join(dir, 'b.txt'), 'b');
  await writeFile(join(dir, '.secret'), 's');
  await import('node:fs/promises').then((f) => f.mkdir(join(dir, 'z-dir')));
  const shown = await list(dir, false);
  assert.deepEqual(shown.entries.map((e) => e.name), ['z-dir', 'b.txt']);
  assert.ok((await list(dir, true)).entries.some((e) => e.name === '.secret'));
});

test('uploads never overwrite and strip path tricks from names', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fs-'));
  const a = await receive(Readable.from([Buffer.from('one')]), dir, 'shot.png', 1024);
  const b = await receive(Readable.from([Buffer.from('two')]), dir, 'shot.png', 1024);
  const c = await receive(Readable.from([Buffer.from('x')]), dir, '../../evil.sh', 1024);
  assert.equal(a, join(dir, 'shot.png'));
  assert.equal(b, join(dir, 'shot (1).png'));
  assert.equal(c, join(dir, 'evil.sh'));
  assert.equal(await readFile(b, 'utf8'), 'two');
  await assert.rejects(receive(Readable.from([Buffer.alloc(2048)]), dir, 'big.bin', 1024), (e: FsError) => e.status === 413);
});
