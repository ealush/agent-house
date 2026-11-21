// Spaces, black box, on stand-in agents (docs/spec/17-spaces.md): a plain Space made over
// HTTP with the files every agent reads, its preferences and memory, sessions in it,
// removing it (refused while one runs; archived, hidden from History and New session),
// restoring it, a removed folder coming back when it's used again, and a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed } from './fake-agents.ts';

const state = async (ah: { port: number }) => (await http(ah as any, 'GET', '/api/state')).json();
const list = async (ah: { port: number }) => (await http(ah as any, 'GET', '/api/spaces')).json();

test('a plain Space: made with its files, preferences and memory, sessions in it, removed and restored', async () => {
  let ah = await startBed();
  try {
    assert.equal((await http(ah, 'GET', '/api/hello')).json().features.spaces, 1);
    const rev0 = (await state(ah)).spaces.revision;
    const home = join(ah.dir, 'home');

    const made = await http(ah, 'POST', '/api/spaces', { body: { name: 'Trips' } });
    assert.equal(made.status, 201, made.body);
    assert.deepEqual(made.json().space, { name: 'Trips', kind: 'space', path: '~/spaces/Trips', exists: true, live: 0, conversations: 0, lastActivityAt: 0 });
    const dir = join(home, 'spaces', 'Trips');
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /memory\/MEMORY\.md/);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    assert.equal(readFileSync(join(dir, 'GEMINI.md'), 'utf8'), '@AGENTS.md\n');
    assert.ok(existsSync(join(dir, 'memory', 'MEMORY.md')));
    assert.ok((await state(ah)).spaces.revision > rev0, 'the state says the list changed');
    assert.ok((await http(ah, 'GET', '/api/projects')).json().includes('~/spaces/Trips'), 'New session offers it');

    const l = await list(ah);
    assert.equal(l.root, '~/spaces');
    assert.ok(l.spaces.some((s: any) => s.name === 'Trips' && s.kind === 'space'), 'an empty plain Space is listed');

    // Names, and one Space per name.
    for (const name of ['', '.hidden', ' lead', 'trail ', 'a/b', '..', 'x'.repeat(65)]) {
      assert.equal((await http(ah, 'POST', '/api/spaces', { body: { name } })).json().code, 'invalid_space_name', JSON.stringify(name));
    }
    assert.equal((await http(ah, 'POST', '/api/spaces', { body: { name: 'trips' } })).json().code, 'space_exists');
    const own = await http(ah, 'POST', '/api/spaces', { body: { name: 'Reading list', preferences: '# Reading\n\nShort answers.' } });
    assert.equal(own.status, 201);
    assert.equal(readFileSync(join(home, 'spaces', 'Reading list', 'AGENTS.md'), 'utf8'), '# Reading\n\nShort answers.');

    // Preferences: the whole AGENTS.md.
    const enc = encodeURIComponent('Reading list');
    assert.equal((await http(ah, 'GET', `/api/spaces/${enc}/preferences`)).json().text, '# Reading\n\nShort answers.');
    const put = await http(ah, 'PUT', `/api/spaces/${enc}/preferences`, { body: { text: '# Reading\n\nLong answers.' } });
    assert.equal(put.status, 200);
    assert.equal(put.json().file, 'AGENTS.md');
    assert.equal(readFileSync(join(home, 'spaces', 'Reading list', 'AGENTS.md'), 'utf8'), '# Reading\n\nLong answers.');
    assert.equal((await http(ah, 'PUT', `/api/spaces/${enc}/preferences`, { body: { text: 'x'.repeat(65_537) } })).json().code, 'preferences_too_long');

    // Memory: Markdown files in memory/, the index first.
    assert.equal((await http(ah, 'PUT', '/api/spaces/Trips/memory/japan.md', { body: { text: '# Japan\n\nOctober.' } })).status, 200);
    const mem = (await http(ah, 'GET', '/api/spaces/Trips/memory')).json().files;
    assert.deepEqual(mem.map((f: any) => f.name), ['MEMORY.md', 'japan.md']);
    assert.equal(mem[1].text, '# Japan\n\nOctober.');
    assert.notEqual((await http(ah, 'PUT', '/api/spaces/Trips/memory/..%2Fescape.md', { body: { text: 'x' } })).status, 200);
    assert.ok(!existsSync(join(dir, 'escape.md')), 'never outside memory/');
    assert.equal((await http(ah, 'PUT', '/api/spaces/Trips/memory/notes.txt', { body: { text: 'x' } })).json().code, 'invalid_memory_file');
    assert.equal((await http(ah, 'DELETE', '/api/spaces/Trips/memory/MEMORY.md')).json().code, 'memory_index');
    assert.equal((await http(ah, 'DELETE', '/api/spaces/Trips/memory/japan.md')).status, 200);
    assert.equal((await http(ah, 'DELETE', '/api/spaces/Trips/memory/japan.md')).json().code, 'memory_not_found');
    assert.equal((await http(ah, 'GET', '/api/spaces/Nowhere/memory')).json().code, 'space_not_found');

    // A session in the Space; a repository is a Space too, without ah's preferences.
    const s = await launch(ah, 'claude', dir, 'Plan Kyoto');
    assert.equal(s.project, 'Trips');
    await launch(ah, 'codex', ah.project, 'In the repo');
    const repo = (await list(ah)).spaces.find((x: any) => x.name === 'proj');
    assert.equal(repo.kind, 'repo');
    assert.equal((await http(ah, 'GET', '/api/spaces/proj/preferences')).json().code, 'not_a_plain_space');

    await say(ah, s.uid, 'first turn');
    assert.equal((await http(ah, 'POST', '/api/spaces/remove', { body: { name: 'Trips' } })).json().code, 'space_busy', 'refused while a session runs');
    assert.equal((await http(ah, 'POST', `/api/sessions/${s.uid}/terminate`)).status, 200);
    await until(async () => (await state(ah)).history.some((h: any) => h.project === 'Trips'), 15000, 'its conversation in History');

    // Removed: archived, out of History, the list and New session; nothing deleted.
    const rm = await http(ah, 'POST', '/api/spaces/remove', { body: { name: 'Trips' } });
    assert.equal(rm.status, 200, rm.body);
    assert.deepEqual([rm.json().removed.name, rm.json().removed.kind, rm.json().removed.archived, rm.json().removed.conversations], ['Trips', 'space', true, 1]);
    assert.ok(!existsSync(dir));
    assert.ok(existsSync(join(home, 'spaces', '.archive', 'Trips', 'AGENTS.md')), 'the folder, files and memory, in the archive');
    assert.ok(!(await state(ah)).history.some((h: any) => h.project === 'Trips'), 'its conversations are hidden');
    const after = await list(ah);
    assert.ok(!after.spaces.some((x: any) => x.name === 'Trips'));
    assert.equal(after.removed[0].name, 'Trips');
    assert.ok(!(await http(ah, 'GET', '/api/projects')).json().includes('~/spaces/Trips'));
    assert.equal((await http(ah, 'POST', '/api/spaces', { body: { name: 'Trips' } })).json().code, 'space_exists', "a removed Space's name is still its own");
    assert.equal((await http(ah, 'GET', '/api/spaces/Trips/preferences')).json().code, 'space_not_found');

    // Durable across a restart.
    ah = Object.assign(await ah.restart(), { bin: ah.bin, project: ah.project });
    assert.equal((await list(ah)).removed[0]?.name, 'Trips');
    assert.ok(!(await state(ah)).history.some((h: any) => h.project === 'Trips'));

    // Restored: the folder back, its conversations in History again.
    const back = await http(ah, 'POST', '/api/spaces/restore', { body: { name: 'Trips' } });
    assert.equal(back.status, 200, back.body);
    assert.equal(back.json().space.name, 'Trips');
    assert.ok(existsSync(join(dir, 'AGENTS.md')));
    assert.ok((await state(ah)).history.some((h: any) => h.project === 'Trips' && h.title === 'Plan Kyoto'));
    assert.equal((await http(ah, 'POST', '/api/spaces/restore', { body: { name: 'Trips' } })).json().code, 'space_not_found');
  } finally {
    await cleanup(ah);
  }
});

