// Native push (APNs) for the iPhone/iPad app, beside Web Push (server/push.ts): the same
// transitions alert the same events, delivered through Apple's provider API with a
// token-signed (ES256 JWT) HTTP/2 connection. Device tokens belong to one native sign-in:
// signing out, being revoked or removing the device forgets them, so a lost phone stops
// receiving alerts the moment it loses access.
//
// Configured on the host only ("apns" in config.json): the team, the .p8 key Apple issued
// for it and the app's bundle id. Without it, registration is refused and nothing is sent.
import { connect, constants, type ClientHttp2Session } from 'node:http2';
import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type ApnsConfig = { teamId: string; keyId: string; keyFile: string; topic: string };
export type ApnsEnvironment = 'sandbox' | 'production';
/** What a lock screen shows: everything Web Push shows, or only that something happened. */
export type ApnsPreview = 'full' | 'private';
export type ApnsEvents = { waiting: boolean; done: boolean };

export type ApnsDevice = {
  token: string;
  environment: ApnsEnvironment;
  events: ApnsEvents;
  preview: ApnsPreview;
  /** The native sign-in that registered it, and its device key. */
  sessionId: string;
  deviceId: string;
  label: string;
  at: number;
};

/**
 * An alert as server/push.ts builds it, plus what the app needs to route and act on it.
 * `tag` groups and replaces alerts (a session uid, or a review layer); `route` is the
 * same fragment the web app opens ("<uid>", "review/<stack>/<pr>").
 */
export type ApnsAlert = { title: string; body: string; tag: string; route: string; host: string; badge: number; answerable: boolean };

const FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'apns.json');
const ORIGINS: Record<ApnsEnvironment, string> = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' };
/** Apple accepts a provider token for an hour; refresh well before that, but not more than every 20 minutes. */
const JWT_MAX_AGE_MS = 40 * 60_000;
const TOKEN_RE = /^[0-9a-f]{64,200}$/;
/** Badge-only updates (a session stopped needing you) are coalesced to at most one per interval. */
const BADGE_INTERVAL_MS = 20_000;

export class ApnsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * The provider origin: Apple's, or a loopback plaintext HTTP/2 stand-in when a test sets
 * AH_APNS_ORIGIN (never anything else: a token must not travel to an arbitrary host).
 */
export function apnsOrigin(environment: ApnsEnvironment, override = process.env.AH_APNS_ORIGIN): string {
  if (override) {
    const u = new URL(override);
    if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('AH_APNS_ORIGIN must be a loopback http:// address');
    return u.origin;
  }
  return ORIGINS[environment];
}

