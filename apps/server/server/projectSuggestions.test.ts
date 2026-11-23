import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSuggestions } from './api/lifecycle.ts';
import { shortPath } from './sessions.ts';
import type { Config } from './config.ts';

test("New session's folders: the project roots' folders and the windows' own, never a folder that's gone", async () => {
  const root = await mkdtemp(join(tmpdir(), 'ah-projects-'));
  await mkdir(join(root, 'vest'));
  await mkdir(join(root, '.worktrees'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'ah-window-'));
  // A project root's folders come back as `~/…` when they're under the home directory (and
  // a temp dir can be), so compare against the shortened form.
  const got = await projectSuggestions({ projectRoots: [root] } as Config, [elsewhere, join(root, 'ah-native')]);
  assert.ok(got.includes(shortPath(join(root, 'vest'))), 'a folder in a project root');
  assert.ok(got.includes(elsewhere), "a live window's folder");
  assert.ok(!got.includes(join(root, 'ah-native')), 'a window whose folder was deleted under it');
  assert.ok(!got.some((p) => p.endsWith('/.worktrees')), 'hidden folders stay hidden');
  assert.ok(got.includes('~'));
});

test("New session's folders: a window in a managed worktree offers its repository, not the worktree", async () => {
  const parent = await mkdtemp(join(tmpdir(), 'ah-code-'));
  await mkdir(join(parent, 'ah'));
  const worktree = join(parent, '.worktrees', 'ah', 'claude-cbef');
  await mkdir(join(worktree, 'apps'), { recursive: true });
  const got = await projectSuggestions({ projectRoots: [] } as unknown as Config, [worktree, join(worktree, 'apps')]);
  assert.ok(!got.some((p) => p.includes('/.worktrees/')), 'no worktree, nor a folder inside one');
  assert.ok(got.includes(join(parent, 'ah')), "the worktree's repository");
  assert.equal(got.filter((p) => p === join(parent, 'ah')).length, 1);
});
