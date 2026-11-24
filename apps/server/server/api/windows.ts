// A tmux window by its id (`@3`): its screen as text, its name, ending it. Sessions reach
// these through their uid (`/api/sessions/:uid/capture|name|terminate`, rewritten in
// main.ts to the window the session has now).
import type { Core } from '../core.ts';
import type { AttachedTerminals } from '../attachedTerminal.ts';
import { actorUid, HttpError, readJson, send, str } from '../http.ts';
import * as t from '../tmux.ts';
import { route, type Audit, type Route } from './router.ts';

export type WindowsRouteDeps = {
  audit: Audit;
  core: Core;
  terminals: AttachedTerminals;
};

async function existing(id: string): Promise<string> {
  if (!(await t.windowExists(id))) throw new HttpError(404, 'window not found');
  return id;
}

export function windowsRoutes({ audit, core, terminals }: WindowsRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/windows\/(@\d+)\/capture$/, async ({ res, url, m }) => {
      const id = await existing(m[1]);
      const screenOnly = url.searchParams.get('screen') === '1';
      const lines = screenOnly ? 0 : Math.min(10000, Math.max(1, Number(url.searchParams.get('lines')) || 2000));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await t.capturePane(id, lines));
    }),
    route('PATCH', /^\/api\/windows\/(@\d+)$/, async ({ req, res, m }) => {
      const id = await existing(m[1]);
      const target = (await core.current()).windows.find((w) => w.id === id);
      if (target) core.assertControl(actorUid(req), target.uid, 'rename');
      const name = str((await readJson(req)).name, 'name', 80).trim();
      if (!name) throw new HttpError(400, 'name required');
      await t.renameWindow(id, name);
      audit(req, 'session.rename', { window: id });
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }),
    route('DELETE', /^\/api\/windows\/(@\d+)$/, async ({ req, res, m }) => {
      const id = await existing(m[1]);
      // You ended it: recovery (server/recovery) must not take this for a crash.
      const ending = (await core.current()).windows.find((w) => w.id === id);
      if (ending) core.assertControl(actorUid(req), ending.uid, 'terminate');
      if (ending) core.registry.setMeta(ending.uid, 'ah.endedBy', 'you');
      if (ending) await terminals.close(ending.uid);
      await t.killWindow(id);
      audit(req, 'session.kill', { window: id });
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }),
  ];
}
