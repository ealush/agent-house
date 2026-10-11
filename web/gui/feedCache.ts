// The newest page of each conversation, kept in IndexedDB so a reload paints at
// once while the stream's snapshot catches up. Conversations are sensitive and a
// lost device is in the threat model (SECURITY.md), so every record is AES-GCM
// encrypted with a key the server derives from this sign-in: once the device
// signs out, is revoked or expires, the key is gone and so is the cache.
import type { CachedFeed } from './reducer.ts';

const DB = 'ah-feed-cache';
const FEEDS = 'feeds';
const META = 'meta';
/** Conversations kept; the least recently saved go first. */
const KEEP = 40;
/** Entries kept per conversation: one snapshot's worth. */
export const CACHE_PAGE = 200;
const MAX_BYTES = 4 * 1024 * 1024;
const SAVE_MS = 1000;

type Key = { key: CryptoKey };
type Row = { iv: Uint8Array; data: ArrayBuffer; at: number };

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

let dbP: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbP ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore(FEEDS);
      r.result.createObjectStore(META);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }).catch((e) => {
    dbP = null;
    throw e;
  });
  return dbP;
}

async function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return req(fn((await db()).transaction(store, mode).objectStore(store)));
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let keyP: Promise<Key | null> | null = null;
function key(): Promise<Key | null> {
  keyP ??= (async () => {
    // WebCrypto needs a secure context (https, or localhost); without it, no cache.
    if (!globalThis.crypto?.subtle || !globalThis.indexedDB) return null;
    const res = await fetch('/api/auth/cache-key', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ah': '1' }, body: '{}' });
    if (!res.ok) return null;
    const raw = fromB64url(((await res.json()) as { key: string }).key);
    const kid = [...new Uint8Array(await crypto.subtle.digest('SHA-256', raw))].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    // Another key means another sign-in: what is stored can't be read, so drop it.
    if ((await tx(META, 'readonly', (s) => s.get('kid'))) !== kid) {
      await tx(FEEDS, 'readwrite', (s) => s.clear());
      await tx(META, 'readwrite', (s) => s.put(kid, 'kid'));
    }
    return { key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  })()
    .catch(() => null)
    .then((k) => {
      // Not signed in yet (or offline): ask again next time.
      if (!k) keyP = null;
      return k;
    });
  return keyP;
}

const enc = new TextEncoder();

/** Any other small thing worth painting before the network answers (the session list), sealed the same way. */
export const loadSealed = <T>(id: string) => loadCached(id) as Promise<T | null>;
export const saveSealed = (id: string, value: unknown) => saveCached(id, value as CachedFeed);

export async function loadCached(url: string): Promise<CachedFeed | null> {
  try {
    const k = await key();
    if (!k) return null;
    const row = (await tx(FEEDS, 'readonly', (s) => s.get(url))) as Row | undefined;
    if (!row) return null;
    // The url is bound in as associated data: a record can't be swapped onto another session.
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv as Uint8Array<ArrayBuffer>, additionalData: enc.encode(url) }, k.key, row.data);
    return JSON.parse(new TextDecoder().decode(plain)) as CachedFeed;
  } catch {
    void tx(FEEDS, 'readwrite', (s) => s.delete(url)).catch(() => {});
    return null;
  }
}

const pending = new Map<string, CachedFeed>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Throttled: a busy turn appends often, and only the latest copy matters. */
export function saveCached(url: string, feed: CachedFeed) {
  pending.set(url, feed);
  timer ??= setTimeout(() => void flush(), SAVE_MS);
}

async function flush() {
  timer = null;
  const batch = [...pending];
  pending.clear();
  const k = await key();
  if (!k) return;
  for (const [url, feed] of batch) {
    try {
      let json = JSON.stringify(feed);
      if (json.length > MAX_BYTES) json = JSON.stringify({ ...feed, entries: feed.entries.slice(-20), hasOlder: true });
      if (json.length > MAX_BYTES) continue;
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(url) }, k.key, enc.encode(json));
      await tx(FEEDS, 'readwrite', (s) => s.put({ iv, data, at: Date.now() } satisfies Row, url));
    } catch {
      // Quota or a closed database: the cache is a convenience, the stream is the truth.
    }
  }
  await prune().catch(() => {});
}

async function prune() {
  const urls = (await tx(FEEDS, 'readonly', (s) => s.getAllKeys())) as string[];
  if (urls.length <= KEEP) return;
  const rows = (await tx(FEEDS, 'readonly', (s) => s.getAll())) as Row[];
  const old = urls.map((url, i) => ({ url, at: rows[i]?.at ?? 0 })).sort((a, b) => a.at - b.at).slice(0, urls.length - KEEP);
  for (const { url } of old) await tx(FEEDS, 'readwrite', (s) => s.delete(url));
}

export function dropCached(url: string) {
  pending.delete(url);
  void tx(FEEDS, 'readwrite', (s) => s.delete(url)).catch(() => {});
}

/** Signing out forgets every conversation this browser kept. */
export async function clearFeedCache() {
  pending.clear();
  keyP = null;
  try {
    (await dbP)?.close();
  } catch {}
  dbP = null;
  if (!globalThis.indexedDB) return;
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(DB);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}
