// HTTP for scheduled and conditional work, under /api/jobs (CND-4). Thin: validation
// in scheduler.ts. Behind the same gate as every route; creating a job is as strong
// as starting a session (it will, later, unattended), so it's audited, and jobs only
// ever launch configured agents.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from '../auth.ts';
import { actorUid, HttpError, readJson, send, str } from '../http.ts';
import { checkSessionControl, isAncestor, type SupervisionGraph } from '../supervision.ts';
import { type Action, type Scheduler } from './scheduler.ts';

type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

const JOB = '(jb-[0-9a-f]{8})';
const RUN = '(jr-[0-9a-f]{8})';

function who(caller: Caller | null, actor: string | null): string {
  if (actor) return `session:${actor}`;
  if (caller?.kind === 'token') return `token:${caller.token.name}`;
  if (caller?.kind === 'session') return `device:${caller.session.label || caller.session.id}`;
  return 'local';
}

function checkJobAction(actor: string | null, action: unknown, graph: SupervisionGraph, spaceOf?: (uid: string) => string | null): void {
  if (!actor || !action || typeof action !== 'object') return;
  const a = action as Partial<Action>;
  const actorSup = graph.get(actor);
  if (a.kind === 'launch') {
    if (actorSup?.managedBy && actorSup.role !== 'chief') {
      throw new HttpError(403, 'supervised worker sessions cannot schedule launch jobs', 'upward_control_denied');
    }
    return;
  }
  if (a.kind === 'send' && typeof a.target === 'string') {
    if (a.target.includes('{{')) {
      if (actorSup?.role !== 'chief') {
        throw new HttpError(403, 'only the user or a chief session can schedule jobs with template targets', 'upward_control_denied');
      }
      return;
    }
    // Allow a session to schedule a wake/heartbeat on itself (`ah heartbeat self`),
    // or downward on its descendants, never upward on its supervisor or laterally on siblings.
    if (a.target === actor) return;
    const verdict = checkSessionControl({ actorUid: actor, targetUid: a.target, graph, targetSpace: spaceOf?.(a.target), action: 'job' });
    if (!verdict.ok) throw new HttpError(403, verdict.message, verdict.code);
    return;
  }
  if (a.kind === 'decide' && a.then) {
    checkJobAction(actor, a.then, graph, spaceOf);
  }
}

function checkJobPolicy(actor: string | null, policy: unknown): void {
  if (!actor || !policy || typeof policy !== 'object') return;
  const p = policy as { allowDangerous?: unknown };
  if (p.allowDangerous === true) {
    throw new HttpError(403, 'only the human user may enable allowDangerous on a scheduled job', 'upward_control_denied');
  }
}

function checkJobTrigger(actor: string | null, trigger: unknown, graph: SupervisionGraph, spaceOf?: (uid: string) => string | null): void {
  if (!actor || !trigger || typeof trigger !== 'object') return;
  const t = trigger as { kind?: string; uid?: string; space?: string };
  if (t.kind !== 'session') return;
  const actorSup = graph.get(actor);
  if (t.uid === '*') {
    if (actorSup?.role !== 'chief') {
      throw new HttpError(403, 'only the user or a Chief of Staff can subscribe to fleet/Space-wide session events', 'upward_control_denied');
    }
    if (actorSup.space && t.space !== actorSup.space) {
      throw new HttpError(403, `chief ${actor} is scoped to Space "${actorSup.space}" and must set trigger.space="${actorSup.space}"`, 'not_managed_by_caller');
    }
  } else if (typeof t.uid === 'string' && t.uid && t.uid !== actor) {
    const verdict = checkSessionControl({ actorUid: actor, targetUid: t.uid, graph, targetSpace: spaceOf?.(t.uid), action: 'job' });
    if (!verdict.ok) throw new HttpError(403, verdict.message, verdict.code);
  }
}

function checkJobOwnership(actor: string | null, createdBy: string, action: Action, graph: SupervisionGraph, spaceOf?: (uid: string) => string | null): void {
  if (!actor) return;
  const ownerSession = createdBy.startsWith('session:')
    ? createdBy.slice('session:'.length)
    : createdBy.startsWith('system:chief:')
      ? createdBy.slice('system:chief:'.length)
      : null;
  // Acting sessions may never edit, pause, run, or cancel human-owned jobs.
  if (!ownerSession) {
    throw new HttpError(403, `session ${actor} cannot modify a human-owned job`, 'upward_control_denied');
  }
  // A session can manage its own jobs or jobs created by its descendants.
  if (ownerSession === actor || isAncestor(actor, ownerSession, graph)) {
    checkJobAction(actor, action, graph, spaceOf);
    return;
  }
  // A supervised worker/reviewer cannot pause, edit, run, or cancel jobs created by humans or other sessions.
  const actorSup = graph.get(actor);
  if (isAncestor(ownerSession, actor, graph)) {
    throw new HttpError(403, `unidirectional control: session ${actor} cannot modify job owned by supervisor ${ownerSession}`, 'upward_control_denied');
  }
  if (actorSup?.managedBy && actorSup.role !== 'chief') {
    throw new HttpError(403, `supervised session ${actor} cannot modify jobs it does not own`, 'upward_control_denied');
  }
  checkJobAction(actor, action, graph, spaceOf);
}

