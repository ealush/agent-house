import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitRequest, admitUpgrade, PUBLIC_ROUTES, type RequestFacts, type UpgradeFacts } from './admission.ts';

// A same-origin browser page, signed in, writing with X-AH: the ordinary case.
const page: RequestFacts = { method: 'POST', path: '/api/sessions/u1/send', origin: true, cookie: true, sameOrigin: true, csrfHeader: true, signedIn: true, native: false, self: 'box' };
// The native app: a bearer sign-in, no Origin, no cookie.
const app: RequestFacts = { ...page, origin: false, cookie: false, sameOrigin: false, native: true };
const anon: RequestFacts = { ...page, cookie: false, signedIn: false };

const forbidden = { kind: 'deny', status: 403, reason: 'forbidden' };
const signIn = { kind: 'deny', status: 401, reason: 'sign in required' };

test('a write from ah’s own page, signed in, reaches the API', () => {
  assert.deepEqual(admitRequest(page), { kind: 'api', path: '/api/sessions/u1/send' });
});

test('CSRF: a write needs X-AH and ah’s own Origin', () => {
  assert.deepEqual(admitRequest({ ...page, csrfHeader: false }), forbidden);
  assert.deepEqual(admitRequest({ ...page, sameOrigin: false }), forbidden, 'another site’s page');
  assert.deepEqual(admitRequest({ ...page, origin: false, sameOrigin: false }), forbidden, 'no Origin and a cookie: not the native app');
  for (const method of ['PUT', 'PATCH', 'DELETE']) assert.deepEqual(admitRequest({ ...page, method, csrfHeader: false }), forbidden, method);
  // Reads carry no CSRF requirement.
  assert.deepEqual(admitRequest({ ...page, method: 'GET', csrfHeader: false, sameOrigin: false }).kind, 'api');
  assert.deepEqual(admitRequest({ ...page, method: 'HEAD', csrfHeader: false, sameOrigin: false }).kind, 'api');
});

test('the native app writes without an Origin only when nothing ambient rides along', () => {
  assert.equal(admitRequest(app).kind, 'api');
  assert.deepEqual(admitRequest({ ...app, csrfHeader: false }), forbidden, 'X-AH is still required');
  assert.deepEqual(admitRequest({ ...app, cookie: true }), forbidden, 'a cookie means a browser');
  assert.deepEqual(admitRequest({ ...app, origin: true }), forbidden, 'an Origin that isn’t ah’s');
  assert.deepEqual(admitRequest({ ...app, native: false }), forbidden, 'a token or browser session without Origin');
});

test('the native sign-in routes write before there is a caller', () => {
  for (const path of ['/api/auth/native/enroll/options', '/api/auth/native/enroll/verify', '/api/auth/native/login/options', '/api/auth/native/login/verify', '/h/box/api/auth/native/login/verify']) {
    assert.equal(admitRequest({ ...anon, path, origin: false, sameOrigin: false, native: false }).kind, 'api', path);
  }
  // Any other write without Origin, signed out: refused before routing.
  assert.deepEqual(admitRequest({ ...anon, path: '/api/auth/password/login', origin: false, sameOrigin: false }), forbidden);
  assert.deepEqual(admitRequest({ ...anon, path: '/api/auth/native/login/verify/x', origin: false, sameOrigin: false }), forbidden);
});

test('default deny: signed out, only the sign-in routes are reachable', () => {
  for (const r of PUBLIC_ROUTES) {
    const [method, path] = r.split(' ');
    assert.equal(admitRequest({ ...anon, method, path }).kind, 'api', r);
  }
  assert.deepEqual(admitRequest({ ...anon, method: 'GET', path: '/api/state' }), signIn);
  assert.deepEqual(admitRequest({ ...anon, path: '/api/hello' }), signIn, 'public as GET only');
  assert.deepEqual(admitRequest({ ...anon, method: 'GET', path: '/api/hello/' }), signIn, 'exact paths: a trailing slash is not public');
  assert.deepEqual(admitRequest({ ...anon, method: 'GET', path: '/api/auth/status?x' }), signIn);
  assert.deepEqual(admitRequest({ ...anon, path: '/api/auth/password' }), signIn, 'setting the password is not sign-in');
});

