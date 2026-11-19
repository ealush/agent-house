// Sessions coming and going: starting one (in a new project or worktree), resuming,
// forking, ordering, pinning and forgetting. Launch rules are launch.ts's and core.ts's.
import * as t from '../tmux.ts';
import { withCatalog } from '../catalog.ts';
import { expandHome } from '../config.ts';
import { defaultName, resolveDir } from '../core.ts';
import { dirStatus, makeDir } from '../files.ts';
import { createWorktree, initRepo } from '../git.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import { buildLaunch } from '../launch.ts';
import { shortPath } from '../sessions.ts';
import type { AttachedTerminals } from '../attachedTerminal.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { route, type Audit, type Route } from './router.ts';

async function projectSuggestions(config: Config, windowPaths: string[]): Promise<string[]> {
  const out = new Set<string>(windowPaths);
  for (const root of config.projectRoots) {
    const dir = expandHome(root);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) out.add(shortPath(join(dir, e.name)));
    }
  }
  out.add('~');
  return [...out];
}

export type LifecycleRouteDeps = {
  audit: Audit;
  config: Config;
  core: Core;
  terminals: AttachedTerminals;
};

export function lifecycleRoutes({ audit, config, core, terminals }: LifecycleRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/projects$/, async ({ res }) => {
      const state = await core.current();
      return send(res, 200, await projectSuggestions(config, [...new Set(state.windows.map((w) => w.projectPath))]));
    }),
    // The new-session form asks before it offers to create a folder.
    route('GET', /^\/api\/dir$/, async ({ res, url }) => {
      const path = (url.searchParams.get('path') ?? '').trim().slice(0, 1024) || '~';
      return send(res, 200, { state: await dirStatus(path), root: shortPath(expandHome(config.projectRoots[0] ?? '~')) });
    }),
    route('POST', /^\/api\/windows$/, async ({ req, res }) => {
      const body = await readJson(req);
      const preset = await withCatalog(core.preset(str(body.preset, 'preset', 40)));
      const asked = str(body.cwd ?? '~', 'cwd', 1024).trim() || '~';
      // A new project: one new folder inside an existing one, within the file roots.
      let created = false;
      if (body.create && (await dirStatus(asked)) === 'new') {
        const dir = await makeDir(asked);
        created = true;
        if (body.git) await initRepo(dir);
        audit(req, 'project.create', { path: dir, git: !!body.git });
      }
      const cwd = await resolveDir(asked);
      const session = t.sanitizeSessionName(str(body.session || config.defaultSession, 'session', 64));
      if (!session) throw new HttpError(400, 'invalid session');
      const name = str(body.label ?? '', 'label', 80).trim() || defaultName(preset, cwd);
      // Structured launch options (F42): mode/model ids plus a free-form tail.
      const mode = body.mode === undefined ? undefined : str(body.mode, 'mode', 40);
      const model = body.model === undefined ? undefined : str(body.model, 'model', 80);
      const effort = body.effort === undefined ? undefined : str(body.effort, 'effort', 20);
      const extraArgs = body.extraArgs === undefined ? undefined : str(body.extraArgs, 'extraArgs', 2048);
      let command: string;
      let launchMeta: Record<string, unknown>;
      const plan = buildLaunch(preset, {
        mode,
        model,
        effort,
        extraArgs,
        resume: body.resume && preset.resume ? true : undefined,
      });
      command = plan.command;
      launchMeta = { ...plan.meta };
      // One writing agent per checkout (F29): optionally start in a fresh worktree + branch.
      const wt = body.worktree && !created ? await createWorktree(cwd, name) : null;
      const order = core.nextOrder();
      const out = await core.launch({
        preset,
        cwd: wt?.path ?? cwd,
        session,
        name,
        command,
        // "Skip startup confirmations": ah accepts the agent's folder-trust prompt.
        meta: { ...launchMeta!, ...(wt ? { 'ah.worktree': wt } : {}), ...(body.trust === true && preset.trust ? { 'ah.launch.trust': true } : {}), 'ah.order': order },
      });
      audit(req, 'session.create', { window: out.windowId, uid: out.uid, preset: preset.id, cwd: wt?.path ?? cwd, branch: wt?.branch, ...(body.trust === true && preset.trust ? { trust: true } : {}) });
      await core.refreshTmuxPath();
      return send(res, 201, { id: out.windowId, uid: out.uid });
    }),
    // Sessions are addressed by registry id, or `harness:harnessId` for discovered history.
    route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/resume$/, async ({ req, res, m }) => {
      const out = await core.resume(m[1]);
      if (out.resumed) audit(req, 'session.resume', { ref: m[1], window: out.windowId });
      return send(res, out.resumed ? 201 : 200, { id: out.windowId, uid: out.uid, resumed: out.resumed });
    }),
    // Fork (F36): what the dialog needs, then the fork itself.
    route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/fork-info$/, async ({ res, m }) => {
      return send(res, 200, await core.forkInfo(m[1]));
    }),
    route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/fork$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const opt = (k: string, max: number) => (body[k] === undefined ? undefined : str(body[k], k, max).trim() || undefined);
      const out = await core.fork(m[1], {
        name: opt('name', 80),
        prompt: opt('prompt', 32 * 1024),
        model: opt('model', 80),
        effort: opt('effort', 20),
        mode: opt('mode', 40),
      });
      audit(req, 'session.fork', { ref: m[1], uid: out.uid, window: out.id, branch: out.branch });
      return send(res, 201, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/pin$/, async ({ req, res, m }) => {
      core.setPinned(m[1], (await readJson(req)).pinned !== false);
      return send(res, 200, { ok: true });
    }),
    // Manual sidebar order (F43): sparse key, persisted in the registry, synced to every device over SSE.
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/order$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const order = Number(body.order);
      if (!Number.isFinite(order)) throw new HttpError(400, 'invalid order');
      await core.setOrder(m[1], order);
      return send(res, 200, { ok: true });
    }),
    route('DELETE', /^\/api\/sessions\/([\w:.-]{1,80})$/, async ({ req, res, m }) => {
      await core.forget(m[1]);
      await terminals.close(m[1]);
      audit(req, 'session.forget', { ref: m[1] });
      return send(res, 200, { ok: true });
    }),
  ];
}
