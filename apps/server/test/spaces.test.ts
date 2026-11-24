// Spaces, black box, on stand-in agents (docs/spec/17-spaces.md): a Space made over HTTP with
// the files every agent reads, its preferences and memory, sessions in it (in its folder, from a
// project attached to it, put in by hand, taken out), removing it (refused while one runs in its
// folder; archived, hidden from History and New session), restoring it, and a restart.
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
    assert.equal((await http(ah, 'GET', '/api/hello')).json().features.spaces, 3);
    const rev0 = (await state(ah)).spaces.revision;
    const home = join(ah.dir, 'home');

    const made = await http(ah, 'POST', '/api/spaces', { body: { name: 'Trips' } });
    assert.equal(made.status, 201, made.body);
    const madeSpace = made.json().space;
    assert.match(madeSpace.id, /^sp-[0-9a-f]{8}$/);
    assert.equal(madeSpace.name, 'Trips');
    assert.equal(madeSpace.kind, 'space');
    assert.equal(madeSpace.path, '~/spaces/Trips');
    assert.equal(madeSpace.contextPath, '~/spaces/Trips');
    assert.equal(madeSpace.exists, true);
    const dir = join(home, 'spaces', 'Trips');
    assert.match(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), /memory\/MEMORY\.md/);
    assert.equal(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
    assert.equal(readFileSync(join(dir, 'GEMINI.md'), 'utf8'), '@AGENTS.md\n');
    assert.ok(existsSync(join(dir, 'memory', 'MEMORY.md')));
    assert.ok(existsSync(join(dir, 'artifacts')), 'artifacts/ directory created with the Space');
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

    // A session in the Space's own folder is in it.
    const s = await launch(ah, 'claude', dir, 'Plan Kyoto');
    await until(async () => (await state(ah)).windows.find((w: any) => w.uid === s.uid)?.space === 'Trips', 5000, 'in its own folder, in the Space');
    // A repository is a project, never a Space: in none until it's attached to one.
    const repoSess = await launch(ah, 'codex', ah.project, 'In the repo');
    assert.ok(!(await list(ah)).spaces.some((x: any) => x.name === 'proj'), 'the repository is no Space');
    assert.equal((await state(ah)).windows.find((w: any) => w.uid === repoSess.uid)?.space, undefined);
    const attached = await http(ah, 'PUT', `/api/spaces/${enc}/projects`, { body: { projects: [ah.project] } });
    assert.equal(attached.status, 200, attached.body);
    assert.equal(attached.json().space.projects.length, 1);
    await until(async () => (await state(ah)).windows.find((w: any) => w.uid === repoSess.uid)?.space === 'Reading list', 5000, "a session in an attached project is in its Space");
    assert.equal((await list(ah)).spaces.find((x: any) => x.name === 'Reading list').live, 1);
    assert.equal((await http(ah, 'PUT', '/api/spaces/Nowhere/projects', { body: { projects: [] } })).json().code, 'space_not_found');
    assert.equal((await http(ah, 'PUT', `/api/spaces/${enc}/projects`, { body: { projects: ['relative/x'] } })).json().code, 'invalid_project');
    assert.ok(!existsSync(join(ah.project, 'AGENTS.md')), "a Space's preferences never touch its projects");

    // Promote knowledge into Space memory and index in MEMORY.md, plus server-generated Chief brief.
    const promoted = await http(ah, 'POST', `/api/spaces/${enc}/knowledge/promote`, {
      body: { title: 'Auth architecture', markdown: 'Use P-256 device keys.', source: 'note:test' },
    });
    assert.equal(promoted.status, 201, promoted.body);
    assert.match(promoted.json().index.text, /auth-architecture\.md/);
    const brief = await http(ah, 'GET', `/api/spaces/${enc}/brief`);
    assert.equal(brief.status, 200);
    assert.match(brief.json().brief, /Chief of Staff for the "Reading list" Space/);

    // Put in another Space by hand, taken out of every one, and back to its project's.
    const moved = await http(ah, 'PUT', `/api/sessions/${repoSess.uid}/space`, { body: { space: 'Trips' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.json().space, 'Trips');
    await until(async () => (await state(ah)).windows.find((w: any) => w.uid === repoSess.uid)?.space === 'Trips', 5000, 'session reflects moved Space');
    const out = await http(ah, 'PUT', `/api/sessions/${repoSess.uid}/space`, { body: { space: '' } });
    assert.equal(out.json().space, null);
    await until(async () => !(await state(ah)).windows.find((w: any) => w.uid === repoSess.uid)?.space, 5000, 'in no Space, though its project is attached');
    assert.equal((await http(ah, 'PUT', `/api/sessions/${repoSess.uid}/space`, { body: { space: null } })).json().space, 'Reading list', "back to its project's");
    assert.equal((await http(ah, 'PUT', `/api/sessions/${repoSess.uid}/space`, { body: { space: 'Nowhere' } })).json().code, 'space_not_found');
    assert.equal((await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: ah.project, space: 'Nowhere' } })).json().code, 'space_not_found');

    await say(ah, s.uid, 'first turn');
    assert.equal((await http(ah, 'POST', '/api/spaces/remove', { body: { name: 'Trips' } })).json().code, 'space_busy', 'refused while a session runs in its folder');
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

