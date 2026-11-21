// The environment every new session starts with (Settings → Environment). Values are
// secrets: listed by name and fingerprint only; env.ts stores them.
import { list } from '../files.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import type { Core } from '../core.ts';
import type { EnvStore } from '../env.ts';
import { route, type Audit, type Route } from './router.ts';

export type EnvRouteDeps = {
  audit: Audit;
  core: Core;
  envStore: EnvStore;
};

export function envRoutes({ audit, core, envStore }: EnvRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/env$/, async ({ res }) => {
      const [list, env] = await Promise.all([envStore.list(), envStore.forLaunch()]);
      return send(res, 200, { ...list, stale: await core.envStale(env) });
    }),
    route('POST', /^\/api\/env$/, async ({ req, res }) => {
      const body = await readJson(req);
      if (typeof body.secret !== 'boolean') throw new HttpError(400, 'invalid secret');
      const out = await envStore.put({
        name: str(body.name, 'name', 128),
        ...(body.value === undefined ? {} : { value: str(body.value, 'value', 8192) }),
        secret: body.secret,
      });
      // Names only: values (secret or not) stay out of the activity log.
      audit(req, 'env.save', { name: out.name });
      return send(res, 200, out);
    }),
    route('DELETE', /^\/api\/env\/([A-Za-z_][A-Za-z0-9_]{0,127})$/, async ({ req, res, m }) => {
      await envStore.remove(m[1]);
      audit(req, 'env.remove', { name: m[1] });
      return send(res, 200, { ok: true });
    }),
  ];
}
