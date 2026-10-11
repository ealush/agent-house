import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, listWorktrees, removeWorktree, removeWorktreesBulk, changes, listBranches, switchBranch, pullRequest, slugify, mainRepo, createSnapshot, restoreSnapshot, snapshotDiff, snapshotRef } from './git.ts';
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

test('branches: listBranches reports uncommitted file count as dirty', async () => {
  const dir = await repo();
  assert.equal((await listBranches(dir)).dirty, 0);
  await writeFile(join(dir, 'a.txt'), 'dirty\n');
  assert.equal((await listBranches(dir)).dirty, 1);
  await writeFile(join(dir, 'new.txt'), 'untracked\n');
  assert.equal((await listBranches(dir)).dirty, 2);
});

test('branches: a branch checked out in another worktree is marked and refuses to switch', async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, 'Held work');
  try {
    const fromMain = await listBranches(dir);
    assert.equal(fromMain.branches.find((b) => b.name === wt.branch)?.worktree, wt.path);
    assert.equal(fromMain.branches.find((b) => b.name === 'main')?.worktree ?? null, null);

    const fromWt = await listBranches(wt.path);
    assert.equal(fromWt.branches.find((b) => b.name === wt.branch)?.worktree ?? null, null, 'own checkout never counts');
    assert.equal(fromWt.branches.find((b) => b.name === 'main')?.worktree, dir);

    await assert.rejects(switchBranch(dir, wt.branch), /already checked out in worktree/);

    await removeWorktree(wt.path, true);
    assert.equal((await switchBranch(dir, wt.branch)).branch, wt.branch, 'removing the worktree frees the kept branch');
  } finally {
    await removeWorktree(wt.path, true).catch(() => {});
  }
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


test('removal rejects a nested directory and a foreign worktree under a lookalike root', async () => {
  const dir = await repo();
  const wt = await createWorktree(dir, 'Guarded');
  const nested = join(wt.path, '.worktrees', 'nested');
  await (await import('node:fs/promises')).mkdir(nested, { recursive: true });
  await assert.rejects(removeWorktree(nested, true), /not an ah-managed worktree/);
  await removeWorktree(wt.path, true);
  const foreign = join(dir, '.worktrees', 'foreign');
  execFileSync('git', ['-C', dir, 'worktree', 'add', '-b', 'foreign', foreign]);
  await assert.rejects(removeWorktree(foreign, true), /not an ah-managed worktree/);
  execFileSync('git', ['-C', dir, 'worktree', 'remove', '--force', foreign]);
});

test('snapshots: capture per turn, restore undoes edits and deletions, user index and stash untouched', async () => {
  const dir = await repo();
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  const indexFile = join(dir, '..', 'snap-index');
  const snap = (turn: number, parent: string | null) =>
    createSnapshot(dir, { uid: 'u1', turn, indexFile, parent, maxFileBytes: 10 * 1024 * 1024 });

  // A stash entry and a staged change: both are the user's own git state and
  // must survive every snapshot and restore byte for byte.
  await writeFile(join(dir, 'stashme.txt'), 'stash\n');
  g('stash', '-u', '-q');
  const stashBefore = g('stash', 'list').toString();
  await writeFile(join(dir, 'staged.txt'), 'staged\n');
  g('add', 'staged.txt');
  const indexBefore = readFileSync(join(dir, '.git', 'index'));
  const branchBefore = g('branch', '--show-current').toString().trim();

  // Turn 1 starts from the init state (plus the staged file, which is worktree state).
  const s1 = await snap(1, null);
  assert.equal(s1.branch, 'main');
  assert.deepEqual(s1.skipped, []);
  assert.equal(g('rev-parse', snapshotRef('u1', 1)).toString().trim(), s1.commit);
  assert.deepEqual(await snapshotDiff(dir, null, s1.commit), { filesChanged: 0, insertions: 0, deletions: 0 });

  // Turn 1's work: modify a.txt, add b.txt. Turn 2's snapshot captures it.
  await writeFile(join(dir, 'a.txt'), 'hello v2\n');
  await writeFile(join(dir, 'b.txt'), 'bee\n');
  const s2 = await snap(2, s1.commit);
  const d12 = await snapshotDiff(dir, s1.commit, s2.commit);
  assert.equal(d12.filesChanged, 2);
  assert.equal(d12.insertions, 2);
  assert.equal(d12.deletions, 1);

  // Turn 2's damage: rewrite a.txt, delete b.txt, create c.txt.
  await writeFile(join(dir, 'a.txt'), 'broken\n');
  await rm(join(dir, 'b.txt'));
  await writeFile(join(dir, 'c.txt'), 'cee\n');
  const safety = await snap(3, s2.commit);

  // Restore to before turn 2: a.txt and b.txt come back, c.txt goes away.
  await restoreSnapshot(dir, { target: s2.commit, current: safety.commit, indexFile });
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'hello v2\n');
  assert.equal(await readFile(join(dir, 'b.txt'), 'utf8'), 'bee\n');
  assert.equal(existsSync(join(dir, 'c.txt')), false);

  // Restoring the safety snapshot returns to the damaged state exactly.
  const back = await snap(4, safety.commit);
  await restoreSnapshot(dir, { target: safety.commit, current: back.commit, indexFile });
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'broken\n');
  assert.equal(existsSync(join(dir, 'b.txt')), false);
  assert.equal(await readFile(join(dir, 'c.txt'), 'utf8'), 'cee\n');

  // The invariance requirement: stash list, branch, and the index file itself.
  assert.equal(g('stash', 'list').toString(), stashBefore);
  assert.equal(g('branch', '--show-current').toString().trim(), branchBefore);
  assert.deepEqual(readFileSync(join(dir, '.git', 'index')), indexBefore);
  assert.deepEqual(g('diff', '--cached', '--name-only').toString().trim().split('\n'), ['staged.txt']);
});

