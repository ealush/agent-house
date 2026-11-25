import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, hostApi, normalize, subscribe, type HostApi, type State } from './api.ts';
import { loadSealed, saveSealed } from './gui/feedCache.ts';
import { reachText } from './errors.ts';

/**
 * Live state for every host: the local daemon plus each online peer it proxies.
 * Windows and history are merged, each tagged with its host; window keys are
 * unique across machines: the session uid locally, "mac/<uid>" on a peer.
 * A uid outlives its tmux window (resume, a restarted tmux server), so links
 * and saved layouts keep pointing at the same session.
 */
export function useHosts(onState: (merged: State) => void) {
  const [local, setLocal] = useState<State | null>(null);
  const [peers, setPeers] = useState<Record<string, State>>({});
  const [error, setError] = useState<string | null>(null);
  const clients = useRef(new Map<string, HostApi>());
  /** States each host's stream has delivered ('' for this host's): a refresh that answers after
   * one of them is older than what it shows. */
  const streamed = useRef(new Map<string, number>());
  const delivered = (key: string) => streamed.current.set(key, (streamed.current.get(key) ?? 0) + 1);
  // Windows we are terminating: gone from the UI at once, back if the kill fails.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  // The last session list paints at once (sealed per sign-in, gui/feedCache.ts); the stream replaces it.
  useEffect(() => {
    let live = false;
    let savedAt = 0;
    void loadSealed<State>('state:local').then((cached) => {
      if (cached && !live) setLocal(cached);
    });
    return subscribe((s) => {
      live = true;
      delivered('');
      setLocal(s);
      // State changes every tick; a copy every 20s is plenty for a first paint.
      if (Date.now() - savedAt > 20_000) {
        savedAt = Date.now();
        saveSealed('state:local', s);
      }
    }, setError);
  }, []);

  const peerNames = (local?.hosts ?? []).filter((h) => !h.self && h.online).map((h) => h.name);
  const peerKey = peerNames.join(',');

  useEffect(() => {
    const stops = peerNames.map((name) =>
      subscribe(
        (s) => {
          delivered(name);
          setPeers((p) => ({ ...p, [name]: s }));
        },
        () => {},
        clientFor(name),
      ),
    );
    // Drop peers that went offline.
    setPeers((p) => Object.fromEntries(Object.entries(p).filter(([n]) => peerNames.includes(n))));
    return () => stops.forEach((stop) => stop());
  }, [peerKey]);

  function clientFor(host: string | undefined): HostApi {
    if (!host || !local || host === local.hostname) return api;
    let c = clients.current.get(host);
    if (!c) clients.current.set(host, (c = hostApi(`/h/${encodeURIComponent(host)}`)));
    return c;
  }

  const all = useMemo<State | null>(() => {
    if (!local) return null;
    const tag = (s: State, self: boolean) => ({
      windows: s.windows.map((w) => ({ ...w, host: s.hostname, key: self ? w.uid : `${s.hostname}/${w.uid}` })),
      history: s.history.map((h) => ({ ...h, host: s.hostname })),
    });
    const parts = [tag(local, true), ...peerNames.filter((n) => peers[n]).map((n) => tag({ ...peers[n], hostname: n }, false))];
    return {
      ...local,
      windows: parts.flatMap((p) => p.windows),
      history: parts.flatMap((p) => p.history).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at),
    };
  }, [local, peers, peerKey]);

  const merged = useMemo<State | null>(() => (all && hidden.size ? { ...all, windows: all.windows.filter((w) => !hidden.has(w.key)) } : all), [all, hidden]);

  // Forget a hidden key once the host stops listing it, so a resume under the same uid shows up.
  useEffect(() => {
    if (!all || !hidden.size) return;
    const live = new Set(all.windows.map((w) => w.key));
    if ([...hidden].some((k) => !live.has(k))) setHidden((h) => new Set([...h].filter((k) => live.has(k))));
  }, [all, hidden]);

  /** Optimistically drop a window from the merged state (or bring it back). */
  const hide = useCallback((key: string, on: boolean) => {
    setHidden((h) => {
      if (h.has(key) === on) return h;
      const next = new Set(h);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  useEffect(() => {
    if (merged) onState(merged);
  }, [merged]);

  /** Immediate refetch after our own actions; the event streams catch everything else. Returns the fetched state so callers can wait on it. */
  const refresh = useCallback(
    async (host?: string): Promise<State | null> => {
      try {
        const c = clientFor(host);
        const key = c === api ? '' : host!;
        const at = streamed.current.get(key) ?? 0;
        const s = normalize(await c.state());
        // The host answers with its last pass. A patch its stream delivered meanwhile is newer
        // (an action's own change, published as the pass that saw it ended): this answer would
        // put the older state back, and with nothing more to change the stream wouldn't send it
        // again. Only an answer nothing newer came before is shown.
        if ((streamed.current.get(key) ?? 0) === at) {
          if (c === api) setLocal(s);
          else setPeers((p) => ({ ...p, [host!]: s }));
        }
        setError(null);
        return s;
      } catch (e) {
        setError(reachText(e));
        return null;
      }
    },
    [local],
  );

  /** Per-host data a dialog needs (presets, sessions) for starting things there. */
  const hostState = (host: string): State | null => (!local ? null : host === local.hostname ? local : (peers[host] ?? null));

  return { state: merged, error, refresh, clientFor, hostState, hide };
}
