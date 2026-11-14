// HTTP for scheduled and conditional work, under /api/jobs (CND-4). Thin: validation
// in scheduler.ts. Behind the same gate as every route; creating a job is as strong
// as starting a session (it will, later, unattended), so it's audited, and jobs only
// ever launch configured agents.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from '../auth.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import { JobError, type Scheduler } from './scheduler.ts';

type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

const JOB = '(jb-[0-9a-f]{8})';
const RUN = '(jr-[0-9a-f]{8})';

function who(caller: Caller | null): string {
  if (caller?.kind === 'token') return `token:${caller.token.name}`;
  if (caller?.kind === 'session') return `device:${caller.session.label || caller.session.id}`;
  return 'local';
}

export async function jobsApi(req: IncomingMessage, res: ServerResponse, path: string, caller: Caller | null, svc: Scheduler, audit: Audit): Promise<void> {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: string) => (method === verb ? path.match(new RegExp(`^/api/jobs${re}$`)) : null);
  let m: RegExpMatchArray | null;
  try {
    if (route('GET', '')) return send(res, 200, { jobs: await svc.list(), state: svc.state() });
    if (route('POST', '')) {
      const body = await readJson(req);
      const job = await svc.create({ name: body.name === undefined ? 'Job' : str(body.name, 'name', 120), action: body.action, trigger: body.trigger, policy: body.policy, createdBy: who(caller) });
      audit(req, 'job.create', { id: job.id, name: job.name, action: job.action.kind, trigger: job.trigger.kind });
      return send(res, 201, job);
    }
    if ((m = route('GET', `/runs/${RUN}`))) return send(res, 200, await svc.run(m[1]));
    if ((m = route('POST', `/runs/${RUN}/decide`))) {
      const body = await readJson(req);
      if (typeof body.approve !== 'boolean') throw new HttpError(400, 'approve must be true or false', 'invalid_decision');
      const out = await svc.decide(m[1], { approve: body.approve, note: body.note === undefined ? undefined : str(body.note, 'note', 2000) });
      audit(req, 'job.decide', { run: m[1], approve: body.approve });
      return send(res, 200, out);
    }
    if ((m = route('POST', `/runs/${RUN}/resolve`))) {
      const body = await readJson(req);
      const out = await svc.resolveUncertain(m[1], { resend: body.resend === true });
      audit(req, 'job.resolve', { run: m[1], resend: body.resend === true });
      return send(res, 200, out);
    }
    if ((m = route('GET', `/${JOB}`))) return send(res, 200, await svc.get(m[1]));
    if ((m = route('PATCH', `/${JOB}`))) {
      const body = await readJson(req);
      const job = await svc.update(m[1], { name: body.name === undefined ? undefined : str(body.name, 'name', 120), action: body.action, trigger: body.trigger, policy: body.policy });
      audit(req, 'job.edit', { id: m[1] });
      return send(res, 200, job);
    }
    if ((m = route('POST', `/${JOB}/(pause|resume|cancel|run)`))) {
      const verb = m[2];
      const out = verb === 'pause' ? await svc.pause(m[1]) : verb === 'resume' ? await svc.resume(m[1]) : verb === 'cancel' ? await svc.cancel(m[1]) : await svc.runNow(m[1]);
      audit(req, `job.${verb}`, { id: m[1] });
      return send(res, 200, out);
    }
    throw new HttpError(404, 'not found');
  } catch (err) {
    if (err instanceof JobError) throw new HttpError(err.status, err.message, err.code);
    throw err;
  }
}
