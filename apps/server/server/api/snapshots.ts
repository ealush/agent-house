// Turn snapshots (F39): the working tree as it was before each turn, and restoring one.
import { actorUid, readJson, send } from '../http.ts';
import type { Core } from '../core.ts';
import { route, type Audit, type Route } from './router.ts';

export type SnapshotsRouteDeps = {
  audit: Audit;
  core: Core;
};

export function snapshotsRoutes({ audit, core }: SnapshotsRouteDeps): Route[] {
  return [
    // Per-turn snapshots (F39): list, restore (with safety snapshot), toggle.
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/snapshots$/, async ({ res, m }) => {
      return send(res, 200, await core.listSnapshots(m[1]));
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/snapshots\/(\d{1,9})\/restore$/, async ({ req, res, m }) => {
      core.assertControl(actorUid(req), m[1], 'snapshot');
      const body = await readJson(req);
      const out = await core.restoreSnapshot(m[1], Number(m[2]), { interrupt: body.interrupt === true });
      audit(req, 'snapshot.restore', { uid: m[1], turn: Number(m[2]), safetyId: out.safety.id, safetyTurn: out.safety.turn });
      return send(res, 200, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/snapshots\/toggle$/, async ({ req, res, m }) => {
      core.assertControl(actorUid(req), m[1], 'snapshot');
      const body = await readJson(req);
      core.setSnapshotsEnabled(m[1], body.enabled !== false);
      audit(req, 'snapshot.toggle', { uid: m[1], enabled: body.enabled !== false });
      return send(res, 200, { ok: true });
    }),
  ];
}
