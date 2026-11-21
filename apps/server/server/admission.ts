// Who gets in, decided once (main.ts invariants 2–4), as a pure function of facts the
// front door has already read off the request. The shell (handle, upgrade) gathers the
// facts (the gate's verdict, the caller, the Origin check, the decoded path), asks here,
// and does what the answer says: deny, proxy to a peer, route the API, or serve a file.
// Nothing here reads a request, a socket or a clock, so every rule has a unit test.

/** Routes reachable without signing in: only what's needed to sign in. Everything else is denied. */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/hello',
  'GET /api/auth/status',
  'POST /api/auth/register/options', // needs a host-issued setup code (or a session) inside
  'POST /api/auth/register/verify',
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  'POST /api/auth/password/login',
  'POST /api/auth/logout',
  // The native app's sign-in: enrollment still needs a host-issued code (or a session) inside.
  'POST /api/auth/native/enroll/options',
  'POST /api/auth/native/enroll/verify',
  'POST /api/auth/native/login/options',
  'POST /api/auth/native/login/verify',
]);

/** Native sign-in routes: writes before there is a caller, so they can't carry a bearer yet. */
const NATIVE_SIGN_IN = /^(?:\/h\/[\w.-]{1,64})?\/api\/auth\/native\/(?:enroll|login)\/(?:options|verify)$/;

/** `/h/<host>/…` addresses a host by name: this one, or a peer. */
const HOST_PREFIX = /^\/h\/([\w.-]{1,64})(\/.*)$/;

export type RequestFacts = {
  method: string;
  /** The decoded path, `/h/<host>` prefix and all. */
  path: string;
  /** Sent an Origin header / a Cookie header at all. */
  origin: boolean;
  cookie: boolean;
  /** The Origin is exactly the host and port this request was addressed to (Gate.originOk). */
  sameOrigin: boolean;
  /** The X-AH header, which no cross-site page can send without a preflight ah never answers. */
  csrfHeader: boolean;
  /** Signed in (any kind) / signed in as the native app, with its bearer secret. */
  signedIn: boolean;
  native: boolean;
  /** This host's own name. */
  self: string;
};

export type Admission =
  | { kind: 'deny'; status: 401 | 403 | 404 | 405; reason: string }
  | { kind: 'peer'; host: string; path: string }
  /** `path`: without this host's own `/h/<name>` prefix. */
  | { kind: 'api'; path: string }
  | { kind: 'static'; path: string };

/**
 * The native app has no Origin: it isn't a web page. Its writes and terminals skip the
 * same-Origin check only when nothing ambient rides along: no Origin and no cookie, and
 * either a native bearer sign-in or the native sign-in routes themselves. A browser always
 * sends Origin on writes and WebSockets, can't attach Authorization or X-AH cross-site
 * without a preflight ah never grants, and never sees a native bearer secret, so the
 * browser's CSRF defenses are unchanged.
 */
function nativeWithoutOrigin(f: Pick<RequestFacts, 'origin' | 'cookie' | 'native' | 'path'>): boolean {
  if (f.origin || f.cookie) return false;
  return f.native || NATIVE_SIGN_IN.test(f.path);
}

const isRead = (method: string) => method === 'GET' || method === 'HEAD';

/** An HTTP request that passed the gate (Host and Serve identity): what happens to it. */
export function admitRequest(f: RequestFacts): Admission {
  // CSRF: every write carries X-AH and comes from ah's own page (or is the native app).
  if (!isRead(f.method) && (!f.csrfHeader || !(f.sameOrigin || nativeWithoutOrigin(f)))) return { kind: 'deny', status: 403, reason: 'forbidden' };
  let path = f.path;
  const h = path.match(HOST_PREFIX);
  if (h && h[1] !== f.self) {
    if (!f.signedIn) return { kind: 'deny', status: 401, reason: 'sign in required' };
    return { kind: 'peer', host: h[1], path: h[2] };
  }
  if (h) {
    path = h[2];
    if (path.startsWith('/h/')) return { kind: 'deny', status: 404, reason: 'not found' };
  }
  if (path.startsWith('/api/')) {
    // Default deny (invariant 4).
    if (!f.signedIn && !PUBLIC_ROUTES.has(`${f.method} ${path}`)) return { kind: 'deny', status: 401, reason: 'sign in required' };
    return { kind: 'api', path };
  }
  if (!isRead(f.method)) return { kind: 'deny', status: 405, reason: 'method not allowed' };
  return { kind: 'static', path };
}

/** `path`: null when the request line's URL doesn't parse. */
export type UpgradeFacts = Omit<RequestFacts, 'method' | 'csrfHeader' | 'path'> & { path: string | null };

export type UpgradeAdmission =
  | { kind: 'reject'; status: '400 Bad Request' | '401 Unauthorized' | '403 Forbidden' | '404 Not Found' }
  /** `host`: a peer to proxy to, or null for this host. */
  | { kind: 'terminal'; host: string | null; windowId: string };

const TERMINAL = /^(?:\/h\/([\w.-]{1,64}))?\/ws\/(@\d+)$/;

/** A WebSocket that passed the gate: a terminal here, one on a peer, or refused. */
export function admitUpgrade(f: UpgradeFacts): UpgradeAdmission {
  // A WebSocket has no preflight: a browser's needs ah's exact Origin. The native app's
  // carries its bearer sign-in and no Origin or cookie at all.
  const native = !f.origin && !f.cookie && f.native;
  if (!f.sameOrigin && !native) return { kind: 'reject', status: '403 Forbidden' };
  if (f.path === null) return { kind: 'reject', status: '400 Bad Request' };
  const m = f.path.match(TERMINAL);
  if (!m) return { kind: 'reject', status: '404 Not Found' };
  if (!f.signedIn) return { kind: 'reject', status: '401 Unauthorized' };
  const [, host, windowId] = m;
  return { kind: 'terminal', host: host && host !== f.self ? host : null, windowId };
}
