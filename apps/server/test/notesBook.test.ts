// The browser's notes (web/notes.ts) against a stand-in host that keeps the spec's rules
// (docs/spec/15-scratchpads.md SCR-2..4): revisions, writeId retries, conflicts, tombstones.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueList, firstLine, NotesBook, noteTitle, type NoteDTO, type NotesApi, type Storage } from '../web/notes.ts';

class Refused extends Error {
  status: number;
  code: string;
  body: { note?: NoteDTO };
  constructor(status: number, code: string, note?: NoteDTO) {
    super(code);
    this.status = status;
    this.code = code;
    this.body = { note };
  }
}

/** One host: rows by id, a change counter, and the last write that made each row. */
function host() {
  const rows = new Map<string, NoteDTO & { writeId: string }>();
  let seq = 0;
  let down = false;
  /** The next answer is lost on the way back (the write still happens). */
  let loseNext = false;
  const view = (r: NoteDTO & { writeId: string }): NoteDTO => {
    const { writeId: _w, ...v } = r;
    return structuredClone(v);
  };
  const answer = <T>(v: T): T => {
    if (loseNext) {
      loseNext = false;
      throw new Error('network: answer lost');
    }
    return v;
  };
  const api: NotesApi = {
    async notes(since) {
      if (down) throw new Error('offline');
      const notes = [...rows.values()].filter((r) => r.seq > since).sort((a, b) => a.seq - b.seq).map(view);
      return { notes, cursor: seq, more: false };
    },
    async putNote(id, b) {
      if (down) throw new Error('offline');
      const row = rows.get(id);
      if (row?.deleted) throw new Refused(409, 'note_deleted', view(row));
      if (row && row.writeId === b.writeId) {
        if (row.title === b.title && row.markdown === b.markdown) return answer(view(row));
        throw new Refused(409, 'note_conflict', view(row));
      }
      if ((row?.revision ?? 0) !== b.baseRevision && !(row === undefined && b.baseRevision > 0)) throw new Refused(409, 'note_conflict', row && view(row));
      const t = 1000 + seq;
      const next = { id, title: b.title, markdown: b.markdown, project: b.project, revision: (row?.revision ?? b.baseRevision) + 1, seq: ++seq, writer: 'device:test', createdAt: row?.createdAt ?? b.createdAt, updatedAt: t, deleted: false, deletedAt: null, exports: [], writeId: b.writeId };
      rows.set(id, next);
      return answer(view(next));
    },
    async deleteNote(id, baseRevision, writeId) {
      if (down) throw new Error('offline');
      const row = rows.get(id);
      if (row && !row.deleted && row.revision !== baseRevision) throw new Refused(409, 'note_conflict', view(row));
      const gone = { id, title: '', markdown: '', project: null, revision: (row?.revision ?? 0) + 1, seq: ++seq, writer: 'device:test', createdAt: row?.createdAt ?? 0, updatedAt: 2000, deleted: true, deletedAt: 2000, exports: [], writeId };
      rows.set(id, gone);
      return answer(view(gone));
    },
  };
  /** Another device's write, straight into the host. */
  const elsewhere = (id: string, markdown: string) => {
    const row = rows.get(id)!;
    rows.set(id, { ...row, markdown, revision: row.revision + 1, seq: ++seq, writeId: `other-${seq}`, writer: 'device:phone' });
  };
  const deleteElsewhere = (id: string) => {
    const row = rows.get(id)!;
    rows.set(id, { ...row, title: '', markdown: '', revision: row.revision + 1, seq: ++seq, deleted: true, deletedAt: 3000, writeId: `other-${seq}` });
  };
  return {
    api,
    rows,
    elsewhere,
    deleteElsewhere,
    set down(v: boolean) {
      down = v;
    },
    loseNextAnswer() {
      loseNext = true;
    },
  };
}

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: (k) => data.get(k) ?? null, set: (k, v) => void data.set(k, v) };
}

const book = (api: NotesApi | null, storage = memory()) => new NotesBook(api, { storage, saveDelay: 0, syncDelay: 2 ** 30, retryDelay: 2 ** 30 });

