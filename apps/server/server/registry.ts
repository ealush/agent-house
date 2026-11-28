// Durable record of every session this host has run, kept beside tmux rather
// than in it. tmux forgets everything when its server dies (reboot, crash);
// this store is what lets a session be found and resumed from any device later.
//
// Synchronous in-memory API (hot paths in tick/send read it constantly) with
// SQLite as the durable backing: one ah.db per host, written fire-and-forget.
import { hostName } from './host.ts';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { defaultDbPath, getDb } from './db.ts';

/** "Saved" (history only) is not a registry state: those come from transcript discovery. */
export type Lifecycle = 'starting' | 'live' | 'ended' | 'unavailable';

/** What Registry.starting changed: the record before (none for a new one), and follow-ups it took from siblings. */
/** What Registry.starting changed: the record before (none for a new one), the meta keys it wrote, and follow-ups it took from siblings. */
export type StartUndo = { id: string; before: SessionRecord | undefined; wrote: string[]; moved: Array<{ from: string; items: unknown[] }> };

export type SessionRecord = {
  id: string;
  host: string;
  /** Preset id (claude, codex, shell, …). */
  harness: string;
  /** The harness's own conversation id (from hooks or discovery). Enables exact resume. */
  harnessId?: string;
  cwd: string;
  model?: string;
  title: string;
  status: string;
  lifecycle: Lifecycle;
  /** Orthogonal to lifecycle: a resume was requested and hasn't come up yet. */
  pendingResume?: boolean;
  createdAt: number;
  lastActivityAt: number;
  endedAt?: number;
  exitCode: number | null;
  tmux?: { session: string; windowId: string };
  /** Free-form extras. Our own keys are namespaced `ah.*` so other producers can coexist. */
  meta: Record<string, unknown>;
};

type Tmux = { session: string; windowId: string };

/** Fork lineage (F36), stored in SessionRecord.meta under `ah.fork`. */
export type ForkMeta = {
  parentUid: string;
  /** The original ancestor, so fork-of-fork chains group flat under one root. */
  rootUid: string;
  /** Title snapshot of the root, so lineage labels survive the root being forgotten. */
  rootTitle: string;
  forkedAt: number;
  /** 1-based position among the parent's forks. */
  forkSeq: number;
};

/** Reads and validates the `ah.fork` meta of a record, if it is one. */
export function forkMetaOf(r: SessionRecord): ForkMeta | null {
  const f = r.meta['ah.fork'] as Partial<ForkMeta> | undefined;
  if (!f || typeof f.parentUid !== 'string' || typeof f.rootUid !== 'string') return null;
  return {
    parentUid: f.parentUid,
    rootUid: f.rootUid,
    rootTitle: typeof f.rootTitle === 'string' ? f.rootTitle : '',
    forkedAt: typeof f.forkedAt === 'number' ? f.forkedAt : 0,
    forkSeq: typeof f.forkSeq === 'number' ? f.forkSeq : 1,
  };
}

const KEEP_ENDED_SECONDS = 30 * 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

/**
 * Conversation identity (system rule): transcripts, side-chats and queues
 * attach to the harness's own conversation id (`harness:harnessId`), never to
 * recency, cwd proximity, or ah's local uid. Sessions whose harness has no
 * conversation id (plain shells) keep the registry uid as their key.
 */
export function conversationKey(harness: string, harnessId: string | undefined, uid: string): string {
  return harnessId ? `${harness}:${harnessId}` : uid;
}

/** The inverse, among known records: a uid as is, or the record holding `harness:harnessId`. */
export function uidOfRef(records: readonly SessionRecord[], ref: string): string | null {
  if (records.some((r) => r.id === ref)) return ref;
  const i = ref.indexOf(':');
  if (i <= 0) return null;
  return records.find((r) => r.harness === ref.slice(0, i) && r.harnessId === ref.slice(i + 1))?.id ?? null;
}

function toRow(r: SessionRecord) {
  return {
    uid: r.id,
    host: r.host,
    title: r.title,
    harness: r.harness,
    harnessId: r.harnessId ?? null,
    cwd: r.cwd,
    model: r.model ?? null,
    status: r.status,
    lifecycle: r.lifecycle,
    pendingResume: r.pendingResume ?? false,
    createdAt: r.createdAt,
    lastActivityAt: r.lastActivityAt,
    endedAt: r.endedAt ?? null,
    exitCode: r.exitCode,
    tmuxJson: r.tmux ? JSON.stringify(r.tmux) : null,
    metaJson: JSON.stringify(r.meta),
  };
}

