import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, listWorktrees, removeWorktree, changes, slugify, mainRepo } from './git.ts';
import { repoInfo } from './sessions.ts';

async function repo() {
  const parent = await mkdtemp(join(tmpdir(), 'ah-git-'));
  const dir = join(parent, 'proj');
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  await writeFile(join(dir, 'a.txt'), 'hello\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return dir;
}

test('slugify', () => {
  assert.equal(slugify('Fix: the Login bug!'), 'fix-the-login-bug');
  assert.equal(slugify('///'), 'session');
});

test('worktree lifecycle: create, detect, list, refuse dirty removal, force', async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, 'Fix login');
  assert.match(wt.branch, /^ah\/fix-login-[0-9a-f]{4}$/);
  assert.ok(wt.path.includes('/.worktrees/proj/'));
  assert.equal(await mainRepo(wt.path), dir);

  const info = repoInfo(wt.path)!;
  assert.equal(info.project, 'proj', 'worktree sessions group under the main repo');
  assert.equal(info.worktree, true);
  assert.equal(info.branch, wt.branch);

  await writeFile(join(wt.path, 'a.txt'), 'changed\n');
  const [listed] = await listWorktrees([dir]);
  assert.equal(listed.dirty, 1);

  const c = await changes(wt.path);
  assert.deepEqual(c.files, [{ code: 'M', path: 'a.txt' }]);
  assert.match(c.patch, /\+changed/);

  await assert.rejects(removeWorktree(wt.path, false), /uncommitted/);
  await removeWorktree(wt.path, true);
  assert.equal(existsSync(wt.path), false);
  await assert.rejects(removeWorktree(dir, true), /not an ah-managed worktree/);
});
