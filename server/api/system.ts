// Host-level actions behind Settings → System: agent hooks, the desktop entry, the agents
// ah offers (harnesses), restarting and rebuilding ah, clearing uploads.
import { screenAudit } from '../audit.ts';
import { desktopStatus, installDesktop, removeDesktop } from '../desktop.ts';
import { clearUploadDir } from '../files.ts';
import { hooksStatus, installClaude, installCodex, uninstallClaude, uninstallCodex } from '../hooks.ts';
import { HttpError, readJson, send } from '../http.ts';
import { omarchyTheme } from '../omarchy.ts';
import { rebuildFailure, rebuildWeb } from '../rebuild.ts';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
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
  config: Config;
  core: Core;
  harnesses: Harnesses;
  /** The checkout ah runs from, and the page build it serves. */
  root: string;
  dist: string;
  uploadDir: string;
};

export function systemRoutes({ audit, config, core, harnesses, root, dist, uploadDir }: SystemRouteDeps): Route[] {
/** One rebuild at a time. A second click while a build is running is refused. */
  let rebuilding = false;
  return [
    route('GET', /^\/api\/system\/hooks$/, ({ res }) => send(res, 200, { ...hooksStatus(), audit: screenAudit.summary() })),
    route('DELETE', /^\/api\/system\/screen-audit$/, ({ res }) => {
      screenAudit.reset();
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
      // `systemctl --user restart ah` stops (SIGTERM → graceful drain above) and
      // starts us again. Live processes belong to ah-tmux.service and never
      // notice; ended records keep their resume data in SQLite.
      send(res, 200, { ok: true });
      scheduleRestart();
      return;
    }),
    route('POST', /^\/api\/system\/rebuild$/, async ({ req, res }) => {
      if (rebuilding) throw new HttpError(409, 'a rebuild is already running');
      audit(req, 'system.rebuild');
      rebuilding = true;
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
        // Sent here so the build log reaches the page. A thrown 500 is replaced with "internal error".
        return send(res, 500, { error: msg });
      } finally {
        rebuilding = false;
      }
      send(res, 200, { ok: true });
      if (!override) {
        console.log('rebuild finished; restarting');
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
  ];
}
