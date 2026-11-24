// HTTP sub-router for cross-session coordination under /api/fleet:
// asynchronous mailbox (/api/fleet/mailbox) and durable task ledger (/api/fleet/tasks).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { actorUid, HttpError, readJson, send } from '../http.ts';
import { checkMailSend, hierarchyRelation, isAncestor, siblingGroupOf, type SupervisionGraph } from '../supervision.ts';
import type { MailboxStore } from './mailbox.ts';
import type { TaskStore } from './tasks.ts';

type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

const MAIL = '(mb-[0-9a-f]{8})';
const TASK = '(tk-[0-9a-f]{8})';

const ASSIGNEE_ALLOWED_PATCH_KEYS = new Set(['status', 'result', 'description']);

function checkTaskAssign(
  actor: string,
  assignedUid: string,
  g: SupervisionGraph,
  spaceOf?: (uid: string) => string | null,
): void {
  const rel = hierarchyRelation(actor, assignedUid, g);
  if (rel === 'upward') {
    throw new HttpError(403, `unidirectional control: session ${actor} cannot assign tasks to supervisor/chief ${assignedUid}`, 'upward_control_denied');
  }
  if (rel === 'sibling') {
    throw new HttpError(403, `supervised session ${actor} cannot assign tasks directly to sibling ${assignedUid}`, 'lateral_control_denied');
  }
  const actorSup = g.get(actor);
  if (rel === 'peer') {
    if (actorSup?.managedBy && actorSup.role !== 'chief') {
      throw new HttpError(403, `supervised session ${actor} cannot assign tasks outside its subtree`, 'lateral_control_denied');
    }
    const targetSup = g.get(assignedUid);
    if (targetSup?.managedBy) {
      throw new HttpError(403, `session ${assignedUid} is supervised by ${targetSup.managedBy}, not ${actor}`, 'not_managed_by_caller');
    }
    if (actorSup?.role !== 'chief') {
      throw new HttpError(403, `session ${actor} cannot assign tasks to peer ${assignedUid}`, 'not_managed_by_caller');
    }
    if (actorSup.space && spaceOf) {
      const targetSpace = spaceOf(assignedUid);
      if (targetSpace !== actorSup.space) {
        throw new HttpError(403, `chief ${actor} is scoped to Space "${actorSup.space}", not "${targetSpace ?? 'none'}"`, 'not_managed_by_caller');
      }
    }
  }
}