test("a project's sessions follow it: attached, a worktree's too; moved to another Space; detached, in none; a removed Space attaches nothing", async () => {
  const ah = await startBed();
  try {
    const scratch = join(ah.dir, 'files', 'scratch');
    mkdirSync(scratch);
    const s = await launch(ah, 'claude', scratch, 'Old idea');
    await say(ah, s.uid, 'first turn');
    assert.equal((await http(ah, 'POST', `/api/sessions/${s.uid}/terminate`)).status, 200);
    await until(async () => (await state(ah)).history.some((h: any) => h.title === 'Old idea'), 15000, 'in History');
    assert.equal((await state(ah)).history.find((h: any) => h.title === 'Old idea').space, undefined, 'a folder in no Space');

    assert.equal((await http(ah, 'POST', '/api/spaces', { body: { name: 'Ideas', projects: [scratch] } })).status, 201);
    await until(async () => (await state(ah)).history.find((h: any) => h.title === 'Old idea')?.space === 'Ideas', 5000, 'its History follows its project');
    const hist = (await state(ah)).history.filter((h: any) => h.space === 'Ideas');
    assert.equal((await list(ah)).spaces.find((x: any) => x.name === 'Ideas').conversations, hist.length, JSON.stringify(hist.map((h: any) => [h.ref, h.title, h.cwd])));

    assert.equal((await http(ah, 'POST', '/api/spaces', { body: { name: 'Later' } })).status, 201);
    const moved = await http(ah, 'PUT', '/api/spaces/Later/projects', { body: { projects: [scratch] } });
    assert.equal(moved.status, 200, moved.body);
    assert.equal((await list(ah)).spaces.find((x: any) => x.name === 'Ideas').projects.length, 0, 'a project is in one Space');
    await until(async () => (await state(ah)).history.find((h: any) => h.title === 'Old idea')?.space === 'Later', 5000, 'moved with it');

    assert.equal((await http(ah, 'POST', '/api/spaces/remove', { body: { name: 'Later' } })).status, 200, 'its sessions elsewhere just leave it');
    await until(async () => !(await state(ah)).history.some((h: any) => h.title === 'Old idea' && h.space === 'Later'), 5000, 'a removed Space attaches nothing');
    assert.equal((await http(ah, 'POST', '/api/spaces/restore', { body: { name: 'Later' } })).status, 200);
    await until(async () => (await state(ah)).history.find((h: any) => h.title === 'Old idea')?.space === 'Later', 5000, 'restored with its projects');

    assert.equal((await http(ah, 'PUT', '/api/spaces/Later/projects', { body: { projects: [] } })).status, 200);
    await until(async () => !(await state(ah)).history.find((h: any) => h.title === 'Old idea')?.space, 5000, 'detached: in none');
    assert.equal((await http(ah, 'POST', '/api/spaces/remove', { body: { name: 'nothing here' } })).json().code, 'space_not_found');
  } finally {
    await cleanup(ah);
  }
});