function fromRow(row: {
  uid: string;
  host: string;
  title: string;
  harness: string;
  harnessId: string | null;
  cwd: string;
  model: string | null;
  status: string;
  lifecycle: string;
  pendingResume: boolean;
  createdAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  exitCode: number | null;
  tmuxJson: string | null;
  metaJson: string;
}): SessionRecord {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.metaJson);
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
  } catch {}
  let tmux: Tmux | undefined;
  try {
    if (row.tmuxJson) tmux = JSON.parse(row.tmuxJson) as Tmux;
  } catch {}
  return {
    id: row.uid,
    host: row.host,
    title: row.title,
    harness: row.harness,
    harnessId: row.harnessId ?? undefined,
    cwd: row.cwd,
    model: row.model ?? undefined,
    status: row.status,
    lifecycle: row.lifecycle as Lifecycle,
    pendingResume: row.pendingResume,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    endedAt: row.endedAt ?? undefined,
    exitCode: row.exitCode,
    tmux,
    meta,
  };
}

export class Registry {
  private records = new Map<string, SessionRecord>();
  private removed = new Set<string>();
  private dirty = false;
  /** Each row as last written (or read), so a flush upserts only the records that changed. */
  private saved = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();
  private loaded: Promise<void> | null = null;
  private db: PrismaClient;
  private dbPath: string;
  /** Told when a running session is found gone, with its last status (recovery: did it die mid-turn?). */
  onEnd: ((r: SessionRecord, lastStatus: string) => void) | null = null;

  constructor(dbPath = defaultDbPath()) {
    this.dbPath = dbPath;
    this.db = getDb(dbPath);
  }

  /**
   * Merge stored rows into memory. The server calls this once its schema is
   * migrated: reading earlier would miss rows (or fail on a new column), and
   * live windows would then re-register under new uids. A failed load rejects
   * instead of leaving an empty registry. In-memory writes made before the
   * load lands win over stored rows.
   */
  load(): Promise<void> {
    return (this.loaded ??= this.db.session.findMany().then((rows) => {
      for (const row of rows) {
        if (!this.records.has(row.uid)) this.records.set(row.uid, fromRow(row));
        if (!this.saved.has(row.uid)) this.saved.set(row.uid, JSON.stringify(toRow(fromRow(row))));
      }
    }));
  }

  static newId(): string {
    return randomUUID().slice(0, 8);
  }

  /** A uid no record here holds yet: 32 random bits rarely collide, but a collision would merge two sessions. */
  freshId(): string {
    for (;;) {
      const id = Registry.newId();
      if (!this.records.has(id) && !this.removed.has(id)) return id;
    }
  }

  /** Resolves once stored rows have merged into memory. Tests only. */
  ready(): Promise<void> {
    return this.load();
  }

