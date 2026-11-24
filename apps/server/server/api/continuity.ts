// Interrupted and stuck sessions over HTTP (docs/spec/13-conductor.md CND-5, CND-8):
// what a tmux stop or a provider error cut off, restoring it, and recovery's controls.
import { actorUid, HttpError, readJson, send } from '../http.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import type { Interruptions } from '../interruptions.ts';
import type { RecoveryEngine } from '../recovery/engine.ts';
import { route, type Audit, type Route } from './router.ts';

export type ContinuityRouteDeps = {
  audit: Audit;
  config: Config;
  core: Core;
  interruptions: Interruptions;
  recovery: RecoveryEngine;
};

export function continuityRoutes({ audit, config, core, interruptions, recovery }: ContinuityRouteDeps): Route[] {
  return [
    // Recovery (server/recovery): what went wrong in a session, what ah will do, and your controls.
    // Interrupted sessions (server/interruptions): the list, restore one or all, dismiss.
    route('GET', /^\/api\/interruptions$/, ({ res }) => send(res, 200, { interruptions: interruptions.list(), ...interruptions.state() })),
    route('POST', /^\/api\/interruptions\/(restore|dismiss)$/, async ({ req, res, m }) => {
      const actor = actorUid(req);
      const body = await readJson(req);
      const action = m[1];
      const uids = body.uids === undefined ? undefined : Array.isArray(body.uids) && body.uids.length <= 200 && body.uids.every((u: unknown) => typeof u === 'string' && /^[\w-]{1,40}$/.test(u)) ? (body.uids as string[]) : null;
      if (uids === null) throw new HttpError(400, 'uids must be a list of session ids', 'invalid_uids');
      const incident = body.incident === undefined ? undefined : typeof body.incident === 'string' && /^[\w-]{1,80}$/.test(body.incident) ? body.incident : null;
      if (incident === null) throw new HttpError(400, 'incident must be an incident id', 'invalid_incident');
      // Everything at once only when you say so: no filter and no `all` is a mistake, not "all".
      if (!uids && !incident && body.all !== true) throw new HttpError(400, 'name uids, an incident, or all: true', 'invalid_target');
      if (actor) {
        if (uids) {
          for (const u of uids) core.assertControl(actor, u, 'recovery');
        } else {
          const sup = core.supervisionGraph().get(actor);
          if (sup?.managedBy && sup.role !== 'chief') {
            throw new HttpError(403, 'supervised worker sessions cannot bulk-restore or dismiss fleet interruptions', 'upward_control_denied');
          }
        }
      }
      if (action === 'dismiss') {
        const dismissed = interruptions.dismiss({ uids, incident });
        audit(req, 'interruptions.dismiss', { uids: uids?.length ?? null, incident: incident ?? null, dismissed });
        return send(res, 200, { dismissed });
      }
      const out = await interruptions.restoreAll({ uids, incident, note: body.note !== false });
      audit(req, 'interruptions.restore', { restored: out.restored.map((r) => r.uid), failed: out.failed.map((f) => f.uid) });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/restore$/, async ({ req, res, m }) => {
      core.assertControl(actorUid(req), m[1], 'recovery');
      const body = await readJson(req);
      const out = await interruptions.restore(m[1], { note: body.note !== false, by: 'you' });
      audit(req, 'session.restore', { uid: m[1], window: out.windowId, noted: out.noted });
      return send(res, out.resumed ? 201 : 200, out);
    }),
    route('GET', /^\/api\/recovery$/, async ({ res }) => send(res, 200, { recoveries: await recovery.list(), config: { auto: config.recovery.auto, maxAttempts: config.recovery.maxAttempts } })),
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/recovery$/, async ({ res, m }) => send(res, 200, await recovery.get(m[1]))),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/recovery$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const uid = m[1];
      core.assertControl(actorUid(req), uid, 'recovery');
      if (!core.registry.get(uid)) throw new HttpError(404, 'session not found');
      if (body.auto !== undefined) {
        if (typeof body.auto !== 'boolean') throw new HttpError(400, 'auto must be true or false', 'invalid_auto');
        core.registry.setMeta(uid, 'ah.recovery.auto', body.auto);
        await recovery.autoChanged(uid);
        audit(req, 'recovery.auto', { uid, auto: body.auto });
        core.tick().catch(() => {});
        return send(res, 200, await recovery.get(uid));
      }
      const action = body.action;
      if (action !== 'retry' && action !== 'pause' && action !== 'resume' && action !== 'cancel') throw new HttpError(400, 'action must be retry, pause, resume or cancel', 'invalid_action');
      const out = await recovery.control(uid, action, (await core.current()).windows);
      audit(req, `recovery.${action}`, { uid });
      return send(res, 200, out);
    }),
  ];
}
