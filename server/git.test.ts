import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, listWorktrees, removeWorktree, removeWorktreesBulk, changes, listBranches, switchBranch, pullRequest, slugify, mainRepo } from './git.ts';
import { settleSizes } from './size.ts';
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

test('pullRequest: parses gh output for the current branch, null when gh fails or HEAD is detached', async () => {
  const dir = await repo();
  const bin = await mkdtemp(join(tmpdir(), 'ah-gh-'));
  const argsFile = join(bin, 'args');
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$@" > "${argsFile}"\nif [ "$AH_GH_FAIL" = "1" ]; then echo "nope" >&2; exit 1; fi\necho '[{"number":42,"url":"https://github.com/ealush/ah/pull/42"}]'\n`,
  );
  await chmod(join(bin, 'gh'), 0o755);
  const savedPath = process.env.PATH ?? '';
  const savedFail = process.env.AH_GH_FAIL;
  process.env.PATH = `${bin}:${savedPath}`;
  try {
    assert.deepEqual(await pullRequest(dir), { number: 42, url: 'https://github.com/ealush/ah/pull/42' });
    assert.match(readFileSync(argsFile, 'utf8'), /pr list --head main/);
    process.env.AH_GH_FAIL = '1';
    assert.equal(await pullRequest(dir), null);
  } finally {
    process.env.PATH = savedPath;
    if (savedFail === undefined) delete process.env.AH_GH_FAIL;
    else process.env.AH_GH_FAIL = savedFail;
  }
  // A detached HEAD never shells out to gh.
  execFileSync('git', ['-C', dir, 'checkout', '-q', '--detach', 'HEAD']);
  assert.equal(await pullRequest(dir), null);
});

test('branches: list local recency, switch local, track remote, create new, reject bad names and clobbering switches', async () => {
  const dir = await repo();
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' }).toString().trim();
  let stamp = 0;
  const commit = async (file: string, content: string, msg: string) => {
    await writeFile(join(dir, file), content);
    g('add', '.');
    // Explicit timestamps: committer-date ties would make recency order flaky.
    const date = `2020-01-01T00:00:${String(10 + stamp++).padStart(2, '0')}`;
    execFileSync('git', ['-C', dir, 'commit', '-qm', msg], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };

  g('checkout', '-qb', 'feature-old');
  await commit('c.txt', 'c\n', 'third');
  g('checkout', '-q', 'main');
  await commit('b.txt', 'b\n', 'second');
  // Simulate fetched remote branches: one with no local counterpart, and one
  // shadowed by a local branch of the same name. A configured remote makes the
  // tracking refs behave like the real thing.
  g('config', 'remote.origin.url', dir);
  g('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  g('update-ref', 'refs/remotes/origin/feature-remote', g('rev-parse', 'HEAD'));
  g('update-ref', 'refs/remotes/origin/feature-old', g('rev-parse', 'HEAD'));

  const listed = await listBranches(dir);
  assert.equal(listed.current, 'main');
  assert.deepEqual(
    listed.branches.map((b) => [b.name, b.current, b.remote]),
    [
      ['main', true, false],
      ['feature-old', false, false],
      ['feature-remote', false, true],
    ],
  );

  // Switching to a name with both local and remote refs takes the local one.
  assert.equal((await switchBranch(dir, 'feature-old')).branch, 'feature-old');
  assert.equal((await listBranches(dir)).current, 'feature-old');

  // A remote-only name is checked out with tracking.
  assert.equal((await switchBranch(dir, 'feature-remote')).branch, 'feature-remote');
  assert.equal(g('config', 'branch.feature-remote.remote'), 'origin');
  assert.equal((await listBranches(dir)).branches.find((b) => b.name === 'feature-remote')?.remote, false);

  // An unknown name creates a new branch.
  assert.equal((await switchBranch(dir, 'feature-new')).branch, 'feature-new');
  assert.equal(g('branch', '--show-current'), 'feature-new');

  await assert.rejects(switchBranch(dir, 'bad..name'), /invalid branch name/);
  await assert.rejects(switchBranch(dir, ''), /invalid branch name/);

  // A switch that would overwrite uncommitted work fails instead of losing it.
  g('checkout', '-q', 'main');
  await commit('d.txt', 'd\n', 'fourth');
  g('checkout', '-qb', 'other');
  await commit('a.txt', 'other side\n', 'other side');
  g('checkout', '-q', 'main');
  await writeFile(join(dir, 'a.txt'), 'my uncommitted side\n');
  await assert.rejects(switchBranch(dir, 'other'), /local changes.*overwritten/i);
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

test('worktree sizes: cold list reports nulls, warm list carries measured bytes', async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, 'Sized');
  await writeFile(join(wt.path, 'big.bin'), 'x'.repeat(200_000));
  const [cold] = await listWorktrees([dir]);
  assert.equal(cold.sizeBytes, null, 'first listing must not block on measuring');
  assert.equal(cold.sizeMeasuredAt, null);
  assert.ok(cold.lastActivityAt > 0, 'directory mtime stands in for last activity');
  await settleSizes();
  const [warm] = await listWorktrees([dir]);
  assert.ok(warm.sizeBytes !== null && warm.sizeBytes >= 200_000, `size ${warm.sizeBytes}`);
  assert.ok(warm.logicalBytes !== null && warm.logicalBytes >= 200_000);
  assert.equal(warm.sizePartial, false);
  assert.equal(warm.sizeTooLarge, false);
  assert.ok(warm.sizeMeasuredAt !== null && warm.sizeMeasuredAt > 0);
  await removeWorktree(wt.path, true);
});

test('bulk removal: revalidates in-use, dirty, and managed root per item', async () => {
  const dir = await repo();
  const clean = await createWorktree(dir, 'Clean one');
  const dirty = await createWorktree(dir, 'Dirty one');
  const busy = await createWorktree(dir, 'Busy one');
  await writeFile(join(dirty.path, 'a.txt'), 'changed\n');
  const missing = join(dir, '.worktrees', 'proj', 'already-gone');

  const results = await removeWorktreesBulk([clean.path, dirty.path, busy.path, dir, missing], new Set(), (p) => p === busy.path);
  const byPath = new Map(results.map((r) => [r.path, r]));
  assert.equal(byPath.get(clean.path)?.ok, true);
  assert.equal(existsSync(clean.path), false);
  assert.match(byPath.get(dirty.path)?.error ?? '', /uncommitted/);
  assert.equal(existsSync(dirty.path), true, 'dirty orphan survives a non-force bulk pass');
  assert.match(byPath.get(busy.path)?.error ?? '', /live session/);
  assert.equal(existsSync(busy.path), true, 'a worktree that became in use after listing is skipped');
  assert.match(byPath.get(dir)?.error ?? '', /not an ah-managed worktree/);
  assert.equal(byPath.get(missing)?.ok, true, 'already gone counts as success');
  assert.equal(byPath.get(missing)?.gone, true);

  // Force-checking the dirty one removes just it; the busy one still stays.
  const second = await removeWorktreesBulk([dirty.path, busy.path], new Set([dirty.path]), (p) => p === busy.path);
  assert.equal(second[0].ok, true);
  assert.equal(existsSync(dirty.path), false);
  assert.equal(second[1].ok, false);

  await removeWorktree(busy.path, true);
});
