import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, hostApi, normalize, subscribe, type HostApi, type State } from './api.ts';

/**
 * Live state for every host: the local daemon plus each online peer it proxies.
 * Windows and history are merged, each tagged with its host; window keys are
 * unique across machines ("@12" locally, "mac/@12" on a peer).
 */
export function useHosts(onState: (merged: State) => void) {
  const [local, setLocal] = useState<State | null>(null);
  const [peers, setPeers] = useState<Record<string, State>>({});
  const [error, setError] = useState<string | null>(null);
  const clients = useRef(new Map<string, HostApi>());

  useEffect(() => subscribe(setLocal, setError), []);

  const peerNames = (local?.hosts ?? []).filter((h) => !h.self && h.online).map((h) => h.name);
  const peerKey = peerNames.join(',');

  useEffect(() => {
    const stops = peerNames.map((name) =>
      subscribe(
        (s) => setPeers((p) => ({ ...p, [name]: s })),
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

  const merged = useMemo<State | null>(() => {
    if (!local) return null;
    const tag = (s: State, self: boolean) => ({
      windows: s.windows.map((w) => ({ ...w, host: s.hostname, key: self ? w.id : `${s.hostname}/${w.id}` })),
      history: s.history.map((h) => ({ ...h, host: s.hostname })),
    });
    const parts = [tag(local, true), ...peerNames.filter((n) => peers[n]).map((n) => tag({ ...peers[n], hostname: n }, false))];
    return {
      ...local,
      windows: parts.flatMap((p) => p.windows),
      history: parts.flatMap((p) => p.history).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at - a.at),
    };
  }, [local, peers, peerKey]);

  useEffect(() => {
    if (merged) onState(merged);
  }, [merged]);

  /** Immediate refetch after our own actions; the event streams catch everything else. */
  const refresh = useCallback(
    async (host?: string) => {
      try {
        const c = clientFor(host);
        const s = normalize(await c.state());
        if (c === api) setLocal(s);
        else setPeers((p) => ({ ...p, [host!]: s }));
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [local],
  );

  /** Per-host data a dialog needs (presets, sessions) for starting things there. */
  const hostState = (host: string): State | null => (!local ? null : host === local.hostname ? local : (peers[host] ?? null));

  return { state: merged, error, refresh, clientFor, hostState };
}
