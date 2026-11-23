// Scratchpads in the browser (docs/spec/15-scratchpads.md): Markdown notes kept on this
// device first and taken to the host by revision. Typing is in memory at once and in
// localStorage within a moment, whatever the network does; a write is kept as sent until the
// host answers, so a retry is the same write and edits made since go after it. A conflict
// keeps both versions and asks; a deletion elsewhere keeps unsynced edits as a new note.
// No React in here: web/NotesView.tsx draws it, test/notesBook.test.ts drives it.

export type NoteProject = { host: string; path: string };
export type NoteExport = { host: string; path: string; revision: number; at: number };
/** A session the note started (`start`) or was handed to (`handoff`), newest first (server/notes/store.ts NoteSession). */
export type NoteSession = { uid: string; host: string; title: string; via: 'start' | 'handoff'; at: number };
/** A note as the host shows it (server/notes/store.ts NoteView). Times are seconds. */
export type NoteDTO = {
  id: string;
  title: string;
  markdown: string;
  project: NoteProject | null;
  revision: number;
  seq: number;
  writer: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  deletedAt: number | null;
  exports: NoteExport[];
  /** From a host with `notes` 2. */
  sessions?: NoteSession[];
};
export type NotesPage = { notes: NoteDTO[]; cursor: number; more: boolean };
export type NotesState = { cursor: number; count: number };

/** What the book needs from the host (web/api.ts hostApi). Refusals throw an error with `status`, `code` and the host's `note`. */
export type NotesApi = {
  notes: (since: number) => Promise<NotesPage>;
  putNote: (id: string, body: { baseRevision: number; writeId: string; title: string; markdown: string; project: NoteProject | null; createdAt: number }) => Promise<NoteDTO>;
  deleteNote: (id: string, baseRevision: number, writeId: string) => Promise<NoteDTO>;
};

/** A write as it went to the host, kept until answered. */
export type NoteWrite = { id: string; baseRevision: number; version: number; title: string; markdown: string; project: NoteProject | null; deletion: boolean };

/** This device's copy of a note. */
export type Note = {
  id: string;
  title: string;
  markdown: string;
  project: NoteProject | null;
  createdAt: number;
  updatedAt: number;
  /** The host's revision this copy was made on (0: the host hasn't seen it). */
  revision: number;
  /** Counts edits here; `synced` is the one the host has. */
  version: number;
  synced: number;
  pending: NoteWrite | null;
  /** The host's version, when it and this device changed the note apart. */
  conflict: NoteDTO | null;
  /** Deleted here, the host not told yet. */
  deletedAt: number | null;
  exports: NoteExport[];
  /** The sessions it went to, newest first: the host's, or this device's own on a host that keeps none. */
  sessions: NoteSession[];
  /** The host refused it for good (too long, …): what it said. */
  error: string | null;
};

export type SyncWord = 'synced' | 'pending' | 'conflict' | 'refused';
export type Resolution = 'mine' | 'theirs' | 'both';

export const MAX_MARKDOWN = 1_048_576;
export const MAX_TITLE = 200;

const now = () => Math.floor(Date.now() / 1000);
const uuid = () =>
  globalThis.crypto?.randomUUID?.() ??
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 3) | 8).toString(16);
  });
/** A timer that never keeps a process (a test) alive; the browser's has no unref. */
const later = (fn: () => void, ms: number) => {
  const t = setTimeout(fn, Math.min(ms, 2 ** 31 - 1));
  (t as { unref?: () => void }).unref?.();
  return t;
};
const sameProject = (a: NoteProject | null, b: NoteProject | null) => (a?.host ?? null) === (b?.host ?? null) && (a?.path ?? null) === (b?.path ?? null);

