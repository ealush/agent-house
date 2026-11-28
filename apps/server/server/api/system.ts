// Host-level actions behind Settings → System: agent hooks, the desktop entry, the agents
// ah offers (harnesses), restarting, rebuilding and updating ah, clearing uploads, the developer log.
import { screenAudit } from '../audit.ts';
import { BUNDLE_ENTRIES, clientInfo, devlog } from '../devlog.ts';
import { desktopStatus, installDesktop, removeDesktop } from '../desktop.ts';
import { clearUploadDir } from '../files.ts';
import { hooksStatus, installClaude, installCodex, uninstallClaude, uninstallCodex } from '../hooks.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import { omarchyTheme } from '../omarchy.ts';
import { rebuildFailure, rebuildWeb } from '../rebuild.ts';
import { applyUpdate, buildWorkspace, checkUpdate, hostVersion, parseRequires, repoRoot, UpdateError } from '../update.ts';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Auth } from '../auth.ts';
import type { Config } from '../config.ts';
import { API_VERSION, type Core } from '../core.ts';
import type { Harnesses } from '../harnesses.ts';
import { route, type Audit, type Route } from './router.ts';

/**
 * What "restart the server" runs. AH_RESTART_CMD overrides the unit restart,
 * so tests can stub the side effect (e.g. `touch flagfile`) instead of
 * bouncing a real systemd unit.
 */
function restartCommand(): string[] {
  const override = process.env.AH_RESTART_CMD?.trim();
  if (override) return ['/bin/sh', '-c', override];
  return ['systemctl', '--user', 'restart', 'ah'];
}

// Answer first, then bounce. The restart stops this process; systemd brings it back.
function scheduleRestart() {
  setTimeout(() => {
    const [cmd, ...args] = restartCommand();
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`restart failed: ${err.message}`));
    child.unref();
  }, 100);
}

export type SystemRouteDeps = {
  audit: Audit;
  auth: Auth;
  config: Config;
  core: Core;
  harnesses: Harnesses;
  /** The checkout ah runs from, and the page build it serves. */
  root: string;
  dist: string;
  uploadDir: string;
};

/**
 * The repository an update moves: the one ah runs from. AH_UPDATE_REPO points it at another
 * clone, so tests fast-forward a disposable one, never the checkout running them.
 */
async function updateRepo(root: string): Promise<string> {
  const override = process.env.AH_UPDATE_REPO?.trim();
  if (override) return override;
  try {
    return await repoRoot(root);
  } catch {
    throw new UpdateError(409, "Agent House isn't running from a git checkout, so it can't update itself from GitHub.", 'not_a_checkout');
  }
}

/** The update's build. AH_UPDATE_BUILD_CMD stubs it in tests, as AH_REBUILD_CMD does the rebuild's. */
async function updateBuild(repo: string): Promise<void> {
  const override = process.env.AH_UPDATE_BUILD_CMD?.trim();
  if (override) {
    await promisify(execFile)('/bin/sh', ['-c', override], { cwd: repo, timeout: 30_000, maxBuffer: 1024 * 1024 });
    return;
  }
  await buildWorkspace(repo);
}

