import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { FeedMessage } from '../../server/feed/schema.ts';
import type { HostApi } from '../api.ts';
import { initialFeed, reduce } from './reducer.ts';

/**
 * Live typed events for one session. One stream carries the snapshot and every
 * append, so there is no subscribe/page race; older pages are fetched on demand.
 */
export function useFeed(client: HostApi, ref: string) {
  const [state, dispatch] = useReducer(reduce, initialFeed);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const oldest = useRef(Infinity);
  oldest.current = state.entries[0]?.seq ?? Infinity;

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    const open = () => {
      if (closed) return;
      es?.close();
      es = new EventSource(client.feedUrl(ref));
      for (const type of ['snapshot', 'append', 'unavailable'] as const) {
        es.addEventListener(type, (e) => dispatch(JSON.parse((e as MessageEvent).data) as FeedMessage));
      }
      es.onerror = () => {
        dispatch({ type: 'disconnected' });
        // EventSource retries by itself unless the server refused outright.
        if (es?.readyState === EventSource.CLOSED) setTimeout(open, 3000);
      };
    };
    open();
    // iOS drops background connections; reopen as soon as we're visible again.
    const wake = () => {
      if (document.visibilityState === 'visible' && (!es || es.readyState === EventSource.CLOSED)) open();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      closed = true;
      es?.close();
      document.removeEventListener('visibilitychange', wake);
    };
  }, [client, ref]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || !Number.isFinite(oldest.current)) return;
    setLoadingOlder(true);
    try {
      dispatch({ type: 'older', ...(await client.feedPage(ref, oldest.current)) });
    } catch {
      // Older history went away (transcript rotated): the next snapshot says so.
    } finally {
      setLoadingOlder(false);
    }
  }, [client, ref, loadingOlder]);

  return { state, loadOlder, loadingOlder };
}
