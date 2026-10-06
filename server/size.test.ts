import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, link, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedSize, invalidateSize, measureDir, requestSize, settleSizes } from './size.ts';

async function tree() {
  const dir = await mkdtemp(join(tmpdir(), 'ah-size-'));
  await writeFile(join(dir, 'a.txt'), 'x'.repeat(1000));
  await mkdir(join(dir, 'sub'));
  await writeFile(join(dir, 'sub', 'b.bin'), 'y'.repeat(5000));
  return dir;
}

test('measureDir sums logical and allocated bytes across subdirectories', async () => {
  const dir = await tree();
  const size = await measureDir(dir);
  assert.equal(size.tooLarge, false);
  assert.equal(size.partial, false);
  assert.ok(size.logicalBytes >= 6000, `logical ${size.logicalBytes} should cover both files`);
  assert.ok(size.sizeBytes !== null && size.sizeBytes >= size.logicalBytes, 'allocated should be at least logical');
  assert.ok(size.measuredAt > 0);
});

test('measureDir does not follow symlinks out of the tree', async () => {
  const dir = await tree();
  const outside = await mkdtemp(join(tmpdir(), 'ah-size-outside-'));
  await writeFile(join(outside, 'big.bin'), 'z'.repeat(100_000));
  await symlink(join(outside, 'big.bin'), join(dir, 'link.bin'));
  await symlink(outside, join(dir, 'linkdir'));
  const size = await measureDir(dir);
  // Only the links' own sizes count, never the 100 KB target behind them.
  assert.ok(size.logicalBytes < 20_000, `logical ${size.logicalBytes} should exclude the symlink target`);
});

test('measureDir reports tooLarge past the entry cap instead of a wrong total', async () => {
  const dir = await tree();
  const size = await measureDir(dir, 2);
  assert.equal(size.tooLarge, true);
  assert.equal(size.sizeBytes, null);
});

test('measureDir flags an unreadable root as partial', async () => {
  const size = await measureDir(join(tmpdir(), 'ah-size-does-not-exist-xyz'));
  assert.equal(size.partial, true);
  assert.equal(size.logicalBytes, 0);
});

test('size cache: requestSize fills in the background, invalidateSize drops it', async () => {
  const dir = await tree();
  assert.equal(cachedSize(dir), null);
  requestSize(dir);
  await settleSizes();
  const hit = cachedSize(dir);
  assert.ok(hit && hit.logicalBytes >= 6000);
  // A second request with a fresh cache entry does not remeasure.
  requestSize(dir);
  await settleSizes();
  assert.equal(cachedSize(dir)?.measuredAt, hit.measuredAt);
  invalidateSize(dir);
  assert.equal(cachedSize(dir), null);
});


test('measureDir matches du for directories and hard links, and never follows a root symlink', async () => {
  const dir = await tree();
  await link(join(dir, 'sub', 'b.bin'), join(dir, 'duplicate.bin'));
  const measured = await measureDir(dir);
  const du = Number(execFileSync('du', ['-s', '-B1', dir], { encoding: 'utf8' }).split(/\s/)[0]);
  assert.equal(measured.sizeBytes, du);
  const linked = dir + '-link';
  await symlink(dir, linked);
  assert.ok((await measureDir(linked)).logicalBytes < 1000);
});

test('invalidating an in-flight size measurement does not repopulate a stale cache', async () => {
  const dir = await tree();
  requestSize(dir);
  invalidateSize(dir);
  await settleSizes();
  assert.equal(cachedSize(dir), null);
});
