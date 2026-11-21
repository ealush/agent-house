import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archiveName, listSpaces, memoryFile, removedView, shown, spaceName, startingFiles, stillRemoved, type Removed } from './spaces/model.ts';

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

test('the list: plain Spaces even when empty, sessions and History counted by name, removed ones left out', () => {
  const spaces = listSpaces({
    plain: [{ name: 'Trips', path: '~/spaces/Trips', at: 5 }],
    live: [{ project: 'ah', projectPath: '~/code/ah', at: 50 }, { project: 'Trips', projectPath: '~/spaces/Trips', at: 40 }],
    history: [
      { project: 'ah', projectPath: '~/code/ah', at: 30 },
      { project: 'ah', projectPath: null, at: 60 },
      { project: 'askprobe', projectPath: '/tmp/askprobe', at: 10 },
      { project: 'old', projectPath: '~/code/old', at: 9 },
      { project: '', projectPath: null, at: 1 },
    ],
    removed: [removed('old', ['r1'])],
    kindOf: (p) => (p === '~/code/ah' ? 'repo' : 'folder'),
    exists: (p) => p !== '/tmp/askprobe',
  });
  assert.deepEqual(spaces, [
    { name: 'ah', kind: 'repo', path: '~/code/ah', exists: true, live: 1, conversations: 2, lastActivityAt: 60 },
    { name: 'askprobe', kind: 'folder', path: '/tmp/askprobe', exists: false, live: 0, conversations: 1, lastActivityAt: 10 },
    { name: 'Trips', kind: 'space', path: '~/spaces/Trips', exists: true, live: 1, conversations: 0, lastActivityAt: 40 },
  ]);
});

test('a removal hides the conversations it saw; a new one, or a session started since, brings the Space back', () => {
  const r = removed('scratch', ['a', 'b'], 100);
  assert.equal(shown([r], { project: 'scratch', ref: 'a' }), false);
  assert.equal(shown([r], { project: 'scratch', ref: 'c' }), true);
  assert.equal(shown([r], { project: 'other', ref: 'a' }), true);
  assert.deepEqual(stillRemoved([r], [], [{ project: 'scratch', ref: 'a' }]), [r], 'what it hid, touched since, is still hidden');
  assert.deepEqual(stillRemoved([r], [], [{ project: 'scratch', ref: 'c' }]), [], 'a conversation it never saw');
  assert.deepEqual(stillRemoved([r], [{ project: 'scratch', createdAt: 90 }], []), [r], 'a window from before, ending as it was removed');
  assert.deepEqual(stillRemoved([r], [{ project: 'scratch', createdAt: 100 }], []), [], 'a session started since (the same second counts)');
});

test("a removed plain Space's folder takes the next free name in the archive; the view keeps its refs and path to itself", () => {
  assert.equal(archiveName('Trips', () => false), 'Trips');
  const taken = new Set(['Trips', 'Trips 2']);
  assert.equal(archiveName('Trips', (c) => taken.has(c)), 'Trips 3');
  const v = removedView({ ...removed('Trips', ['a']), kind: 'space', archive: '/h/spaces/.archive/Trips' });
  assert.deepEqual(v, { name: 'Trips', kind: 'space', path: '/x/Trips', removedAt: 100, conversations: 1, archived: true });
});

test("a removal hides every conversation the Space has, not only the newest History shows; an older one coming into view doesn't bring it back", async () => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { SpacesService } = await import('./spaces/service.ts');
  const { nodeSpaceFs } = await import('./spaces/files.ts');
  const dir = await mkdtemp(join(tmpdir(), 'ah-spaces-'));
  // History shows the newest only ('new'); the Space also has 'old', past the cut.
  const spaces = new SpacesService({
    root: join(dir, 'spaces'),
    stateFile: join(dir, 'spaces.json'),
    fs: nodeSpaceFs,
    current: async () => ({ live: [], history: [{ project: 'busy-repo', projectPath: '/x/busy-repo', at: 50 }] }),
    isRepo: () => true,
    shortPath: (p) => p,
    expandHome: (p) => p,
    refresh: async () => {},
    refsIn: async () => ['new', 'old'],
    now: () => 100,
  });
  const removed = await spaces.remove('busy-repo');
  assert.equal(removed.conversations, 2, 'all of them, counted');
  const show = spaces.historyFilter([]);
  assert.equal(show({ project: 'busy-repo', ref: 'new' }), false);
  assert.equal(show({ project: 'busy-repo', ref: 'old' }), false, 'the older one, now in view, is hidden too');
  assert.equal((await spaces.list()).removed.length, 1, 'and the Space stays removed');
  assert.equal(spaces.historyFilter([])({ project: 'busy-repo', ref: 'brand-new' }), true);
  assert.equal((await spaces.list()).removed.length, 0, 'a conversation it never had brings it back');
  await spaces.flushed();
});
