// This device's developer log (Settings → System → Developer): what the page did, kept
// in this browser until you send it to the host as a bundle for an agent to read
// (POST /api/system/logging/client, saved beside the host's own log). Off until turned
// on here. Kept: the last three days, at most MAX_ENTRIES.
//
// In it: messages sent (their words, capped, and their attachments' sizes, never their
// bytes), every request the page makes (method, path, status, time, or why it failed),
// the live connection opening and dropping, the page hidden and shown, and errors.
// Never cookies, tokens or setup codes: queries are redacted as the host's are.

export type ClientEntry = { at: string; kind: string } & Record<string, unknown>;

const ON = 'ah.clientLog';
const STORE = 'ah.clientLog.entries';
export const MAX_ENTRIES = 5000;
export const KEEP_MS = 3 * 24 * 3600_000;
/** A sent message's words are kept up to this many characters (as the host keeps them). */
export const TEXT_KEEP = 2000;
/** The bundle route itself: sending the log isn't something to log. */
const BUNDLE = '/api/system/logging/client';

let on = false;
let entries: ClientEntry[] = [];
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
/** Uploaded file path → its size, so a message naming it says how big it was. */
const sizes = new Map<string, number>();

function load() {
  try {
    on = localStorage.getItem(ON) === '1';
    const kept = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    entries = Array.isArray(kept) ? kept : [];
  } catch {
    entries = [];
  }
}
load();

/** A bundle's time window: from and to, in ms since the epoch (either open). */
export type Window = { from?: number; to?: number };

/** The entries inside `w`, oldest first. Pure. */
export function within(list: readonly ClientEntry[], w: Window): ClientEntry[] {
  return list.filter((e) => {
    const t = Date.parse(e.at);
    return (w.from === undefined || t >= w.from) && (w.to === undefined || t <= w.to);
  });
}

/** The window "the last `minutes` minutes" names at `now` (null minutes: everything kept). Pure. */
export const lastMinutes = (minutes: number | null, now = Date.now()): Window => (minutes === null ? {} : { from: now - minutes * 60_000, to: now });

