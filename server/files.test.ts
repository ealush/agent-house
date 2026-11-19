import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { safePath, list, receive, FsError, setRoots, clearUploadDir, dirStatus } from './files.ts';

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

test('dirStatus offers a new folder only inside the roots, under an existing parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fs-'));
  await writeFile(join(dir, 'notes.txt'), 'n');
  assert.equal(await dirStatus(dir), 'dir');
  assert.equal(await dirStatus(join(dir, 'fresh')), 'new');
  assert.equal(await dirStatus(join(dir, 'a', 'b')), 'missing');
  assert.equal(await dirStatus(join(dir, 'notes.txt')), 'file');
  assert.equal(await dirStatus('/etc/ah-nope'), 'outside');
  assert.equal(await dirStatus('/etc'), 'dir'); // starting in any existing folder stays allowed
  assert.equal(await dirStatus('relative'), 'missing');
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

test('clearUploadDir removes only the uploads directory contents', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ah-fs-'));
  const uploads = join(root, 'ah', 'uploads');
  await mkdir(uploads, { recursive: true });
  await writeFile(join(uploads, 'shot.png'), 'png');
  await mkdir(join(uploads, 'sub'));
  await writeFile(join(uploads, 'sub', 'inner.txt'), 'in');
  await writeFile(join(root, 'keep.txt'), 'keep');

  assert.equal(await clearUploadDir(uploads), 2);
  assert.equal(existsSync(join(uploads, 'shot.png')), false);
  assert.equal(existsSync(join(uploads, 'sub')), false);
  assert.equal(existsSync(uploads), true);
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
});

test('clearUploadDir creates a missing uploads directory and refuses anything else', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ah-fs-'));
  const uploads = join(root, 'ah', 'uploads');
  await writeFile(join(root, 'keep.txt'), 'keep');
  assert.equal(await clearUploadDir(uploads), 0);
  assert.equal(existsSync(uploads), true);

  const evil = await mkdtemp(join(tmpdir(), 'ah-evil-'));
  await writeFile(join(evil, 'precious'), 'no');
  const link = join(root, 'linked-uploads');
  await symlink(evil, link);
  await assert.rejects(() => clearUploadDir(link), /refusing to clear/);
  await assert.rejects(() => clearUploadDir(root), /refusing to clear/);
  assert.equal(await readFile(join(evil, 'precious'), 'utf8'), 'no');
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
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