test('a note is named by its title, else its first line without marks', () => {
  assert.equal(firstLine('\n\n# Plan for Friday\nmore'), 'Plan for Friday');
  assert.equal(firstLine('- [ ] buy milk'), 'buy milk');
  assert.equal(firstLine('```\ncode'), 'code');
  assert.equal(noteTitle({ title: '  ', markdown: '' }), 'Untitled Note');
  assert.equal(noteTitle({ title: 'Mine', markdown: '# Other' }), 'Mine');
});

test('written here, it reaches the host; another device sees it on its next pull', async () => {
  const h = host();
  const a = book(h.api);
  const n = a.create({ markdown: '# Idea' });
  assert.equal(a.syncWord(a.get(n.id)!), 'pending');
  await a.sync();
  assert.equal(h.rows.get(n.id)!.revision, 1);
  assert.equal(a.syncWord(a.get(n.id)!), 'synced');
  const b = book(h.api);
  await b.sync();
  assert.equal(b.get(n.id)!.markdown, '# Idea');
  a.edit(n.id, { markdown: '# Idea\n\nmore' });
  await a.sync();
  await b.sync();
  assert.equal(b.get(n.id)!.markdown, '# Idea\n\nmore');
  assert.equal(b.get(n.id)!.revision, 2);
});

test('offline, the edit stays on the device across a reload and goes once the host is back', async () => {
  const h = host();
  const storage = memory();
  h.down = true;
  const a = book(h.api, storage);
  const n = a.create({ markdown: 'typed on a train' });
  await a.sync();
  assert.equal(a.offline, true);
  a.saveNow();
  const reloaded = book(h.api, storage);
  assert.equal(reloaded.get(n.id)!.markdown, 'typed on a train');
  h.down = false;
  await reloaded.sync();
  assert.equal(reloaded.offline, false);
  assert.equal(h.rows.get(n.id)!.markdown, 'typed on a train');
});

test('a lost answer is retried as the same write, and edits made since go after it', async () => {
  const h = host();
  const a = book(h.api);
  const n = a.create({ markdown: 'one' });
  await a.sync();
  a.edit(n.id, { markdown: 'two' });
  h.loseNextAnswer();
  await a.sync();
  assert.equal(a.get(n.id)!.pending?.markdown, 'two', 'kept as sent');
  a.edit(n.id, { markdown: 'three' });
  await a.sync();
  assert.equal(h.rows.get(n.id)!.markdown, 'three');
  assert.equal(h.rows.get(n.id)!.revision, 3, 'two was written once, three on top');
  assert.equal(a.syncWord(a.get(n.id)!), 'synced');
});

test('changed on two devices apart: both kept, and the person chooses', async () => {
  for (const choice of ['mine', 'theirs', 'both'] as const) {
    const h = host();
    const a = book(h.api);
    const n = a.create({ markdown: 'base' });
    await a.sync();
    h.elsewhere(n.id, 'from the phone');
    a.edit(n.id, { markdown: 'from the laptop' });
    await a.sync();
    const c = a.get(n.id)!;
    assert.equal(a.syncWord(c), 'conflict', choice);
    assert.equal(c.conflict?.markdown, 'from the phone');
    assert.equal(c.markdown, 'from the laptop');
    a.resolve(n.id, choice);
    await a.sync();
    const host_ = h.rows.get(n.id)!.markdown;
    if (choice === 'mine') assert.equal(host_, 'from the laptop');
    else assert.equal(host_, 'from the phone');
    if (choice === 'both') assert.ok(a.list().some((x) => x.markdown === 'from the laptop' && x.title.includes("this device's version")));
    assert.equal(a.syncWord(a.get(n.id)!), 'synced', choice);
  }
});

test('deleted elsewhere: untouched here it goes; edited here the edits live on as a new note', async () => {
  const h = host();
  const a = book(h.api);
  const quiet = a.create({ markdown: 'quiet' });
  const busy = a.create({ markdown: 'busy' });
  await a.sync();
  h.deleteElsewhere(quiet.id);
  h.deleteElsewhere(busy.id);
  a.edit(busy.id, { markdown: 'busy, edited offline' });
  await a.sync();
  assert.equal(a.get(quiet.id), null);
  assert.equal(a.get(busy.id), null);
  const kept = a.get(a.current(busy.id))!;
  assert.equal(kept.markdown, 'busy, edited offline');
  assert.equal(h.rows.get(kept.id)?.markdown, 'busy, edited offline');
  assert.equal(a.takeNotices().length, 2);
});

