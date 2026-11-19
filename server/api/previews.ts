// A session's dev server shown in ah (preview.ts): which ports it listens on, and
// publishing one behind ah's own sign-in.
import { HttpError, readJson, send } from '../http.ts';
import { listeningPorts } from '../procs.ts';
import type { Core } from '../core.ts';
import type { Previews } from '../preview.ts';
import { route, type Audit, type Route } from './router.ts';

export type PreviewsRouteDeps = {
  audit: Audit;
  core: Core;
  previews: Previews;
  /** ah's own port and its preview range: never offered as a session's dev server. */
  isPreviewPort: (port: number) => boolean;
};

export function previewsRoutes({ audit, core, previews, isPreviewPort }: PreviewsRouteDeps): Route[] {
  return [
    // Browser preview: one per session, of a port its dev server listens on.
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/preview$/, async ({ res, m }) => {
      const pids = await core.sessionPids(m[1]);
      const ports = pids ? (await listeningPorts(pids)).filter((p) => !isPreviewPort(p)) : [];
      return send(res, 200, { preview: previews.get(m[1]), ports, live: !!pids });
    }),
    route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/preview$/, async ({ req, res, m }) => {
      const target = (await readJson(req)).target;
      if (!Number.isInteger(target) || (target as number) < 1 || (target as number) > 65535 || isPreviewPort(target as number)) throw new HttpError(400, 'invalid port');
      if (!(await core.sessionPids(m[1]))) throw new HttpError(404, 'session not running');
      const preview = await previews.start(m[1], target as number);
      core.registry.setMeta(m[1], 'ah.preview', { target });
      audit(req, 'preview.start', { uid: m[1], target, port: preview.port });
      return send(res, 200, { preview });
    }),
    route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/preview$/, async ({ req, res, m }) => {
      await previews.stop(m[1]);
      core.registry.setMeta(m[1], 'ah.preview', undefined);
      audit(req, 'preview.stop', { uid: m[1] });
      return send(res, 200, { ok: true });
    }),
  ];
}
