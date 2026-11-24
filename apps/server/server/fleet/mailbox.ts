// Durable cross-session asynchronous mailbox (SQLite via PrismaClient port).
// Pure core + passed-in PrismaClient: zero ambient I/O.
import { randomUUID } from 'node:crypto';
import type { PrismaClient, MailboxMessage as MessageRow } from '@prisma/client';
import { DomainError } from '../errors.ts';

export type MailKind = 'message' | 'directive' | 'report' | 'blocker' | 'handoff';
export const MAIL_KINDS: readonly MailKind[] = ['message', 'directive', 'report', 'blocker', 'handoff'];

export class FleetError extends DomainError {
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
  }
}

export type MailView = {
  id: string;
  fromUid: string | null;
  toUid: string;
  threadId: string | null;
  kind: MailKind;
  subject: string;
  body: string;
  meta: Record<string, unknown>;
  readAt: number | null;
  ackedAt: number | null;
  createdAt: number;
};

const now = () => Math.floor(Date.now() / 1000);
const makeId = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isBroadcast(toUid: string): boolean {
  return toUid === '*' || toUid.startsWith('siblings:');
}

function ackedMap(meta: Record<string, unknown>): Record<string, number> {
  const raw = meta.ackedBy;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function view(r: MessageRow, forUid?: string | null): MailView {
  const meta = parseMeta(r.metaJson);
  const perRecipient = forUid && isBroadcast(r.toUid) ? ackedMap(meta)[forUid] ?? null : null;
  const effectiveAcked = isBroadcast(r.toUid) && forUid ? (perRecipient ?? r.ackedAt) : r.ackedAt;
  return {
    id: r.id,
    fromUid: r.fromUid,
    toUid: r.toUid,
    threadId: r.threadId,
    kind: (MAIL_KINDS as readonly string[]).includes(r.kind) ? (r.kind as MailKind) : 'message',
    subject: r.subject,
    body: r.body,
    meta,
    readAt: effectiveAcked ? (r.readAt ?? effectiveAcked) : r.readAt,
    ackedAt: effectiveAcked,
    createdAt: r.createdAt,
  };
}

export class MailboxStore {
  private db: PrismaClient;
  private onChange?: () => void;

  constructor(db: PrismaClient, onChange?: () => void) {
    this.db = db;
    this.onChange = onChange;
  }

  async send(input: {
    fromUid?: string | null;
    toUid: string;
    threadId?: string | null;
    kind?: string;
    subject?: string;
    body: string;
    meta?: Record<string, unknown>;
  }): Promise<MailView> {
    const toUid = typeof input.toUid === 'string' ? input.toUid.trim() : '';
    if (!toUid || (toUid !== '*' && !/^[\w-]{1,40}$/.test(toUid) && !/^siblings:[\w-]{1,40}$/.test(toUid))) {
      throw new FleetError(400, 'invalid_recipient', 'toUid must be a session uid, "siblings:<uid>", or "*"');
    }
    const fromUid = input.fromUid && typeof input.fromUid === 'string' ? input.fromUid.trim() : null;
    if (fromUid && !/^[\w-]{1,40}$/.test(fromUid)) {
      throw new FleetError(400, 'invalid_sender', 'invalid fromUid');
    }
    const kind = input.kind ?? 'message';
    if (!(MAIL_KINDS as readonly string[]).includes(kind)) {
      throw new FleetError(400, 'invalid_kind', `kind must be one of: ${MAIL_KINDS.join(', ')}`);
    }
    const body = typeof input.body === 'string' ? input.body : '';
    if (!body.trim() || body.length > 65_536) {
      throw new FleetError(400, 'invalid_body', 'body is required (at most 65536 characters)');
    }
    const subject = typeof input.subject === 'string' ? input.subject.trim().slice(0, 200) : '';
    const threadId = input.threadId && typeof input.threadId === 'string' ? input.threadId.trim().slice(0, 64) : null;
    const meta = input.meta && typeof input.meta === 'object' && !Array.isArray(input.meta) ? input.meta : {};
    const row = await this.db.mailboxMessage.create({
      data: {
        id: makeId('mb'),
        fromUid,
        toUid,
        threadId,
        kind,
        subject,
        body,
        metaJson: JSON.stringify(meta),
        createdAt: now(),
      },
    });
    this.onChange?.();
    return view(row);
  }

  async list(filter: { toUid?: string; siblingGroup?: string | null; fromUid?: string; threadId?: string; unread?: boolean; includeBroadcast?: boolean; limit?: number } = {}): Promise<MailView[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 50)));
    const where: Record<string, unknown> = {};
    if (filter.toUid) {
      if (filter.includeBroadcast !== false && !isBroadcast(filter.toUid)) {
        const recipients = [filter.toUid, '*'];
        if (filter.siblingGroup) recipients.push(filter.siblingGroup);
        where.toUid = { in: recipients };
      } else {
        where.toUid = filter.toUid;
      }
    }
    if (filter.fromUid) where.fromUid = filter.fromUid;
    if (filter.threadId) where.threadId = filter.threadId;
    if (filter.unread && (!filter.toUid || isBroadcast(filter.toUid))) where.ackedAt = null;
    const rows = await this.db.mailboxMessage.findMany({ where, orderBy: { createdAt: 'desc' }, take: filter.unread ? Math.min(400, limit * 4) : limit });
    const recipient = filter.toUid && !isBroadcast(filter.toUid) ? filter.toUid : null;
    let out = rows
      // Don't echo a session's own broadcasts back into its own inbox.
      .filter((r) => !(recipient && r.fromUid === recipient && isBroadcast(r.toUid)))
      .map((r) => view(r, recipient));
    if (filter.unread) out = out.filter((m) => m.ackedAt === null);
    return out.slice(0, limit);
  }

  async get(id: string, forUid?: string | null): Promise<MailView> {
    const row = await this.db.mailboxMessage.findUnique({ where: { id } });
    if (!row) throw new FleetError(404, 'mail_not_found', 'no such message');
    return view(row, forUid);
  }

  async ack(id: string, actorUid?: string | null): Promise<MailView> {
    const existing = await this.db.mailboxMessage.findUnique({ where: { id } });
    if (!existing) throw new FleetError(404, 'mail_not_found', 'no such message');
    const ts = now();
    // Per-recipient receipts for broadcast messages (`*` or `siblings:<uid>`):
    // acknowledging as one sibling never hides the broadcast from other siblings.
    if (isBroadcast(existing.toUid) && actorUid) {
      const meta = parseMeta(existing.metaJson);
      const receipts = ackedMap(meta);
      if (!receipts[actorUid]) receipts[actorUid] = ts;
      const nextMeta = { ...meta, ackedBy: receipts };
      const row = await this.db.mailboxMessage.update({
        where: { id },
        data: { readAt: existing.readAt ?? ts, metaJson: JSON.stringify(nextMeta) },
      });
      this.onChange?.();
      return view(row, actorUid);
    }
    const row = await this.db.mailboxMessage.update({
      where: { id },
      data: { readAt: existing.readAt ?? ts, ackedAt: existing.ackedAt ?? ts },
    });
    this.onChange?.();
    return view(row, actorUid);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.db.mailboxMessage.findUnique({ where: { id } });
    if (!existing) throw new FleetError(404, 'mail_not_found', 'no such message');
    await this.db.mailboxMessage.delete({ where: { id } });
    this.onChange?.();
  }

  /** Rebinds mailbox addresses when a session/Chief is relaunched under a new uid. */
  async rekey(oldUid: string, newUid: string): Promise<void> {
    if (!oldUid || !newUid || oldUid === newUid) return;
    await this.db.mailboxMessage.updateMany({ where: { toUid: oldUid }, data: { toUid: newUid } });
    await this.db.mailboxMessage.updateMany({ where: { toUid: `siblings:${oldUid}` }, data: { toUid: `siblings:${newUid}` } });
    this.onChange?.();
  }

  /** Prunes acknowledged mail older than `maxAgeSeconds` (default 30 days). */
  async pruneOlderThan(maxAgeSeconds = 30 * 86_400): Promise<number> {
    const cutoff = now() - maxAgeSeconds;
    const res = await this.db.mailboxMessage.deleteMany({
      where: { ackedAt: { not: null }, createdAt: { lt: cutoff } },
    });
    return res.count;
  }
}
