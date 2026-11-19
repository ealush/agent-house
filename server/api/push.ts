// Alerts to devices: Web Push subscriptions for browsers, APNs and Live Activities for
// the native app (registering them needs a native sign-in).
import { HttpError, readJson, send, str } from '../http.ts';
import type { Apns } from '../apns.ts';
import type { Auth } from '../auth.ts';
import type { Core } from '../core.ts';
import { route, type Audit, type Route } from './router.ts';

export type PushRouteDeps = {
  apns: Apns;
  audit: Audit;
  auth: Auth;
  core: Core;
};

export function pushRoutes({ apns, audit, auth, core }: PushRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/push\/key$/, ({ res }) => send(res, 200, { key: core.push.publicKey })),
    route('POST', /^\/api\/push\/subscribe$/, async ({ req, res }) => {
      const body = await readJson(req);
      const events = body.events as { waiting?: unknown; done?: unknown } | undefined;
      try {
        core.push.subscribe(body.subscription as never, { waiting: events?.waiting !== false, done: events?.done === true }, String(body.label ?? ''));
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      audit(req, 'push.subscribe', { label: String(body.label ?? '').slice(0, 60) });
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/push\/unsubscribe$/, async ({ req, res }) => {
      core.push.unsubscribe(str((await readJson(req)).endpoint, 'endpoint', 2048));
      audit(req, 'push.unsubscribe');
      return send(res, 200, { ok: true });
    }),
    // Native app push (server/apns.ts): one registration per native sign-in.
    route('GET', /^\/api\/push\/apns$/, ({ res, caller }) => send(res, 200, apns.status(caller.kind === 'session' ? caller.session.id : null))),
    route('PUT', /^\/api\/push\/apns$/, async ({ req, res, caller }) => {
      if (caller.kind !== 'session' || !auth.isNative(caller)) throw new HttpError(403, 'only the native app registers for APNs');
      const body = await readJson(req);
      const events = body.events as { waiting?: unknown; done?: unknown } | undefined;
      apns.register({
        token: str(body.token, 'token', 200),
        environment: str(body.environment, 'environment', 20) as never,
        events: { waiting: events?.waiting !== false, done: events?.done === true },
        preview: body.preview === 'private' ? 'private' : 'full',
        sessionId: caller.session.id,
        deviceId: caller.session.keyId ?? '',
        label: caller.session.label,
      });
      audit(req, 'push.apns.register', { device: caller.session.keyId });
      return send(res, 200, apns.status(caller.session.id));
    }),
    // A Live Activity the app started for a session it sent to: the host keeps it current.
    route('PUT', /^\/api\/push\/apns\/activity$/, async ({ req, res, caller }) => {
      if (caller.kind !== 'session' || !auth.isNative(caller)) throw new HttpError(403, 'only the native app registers Live Activities');
      const body = await readJson(req);
      apns.registerActivity({ uid: str(body.uid, 'uid', 200), token: str(body.token, 'token', 200), environment: str(body.environment, 'environment', 20) as never, sessionId: caller.session.id, rotated: body.rotated === true });
      return send(res, 200, { ok: true, activities: apns.activityCount(caller.session.id) });
    }),
    route('DELETE', /^\/api\/push\/apns\/activity\/([^/]+)$/, ({ res, m, caller }) => {
      if (caller.kind === 'session') apns.unregisterActivity(caller.session.id, decodeURIComponent(m[1]));
      return send(res, 200, { ok: true });
    }),
    route('DELETE', /^\/api\/push\/apns$/, ({ req, res, caller }) => {
      if (caller.kind === 'session') apns.unregister(caller.session.id);
      audit(req, 'push.apns.unregister');
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/push\/status$/, async ({ req, res }) => send(res, 200, { events: core.push.settings(str((await readJson(req)).endpoint, 'endpoint', 2048)) })),
  ];
}
