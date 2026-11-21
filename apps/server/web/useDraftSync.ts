import { useEffect, useRef, useState } from 'react';
import { CLIENT_ID, deviceName, type HostApi } from './api.ts';

/** Per session: the text we last saved to or loaded from the host. */
const synced = new Map<string, string>();

const SAVE_AFTER_MS = 700;

/**
 * Keeps a composer's unsent text on the host (server/drafts.ts), so a message
 * started on one device is there on the next, and survives a reload. The
 * host's copy only fills a box nobody has typed in since the last sync: what
 * you are typing here always wins. Returns the device a draft came from (for
 * a quiet "from iPhone" note) and `saveNow` for moments that can't wait.
 */
export function useDraftSync(client: HostApi, target: string, text: string, setText: (t: string) => void) {
  const [from, setFrom] = useState<string | null>(null);
  const pending = useRef<{ client: HostApi; target: string; text: string } | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  const flush = () => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    synced.set(p.target, p.text);
    p.client.saveDraft(p.target, p.text).catch(() => {});
  };

  // Pull: on open, and whenever this device comes back to the foreground.
  useEffect(() => {
    let live = true;
    setFrom(null);
    const pull = () =>
      client
        .draft(target)
        .then((d) => {
          if (!live || pending.current) return;
          const here = textRef.current;
          if (here !== (synced.get(target) ?? '')) return;
          // No draft there means it was sent or cleared elsewhere: an untouched box follows.
          const there = !d ? '' : d.client === CLIENT_ID ? null : d.text;
          if (there === null || there === here) return;
          synced.set(target, there);
          setText(there);
          setFrom(d && d.device !== deviceName() ? d.device : null);
        })
        .catch(() => {});
    void pull();
    const onShow = () => {
      if (document.visibilityState === 'visible') void pull();
      else flush(); // Put down here, picked up elsewhere: save what was typed.
    };
    document.addEventListener('visibilitychange', onShow);
    window.addEventListener('focus', onShow);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onShow);
      window.removeEventListener('focus', onShow);
      flush();
    };
  }, [client, target]);

  // Push: shortly after typing stops.
  useEffect(() => {
    if (text === (synced.get(target) ?? '') && !pending.current) return;
    if (text !== (synced.get(target) ?? '')) setFrom(null);
    pending.current = { client, target, text };
    const t = setTimeout(flush, SAVE_AFTER_MS);
    return () => clearTimeout(t);
  }, [client, target, text]);

  /** Sent or cleared: tell the host now, not after the debounce. */
  const saveNow = (next: string) => {
    pending.current = { client, target, text: next };
    flush();
  };

  return { from, saveNow };
}
