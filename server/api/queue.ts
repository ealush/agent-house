// A session's queued follow-ups: listing, removing, reordering, and sending one now.
import { HttpError, readJson, send } from '../http.ts';
import type { Core } from '../core.ts';
import { route, type Audit, type Route } from './router.ts';

export type QueueRouteDeps = {
  audit: Audit;
  core: Core;
};

export function queueRoutes({ audit, core }: QueueRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/queue$/, ({ res, m }) => send(res, 200, core.queue(m[1]))),
    route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/queue(?:\/([\w-]{1,40}))?$/, ({ res, m }) => {
      core.clearQueue(m[1], m[2]);
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/move$/, async ({ req, res, m }) => {
      const to = (await readJson(req)).to;
      if (!Number.isInteger(to) || (to as number) < 0 || (to as number) > 1000) throw new HttpError(400, 'invalid position');
      return send(res, 200, core.moveQueued(m[1], m[2], to as number));
    }),
    // Urgent follow-up: deliver one queued message now, stopping the live turn.
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/send-now$/, async ({ req, res, m }) => {
      const out = await core.sendNow(m[1], m[2]);
      audit(req, 'session.send-now', { uid: m[1], window: out.windowId });
      return send(res, 200, out);
    }),
  ];
}
