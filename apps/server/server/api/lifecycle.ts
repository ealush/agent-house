// Sessions coming and going: starting one (in a new project or worktree), resuming,
// forking, ordering, pinning and forgetting. Launch rules are launch.ts's and core.ts's.
import * as t from '../tmux.ts';
import { withCatalog } from '../catalog.ts';
import { expandHome } from '../config.ts';
import { defaultName, resolveDir } from '../core.ts';
import { dirStatus, makeDir } from '../files.ts';
import { initRepo } from '../git.ts';
import { repoIdentity } from '../checkouts/git.ts';
import type { CheckoutsService } from '../checkouts/service.ts';
import { actorUid, HttpError, MESSAGE_BODY, MESSAGE_MAX, readJson, send, str } from '../http.ts';
import { buildLaunch, resolvePermissionMode } from '../launch.ts';
import { canonicalProjectDir, projectOf, shortPath } from '../sessions.ts';
import { resolveSpawnSupervision } from '../supervision.ts';
import { spaceName } from '../spaces/model.ts';
import type { AttachedTerminals } from '../attachedTerminal.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import type { SpacesService } from '../spaces/service.ts';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { route, type Audit, type Route } from './router.ts';

/** `hidden`: removed Spaces' folders (server/spaces), short paths. */
export async function projectSuggestions(config: Config, windowPaths: string[], hidden: Set<string> = new Set()): Promise<string[]> {
  // A window can outlive its folder (deleted under the shell): nothing to start a session in.
  // Never offer ephemeral cache dirs or managed worktree folders.
  const out = new Set<string>(
    windowPaths
      .map(canonicalProjectDir)
      .filter((p) => !p.includes('/.cache/') && existsSync(expandHome(p))),
  );
  // The Spaces folder is a project root: each plain Space is a folder in it.
  for (const root of [...config.projectRoots, ...(config.spaces ? [config.spaces.root] : [])]) {
    const dir = expandHome(root);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) out.add(shortPath(join(dir, e.name)));
    }
  }
  out.add('~');
  return [...out].filter((p) => !hidden.has(p));
}

export type LifecycleRouteDeps = {
  audit: Audit;
  checkouts: CheckoutsService;
  config: Config;
  core: Core;
  spaces: SpacesService;
  terminals: AttachedTerminals;
  /** Auto-subscribes a newly started Chief of Staff to Space worker events (waiting / finished). */
  subscribeChief?: (o: { uid: string; space: string | null }) => Promise<void>;
};

