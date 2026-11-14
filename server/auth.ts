// App-level authentication on top of Tailscale. Tailscale decides which devices can
// reach ah; this decides which *people holding those devices* can use it, so a lost
// phone or another machine on the tailnet isn't a shell.
//
// - Passkeys (WebAuthn) are the way in: biometric, phishing-resistant, nothing to leak.
// - New devices enroll with a one-time code that only the host can produce (printed by
//   the server, or `ah auth code`). That is also lockout recovery: whoever can run
//   commands on the host is already trusted.
// - An optional master password (scrypt) for browsers without passkeys, set on the host.
// - Machine tokens for the local CLI and for peers that proxy through each other.
// - Native app devices (iPhone/iPad): a device-bound P-256 key, enrolled with the same
//   host-issued code, signs a fresh challenge to sign in. Each sign-in is an ordinary
//   session (same expiry, revocation and stream tracking) carried as a bearer secret
//   instead of a cookie. Passkeys can't serve the native app: Apple fetches associated
//   domains through its public CDN, which can't reach a private ts.net name.
import { createHash, createHmac, createPublicKey, randomBytes, scrypt as scryptCb, timingSafeEqual, verify as verifySignature } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { hostName } from './host.ts';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const DIR = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah');
const FILE = join(DIR, 'auth.json');
const AUDIT = join(DIR, 'audit.log');
/** Read by the local CLI. Same-user processes can read it, which they could anyway (tmux). */
export const LOCAL_TOKEN_FILE = join(DIR, 'local-token');

const CODE_TTL_MS = 10 * 60_000;
const THROTTLE_WINDOW_MS = 5 * 60_000;
const THROTTLE_PER_SOURCE = 10;
const THROTTLE_GLOBAL = 30;
/** Outstanding WebAuthn challenges are capped so unauthenticated callers can't grow memory. */
const MAX_CHALLENGES = 200;
type Mechanism = 'password' | 'code';
const CHALLENGE_TTL_MS = 5 * 60_000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export type AuthConfig = {
  /** "passkey" (default) requires sign-in; "off" trusts the network alone. */
  mode: 'passkey' | 'off';
  /** Sign out a device after this many hours without use. */
  idleHours: number;
  /** …and after this many days regardless. */
  maxDays: number;
};

type Passkey = { id: string; publicKey: string; counter: number; transports?: string[]; rpID: string; label: string; createdAt: number; lastUsedAt: number };
type Session = {
  id: string;
  hash: string;
  label: string;
  via: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  /** A native app sign-in: the secret travels as `Authorization: Bearer`, never as a cookie. */
  bearer?: boolean;
  /** The native device key this sign-in came from; removing the key ends it. */
  keyId?: string;
  /** Derived from another sign-in (a native app's preview web view); ends with it. */
  parent?: string;
};
/** A native app's device key: uncompressed P-256 point (X9.63), base64url. */
type NativeKey = { id: string; publicKey: string; label: string; createdAt: number; lastUsedAt: number };
type Token = { id: string; hash: string; name: string; createdAt: number; lastUsedAt: number };
type Store = {
  userId: string;
  passkeys: Passkey[];
  sessions: Session[];
  tokens: Token[];
  password?: { salt: string; hash: string };
  nativeKeys?: NativeKey[];
  /** Keys the browser's encrypted conversation cache, one key per sign-in (see cacheKey). */
  cacheSecret?: string;
};

