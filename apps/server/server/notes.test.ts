import '../test/scratch.ts';
// Scratchpads on a real database (docs/spec/15-scratchpads.md): conditional writes,
// retries, tombstones, the change feed; saving as a file inside a project only; and
// hand-offs that are never sent twice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureMigrated, getDb } from './db.ts';
import { NotesStore, NoteError } from './notes/store.ts';
import { exportNote, relativeSegments } from './notes/export.ts';
import { Handoffs, MaybeArrived } from './notes/handoff.ts';
import { Registry } from './registry.ts';
import { PasteError } from './tmux.ts';
import { createServer } from 'node:http';
import { notesApi } from './notes/api.ts';
import { renameSync } from 'node:fs';
import { setRoots } from './files.ts';

async function bed() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-notes-'));
  const path = join(dir, 'ah.db');
  await ensureMigrated(path);
  const db = getDb(path);
  let changes = 0;
  const store = new NotesStore(db, () => changes++);
  await store.load();
  return { dir, path, db, store, changes: () => changes };
}

const write = (o: Partial<Parameters<NotesStore['put']>[1]> = {}) => ({ baseRevision: 0, writeId: randomUUID(), title: 'Ideas', markdown: '# Ideas', project: null, writer: 'device:phone', ...o });

async function refused(p: Promise<unknown>, code: string): Promise<NoteError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof NoteError, String(err));
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`expected ${code}`);
}

test('notes: made with the device’s id, changed on the revision it was made on, a retry answered not applied', async () => {
  const { store, changes } = await bed();
  const id = randomUUID();
  const made = await store.put(id, write({ createdAt: 1_700_000_000 }));
  assert.equal(made.created, true);
  assert.equal(made.note.id, id);
  assert.equal(made.note.revision, 1);
  assert.equal(made.note.createdAt, 1_700_000_000, 'kept from the device');
  assert.deepEqual(store.state(), { cursor: 1, count: 1 });

  const w = write({ baseRevision: 1, markdown: '# Ideas\n\n- one', project: { host: 'mac', path: '/Users/me/code/ah-native' } });
  const next = await store.put(id, w);
  assert.equal(next.note.revision, 2);
  assert.deepEqual(next.note.project, { host: 'mac', path: '/Users/me/code/ah-native' });
  // The answer was lost and the device asks again: same note, no third revision.
  const again = await store.put(id, w);
  assert.equal(again.note.revision, 2);
  assert.equal(again.note.seq, next.note.seq);
  assert.equal(changes(), 2);
  assert.equal(id.toUpperCase() === id ? 0 : (await store.get(id.toUpperCase())).id, id, 'ids are case-blind');
});

test('notes: two devices edit the same revision — the second is refused with the first’s text, nothing merged', async () => {
  const { store } = await bed();
  const id = randomUUID();
  await store.put(id, write());
  await store.put(id, write({ baseRevision: 1, markdown: 'phone’s version' }));
  const err = await refused(store.put(id, write({ baseRevision: 1, markdown: 'iPad’s version' })), 'note_conflict');
  assert.equal(err.status, 409);
  assert.equal(err.note?.markdown, 'phone’s version');
  assert.equal(err.note?.revision, 2);
  assert.equal((await store.get(id)).markdown, 'phone’s version', 'the refused write changed nothing');
  // The iPad keeps its text and writes it on top once it has seen revision 2.
  assert.equal((await store.put(id, write({ baseRevision: 2, markdown: 'iPad’s version' }))).note.revision, 3);
});

test('notes: a deletion leaves a tombstone no stale device brings back; a deletion of unseen changes is refused', async () => {
  const { store } = await bed();
  const id = randomUUID();
  await store.put(id, write());
  await store.put(id, write({ baseRevision: 1, markdown: 'changed on the Mac' }));
  // The phone saw revision 1 and deletes: the Mac's change would be lost unseen.
  await refused(store.remove(id, 1, 'del-1', 'device:phone'), 'note_conflict');
  const gone = await store.remove(id, 2, 'del-2', 'device:phone');
  assert.equal(gone.deleted, true);
  assert.equal(gone.markdown, '', 'a tombstone keeps no text');
  assert.equal(store.state()!.count, 0);
  // Retried, and again from another device: still the one tombstone.
  assert.equal((await store.remove(id, 2, 'del-2', 'device:phone')).revision, gone.revision);
  assert.equal((await store.remove(id, 1, 'del-3', 'device:ipad')).deleted, true);
  // An offline device's old copy can't come back by writing.
  const err = await refused(store.put(id, write({ baseRevision: 2, markdown: 'stale' })), 'note_deleted');
  assert.equal(err.note?.deleted, true);
  await refused(store.put(id, write({ baseRevision: 0 })), 'note_deleted');
  // An id this host never had, deleted offline elsewhere: a tombstone ahead of any copy.
  const unseen = randomUUID();
  assert.equal((await store.remove(unseen, 3, 'del-4', 'device:ipad')).deleted, true);
  await refused(store.put(unseen, write({ baseRevision: 3 })), 'note_deleted');
});

