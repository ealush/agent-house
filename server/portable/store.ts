// Durable side of portable conversations: identity rows, lineage edges (each one
// also the record of the operation that made it), and the portable documents on
// disk. Owner-only, like the rest of ah's state.
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PrismaClient, ConversationLink as LinkRow, Conversation as ConvRow } from '@prisma/client';
import type { LinkKind, LinkState, Limitation, PortableConversation, Strategy } from './schema.ts';

export const PORTABLE_DIR = () => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'portable');

const now = () => Math.floor(Date.now() / 1000);

export type Link = {
  id: string;
  kind: LinkKind;
  strategy: Strategy;
  state: LinkState;
  parentId: string;
  childId: string | null;
  parentUid: string | null;
  childUid: string | null;
  fromHarness: string;
  toHarness: string;
  fromHost: string;
  toHost: string;
  checkpoint: { line: number; bytes: number; sha256: string } | null;
  limitations: Limitation[];
  detail: Record<string, unknown>;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

function toLink(r: LinkRow): Link {
  const parse = <T>(s: string, d: T): T => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return d;
    }
  };
  return {
    id: r.id,
    kind: r.kind as LinkKind,
    strategy: r.strategy as Strategy,
    state: r.state as LinkState,
    parentId: r.parentId,
    childId: r.childId,
    parentUid: r.parentUid,
    childUid: r.childUid,
    fromHarness: r.fromHarness,
    toHarness: r.toHarness,
    fromHost: r.fromHost,
    toHost: r.toHost,
    checkpoint: r.checkpointLine !== null && r.checkpointBytes !== null && r.checkpointSha ? { line: r.checkpointLine, bytes: r.checkpointBytes, sha256: r.checkpointSha } : null,
    limitations: parse<Limitation[]>(r.limitationsJson, []),
    detail: parse<Record<string, unknown>>(r.detailJson, {}),
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export type Conversation = ConvRow;

export class PortableStore {
  private db: PrismaClient;
  private dir: string;

  constructor(db: PrismaClient, dir = PORTABLE_DIR()) {
    this.db = db;
    this.dir = dir;
  }

  /** Records (or refreshes) a conversation's identity row from a document read from it. */
  async upsertConversation(doc: PortableConversation, docPath: string | null): Promise<void> {
    const row = {
      harness: doc.source.harness,
      harnessId: doc.source.harnessId,
      host: doc.source.host,
      title: doc.title,
      cwd: doc.cwd,
      sourceFile: doc.source.file,
      sourceBytes: doc.source.bytes,
      sourceSha: doc.source.sha256,
      docVersion: doc.version,
      messages: doc.messages.length,
      updatedAt: now(),
      ...(docPath ? { docPath } : {}),
    };
    await this.db.conversation.upsert({ where: { id: doc.id }, create: { id: doc.id, createdAt: now(), ...row }, update: row });
  }

  /** An identity row for a conversation no document was read from yet (a continuation's destination). */
  async upsertConversationRow(c: { id: string; harness: string; harnessId: string; host: string; title: string; cwd: string }): Promise<void> {
    const row = { harness: c.harness, harnessId: c.harnessId, host: c.host, title: c.title, cwd: c.cwd, updatedAt: now() };
    await this.db.conversation.upsert({ where: { id: c.id }, create: { id: c.id, createdAt: now(), ...row }, update: row });
  }

  conversation(id: string): Promise<Conversation | null> {
    return this.db.conversation.findUnique({ where: { id } });
  }

  conversationOf(harness: string, harnessId: string): Promise<Conversation | null> {
    return this.db.conversation.findUnique({ where: { harness_harnessId: { harness, harnessId } } });
  }

  /** Where a document for `id` at this content hash lives (stable: the same bytes, the same file). */
  docPath(id: string, sha256: string): string {
    return join(this.dir, id, `${sha256.slice(0, 16)}.json`);
  }

  attachDir(id: string): string {
    return join(this.dir, id, 'attachments');
  }

  /**
   * Writes a document owner-only, atomically (a reader never sees half of one). A
   * document is named by the source bytes it was read from and never rewritten: the
   * first one stands, so its hash holds for anyone who recorded it (a lineage edge,
   * a migration under way).
   */
  async writeDoc(doc: PortableConversation): Promise<string> {
    const path = this.docPath(doc.id, doc.source.sha256);
    if (await stat(path).catch(() => null)) return path;
    await mkdir(join(this.dir, doc.id), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, JSON.stringify(doc), { mode: 0o600 });
    await rename(tmp, path);
    return path;
  }

  async readDoc(path: string): Promise<PortableConversation | null> {
    try {
      const doc = JSON.parse(await readFile(path, 'utf8')) as PortableConversation;
      return doc?.format === 'ah.portable-conversation' ? doc : null;
    } catch {
      return null;
    }
  }

  // ---------- links

  /** A new edge, written before anything it describes happens. An existing idempotency key returns its edge. */
  async createLink(l: Omit<Link, 'id' | 'createdAt' | 'updatedAt' | 'error' | 'childId'> & { childId?: string | null; idempotencyKey?: string | null }): Promise<{ link: Link; existed: boolean }> {
    if (l.idempotencyKey) {
      const prior = await this.db.conversationLink.findUnique({ where: { idempotencyKey: l.idempotencyKey } });
      if (prior) return { link: toLink(prior), existed: true };
    }
    const id = `lk-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    try {
      const row = await this.db.conversationLink.create({
        data: {
          id,
          kind: l.kind,
          strategy: l.strategy,
          state: l.state,
          parentId: l.parentId,
          childId: l.childId ?? null,
          parentUid: l.parentUid,
          childUid: l.childUid,
          fromHarness: l.fromHarness,
          toHarness: l.toHarness,
          fromHost: l.fromHost,
          toHost: l.toHost,
          checkpointLine: l.checkpoint?.line ?? null,
          checkpointBytes: l.checkpoint?.bytes ?? null,
          checkpointSha: l.checkpoint?.sha256 ?? null,
          limitationsJson: JSON.stringify(l.limitations),
          detailJson: JSON.stringify(l.detail),
          idempotencyKey: l.idempotencyKey ?? null,
          createdAt: now(),
          updatedAt: now(),
        },
      });
      return { link: toLink(row), existed: false };
    } catch (err) {
      // Two identical requests at once: the unique key let one in; the other gets its edge.
      if (l.idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const prior = await this.db.conversationLink.findUnique({ where: { idempotencyKey: l.idempotencyKey } });
        if (prior) return { link: toLink(prior), existed: true };
      }
      throw err;
    }
  }

  async updateLink(id: string, patch: Partial<Pick<Link, 'state' | 'childId' | 'childUid' | 'error' | 'detail' | 'limitations'>>): Promise<Link> {
    const data: Record<string, unknown> = { updatedAt: now() };
    if (patch.state) data.state = patch.state;
    if (patch.childId !== undefined) data.childId = patch.childId;
    if (patch.childUid !== undefined) data.childUid = patch.childUid;
    if (patch.error !== undefined) data.error = patch.error;
    if (patch.detail) data.detailJson = JSON.stringify(patch.detail);
    if (patch.limitations) data.limitationsJson = JSON.stringify(patch.limitations);
    return toLink(await this.db.conversationLink.update({ where: { id }, data }));
  }

  /** An edge that came with a conversation from another host (a migration), as it was there. */
  async importLink(l: { id: string; kind: string; strategy: string; parentId: string; childId: string | null; parentUid: string | null; childUid: string | null; fromHarness: string; toHarness: string; fromHost: string; toHost: string; checkpoint: Link['checkpoint']; limitations: unknown[]; detail: Record<string, unknown>; createdAt: number }): Promise<void> {
    await this.db.conversationLink.create({
      data: {
        id: l.id, kind: l.kind, strategy: l.strategy, state: 'linked', parentId: l.parentId, childId: l.childId, parentUid: l.parentUid, childUid: l.childUid,
        fromHarness: l.fromHarness, toHarness: l.toHarness, fromHost: l.fromHost, toHost: l.toHost,
        checkpointLine: l.checkpoint?.line ?? null, checkpointBytes: l.checkpoint?.bytes ?? null, checkpointSha: l.checkpoint?.sha256 ?? null,
        limitationsJson: JSON.stringify(l.limitations), detailJson: JSON.stringify(l.detail), createdAt: l.createdAt, updatedAt: now(),
      },
    });
  }

  async linkByKey(key: string): Promise<Link | null> {
    const r = await this.db.conversationLink.findUnique({ where: { idempotencyKey: key } });
    return r ? toLink(r) : null;
  }

  async link(id: string): Promise<Link | null> {
    const r = await this.db.conversationLink.findUnique({ where: { id } });
    return r ? toLink(r) : null;
  }

  /** Edges into a conversation (where it came from) and out of it (what came from it). */
  async edges(conversationId: string): Promise<{ parents: Link[]; children: Link[] }> {
    const [parents, children] = await Promise.all([
      this.db.conversationLink.findMany({ where: { childId: conversationId }, orderBy: { createdAt: 'asc' } }),
      this.db.conversationLink.findMany({ where: { parentId: conversationId }, orderBy: { createdAt: 'asc' } }),
    ]);
    return { parents: parents.map(toLink), children: children.map(toLink) };
  }

  /** The edge that made the session `uid` (it is chosen before the session launches). */
  async linkIntoUid(uid: string): Promise<Link | null> {
    const r = await this.db.conversationLink.findFirst({ where: { childUid: uid }, orderBy: { createdAt: 'desc' } });
    return r ? toLink(r) : null;
  }

  /** Operations a restart has to pick up again. */
  async unfinished(): Promise<Link[]> {
    const rows = await this.db.conversationLink.findMany({ where: { state: { in: ['preparing', 'launching', 'delivering'] } }, orderBy: { createdAt: 'asc' } });
    return rows.map(toLink);
  }

  async recent(limit = 50): Promise<Link[]> {
    return (await this.db.conversationLink.findMany({ orderBy: { createdAt: 'desc' }, take: limit })).map(toLink);
  }

  /** Every edge with a destination known, for drawing whole trees (small: one row per continuation). */
  async allLinks(): Promise<Link[]> {
    return (await this.db.conversationLink.findMany({ orderBy: { createdAt: 'asc' } })).map(toLink);
  }
}
