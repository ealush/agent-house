// Identity & access over HTTP, under /api/auth: signing in (passkeys, the master
// password, the native app's device keys), and managing who's signed in. Thin: every
// rule is in auth.ts. Only the sign-in routes are public (admission.ts PUBLIC_ROUTES).
import type { ServerResponse } from 'node:http';
import { clearCookies, type Auth } from '../auth.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import { publicRoute, route, type Route } from './router.ts';

export type AuthRouteDeps = {
  auth: Auth;
  /** Where another device opens ah (Security → Add a device), or null off the tailnet. */
  address: () => Promise<string | null>;
};

const label = (b: Record<string, unknown>) => String(b.label ?? '').replace(/[^\w .·()-]/g, '').slice(0, 60);

function signedIn(res: ServerResponse, cookie: { cookie: string } | null) {
  if (cookie) res.setHeader('set-cookie', cookie.cookie);
  return send(res, 200, { ok: true });
}

export function authRoutes({ auth, address }: AuthRouteDeps): Route[] {
  return [
    publicRoute('GET', /^\/api\/auth\/status$/, ({ res, caller }) => send(res, 200, { enabled: auth.enabled, enrolled: auth.enrolled, authenticated: !!caller, password: auth.hasPassword })),
    publicRoute('POST', /^\/api\/auth\/register\/options$/, async ({ req, res, caller }) => {
      const body = await readJson(req);
      return send(res, 200, await auth.registrationOptions(req, caller, typeof body.code === 'string' ? body.code : undefined));
    }),
    publicRoute('POST', /^\/api\/auth\/register\/verify$/, async ({ req, res }) => {
      const body = await readJson(req);
      return signedIn(res, await auth.verifyRegistration(req, str(body.challengeId, 'challenge', 40), body.response as never, label(body)));
    }),
    publicRoute('POST', /^\/api\/auth\/login\/options$/, async ({ req, res }) => send(res, 200, await auth.authenticationOptions(req))),
    publicRoute('POST', /^\/api\/auth\/login\/verify$/, async ({ req, res }) => {
      const body = await readJson(req);
      return signedIn(res, await auth.verifyAuthentication(req, str(body.challengeId, 'challenge', 40), body.response as never, label(body)));
    }),
    publicRoute('POST', /^\/api\/auth\/password\/login$/, async ({ req, res }) => {
      const body = await readJson(req);
      return signedIn(res, await auth.passwordLogin(req, str(body.password, 'password', 512), label(body)));
    }),
    publicRoute('POST', /^\/api\/auth\/native\/enroll\/options$/, async ({ req, res, caller }) => {
      const body = await readJson(req);
      return send(res, 200, auth.nativeEnrollOptions(req, caller, typeof body.code === 'string' ? body.code : undefined));
    }),
    publicRoute('POST', /^\/api\/auth\/native\/enroll\/verify$/, async ({ req, res }) => {
      const body = await readJson(req);
      return send(res, 200, auth.nativeEnrollVerify(req, str(body.challengeId, 'challenge', 40), str(body.publicKey, 'publicKey', 100), str(body.signature, 'signature', 200), label(body)));
    }),
    publicRoute('POST', /^\/api\/auth\/native\/login\/options$/, ({ req, res }) => send(res, 200, auth.nativeLoginOptions(req))),
    publicRoute('POST', /^\/api\/auth\/native\/login\/verify$/, async ({ req, res }) => {
      const body = await readJson(req);
      return send(res, 200, auth.nativeLoginVerify(req, str(body.challengeId, 'challenge', 40), str(body.deviceId, 'deviceId', 20), str(body.signature, 'signature', 200), label(body)));
    }),
    publicRoute('POST', /^\/api\/auth\/logout$/, ({ res, caller }) => {
      if (caller?.kind === 'session') auth.endSession(caller.session.id, 'signed out');
      res.setHeader('set-cookie', clearCookies());
      return send(res, 200, { ok: true });
    }),

    // Management: signed-in devices and the host's own CLI only.
    route('POST', /^\/api\/auth\/cache-key$/, ({ res, caller }) => {
      const key = auth.cacheKey(caller);
      if (!key) throw new HttpError(404, 'no cache for this caller');
      res.setHeader('cache-control', 'no-store');
      return send(res, 200, { key });
    }),
    route('GET', /^\/api\/auth\/overview$/, async ({ res, caller }) => send(res, 200, { ...auth.overview(caller), audit: auth.recentAudit(50), address: await address() })),
    route('POST', /^\/api\/auth\/code$/, ({ res, caller }) => send(res, 200, { code: auth.issueCode(caller.kind === 'session' ? `device ${caller.session.label}` : 'host CLI'), ttlMinutes: 10 })),
    route('DELETE', /^\/api\/auth\/sessions\/(\w{1,20})$/, ({ res, m }) => {
      auth.endSession(m[1], 'revoked');
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/auth\/signout-all$/, ({ res, caller }) => {
      auth.signOutEverywhere(caller.kind === 'session' ? caller.session.id : undefined);
      return send(res, 200, { ok: true });
    }),
    route('DELETE', /^\/api\/auth\/passkeys\/([\w-]{1,512})$/, ({ res, m }) => {
      auth.removePasskey(m[1]);
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/auth\/native\/preview-session$/, ({ res, caller }) => send(res, 200, auth.nativePreviewSession(caller))),
    route('DELETE', /^\/api\/auth\/devices\/(\w{1,20})$/, ({ res, m }) => {
      auth.removeDevice(m[1]);
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/auth\/tokens$/, async ({ req, res }) => send(res, 200, { token: auth.createToken(str((await readJson(req)).name, 'name', 60)) })),
    route('DELETE', /^\/api\/auth\/tokens\/(\w{1,20})$/, ({ res, m }) => {
      auth.removeToken(m[1]);
      return send(res, 200, { ok: true });
    }),
    // The master password can only be set from the host itself.
    route('POST', /^\/api\/auth\/password$/, async ({ req, res, caller }) => {
      if (!(caller.kind === 'token' && caller.token.id === 'local')) throw new HttpError(403, 'set the master password on the host: node bin/ah.js auth password');
      const body = await readJson(req);
      await auth.setPassword(body.password === null ? null : str(body.password, 'password', 512));
      return send(res, 200, { ok: true });
    }),
  ];
}
