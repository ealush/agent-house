// Rebuild clears the project's dist directory, then runs its build script.
// A path that is not that dist directory is refused before anything is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rebuildFailure, rebuildWeb } from '../server/rebuild.ts';

function project(name: string, buildJs: string): { root: string; dist: string } {
  const root = mkdtempSync(join(tmpdir(), `ah-rebuild-${name}-`));
  const dist = join(root, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'stale.txt'), 'old');
  writeFileSync(join(root, 'build.js'), buildJs);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name, private: true, scripts: { build: 'node build.js' } }));
  return { root, dist };
}

test('rebuildWeb clears dist and runs the project build', async () => {
  const { root, dist } = project('ok', "const fs = require('fs');\nfs.mkdirSync('dist');\nfs.writeFileSync('dist/ok.txt', 'fresh');\n");
  await rebuildWeb(root, dist);
  assert.equal(existsSync(join(dist, 'stale.txt')), false);
  assert.equal(readFileSync(join(dist, 'ok.txt'), 'utf8'), 'fresh');
});

test('a failed build rejects after the old dist is gone', async () => {
  const { root, dist } = project('fail', "process.stderr.write('build-broke\\n'); process.exit(1);\n");
  await assert.rejects(
    () => rebuildWeb(root, dist),
    (err: Error) => {
      assert.match(rebuildFailure(err), /build-broke/);
      return true;
    },
  );
  assert.equal(existsSync(join(dist, 'stale.txt')), false);
});

test('rebuildWeb refuses to remove anything other than dist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ah-rebuild-guard-'));
  writeFileSync(join(root, 'keep.txt'), 'safe');
  await assert.rejects(() => rebuildWeb(root, root), /refusing to remove/);
  assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'safe');
});
