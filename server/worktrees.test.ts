import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Core, type State } from './core.ts';
import { createWorktree, removeWorktree } from './git.ts';

// Exercise Core's cleanup policy independently of tmux timing and the database.
test('bulk cleanup protects live registry ownership and ended resumable sessions', async () => {
  // Worktrees go beside the repository (<parent>/.worktrees/<repo>): both inside one temp
  // dir, removed after, so a run leaves nothing in /tmp.
  const parent = await mkdtemp(join(tmpdir(), 'ah-worktree-policy-'));
  const dir = join(parent, 'repo');
  await mkdir(dir);
  execFileSync('git', ['init', '-q', '-b', 'main', dir]);
  execFileSync('git', ['-C', dir, 'config', 'user.email', 't@t']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 't']);
  await writeFile(join(dir, 'a'), 'a');
  execFileSync('git', ['-C', dir, 'add', '.']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'init']);
  const wt = await createWorktree(dir, 'Saved');
  const owner = { id: 'owner', title: 'Saved', lifecycle: 'live', harnessId: undefined as string | undefined, lastActivityAt: 1, meta: { 'ah.worktree': wt } };
  const state = { windows: [{ uid: 'owner', id: '@1', name: 'Saved', cwd: dir }] } as State;
  const core = Object.create(Core.prototype) as Core;
  Object.assign(core, { registry: { all: () => [owner], get: () => owner }, current: async () => state, tick: async () => state });
  try {
    assert.equal((await core.worktrees())[0].orphan, false, 'registry ownership protects a live session after cd');
    assert.equal((await core.removeWorktreesBulk([wt.path], []))[0].ok, false);
    state.windows = [];
    owner.lifecycle = 'ended';
    owner.harnessId = 'saved-conversation';
    assert.equal((await core.worktrees())[0].orphan, false, 'saved conversation is not an orphan');
    assert.equal((await core.removeWorktreesBulk([wt.path], []))[0].ok, false);
    owner.harnessId = undefined;
    assert.equal((await core.worktrees())[0].orphan, true);
    assert.equal((await core.removeWorktreesBulk([wt.path], []))[0].ok, true);
  } finally {
    await removeWorktree(wt.path, true).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  }
});
