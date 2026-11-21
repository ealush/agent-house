// Scratchpads, black box, on stand-in agents (docs/spec/15-scratchpads.md): notes over
// HTTP with their conflicts and tombstones, the state stream's cursor, a restart, saving
// as SPEC.md in the project, and handing a note to idle, busy and ended sessions, each
// prompt arriving exactly once however often the device asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, transcriptOf, windows } from './fake-agents.ts';

const logOf = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const count = (file: string, text: string) => logOf(file).split('\n').filter((l) => l.includes(text)).length;

test('notes over HTTP: create, change, conflict with both versions, delete for good, the cursor in the state, a restart', async () => {
  let ah = await startBed();
  try {
    assert.equal((await http(ah, 'GET', '/api/hello')).json().features.notes, 1);
    const before = (await http(ah, 'GET', '/api/state')).json().notes;
    assert.deepEqual(before, { cursor: 0, count: 0 });
    const id = randomUUID();
    const put = (body: object) => http(ah, 'PUT', `/api/notes/${id}`, { body });
    const made = await put({ baseRevision: 0, writeId: 'w1', title: 'Session restoration ideas', markdown: '# Restore\n\n- [ ] panes', project: { host: 'mac', path: '/Users/me/code/ah-native' } });
    assert.equal(made.status, 201, made.body);
    assert.equal(made.json().revision, 1);
    assert.equal(made.json().writer, 'local');
    await until(async () => (await http(ah, 'GET', '/api/state')).json().notes?.cursor === 1, 8000, 'cursor in the state');

    assert.equal((await put({ baseRevision: 1, writeId: 'w2', title: 'Session restoration ideas', markdown: 'from the phone' })).status, 200);
    const clash = await put({ baseRevision: 1, writeId: 'w3', title: 'Session restoration ideas', markdown: 'from the iPad' });
    assert.equal(clash.status, 409);
    assert.equal(clash.json().code, 'note_conflict');
    assert.equal(clash.json().note.markdown, 'from the phone', 'the host’s version comes back to keep beside yours');
    assert.equal((await put({ baseRevision: 1, writeId: 'w2', title: 'Session restoration ideas', markdown: 'from the phone' })).status, 200, 'a retry is answered');

    const since = (await http(ah, 'GET', '/api/notes?since=1')).json();
    assert.deepEqual(since.notes.map((n: any) => n.revision), [2]);
    assert.equal(since.cursor, 2);

    // A large note goes through (JSON bodies elsewhere stop at 64 KB).
    const big = randomUUID();
    const text = '# Big\n' + 'line of a long specification\n'.repeat(20_000);
    const r = await http(ah, 'PUT', `/api/notes/${big}`, { body: { baseRevision: 0, writeId: 'b1', title: 'Big', markdown: text } });
    assert.equal(r.status, 201, r.body.slice(0, 200));
    assert.equal((await http(ah, 'GET', `/api/notes/${big}`)).json().markdown.length, text.length);

    const del = await http(ah, 'DELETE', `/api/notes/${big}?baseRevision=1&writeId=d1`);
    assert.equal(del.json().deleted, true);
    const back = await http(ah, 'PUT', `/api/notes/${big}`, { body: { baseRevision: 1, writeId: 'b2', title: 'Big', markdown: 'stale copy' } });
    assert.equal(back.json().code, 'note_deleted');
    assert.equal((await http(ah, 'PUT', '/api/notes/nope', { body: {} })).status, 404);
    assert.equal((await http(ah, 'PUT', `/api/notes/${randomUUID()}`, { body: { baseRevision: 0 } })).json().code, 'invalid_write_id');

    // Durable: a restarted host has every note, tombstone and the cursor.
    const cursor = (await http(ah, 'GET', '/api/notes?since=999999')).json().state.cursor;
    assert.equal(cursor, 4);
    ah = Object.assign(await ah.restart(), { bin: ah.bin, project: ah.project });
    assert.equal((await http(ah, 'GET', `/api/notes/${id}`)).json().markdown, 'from the phone');
    assert.equal((await http(ah, 'GET', `/api/notes/${big}`)).json().deleted, true);
    assert.deepEqual(await until(async () => {
      const n = (await http(ah, 'GET', '/api/state')).json().notes;
      return n?.cursor === cursor && n;
    }, 8000, 'cursor after restart'), { cursor, count: 1 });
  } finally {
    await cleanup(ah);
  }
});

