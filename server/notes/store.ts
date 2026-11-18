// Scratchpads (docs/spec/15-scratchpads.md): Markdown notes kept as their own kind of
// session, with no agent, window or process behind them. Devices write them offline and
// bring them here when they can; this host is where every device meets.
//
// Writes are conditional: each names the revision it was made on (`baseRevision`, 0 for a
// note the host hasn't seen) and its own `writeId`. A write made on an older revision is
// refused with the note as it is now, so the device keeps both versions; nothing is ever
// merged or overwritten silently. A retried write (same `writeId` and the same text, title
// and project) gets the same answer; the same id with anything else is a new write, checked
// like one. Deleting leaves a tombstone, so a device that was offline can't bring a note back.
import type { PrismaClient, Note } from '@prisma/client';

/** A note as the API shows it. Times are seconds since the epoch, as everywhere in ah. */
export type NoteView = {
  id: string;
  title: string;
  /** Empty on a tombstone. */
  markdown: string;
  project: { host: string; path: string } | null;
  revision: number;
  seq: number;
  writer: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  deletedAt: number | null;
  exports: NoteExport[];
};

export type NoteExport = { host: string; path: string; revision: number; at: number };

/** What the state stream says about notes: clients pull `?since=` when `cursor` moves. */
export type NotesState = { cursor: number; count: number };

export class NoteError extends Error {
  status: number;
  code: string;
  /** The note as the host has it, for a refused write (conflict, deleted). */
  note?: NoteView;
  constructor(status: number, code: string, message: string, note?: NoteView) {
    super(message);
    this.status = status;
    this.code = code;
    if (note) this.note = note;
  }
}

export const MAX_MARKDOWN = 1024 * 1024;
export const MAX_TITLE = 200;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_ID = /^[\w-]{1,64}$/;
const HOST = /^[\w.-]{1,64}$/;
/** A page of `list` stops past this many bytes of text (one note always fits). */
const PAGE_BYTES = 4 * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);

export function noteId(raw: string): string {
  const id = raw.toLowerCase();
  if (!ID.test(id)) throw new NoteError(400, 'invalid_note_id', 'a note id is a UUID');
  return id;
}

export function writeId(raw: unknown): string {
  if (typeof raw !== 'string' || !WRITE_ID.test(raw)) throw new NoteError(400, 'invalid_write_id', 'writeId: 1-64 letters, digits, - or _');
  return raw;
}

export function revisionOf(raw: unknown): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new NoteError(400, 'invalid_revision', 'baseRevision: a whole number, 0 for a new note');
  return n;
}

/** `null` clears the project; a project is a host's name and an absolute folder there. */
export function projectOf(raw: unknown): { host: string; path: string } | null {
  if (raw === null) return null;
  const p = raw as { host?: unknown; path?: unknown };
  if (!p || typeof p !== 'object' || typeof p.host !== 'string' || !HOST.test(p.host)) throw new NoteError(400, 'invalid_project', 'project.host: a host name');
  if (typeof p.path !== 'string' || !p.path.startsWith('/') || p.path.length > 1024 || p.path.includes('\0')) throw new NoteError(400, 'invalid_project', 'project.path: an absolute folder');
  return { host: p.host, path: p.path };
}

export type NoteWrite = {
  baseRevision: number;
  writeId: string;
  title: string;
  markdown: string;
  project: { host: string; path: string } | null;
  writer: string;
  /** When the device made the note (kept from its first write); defaults to now. */
  createdAt?: number;
};

export class NotesStore {
  private db: PrismaClient;
  private changed: () => void;
  private summary: NotesState = { cursor: 0, count: 0 };
  /** The cursor and count have been read: until then no `seq` can be given out. */
  private loaded = false;
  /** Writes one at a time: `seq` is the next number, and a revision check and its write can't interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(db: PrismaClient, changed: () => void = () => {}) {
    this.db = db;
    this.changed = changed;
  }

  /** Reads the cursor and count (at start; again by the first request if that failed). */
  async load(): Promise<void> {
    const top = await this.db.note.aggregate({ _max: { seq: true } });
    const count = await this.db.note.count({ where: { deletedAt: null } });
    this.summary = { cursor: top._max.seq ?? 0, count };
    this.loaded = true;
  }