test('notes: the change feed — since a cursor, oldest first, tombstones and paging included; durable across a restart', async () => {
  const { store, db } = await bed();
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  for (const id of ids) await store.put(id, write({ title: id }));
  const cursor = store.state()!.cursor;
  await store.put(ids[0], write({ baseRevision: 1, title: 'renamed' }));
  await store.remove(ids[1], 1, 'd', 'local');
  const since = await store.list(cursor);
  assert.deepEqual(since.notes.map((n) => [n.id, n.deleted]), [[ids[0], false], [ids[1], true]]);
  assert.equal(since.cursor, store.state()!.cursor);
  assert.equal(since.more, false);
  const nothing = await store.list(since.cursor);
  assert.deepEqual(nothing.notes, []);
  assert.equal(nothing.cursor, since.cursor);
  const page = await store.list(0, 2);
  assert.equal(page.notes.length, 2);
  assert.equal(page.more, true);
  const rest = await store.list(page.cursor, 2);
  assert.equal(rest.more, false);
  assert.equal(new Set([...page.notes, ...rest.notes].map((n) => n.id)).size, 3);
  // A fresh process reads the same cursor and count from the database.
  const reopened = new NotesStore(db);
  await reopened.load();
  assert.deepEqual(reopened.state(), store.state());
  assert.equal((await reopened.get(ids[0])).title, 'renamed');
});

test('notes: what a write may carry', async () => {
  const { store } = await bed();
  await refused(store.put('not-a-uuid', write()), 'invalid_note_id');
  await refused(store.put(randomUUID(), write({ markdown: 'x'.repeat(1024 * 1024 + 1) })), 'note_too_long');
  await refused(store.put(randomUUID(), write({ title: 't'.repeat(201) })), 'title_too_long');
  const { projectOf, revisionOf } = await import('./notes/store.ts');
  assert.throws(() => projectOf({ host: 'a b', path: '/x' }), NoteError);
  assert.throws(() => projectOf({ host: 'mac', path: 'relative' }), NoteError);
  assert.equal(projectOf(null), null);
  assert.throws(() => revisionOf(-1), NoteError);
  assert.throws(() => revisionOf(1.5), NoteError);
  assert.equal(revisionOf('3'), 3);
});

test('notes: an export is recorded on the note without a new revision', async () => {
  const { store } = await bed();
  const id = randomUUID();
  await store.put(id, write());
  await store.recordExport(id, { host: 'box', path: '/p/SPEC.md', revision: 1, at: 1 });
  await store.recordExport(id, { host: 'box', path: '/p/SPEC.md', revision: 1, at: 2 });
  const n = await store.get(id);
  assert.equal(n.revision, 1, 'no device’s next write conflicts with it');
  assert.deepEqual(n.exports, [{ host: 'box', path: '/p/SPEC.md', revision: 1, at: 2 }]);
  await store.recordExport(randomUUID(), { host: 'box', path: '/p/x.md', revision: 0, at: 3 });
});

// ---------- saving as a file

function project() {
  const root = mkdtempSync(join(tmpdir(), 'ah-notes-fs-'));
  const proj = join(root, 'proj');
  mkdirSync(proj);
  const outside = mkdtempSync(join(tmpdir(), 'ah-notes-out-'));
  setRoots([root]);
  return { root, proj, outside };
}

test('export: SPEC.md and nested paths, folders made, atomic, no temp files left', async () => {
  const { proj } = project();
  const out = await exportNote(proj, 'SPEC.md', '# Spec\n', false);
  assert.equal(out.path, join(proj, 'SPEC.md'));
  assert.equal(out.replaced, false);
  assert.equal(readFileSync(out.path, 'utf8'), '# Spec\n');
  const nested = await exportNote(proj, 'docs/proposals/session-restoration.md', 'x', false);
  assert.equal(readFileSync(nested.path, 'utf8'), 'x');
  assert.ok(statSync(join(proj, 'docs', 'proposals')).isDirectory());
  assert.deepEqual(readdirSync(proj).filter((n) => n.includes('.ah-')), []);
});

