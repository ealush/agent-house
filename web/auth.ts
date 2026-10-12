// The WebAuthn helper loads only when a passkey is created or used, not with every page.
const webauthn = () => import('@simplewebauthn/browser');
import { deviceName } from './api.ts';
import { clearFeedCache } from './gui/feedCache.ts';

export type AuthStatus = { enabled: boolean; enrolled: boolean; authenticated: boolean; password: boolean };

export type Overview = {
  passkeys: Array<{ id: string; label: string; rpID: string; createdAt: number; lastUsedAt: number }>;
  sessions: Array<{ id: string; label: string; via: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean }>;
  tokens: Array<{ id: string; name: string; createdAt: number; lastUsedAt: number }>;
  password: boolean;
  /** false when the host's config turns sign-in off. */
  enabled: boolean;
  idleHours: number;
  maxDays: number;
  audit: Array<{ at: string; event: string; [k: string]: unknown }>;
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ah': '1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json as T;
}

/** "iPhone · Safari": how this device appears in the signed-in list. */
export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${deviceName()} · ${browser}`;
}

/** Passkeys need WebAuthn and a domain name (the https://….ts.net address, or localhost). */
export function passkeysAvailable(): { ok: boolean; why?: string } {
  if (typeof window.PublicKeyCredential !== 'function') return { ok: false, why: "This browser can't use passkeys." };
  if (!window.isSecureContext) return { ok: false, why: 'Passkeys need https. Open ah through its https://….ts.net address (pnpm serve).' };
  if (/^[\d.]+$/.test(location.hostname)) return { ok: false, why: 'Passkeys need a name, not an IP. Open ah through its https://….ts.net address.' };
  return { ok: true };
}

export const authApi = {
  status: () => call<AuthStatus>('GET', '/api/auth/status'),

  /** Creates a passkey for this device: with a host-issued setup code, or while signed in. */
  async addPasskey(code?: string, label = deviceLabel()) {
    const { challengeId, options } = await call<{ challengeId: string; options: never }>('POST', '/api/auth/register/options', { code });
    const response = await (await webauthn()).startRegistration({ optionsJSON: options });
    await call('POST', '/api/auth/register/verify', { challengeId, response, label });
  },

  async signIn(label = deviceLabel()) {
    const { challengeId, options } = await call<{ challengeId: string; options: never }>('POST', '/api/auth/login/options');
    const response = await (await webauthn()).startAuthentication({ optionsJSON: options });
    await call('POST', '/api/auth/login/verify', { challengeId, response, label });
  },

  passwordSignIn: (password: string, label = deviceLabel()) => call('POST', '/api/auth/password/login', { password, label }),
  async signOut() {
    await clearFeedCache();
    return call('POST', '/api/auth/logout');
  },
  overview: () => call<Overview>('GET', '/api/auth/overview'),
  newCode: () => call<{ code: string; ttlMinutes: number }>('POST', '/api/auth/code'),
  revoke: (id: string) => call('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`),
  signOutEverywhere: () => call('POST', '/api/auth/signout-all'),
  removePasskey: (id: string) => call('DELETE', `/api/auth/passkeys/${encodeURIComponent(id)}`),
  removeToken: (id: string) => call('DELETE', `/api/auth/tokens/${encodeURIComponent(id)}`),
};

/** WebAuthn errors are cryptic; say what actually happened. */
export function explain(err: unknown): string {
  const e = err as Error;
  if (e?.name === 'NotAllowedError') return 'Cancelled, or the passkey prompt timed out.';
  if (e?.name === 'InvalidStateError') return 'This device already has a passkey for ah. Sign in with it instead.';
  return e?.message ?? String(err);
}