export function lifecycleRoutes({ audit, checkouts, config, core, spaces, terminals, subscribeChief }: LifecycleRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/projects$/, async ({ res }) => {
      const state = await core.current();
      return send(res, 200, await projectSuggestions(config, [...new Set(state.windows.map((w) => w.projectPath))], spaces.hiddenPaths()));
    }),
    // The new-session form asks before it offers to create a folder.
    route('GET', /^\/api\/dir$/, async ({ res, url }) => {
      const path = (url.searchParams.get('path') ?? '').trim().slice(0, 1024) || '~';
      const state = await dirStatus(path);
      const repo = state === 'dir' ? await repoIdentity(expandHome(path)) : null;
      return send(res, 200, {
        state,
        root: shortPath(expandHome(config.projectRoots[0] ?? '~')),
        git: repo?.isGit ?? false,
        hasHead: repo?.hasHead ?? false,
      });
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
      const actor = actorUid(req);
      if (actor) {
        const resolvedMode = resolvePermissionMode(preset, mode);
        if (resolvedMode?.dangerous) {
          throw new HttpError(403, 'only the human user may launch a session in a dangerous/bypass permission mode', 'upward_control_denied');
        }
        if (
          extraArgs &&
          /dangerously-skip-permissions|dangerously-bypass-approvals|bypassPermissions|--yolo\b|(?:^|\s)-y(?:\s|$)|--approval-mode(?:=|\s+)yolo|--full-auto\b|--sandbox(?:=|\s+)danger-full-access/i.test(
            extraArgs,
          )
        ) {
          throw new HttpError(403, 'only the human user may pass permission-bypass flags in extraArgs', 'upward_control_denied');
        }
        const actorSup = core.supervisionGraph().get(actor);
        if (body.trust === true && actorSup?.managedBy && actorSup.role !== 'chief') {
          throw new HttpError(403, 'supervised worker sessions cannot auto-accept folder trust prompts', 'upward_control_denied');
        }
      }
      const resumingInPlace = !!(body.resume && preset.resume);
      // Automatic isolation & atomic exclusive writer ownership (docs/spec/18-checkouts.md).
      const uid = core.registry.freshId();
      const explicitSpace =
        typeof body.space === 'string' && body.space.trim()
          ? spaceName(body.space.trim())
          : undefined;
      if (explicitSpace && !(await spaces.has(explicitSpace))) throw new HttpError(404, `no Space called ${explicitSpace} on this host`, 'space_not_found');
      const requestedSup = body.supervision && typeof body.supervision === 'object' && !Array.isArray(body.supervision)
        ? (body.supervision as Record<string, unknown>)
        : null;
      // '' puts it in no Space, even when its project is attached to one.
      const noSpace = body.space === '';
      const effectiveTargetSpace = noSpace ? null : (explicitSpace ?? core.spaceOfDir(cwd));
      const supervision = resolveSpawnSupervision({
        actorUid: actorUid(req),
        targetUid: uid,
        requested: requestedSup,
        graph: core.supervisionGraph(),
        targetSpace: effectiveTargetSpace,
      });
      const assignedSpace = explicitSpace ?? (supervision?.space && supervision.space !== effectiveTargetSpace ? supervision.space : undefined);
      const explicitWorktree = typeof body.worktree === 'boolean' ? body.worktree : undefined;
      const acquired = await checkouts.acquireForLaunch({
        uid,
        preset,
        cwd,
        name,
        creatingDir: created,
        resumingInPlace,
        explicitWorktree,
      });
      // Prepare Space context snapshot, canonical AH_SPACE* env vars, and harness-native CLI flags
      // (e.g. `--add-dir <contextDir>` / `--append-system-prompt` / `--rules`) before launching.
      const spaceLookup = assignedSpace ?? effectiveTargetSpace;
      const preparedSpace = spaceLookup
        ? await spaces.prepareSessionContext(spaceLookup, acquired.cwd, { explicit: true }).catch(() => null)
        : null;
      const spaceContextEnv: Record<string, string> = preparedSpace
        ? { ...preparedSpace.env }
        : assignedSpace
          ? { AH_SPACE: assignedSpace }
          : {};
      const launchPointer = core.composeLaunchPointer({
        spacePointer: preparedSpace?.shouldInjectPrompt ? preparedSpace.pointer : null,
        supervision,
        spaceName: spaceLookup,
        hasMcp: !!preset.mcp,
      });
      const launchMcp = core.mcpLaunchOptions(preset);
      const plan = buildLaunch(preset, {
        mode,
        model,
        effort,
        extraArgs,
        resume: resumingInPlace ? true : undefined,
        ...(preparedSpace?.shouldAddDir || launchPointer
          ? {
              spaceContext: {
                ...(preparedSpace?.shouldAddDir ? { addDir: preparedSpace.contextDir } : {}),
                ...(launchPointer ? { pointer: launchPointer } : {}),
              },
            }
          : {}),
        ...(launchMcp ? { mcp: launchMcp } : {}),
      });
      const command = plan.command;
      const launchMeta = { ...plan.meta };
      const order = core.nextOrder();
      let out: { uid: string; windowId: string };
      try {
        out = await core.launch({
          uid,
          preset,
          cwd: acquired.cwd,
          session,
          name,
          command,
          // "Continue latest" opens a conversation the agent already has: no new one named.
          ...(resumingInPlace ? { resuming: true } : {}),
          env: { ...acquired.env, ...spaceContextEnv },
          // "Skip startup confirmations": ah accepts the agent's folder-trust prompt.
          meta: {
            ...launchMeta,
            ...(acquired.worktree ? { 'ah.worktree': acquired.worktree } : {}),
            ...(acquired.checkoutId ? { 'ah.checkoutId': acquired.checkoutId } : {}),
            ...(body.trust === true && preset.trust ? { 'ah.launch.trust': true } : {}),
            ...(supervision ? { 'ah.supervision': supervision } : {}),
            ...(assignedSpace ? { 'ah.space': assignedSpace } : noSpace ? { 'ah.space': '' } : {}),
            'ah.order': order,
          },
        });
      } catch (err) {
        await acquired.rollback();
        throw err;
      }
      audit(req, 'session.create', { window: out.windowId, uid: out.uid, preset: preset.id, cwd: acquired.cwd, branch: acquired.worktree?.branch, checkoutId: acquired.checkoutId, ...(body.trust === true && preset.trust ? { trust: true } : {}) });
      if (supervision?.role === 'chief' && body.autoSubscribe !== false && subscribeChief) {
        await subscribeChief({ uid: out.uid, space: supervision.space ?? assignedSpace ?? null }).catch((err) =>
          console.warn(`chief auto-subscribe (${out.uid}):`, err),
        );
      }
      await core.refreshTmuxPath();
      return send(res, 201, {
        id: out.windowId,
        uid: out.uid,
        ...(acquired.checkoutId ? { checkoutId: acquired.checkoutId } : {}),
        ...(acquired.worktree ? { worktree: acquired.worktree.path, branch: acquired.worktree.branch } : {}),
      });
    }),
    // Sessions are addressed by registry id, or `harness:harnessId` for discovered history.
    route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/resume$/, async ({ req, res, m }) => {
      core.assertControl(actorUid(req), m[1], 'resume');
      const out = await core.resume(m[1]);
      if (out.resumed) audit(req, 'session.resume', { ref: m[1], window: out.windowId });
      return send(res, out.resumed ? 201 : 200, { id: out.windowId, uid: out.uid, resumed: out.resumed });
    }),
    // Fork (F36): what the dialog needs, then the fork itself.
    route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/fork-info$/, async ({ res, m }) => {
      return send(res, 200, await core.forkInfo(m[1]));
    }),
    route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/fork$/, async ({ req, res, m }) => {
      const actor = actorUid(req);
      core.assertControl(actor, m[1], 'fork');
      const body = await readJson(req, MESSAGE_BODY);
      const opt = (k: string, max: number) => (body[k] === undefined ? undefined : str(body[k], k, max).trim() || undefined);
      const mode = opt('mode', 40);
      if (actor && mode) {
        const info = await core.forkInfo(m[1]).catch(() => null);
        const preset = info?.harness ? config.presets.find((p) => p.id === info.harness) : undefined;
        if (preset && resolvePermissionMode(preset, mode)?.dangerous) {
          throw new HttpError(403, 'only the human user may fork a session into a dangerous/bypass permission mode', 'upward_control_denied');
        }
      }
      const out = await core.fork(m[1], {
        name: opt('name', 80),
        prompt: opt('prompt', MESSAGE_MAX),
        model: opt('model', 80),
        effort: opt('effort', 20),
        mode,
      });
      audit(req, 'session.fork', { ref: m[1], uid: out.uid, window: out.id, branch: out.branch });
      return send(res, 201, out);
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/pin$/, async ({ req, res, m }) => {
      core.assertControl(actorUid(req), m[1], 'pin');
      core.setPinned(m[1], (await readJson(req)).pinned !== false);
      return send(res, 200, { ok: true });
    }),
    // Supervision role, owner, alert muting & tags (server/supervision.ts).
    route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/supervision$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const supervision = core.setSupervision(m[1], body, actorUid(req));
      audit(req, 'session.supervision', { uid: m[1], role: supervision?.role ?? null, managedBy: supervision?.managedBy ?? null, muteAlerts: supervision?.muteAlerts ?? null });
      return send(res, 200, { uid: m[1], supervision });
    }),
    // Which Space a session is in (docs/spec/17-spaces.md): a Space's name; '' none; null its project's.
    route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/space$/, async ({ req, res, m }) => {
      const body = await readJson(req);
      const raw = body.space;
      const next = raw === null || raw === undefined ? null : raw === '' ? '' : str(raw, 'space', 64);
      const space = await core.setSessionSpace(m[1], next, actorUid(req));
      audit(req, 'session.space', { uid: m[1], space });
      return send(res, 200, { uid: m[1], space });
    }),
    // Manual sidebar order (F43): sparse key, persisted in the registry, synced to every device over SSE.
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/order$/, async ({ req, res, m }) => {
      core.assertControl(actorUid(req), m[1], 'order');
      const body = await readJson(req);
      const order = Number(body.order);
      if (!Number.isFinite(order)) throw new HttpError(400, 'invalid order');
      await core.setOrder(m[1], order);
      return send(res, 200, { ok: true });
    }),
    route('DELETE', /^\/api\/sessions\/([\w:.-]{1,80})$/, async ({ req, res, m }) => {
      core.assertControl(actorUid(req), m[1], 'forget');
      await core.forget(m[1]);
      await terminals.close(m[1]);
      audit(req, 'session.forget', { ref: m[1] });
      return send(res, 200, { ok: true });
    }),
  ];
}
