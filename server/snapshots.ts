// Per-turn snapshot records (F39). The git side lives in server/git.ts
// (plumbing commits under refs/ah-snapshots/); this store is only the index
// of what was captured: one row per snapshot, keyed by session uid with no
// foreign key, so rows outlive the session's own record on purpose (the
// retention pass in core.ts is what prunes them).
import type { PrismaClient } from '@prisma/client';
import { defaultDbPath, getDb } from './db.ts';

export type SnapshotInfo = {
  id: number;
  uid: string;
  turn: number;
  commit: string;
  repoRoot?: string;
  kind: 'turn' | 'safety';
  promptExcerpt: string;
  branch: string;
  createdAt: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  skipped: string[];
  submodules: boolean;
};

type Row = {
  id: number;
  uid: string;
  turn: number;
  commit: string;
  repoRoot: string;
  kind: string;
  promptExcerpt: string;
  branch: string;
  createdAt: number;
  filesChanged: number;
  insertions: number;
  deletions: number;
  skippedJson: string;
  submodules: boolean;
};

function fromRow(r: Row): SnapshotInfo {
  let skipped: string[] = [];
  try {
    const parsed: unknown = JSON.parse(r.skippedJson);
    if (Array.isArray(parsed)) skipped = parsed.filter((x): x is string => typeof x === 'string');
  } catch {}
  return {
    id: r.id,
    uid: r.uid,
    turn: r.turn,
    commit: r.commit,
    repoRoot: r.repoRoot,
    kind: r.kind === 'safety' ? 'safety' : 'turn',
    promptExcerpt: r.promptExcerpt,
    branch: r.branch,
    createdAt: r.createdAt,
    filesChanged: r.filesChanged,
    insertions: r.insertions,
    deletions: r.deletions,
    skipped,
    submodules: r.submodules,
  };
}

export class SnapshotStore {
  private db: PrismaClient | null = null;
  private dbPath: string;

  /** Side-effect free: the database is touched on first use, not here. */
  constructor(dbPath = defaultDbPath()) {
    this.dbPath = dbPath;
  }

  private client(): PrismaClient {
    return (this.db ??= getDb(this.dbPath));
  }

  async list(uid: string): Promise<SnapshotInfo[]> {
    const rows = await this.client().snapshot.findMany({ where: { uid }, orderBy: { turn: 'desc' } });
    return rows.map(fromRow);
  }

  async all(): Promise<SnapshotInfo[]> {
    return (await this.client().snapshot.findMany({ orderBy: [{ uid: 'asc' }, { turn: 'asc' }] })).map(fromRow);
  }

  async latest(uid: string): Promise<SnapshotInfo | null> {
    const row = await this.client().snapshot.findFirst({ where: { uid }, orderBy: { turn: 'desc' } });
    return row ? fromRow(row) : null;
  }

  async get(uid: string, turn: number): Promise<SnapshotInfo | null> {
    const row = await this.client().snapshot.findUnique({ where: { uid_turn: { uid, turn } } });
    return row ? fromRow(row) : null;
  }

  async create(s: Omit<SnapshotInfo, 'id'>): Promise<SnapshotInfo> {
    const row = await this.client().snapshot.create({
      data: {
        uid: s.uid,
        turn: s.turn,
        commit: s.commit,
        repoRoot: s.repoRoot ?? '',
        kind: s.kind,
        promptExcerpt: s.promptExcerpt,
        branch: s.branch,
        createdAt: s.createdAt,
        filesChanged: s.filesChanged,
        insertions: s.insertions,
        deletions: s.deletions,
        skippedJson: JSON.stringify(s.skipped),
        submodules: s.submodules,
      },
    });
    return fromRow(row);
  }

  async remove(uid: string, turn: number): Promise<void> {
    await this.client().snapshot.deleteMany({ where: { uid, turn } });
  }
}