test('export: an existing file is replaced only when asked, with a free name offered', async () => {
  const { proj } = project();
  writeFileSync(join(proj, 'PLAN.md'), 'theirs');
  const err = await refused(exportNote(proj, 'PLAN.md', 'mine', false), 'file_exists');
  assert.equal((err as NoteError & { suggestion?: string }).suggestion, 'PLAN (1).md');
  assert.equal(readFileSync(join(proj, 'PLAN.md'), 'utf8'), 'theirs', 'untouched');
  const replaced = await exportNote(proj, 'PLAN.md', 'mine', true);
  assert.equal(replaced.replaced, true);
  assert.equal(readFileSync(join(proj, 'PLAN.md'), 'utf8'), 'mine');
  writeFileSync(join(proj, 'PLAN (1).md'), 'x');
  const e2 = await refused(exportNote(proj, 'PLAN.md', 'mine', false), 'file_exists');
  assert.equal((e2 as NoteError & { suggestion?: string }).suggestion, 'PLAN (2).md');
});

test('export: nothing outside the project — traversal, absolute paths, .git, symlinks out, links as targets', async () => {
  const { proj, outside, root } = project();
  for (const bad of ['../x.md', 'a/../../x.md', '/etc/passwd', '~/x.md', 'a//b.md', './x.md', '.git/hooks/pre-commit', 'a\\b.md', 'x\u0000.md', '']) {
    await refused(exportNote(proj, bad, 'x', true), 'invalid_path');
  }
  assert.throws(() => relativeSegments('docs/.GIT/x'), NoteError);
  // A folder link that leads out of the project.
  symlinkSync(outside, join(proj, 'escape'));
  await refused(exportNote(proj, 'escape/x.md', 'x', false), 'outside_project');
  assert.equal(existsSync(join(outside, 'x.md')), false);
  // A file link at the target is never written through or replaced.
  writeFileSync(join(outside, 'target.md'), 'safe');
  symlinkSync(join(outside, 'target.md'), join(proj, 'link.md'));
  await refused(exportNote(proj, 'link.md', 'x', true), 'file_symlink');
  assert.equal(readFileSync(join(outside, 'target.md'), 'utf8'), 'safe');
  assert.ok(lstatSync(join(proj, 'link.md')).isSymbolicLink());
  // A project outside the browsable roots is refused by files.ts.
  await assert.rejects(exportNote(outside, 'x.md', 'x', false), /outside the browsable folders/);
  // A link inside the project that stays inside is fine.
  mkdirSync(join(proj, 'real'));
  symlinkSync(join(proj, 'real'), join(proj, 'alias'));
  assert.equal((await exportNote(proj, 'alias/ok.md', 'ok', false)).path, join(proj, 'real', 'ok.md'));
  // A file in the way of a folder.
  writeFileSync(join(proj, 'file'), '');
  await refused(exportNote(proj, 'file/x.md', 'x', false), 'not_a_directory');
  void root;
});

// ---------- hand-offs

function sends() {
  const sent: Array<{ target: string; text: string; id: string }> = [];
  const queues = new Map<string, string[]>();
  let next: 'delivered' | 'queued' | 'fail' = 'delivered';
  const deps = {
    send: async (target: string, text: string, id: string) => {
      if (next === 'fail') throw Object.assign(new Error('no such session'), { status: 404 });
      sent.push({ target, text, id });
      if (next === 'queued') queues.set(target, [...(queues.get(target) ?? []), id]);
      return { outcome: next, resumed: target.includes(':'), queueId: next === 'queued' ? id : undefined };
    },
    resolve: async (ref: string) => ref,
    queueIds: (uid: string) => queues.get(uid) ?? [],
  };
  return { sent, queues, deps, set: (o: typeof next) => (next = o) };
}

const handoff = (o: Partial<Parameters<Handoffs['hand']>[0]> = {}) => ({ id: randomUUID(), noteId: randomUUID(), revision: 3, target: 'abc123', text: '# Spec\n\nBuild it.', ...o });

