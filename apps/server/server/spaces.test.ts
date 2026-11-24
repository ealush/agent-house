import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveName, listSpaces, memoryFile, projectPathOf, removedView, shown, spaceFor, spaceName, startingFiles, stillRemoved, type Removed } from './spaces/model.ts';

const removed = (name: string, refs: string[], removedAt = 100): Removed => ({ name, kind: 'folder', path: `/x/${name}`, removedAt, conversations: refs.length, archive: null, refs });

test("a Space's name is its folder's: no separators, no dot or space first, 64 at most", () => {
  for (const ok of ['Trips', 'Reading list', 'q4-plan', 'v1.2', '_inbox']) assert.equal(spaceName(ok), ok);
  for (const bad of ['', '.hidden', ' lead', 'trail ', 'a/b', 'a\\b', '..', 'a..b', 'x'.repeat(65), 7, null]) {
    assert.throws(() => spaceName(bad), (e: any) => e.code === 'invalid_space_name' && e.status === 400, String(bad));
  }
});

test('a memory file is a Markdown file directly in memory/', () => {
  assert.equal(memoryFile('japan.md'), 'japan.md');
  for (const bad of ['japan.txt', '../japan.md', 'a/b.md', '.md', '.hidden.md', 'x'.repeat(80) + '.md']) {
    assert.throws(() => memoryFile(bad), (e: any) => e.code === 'invalid_memory_file', bad);
  }
});