export type Caller = { kind: 'session'; session: Session } | { kind: 'token'; token: Token } | { kind: 'open' };

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const now = () => Date.now();
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newSecret = () => randomBytes(32).toString('base64url');
const shortId = () => randomBytes(6).toString('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Auth {
  readonly config: AuthConfig;
  private store: Store;
  private codes = new Map<string, number>(); // code → expiry
  private challenges = new Map<string, { challenge: string; rpID: string; origin: string; expires: number; enrollCode?: string; sessionId?: string; native?: 'enroll' | 'login' }>();
  /** Failure timestamps per "mechanism:source" bucket, plus one global bucket per mechanism. */
  private failures = new Map<string, number[]>();
  /** Live sockets/streams per session, so revoking a device also cuts its terminals. */
  private live = new Map<string, Set<{ close: () => void }>>();
  readonly localToken: string;

  constructor(config: AuthConfig) {
    this.config = config;
    if (existsSync(FILE)) {
      try {
        this.store = JSON.parse(readFileSync(FILE, 'utf8'));
      } catch (err) {
        // Fail closed: starting fresh would silently drop every passkey and session.
        throw new Error(`${FILE} is unreadable (${(err as Error).message}). Restore it from a backup, or move it away to start over.`);
      }
    } else {
      this.store = { userId: newSecret(), passkeys: [], sessions: [], tokens: [] };
    }
    this.store.tokens ??= [];
    this.store.nativeKeys ??= [];
    this.store.cacheSecret ??= newSecret();
    // A fresh local token every start; the CLI reads it from a 0600 file.
    this.localToken = newSecret();
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    writeFileSync(LOCAL_TOKEN_FILE, this.localToken, { mode: 0o600 });
    this.save();
  }

  get enabled() {
    return this.config.mode !== 'off';
  }

  /** Has any way to sign in been set up? */
  get hasPassword() {
    return !!this.store.password;
  }

  get enrolled() {
    return this.store.passkeys.length > 0 || !!this.store.password || this.nativeKeys.length > 0;
  }

  private get nativeKeys(): NativeKey[] {
    return (this.store.nativeKeys ??= []);
  }

  /** Called when a sign-in ends (signed out, revoked, expired), e.g. to forget its APNs token. */
  onSessionEnd: (id: string) => void = () => {};

  private save() {
    mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
    writeFileSync(FILE, JSON.stringify(this.store, null, 2), { mode: 0o600 });
  }

  audit(event: string, detail: Record<string, unknown> = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...detail });
    try {
      appendFileSync(AUDIT, line + '\n', { mode: 0o600 });
    } catch {}
    console.log(`[audit] ${line}`);
  }

  recentAudit(n = 60): unknown[] {
    try {
      return readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-n).reverse().map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // ---------- throttling
  //
  // Only guessable secrets are throttled (master password, setup codes): passkeys
  // can't be brute-forced, so failed passkey attempts never lock anyone out. Buckets
  // are per mechanism and per source (Tailscale identity, or "local"), with a higher
  // global ceiling per mechanism so many sources can't add up to a brute force.

  private recent(key: string): number[] {
    const t = now();
    const list = (this.failures.get(key) ?? []).filter((f) => t - f < THROTTLE_WINDOW_MS);
    this.failures.set(key, list);
    return list;
  }

  private throttle(mech: Mechanism, req: IncomingMessage) {
    if (this.recent(`${mech}:${who(req)}`).length >= THROTTLE_PER_SOURCE || this.recent(`${mech}:*`).length >= THROTTLE_GLOBAL) {
      throw new AuthError(429, 'Too many failed attempts. Try again in a few minutes.');
    }
  }

  private fail(reason: string, req: IncomingMessage, mech?: Mechanism): never {
    if (mech) {
      this.recent(`${mech}:${who(req)}`).push(now());
      this.recent(`${mech}:*`).push(now());
    }
    this.audit('auth.failed', { reason, from: who(req) });
    throw new AuthError(401, reason);
  }

  // ---------- who is calling

  /** Resolves the caller from the session cookie or a bearer token; null if unauthenticated. */
  identify(req: IncomingMessage): Caller | null {
    if (!this.enabled) return { kind: 'open' };
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    if (bearer) {
      if (safeEqual(bearer, this.localToken)) return { kind: 'token', token: { id: 'local', hash: '', name: 'local CLI', createdAt: 0, lastUsedAt: now() } };
      const hash = sha256(bearer);
      const token = this.store.tokens.find((t) => safeEqual(t.hash, hash));
      if (token) {
        if (now() - token.lastUsedAt > 60_000) {
          token.lastUsedAt = now();
          this.save();
        }
        return { kind: 'token', token };
      }
      // A native app's sign-in. Bearer sessions are never accepted as cookies, nor the reverse.
      const native = this.store.sessions.find((x) => x.bearer && safeEqual(x.hash, hash));
      return native ? this.live_(native) : null;
    }
    const raw = cookie(req, COOKIE) ?? cookie(req, SECURE_COOKIE);
    if (!raw) return null;
    const hash = sha256(raw);
    const s = this.store.sessions.find((x) => !x.bearer && safeEqual(x.hash, hash));
    if (!s) return null;
    return this.live_(s);
  }

  /** The caller for a session that still holds, or null (and ended) once it expired. */
  private live_(s: Session): Caller | null {
    const t = now();
    if (t > s.expiresAt || t - s.lastSeenAt > this.config.idleHours * 3600_000) {
      this.endSession(s.id, 'expired');
      return null;
    }
    if (t - s.lastSeenAt > 60_000) {
      s.lastSeenAt = t;
      this.save();
    }
    return { kind: 'session', session: s };
  }

  /** Registers something to close if the session is revoked (WebSocket, event stream). */
  track(caller: Caller, conn: { close: () => void }): () => void {
    if (caller.kind !== 'session') return () => {};
    const set = this.live.get(caller.session.id) ?? new Set();
    set.add(conn);
    this.live.set(caller.session.id, set);
    return () => set.delete(conn);
  }

  private newSession(req: IncomingMessage, label: string, via: string): { cookie: string; session: Session } {
    const secret = newSecret();
    const t = now();
    const session: Session = { id: shortId(), hash: sha256(secret), label: label.slice(0, 60) || 'device', via, createdAt: t, lastSeenAt: t, expiresAt: t + this.config.maxDays * 86400_000 };
    this.store.sessions.push(session);
    this.store.sessions = this.store.sessions.filter((s) => s.expiresAt > t);
    this.save();
    this.audit('auth.signin', { via, device: session.label, session: session.id, from: who(req) });
    return { cookie: setCookie(req, secret, this.config.maxDays * 86400), session };
  }

  /**
   * The key a browser encrypts its local conversation cache with. It is derived
   * from this sign-in, so it is gone once the device signs out, is revoked, or
   * expires, and what the browser stored is unreadable without signing in again.
   * The host CLI has no cache; with auth off there is no sign-in to tie it to.
   */
  cacheKey(caller: Caller): string | null {
    if (caller.kind === 'token') return null;
    const subject = caller.kind === 'session' ? `session:${caller.session.hash}` : 'open';
    return createHmac('sha256', this.store.cacheSecret!).update(subject).digest('base64url');
  }

  endSession(id: string, reason: string) {
    const before = this.store.sessions.length;
    this.store.sessions = this.store.sessions.filter((s) => s.id !== id);
    if (this.store.sessions.length !== before) {
      this.save();
      this.audit('auth.signout', { session: id, reason });
    }
    for (const c of this.live.get(id) ?? []) c.close();
    this.live.delete(id);
    this.onSessionEnd(id);
    // Sign-ins derived from this one (a native app's preview web view) end with it.
    for (const child of this.store.sessions.filter((s) => s.parent === id)) this.endSession(child.id, reason);
  }

  /** Is this caller a native app's sign-in (bearer secret, not a browser cookie)? */
  isNative(caller: Caller | null): boolean {
    return caller?.kind === 'session' && !!caller.session.bearer;
  }

  // ---------- enrollment codes (host-issued)

  /** A one-time code that lets one new device create a passkey. Printed on the host. */
  issueCode(by: string): string {
    // Unambiguous alphabet, 10 chars ≈ 50 bits, grouped for reading aloud.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(10);
    const code = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
    const pretty = `${code.slice(0, 5)}-${code.slice(5)}`;
    this.codes.set(code, now() + CODE_TTL_MS);
    this.audit('auth.code_issued', { by });
    return pretty;
  }

  private takeCode(input: string, consume: boolean): string | null {
    const code = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const exp = this.codes.get(code);
    if (!exp || exp < now()) return null;
    if (consume) this.codes.delete(code);
    return code;
  }

  // ---------- passkeys

  private newChallenge(c: { challenge: string; rpID: string; origin: string; expires: number; enrollCode?: string; sessionId?: string; native?: 'enroll' | 'login' }): string {
    const t = now();
    for (const [id, v] of this.challenges) if (v.expires < t) this.challenges.delete(id);
    if (this.challenges.size >= MAX_CHALLENGES) throw new AuthError(429, 'Too many sign-ins in progress. Try again shortly.');
    const id = shortId();
    this.challenges.set(id, c);
    return id;
  }

  private originOf(req: IncomingMessage): { origin: string; rpID: string } {
    const origin = String(req.headers.origin ?? '');
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      throw new AuthError(400, 'missing origin');
    }
    // WebAuthn needs a domain (not an IP) on https, or localhost.
    if (/^[\d.]+$/.test(host) || host.includes(':')) throw new AuthError(400, 'Passkeys need a domain name — open ah through its https://….ts.net address.');
    if (!origin.startsWith('https://') && host !== 'localhost') throw new AuthError(400, 'Passkeys need https.');
    return { origin, rpID: host };
  }

  /** Step 1 of adding a passkey: either with a host-issued code, or from a signed-in device. */
  async registrationOptions(req: IncomingMessage, caller: Caller | null, code: string | undefined) {
    let enrollCode: string | undefined;
    if (!caller || caller.kind !== 'session') {
      this.throttle('code', req);
      const c = code && this.takeCode(code, false);
      if (!c) this.fail('invalid or expired setup code', req, 'code');
      enrollCode = c;
    }
    const { origin, rpID } = this.originOf(req);
    const options = await generateRegistrationOptions({
      rpName: 'ah',
      rpID,
      userName: `ah@${hostName()}`,
      userDisplayName: `ah on ${hostName()}`,
      userID: Buffer.from(this.store.userId),
      attestationType: 'none',
      excludeCredentials: this.store.passkeys.filter((p) => p.rpID === rpID).map((p) => ({ id: p.id, transports: p.transports as never })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = this.newChallenge({ challenge: options.challenge, rpID, origin, expires: now() + CHALLENGE_TTL_MS, enrollCode, sessionId: caller?.kind === 'session' ? caller.session.id : undefined });
    return { challengeId, options };
  }

  async verifyRegistration(req: IncomingMessage, challengeId: string, response: RegistrationResponseJSON, label: string) {
    const ch = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!ch || ch.expires < now()) this.fail('setup timed out, try again', req);
    // The code must still be valid now (not spent by a parallel enrollment)…
    if (ch.enrollCode && !this.takeCode(ch.enrollCode, false)) this.fail('invalid or expired setup code', req, 'code');
    let result;
    try {
      result = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: ch.origin, expectedRPID: ch.rpID, requireUserVerification: true });
    } catch (err) {
      this.fail(`passkey not accepted: ${(err as Error).message}`, req);
    }
    if (!result.verified) this.fail('passkey not accepted', req);
    // …and is spent only now that a verified passkey exists: a failed attempt keeps it usable.
    if (ch.enrollCode && !this.takeCode(ch.enrollCode, true)) this.fail('invalid or expired setup code', req, 'code');
    const { credential } = result.registrationInfo;
    const t = now();
    this.store.passkeys.push({ id: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter, transports: credential.transports, rpID: ch.rpID, label: label.slice(0, 60) || 'passkey', createdAt: t, lastUsedAt: t });
    this.save();
    this.audit('auth.passkey_added', { label, rpID: ch.rpID, from: who(req) });
    // Enrolling signs this device in; adding a passkey from a signed-in device keeps its session.
    return ch.sessionId ? null : this.newSession(req, label, 'passkey');
  }

  async authenticationOptions(req: IncomingMessage) {
    const { origin, rpID } = this.originOf(req);
    // Empty allowCredentials: discoverable credentials, so the OS offers the right passkey.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const challengeId = this.newChallenge({ challenge: options.challenge, rpID, origin, expires: now() + CHALLENGE_TTL_MS });
    return { challengeId, options };
  }

  async verifyAuthentication(req: IncomingMessage, challengeId: string, response: AuthenticationResponseJSON, label: string) {
    const ch = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!ch || ch.expires < now()) this.fail('sign-in timed out, try again', req);
    const pk = this.store.passkeys.find((p) => p.id === response.id && p.rpID === ch.rpID);
    if (!pk) this.fail('unknown passkey', req);
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: ch.origin,
        expectedRPID: ch.rpID,
        credential: { id: pk.id, publicKey: Buffer.from(pk.publicKey, 'base64url'), counter: pk.counter, transports: pk.transports as never },
        requireUserVerification: true,
      });
    } catch (err) {
      this.fail(`passkey not accepted: ${(err as Error).message}`, req);
    }
    if (!result.verified) this.fail('passkey not accepted', req);
    pk.counter = result.authenticationInfo.newCounter;
    pk.lastUsedAt = now();
    this.save();
    return this.newSession(req, label, `passkey:${pk.label}`);
  }

  // ---------- master password (optional, set on the host)

  async setPassword(password: string | null) {
    if (password === null) {
      delete this.store.password;
    } else {
      if (password.length < 12) throw new AuthError(400, 'use at least 12 characters');
      const salt = randomBytes(16);
      const hash = await scrypt(password, salt, 32, SCRYPT);
      this.store.password = { salt: salt.toString('base64'), hash: hash.toString('base64') };
    }
    this.save();
    this.audit(password === null ? 'auth.password_removed' : 'auth.password_set');
  }

  async passwordLogin(req: IncomingMessage, password: string, label: string) {
    this.throttle('password', req);
    if (!this.store.password) this.fail('no master password is set', req, 'password');
    const hash = await scrypt(password, Buffer.from(this.store.password.salt, 'base64'), 32, SCRYPT);
    if (!timingSafeEqual(hash, Buffer.from(this.store.password.hash, 'base64'))) this.fail('wrong password', req, 'password');
    return this.newSession(req, label, 'password');
  }

  // ---------- machine tokens (peers)

  createToken(name: string): string {
    const secret = newSecret();
    this.store.tokens.push({ id: shortId(), hash: sha256(secret), name: name.slice(0, 60), createdAt: now(), lastUsedAt: 0 });
    this.save();
    this.audit('auth.token_created', { name });
    return secret;
  }

  // ---------- native app devices
  //
  // Enrollment spends a host-issued code (or runs from a signed-in device) exactly like a
  // passkey, and only once the device has proven it holds the key it registers. The
  // signed message names the purpose, the challenge, the Host the request was addressed
  // to and the label, so a signature can't be replayed to another host or step.

  /** Step 1 of enrolling a native app: a challenge for its new device key to sign. */
  nativeEnrollOptions(req: IncomingMessage, caller: Caller | null, code: string | undefined) {
    let enrollCode: string | undefined;
    if (!caller || caller.kind !== 'session') {
      this.throttle('code', req);
      const c = code && this.takeCode(code, false);
      if (!c) this.fail('invalid or expired setup code', req, 'code');
      enrollCode = c;
    }
    const challenge = newSecret();
    const challengeId = this.newChallenge({ challenge, rpID: hostHeader(req), origin: '', expires: now() + CHALLENGE_TTL_MS, enrollCode, native: 'enroll' });
    return { challengeId, challenge, host: hostHeader(req) };
  }

  nativeEnrollVerify(req: IncomingMessage, challengeId: string, publicKey: string, signature: string, label: string) {
    const ch = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!ch || ch.expires < now() || ch.native !== 'enroll') this.fail('setup timed out, try again', req);
    if (ch.rpID !== hostHeader(req)) this.fail('setup was started on another address', req);
    if (ch.enrollCode && !this.takeCode(ch.enrollCode, false)) this.fail('invalid or expired setup code', req, 'code');
    const key = nativePublicKey(publicKey);
    if (!key) this.fail('device key not accepted', req);
    if (!checkSignature(key, nativeMessage('enroll', ch.challenge, ch.rpID, publicKey, label), signature)) this.fail('device key signature not accepted', req);
    if (ch.enrollCode && !this.takeCode(ch.enrollCode, true)) this.fail('invalid or expired setup code', req, 'code');
    if (this.nativeKeys.some((k) => k.publicKey === publicKey)) this.fail('this device is already enrolled', req);
    const t = now();
    const device: NativeKey = { id: shortId(), publicKey, label: label || 'device', createdAt: t, lastUsedAt: t };
    this.nativeKeys.push(device);
    this.save();
    this.audit('auth.device_added', { label: device.label, device: device.id, from: who(req) });
    return { deviceId: device.id, ...this.newBearerSession(req, device) };
  }

  /** Sign-in for an enrolled native device: a fresh challenge for its key. */
  nativeLoginOptions(req: IncomingMessage) {
    const challenge = newSecret();
    const challengeId = this.newChallenge({ challenge, rpID: hostHeader(req), origin: '', expires: now() + CHALLENGE_TTL_MS, native: 'login' });
    return { challengeId, challenge, host: hostHeader(req) };
  }

  nativeLoginVerify(req: IncomingMessage, challengeId: string, deviceId: string, signature: string, label: string) {
    const ch = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!ch || ch.expires < now() || ch.native !== 'login') this.fail('sign-in timed out, try again', req);
    if (ch.rpID !== hostHeader(req)) this.fail('sign-in was started on another address', req);
    const device = this.nativeKeys.find((k) => k.id === deviceId);
    const key = device && nativePublicKey(device.publicKey);
    if (!device || !key) this.fail('unknown device', req);
    if (!checkSignature(key, nativeMessage('login', ch.challenge, ch.rpID, deviceId, label), signature)) this.fail('device key signature not accepted', req);
    device.lastUsedAt = now();
    if (label) device.label = label;
    this.save();
    return { deviceId: device.id, ...this.newBearerSession(req, device) };
  }

  private newBearerSession(req: IncomingMessage, device: NativeKey) {
    const secret = newSecret();
    const t = now();
    const session: Session = { id: shortId(), hash: sha256(secret), label: device.label, via: 'native', createdAt: t, lastSeenAt: t, expiresAt: t + this.config.maxDays * 86400_000, bearer: true, keyId: device.id };
    this.store.sessions.push(session);
    this.store.sessions = this.store.sessions.filter((s) => s.expiresAt > t);
    this.save();
    this.audit('auth.signin', { via: 'native', device: device.label, session: session.id, from: who(req) });
    return { token: secret, sessionId: session.id, expiresAt: session.expiresAt, idleHours: this.config.idleHours };
  }

  /**
   * A cookie for the native app's preview web view only (a session's dev server on its own
   * port authorizes by cookie, like a browser). Short-lived, and it ends with the native sign-in.
   */
  nativePreviewSession(caller: Caller) {
    if (caller.kind !== 'session' || !caller.session.bearer) throw new AuthError(403, 'only the native app needs this');
    const parent = caller.session;
    const secret = newSecret();
    const t = now();
    const session: Session = { id: shortId(), hash: sha256(secret), label: `${parent.label} preview`, via: 'native-preview', createdAt: t, lastSeenAt: t, expiresAt: Math.min(parent.expiresAt, t + 12 * 3600_000), keyId: parent.keyId, parent: parent.id };
    this.store.sessions.push(session);
    this.save();
    this.audit('auth.preview_session', { session: session.id, parent: parent.id });
    return { value: secret, expiresAt: session.expiresAt, names: { https: SECURE_COOKIE, http: COOKIE } };
  }

  removeDevice(id: string) {
    const device = this.nativeKeys.find((k) => k.id === id);
    if (!device) throw new AuthError(404, 'no such device');
    if (!this.store.passkeys.length && !this.store.password && this.nativeKeys.length === 1) throw new AuthError(409, 'that is the last way in — enroll another device or add a passkey first');
    this.store.nativeKeys = this.nativeKeys.filter((k) => k.id !== id);
    this.save();
    this.audit('auth.device_removed', { label: device.label, device: id });
    for (const s of this.store.sessions.filter((s) => s.keyId === id)) this.endSession(s.id, 'device removed');
  }

  // ---------- management

  overview(current: Caller | null) {
    return {
      passkeys: this.store.passkeys.map(({ id, label, rpID, createdAt, lastUsedAt }) => ({ id, label, rpID, createdAt, lastUsedAt })),
      sessions: this.store.sessions
        .filter((s) => s.expiresAt > now())
        .map(({ id, label, via, createdAt, lastSeenAt, expiresAt, bearer, keyId }) => ({ id, label, via, createdAt, lastSeenAt, expiresAt, current: current?.kind === 'session' && current.session.id === id, native: !!bearer, deviceId: keyId ?? null })),
      devices: this.nativeKeys.map(({ id, label, createdAt, lastUsedAt }) => ({ id, label, createdAt, lastUsedAt, current: current?.kind === 'session' && current.session.keyId === id })),
      tokens: this.store.tokens.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
      password: !!this.store.password,
      enabled: this.enabled,
      idleHours: this.config.idleHours,
      maxDays: this.config.maxDays,
    };
  }

  removePasskey(id: string) {
    const pk = this.store.passkeys.find((p) => p.id === id);
    if (!pk) throw new AuthError(404, 'no such passkey');
    if (this.store.passkeys.length === 1 && !this.store.password && !this.nativeKeys.length) throw new AuthError(409, 'that is the last way in — add another passkey first');
    this.store.passkeys = this.store.passkeys.filter((p) => p.id !== id);
    this.save();
    this.audit('auth.passkey_removed', { label: pk.label });
  }

  removeToken(id: string) {
    this.store.tokens = this.store.tokens.filter((t) => t.id !== id);
    this.save();
    this.audit('auth.token_removed', { id });
  }

  signOutEverywhere(except?: string) {
    for (const s of [...this.store.sessions]) if (s.id !== except) this.endSession(s.id, 'signed out everywhere');
  }
}