/** One JSON line per entry, as the host keeps a bundle, after a header saying what's in it. Pure. */
export function asJsonl(list: readonly ClientEntry[], header: Record<string, unknown>): string {
  return [{ kind: 'bundle', ...header, entries: list.length }, ...list].map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/** Entries still kept at `now`: the last three days, the newest MAX_ENTRIES. Pure. */
export function kept(list: readonly ClientEntry[], now: number, max = MAX_ENTRIES): ClientEntry[] {
  const from = now - KEEP_MS;
  return list.filter((e) => Date.parse(e.at) >= from).slice(-max);
}

const SECRET_PARAM = /token|code|secret|key|password|auth|sig|cookie/i;

/** A URL as the log keeps it: path and query, secret-looking values replaced. Pure. */
export function redactedUrl(raw: string, base = 'http://x'): string {
  let u: URL;
  try {
    u = new URL(raw, base);
  } catch {
    return raw.slice(0, 200);
  }
  const q = [...u.searchParams].map(([k, v]) => `${encodeURIComponent(k)}=${SECRET_PARAM.test(k) ? '…' : encodeURIComponent(v.slice(0, 200))}`);
  return q.length ? `${u.pathname}?${q.join('&')}` : u.pathname;
}

const PATH = /(?:^|\s)((?:~|\/)[^\s'"`]+\.\w{1,8})(?=[\s'"`]|$)/g;

/** A message as the log keeps it: length, words up to TEXT_KEEP, the files it names with the sizes this device sent them at. Pure but for `known`. */
export function messageDetail(text: string, known: ReadonlyMap<string, number> = sizes): Record<string, unknown> {
  const files = [...text.matchAll(PATH)].slice(0, 20).map((m) => ({ ext: (m[1].match(/\.(\w{1,8})$/)?.[1] ?? '').toLowerCase(), bytes: known.get(m[1]) ?? null }));
  return {
    chars: text.length,
    text: text.length > TEXT_KEEP ? `${text.slice(0, TEXT_KEEP)}…` : text,
    ...(files.length ? { attachments: files, attachmentBytes: files.reduce((n, f) => n + (f.bytes ?? 0), 0) } : {}),
  };
}

function save() {
  saveTimer = undefined;
  entries = kept(entries, Date.now());
  try {
    localStorage.setItem(STORE, JSON.stringify(entries));
  } catch {
    // Full: keep the newer half.
    entries = entries.slice(-Math.floor(entries.length / 2));
    try {
      localStorage.setItem(STORE, JSON.stringify(entries));
    } catch {}
  }
}

const changed = () => {
  for (const fn of listeners) fn();
};

export const clientLog = {
  get on() {
    return on;
  },
  /** Turn this device's log on or off. Off keeps what's there until cleared. */
  set(next: boolean) {
    if (on && !next) this.event('logging', { on: false });
    on = next;
    try {
      if (next) localStorage.setItem(ON, '1');
      else localStorage.removeItem(ON);
    } catch {}
    if (next) this.event('logging', { on: true, ua: navigator.userAgent });
    save();
    changed();
  },
  /** One thing that happened. Nothing happens while the log is off. */
  event(kind: string, detail: Record<string, unknown> = {}) {
    if (!on) return;
    entries.push({ at: new Date().toISOString(), kind, ...detail });
    if (entries.length > MAX_ENTRIES + 500) entries = entries.slice(-MAX_ENTRIES);
    saveTimer ??= setTimeout(save, 1000);
    changed();
  },
  /** A file this device uploaded, so a message that names its path says how big it was. */
  uploaded(path: string, bytes: number, type: string) {
    sizes.set(path, bytes);
    this.event('upload', { bytes, type: type.slice(0, 60), ext: (path.match(/\.(\w{1,8})$/)?.[1] ?? '').toLowerCase() });
  },
  /** What's kept, or just what falls in `w`. */
  entries(w: Window = {}): ClientEntry[] {
    return within(kept(entries, Date.now()), w);
  },
  clear() {
    entries = [];
    save();
    changed();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
};

let installed = false;
/**
 * Logs every request the page makes (fetch, whoever calls it), errors nobody caught,
 * and the page going out of sight and back. Once, at startup (main.tsx).
 */
export function installClientLog() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const plain = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!on) return plain(input, init);
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const path = redactedUrl(url, location.href);
    if (path.startsWith(BUNDLE)) return plain(input, init);
    const t0 = performance.now();
    const body = init?.body;
    const bytesOut = typeof body === 'string' ? body.length : body instanceof Blob ? body.size : undefined;
    try {
      const res = await plain(input, init);
      clientLog.event('request', { method, path, status: res.status, ms: Math.round(performance.now() - t0), ...(bytesOut ? { bytesOut } : {}) });
      return res;
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      clientLog.event(aborted ? 'request' : 'network-error', { method, path, ms: Math.round(performance.now() - t0), ...(aborted ? { aborted: true } : { error: String((err as Error)?.message ?? err), online: navigator.onLine }) });
      throw err;
    }
  };
  window.addEventListener('error', (e) => clientLog.event('error', { message: e.message, source: e.filename ? redactedUrl(e.filename, location.href) : undefined, line: e.lineno, stack: (e.error as Error | undefined)?.stack?.slice(0, 4000) }));
  window.addEventListener('unhandledrejection', (e) => clientLog.event('error', { message: String((e.reason as Error)?.message ?? e.reason), unhandled: true, stack: (e.reason as Error | undefined)?.stack?.slice(0, 4000) }));
  document.addEventListener('visibilitychange', () => clientLog.event('page', { visible: document.visibilityState === 'visible' }));
  window.addEventListener('online', () => clientLog.event('network', { online: true }));
  window.addEventListener('offline', () => clientLog.event('network', { online: false }));
  window.addEventListener('pagehide', save);
  clientLog.event('page', { loaded: true, path: location.pathname });
}