test("a new Space's files: AGENTS.md for every agent, CLAUDE.md and GEMINI.md importing it, the memory's index", () => {
  const files = startingFiles('Trips');
  assert.deepEqual(files.map((f) => f.file), ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'memory/MEMORY.md']);
  assert.match(files[0].text, /^# Trips\n/);
  assert.match(files[0].text, /read `memory\/MEMORY\.md`/);
  assert.match(files[0].text, /Never write secrets/);
  assert.equal(files[1].text, '@AGENTS.md\n');
  assert.equal(startingFiles('Trips', 'Short answers.')[0].text, 'Short answers.', 'given preferences are the whole file');
  assert.match(startingFiles('Trips', '   ')[0].text, /^# Trips/, 'blank preferences are none');
});

test('the list: only the Spaces made in the Spaces folder, even empty; each counts the sessions and History in it; removed ones left out', () => {
  const spaces = listSpaces({
    plain: [
      { name: 'Trips', path: '~/spaces/Trips', at: 5 },
      { name: 'Agent House', path: '~/spaces/Agent House', at: 6 },
      { name: 'old', path: '~/spaces/old', at: 7 },
    ],
    live: [
      { space: null, projectPath: '~/code/ah', at: 50 },
      { space: 'Trips', projectPath: '~/spaces/Trips', at: 40 },
      { space: 'Agent House', projectPath: '~/code/agent-house', at: 45 },
    ],
    history: [
      { space: 'Agent House', projectPath: '~/code/ah-native', at: 30 },
      { space: 'Agent House', projectPath: null, at: 60 },
      { space: null, projectPath: '/tmp/askprobe', at: 10 },
      { space: 'old', projectPath: '~/spaces/old', at: 9 },
      { space: 'Nowhere', projectPath: null, at: 1 },
    ],
    removed: [removed('old', ['r1'])],
    exists: () => true,
  });
  assert.deepEqual(spaces, [
    { name: 'Agent House', kind: 'space', path: '~/spaces/Agent House', exists: true, live: 1, conversations: 2, lastActivityAt: 60 },
    { name: 'Trips', kind: 'space', path: '~/spaces/Trips', exists: true, live: 1, conversations: 0, lastActivityAt: 40 },
  ], 'a repository or a folder is a project, never a Space; a Space nobody made is none');
});

test("a session's Space: the one it was put in, else its project's, else none; taken out of every Space, it's in none", () => {
  const attached = new Map([['~/code/agent-house', 'Agent House']]);
  assert.equal(spaceFor('Trips', '~/code/agent-house', attached), 'Trips', 'put in one: that one');
  assert.equal(spaceFor(undefined, '~/code/agent-house', attached), 'Agent House', "never put in one: its project's");
  assert.equal(spaceFor(null, '~/code/agent-house', attached), null, 'taken out of every Space');
  assert.equal(spaceFor(undefined, '~/code/other', attached), null, 'a project in no Space');
  assert.equal(spaceFor(undefined, null, attached), null);
});

test('a project is a folder: absolute or under ~, never through ..', () => {
  assert.equal(projectPathOf('~/code/ah/'), '~/code/ah');
  assert.equal(projectPathOf('/srv/app'), '/srv/app');
  for (const bad of ['', 'code/ah', '~/code/../etc', 7, null, 'x'.repeat(1025)]) {
    assert.throws(() => projectPathOf(bad), (e: any) => e.code === 'invalid_project' && e.status === 400, String(bad));
  }
});

test('a removal hides the conversations it saw; a new one, or a session started since, brings the Space back', () => {
  const r = removed('scratch', ['a', 'b'], 100);
  assert.equal(shown([r], { space: 'scratch', ref: 'a' }), false);
  assert.equal(shown([r], { space: 'scratch', ref: 'c' }), true);
  assert.equal(shown([r], { space: null, ref: 'a' }), false, 'hidden by its ref, wherever it is now');
  assert.equal(shown([r], { space: 'other', ref: 'z' }), true);
  assert.deepEqual(stillRemoved([r], [], [{ space: 'scratch', ref: 'a' }]), [r], 'what it hid, touched since, is still hidden');
  assert.deepEqual(stillRemoved([r], [], [{ space: 'scratch', ref: 'c' }]), [], 'a conversation it never saw');
  assert.deepEqual(stillRemoved([r], [{ space: 'scratch', createdAt: 90 }], []), [r], 'a window from before, ending as it was removed');
  assert.deepEqual(stillRemoved([r], [{ space: 'scratch', createdAt: 100 }], []), [], 'a session started since (the same second counts)');
});

test("a removed plain Space's folder takes the next free name in the archive; the view keeps its refs and path to itself", () => {
  assert.equal(archiveName('Trips', () => false), 'Trips');
  const taken = new Set(['Trips', 'Trips 2']);
  assert.equal(archiveName('Trips', (c) => taken.has(c)), 'Trips 3');
  const v = removedView({ ...removed('Trips', ['a']), kind: 'space', archive: '/h/spaces/.archive/Trips' });
  assert.deepEqual(v, { name: 'Trips', kind: 'space', path: '/x/Trips', removedAt: 100, conversations: 1, archived: true });
});

test("a removal hides every conversation the Space has, not only the newest History shows; an older one coming into view doesn't bring it back", async () => {
  const { mkdtemp, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SpacesService } = await import('./spaces/service.ts');
  const { nodeSpaceFs } = await import('./spaces/files.ts');
  const dir = await mkdtemp(join(tmpdir(), 'ah-spaces-'));
  await mkdir(join(dir, 'spaces', 'busy'), { recursive: true });
  // History shows the newest only ('new'); the Space also has 'old', past the cut.
  const spaces = new SpacesService({
    root: join(dir, 'spaces'),
    stateFile: join(dir, 'spaces.json'),
    fs: nodeSpaceFs,
    current: async () => ({ live: [{ space: 'busy', projectPath: '/x/elsewhere', at: 60 }], history: [{ space: 'busy', projectPath: '/x/busy-repo', at: 50 }] }),
    isRepo: () => false,
    projectOf: (p) => p,
    shortPath: (p) => p,
    expandHome: (p) => p,
    refresh: async () => {},
    refsIn: async () => ['new', 'old'],
    now: () => 100,
  });
  const removed = await spaces.remove('busy');
  assert.equal(removed.conversations, 2, 'all of them, counted; a session of it working elsewhere just leaves it');
  assert.equal(removed.archived, true, 'its folder went to the archive');
  const show = spaces.historyFilter([]);
  assert.equal(show({ space: 'busy', ref: 'new' }), false);
  assert.equal(show({ space: 'busy', ref: 'old' }), false, 'the older one, now in view, is hidden too');
  assert.equal((await spaces.list()).removed.length, 1, 'and the Space stays removed');
  assert.equal(spaces.historyFilter([])({ space: 'busy', ref: 'brand-new' }), true);
  assert.equal((await spaces.list()).removed.length, 0, 'a conversation it never had brings it back');
  await spaces.flushed();
});

test('projects attach to one Space: a session in one is in that Space; attaching it elsewhere moves it; a removed Space attaches nothing', async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SpacesService } = await import('./spaces/service.ts');
  const { nodeSpaceFs } = await import('./spaces/files.ts');
  const dir = await mkdtemp(join(tmpdir(), 'ah-spaces-'));
  const spaces = new SpacesService({
    root: join(dir, 'spaces'),
    stateFile: join(dir, 'spaces.json'),
    fs: nodeSpaceFs,
    current: async () => ({ live: [], history: [] }),
    isRepo: () => false,
    // A worktree stands for its repository.
    projectOf: (p) => p.replace(/\/\.worktrees\/([^/]+)\/[^/]+$/, '/$1'),
    shortPath: (p) => p,
    expandHome: (p) => p,
    refresh: async () => {},
    refsIn: async () => [],
    now: () => 100,
  });
  const house = await spaces.create('Agent House', undefined, ['/code/agent-house', '/code/.worktrees/ah-native/claude-1234']);
  assert.deepEqual(house.projects, ['/code/agent-house', '/code/ah-native']);
  assert.equal(spaces.spaceForDir('/code/agent-house'), 'Agent House');
  assert.equal(spaces.spaceForDir('/code/.worktrees/agent-house/gemini-8fae'), 'Agent House', "a worktree is in its repository's Space");
  assert.equal(spaces.spaceForDir('/code/other'), null, 'a project attached to none');
  assert.equal(spaces.spaceFor(undefined, '/code/ah-native'), 'Agent House');
  assert.equal(spaces.spaceFor(null, '/code/ah-native'), null, 'taken out of every Space');
  await spaces.create('Native');
  const native = await spaces.setProjects('Native', ['/code/ah-native']);
  assert.deepEqual(native.projects, ['/code/ah-native']);
  assert.deepEqual((await spaces.list()).spaces.find((s) => s.name === 'Agent House')?.projects, ['/code/agent-house'], 'moved, not shared');
  assert.equal(spaces.spaceFor(undefined, '/code/ah-native'), 'Native');
  await assert.rejects(spaces.setProjects('Nope', []), (e: any) => e.code === 'space_not_found');
  await assert.rejects(spaces.setProjects('Native', ['relative/path']), (e: any) => e.code === 'invalid_project');
  await spaces.remove('Native');
  assert.equal(spaces.spaceFor(undefined, '/code/ah-native'), null, 'a removed Space attaches nothing');
  await spaces.restore('Native');
  assert.equal(spaces.spaceFor(undefined, '/code/ah-native'), 'Native', 'restored with its projects');
  assert.equal(await spaces.has('Native'), true);
  assert.equal(await spaces.has('Nope'), false);
  // Kept across a restart.
  await spaces.flushed();
  const again = new SpacesService({ root: join(dir, 'spaces'), stateFile: join(dir, 'spaces.json'), fs: nodeSpaceFs, current: async () => ({ live: [], history: [] }), isRepo: () => false, projectOf: (p) => p, shortPath: (p) => p, expandHome: (p) => p, refresh: async () => {}, refsIn: async () => [] });
  await again.load();
  assert.equal(again.spaceFor(undefined, '/code/agent-house'), 'Agent House');
});