/** The first line worth naming a note by: its first heading or line, without list or quote marks. */
export function firstLine(markdown: string): string | null {
  for (const raw of markdown.split('\n').slice(0, 40)) {
    let line = raw.trim().replace(/^#+\s*/, '');
    for (const mark of ['- [ ] ', '- [x] ', '- ', '* ', '> ']) if (line.startsWith(mark)) line = line.slice(mark.length);
    line = line.trim();
    if (line && !line.startsWith('```')) return line.slice(0, 80);
  }
  return null;
}

/** What a note is called in lists: its title, else its first line. */
export const noteTitle = (n: { title: string; markdown: string }) => n.title.trim() || firstLine(n.markdown) || 'Untitled Note';

export const noteKey = (id: string) => `note:${id}`;

/** Why the host would refuse a note's size, before it's sent. */
export function tooBig(n: { title: string; markdown: string }): string | null {
  if (n.markdown.length > MAX_MARKDOWN) return 'Too long to sync: a note holds at most about a million characters. It stays on this device.';
  if (n.title.length > MAX_TITLE) return 'The title is too long to sync (at most 200 characters).';
  return null;
}

type Refusal = { status?: number; code?: string | null; note?: NoteDTO; message?: string };
/** A refusal for good (a 4xx), with the host's note when it sent one (web/api.ts ApiError keeps the body). */
const refusal = (e: unknown): Refusal | null => {
  const r = e as Refusal & { body?: { note?: NoteDTO } | null; message?: string };
  if (!r || typeof r.status !== 'number' || r.status < 400 || r.status >= 500 || r.status === 401 || r.status === 408 || r.status === 429) return null;
  return { status: r.status, code: r.code ?? null, note: r.note ?? r.body?.note, message: r.message } as Refusal;
};

type Stored = { cursor: number; notes: Note[] };
export type Storage = { get: (key: string) => string | null; set: (key: string, value: string) => void };
export const localStore: Storage = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

export type BookOptions = { storage?: Storage; key?: string; saveDelay?: number; syncDelay?: number; retryDelay?: number };

/**
 * Every note this browser has for one host. Subscribe to redraw; `version` moves on each change.
 */
export class NotesBook {
  private notes = new Map<string, Note>();
  private cursor = 0;
  private listeners = new Set<() => void>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private storage: Storage;
  private key: string;
  private opts: Required<Omit<BookOptions, 'storage' | 'key'>>;
  /** A note kept under a new id (its edits met a deletion elsewhere): where a view on the old one goes. */
  successors = new Map<string, string>();
  /** Things to say once ("… was deleted on another device"); the view takes them. */
  notices: string[] = [];
  /** Moves on every change, for useSyncExternalStore. */
  version = 0;
  /** The host can't be reached or refused for now: changes wait here. */
  offline = false;

  private api: NotesApi | null;

  constructor(api: NotesApi | null, o: BookOptions = {}) {
    this.api = api;
    this.storage = o.storage ?? localStore;
    this.key = o.key ?? 'ah.notes';
    this.opts = { saveDelay: o.saveDelay ?? 300, syncDelay: o.syncDelay ?? 1200, retryDelay: o.retryDelay ?? 5000 };
    try {
      const s = JSON.parse(this.storage.get(this.key) ?? 'null') as Stored | null;
      if (s) {
        this.cursor = s.cursor ?? 0;
        for (const n of s.notes ?? []) this.notes.set(n.id, { ...n, sessions: n.sessions ?? [] });
      }
    } catch {}
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;

  private changed(save: 'soon' | 'now' = 'soon') {
    this.version++;
    for (const fn of this.listeners) fn();
    if (save === 'now') this.saveNow();
    else if (!this.saveTimer) this.saveTimer = later(() => this.saveNow(), this.opts.saveDelay);
  }

  /** Writes this device's copy to storage now (a page closing, a test). */
  saveNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.storage.set(this.key, JSON.stringify({ cursor: this.cursor, notes: [...this.notes.values()] } satisfies Stored));
  }

  // ---------- reading

  /** Live notes, the latest written first. */
  list(): Note[] {
    return [...this.notes.values()].filter((n) => n.deletedAt === null).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  get(id: string): Note | null {
    const n = this.notes.get(id);
    return n && n.deletedAt === null ? n : null;
  }
  /** Where a view on `id` should be: itself, or the copy its edits were kept as. */
  current(id: string): string {
    let at = id;
    for (let hops = 0; hops < 8 && !this.get(at) && this.successors.has(at); hops++) at = this.successors.get(at)!;
    return at;
  }
  syncWord(n: Note): SyncWord {
    if (n.conflict) return 'conflict';
    if (n.error) return 'refused';
    return n.version !== n.synced || n.pending || n.revision === 0 ? 'pending' : 'synced';
  }
  takeNotices(): string[] {
    const out = this.notices;
    this.notices = [];
    return out;
  }

  // ---------- writing

  create(o: { title?: string; markdown?: string; project?: NoteProject | null } = {}): Note {
    const t = now();
    const n: Note = { id: uuid(), title: (o.title ?? '').slice(0, MAX_TITLE), markdown: o.markdown ?? '', project: o.project ?? null, createdAt: t, updatedAt: t, revision: 0, version: 1, synced: 0, pending: null, conflict: null, deletedAt: null, exports: [], sessions: [], error: null };
    this.notes.set(n.id, n);
    this.changed('now');
    this.syncSoon();
    return n;
  }

  /** An edit: the text, title or project. Nothing is sent until a moment's pause. */
  edit(id: string, patch: { markdown?: string; title?: string; project?: NoteProject | null }) {
    const n = this.get(id);
    if (!n) return;
    const next = { ...n };
    if (patch.markdown !== undefined) next.markdown = patch.markdown;
    if (patch.title !== undefined) next.title = patch.title.slice(0, MAX_TITLE);
    if (patch.project !== undefined) next.project = patch.project;
    if (next.markdown === n.markdown && next.title === n.title && sameProject(next.project, n.project)) return;
    next.version++;
    next.updatedAt = now();
    next.error = null;
    this.notes.set(id, next);
    this.changed();
    this.syncSoon();
  }

  duplicate(id: string): Note | null {
    const n = this.get(id);
    return n ? this.create({ title: `${noteTitle(n)} copy`, markdown: n.markdown, project: n.project }) : null;
  }

  remove(id: string) {
    const n = this.get(id);
    if (!n) return;
    if (n.revision === 0 && !n.pending) {
      // The host never had it: nothing to tell.
      this.notes.delete(id);
    } else {
      this.notes.set(id, { ...n, deletedAt: now(), conflict: null });
      this.syncSoon();
    }
    this.changed('now');
  }

  /** The person's choice when this device and another changed a note apart. */
  resolve(id: string, choice: Resolution) {
    const n = this.get(id);
    const theirs = n?.conflict;
    if (!n || !theirs) return;
    if (choice === 'both') this.create({ title: `${noteTitle(n)} (this device's version)`, markdown: n.markdown, project: n.project });
    if (choice === 'mine') {
      // Written on top of the host's revision: an ordinary write.
      this.notes.set(id, { ...n, conflict: null, revision: theirs.revision, pending: null, version: n.version + 1, updatedAt: now() });
    } else {
      this.notes.set(id, { ...n, conflict: null, title: theirs.title, markdown: theirs.markdown, project: theirs.project, revision: theirs.revision, pending: null, version: n.version + 1, synced: n.version + 1, updatedAt: theirs.updatedAt, exports: theirs.exports, sessions: theirs.sessions ?? n.sessions });
    }
    this.changed('now');
    this.syncSoon();
  }

  /** A file the host wrote from this note (POST /api/notes/export with noteId): kept on the note at once. */
  recordExport(id: string, e: NoteExport) {
    const n = this.get(id);
    if (!n) return;
    this.notes.set(id, { ...n, exports: [...n.exports.filter((x) => x.host !== e.host || x.path !== e.path), e] });
    this.changed();
  }

  /** A session started from this note, or one it was handed to: kept on the note at once (the host keeps its own on `notes` 2). */
  recordSession(id: string, e: NoteSession) {
    const n = this.get(id);
    if (!n) return;
    this.notes.set(id, { ...n, sessions: [e, ...n.sessions.filter((x) => x.host !== e.host || x.uid !== e.uid)].slice(0, 20) });
    this.changed();
  }

  // ---------- sync

  /** The state stream's `notes`: a pull when its cursor is past ours. */
  heard(state: NotesState | null | undefined) {
    if (!state) return;
    if (state.cursor > this.cursor || this.dirty().length) this.syncSoon(0);
  }

  private dirty(): Note[] {
    return [...this.notes.values()].filter((n) => !n.conflict && !n.error && (n.pending || n.deletedAt !== null || n.version !== n.synced));
  }

  syncSoon(delay = this.opts.syncDelay) {
    if (!this.api) return;
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = later(() => {
      this.syncTimer = null;
      void this.sync();
    }, delay);
  }

  /** Pulls what changed on the host, then sends what changed here; one pass at a time. */
  sync(): Promise<void> {
    if (!this.api) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.pull();
          for (const n of this.dirty()) {
            for (let i = 0; i < 4 && (await this.push(n.id)); i++);
          }
          if (this.offline) {
            this.offline = false;
            this.changed();
          }
        } catch {
          // Unreachable, signed out, or the host not ready (503 notes_unavailable): later.
          if (!this.offline) {
            this.offline = true;
            this.changed();
          }
          this.syncSoon(this.opts.retryDelay);
          break;
        }
      } while (this.again);
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async pull() {
    for (let pages = 0; pages < 50; pages++) {
      const page = await this.api!.notes(this.cursor);
      for (const dto of page.notes) this.merge(dto);
      this.cursor = page.cursor;
      this.changed('now');
      if (!page.more) break;
    }
  }

  /** One change from the host, against this device's copy. */
  merge(dto: NoteDTO) {
    const n = this.notes.get(dto.id);
    if (!n) {
      if (dto.deleted) return;
      this.notes.set(dto.id, { id: dto.id, title: dto.title, markdown: dto.markdown, project: dto.project, createdAt: dto.createdAt, updatedAt: dto.updatedAt, revision: dto.revision, version: 1, synced: 1, pending: null, conflict: null, deletedAt: null, exports: dto.exports, sessions: dto.sessions ?? [], error: null });
      this.changed();
      return;
    }
    const changedHere = n.version !== n.synced;
    if (dto.deleted) {
      if (n.deletedAt !== null || !changedHere) {
        if (n.deletedAt === null) this.notices.push(`“${noteTitle(n)}” was deleted on another device.`);
        this.notes.delete(n.id);
        this.changed();
      } else this.keepAsCopy(n, `“${noteTitle(n)}” was deleted on another device. Your edits are kept as a new note.`);
      return;
    }
    if (dto.revision <= n.revision) {
      // Where it was saved, or a session it went to: no new revision, but news.
      const exports = dto.exports.length && JSON.stringify(dto.exports) !== JSON.stringify(n.exports);
      const sessions = !!dto.sessions?.length && JSON.stringify(dto.sessions) !== JSON.stringify(n.sessions);
      if (exports || sessions) {
        this.notes.set(n.id, { ...n, ...(exports ? { exports: dto.exports } : {}), ...(sessions ? { sessions: dto.sessions } : {}) });
        this.changed();
      }
      return;
    }
    // Deleted here, changed there: the deletion goes on the revision it saw, and is refused.
    if (n.deletedAt !== null) return;
    if (!changedHere) {
      this.notes.set(n.id, { ...n, title: dto.title, markdown: dto.markdown, project: dto.project, revision: dto.revision, version: n.version + 1, synced: n.version + 1, updatedAt: dto.updatedAt, exports: dto.exports, sessions: dto.sessions ?? n.sessions });
    } else if (sameContent(n, dto) || (n.pending && matches(n.pending, dto))) {
      // This device's own write, seen on the feed before its answer came.
      const carried = n.pending && matches(n.pending, dto) ? n.pending.version : null;
      this.notes.set(n.id, { ...n, pending: carried !== null ? null : n.pending, revision: dto.revision, synced: Math.max(n.synced, sameContent(n, dto) ? n.version : (carried ?? n.synced)) });
    } else {
      this.notes.set(n.id, { ...n, conflict: dto });
    }
    this.changed();
  }

  /** Sends one note's write; true when it may have more to send. */
  private async push(id: string): Promise<boolean> {
    const n = this.notes.get(id);
    if (!n || n.conflict || n.error) return false;
    let write = n.pending;
    if (!write) {
      if (n.deletedAt === null && n.version === n.synced) return false;
      if (n.deletedAt === null) {
        const big = tooBig(n);
        if (big) {
          this.notes.set(id, { ...n, error: big });
          this.changed();
          return false;
        }
      }
      write = { id: uuid(), baseRevision: n.revision, version: n.version, title: n.title, markdown: n.markdown, project: n.project, deletion: n.deletedAt !== null };
      this.notes.set(id, { ...n, pending: write });
      this.changed('now');
    }
    try {
      if (write.deletion) {
        await this.api!.deleteNote(id, write.baseRevision, write.id);
        this.notes.delete(id);
        this.changed('now');
        return false;
      }
      const dto = await this.api!.putNote(id, { baseRevision: write.baseRevision, writeId: write.id, title: write.title, markdown: write.markdown, project: write.project, createdAt: n.createdAt });
      const cur = this.notes.get(id);
      if (!cur) return false;
      const next = { ...cur, pending: null, revision: dto.revision, synced: Math.max(cur.synced, write.version), exports: dto.exports.length ? dto.exports : cur.exports, sessions: dto.sessions?.length ? dto.sessions : cur.sessions };
      this.notes.set(id, next);
      this.changed('now');
      return next.version !== next.synced || next.deletedAt !== null;
    } catch (e) {
      const r = refusal(e);
      if (!r) throw e;
      return this.refused(id, write, r);
    }
  }

  private refused(id: string, write: NoteWrite, r: Refusal): boolean {
    const cur = this.notes.get(id);
    if (!cur) return false;
    const n = { ...cur, pending: null };
    const theirs = r.note;
    if (write.deletion) {
      if (r.code === 'note_conflict' && theirs && !theirs.deleted) {
        if (matches(write, theirs)) {
          // What was deleted here is what the host has, a revision on (our own write, its answer lost).
          this.notes.set(id, { ...n, revision: theirs.revision });
          this.changed('now');
          return true;
        }
        // Changed on another device since: their changes stay.
        this.notes.set(id, { ...n, deletedAt: null, title: theirs.title, markdown: theirs.markdown, project: theirs.project, revision: theirs.revision, version: n.version + 1, synced: n.version + 1, updatedAt: theirs.updatedAt, exports: theirs.exports, sessions: theirs.sessions ?? n.sessions });
        this.notices.push(`“${noteTitle(theirs)}” changed on another device, so it wasn't deleted.`);
      } else this.notes.delete(id);
      this.changed('now');
      return false;
    }
    if (r.code === 'note_conflict' && theirs) {
      if (matches(write, theirs) || sameContent(n, theirs)) {
        // This write reached the host (its answer was lost), or both sides wrote the same.
        const next = { ...n, revision: theirs.revision, synced: Math.max(n.synced, sameContent(n, theirs) ? n.version : write.version) };
        this.notes.set(id, next);
        this.changed('now');
        return next.version !== next.synced;
      }
      if (n.deletedAt !== null) {
        this.notes.set(id, n);
        return true;
      }
      this.notes.set(id, { ...n, conflict: theirs });
      this.changed('now');
      return false;
    }
    if (r.code === 'note_deleted') {
      this.notes.set(id, n);
      if (n.deletedAt !== null) {
        this.notes.delete(id);
        this.changed('now');
      } else this.keepAsCopy(n, `“${noteTitle(n)}” was deleted on another device. Your edits are kept as a new note.`);
      return false;
    }
    this.notes.set(id, { ...n, error: r.message || 'The host refused this note.' });
    this.changed('now');
    return false;
  }

  /** Edits that met a deletion elsewhere live on as a new note; the old id is gone. */
  private keepAsCopy(n: Note, reason: string) {
    const copy = this.create({ title: n.title, markdown: n.markdown, project: n.project });
    this.successors.set(n.id, copy.id);
    this.notes.delete(n.id);
    this.notices.push(reason);
    this.changed('now');
  }
}

const sameContent = (n: { title: string; markdown: string; project: NoteProject | null }, d: { title: string; markdown: string; project: NoteProject | null }) => n.title === d.title && n.markdown === d.markdown && sameProject(n.project, d.project);
const matches = (w: NoteWrite, d: NoteDTO) => !w.deletion && sameContent(w, d);

// ---------- the editor's list carrying

/**
 * Return in a list: the next line starts with the same marker (a number one on, a task
 * unticked). Return on an empty item ends the list. Null when the line isn't a list item.
 */
export function continueList(text: string, start: number, end: number): { text: string; caret: number } | null {
  if (start !== end) return null;
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const line = text.slice(lineStart, start);
  const m = /^(\s*)(?:([-*+]) \[[ xX]\] |([-*+]) |(\d{1,9})([.)]) |> )/.exec(line);
  if (!m) return null;
  const [marker, indent] = [m[0], m[1]];
  const rest = text.slice(start);
  if (line.trim() === marker.trim() && !rest.split('\n')[0].trim()) {
    // An empty item: the list ends here.
    return { text: text.slice(0, lineStart) + text.slice(start), caret: lineStart };
  }
  const next = m[2] ? `${indent}${m[2]} [ ] ` : m[3] ? `${indent}${m[3]} ` : m[4] ? `${indent}${Number(m[4]) + 1}${m[5]} ` : `${indent}> `;
  const insert = `\n${next}`;
  return { text: text.slice(0, start) + insert + rest, caret: start + insert.length };
}