test('a removed folder Space comes back when a session starts in it, with what it had', async () => {
  const ah = await startBed();
  try {
    const scratch = join(ah.dir, 'files', 'scratch');
    mkdirSync(scratch);
    const s = await launch(ah, 'claude', scratch, 'Old idea');
    await say(ah, s.uid, 'first turn');
    assert.equal((await http(ah, 'POST', `/api/sessions/${s.uid}/terminate`)).status, 200);
    await until(async () => (await state(ah)).history.some((h: any) => h.project === 'scratch'), 15000, 'in History');

    const rm = await http(ah, 'POST', '/api/spaces/remove', { body: { name: 'scratch' } });
    assert.equal(rm.json().removed.kind, 'folder');
    assert.equal(rm.json().removed.archived, false);
    assert.ok(existsSync(scratch), 'a folder is never moved');
    assert.ok(!(await state(ah)).history.some((h: any) => h.project === 'scratch'));
    assert.ok(!(await http(ah, 'GET', '/api/projects')).json().some((p: string) => p.endsWith('/scratch')));

    await launch(ah, 'codex', scratch, 'New idea');
    await until(async () => (await state(ah)).history.some((h: any) => h.title === 'Old idea'), 15000, 'the old conversation back');
    assert.deepEqual((await list(ah)).removed, []);
    assert.equal((await http(ah, 'POST', '/api/spaces/remove', { body: { name: 'nothing here' } })).json().code, 'space_not_found');
  } finally {
    await cleanup(ah);
  }
});
