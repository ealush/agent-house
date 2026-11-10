import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { FeedMessage } from '../../server/feed/schema.ts';
import type { HostApi } from '../api.ts';
import { initialFeed, reduce, type Action, type FeedState } from './reducer.ts';
import { CACHE_PAGE, dropCached, loadCached, saveCached } from './feedCache.ts';

/**
 * Live typed events for one session. One stream carries the snapshot and every
 * append, so there is no subscribe/page race; older pages are fetched on demand.
 *
 * The state lives here, not in the component: splitting, moving a pane, or
 * sending a session to another workspace remounts the GUI, and it should come
 * back with the conversation already on screen and its stream still open.
 * A stream nobody shows is closed after LINGER_MS, long enough to bridge a
 * remount and no longer: over HTTP/1.1 a browser has six connections per host,
 * and streams left open for sessions you walked past would take all of them,
 * stalling every other request. Their entries are kept (the newest KEEP
 * sessions), so coming back paints at once while a snapshot catches up.
 * A reload starts from this browser's encrypted copy (feedCache.ts) the same way.
 */
const LINGER_MS = 2000;
const KEEP = 16;

type Feed = {
  url: string;
  /** The cache's key: the stream without its query, which names this page
   *  (`client` is new on every load), so a reload finds what the last one saved. */
  cacheKey: string;
  client: HostApi;
  ref: string;
  state: FeedState;
  loadingOlder: boolean;
  /** What useSyncExternalStore reads: replaced on every change. */
  view: { state: FeedState; loadingOlder: boolean };
  listeners: Set<() => void>;
  users: number;
  es: EventSource | null;
  retry: ReturnType<typeof setTimeout> | null;
  linger: ReturnType<typeof setTimeout> | null;
  /** Its stream was closed after nobody showed it: only these are evicted. */
  closed: boolean;
};

// Insertion order is recency: a feed is moved to the end whenever it is shown.
const feeds = new Map<string, Feed>();

function changed(f: Feed) {
  f.view = { state: f.state, loadingOlder: f.loadingOlder };
  for (const fn of f.listeners) fn();
}

function dispatch(f: Feed, a: Action) {
  const next = reduce(f.state, a);
  if (next === f.state) return;
  f.state = next;
  changed(f);
  if (a.type === 'snapshot' || a.type === 'append') {
    saveCached(f.cacheKey, { harness: next.harness, entries: next.entries.slice(-CACHE_PAGE), hasOlder: next.hasOlder || next.entries.length > CACHE_PAGE });
  } else if (a.type === 'unavailable') {
    dropCached(f.cacheKey);
  }
}

function open(f: Feed) {
  if (f.retry) clearTimeout(f.retry);
  f.retry = null;
  f.es?.close();
  const es = (f.es = new EventSource(f.url));
  for (const type of ['snapshot', 'append', 'unavailable'] as const) {
    es.addEventListener(type, (e) => dispatch(f, JSON.parse((e as MessageEvent).data) as FeedMessage));
  }
  es.onerror = () => {
    dispatch(f, { type: 'disconnected' });
    // EventSource retries by itself unless the server refused outright.
    if (es.readyState === EventSource.CLOSED && f.es === es) f.retry = setTimeout(() => open(f), 3000);
  };
}

function close(f: Feed) {
  if (f.retry) clearTimeout(f.retry);
  f.retry = null;
  f.es?.close();
  f.es = null;
  f.closed = true;
  // The next stream starts with a snapshot; until then this copy is what we have.
  dispatch(f, { type: 'disconnected' });
  for (const [url, old] of feeds) {
    if (feeds.size <= KEEP) break;
    if (old.closed && old.users === 0) feeds.delete(url);
  }
}

function create(client: HostApi, ref: string): Feed {
  const view = { state: initialFeed, loadingOlder: false };
  const url = client.feedUrl(ref);
  const f: Feed = { url, cacheKey: url.split('?')[0], client, ref, state: initialFeed, loadingOlder: false, view, listeners: new Set(), users: 0, es: null, retry: null, linger: null, closed: false };
  feeds.set(f.url, f);
  void loadCached(f.cacheKey).then((cached) => cached && dispatch(f, { type: 'cached', ...cached }));
  return f;
}

function acquire(f: Feed, client: HostApi) {
  // Most recently shown last; re-inserted in case it was dropped since render.
  feeds.delete(f.url);
  feeds.set(f.url, f);
  f.client = client;
  f.closed = false;
  if (f.linger) clearTimeout(f.linger);
  f.linger = null;
  f.users++;
  if (!f.es) open(f);
}

function release(f: Feed) {
  f.users--;
  if (f.users > 0) return;
  f.linger = setTimeout(() => {
    f.linger = null;
    if (f.users === 0) close(f);
  }, LINGER_MS);
}

// iOS drops background connections; reopen as soon as we're visible again.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    for (const f of feeds.values()) {
      if (f.users > 0 && (!f.es || f.es.readyState === EventSource.CLOSED)) open(f);
    }
  });
}

export function useFeed(client: HostApi, ref: string) {
  // Looked up during render, so a remount paints the kept state on its first frame.
  const feed = feeds.get(client.feedUrl(ref)) ?? create(client, ref);
  useEffect(() => {
    acquire(feed, client);
    return () => release(feed);
  }, [feed, client]);
  const subscribe = useCallback(
    (fn: () => void) => {
      feed.listeners.add(fn);
      return () => feed.listeners.delete(fn);
    },
    [feed],
  );
  const { state, loadingOlder } = useSyncExternalStore(subscribe, () => feed.view);

  const loadOlder = useCallback(async () => {
    const f = feed;
    const oldest = f.state.entries[0]?.seq ?? Infinity;
    if (f.loadingOlder || !Number.isFinite(oldest)) return;
    f.loadingOlder = true;
    changed(f);
    try {
      dispatch(f, { type: 'older', ...(await f.client.feedPage(f.ref, oldest)) });
    } catch {
      // Older history went away (transcript rotated): the next snapshot says so.
    } finally {
      f.loadingOlder = false;
      changed(f);
    }
  }, [feed]);

  return { state, loadOlder, loadingOlder };
}
