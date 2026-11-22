// The state of everything (sessions, history, presets, …): once, as a stream of patches
// (server-sent events), and what this server can do (capabilities).
import { API_VERSION } from '../core.ts';
import { features } from '../features.ts';
import { hostName } from '../host.ts';
import { send, sse } from '../http.ts';
import type { Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { route, type Route } from './router.ts';

export type StateRouteDeps = {
  auth: Auth;
  config: Config;
  core: Core;
};

export function stateRoutes({ auth, config, core }: StateRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/state$/, async ({ res }) => send(res, 200, await core.current())),
    // What this host supports, with each feature's limits (server/features.ts).
    route('GET', /^\/api\/capabilities$/, ({ res }) => {
      return send(res, 200, {
        api: API_VERSION,
        host: hostName(),
        features: features(),
        uploads: { maxBytes: config.uploads.maxBytes, maxTotalBytes: config.uploads.maxTotalBytes, idleMs: config.uploads.idleMs },
        checkouts: config.checkouts,
      });
    }),
    route('GET', /^\/api\/events$/, ({ req, res, url, caller }) => {
      // Server-sent state pushes: one stream per client instead of polling.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      // The whole state first, then patches (only the fields that changed; web/api.ts merges them).
      let sent = false;
      // ?delta=1: windows as per-window deltas (web/api.ts); an older page gets the whole list.
      const deltas = url.searchParams.get('delta') === '1';
      const unsubscribe = core.subscribe((json, patch, slim) => {
        if (sent && patch) sse(res, `event: patch\ndata: ${deltas && slim ? slim : patch}\n\n`);
        else sse(res, `event: state\ndata: ${json}\n\n`);
        sent = true;
      });
      const ping = setInterval(() => sse(res, ': ping\n\n'), 25_000);
      const untrack = auth.track(caller, { close: () => res.end() });
      req.on('close', () => {
        clearInterval(ping);
        unsubscribe();
        untrack();
      });
      return;
    }),
  ];
}
