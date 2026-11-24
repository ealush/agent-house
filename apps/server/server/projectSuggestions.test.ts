import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSuggestions } from './api/lifecycle.ts';
import { canonicalProjectDir, projectOf, shortPath } from './sessions.ts';
import { listSpaces } from './spaces/model.ts';
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

test('projectOf maps deleted and live managed worktrees to their main repository, never a worktree slug', () => {
  const deletedWorktree = '/tmp/code/.worktrees/agent-house/claude-8a5d';
  assert.equal(canonicalProjectDir(deletedWorktree), '/tmp/code/agent-house');
  assert.deepEqual(projectOf(deletedWorktree), {
    project: 'agent-house',
    projectPath: '/tmp/code/agent-house',
  });
  assert.deepEqual(projectOf('/tmp/code/.worktrees/agent-house/gemini-5d7b/apps/ios'), {
    project: 'agent-house',
    projectPath: '/tmp/code/agent-house',
  });
});

test('listSpaces drops orphaned worktree slugs and ephemeral cache dirs while keeping virtual Spaces', () => {
  const spaces = listSpaces({
    plain: [{ name: 'Launch Q1', path: '~/spaces/Launch Q1', at: 100 }],
    live: [],
    history: [
      { project: 'agent-house', projectPath: '~/code/agent-house', at: 200 },
      { project: 'claude-8a5d', projectPath: '~/code/.worktrees/agent-house/claude-8a5d', at: 190 },
      { project: 'gemini-5d7b', projectPath: null, at: 180 },
      { project: 'home-ealush-.cache-ah-uploads', projectPath: '~/.cache/ah/uploads', at: 170 },
      { project: 'home-ealush-.cache-ah-probe', projectPath: null, at: 165 },
      // A real repository whose name happens to look like a worktree slug stays.
      { project: 'codex-cafe', projectPath: '~/code/codex-cafe', at: 160 },
    ],
    removed: [],
    kindOf: (p) => (p?.startsWith('~/spaces/') ? 'space' : p?.includes('/code/') ? 'repo' : 'folder'),
    exists: () => true,
  });
  assert.deepEqual(
    spaces.map((s) => s.name),
    ['agent-house', 'codex-cafe', 'Launch Q1'],
  );
});