export async function fleetApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  o: {
    mailbox: MailboxStore;
    tasks: TaskStore;
    graph?: () => SupervisionGraph;
    spaceOf?: (uid: string) => string | null;
    wake?: (uid: string, text: string, actorUid: string | null) => Promise<void>;
    audit: Audit;
  },
): Promise<void> {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: string) => (method === verb ? path.match(new RegExp(`^/api/fleet${re}$`)) : null);
  const actor = actorUid(req);
  const supGraph = () => o.graph?.() ?? new Map();
  let m: RegExpMatchArray | null;

  // ---------- mailbox
  if (route('GET', '/mailbox')) {
    const g = supGraph();
    const requestedTo = url.searchParams.get('to') ?? undefined;
    // Privacy: a session can only inspect its own inbox or its descendants' inboxes.
    const to = actor && !requestedTo ? actor : requestedTo;
    if (actor && to) {
      const ownGroup = siblingGroupOf(actor, g);
      const allowed =
        to === actor ||
        to === '*' ||
        (ownGroup !== null && to === ownGroup) ||
        to === `siblings:${actor}` ||
        (to.startsWith('siblings:') && isAncestor(actor, to.slice('siblings:'.length), g)) ||
        (!to.startsWith('siblings:') && isAncestor(actor, to, g));
      if (!allowed) {
        throw new HttpError(403, `session ${actor} cannot read mailbox addressed to ${to}`, 'upward_control_denied');
      }
    }
    const siblingGroup = to && to !== '*' && !to.startsWith('siblings:') ? siblingGroupOf(to, g) : null;
    const messages = await o.mailbox.list({
      toUid: to,
      siblingGroup,
      fromUid: url.searchParams.get('from') ?? undefined,
      threadId: url.searchParams.get('thread') ?? undefined,
      unread: url.searchParams.get('unread') === '1',
      includeBroadcast: url.searchParams.get('broadcast') !== '0',
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
    });
    return send(res, 200, { messages });
  }
  if (route('POST', '/mailbox')) {
    const body = await readJson(req, 256 * 1024);
    const g = supGraph();
    // Sessions cannot spoof another session as sender.
    const fromUid = actor ?? (typeof body.fromUid === 'string' && body.fromUid.trim() ? body.fromUid.trim() : null);
    const rawTo = String(body.toUid ?? '');
    const kind = typeof body.kind === 'string' ? body.kind : undefined;
    const targetSpace = rawTo && rawTo !== '*' && !rawTo.startsWith('siblings') ? o.spaceOf?.(rawTo) : undefined;
    const check = checkMailSend({ actorUid: actor, toUid: rawTo, kind, graph: g, targetSpace });
    if (!check.ok) throw new HttpError(check.status, check.message, check.code);
    const msg = await o.mailbox.send({
      fromUid,
      toUid: check.resolvedTo,
      threadId: typeof body.threadId === 'string' ? body.threadId : null,
      kind,
      subject: typeof body.subject === 'string' ? body.subject : undefined,
      body: typeof body.body === 'string' ? body.body : '',
      meta: body.meta && typeof body.meta === 'object' && !Array.isArray(body.meta) ? (body.meta as Record<string, unknown>) : undefined,
    });
    o.audit(req, 'fleet.mail.send', { id: msg.id, from: msg.fromUid, to: msg.toUid, kind: msg.kind });
    if (body.wake === true && check.allowWake && o.wake) {
      const note = `[ah mail ${msg.id}${msg.fromUid ? ` from ${msg.fromUid}` : ''}${msg.subject ? ` · ${msg.subject}` : ''}] Read with: ah mail inbox self`;
      await o.wake(msg.toUid, note, actor).catch(() => {});
    }
    return send(res, 201, msg);
  }
  if ((m = route('GET', `/mailbox/${MAIL}`))) {
    const existing = await o.mailbox.get(m[1], actor);
    if (actor) {
      const g = supGraph();
      const ownGroup = siblingGroupOf(actor, g);
      const canRead =
        existing.fromUid === actor ||
        existing.toUid === actor ||
        existing.toUid === '*' ||
        (ownGroup !== null && existing.toUid === ownGroup) ||
        existing.toUid === `siblings:${actor}` ||
        (existing.toUid.startsWith('siblings:') && isAncestor(actor, existing.toUid.slice('siblings:'.length), g)) ||
        (!existing.toUid.startsWith('siblings:') && isAncestor(actor, existing.toUid, g)) ||
        (existing.fromUid !== null && isAncestor(actor, existing.fromUid, g));
      if (!canRead) {
        throw new HttpError(403, `session ${actor} cannot read mail belonging to ${existing.toUid}`, 'upward_control_denied');
      }
    }
    return send(res, 200, existing);
  }
  if ((m = route('POST', `/mailbox/${MAIL}/ack`))) {
    if (actor) {
      const existing = await o.mailbox.get(m[1], actor);
      const g = supGraph();
      const ownGroup = siblingGroupOf(actor, g);
      const canAck =
        existing.toUid === actor ||
        existing.toUid === '*' ||
        (ownGroup !== null && existing.toUid === ownGroup) ||
        isAncestor(actor, existing.toUid, g);
      if (!canAck) {
        throw new HttpError(403, `session ${actor} cannot acknowledge mail addressed to ${existing.toUid}`, 'upward_control_denied');
      }
    }
    const msg = await o.mailbox.ack(m[1], actor);
    o.audit(req, 'fleet.mail.ack', { id: msg.id });
    return send(res, 200, msg);
  }
  if ((m = route('DELETE', `/mailbox/${MAIL}`))) {
    if (actor) {
      const existing = await o.mailbox.get(m[1], actor);
      const g = supGraph();
      const canDelete =
        existing.fromUid === actor ||
        existing.toUid === actor ||
        isAncestor(actor, existing.toUid, g) ||
        (existing.fromUid !== null && isAncestor(actor, existing.fromUid, g));
      if (!canDelete) {
        throw new HttpError(403, `session ${actor} cannot delete mail belonging to ${existing.toUid}`, 'upward_control_denied');
      }
    }
    await o.mailbox.remove(m[1]);
    o.audit(req, 'fleet.mail.delete', { id: m[1] });
    return send(res, 200, { ok: true });
  }

  // ---------- tasks
  if (route('GET', '/tasks')) {
    let spaceFilter = url.searchParams.get('space') ?? undefined;
    if (actor) {
      const g = supGraph();
      const actorSup = g.get(actor);
      const actorSpace = actorSup?.space ?? (actorSup?.managedBy ? o.spaceOf?.(actor) ?? undefined : undefined);
      if (actorSpace) {
        if (spaceFilter && spaceFilter !== actorSpace) {
          throw new HttpError(403, `session ${actor} is scoped to Space "${actorSpace}", not "${spaceFilter}"`, 'not_managed_by_caller');
        }
        spaceFilter = actorSpace;
      }
    }
    const tasks = await o.tasks.list({
      status: url.searchParams.get('status') ?? undefined,
      assignedUid: url.searchParams.get('assigned') ?? undefined,
      ownerUid: url.searchParams.get('owner') ?? undefined,
      space: spaceFilter,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
    });
    return send(res, 200, { tasks });
  }
  if (route('POST', '/tasks')) {
    const body = await readJson(req, 256 * 1024);
    const g = supGraph();
    const assignedUid = typeof body.assignedUid === 'string' && body.assignedUid.trim() ? body.assignedUid.trim() : null;
    const requestedSpace = typeof body.space === 'string' && body.space.trim() ? body.space.trim() : null;
    if (actor) {
      const actorSup = g.get(actor);
      if (actorSup?.role === 'chief' && actorSup.space && requestedSpace && requestedSpace !== actorSup.space) {
        throw new HttpError(403, `chief ${actor} is scoped to Space "${actorSup.space}", not "${requestedSpace}"`, 'not_managed_by_caller');
      }
      if (assignedUid) checkTaskAssign(actor, assignedUid, g, o.spaceOf);
    }
    const ownerUid = actor ?? (typeof body.ownerUid === 'string' ? body.ownerUid : null);
    const space = requestedSpace ?? (actor ? g.get(actor)?.space ?? o.spaceOf?.(actor) ?? null : null);
    const task = await o.tasks.create({
      title: typeof body.title === 'string' ? body.title : '',
      description: typeof body.description === 'string' ? body.description : undefined,
      status: typeof body.status === 'string' ? body.status : undefined,
      priority: typeof body.priority === 'number' ? body.priority : undefined,
      ownerUid,
      assignedUid,
      space,
      checkoutId: typeof body.checkoutId === 'string' ? body.checkoutId : null,
      dependsOn: Array.isArray(body.dependsOn) ? (body.dependsOn as string[]) : undefined,
      verifyCmd: typeof body.verifyCmd === 'string' ? body.verifyCmd : null,
    });
    o.audit(req, 'fleet.task.create', { id: task.id, assigned: task.assignedUid, space: task.space });
    return send(res, 201, task);
  }
  if ((m = route('GET', `/tasks/${TASK}`))) {
    const task = await o.tasks.get(m[1]);
    if (actor) {
      const g = supGraph();
      const actorSup = g.get(actor);
      const actorSpace = actorSup?.space ?? (actorSup?.managedBy ? o.spaceOf?.(actor) ?? undefined : undefined);
      if (actorSpace && task.space && task.space !== actorSpace && task.assignedUid !== actor && task.ownerUid !== actor) {
        throw new HttpError(403, `session ${actor} is scoped to Space "${actorSpace}" and cannot read task in "${task.space}"`, 'not_managed_by_caller');
      }
    }
    return send(res, 200, task);
  }
  if ((m = route('PATCH', `/tasks/${TASK}`))) {
    const body = await readJson(req, 256 * 1024);
    if (actor) {
      const existing = await o.tasks.get(m[1]);
      const g = supGraph();
      const actorSup = g.get(actor);
      const ownsOrSupervises =
        existing.ownerUid === actor ||
        (existing.ownerUid !== null && isAncestor(actor, existing.ownerUid, g)) ||
        (existing.assignedUid !== null && isAncestor(actor, existing.assignedUid, g)) ||
        (actorSup?.role === 'chief' && (!actorSup.space || existing.space === actorSup.space) && existing.ownerUid === null);
      const isAssignee = existing.assignedUid === actor;
      if (!ownsOrSupervises && !isAssignee) {
        throw new HttpError(403, `session ${actor} cannot modify task ${existing.id} it does not own or supervise`, 'upward_control_denied');
      }
      if (!ownsOrSupervises && isAssignee) {
        // Assignees can only update progress (`status`, `result`, `description`), never verification commands/records or assignment.
        const forbidden = Object.keys(body).filter((k) => !ASSIGNEE_ALLOWED_PATCH_KEYS.has(k));
        if (forbidden.length) {
          throw new HttpError(
            403,
            `assignee ${actor} cannot modify ${forbidden.join(', ')} on a supervisor's task (only status, result, description)`,
            'upward_control_denied',
          );
        }
      }
      if (actorSup?.role === 'chief' && actorSup.space && typeof body.space === 'string' && body.space.trim() && body.space.trim() !== actorSup.space) {
        throw new HttpError(403, `chief ${actor} is scoped to Space "${actorSup.space}", not "${body.space.trim()}"`, 'not_managed_by_caller');
      }
      if (typeof body.assignedUid === 'string' && body.assignedUid.trim()) {
        checkTaskAssign(actor, body.assignedUid.trim(), g, o.spaceOf);
      }
    }
    const task = await o.tasks.update(m[1], body as never);
    o.audit(req, 'fleet.task.update', { id: task.id, status: task.status, assigned: task.assignedUid });
    return send(res, 200, task);
  }
  if ((m = route('DELETE', `/tasks/${TASK}`))) {
    if (actor) {
      const existing = await o.tasks.get(m[1]);
      const g = supGraph();
      const actorSup = g.get(actor);
      const canDelete =
        existing.ownerUid === actor ||
        (existing.ownerUid !== null && isAncestor(actor, existing.ownerUid, g)) ||
        (actorSup?.role === 'chief' && (!actorSup.space || existing.space === actorSup.space) && existing.ownerUid === null);
      if (!canDelete) {
        throw new HttpError(403, `unidirectional control: session ${actor} cannot delete task ${existing.id}`, 'upward_control_denied');
      }
    }
    await o.tasks.remove(m[1]);
    o.audit(req, 'fleet.task.delete', { id: m[1] });
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'not found');
}