test('deleting leaves a tombstone on the host; a note it never had just goes', async () => {
  const h = host();
  const a = book(h.api);
  const n = a.create({ markdown: 'x' });
  await a.sync();
  a.remove(n.id);
  assert.equal(a.get(n.id), null);
  await a.sync();
  assert.equal(h.rows.get(n.id)!.deleted, true);
  h.down = true;
  const local = a.create({ markdown: 'never sent' });
  a.remove(local.id);
  h.down = false;
  await a.sync();
  assert.equal(h.rows.has(local.id), false);
});

test('a deletion of a note changed elsewhere since is refused, and their changes stay', async () => {
  const h = host();
  const a = book(h.api);
  const n = a.create({ markdown: 'x' });
  await a.sync();
  h.down = true;
  a.remove(n.id);
  await a.sync();
  h.down = false;
  h.elsewhere(n.id, 'kept going on the phone');
  await a.sync();
  assert.equal(a.get(n.id)?.markdown, 'kept going on the phone');
  assert.equal(h.rows.get(n.id)!.deleted, false);
});

test('a note too long to sync stays here, said why', async () => {
  const h = host();
  const a = book(h.api);
  const n = a.create({ markdown: 'x'.repeat(1_048_577) });
  await a.sync();
  assert.equal(a.syncWord(a.get(n.id)!), 'refused');
  assert.equal(h.rows.has(n.id), false);
});

test('Return carries a list on, numbers counted, tasks unticked; on an empty item it ends the list', () => {
  const at = (t: string) => continueList(t, t.length, t.length);
  assert.deepEqual(at('- one'), { text: '- one\n- ', caret: 8 });
  assert.deepEqual(at('  * two'), { text: '  * two\n  * ', caret: 12 });
  assert.deepEqual(at('9. nine'), { text: '9. nine\n10. ', caret: 12 });
  assert.deepEqual(at('- [x] done'), { text: '- [x] done\n- [ ] ', caret: 17 });
  assert.deepEqual(at('> quoted'), { text: '> quoted\n> ', caret: 11 });
  assert.deepEqual(at('text\n- '), { text: 'text\n', caret: 5 });
  assert.equal(at('plain'), null);
  assert.equal(continueList('- one', 0, 3), null);
});

test('a note says which sessions it went to: kept here at once, the host’s list taken when it has one, older copies with none', async () => {
  const h = host();
  const storage = memory();
  const a = book(h.api, storage);
  const n = a.create({ markdown: '# Plan' });
  await a.sync();
  a.recordSession(n.id, { uid: 'abc123', host: 'box', title: 'Build it', via: 'start', at: 1 });
  a.recordSession(n.id, { uid: 'def456', host: 'box', title: 'Review', via: 'handoff', at: 2 });
  a.recordSession(n.id, { uid: 'abc123', host: 'box', title: 'Build it', via: 'start', at: 3 });
  assert.deepEqual(a.get(n.id)!.sessions.map((s) => s.uid), ['abc123', 'def456'], 'newest first, once each');
  // The host's list, on the feed with no new revision (it was recorded there too).
  const row = h.rows.get(n.id)!;
  h.rows.set(n.id, { ...row, seq: row.seq + 10, sessions: [{ uid: 'mac0001', host: 'mac', title: 'On the Mac', via: 'start', at: 4 }] });
  await a.sync();
  assert.deepEqual(a.get(n.id)!.sessions.map((s) => s.uid), ['mac0001']);
  assert.equal(a.get(n.id)!.revision, 1);
  // A copy saved before notes had sessions reads as having none.
  storage.set('ah.notes', JSON.stringify({ cursor: 0, notes: [{ ...a.get(n.id)!, sessions: undefined }] }));
  assert.deepEqual(book(null, storage).get(n.id)!.sessions, []);
});