  /**
   * Before anything reads the cursor or gives out a `seq`. A start that couldn't read the
   * database leaves nothing to number changes from: numbering from 0 would hide every new
   * change from a device that has read further, so until it can, the answer is 503.
   */
  private async ready(): Promise<void> {
    if (this.loaded) return;
    try {
      await this.load();
    } catch (err) {
      console.error('notes: reading the cursor failed:', err);
      throw new NoteError(503, 'notes_unavailable', 'notes can’t be read on this host right now');
    }
  }

  /** Null until the cursor is known: the stream doesn't claim a cursor it hasn't read. */
  state(): NotesState | null {
    return this.loaded ? { ...this.summary } : null;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.chain.catch(() => {}).then(fn);
    this.chain = task;
    return task;
  }

  /** Every change after `since`, tombstones included, oldest first. */
  async list(since = 0, limit = 200): Promise<{ notes: NoteView[]; cursor: number; more: boolean }> {
    await this.ready();
    const take = Math.max(1, Math.min(500, limit));
    const rows = await this.db.note.findMany({ where: { seq: { gt: since } }, orderBy: { seq: 'asc' }, take: take + 1 });
    const out: NoteView[] = [];
    let bytes = 0;
    for (const row of rows.slice(0, take)) {
      bytes += Buffer.byteLength(row.markdown);
      if (out.length && bytes > PAGE_BYTES) break;
      out.push(view(row));
    }
    const more = out.length < rows.length;
    return { notes: out, cursor: out.length ? out[out.length - 1].seq : Math.max(since, this.summary.cursor), more };
  }

  async get(id: string): Promise<NoteView> {
    await this.ready();
    const row = await this.db.note.findUnique({ where: { id: noteId(id) } });
    if (!row) throw new NoteError(404, 'note_not_found', 'no such note');
    return view(row);
  }

  /**
   * Creates (baseRevision 0) or changes a note. `created` says which. A host that lost a
   * note it once had (a restored database) takes it back from the device that still has it.
   *
   * A retry is the same `writeId` with the same title, text and project: answered as the
   * first time was. The same id with something else (a device that kept editing while the
   * first answer was lost) isn't one: it's checked as a write of its own, so it can't be
   * taken as written when what the host has is the earlier text.
   */
  async put(rawId: string, w: NoteWrite): Promise<{ note: NoteView; created: boolean }> {
    const id = noteId(rawId);
    if (w.markdown.length > MAX_MARKDOWN) throw new NoteError(413, 'note_too_long', `a note holds at most ${MAX_MARKDOWN} characters`);
    if (w.title.length > MAX_TITLE) throw new NoteError(400, 'title_too_long', `a title is at most ${MAX_TITLE} characters`);
    return this.serial(async () => {
      await this.ready();
      const row = await this.db.note.findUnique({ where: { id } });
      const at = now();
      if (!row) {
        const made = await this.db.note.create({
          data: {
            id,
            title: w.title,
            markdown: w.markdown,
            projectHost: w.project?.host ?? null,
            projectPath: w.project?.path ?? null,
            revision: w.baseRevision + 1,
            seq: this.summary.cursor + 1,
            lastWriteId: w.writeId,
            writer: w.writer,
            createdAt: w.createdAt && w.createdAt > 0 && w.createdAt <= at ? Math.floor(w.createdAt) : at,
            updatedAt: at,
          },
        });
        this.bump(+1);
        return { note: view(made), created: true };
      }
      // A retry of the write that made the note what it is: the same answer again.
      if (row.lastWriteId === w.writeId && row.deletedAt === null && sameContent(row, w)) return { note: view(row), created: false };
      if (row.deletedAt !== null) throw new NoteError(409, 'note_deleted', 'this note was deleted on another device', view(row));
      if (row.revision !== w.baseRevision) throw new NoteError(409, 'note_conflict', 'this note changed on another device since', view(row));
      const next = await this.db.note.update({
        where: { id },
        data: {
          title: w.title,
          markdown: w.markdown,
          projectHost: w.project?.host ?? null,
          projectPath: w.project?.path ?? null,
          revision: row.revision + 1,
          seq: this.summary.cursor + 1,
          lastWriteId: w.writeId,
          writer: w.writer,
          updatedAt: at,
        },
      });
      this.bump(0);
      return { note: view(next), created: false };
    });
  }