test('hand-off: delivered to an idle session, queued behind a busy one, resumed for an ended one; each once', async () => {
  const { db } = await bed();
  const s = sends();
  const h = new Handoffs(db, s.deps);
  const idle = handoff();
  const a = await h.hand(idle);
  assert.equal(a.outcome, 'delivered');
  assert.equal(a.replay, false);
  assert.equal(a.revision, 3, 'the revision handed off is kept');
  const again = await h.hand(idle);
  assert.equal(again.outcome, 'delivered');
  assert.equal(again.replay, true);
  assert.equal(s.sent.length, 1, 'a retry sends nothing');

  s.set('queued');
  const busy = handoff({ target: 'busy1' });
  const b = await h.hand(busy);
  assert.equal(b.outcome, 'queued');
  assert.equal(b.queueId, busy.id, 'the queue item is the hand-off');
  s.set('delivered');
  const ended = await h.hand(handoff({ target: 'claude:0f0e' }));
  assert.equal(ended.resumed, true);

  // Two at once with one id: one send.
  const twin = handoff();
  const [x, y] = await Promise.all([h.hand(twin), h.hand(twin)]);
  assert.deepEqual([x.outcome, y.outcome], ['delivered', 'delivered']);
  assert.equal(s.sent.filter((m) => m.id === twin.id).length, 1);
  // An id reused for something else is refused.
  await refused(h.hand({ ...twin, text: 'other' }), 'handoff_mismatch');
  assert.equal((await h.get(twin.id)).outcome, 'delivered');
});

test('hand-off: a send that failed can be retried; a crash mid-send is read from the queue, or said to be uncertain', async () => {
  const { db } = await bed();
  const s = sends();
  const h = new Handoffs(db, s.deps);
  s.set('fail');
  const f = handoff();
  await assert.rejects(h.hand(f), /no such session/);
  assert.equal((await h.get(f.id)).outcome, 'failed');
  s.set('delivered');
  assert.equal((await h.hand(f)).outcome, 'delivered');

  // A process died after writing the row: one in the target's queue was queued.
  const queued = handoff({ target: 'q1' });
  await db.noteHandoff.create({ data: { id: queued.id, noteId: queued.noteId, revision: 3, target: 'q1', textSha: (await import('node:crypto')).createHash('sha256').update(queued.text).digest('hex'), state: 'sending' } });
  s.queues.set('q1', [queued.id]);
  const r = await new Handoffs(db, s.deps).hand(queued);
  assert.deepEqual([r.outcome, r.replay], ['queued', true]);
  // Not in any queue: nobody can say. Not sent again unless asked.
  const lost = handoff();
  await db.noteHandoff.create({ data: { id: lost.id, noteId: lost.noteId, revision: 3, target: lost.target, textSha: (await import('node:crypto')).createHash('sha256').update(lost.text).digest('hex'), state: 'sending' } });
  const before = s.sent.length;
  const u = await new Handoffs(db, s.deps).hand(lost);
  assert.equal(u.outcome, 'uncertain');
  assert.equal(s.sent.length, before);
  assert.equal((await h.hand(lost)).outcome, 'uncertain', 'still uncertain on a plain retry');
  const resent = await h.hand({ ...lost, resend: true });
  assert.deepEqual([resent.outcome, resent.replay], ['delivered', false]);
  assert.equal(s.sent.length, before + 1);
});

test('hand-off: what it may carry', async () => {
  const { db } = await bed();
  const h = new Handoffs(db, sends().deps);
  await refused(h.hand(handoff({ id: 'short' })), 'invalid_handoff_id');
  await refused(h.hand(handoff({ text: '  \n' })), 'empty_note');
  await refused(h.hand(handoff({ text: 'x'.repeat(32 * 1024 + 1) })), 'handoff_too_long');
  await refused(h.get(randomUUID()), 'handoff_not_found');
});

// ---------- what review found (retries that weren't, failures said to be safe)

test('notes: the same writeId with other text is not a retry — checked as a write of its own', async () => {
  const { store } = await bed();
  const id = randomUUID();
  await store.put(id, write());
  // Text A goes as w1 and lands; the answer is lost. The device edits to B and asks again with w1.
  const w1 = write({ baseRevision: 1, writeId: 'w1', markdown: 'A' });
  assert.equal((await store.put(id, w1)).note.revision, 2);
  const err = await refused(store.put(id, { ...w1, markdown: 'B' }), 'note_conflict');
  assert.equal(err.note?.markdown, 'A', 'the device is told what the host has');
  // A different project is a different write too.
  await refused(store.put(id, { ...w1, project: { host: 'mac', path: '/p' } }), 'note_conflict');
  // Exactly the same is a retry.
  assert.equal((await store.put(id, w1)).note.revision, 2);
  assert.equal((await store.get(id)).markdown, 'A');
});