/** The provider authentication token: ES256 over {alg, kid}.{iss, iat}. */
export function providerToken(config: Pick<ApnsConfig, 'teamId' | 'keyId'>, key: KeyObject, issuedAt = Math.floor(Date.now() / 1000)): string {
  const part = (v: object) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const input = `${part({ alg: 'ES256', kid: config.keyId })}.${part({ iss: config.teamId, iat: issuedAt })}`;
  const signature = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${input}.${signature}`;
}

/** The notification body. `private` keeps the session's title and question off the lock screen. */
export function apnsPayload(alert: ApnsAlert, event: 'waiting' | 'done', preview: ApnsPreview) {
  const titles = { waiting: 'A session needs you', done: 'A session finished' };
  return {
    aps: {
      alert: preview === 'full' ? { title: alert.title, body: alert.body } : { title: titles[event] },
      badge: alert.badge,
      sound: 'default',
      'thread-id': alert.tag,
      'interruption-level': event === 'waiting' ? 'time-sensitive' : 'active',
      // Approve/Deny on the notification only where one tap is safe (a known permission prompt).
      ...(event === 'waiting' && alert.answerable ? { category: 'AH_APPROVAL' } : {}),
      // A finished session takes a reply from the notification (the app sends it like any message).
      ...(event === 'done' && !alert.route.startsWith('review') ? { category: 'AH_REPLY' } : {}),
    },
    ah: { v: 1, host: alert.host, route: alert.route, event },
  };
}

type Delivery = { status: number; reason?: string };
type Transport = (origin: string, path: string, headers: Record<string, string>, body: string) => Promise<Delivery>;

/** One HTTP/2 connection per provider origin, reopened when it closes. */
function http2Transport(): Transport {
  const sessions = new Map<string, ClientHttp2Session>();
  const session = (origin: string) => {
    const open = sessions.get(origin);
    if (open && !open.closed && !open.destroyed) return open;
    const s = connect(origin);
    s.on('error', (err) => console.warn(`apns connection: ${err.message}`));
    s.on('close', () => sessions.get(origin) === s && sessions.delete(origin));
    s.unref();
    sessions.set(origin, s);
    return s;
  };
  return (origin, path, headers, body) =>
    new Promise((resolve, reject) => {
      const req = session(origin).request({ [constants.HTTP2_HEADER_METHOD]: 'POST', [constants.HTTP2_HEADER_PATH]: path, ...headers });
      let status = 0;
      let text = '';
      req.setTimeout(10_000, () => req.close(constants.NGHTTP2_CANCEL));
      req.on('response', (h) => (status = Number(h[constants.HTTP2_HEADER_STATUS])));
      req.setEncoding('utf8');
      req.on('data', (d) => (text += d));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = text ? JSON.parse(text).reason : undefined;
        } catch {}
        resolve({ status, reason });
      });
      req.on('error', reject);
      req.end(body);
    });
}

export class Apns {
  private devices = new Map<string, ApnsDevice>();
  private key: KeyObject | null = null;
  private jwt: { value: string; at: number } | null = null;
  private lastBadge: number | null = null;
  private badgeTimer: NodeJS.Timeout | null = null;
  private badgeSentAt = 0;
  readonly config: ApnsConfig | null;
  private file: string;
  private transport: Transport;

  constructor(config: ApnsConfig | null | undefined, opts: { file?: string; transport?: Transport } = {}) {
    this.file = opts.file ?? FILE;
    this.transport = opts.transport ?? http2Transport();
    this.config = config && config.teamId && config.keyId && config.keyFile && config.topic ? config : null;
    if (this.config) {
      try {
        this.key = createPrivateKey(readFileSync(this.config.keyFile.replace(/^~(?=\/)/, homedir()), 'utf8'));
      } catch (err) {
        // A missing key disables APNs rather than failing every alert later.
        console.error(`APNs disabled: can't read ${this.config.keyFile} (${(err as Error).message})`);
        this.config = null;
      }
    }
    try {
      if (existsSync(this.file)) for (const d of JSON.parse(readFileSync(this.file, 'utf8')) as ApnsDevice[]) if (TOKEN_RE.test(d.token)) this.devices.set(d.token, d);
    } catch {}
  }

  get enabled() {
    return !!this.config && !!this.key;
  }

  status(sessionId: string | null) {
    const mine = sessionId ? [...this.devices.values()].find((d) => d.sessionId === sessionId) : undefined;
    return {
      configured: this.enabled,
      topic: this.config?.topic ?? null,
      registration: mine ? { environment: mine.environment, events: mine.events, preview: mine.preview, at: mine.at } : null,
    };
  }

  register(d: Omit<ApnsDevice, 'at'>) {
    if (!this.enabled) throw new ApnsError(409, 'APNs is not configured on this host (see "apns" in config.json)');
    const token = d.token.toLowerCase();
    if (!TOKEN_RE.test(token)) throw new ApnsError(400, 'invalid device token');
    if (d.environment !== 'sandbox' && d.environment !== 'production') throw new ApnsError(400, 'invalid environment');
    // One registration per native sign-in: a reinstall's new token replaces the old one.
    for (const [t, x] of this.devices) if (x.sessionId === d.sessionId || t === token) this.devices.delete(t);
    this.devices.set(token, { ...d, token, preview: d.preview === 'private' ? 'private' : 'full', label: d.label.slice(0, 80), at: Date.now() });
    this.persist();
  }

  unregister(sessionId: string) {
    let changed = false;
    for (const [t, d] of this.devices) if (d.sessionId === sessionId && this.devices.delete(t)) changed = true;
    if (changed) this.persist();
  }

  /** A native sign-in ended (signed out, revoked, expired, device removed): stop alerting it. */
  forgetSession(sessionId: string) {
    this.unregister(sessionId);
  }

  private token(): string {
    const t = Date.now();
    if (!this.jwt || t - this.jwt.at > JWT_MAX_AGE_MS) this.jwt = { value: providerToken(this.config!, this.key!), at: t };
    return this.jwt.value;
  }

  /** An alert for every registered device that wants this event. Resolves once all are attempted. */
  async send(event: 'waiting' | 'done', alert: ApnsAlert): Promise<void> {
    if (!this.enabled) return;
    this.lastBadge = alert.badge;
    const targets = [...this.devices.values()].filter((d) => d.events[event]);
    await Promise.all(
      targets.map((d) =>
        this.deliver(d, apnsPayload(alert, event, d.preview), {
          'apns-push-type': 'alert',
          'apns-priority': event === 'waiting' ? '10' : '5',
          'apns-expiration': String(Math.floor(Date.now() / 1000) + 600),
          // A newer alert for the same session replaces the older one on the device.
          'apns-collapse-id': alert.tag.slice(0, 64),
        }),
      ),
    );
  }

  /**
   * The app icon's badge counts sessions that need you. When that count changes without
   * an alert (answered elsewhere, or the agent moved on), devices get a badge-only update,
   * coalesced so a burst of changes is one push.
   */
  badge(count: number) {
    if (!this.enabled || count === this.lastBadge) return;
    this.lastBadge = count;
    if (this.badgeTimer) return;
    const wait = Math.max(0, this.badgeSentAt + BADGE_INTERVAL_MS - Date.now());
    this.badgeTimer = setTimeout(() => {
      this.badgeTimer = null;
      this.badgeSentAt = Date.now();
      const badge = this.lastBadge ?? 0;
      const targets = [...this.devices.values()].filter((d) => d.events.waiting);
      void Promise.all(targets.map((d) => this.deliver(d, { aps: { badge } }, { 'apns-push-type': 'alert', 'apns-priority': '5' })));
    }, wait);
    this.badgeTimer.unref?.();
  }

  private async deliver(d: ApnsDevice, payload: object, headers: Record<string, string>) {
    try {
      const res = await this.transport(apnsOrigin(d.environment), `/3/device/${d.token}`, { authorization: `bearer ${this.token()}`, 'apns-topic': this.config!.topic, ...headers }, JSON.stringify(payload));
      // Apple says the token is gone: forget it (the app registers a fresh one at its next launch).
      if (res.status === 410 || (res.status === 400 && (res.reason === 'BadDeviceToken' || res.reason === 'DeviceTokenNotForTopic'))) {
        if (this.devices.delete(d.token)) this.persist();
      } else if (res.status === 403 && res.reason === 'ExpiredProviderToken') {
        this.jwt = null;
      } else if (res.status !== 200) {
        console.error(`apns to ${d.label || 'device'} failed: ${res.status} ${res.reason ?? ''}`);
      }
    } catch (err) {
      console.error(`apns to ${d.label || 'device'} failed: ${(err as Error).message}`);
    }
  }

  /** Writes run one after another, so the file always ends up with the latest registrations. */
  private writing: Promise<void> = Promise.resolve();

  private persist() {
    const data = JSON.stringify([...this.devices.values()], null, 2);
    this.writing = this.writing
      .then(() => mkdir(dirname(this.file), { recursive: true, mode: 0o700 }))
      .then(() => writeFile(this.file, data, { mode: 0o600 }))
      .catch((err) => console.error(`writing ${this.file} failed:`, err));
  }
}
