// A session's repository: its changes, branches and pull request (by window), and the
// worktrees ah made for sessions. Every git call is git.ts's.
import { expandHome } from '../config.ts';
import { changes, listBranches, pullRequest, switchBranch } from '../git.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import type { Core } from '../core.ts';
import { route, type Audit, type Route } from './router.ts';

export type GitRouteDeps = {
  audit: Audit;
  core: Core;
};

export function gitRoutes({ audit, core }: GitRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/worktrees$/, async ({ res }) => send(res, 200, await core.worktrees())),
    route('DELETE', /^\/api\/worktrees$/, async ({ req, res }) => {
      const body = await readJson(req);
      const path = str(body.path, 'path', 1024);
      await core.removeWorktree(path, body.force === true);
      audit(req, 'worktree.remove', { path, forced: body.force === true });
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/worktrees\/remove-bulk$/, async ({ req, res }) => {
      const body = await readJson(req);
      const paths = Array.isArray(body.paths) ? body.paths.slice(0, 200).map((p: unknown) => str(p, 'path', 1024)) : [];
      const force = Array.isArray(body.force) ? body.force.slice(0, 200).map((p: unknown) => str(p, 'path', 1024)) : [];
      if (!paths.length) throw new HttpError(400, 'no worktrees given');
      // The client selection is never trusted: Core and the git layer
      // revalidate in-use, dirty, and managed-root per item at removal time.
      const results = await core.removeWorktreesBulk(paths, force);
      const removed = results.filter((r) => r.ok).map((r) => r.path);
      audit(req, 'worktree.remove-bulk', {
        removed,
        failed: results.length - removed.length,
        forced: force,
        reclaimedBytes: results.reduce((n, r) => n + (r.ok ? r.reclaimedBytes : 0), 0),
      });
      return send(res, 200, { results });
    }),
    route('GET', /^\/api\/windows\/(@\d+)\/changes$/, async ({ res, m }) => {
      const w = (await core.current()).windows.find((w) => w.id === m![1]);
      if (!w) throw new HttpError(404, 'window not found');
      return send(res, 200, await changes(expandHome(w.cwd)));
    }),
    route('GET', /^\/api\/windows\/(@\d+)\/branches$/, async ({ res, m }) => {
      const w = (await core.current()).windows.find((w) => w.id === m![1]);
      if (!w) throw new HttpError(404, 'window not found');
      return send(res, 200, await listBranches(expandHome(w.cwd)));
    }),
    route('POST', /^\/api\/windows\/(@\d+)\/branches$/, async ({ req, res, m }) => {
      const w = (await core.current()).windows.find((w) => w.id === m![1]);
      if (!w) throw new HttpError(404, 'window not found');
      const branch = str((await readJson(req)).branch, 'branch', 200).trim();
      if (!branch) throw new HttpError(400, 'branch required');
      const out = await switchBranch(expandHome(w.cwd), branch);
      audit(req, 'session.branch', { window: m[1], branch: out.branch });
      core.tick().catch(() => {});
      return send(res, 200, out);
    }),
    route('GET', /^\/api\/windows\/(@\d+)\/pull$/, async ({ res, url, m }) => {
      const w = (await core.current()).windows.find((w) => w.id === m![1]);
      if (!w) throw new HttpError(404, 'window not found');
      const pr = await pullRequest(expandHome(w.cwd));
      return send(res, 200, { number: pr?.number ?? null, url: pr?.url ?? null });
    }),
  ];
}