test('notes: a deletion is never answered by a live note; a deletion that succeeds returns a tombstone', async () => {
  const { store } = await bed();
  const id = randomUUID();
  await store.put(id, write());
  await store.put(id, write({ baseRevision: 1, writeId: 'put-2', markdown: 'kept' }));
  // The device lost put-2's answer (it thinks revision 1) and deletes under that same id.
  const err = await refused(store.remove(id, 1, 'put-2', 'device:phone'), 'note_conflict');
  assert.equal(err.note?.deleted, false);
  assert.equal((await store.get(id)).markdown, 'kept');
  // On the revision it is now, under the PUT's id: deleted, and the answer is a tombstone.
  const gone = await store.remove(id, 2, 'put-2', 'device:phone');
  assert.equal(gone.deleted, true);
  assert.equal((await store.remove(id, 2, 'put-2', 'device:phone')).deleted, true, 'a retry: the tombstone again');
});

test('notes: a start that couldn’t read the cursor numbers nothing from 0 — 503, then on from where it was', async () => {
  const { store, db } = await bed();
  for (let i = 0; i < 3; i++) await store.put(randomUUID(), write());
  const top = store.state()!.cursor;
  let failing = true;
  const flaky = new Proxy(db, {
    get(target, prop, recv) {
      if (prop !== 'note') return Reflect.get(target, prop, recv);
      const note = target.note;
      return new Proxy(note, { get: (n, p, r) => (failing && (p === 'aggregate' || p === 'count') ? async () => { throw new Error('database is locked'); } : Reflect.get(n, p, r)) });
    },
  });
  const restarted = new NotesStore(flaky);
  await assert.rejects(restarted.load(), /locked/);
  assert.equal(restarted.state(), null, 'the stream doesn’t claim a cursor');
  await refused(restarted.put(randomUUID(), write()), 'notes_unavailable');
  await refused(restarted.list(0), 'notes_unavailable');
  await refused(restarted.remove(randomUUID(), 0, 'd1', 'local'), 'notes_unavailable');
  failing = false;
  const made = await restarted.put(randomUUID(), write());
  assert.equal(made.note.seq, top + 1, 'numbered after what was there');
  assert.equal((await restarted.list(top)).notes.length, 1, 'a device that read to the top sees it');
});

test('hand-off: a paste that typed some of it, or a queue not yet kept, is uncertain — not failed, not sent again', async () => {
  const { db } = await bed();
  const s = sends();
  let mode: 'typed' | 'untyped' | 'unsaved' | 'ok' = 'typed';
  const deps = {
    ...s.deps,
    send: async (target: string, text: string, id: string) => {
      if (mode === 'typed') throw new PasteError('send-keys Enter failed', true);
      if (mode === 'untyped') throw new PasteError('load-buffer failed', false);
      if (mode === 'unsaved') throw new MaybeArrived('queued, but not yet saved: disk full');
      return s.deps.send(target, text, id);
    },
  };
  const h = new Handoffs(db, deps);
  const typed = handoff();
  const a = await h.hand(typed);
  assert.deepEqual([a.outcome, a.replay], ['uncertain', false]);
  mode = 'ok';
  assert.equal((await h.hand(typed)).outcome, 'uncertain', 'a plain retry sends nothing');
  assert.equal(s.sent.length, 0);
  mode = 'unsaved';
  assert.equal((await h.hand(handoff({ target: 'busy' }))).outcome, 'uncertain');
  mode = 'untyped';
  const untyped = handoff();
  await assert.rejects(h.hand(untyped), /load-buffer/);
  assert.equal((await h.get(untyped.id)).outcome, 'failed', 'nothing typed: safe to send again');
});

