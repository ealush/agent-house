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
    // `?unsent=1`: what the agent never took first (`unsent: true`). Asked for, so a client that
    // places rows by their index in this list (move) never counts rows it doesn't know.
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/queue$/, ({ res, m, url }) => send(res, 200, core.queue(m[1], url.searchParams.get('unsent') === '1'))),
    route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/queue(?:\/([\w-]{1,40}))?$/, ({ req, res, m }) => {
      core.clearQueue(m[1], m[2]);
      audit(req, m[2] ? 'queue.remove' : 'queue.clear', { uid: m[1], ...(m[2] ? { item: m[2] } : {}) });
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/move$/, async ({ req, res, m }) => {
      const to = (await readJson(req)).to;
      if (!Number.isInteger(to) || (to as number) < 0 || (to as number) > 1000) throw new HttpError(400, 'invalid position');
      const order = core.moveQueued(m[1], m[2], to as number);
      audit(req, 'queue.move', { uid: m[1], item: m[2], to });
      return send(res, 200, order);
    }),
    // Urgent follow-up: deliver one queued message now, stopping the live turn.
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/send-now$/, async ({ req, res, m }) => {
      const out = await core.sendNow(m[1], m[2]);
      audit(req, 'session.send-now', { uid: m[1], window: out.windowId });
      return send(res, 200, out);
    }),
  ];
}
