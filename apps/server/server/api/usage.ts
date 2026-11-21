// Usage and limits (usage/, CND-6): tokens from the agents' own transcripts, their
// reported limits, and exports.
import { hostName } from '../host.ts';
import { HttpError, send } from '../http.ts';
import type { Core } from '../core.ts';
import type { UsageService } from '../usage/service.ts';
import { route, type Route } from './router.ts';

export type UsageRouteDeps = {
  core: Core;
  usage: UsageService;
};

export function usageRoutes({ core, usage }: UsageRouteDeps): Route[] {
  return [
    // Usage (server/usage): tokens, limits and estimates, each with where it came from.
    route('GET', /^\/api\/usage$/, async ({ res, url }) => {
      const by = url.searchParams.get('by') ?? 'model';
      if (!['day', 'model', 'provider', 'harness', 'session'].includes(by)) throw new HttpError(400, 'by is day, model, provider, harness or session', 'invalid_group');
      const day = (k: string) => {
        const v = url.searchParams.get(k);
        if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${k} is a date (YYYY-MM-DD)`, 'invalid_date');
        return v ?? undefined;
      };
      return send(res, 200, await usage.report({ from: day('from'), to: day('to'), by: by as 'model' }));
    }),
    route('GET', /^\/api\/usage\/limits$/, async ({ res }) => send(res, 200, await usage.limits())),
    route('POST', /^\/api\/usage\/refresh$/, async ({ res }) => send(res, 200, await usage.ingest())),
    route('GET', /^\/api\/usage\/export$/, async ({ res, url }) => {
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
      const body = await usage.export(format);
      res.writeHead(200, { 'content-type': format === 'json' ? 'application/json' : 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="ah-usage-${hostName()}.${format}"`, 'cache-control': 'no-store' });
      return void res.end(body);
    }),
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/usage$/, async ({ res, m }) => {
      const rec = core.registry.get(m[1]);
      if (!rec?.harnessId) throw new HttpError(404, 'no conversation for that session', 'not_found');
      return send(res, 200, await usage.session(rec.harness, rec.harnessId));
    }),
  ];
}
