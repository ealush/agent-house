// Durable fleet work ledger (SQLite via PrismaClient port): tracks tasks, assignments,
// dependencies, verification commands and results outside any single agent's context window.
import { randomUUID } from 'node:crypto';
import type { PrismaClient, FleetTask as TaskRow } from '@prisma/client';
import { FleetError } from './mailbox.ts';

export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'cancelled';
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'];

export type VerifyRecord = {
  at: number;
  command: string;
  exitCode: number;
  ok: boolean;
  output?: string;
};

export type TaskView = {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: number;
  ownerUid: string | null;
  assignedUid: string | null;
  space: string | null;
  checkoutId: string | null;
  dependsOn: string[];
  verifyCmd: string | null;
  lastVerify: VerifyRecord | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

const now = () => Math.floor(Date.now() / 1000);
const makeId = () => `tk-${randomUUID().replace(/-/g, '').slice(0, 8)}`;

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseVerify(raw: string | null): VerifyRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as VerifyRecord) : null;
  } catch {
    return null;
  }
}

function view(r: TaskRow): TaskView {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    status: (TASK_STATUSES as readonly string[]).includes(r.status) ? (r.status as TaskStatus) : 'todo',
    priority: r.priority,
    ownerUid: r.ownerUid,
    assignedUid: r.assignedUid,
    space: r.space,
    checkoutId: r.checkoutId,
    dependsOn: parseList(r.dependsOnJson),
    verifyCmd: r.verifyCmd,
    lastVerify: parseVerify(r.lastVerifyJson),
    result: r.result,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function checkUid(val: unknown, field: string): string | null {
  if (val === undefined || val === null || val === '') return null;
  if (typeof val !== 'string' || !/^[\w-]{1,40}$/.test(val.trim())) {
    throw new FleetError(400, 'invalid_task', `${field} must be a valid session uid`);
  }
  return val.trim();
}

function checkPriority(val: unknown): number {
  if (val === undefined) return 2;
  if (typeof val !== 'number' || !Number.isInteger(val) || val < 0 || val > 3) {
    throw new FleetError(400, 'invalid_task', 'priority must be an integer 0..3');
  }
  return val;
}

function checkDepends(val: unknown): string[] {
  if (val === undefined || val === null) return [];
  if (!Array.isArray(val) || val.length > 50 || val.some((x) => typeof x !== 'string' || !/^tk-[0-9a-f]{8}$/.test(x))) {
    throw new FleetError(400, 'invalid_task', 'dependsOn must be a list of task ids (tk-xxxxxxxx)');
  }
  return [...new Set(val)];
}

export class TaskStore {
  private db: PrismaClient;
  private onChange?: () => void;

  constructor(db: PrismaClient, onChange?: () => void) {
    this.db = db;
    this.onChange = onChange;
  }

  async create(input: {
    title: string;
    description?: string;
    status?: string;
    priority?: number;
    ownerUid?: string | null;
    assignedUid?: string | null;
    space?: string | null;
    checkoutId?: string | null;
    dependsOn?: string[];
    verifyCmd?: string | null;
  }): Promise<TaskView> {
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    if (!title || title.length > 200) throw new FleetError(400, 'invalid_task', 'title is required (at most 200 characters)');
    const description = typeof input.description === 'string' ? input.description.slice(0, 32_768) : '';
    const status = input.status ?? 'todo';
    if (!(TASK_STATUSES as readonly string[]).includes(status)) {
      throw new FleetError(400, 'invalid_task', `status must be one of: ${TASK_STATUSES.join(', ')}`);
    }
    const priority = checkPriority(input.priority);
    const ownerUid = checkUid(input.ownerUid, 'ownerUid');
    const assignedUid = checkUid(input.assignedUid, 'assignedUid');
    const space = typeof input.space === 'string' && input.space.trim() ? input.space.trim().slice(0, 120) : null;
    const checkoutId = typeof input.checkoutId === 'string' && input.checkoutId.trim() ? input.checkoutId.trim().slice(0, 40) : null;
    const dependsOn = checkDepends(input.dependsOn);
    const verifyCmd = typeof input.verifyCmd === 'string' && input.verifyCmd.trim() ? input.verifyCmd.trim().slice(0, 4000) : null;
    const ts = now();
    const row = await this.db.fleetTask.create({
      data: {
        id: makeId(),
        title,
        description,
        status,
        priority,
        ownerUid,
        assignedUid,
        space,
        checkoutId,
        dependsOnJson: JSON.stringify(dependsOn),
        verifyCmd,
        createdAt: ts,
        updatedAt: ts,
      },
    });
    this.onChange?.();
    return view(row);
  }

  async list(filter: { status?: string; assignedUid?: string; ownerUid?: string; space?: string; limit?: number } = {}): Promise<TaskView[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(filter.limit ?? 100)));
    const where: Record<string, unknown> = {};
    if (filter.status) where.status = filter.status;
    if (filter.assignedUid) where.assignedUid = filter.assignedUid;
    if (filter.ownerUid) where.ownerUid = filter.ownerUid;
    if (filter.space) where.space = filter.space;
    const rows = await this.db.fleetTask.findMany({ where, orderBy: [{ priority: 'asc' }, { updatedAt: 'desc' }], take: limit });
    return rows.map(view);
  }

  async get(id: string): Promise<TaskView> {
    const row = await this.db.fleetTask.findUnique({ where: { id } });
    if (!row) throw new FleetError(404, 'task_not_found', 'no such task');
    return view(row);
  }

  async update(
    id: string,
    patch: {
      title?: string;
      description?: string;
      status?: string;
      priority?: number;
      ownerUid?: string | null;
      assignedUid?: string | null;
      space?: string | null;
      checkoutId?: string | null;
      dependsOn?: string[];
      verifyCmd?: string | null;
      lastVerify?: VerifyRecord | null;
      result?: string | null;
    },
  ): Promise<TaskView> {
    const existing = await this.db.fleetTask.findUnique({ where: { id } });
    if (!existing) throw new FleetError(404, 'task_not_found', 'no such task');
    const data: Record<string, unknown> = { updatedAt: now() };
    if (patch.title !== undefined) {
      const t = typeof patch.title === 'string' ? patch.title.trim() : '';
      if (!t || t.length > 200) throw new FleetError(400, 'invalid_task', 'title must be 1..200 characters');
      data.title = t;
    }
    if (patch.description !== undefined) data.description = typeof patch.description === 'string' ? patch.description.slice(0, 32_768) : '';
    if (patch.status !== undefined) {
      if (!(TASK_STATUSES as readonly string[]).includes(patch.status)) {
        throw new FleetError(400, 'invalid_task', `status must be one of: ${TASK_STATUSES.join(', ')}`);
      }
      data.status = patch.status;
    }
    if (patch.priority !== undefined) data.priority = checkPriority(patch.priority);
    if ('ownerUid' in patch) data.ownerUid = checkUid(patch.ownerUid, 'ownerUid');
    if ('assignedUid' in patch) data.assignedUid = checkUid(patch.assignedUid, 'assignedUid');
    if ('space' in patch) data.space = typeof patch.space === 'string' && patch.space.trim() ? patch.space.trim().slice(0, 120) : null;
    if ('checkoutId' in patch) data.checkoutId = typeof patch.checkoutId === 'string' && patch.checkoutId.trim() ? patch.checkoutId.trim().slice(0, 40) : null;
    if (patch.dependsOn !== undefined) data.dependsOnJson = JSON.stringify(checkDepends(patch.dependsOn));
    if ('verifyCmd' in patch) data.verifyCmd = typeof patch.verifyCmd === 'string' && patch.verifyCmd.trim() ? patch.verifyCmd.trim().slice(0, 4000) : null;
    if ('lastVerify' in patch) data.lastVerifyJson = patch.lastVerify ? JSON.stringify(patch.lastVerify) : null;
    if ('result' in patch) data.result = typeof patch.result === 'string' ? patch.result.slice(0, 32_768) : null;
    const row = await this.db.fleetTask.update({ where: { id }, data });
    this.onChange?.();
    return view(row);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.db.fleetTask.findUnique({ where: { id } });
    if (!existing) throw new FleetError(404, 'task_not_found', 'no such task');
    await this.db.fleetTask.delete({ where: { id } });
    this.onChange?.();
  }

  /** Rebinds task ownership/assignment when a session or Chief is relaunched under a new uid. */
  async rekey(oldUid: string, newUid: string): Promise<void> {
    if (!oldUid || !newUid || oldUid === newUid) return;
    await this.db.fleetTask.updateMany({ where: { ownerUid: oldUid }, data: { ownerUid: newUid } });
    await this.db.fleetTask.updateMany({ where: { assignedUid: oldUid }, data: { assignedUid: newUid } });
    this.onChange?.();
  }
}
