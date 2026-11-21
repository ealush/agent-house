// Web Push plumbing. Push needs a secure context (https via `pnpm serve`) and, on iOS,
// the app installed to the home screen; elsewhere we fall back to in-page notifications.

export type PushEvents = { waiting: boolean; done: boolean };

export function pushSupport(): 'ok' | 'insecure' | 'unsupported' {
  if (!window.isSecureContext) return 'insecure';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'ok';
}

let registration: Promise<ServiceWorkerRegistration> | null = null;

export function registerWorker() {
  if (pushSupport() !== 'ok') return null;
  registration ??= navigator.serviceWorker.register('/sw.js');
  return registration;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ah': '1' }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? res.statusText);
  return json;
}

function keyBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** This device's current opt-in, or null when it isn't subscribed. */
export async function pushStatus(): Promise<PushEvents | null> {
  const reg = await registerWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const { events } = await post<{ events: PushEvents | null }>('/api/push/status', { endpoint: sub.endpoint });
  return events;
}

export async function enablePush(events: PushEvents): Promise<void> {
  const reg = await registerWorker();
  if (!reg) throw new Error('Push needs HTTPS (pnpm serve) and, on iPhone/iPad, the home-screen app.');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site.');
  const { key } = await (await fetch('/api/push/key')).json();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) as BufferSource }));
  await post('/api/push/subscribe', { subscription: sub.toJSON(), events, label: deviceLabel() });
}

export async function disablePush(): Promise<void> {
  const reg = await registerWorker();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad|Macintosh.*Mobile/.test(ua) ? 'iPad' : /Mac/.test(ua) ? 'Mac' : /Android/.test(ua) ? 'Android' : /Linux/.test(ua) ? 'Linux' : 'device';
  return `${os} · ${new Date().toLocaleDateString()}`;
}