  /** Resolves once every queued write has landed. Tests and the shutdown drain. */
  settled(): Promise<void> {
    return this.writing.then(() => {});
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  all(): SessionRecord[] {
    return [...this.records.values()];
  }

  /** Creates or refreshes the record of a running window. */
  live(id: string, f: { harness: string; harnessId?: string; cwd: string; model?: string; title: string; status: string; tmux: Tmux; activity: number; createdAt?: number }) {
    const prev = this.records.get(id);
    const next: SessionRecord = {
      id,
      host: hostName(),
      harness: f.harness,
      harnessId: f.harnessId || (prev?.harness === f.harness ? prev.harnessId : undefined),
      cwd: f.cwd,
      model: f.model || (prev?.harness === f.harness ? prev.model : undefined),
      title: f.title,
      status: f.status,
      lifecycle: 'live',
      pendingResume: false,
      createdAt: prev?.createdAt ?? f.createdAt ?? now(),
      lastActivityAt: Math.max(f.activity, prev?.lastActivityAt ?? 0),
      exitCode: null,
      tmux: f.tmux,
      meta: prev?.meta ?? {},
    };
    this.records.set(id, next);
    // status/activity change constantly: persist them only alongside a real change, or once a minute,
    // or when a turn starts or ends (after a crash or a reboot, recovery reads whether it was working).
    const working = (s: string) => s === 'busy' || s === 'waiting';
    if (!prev || prev.lifecycle !== 'live' || key(prev) !== key(next) || next.lastActivityAt - prev.lastActivityAt > 60 || working(prev.status) !== working(next.status)) {
      this.dirty = true;
    }
  }

  /** Returns what it changed, for abandonStart() if the start fails before the agent runs. */
  starting(id: string, f: { harness: string; harnessId?: string; cwd: string; title: string; tmux: Tmux; pendingResume?: boolean; meta?: Record<string, unknown> }): StartUndo {
    const prev = this.records.get(id);
    this.records.set(id, {
      id,
      host: hostName(),
      harness: f.harness,
      harnessId: f.harnessId ?? prev?.harnessId,
      cwd: f.cwd,
      model: prev?.model,
      title: f.title,
      status: 'busy',
      lifecycle: 'starting',
      pendingResume: f.pendingResume ?? false,
      createdAt: prev?.createdAt ?? now(),
      lastActivityAt: now(),
      exitCode: null,
      tmux: f.tmux,
      meta: { ...prev?.meta, ...f.meta },
    });
    // Running again: an earlier "you ended it" or "it was interrupted" (server/interruptions)
    // no longer says anything about this run.
    delete this.records.get(id)!.meta['ah.endedBy'];
    delete this.records.get(id)!.meta['ah.interrupted'];
    this.dirty = true;
    const moved = this.inheritQueue(id);
    this.flush();
    return { id, before: prev && { ...prev, meta: { ...prev.meta } }, wrote: [...Object.keys(f.meta ?? {}), 'ah.endedBy', 'ah.interrupted'], moved };
  }

  /**
   * A start that failed before its agent ran (the window couldn't be set up, a resume
   * couldn't be typed): everything starting() changed goes back. A new record goes; a
   * session that was being resumed is as it was, ended, never deleted; follow-ups taken
   * from sibling records of the conversation return to them; and its queue is the queue
   * as it is now (removed meanwhile stays removed, queued meanwhile stays queued — on a
   * new record kept ended rather than lost). Forgotten meanwhile, it stays forgotten.
   */
  abandonStart(undo: StartUndo) {
    const now = this.records.get(undo.id);
    // Forgotten meanwhile: nothing to put back.
    if (!now) return;
    const idOf = (q: unknown) => (q as { id?: string }).id;
    // The queue as it is now: what was removed during the start stays removed. Items
    // that came from a sibling record go back to it (first in line); the rest stay here.
    const queue = (now.meta['ah.queue'] as unknown[] | undefined) ?? [];
    const from = new Map<string, string>();
    for (const m of undo.moved) for (const q of m.items) from.set(String(idOf(q)), m.from);
    const returned = new Set<unknown>();
    for (const m of undo.moved) {
      const sib = this.records.get(m.from);
      const back = queue.filter((q) => from.get(String(idOf(q))) === m.from);
      // A sibling forgotten meanwhile can't take its items back: they stay here.
      if (!sib || !back.length) continue;
      sib.meta['ah.queue'] = [...back, ...((sib.meta['ah.queue'] as unknown[]) ?? [])];
      for (const q of back) returned.add(q);
    }
    const kept = queue.filter((q) => !returned.has(q));
    const withQueue = (meta: Record<string, unknown>) => {
      const { 'ah.queue': _, ...rest } = meta;
      return kept.length ? { ...rest, 'ah.queue': kept } : rest;
    };
    if (undo.before) {
      // Only what the start wrote goes back; anything else changed meanwhile (a pin,
      // the delivered-ids ledger, snapshot settings) is kept as it is now.
      const meta = { ...now.meta };
      for (const k of undo.wrote) {
        if (k in undo.before.meta) meta[k] = undo.before.meta[k];
        else delete meta[k];
      }
      // And the fields it set (the record it made from scratch otherwise stays as it is now).
      const restored: Record<string, unknown> = { ...now, meta: withQueue(meta) };
      for (const k of ['lifecycle', 'status', 'tmux', 'pendingResume', 'endedAt', 'lastActivityAt', 'createdAt', 'cwd', 'title', 'harnessId', 'model', 'exitCode', 'host'] as const) {
        if (k in undo.before) restored[k] = undo.before[k];
        else delete restored[k];
      }
      this.records.set(undo.id, restored as SessionRecord);
    } else if (kept.length) {
      this.records.set(undo.id, { ...now, lifecycle: 'ended', status: 'ended', endedAt: now.endedAt ?? Math.floor(Date.now() / 1000), tmux: undefined, pendingResume: false, meta: withQueue(now.meta) });
    } else {
      this.records.delete(undo.id);
      this.removed.add(undo.id);
    }
    this.dirty = true;
    this.flush();
  }


  /** Records a conversation id learned from discovery rather than hooks. */
  adopt(id: string, harnessId: string, model?: string) {
    const r = this.records.get(id);
    if (!r || r.harnessId) return;
    r.harnessId = harnessId;
    r.model ??= model;
    this.inheritQueue(id);
    this.dirty = true;
    this.flush();
  }

  /**
   * Queued follow-ups belong to the conversation, not the window: when a
   * session takes on an existing conversation id (adopted, or resumed under a
   * new uid), it inherits what was queued for that conversation from any
   * sibling record. A forked copy has a new id, so the parent keeps its queue.
   */
  private inheritQueue(id: string): StartUndo['moved'] {
    const moved: StartUndo['moved'] = [];
    const r = this.records.get(id);
    if (!r?.harnessId) return moved;
    for (const other of this.records.values()) {
      if (other.id === id || other.harness !== r.harness || other.harnessId !== r.harnessId) continue;
      const queued = other.meta['ah.queue'] as unknown[] | undefined;
      if (queued?.length) {
        r.meta['ah.queue'] = [...((r.meta['ah.queue'] as unknown[]) ?? []), ...queued];
        delete other.meta['ah.queue'];
        moved.push({ from: other.id, items: queued });
        this.dirty = true;
      }
    }
    return moved;
  }

  /** Direct forks of a session, oldest first (F36). */
  forksOf(id: string): SessionRecord[] {
    return this.all()
      .filter((r) => forkMetaOf(r)?.parentUid === id)
      .sort((a, b) => (forkMetaOf(a)!.forkSeq - forkMetaOf(b)!.forkSeq) || (forkMetaOf(a)!.forkedAt - forkMetaOf(b)!.forkedAt));
  }

  /** The session this one was forked from, if it's still in the registry (F36). */
  forkParent(id: string): SessionRecord | undefined {
    const r = this.records.get(id);
    const f = r ? forkMetaOf(r) : null;
    return f ? this.records.get(f.parentUid) : undefined;
  }

  /**
   * Adds the record of a conversation that arrived from another host (a migration):
   * ended here, resumable from History. Never replaces a record that exists.
   */
  restore(r: SessionRecord): boolean {
    if (this.records.has(r.id)) return false;
    this.records.set(r.id, { ...r, host: hostName(), lifecycle: 'ended', status: 'ended', tmux: undefined, pendingResume: false });
    this.removed.delete(r.id);
    this.dirty = true;
    this.flush();
    return true;
  }

  /** setMeta for several keys of one record, kept in one write: none lands without the others. */
  setMetas(id: string, values: Record<string, unknown>) {
    const r = this.records.get(id);
    if (!r) return;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete r.meta[key];
      else r.meta[key] = value;
    }
    this.dirty = true;
    this.flush();
  }

