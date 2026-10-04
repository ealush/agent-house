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
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
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
type Session = { id: string; hash: string; label: string; via: string; createdAt: number; lastSeenAt: number; expiresAt: number };
type Token = { id: string; hash: string; name: string; createdAt: number; lastUsedAt: number };
type Store = { userId: string; passkeys: Passkey[]; sessions: Session[]; tokens: Token[]; password?: { salt: string; hash: string } };

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
  private challenges = new Map<string, { challenge: string; rpID: string; origin: string; expires: number; enrollCode?: string; sessionId?: string }>();
  private failures: number[] = [];
  /** Live sockets/streams per session, so revoking a device also cuts its terminals. */
  private live = new Map<string, Set<{ close: () => void }>>();
  readonly localToken: string;

  constructor(config: AuthConfig) {
    this.config = config;
    this.store = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { userId: newSecret(), passkeys: [], sessions: [], tokens: [] };
    this.store.tokens ??= [];
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
  get enrolled() {
    return this.store.passkeys.length > 0 || !!this.store.password;
  }

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

  // ---------- throttling (all login paths share one budget)

  private throttle() {
    const t = now();
    this.failures = this.failures.filter((f) => t - f < 5 * 60_000);
    if (this.failures.length >= 10) throw new AuthError(429, 'Too many failed attempts. Try again in a few minutes.');
  }

  private fail(reason: string, req: IncomingMessage): never {
    this.failures.push(now());
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
      return null;
    }
    const raw = cookie(req, COOKIE) ?? cookie(req, SECURE_COOKIE);
    if (!raw) return null;
    const hash = sha256(raw);
    const s = this.store.sessions.find((x) => safeEqual(x.hash, hash));
    if (!s) return null;
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

  endSession(id: string, reason: string) {
    const before = this.store.sessions.length;
    this.store.sessions = this.store.sessions.filter((s) => s.id !== id);
    if (this.store.sessions.length !== before) {
      this.save();
      this.audit('auth.signout', { session: id, reason });
    }
    for (const c of this.live.get(id) ?? []) c.close();
    this.live.delete(id);
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
    return { origin, rpID: host };
  }

  /** Step 1 of adding a passkey: either with a host-issued code, or from a signed-in device. */
  async registrationOptions(req: IncomingMessage, caller: Caller | null, code: string | undefined) {
    this.throttle();
    let enrollCode: string | undefined;
    if (!caller || caller.kind !== 'session') {
      const c = code && this.takeCode(code, false);
      if (!c) this.fail('invalid or expired setup code', req);
      enrollCode = c;
    }
    const { origin, rpID } = this.originOf(req);
    const options = await generateRegistrationOptions({
      rpName: 'ah',
      rpID,
      userName: `ah@${hostname()}`,
      userDisplayName: `ah on ${hostname()}`,
      userID: Buffer.from(this.store.userId),
      attestationType: 'none',
      excludeCredentials: this.store.passkeys.filter((p) => p.rpID === rpID).map((p) => ({ id: p.id, transports: p.transports as never })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = shortId();
    this.challenges.set(challengeId, { challenge: options.challenge, rpID, origin, expires: now() + CHALLENGE_TTL_MS, enrollCode, sessionId: caller?.kind === 'session' ? caller.session.id : undefined });
    return { challengeId, options };
  }

  async verifyRegistration(req: IncomingMessage, challengeId: string, response: RegistrationResponseJSON, label: string) {
    this.throttle();
    const ch = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!ch || ch.expires < now()) this.fail('setup timed out, try again', req);
    // The code is spent only once a passkey actually exists.
    if (ch.enrollCode && !this.takeCode(ch.enrollCode, true)) this.fail('invalid or expired setup code', req);
    let result;
    try {
      result = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: ch.origin, expectedRPID: ch.rpID, requireUserVerification: true });
    } catch (err) {
      this.fail(`passkey not accepted: ${(err as Error).message}`, req);
    }
    if (!result.verified) this.fail('passkey not accepted', req);
    const { credential } = result.registrationInfo;
    const t = now();
    this.store.passkeys.push({ id: credential.id, publicKey: b64url(credential.publicKey), counter: credential.counter, transports: credential.transports, rpID: ch.rpID, label: label.slice(0, 60) || 'passkey', createdAt: t, lastUsedAt: t });
    this.save();
    this.audit('auth.passkey_added', { label, rpID: ch.rpID, from: who(req) });
    // Enrolling signs this device in; adding a passkey from a signed-in device keeps its session.
    return ch.sessionId ? null : this.newSession(req, label, 'passkey');
  }

  async authenticationOptions(req: IncomingMessage) {
    this.throttle();
    const { origin, rpID } = this.originOf(req);
    // Empty allowCredentials: discoverable credentials, so the OS offers the right passkey.
    const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
    const challengeId = shortId();
    this.challenges.set(challengeId, { challenge: options.challenge, rpID, origin, expires: now() + CHALLENGE_TTL_MS });
    return { challengeId, options };
  }

  async verifyAuthentication(req: IncomingMessage, challengeId: string, response: AuthenticationResponseJSON, label: string) {
    this.throttle();
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
    this.throttle();
    if (!this.store.password) this.fail('no master password is set', req);
    const hash = await scrypt(password, Buffer.from(this.store.password.salt, 'base64'), 32, SCRYPT);
    if (!timingSafeEqual(hash, Buffer.from(this.store.password.hash, 'base64'))) this.fail('wrong password', req);
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

  // ---------- management

  overview(current: Caller | null) {
    return {
      passkeys: this.store.passkeys.map(({ id, label, rpID, createdAt, lastUsedAt }) => ({ id, label, rpID, createdAt, lastUsedAt })),
      sessions: this.store.sessions
        .filter((s) => s.expiresAt > now())
        .map(({ id, label, via, createdAt, lastSeenAt, expiresAt }) => ({ id, label, via, createdAt, lastSeenAt, expiresAt, current: current?.kind === 'session' && current.session.id === id })),
      tokens: this.store.tokens.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })),
      password: !!this.store.password,
      idleHours: this.config.idleHours,
      maxDays: this.config.maxDays,
    };
  }

  removePasskey(id: string) {
    const pk = this.store.passkeys.find((p) => p.id === id);
    if (!pk) throw new AuthError(404, 'no such passkey');
    if (this.store.passkeys.length === 1 && !this.store.password) throw new AuthError(409, 'that is the last way in — add another passkey first');
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

function who(req: IncomingMessage): string {
  return String(req.headers['tailscale-user-login'] ?? req.socket.remoteAddress ?? '?');
}
