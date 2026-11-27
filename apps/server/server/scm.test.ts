import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SourceControl, checksWord, pullOf, type RepoPull } from './scm.ts';

const pr = (number: number, head: string, state: string, more: Partial<RepoPull> = {}): RepoPull => ({ number, url: `https://github.com/o/r/pull/${number}`, state, draft: false, head, crossRepo: false, checks: null, ...more });

test("a branch's pull request: its open one over older merged ones, never a fork's", () => {
  const pulls = [pr(9, 'feat', 'MERGED'), pr(12, 'feat', 'OPEN', { checks: 'fail' }), pr(15, 'feat', 'OPEN', { crossRepo: true }), pr(3, 'other', 'CLOSED')];
  assert.deepEqual(pullOf(pulls, 'feat'), { number: 12, url: 'https://github.com/o/r/pull/12', state: 'open', checks: 'fail' });
  assert.equal(pullOf(pulls, 'other')?.state, 'closed');
  assert.equal(pullOf(pulls, 'nope'), null);
  assert.equal(pullOf(pulls, null), null, 'a detached head has none');
  assert.equal(pullOf([pr(4, 'd', 'OPEN', { draft: true })], 'd')?.state, 'draft');
  assert.equal(pullOf([pr(4, 'm', 'MERGED'), pr(7, 'm', 'MERGED')], 'm')?.number, 7, 'the newest of those that ended');
});

test('checks in one word: a failure fails it, a running one keeps it pending', () => {
  assert.equal(checksWord({ pass: 3, fail: 1, pending: 2 }), 'fail');
  assert.equal(checksWord({ pass: 3, fail: 0, pending: 1 }), 'pending');
  assert.equal(checksWord({ pass: 3, fail: 0, pending: 0 }), 'pass');
  assert.equal(checksWord({ pass: 0, fail: 0, pending: 0 }), null);
});

test('read in the background, kept a while, one gh call per repository for all its sessions', async () => {
  let clock = 1_000_000;
  const calls = { dirty: [] as string[], pulls: [] as string[] };
  let dirty = 2;
  const scm = new SourceControl(
    {
      dirty: async (root) => (calls.dirty.push(root), dirty),
      pulls: async (main) => (calls.pulls.push(main), [pr(5, 'a', 'OPEN', { draft: true }), pr(6, 'b', 'MERGED')]),
    },
    () => clock,
  );
  const a = { uid: 'u1', root: '/r/.worktrees/a', main: '/r', branch: 'a' };
  const b = { uid: 'u2', root: '/r/.worktrees/b', main: '/r', branch: 'b' };
  assert.equal(scm.peek(a), null, 'nothing until it has been read');
  await scm.refresh([a, b]);
  assert.deepEqual(scm.peek(a), { dirty: 2, pull: { number: 5, url: 'https://github.com/o/r/pull/5', state: 'draft', checks: null } });
  assert.equal(scm.peek(b)?.pull?.state, 'merged');
  assert.deepEqual(calls.pulls, ['/r'], 'one list for both branches');
  dirty = 0;
  clock += 5_000;
  await scm.refresh([a, b]);
  assert.equal(calls.dirty.length, 2, 'fresh: not read again');
  clock += 6_000;
  await scm.refresh([a, b]);
  assert.equal(scm.peek(a)?.dirty, 0, 'stale: read again');
  assert.equal(calls.pulls.length, 1, 'pull requests are kept longer');
  await scm.refresh([a]);
  await scm.refresh([a, b]);
  assert.equal(calls.dirty.filter((r) => r === b.root).length, 3, 'a checkout no session is in is forgotten');
});

test("gh that can't answer keeps what it said last, and isn't asked every minute", async () => {
  let clock = 0;
  let answer: RepoPull[] | null = [pr(1, 'x', 'OPEN')];
  let asked = 0;
  const scm = new SourceControl({ dirty: async () => 0, pulls: async () => (asked++, answer) }, () => clock);
  const t = { uid: 'u', root: '/r', main: '/r', branch: 'x' };
  await scm.refresh([t]);
  answer = null;
  clock += 61_000;
  await scm.refresh([t]);
  assert.equal(scm.peek(t)?.pull?.number, 1);
  clock += 61_000;
  await scm.refresh([t]);
  assert.equal(asked, 2, 'after a failure, asked again in minutes, not each one');
});

test("a real checkout's uncommitted files, untracked ones too", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-scm-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  await writeFile(join(dir, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-qm', 'a');
  const scm = new SourceControl({ pulls: async () => null });
  const t = { uid: 'u', root: dir, main: dir, branch: 'main' };
  await scm.refresh([t]);
  assert.deepEqual(scm.peek(t), { dirty: 0, pull: null });
  await writeFile(join(dir, 'a.txt'), 'changed');
  await writeFile(join(dir, 'new.txt'), 'new');
  const fresh = new SourceControl({ pulls: async () => null });
  await fresh.refresh([t]);
  assert.equal(fresh.peek(t)?.dirty, 2);
});

test('a repository with no remote has no pull requests, and gh is never asked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-scm-'));
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', repo, bin]);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  // A gh that leaves a mark when it runs.
  await writeFile(join(bin, 'gh'), `#!/bin/sh\ntouch "${join(dir, 'gh-ran')}"\necho '[]'\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const scm = new SourceControl();
    const t = { uid: 'u', root: repo, main: repo, branch: 'main' };
    await scm.refresh([t]);
    assert.deepEqual(scm.peek(t), { dirty: 0, pull: null });
    assert.equal(existsSync(join(dir, 'gh-ran')), false);
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/o/r.git'], { cwd: repo });
    await new SourceControl().refresh([t]);
    assert.equal(existsSync(join(dir, 'gh-ran')), true, 'with a remote, gh is asked');
  } finally {
    process.env.PATH = path;
  }
});