export async function jobsApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  caller: Caller | null,
  svc: Scheduler,
  audit: Audit,
  graph?: () => SupervisionGraph,
  spaceOf?: (uid: string) => string | null,
): Promise<void> {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: string) => (method === verb ? path.match(new RegExp(`^/api/jobs${re}$`)) : null);
  const actor = actorUid(req);
  const supGraph = () => graph?.() ?? new Map();
  let m: RegExpMatchArray | null;
  if (route('GET', '')) return send(res, 200, { jobs: await svc.list(), state: svc.state() });
  if (route('POST', '')) {
    const body = await readJson(req);
    const g = supGraph();
    checkJobAction(actor, body.action, g, spaceOf);
    checkJobTrigger(actor, body.trigger, g, spaceOf);
    checkJobPolicy(actor, body.policy);
    const job = await svc.create({ name: body.name === undefined ? 'Job' : str(body.name, 'name', 120), action: body.action, trigger: body.trigger, policy: body.policy, createdBy: who(caller, actor) });
    audit(req, 'job.create', { id: job.id, name: job.name, action: job.action.kind, trigger: job.trigger.kind });
    return send(res, 201, job);
  }
  if ((m = route('GET', `/runs/${RUN}`))) return send(res, 200, await svc.run(m[1]));
  if ((m = route('POST', `/runs/${RUN}/decide`))) {
    if (actor) throw new HttpError(403, 'only the user can answer decision requests', 'self_control_denied');
    const body = await readJson(req);
    if (typeof body.approve !== 'boolean') throw new HttpError(400, 'approve must be true or false', 'invalid_decision');
    const out = await svc.decide(m[1], { approve: body.approve, note: body.note === undefined ? undefined : str(body.note, 'note', 2000) });
    audit(req, 'job.decide', { run: m[1], approve: body.approve });
    return send(res, 200, out);
  }
  if ((m = route('POST', `/runs/${RUN}/resolve`))) {
    if (actor) {
      const g = supGraph();
      const sup = g.get(actor);
      if (sup?.managedBy && sup.role !== 'chief') throw new HttpError(403, 'supervised worker sessions cannot resolve uncertain job runs', 'upward_control_denied');
    }
    const body = await readJson(req);
    const out = await svc.resolveUncertain(m[1], { resend: body.resend === true });
    audit(req, 'job.resolve', { run: m[1], resend: body.resend === true });
    return send(res, 200, out);
  }
  if ((m = route('GET', `/${JOB}`))) return send(res, 200, await svc.get(m[1]));
  if ((m = route('PATCH', `/${JOB}`))) {
    const body = await readJson(req);
    const g = supGraph();
    if (actor) {
      const existing = await svc.get(m[1]);
      checkJobOwnership(actor, existing.createdBy, existing.action, g, spaceOf);
      if (body.action !== undefined) checkJobAction(actor, body.action, g, spaceOf);
      if (body.trigger !== undefined) checkJobTrigger(actor, body.trigger, g, spaceOf);
      if (body.policy !== undefined) checkJobPolicy(actor, body.policy);
    }
    const job = await svc.update(m[1], { name: body.name === undefined ? undefined : str(body.name, 'name', 120), action: body.action, trigger: body.trigger, policy: body.policy });
    audit(req, 'job.edit', { id: m[1] });
    return send(res, 200, job);
  }
  if ((m = route('POST', `/${JOB}/(pause|resume|cancel|run)`))) {
    const verb = m[2];
    if (actor) {
      const existing = await svc.get(m[1]);
      checkJobOwnership(actor, existing.createdBy, existing.action, supGraph(), spaceOf);
    }
    const out = verb === 'pause' ? await svc.pause(m[1]) : verb === 'resume' ? await svc.resume(m[1]) : verb === 'cancel' ? await svc.cancel(m[1]) : await svc.runNow(m[1]);
    audit(req, `job.${verb}`, { id: m[1] });
    return send(res, 200, out);
  }
  throw new HttpError(404, 'not found');
}