  setMeta(id: string, key: string, value: unknown) {
    const r = this.records.get(id);
    if (!r) return;
    if (value === undefined) delete r.meta[key];
    else r.meta[key] = value;
    this.dirty = true;
    this.flush();
  }

  /** setMeta for many records at once, written in one go. */
  setMetaMany(key: string, values: ReadonlyMap<string, unknown>) {
    for (const [id, value] of values) {
      const r = this.records.get(id);
      if (!r) continue;
      if (value === undefined) delete r.meta[key];
      else r.meta[key] = value;
      this.dirty = true;
    }
    this.flush();
  }

  /** Marks running records that are no longer in tmux as ended. Starting ones get a grace period. */
  reconcile(alive: Set<string>) {
    const t = now();
    for (const r of this.records.values()) {
      const running = r.lifecycle === 'live' || r.lifecycle === 'starting';
      const grace = r.lifecycle === 'starting' && t - r.lastActivityAt < 10;
      if (running && r.host === hostName() && !alive.has(r.id) && !grace) {
        const last = r.status;
        r.lifecycle = 'ended';
        r.status = 'ended';
        r.endedAt = t;
        r.pendingResume = false;
        this.dirty = true;
        try {
          this.onEnd?.(r, last);
        } catch (err) {
          console.error('session end hook failed:', err);
        }
      }
      if (r.endedAt && t - r.endedAt > KEEP_ENDED_SECONDS && !r.meta['ah.pinned']) {
        this.records.delete(r.id);
        this.removed.add(r.id);
        this.dirty = true;
      }
    }
    this.flush();
  }