test('hand-off: sent, but the ledger couldn’t be written after — the row stays sending, read as queued or uncertain', async () => {
  const { db } = await bed();
  const s = sends();
  let breakAfterSend = true;
  const flaky = new Proxy(db, {
    get(target, prop, recv) {
      if (prop !== 'noteHandoff') return Reflect.get(target, prop, recv);
      const t = target.noteHandoff;
      return new Proxy(t, {
        get: (n, p, r) =>
          p === 'update'
            ? async (args: { data: { state?: string } }) => {
                if (breakAfterSend && args.data.state && args.data.state !== 'sending') throw new Error('database is locked');
                return t.update(args as never);
              }
            : Reflect.get(n, p, r),
      });
    },
  });
  const h = new Handoffs(flaky, s.deps);
  const o = handoff();
  await assert.rejects(h.hand(o), /locked/);
  assert.equal((await db.noteHandoff.findUnique({ where: { id: o.id } }))?.state, 'sending', 'never “failed”');
  breakAfterSend = false;
  const retry = await h.hand(o);
  assert.equal(retry.outcome, 'uncertain', 'delivered but unrecorded: nobody can say');
  assert.equal(s.sent.length, 1, 'not sent again');
});

test('registry: written() says when a session (its queue) is on disk, and rejects when that write failed', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'ah-notes-reg-')), 'ah.db');
  await ensureMigrated(path);
  const registry = new Registry(path);
  await registry.ready();
  registry.starting('u1', { harness: 'claude', harnessId: 'c1', cwd: '/tmp', title: 't', tmux: { session: 's', windowId: '@1' } });
  registry.setMeta('u1', 'ah.queue', [{ id: 'h1', text: 'x', enter: true, at: 0 }]);
  await registry.written('u1');
  const real = (registry as unknown as { persist: unknown }).persist;
  (registry as unknown as { persist: () => Promise<void> }).persist = async () => {
    throw new Error('disk full');
  };
  registry.setMeta('u1', 'ah.queue', [{ id: 'h2', text: 'y', enter: true, at: 0 }]);
  await assert.rejects(registry.written('u1'), /could not be saved/);
  (registry as unknown as { persist: unknown }).persist = real;
  await registry.written('u1');
});

test('export: .git reached through a symlink is refused; a folder swapped for a link mid-write is caught', async () => {
  const { proj, outside } = project();
  mkdirSync(join(proj, '.git', 'hooks'), { recursive: true });
  symlinkSync(join(proj, '.git'), join(proj, 'alias'));
  await refused(exportNote(proj, 'alias/hooks/pre-commit', '#!/bin/sh', true), 'invalid_path');
  assert.equal(existsSync(join(proj, '.git', 'hooks', 'pre-commit')), false);
  // A project that is itself a .git.
  await refused(exportNote(join(proj, '.git'), 'x.md', 'x', false), 'invalid_path');

  // docs/ is checked, then swapped for a link out before the file goes in: refused, nothing outside.
  for (const when of ['beforeOpen', 'beforePublish'] as const) {
    const docs = join(proj, `docs-${when}`);
    mkdirSync(docs);
    const swap = async () => {
      renameSync(docs, `${docs}-moved`);
      symlinkSync(outside, docs);
    };
    await refused(exportNote(proj, `docs-${when}/SPEC.md`, 'x', false, { [when]: swap }), 'outside_project');
    assert.equal(existsSync(join(outside, 'SPEC.md')), false, when);
  }
});

test('api: a hand-off of 24 000 CJK characters goes; one over the limit says handoff_too_long; notes say note_too_long', async () => {
  const { db, store } = await bed();
  const s = sends();
  const handoffs = new Handoffs(db, s.deps);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    notesApi(req, res, url, url.pathname, null, { store, handoffs, host: () => 'box', audit: () => {} }).catch((err) => {
      res.writeHead(err.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err.message) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  };
  try {
    const cjk = await call('POST', '/api/notes/handoffs', handoff({ text: '漢'.repeat(24_000) }));
    assert.equal(cjk.status, 200, JSON.stringify(cjk.json));
    assert.equal(cjk.json.outcome, 'delivered');
    const long = await call('POST', '/api/notes/handoffs', handoff({ text: 'x'.repeat(33_000) }));
    assert.deepEqual([long.status, long.json.code], [413, 'handoff_too_long']);
    const big = await call('PUT', `/api/notes/${randomUUID()}`, { baseRevision: 0, writeId: 'w', title: 't', markdown: 'x'.repeat(1024 * 1024 + 1) });
    assert.deepEqual([big.status, big.json.code], [413, 'note_too_long']);
    const title = await call('PUT', `/api/notes/${randomUUID()}`, { baseRevision: 0, writeId: 'w', title: 't'.repeat(201), markdown: '' });
    assert.deepEqual([title.status, title.json.code], [400, 'title_too_long']);
  } finally {
    server.close();
  }
});