export function systemRoutes({ audit, auth, config, core, harnesses, root, dist, uploadDir }: SystemRouteDeps): Route[] {
  /** One build at a time, a rebuild's or an update's. A second click while one runs is refused. */
  let building: 'rebuild' | 'update' | null = null;
  return [
    route('GET', /^\/api\/system\/audit$/, ({ res, url }) => {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const session = url.searchParams.get('session')?.trim() || null;
      const event = url.searchParams.get('event')?.trim() || null;
      let entries = auth.recentAudit(Math.max(limit * 4, 200)) as Array<Record<string, unknown>>;
      if (session) entries = entries.filter((e) => e.uid === session || e.actorUid === session || e.ref === session || e.from === session || e.to === session);
      if (event) entries = entries.filter((e) => typeof e.event === 'string' && (e.event === event || e.event.startsWith(event)));
      return send(res, 200, { entries: entries.slice(0, limit) });
    }),
    route('GET', /^\/api\/system\/hooks$/, ({ res }) => send(res, 200, { ...hooksStatus(), audit: screenAudit.summary() })),
    route('DELETE', /^\/api\/system\/screen-audit$/, ({ req, res }) => {
      screenAudit.reset();
      audit(req, 'system.screen-audit.clear');
      return send(res, 200, { ok: true });
    }),
    // ah in the host's app launcher, in its own window (server/desktop.ts), like the hooks card.
    route('GET', /^\/api\/system\/desktop$/, ({ res }) => send(res, 200, desktopStatus(config.port))),
    route('POST', /^\/api\/system\/desktop$/, async ({ req, res }) => {
      const action = (await readJson(req)).action;
      if (action !== 'install' && action !== 'uninstall') throw new HttpError(400, 'action must be install or uninstall');
      let messages: string[];
      try {
        messages = action === 'install' ? installDesktop(config.port) : removeDesktop();
      } catch (err) {
        throw new HttpError(500, (err as Error).message);
      }
      audit(req, `system.desktop.${action}`);
      return send(res, 200, { messages, status: desktopStatus(config.port) });
    }),
    route('GET', /^\/api\/omarchy\/theme$/, ({ res }) => send(res, 200, omarchyTheme())),
    // Settings → Agents (server/harnesses.ts): what each CLI's installed version offers,
    // which agents New session shows, and agents added by hand.
    route('GET', /^\/api\/harnesses$/, ({ res }) => send(res, 200, core.harnessList())),
    route('POST', /^\/api\/harnesses\/check$/, async ({ req, res }) => {
      audit(req, 'harnesses.check');
      await core.checkHarnesses(true);
      return send(res, 200, core.harnessList());
    }),
    route('POST', /^\/api\/harnesses\/custom$/, async ({ req, res }) => {
      const body = await readJson(req);
      let added;
      try {
        added = harnesses.addCustom(body, config.presets.map((p) => p.id));
      } catch (err) {
        throw new HttpError(400, `An added agent needs ${(err as Error).message}.`);
      }
      audit(req, 'harnesses.add', { id: added.id, command: added.command });
      core.applyHarnesses();
      await core.checkHarnesses();
      return send(res, 200, core.harnessList());
    }),
    route('DELETE', /^\/api\/harnesses\/custom\/([\w-]{1,48})$/, async ({ req, res, m }) => {
      if (!harnesses.removeCustom(m[1])) throw new HttpError(404, 'no such agent');
      audit(req, 'harnesses.remove', { id: m[1] });
      core.applyHarnesses();
      await core.tick();
      return send(res, 200, core.harnessList());
    }),
    route('POST', /^\/api\/harnesses\/([\w-]{1,48})$/, async ({ req, res, m }) => {
      const hidden = (await readJson(req)).hidden;
      if (typeof hidden !== 'boolean') throw new HttpError(400, 'hidden must be true or false');
      if (!config.presets.some((p) => p.id === m![1] && p.command.trim())) throw new HttpError(404, 'no such agent');
      harnesses.setHidden(m[1], hidden);
      audit(req, hidden ? 'harnesses.hide' : 'harnesses.show', { id: m[1] });
      await core.tick();
      return send(res, 200, core.harnessList());
    }),
    route('POST', /^\/api\/system\/hooks$/, async ({ req, res }) => {
      const action = (await readJson(req)).action;
      if (action !== 'install' && action !== 'uninstall') throw new HttpError(400, 'action must be install or uninstall');
      const messages = action === 'install' ? [installClaude(), installCodex()] : [uninstallClaude(), uninstallCodex()];
      audit(req, `system.hooks.${action}`);
      return send(res, 200, { messages, status: hooksStatus() });
    }),
    route('POST', /^\/api\/system\/restart$/, ({ req, res }) => {
      audit(req, 'system.restart');
      devlog.event('restart', { asked: 'Settings' });
      // `systemctl --user restart ah` stops (SIGTERM → graceful drain above) and
      // starts us again. Live processes belong to ah-tmux.service and never
      // notice; ended records keep their resume data in SQLite.
      send(res, 200, { ok: true });
      scheduleRestart();
      return;
    }),
    route('POST', /^\/api\/system\/rebuild$/, async ({ req, res }) => {
      if (building) throw new HttpError(409, `${building === 'rebuild' ? 'a rebuild' : 'an update'} is already running`);
      audit(req, 'system.rebuild');
      devlog.event('rebuild', { phase: 'started' });
      building = 'rebuild';
      // Tests stub the whole side effect. The real path clears dist, builds, answers, then restarts.
      const override = process.env.AH_REBUILD_CMD?.trim();
      try {
        if (override) {
          await promisify(execFile)('/bin/sh', ['-c', override], { timeout: 30_000, maxBuffer: 1024 * 1024 });
        } else {
          console.log('rebuild: clearing dist and building');
          await rebuildWeb(root, dist);
        }
      } catch (err) {
        const msg = rebuildFailure(err);
        console.error(`rebuild failed: ${msg}`);
        devlog.event('rebuild', { phase: 'failed', message: msg.slice(-4000) });
        // Sent here so the build log reaches the page. A thrown 500 is replaced with "internal error".
        return send(res, 500, { error: msg });
      } finally {
        building = null;
      }
      send(res, 200, { ok: true });
      devlog.event('rebuild', { phase: 'built', restarting: !override });
      if (!override) {
        console.log('rebuild finished; restarting');
        scheduleRestart();
      }
      return;
    }),
    // The checkout ah runs from: its commit, branch, and the app releases it contains (server/update.ts).
    route('GET', /^\/api\/system\/version$/, async ({ res }) => send(res, 200, { api: API_VERSION, ...(await hostVersion(await updateRepo(root))) })),
    // Update from GitHub: `check: true` fetches and says what an update would do; otherwise the
    // checkout moves to origin's main (when it serves `requires`), builds, answers, and restarts.
    route('POST', /^\/api\/system\/update$/, async ({ req, res }) => {
      const body = await readJson(req);
      const requires = parseRequires(body.requires);
      const repo = await updateRepo(root);
      if (body.check === true) return send(res, 200, await checkUpdate(repo, requires, API_VERSION));
      if (building) throw new HttpError(409, `${building === 'rebuild' ? 'a rebuild' : 'an update'} is already running`);
      building = 'update';
      audit(req, 'system.update', { requires: Object.keys(requires).length });
      devlog.event('update', { phase: 'started' });
      let result;
      try {
        result = await applyUpdate(repo, requires, API_VERSION, updateBuild);
      } catch (err) {
        if (err instanceof UpdateError) {
          devlog.event('update', { phase: 'refused', code: err.code ?? null });
          throw err;
        }
        const msg = rebuildFailure(err);
        console.error(`update failed: ${msg}`);
        devlog.event('update', { phase: 'failed', message: msg.slice(-4000) });
        // As the rebuild's: sent here so the build's log reaches the client.
        return send(res, 500, { error: msg, code: 'build_failed' });
      } finally {
        building = null;
      }
      const restarting = result.updated;
      devlog.event('update', { phase: result.updated ? 'built' : 'current', from: result.from, to: result.to });
      send(res, 200, { ok: true, ...result, restarting });
      if (restarting) {
        console.log(`update: ${result.from.slice(0, 8)} → ${result.to.slice(0, 8)} built; restarting`);
        scheduleRestart();
      }
      return;
    }),
    route('POST', /^\/api\/system\/uploads\/clear$/, async ({ req, res }) => {
      try {
        const removed = await clearUploadDir(uploadDir);
        audit(req, 'system.uploads.clear', { removed });
        return send(res, 200, { ok: true, removed });
      } catch (err) {
        const msg = (err as Error).message || 'could not clear uploads';
        console.error(`clear uploads failed: ${msg}`);
        return send(res, 500, { error: msg });
      }
    }),
    // The developer log (server/devlog.ts): the host's own, on or off, and devices' bundles.
    route('GET', /^\/api\/system\/logging$/, async ({ res }) => send(res, 200, await devlog.status())),
    route('PUT', /^\/api\/system\/logging$/, async ({ req, res }) => {
      const on = (await readJson(req)).server;
      if (typeof on !== 'boolean') throw new HttpError(400, 'server must be true or false');
      devlog.set(on);
      audit(req, on ? 'system.logging.on' : 'system.logging.off');
      return send(res, 200, await devlog.status());
    }),
    route('POST', /^\/api\/system\/logging\/client$/, async ({ req, res }) => {
      const body = await readJson(req, 16 * 1024 * 1024);
      const entries = body.entries;
      if (!Array.isArray(entries)) throw new HttpError(400, 'entries must be a list');
      if (entries.length > BUNDLE_ENTRIES) throw new HttpError(400, `at most ${BUNDLE_ENTRIES.toLocaleString('en-US')} entries`);
      if (!entries.every((e) => e && typeof e === 'object' && !Array.isArray(e))) throw new HttpError(400, 'each entry must be an object');
      const note = body.note === undefined ? '' : str(body.note, 'note', 2000);
      const client = clientInfo(body.client);
      const file = await devlog.saveClient(client, entries as Record<string, unknown>[], note, String(req.headers['tailscale-user-login'] ?? 'local'));
      audit(req, 'system.logging.bundle', { app: client.app, entries: entries.length });
      return send(res, 201, { file, entries: entries.length });
    }),
  ];
}
