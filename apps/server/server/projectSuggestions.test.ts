import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSuggestions } from './api/lifecycle.ts';
import type { Config } from './config.ts';

test("New session's folders: the project roots' folders and the windows' own, never a folder that's gone", async () => {
  const root = await mkdtemp(join(tmpdir(), 'ah-projects-'));
  await mkdir(join(root, 'vest'));
  await mkdir(join(root, '.worktrees'));
  const elsewhere = await mkdtemp(join(tmpdir(), 'ah-window-'));
  const got = await projectSuggestions({ projectRoots: [root] } as Config, [elsewhere, join(root, 'ah-native')]);
  assert.ok(got.includes(join(root, 'vest')), 'a folder in a project root');
  assert.ok(got.includes(elsewhere), "a live window's folder");
  assert.ok(!got.includes(join(root, 'ah-native')), 'a window whose folder was deleted under it');
  assert.ok(!got.includes(join(root, '.worktrees')), 'hidden folders stay hidden');
  assert.ok(got.includes('~'));
});