  remove(id: string) {
    if (this.records.delete(id)) {
      this.removed.add(id);
      this.dirty = true;
      this.flush();
    }
  }

  /** Writes failing since `at` (0: they aren't), last said in the log at `logged`. */
  private failingSince = { at: 0, logged: 0 };

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    // Only the rows that differ from what was last written: a queue change or a
    // pin used to rewrite every live session and 30 days of ended ones.
    const records: ReturnType<typeof toRow>[] = [];
    for (const r of this.records.values()) {
      const row = toRow(r);
      const json = JSON.stringify(row);
      if (this.saved.get(row.uid) === json) continue;
      this.saved.set(row.uid, json);
      records.push(row);
    }
    const removed = [...this.removed];
    this.removed.clear();
    for (const id of removed) this.saved.delete(id);
    // Capture the in-flight write first: reading this.writing inside the
    // callback below would observe the reassigned (self) promise and deadlock.
    const prev = this.writing;
    this.writing = this.load()
      .catch(() => {})
      .then(() => prev.catch(() => {}))
      .then(() => this.persist(records, removed))
      .then(() => {
        if (this.failingSince.at) console.error(`registry writes recovered after ${Math.round((Date.now() - this.failingSince.at) / 1000)} s`);
        this.failingSince = { at: 0, logged: 0 };
      })
      .catch((err) => {
        // Not written: the next flush (the next pass, at the latest) tries again — the
        // rows, and the deletions, which would otherwise come back after a restart.
        for (const r of records) this.saved.delete(r.uid);
        for (const id of removed) if (!this.records.has(id)) this.removed.add(id);
        this.dirty = true;
        // Said once, then at most once a minute while it keeps failing (every pass retries).
        if (Date.now() - this.failingSince.logged > 60_000) {
          console.error(this.failingSince.at ? 'registry writes still failing:' : 'registry write failed:', err);
          this.failingSince = { at: this.failingSince.at || Date.now(), logged: Date.now() };
        }
      });
  }

  /**
   * Resolves once session `id` as it is now is in the database (its queue included);
   * rejects when that write failed. For a caller that must not say something is kept
   * before it is (a hand-off that answers "queued"). flush() itself never waits.
   */
  async written(id: string): Promise<void> {
    const r0 = this.records.get(id);
    if (!r0) throw new Error('no such session');
    // A row an earlier write failed to keep is written again now, not at the next change.
    if (this.saved.get(id) !== JSON.stringify(toRow(r0))) this.dirty = true;
    this.flush();
    // Writes run in order: once the latest settles, every one before it has.
    let w: Promise<void>;
    do {
      w = this.writing;
      await w;
    } while (w !== this.writing);
    const r = this.records.get(id);
    if (r && this.saved.get(id) !== JSON.stringify(toRow(r))) throw new Error('the session could not be saved');
  }

  private async persist(records: ReturnType<typeof toRow>[], removed: string[]) {
    if (removed.length) await this.db.session.deleteMany({ where: { uid: { in: removed } } });
    if (records.length) {
      await this.db.$transaction(records.map((r) => this.db.session.upsert({ where: { uid: r.uid }, create: r, update: r })));
    }
  }
}

function key(r: SessionRecord): string {
  return JSON.stringify([r.harness, r.harnessId, r.cwd, r.model, r.title, r.tmux]);
}

// v1 records (uid/name/tmuxSession/windowId/lastAliveAt) → v2. Kept for the
// one-time JSON import; the database only ever holds v2.
export function migrate(r: Record<string, any>): SessionRecord {
  if (r.id && r.lifecycle) return { meta: {}, exitCode: null, ...r } as SessionRecord;
  return {
    id: r.uid,
    host: r.host,
    harness: r.harness,
    harnessId: r.harnessId,
    cwd: r.cwd,
    model: r.model,
    title: r.name ?? '',
    status: r.status ?? 'idle',
    lifecycle: r.endedAt ? 'ended' : 'live',
    createdAt: r.createdAt,
    lastActivityAt: r.lastAliveAt ?? r.createdAt,
    endedAt: r.endedAt,
    exitCode: null,
    tmux: r.tmuxSession ? { session: r.tmuxSession, windowId: r.windowId } : undefined,
    meta: {},
  };
}
