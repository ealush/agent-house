// Checkouts (docs/spec/18-checkouts.md): repository-level concurrency, overlaps,
// integration compatibility checks, pinning, recreation, and automatic reclamation.
import { HttpError, readJson, send } from '../http.ts';
import type { CheckoutsService } from '../checkouts/service.ts';
import { route, type Audit, type Route } from './router.ts';

export type CheckoutsRouteDeps = {
  audit: Audit;
  checkouts: CheckoutsService;
};

export function checkoutsRoutes({ audit, checkouts }: CheckoutsRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/checkouts$/, async ({ res, url }) => {
      const repo = url.searchParams.get('repo')?.trim() || undefined;
      return send(res, 200, await checkouts.list(repo));
    }),
    route('POST', /^\/api\/checkouts\/gc$/, async ({ req, res }) => {
      const body = await readJson(req);
      const dryRun = body.dryRun === true;
      const out = await checkouts.runGc({ dryRun });
      audit(req, 'checkouts.gc', { dryRun, reclaimed: out.reclaimed.length, reclaimedBytes: out.reclaimedBytes });
      return send(res, 200, out);
    }),
    route('GET', /^\/api\/checkouts\/(ck-[\w-]{1,32})$/, async ({ res, m }) => {
      return send(res, 200, await checkouts.get(m[1]));
    }),
    route('POST', /^\/api\/checkouts\/(ck-[\w-]{1,32})\/pin$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      if (typeof body.pinned !== 'boolean') throw new HttpError(400, 'pinned must be true or false');
      const out = await checkouts.setPinned(m[1], body.pinned);
      audit(req, 'checkout.pin', { id: m[1], pinned: body.pinned });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/checkouts\/(ck-[\w-]{1,32})\/check$/, async ({ req, res, m }) => {
      const out = await checkouts.checkIntegration(m[1]);
      audit(req, 'checkout.check', { id: m[1], clean: out.integration?.clean ?? null });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/checkouts\/(ck-[\w-]{1,32})\/recreate$/, async ({ req, res, m }) => {
      const out = await checkouts.recreate(m[1]);
      audit(req, 'checkout.recreate', { id: m[1], path: out.path });
      return send(res, 200, out);
    }),
    route('DELETE', /^\/api\/checkouts\/(ck-[\w-]{1,32})$/, async ({ req, res, url, m }) => {
      const body = await readJson(req);
      const force = url.searchParams.get('force') === '1' || body.force === true;
      const out = await checkouts.remove(m[1], force);
      audit(req, 'checkout.remove', { id: m[1], path: out.path, force, reclaimedBytes: out.reclaimedBytes });
      return send(res, 200, out);
    }),
  ];
}
