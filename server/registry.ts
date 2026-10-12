// Durable record of every session this host has run, kept beside tmux rather
// than in it. tmux forgets everything when its server dies (reboot, crash);
// this store is what lets a session be found and resumed from any device later.
//
// Synchronous in-memory API (hot paths in tick/send read it constantly) with
// SQLite as the durable backing: one ah.db per host, written fire-and-forget.
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { defaultDbPath, getDb } from './db.ts';

/** "Saved" (history only) is not a registry state: those come from transcript discovery. */
export type Lifecycle = 'starting' | 'live' | 'ended' | 'unavailable';

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
  private writing: Promise<void> = Promise.resolve();
  private loaded: Promise<void> | null = null;
  private db: PrismaClient;
  private dbPath: string;

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
      for (const row of rows) if (!this.records.has(row.uid)) this.records.set(row.uid, fromRow(row));
    }));
  }

  static newId(): string {
    return randomUUID().slice(0, 8);
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
      host: hostname(),
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
    // status/activity change constantly: persist them only alongside a real change, or once a minute.
    if (!prev || prev.lifecycle !== 'live' || key(prev) !== key(next) || next.lastActivityAt - prev.lastActivityAt > 60) {
      this.dirty = true;
    }
  }

  starting(id: string, f: { harness: string; harnessId?: string; cwd: string; title: string; tmux: Tmux; pendingResume?: boolean; meta?: Record<string, unknown> }) {
    const prev = this.records.get(id);
    this.records.set(id, {
      id,
      host: hostname(),
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
    this.dirty = true;
    this.inheritQueue(id);
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
  private inheritQueue(id: string): void {
    const r = this.records.get(id);
    if (!r?.harnessId) return;
    for (const other of this.records.values()) {
      if (other.id === id || other.harness !== r.harness || other.harnessId !== r.harnessId) continue;
      const queued = other.meta['ah.queue'] as unknown[] | undefined;
      if (queued?.length) {
        r.meta['ah.queue'] = [...((r.meta['ah.queue'] as unknown[]) ?? []), ...queued];
        delete other.meta['ah.queue'];
        this.dirty = true;
      }
    }
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

  setMeta(id: string, key: string, value: unknown) {
    const r = this.records.get(id);
    if (!r) return;
    if (value === undefined) delete r.meta[key];
    else r.meta[key] = value;
    this.dirty = true;
    this.flush();
  }

  /** Marks running records that are no longer in tmux as ended. Starting ones get a grace period. */
  reconcile(alive: Set<string>) {
    const t = now();
    for (const r of this.records.values()) {
      const running = r.lifecycle === 'live' || r.lifecycle === 'starting';
      const grace = r.lifecycle === 'starting' && t - r.lastActivityAt < 10;
      if (running && r.host === hostname() && !alive.has(r.id) && !grace) {
        r.lifecycle = 'ended';
        r.status = 'ended';
        r.endedAt = t;
        r.pendingResume = false;
        this.dirty = true;
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

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const records = [...this.records.values()].map(toRow);
    const removed = [...this.removed];
    this.removed.clear();
    // Capture the in-flight write first: reading this.writing inside the
    // callback below would observe the reassigned (self) promise and deadlock.
    const prev = this.writing;
    this.writing = this.load()
      .catch(() => {})
      .then(() => prev.catch(() => {}))
      .then(() => this.persist(records, removed))
      .catch((err) => console.error('registry write failed:', err));
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