test('save as file: SPEC.md in the project, never over a file unless asked, never outside it', async () => {
  const ah = await startBed();
  try {
    const id = randomUUID();
    await http(ah, 'PUT', `/api/notes/${id}`, { body: { baseRevision: 0, writeId: 'w1', title: 'Spec', markdown: '# Spec' } });
    const save = (body: object) => http(ah, 'POST', '/api/notes/export', { body: { dir: ah.project, markdown: '# Spec\n', noteId: id, revision: 1, ...body } });
    const first = await save({ path: 'SPEC.md' });
    assert.equal(first.status, 201, first.body);
    assert.equal(readFileSync(join(ah.project, 'SPEC.md'), 'utf8'), '# Spec\n');
    const again = await save({ path: 'SPEC.md', markdown: 'second' });
    assert.equal(again.status, 409);
    assert.deepEqual([again.json().code, again.json().suggestion], ['file_exists', 'SPEC (1).md']);
    assert.equal(readFileSync(join(ah.project, 'SPEC.md'), 'utf8'), '# Spec\n');
    assert.equal((await save({ path: 'SPEC.md', markdown: 'second', replace: true })).json().replaced, true);
    assert.equal(readFileSync(join(ah.project, 'SPEC.md'), 'utf8'), 'second');
    assert.equal((await save({ path: 'docs/proposals/session-restoration.md' })).status, 201);
    // The note remembers where it went; its revision doesn't move.
    const note = (await http(ah, 'GET', `/api/notes/${id}`)).json();
    assert.equal(note.revision, 1);
    assert.deepEqual(note.exports.map((e: any) => e.path.split('/').slice(-2).join('/')), ['proposals/session-restoration.md', 'proj/SPEC.md']);

    assert.equal((await save({ path: '../escape.md' })).json().code, 'invalid_path');
    const outside = mkdtempSync(join(tmpdir(), 'ah-out-'));
    symlinkSync(outside, join(ah.project, 'out'));
    assert.equal((await save({ path: 'out/x.md' })).json().code, 'outside_project');
    assert.equal((await http(ah, 'POST', '/api/notes/export', { body: { dir: outside, path: 'x.md', markdown: 'x' } })).status, 403);
    assert.equal(existsSync(join(outside, 'x.md')), false);
  } finally {
    await cleanup(ah);
  }
});

test('hand-off: to an idle session, a busy one (queued, then in once) and an ended one (resumed); retries send nothing', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ah-log-')), 'prompts.log');
  const ah = await startBed({}, { FAKE_HARNESS_LOG: log });
  try {
    const noteId = randomUUID();
    const hand = (body: object) => http(ah, 'POST', '/api/notes/handoffs', { body: { noteId, revision: 4, ...body } });
    const idle = await launch(ah, 'claude', ah.project, 'Idle one');
    const h1 = { id: randomUUID(), target: idle.uid, text: 'Spec one: build the parser' };
    const a = await hand(h1);
    assert.equal(a.status, 200, a.body);
    assert.equal(a.json().outcome, 'delivered');
    await until(async () => (await transcriptOf(ah, idle.uid))?.includes('Got: Spec one'), 15000, 'delivered');
    const retry = (await hand(h1)).json();
    assert.deepEqual([retry.outcome, retry.replay, retry.revision], ['delivered', true, 4]);

    const busy = await launch(ah, 'codex', ah.project, 'Busy one');
    await http(ah, 'POST', `/api/sessions/${busy.uid}/send`, { body: { text: 'SLOW 6000' } });
    await until(async () => (await windows(ah)).find((w) => w.uid === busy.uid)?.status === 'busy', 10000, 'busy');
    const h2 = { id: randomUUID(), target: busy.uid, text: 'Spec two: after the slow turn' };
    const b = (await hand(h2)).json();
    assert.equal(b.outcome, 'queued');
    assert.equal(b.queueId, h2.id);
    assert.equal((await hand(h2)).json().replay, true);
    await until(async () => (await transcriptOf(ah, busy.uid))?.includes('Got: Spec two'), 25000, 'the queued note went in');

    // Ended: handed to its history ref, which resumes the conversation.
    const ended = await launch(ah, 'claude', ah.project, 'Ended one');
    await say(ah, ended.uid, 'first turn');
    assert.equal((await http(ah, 'POST', `/api/sessions/${ended.uid}/terminate`)).status, 200);
    const ref = await until(async () => (await http(ah, 'GET', '/api/state')).json().history.find((h: any) => h.title === 'Ended one')?.ref, 15000, 'in history');
    const h3 = { id: randomUUID(), target: ref, text: 'Spec three: picked up again' };
    const c = (await hand(h3)).json();
    assert.equal(c.resumed, true, JSON.stringify(c));
    const live = await until(async () => (await windows(ah)).find((w) => w.harnessId === ended.harnessId), 15000, 'resumed');
    await until(async () => (await transcriptOf(ah, live.uid))?.includes('Got: Spec three'), 25000, 'went into the resumed conversation');

    await new Promise((r) => setTimeout(r, 3000));
    for (const t of ['Spec one', 'Spec two', 'Spec three']) assert.equal(count(log, t), 1, `${t} exactly once`);
    assert.equal((await http(ah, 'GET', `/api/notes/handoffs/${h2.id}`)).json().outcome, 'queued');
  } finally {
    await cleanup(ah);
  }
});