test('snapshots: ignored and oversized files are excluded, oversized is reported', async () => {
  const dir = await repo();
  const g = (...a: string[]) => execFileSync('git', ['-C', dir, ...a], { stdio: 'pipe' });
  await writeFile(join(dir, '.gitignore'), 'big.bin\n');
  g('add', '.gitignore');
  g('commit', '-qm', 'ignore');
  await writeFile(join(dir, 'big.bin'), Buffer.alloc(4096, 1));
  await writeFile(join(dir, 'fat.txt'), Buffer.alloc(4096, 2));
  await writeFile(join(dir, 'small.txt'), 'ok\n');
  const indexFile = join(dir, '..', 'snap-index');
  const s = await createSnapshot(dir, { uid: 'u2', turn: 1, indexFile, parent: null, maxFileBytes: 1024 });
  assert.deepEqual(s.skipped, ['fat.txt']);
  const names = g('ls-tree', '-r', '--name-only', s.commit).toString();
  assert.match(names, /small\.txt/);
  assert.doesNotMatch(names, /big\.bin/);
  assert.doesNotMatch(names, /fat\.txt/);
  // Excluded files are never deleted by a restore either: they are in no snapshot.
  await writeFile(join(dir, 'small.txt'), 'changed\n');
  const safety = await createSnapshot(dir, { uid: 'u2', turn: 2, indexFile, parent: s.commit, maxFileBytes: 1024 });
  await restoreSnapshot(dir, { target: s.commit, current: safety.commit, indexFile });
  assert.equal(await readFile(join(dir, 'small.txt'), 'utf8'), 'ok\n');
  assert.equal(existsSync(join(dir, 'fat.txt')), true);
  assert.equal(existsSync(join(dir, 'big.bin')), true);
});

test('snapshots: repo with no commits yet', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ah-git-'));
  const dir = join(parent, 'fresh');
  const idx = join(parent, 'idx');
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  await writeFile(join(dir, 'new.txt'), 'fresh\n');
  const s1 = await createSnapshot(dir, { uid: 'u3', turn: 1, indexFile: idx, parent: null, maxFileBytes: 1024 });
  const names = execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', s1.commit], { stdio: 'pipe' }).toString();
  assert.match(names, /new\.txt/);
  // No HEAD to parent to: the snapshot commit is a root commit.
  const parents = execFileSync('git', ['-C', dir, 'rev-list', '--parents', '-n', '1', s1.commit], { stdio: 'pipe' }).toString().trim().split(' ');
  assert.equal(parents.length, 1);
  await writeFile(join(dir, 'new.txt'), 'edited\n');
  const s2 = await createSnapshot(dir, { uid: 'u3', turn: 2, indexFile: idx, parent: s1.commit, maxFileBytes: 1024 });
  await writeFile(join(dir, 'new.txt'), 'broken\n');
  const safety = await createSnapshot(dir, { uid: 'u3', turn: 3, indexFile: idx, parent: s2.commit, maxFileBytes: 1024 });
  await restoreSnapshot(dir, { target: s2.commit, current: safety.commit, indexFile: idx });
  assert.equal(await readFile(join(dir, 'new.txt'), 'utf8'), 'edited\n');
});

test('snapshots restore file/directory transitions and retain tracked files matched by ignore rules', async () => {
  const dir = await repo();
  const indexFile = join(dir, '..', 'transition-index');
  const snapshot = (turn: number, parent: string | null) => createSnapshot(dir, { uid: 'transitions', turn, indexFile, parent, maxFileBytes: 1024 });
  await writeFile(join(dir, '.gitignore'), 'a.txt\n');
  const file = await snapshot(1, null);
  assert.match(execFileSync('git', ['-C', dir, 'ls-tree', '-r', '--name-only', file.commit], { encoding: 'utf8' }), /a\.txt/);
  await rm(join(dir, 'a.txt'));
  await mkdir(join(dir, 'a.txt'));
  await writeFile(join(dir, 'a.txt', 'child'), 'child\n');
  // Clear the ignore rule so the new directory can be captured.
  await writeFile(join(dir, '.gitignore'), '');
  const directory = await snapshot(2, file.commit);
  await restoreSnapshot(dir, { target: file.commit, current: directory.commit, indexFile });
  assert.equal(await readFile(join(dir, 'a.txt'), 'utf8'), 'hello\n');
  const safety = await snapshot(3, directory.commit);
  await restoreSnapshot(dir, { target: directory.commit, current: safety.commit, indexFile });
  assert.equal(await readFile(join(dir, 'a.txt', 'child'), 'utf8'), 'child\n');
});
