// Full-text search over transcripts and side chats (search.ts), on this host or every
// host at once (peers answer for themselves; their results are merged here).
import { hostName } from '../host.ts';
import { HttpError, readJson, send } from '../http.ts';
import { peerUrlAllowed, type Peers } from '../peers.ts';
import { type SearchParams, combineResponses } from '../search.ts';
import type { PortableService } from '../portable/service.ts';
import type { SearchIndexer } from '../search.ts';
import { route, type Audit, type Route } from './router.ts';

/** Query params for /api/search and /api/search/all. Values are only ever bound parameters downstream. */
function searchParams(url: URL): SearchParams {
  const scope = url.searchParams.get('in');
  const num = (k: string) => {
    const n = Number(url.searchParams.get(k));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    q: (url.searchParams.get('q') ?? '').slice(0, 500),
    scope: scope === 'transcripts' || scope === 'chats' ? scope : 'all',
    role: url.searchParams.get('role') ?? undefined,
    project: url.searchParams.get('p') ?? undefined,
    host: url.searchParams.get('h') ?? undefined,
    model: url.searchParams.get('m') ?? undefined,
    limit: num('limit'),
    offset: num('offset'),
    from: num('from'),
    to: num('to'),
    order: url.searchParams.get('sort') === 'recent' ? 'recent' : undefined,
  };
}

export type SearchRouteDeps = {
  audit: Audit;
  portable: PortableService;
  search: SearchIndexer;
  peers: Peers;
};

export function searchRoutes({ audit, portable, search, peers }: SearchRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/search\/status$/, async ({ res }) => send(res, 200, await search.status())),
    route('GET', /^\/api\/search$/, async ({ res, url }) => {
      // ?lineage=<ref>: across every conversation that ref's lineage holds (forks, continuations in other agents).
      const lineage = url.searchParams.get('lineage');
      if (lineage && !/^[\w:.-]{1,80}$/.test(lineage)) throw new HttpError(400, 'invalid lineage');
      return send(res, 200, await search.search({ ...searchParams(url), ...(lineage ? { refs: await portable.lineageKeys(lineage) } : {}) }));
    }),
    route('GET', /^\/api\/search\/all$/, async ({ res, url, m }) => {
      // Hub fan-out: our own results plus every peer's, merged. A peer that is
      // offline or errors becomes a note in the response, never a failed search.
      const params = searchParams(url);
      const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 20)));
      const offset = Math.max(0, Math.floor(params.offset ?? 0));
      const needed = offset + limit;
      const selected = (host: string) => !params.host || host.toLowerCase().includes(params.host.toLowerCase());
      // Every host supplies the ordered prefix needed for this global page.
      // Applying the global offset on each host would lose or repeat sessions.
      const prefix = async (get: (p: SearchParams) => Promise<Awaited<ReturnType<typeof search.search>>>) => {
        let body: Awaited<ReturnType<typeof search.search>> | undefined;
        const results: NonNullable<typeof body>['results'] = [];
        do {
          const next = await get({ ...params, host: undefined, order: 'recent', limit: Math.min(50, needed - results.length), offset: results.length });
          body = next;
          results.push(...next.results);
          if (!next.results.length || results.length >= next.total) break;
        } while (results.length < needed);
        return { ...body!, results };
      };
      const parts = await Promise.all([
        ...(selected(hostName()) ? [prefix((p) => search.search(p)).then((body) => ({ host: hostName(), body }))] : []),
        ...peers.list().filter((peer) => selected(peer.name)).map(async (peer) => {
          if (!peer.online || !peerUrlAllowed(peer.url)) return { host: peer.name, error: 'offline' };
          try {
            const body = await prefix(async (p) => {
              const qs = new URLSearchParams();
              for (const [k, v] of Object.entries({ q: p.q, in: p.scope, role: p.role, p: p.project, m: p.model, limit: p.limit, offset: p.offset, from: p.from, to: p.to, sort: 'recent' })) {
                if (v !== undefined && v !== 'all') qs.set(k, String(v));
              }
              const r = await fetch(`${peer.url}/api/search?${qs}`, {
                headers: peer.token ? { authorization: `Bearer ${peer.token}` } : {},
                signal: AbortSignal.timeout(3000),
                redirect: 'manual',
              });
              if (!r.ok) throw new Error(`http ${r.status}`);
              return await r.json();
            });
            return { host: peer.name, body };
          } catch { return { host: peer.name, error: 'unreachable' }; }
        }),
      ]);
      return send(res, 200, combineResponses(parts, { offset, limit }));
    }),
    route('POST', /^\/api\/search\/rebuild$/, async ({ req, res }) => {
      void search.rebuild().catch((err) => console.error('search rebuild failed:', err));
      audit(req, 'search.rebuild');
      return send(res, 200, await search.status());
    }),
    route('POST', /^\/api\/search\/enabled$/, async ({ req, res }) => {
      const on = (await readJson(req)).enabled === true;
      await search.setEnabled(on);
      audit(req, on ? 'search.enable' : 'search.disable');
      return send(res, 200, await search.status());
    }),
  ];
}