  /**
   * Deletes a note made on `baseRevision`: one changed since is kept (409, with its text),
   * since the deletion didn't see those changes. An id the host never had gets a tombstone
   * too, so no other device's copy brings it back. Deleting a tombstone again is fine (a
   * retry). A live note is never a retry, whatever id last wrote it: the answer to a
   * deletion that succeeds is always a tombstone.
   */
  async remove(rawId: string, baseRevision: number, wid: string, writer: string): Promise<NoteView> {
    const id = noteId(rawId);
    return this.serial(async () => {
      await this.ready();
      const row = await this.db.note.findUnique({ where: { id } });
      const at = now();
      if (!row) {
        const made = await this.db.note.create({ data: { id, revision: baseRevision + 1, seq: this.summary.cursor + 1, lastWriteId: wid, writer, createdAt: at, updatedAt: at, deletedAt: at } });
        this.bump(0);
        return view(made);
      }
      if (row.deletedAt !== null) return view(row);
      if (row.revision !== baseRevision) throw new NoteError(409, 'note_conflict', 'this note changed on another device since', view(row));
      const gone = await this.db.note.update({
        where: { id },
        data: { title: '', markdown: '', projectHost: null, projectPath: null, revision: row.revision + 1, seq: this.summary.cursor + 1, lastWriteId: wid, writer, updatedAt: at, deletedAt: at },
      });
      this.bump(-1);
      return view(gone);
    });
  }

  /** Says where a note was saved as a file (a note this host doesn't have is fine: nothing to record). */
  async recordExport(rawId: string, e: NoteExport): Promise<void> {
    const id = noteId(rawId);
    return this.serial(async () => {
      await this.ready();
      const row = await this.db.note.findUnique({ where: { id } });
      if (!row || row.deletedAt !== null) return;
      const prior = parseExports(row.exportsJson).filter((x) => !(x.host === e.host && x.path === e.path));
      // Not a change to the note itself: no new revision, so no device's next write conflicts with it.
      await this.db.note.update({ where: { id }, data: { exportsJson: JSON.stringify([e, ...prior].slice(0, 20)), seq: this.summary.cursor + 1 } });
      this.bump(0);
    });
  }

  private bump(count: number) {
    this.summary = { cursor: this.summary.cursor + 1, count: this.summary.count + count };
    this.changed();
  }
}

/** What a write would make the note: the same as it is (title, text and project). */
function sameContent(row: Note, w: NoteWrite): boolean {
  return row.title === w.title && row.markdown === w.markdown && (row.projectHost ?? null) === (w.project?.host ?? null) && (row.projectPath ?? null) === (w.project?.path ?? null);
}

function parseExports(json: string): NoteExport[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.path === 'string') : [];
  } catch {
    return [];
  }
}

export function view(row: Note): NoteView {
  return {
    id: row.id,
    title: row.title,
    markdown: row.markdown,
    project: row.projectHost && row.projectPath ? { host: row.projectHost, path: row.projectPath } : null,
    revision: row.revision,
    seq: row.seq,
    writer: row.writer,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deleted: row.deletedAt !== null,
    deletedAt: row.deletedAt,
    exports: parseExports(row.exportsJson),
  };
}