// ---------- cookies

const COOKIE = 'ah_session';
/** __Host- cookies are locked to this exact host, https and path "/". */
const SECURE_COOKIE = '__Host-ah_session';

function isHttps(req: IncomingMessage): boolean {
  return String(req.headers.origin ?? '').startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';
}

function setCookie(req: IncomingMessage, value: string, maxAge: number): string {
  return isHttps(req)
    ? `${SECURE_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`
    : `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearCookies(): string[] {
  return [`${SECURE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`, `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`];
}

function cookie(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

/** The Host a request was addressed to, as the native app signs it. */
function hostHeader(req: IncomingMessage): string {
  return String(req.headers.host ?? '').toLowerCase();
}

/** What a native device key signs: purpose, challenge, the addressed Host, then the step's own fields. */
export function nativeMessage(purpose: 'enroll' | 'login', challenge: string, host: string, subject: string, label: string): Buffer {
  return Buffer.from([`ah-native-${purpose}-v1`, challenge, host, subject, label].join('\n'), 'utf8');
}

function nativePublicKey(raw: string): ReturnType<typeof createPublicKey> | null {
  try {
    const point = Buffer.from(raw, 'base64url');
    if (point.length !== 65 || point[0] !== 4 || point.toString('base64url') !== raw) return null;
    return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') }, format: 'jwk' });
  } catch {
    return null;
  }
}

function checkSignature(key: ReturnType<typeof createPublicKey>, message: Buffer, signature: string): boolean {
  try {
    const der = Buffer.from(signature, 'base64url');
    return der.length > 0 && der.length <= 80 && verifySignature('sha256', message, { key, dsaEncoding: 'der' }, der);
  } catch {
    return false;
  }
}

function who(req: IncomingMessage): string {
  return String(req.headers['tailscale-user-login'] ?? req.socket.remoteAddress ?? '?');
}