test('/h/<host>: this host is served here, a peer is proxied for a caller only', () => {
  assert.deepEqual(admitRequest({ ...page, path: '/h/box/api/sessions/u1/send' }), { kind: 'api', path: '/api/sessions/u1/send' });
  assert.deepEqual(admitRequest({ ...page, path: '/h/other/api/state' }), { kind: 'peer', host: 'other', path: '/api/state' });
  assert.deepEqual(admitRequest({ ...anon, method: 'GET', path: '/h/other/api/hello' }), signIn, 'a peer’s public routes aren’t ours to open');
  assert.deepEqual(admitRequest({ ...page, path: '/h/box/h/other/api/state' }), { kind: 'deny', status: 404, reason: 'not found' }, 'no chained hops');
  assert.deepEqual(admitRequest({ ...page, method: 'GET', path: '/h/box/assets/app.js' }), { kind: 'static', path: '/assets/app.js' });
  // CSRF applies before any proxying.
  assert.deepEqual(admitRequest({ ...page, path: '/h/other/api/state', sameOrigin: false }), forbidden);
});

test('everything else is a read-only static file', () => {
  assert.deepEqual(admitRequest({ ...anon, method: 'GET', path: '/' }), { kind: 'static', path: '/' });
  assert.deepEqual(admitRequest({ ...page, path: '/' }), { kind: 'deny', status: 405, reason: 'method not allowed' });
  assert.deepEqual(admitRequest({ ...anon, method: 'GET', path: '/apix' }).kind, 'static');
});

const ws: UpgradeFacts = { path: '/ws/@3', origin: true, cookie: true, sameOrigin: true, signedIn: true, native: false, self: 'box' };

test('a terminal WebSocket needs ah’s exact Origin, or the native app with nothing ambient', () => {
  assert.deepEqual(admitUpgrade(ws), { kind: 'terminal', host: null, windowId: '@3' });
  assert.deepEqual(admitUpgrade({ ...ws, sameOrigin: false }), { kind: 'reject', status: '403 Forbidden' });
  const nativeWs = { ...ws, origin: false, cookie: false, sameOrigin: false, native: true };
  assert.equal(admitUpgrade(nativeWs).kind, 'terminal');
  assert.deepEqual(admitUpgrade({ ...nativeWs, cookie: true }), { kind: 'reject', status: '403 Forbidden' });
  assert.deepEqual(admitUpgrade({ ...nativeWs, native: false }), { kind: 'reject', status: '403 Forbidden' });
});

test('a terminal WebSocket: the path, then the sign-in', () => {
  assert.deepEqual(admitUpgrade({ ...ws, path: null }), { kind: 'reject', status: '400 Bad Request' });
  assert.deepEqual(admitUpgrade({ ...ws, path: '/ws/3' }), { kind: 'reject', status: '404 Not Found' });
  assert.deepEqual(admitUpgrade({ ...ws, path: '/ws/@3/x' }), { kind: 'reject', status: '404 Not Found' });
  assert.deepEqual(admitUpgrade({ ...ws, signedIn: false }), { kind: 'reject', status: '401 Unauthorized' });
  // The Origin is checked before the path: a foreign page learns nothing about routes.
  assert.deepEqual(admitUpgrade({ ...ws, sameOrigin: false, path: '/nope' }), { kind: 'reject', status: '403 Forbidden' });
  assert.deepEqual(admitUpgrade({ ...ws, path: '/h/box/ws/@3' }), { kind: 'terminal', host: null, windowId: '@3' });
  assert.deepEqual(admitUpgrade({ ...ws, path: '/h/other/ws/@3' }), { kind: 'terminal', host: 'other', windowId: '@3' });
});
