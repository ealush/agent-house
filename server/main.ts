// ah's HTTP/WebSocket front door.
//
// Invariants, in the order a request meets them:
//   1. ah only listens on loopback. Remote access is Tailscale's job (`tailscale serve`).
//   2. Host must be loopback or this node's ts.net name; via Serve, the caller must be
//      the machine owner's Tailscale identity (gate.ts).
//   3. Writes and WebSockets need a same-site Origin and, for writes, the X-AH header.
//   4. Default deny: every route needs a signed-in device or machine token, except the
//      short PUBLIC list below (sign-in itself).
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname, homedir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { loadConfig, expandHome, CONFIG_PATH, type Config } from './config.ts';
import { shortPath } from './sessions.ts';
import { Core, CoreError, resolveDir, defaultName } from './core.ts';
import { buildLaunch, LaunchError } from './launch.ts';
import { withCatalog } from './catalog.ts';
import { addViewer, attach, viewers } from './terminal.ts';
import { desktopStatus, installDesktop, removeDesktop } from './desktop.ts';
import { Drafts } from './drafts.ts';
import { feedPage, streamFeed, SNAPSHOT } from './feed/stream.ts';
import { Previews, removeStaleMappings, tailscalePublish } from './preview.ts';
import { listeningPorts } from './procs.ts';
import * as t from './tmux.ts';
import { createWorktree, initRepo, changes, listBranches, switchBranch, pullRequest, GitError } from './git.ts';
import { SideChatStore, SideChatError, changeContext } from './sidechat.ts';
import { ensureMigrated, getDb } from './db.ts';
import { importLegacyJson } from './migrate.ts';
import { FsError, dirStatus, list, makeDir, receive, sendFile, setRoots, roots, clearUploadDir } from './files.ts';
import { Peers, proxyHttp, proxyWs, peerUrlAllowed } from './peers.ts';
import { SearchIndexer, combineResponses, type SearchParams } from './search.ts';
import { Auth, AuthError, clearCookies, type Caller } from './auth.ts';
import { Gate, LOOPBACK_BIND } from './gate.ts';
import { HttpError, send, readBody, readJson, str, safeDecode } from './http.ts';
import { rebuildFailure, rebuildWeb } from './rebuild.ts';
import { slashCommands, projectFiles } from './complete.ts';
import { omarchyTheme } from './omarchy.ts';
import { screenAudit } from './audit.ts';
import { hooksStatus, installClaude, installCodex, uninstallClaude, uninstallCodex } from './hooks.ts';

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(flag('port') ?? process.env.AH_PORT ?? config.port);
const HOST = String(flag('host') ?? process.env.AH_HOST ?? config.host);
// AH_DIST: serve another build of the page (the browser tests build their own, never touching dist/).
const DIST = process.env.AH_DIST ? resolve(process.env.AH_DIST) : fileURLToPath(new URL('../dist', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Invariant 1. No flag turns this off: exposure belongs to Tailscale, not to ah.
if (!LOOPBACK_BIND.has(HOST)) {
  console.error(`Refusing to listen on ${HOST}: ah only listens on loopback (127.0.0.1 or ::1).`);
  console.error('Reach it from other devices with `tailscale serve` — run `node bin/ah.js setup tailscale` once.');
  process.exit(1);
}

let auth: Auth;
try {
  auth = new Auth(config.auth);
} catch (err) {
  // Fail closed: never start without the sign-in data we're supposed to enforce.
  console.error(`Can't read ah's auth state: ${(err as Error).message}`);
  process.exit(1);
}
const core = new Core(config, viewers);
const drafts = new Drafts();
const sidechat = new SideChatStore();
const search = new SearchIndexer(getDb(), () => core.searchSources());
const gate = new Gate();

// Browser previews (server/preview.ts): a session's dev server behind ah's own
// sign-in, each on a port of its own. Tests and setups without Tailscale skip
// publishing (AH_PREVIEW_PUBLISH=0); the loopback port still works locally.
const ahPort = () => (server?.address() as AddressInfo | null)?.port ?? PORT;
const previews = new Previews({
  authorize: (req) => {
    const verdict = gate.check(req);
    if (!verdict.ok) return { status: verdict.status, reason: verdict.reason };
    return auth.identify(req) ? null : { status: 401, reason: 'sign in required' };
  },
  frameAncestors: () => [...(gate.tailnet ? [`https://${gate.tailnet.dnsName}`] : []), `http://localhost:${ahPort()}`, `http://127.0.0.1:${ahPort()}`],
  publish: process.env.AH_PREVIEW_PUBLISH === '0' ? null : { add: (p) => (gate.tailnet ? tailscalePublish.add(p) : Promise.reject(new Error('no tailnet'))), remove: tailscalePublish.remove },
  range: config.preview.ports,
});
const isPreviewPort = (p: number) => p === ahPort() || (p >= config.preview.ports[0] && p <= config.preview.ports[1]);

/** Keeps previews in step with sessions: back after a restart or a resume, gone with the session. */
async function syncPreviews() {
  const running = new Set(previews.list().map((p) => p.uid));
  for (const rec of core.registry.all()) {
    const want = (rec.meta['ah.preview'] as { target?: number } | undefined)?.target;
    const live = running.has(rec.id) || want ? await core.sessionPids(rec.id) : null;
    if (want && live && !running.has(rec.id)) await previews.start(rec.id, want).catch((err) => console.warn(`preview for ${rec.id}: ${(err as Error).message}`));
    if (running.has(rec.id) && !live) await previews.stop(rec.id);
  }
}
const peers = new Peers(config.peers, PORT);
core.peers = peers;
setRoots(config.files.roots.map(expandHome));

const UPLOAD_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ah', 'uploads');
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const FS_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;

/** Routes reachable without signing in: only what's needed to sign in. Everything else is denied. */
export const PUBLIC_ROUTES = new Set([
  'GET /api/hello',
  'GET /api/auth/status',
  'POST /api/auth/register/options', // needs a host-issued setup code (or a session) inside
  'POST /api/auth/register/verify',
  'POST /api/auth/login/options',
  'POST /api/auth/login/verify',
  'POST /api/auth/password/login',
  'POST /api/auth/logout',
]);

function audit(req: IncomingMessage, event: string, detail: Record<string, unknown> = {}) {
  auth.audit(event, { ...detail, from: String(req.headers['tailscale-user-login'] ?? 'local') });
}

async function projectSuggestions(windowPaths: string[]): Promise<string[]> {
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

/** Query params for /api/search and /api/search/all. Values are only ever bound parameters downstream. */
function searchParams(url: URL): SearchParams {
  const scope = url.searchParams.get('in');
  const num = (k: string) => {
    const n = Number(url.searchParams.get(k));
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  return {
    q: (url.searchParams.get('q') ?? '').slice(0, 500),
    scope: scope === 'transcripts' || scope === 'chats' ? scope : 'all',
    role: url.searchParams.get('role') ?? undefined,
    project: url.searchParams.get('p') ?? undefined,
    host: url.searchParams.get('h') ?? undefined,
    model: url.searchParams.get('m') ?? undefined,
    limit: num('limit'),
    offset: num('offset'),
    from: num('from'),
    to: num('to'),
    order: url.searchParams.get('sort') === 'recent' ? 'recent' : undefined,
  };
}

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

/** One rebuild at a time. A second click while a build is running is refused. */
let rebuilding = false;

// Answer first, then bounce. The restart stops this process; systemd brings it back.
function scheduleRestart() {
  setTimeout(() => {
    const [cmd, ...args] = restartCommand();
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`restart failed: ${err.message}`));
    child.unref();
  }, 100);
}

// ---------- API (reached only after the gate in handle())

async function api(req: IncomingMessage, res: ServerResponse, url: URL, path: string, caller: Caller | null) {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: RegExp) => (method === verb ? path.match(re) : null);
  let m: RegExpMatchArray | null;

  if (route('GET', /^\/api\/hello$/)) return send(res, 200, { ah: true, hostname: hostname(), auth: auth.enabled });
  if (path.startsWith('/api/auth/')) return authApi(req, res, path, method, caller);
  if (!caller) throw new HttpError(401, 'sign in required'); // belt and braces; handle() already denied

  if (route('GET', /^\/api\/state$/)) return send(res, 200, await core.current());

  if (route('GET', /^\/api\/events$/)) {
    // Server-sent state pushes: one stream per client instead of polling.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    // The whole state first, then patches (only the fields that changed; web/api.ts merges them).
    let sent = false;
    const unsubscribe = core.subscribe((json, patch) => {
      if (sent && patch) res.write(`event: patch\ndata: ${patch}\n\n`);
      else res.write(`event: state\ndata: ${json}\n\n`);
      sent = true;
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const untrack = auth.track(caller, { close: () => res.end() });
    req.on('close', () => {
      clearInterval(ping);
      unsubscribe();
      untrack();
    });
    return;
  }

  if (route('GET', /^\/api\/projects$/)) {
    const state = await core.current();
    return send(res, 200, await projectSuggestions([...new Set(state.windows.map((w) => w.projectPath))]));
  }

  // The new-session form asks before it offers to create a folder.
  if (route('GET', /^\/api\/dir$/)) {
    const path = (url.searchParams.get('path') ?? '').trim().slice(0, 1024) || '~';
    return send(res, 200, { state: await dirStatus(path), root: shortPath(expandHome(config.projectRoots[0] ?? '~')) });
  }

  if (route('POST', /^\/api\/windows$/)) {
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
    try {
      const plan = buildLaunch(preset, {
        mode,
        model,
        effort,
        extraArgs,
        resume: body.resume && preset.resume ? true : undefined,
      });
      command = plan.command;
      launchMeta = { ...plan.meta };
    } catch (err) {
      if (err instanceof LaunchError) throw new HttpError(400, err.message);
      throw err;
    }
    // One writing agent per checkout (F29): optionally start in a fresh worktree + branch.
    const wt = body.worktree && !created ? await createWorktree(cwd, name) : null;
    const order = core.nextOrder();
    const out = await core.launch({
      preset,
      cwd: wt?.path ?? cwd,
      session,
      name,
      command,
      meta: { ...launchMeta!, ...(wt ? { 'ah.worktree': wt } : {}), 'ah.order': order },
    });
    audit(req, 'session.create', { window: out.windowId, uid: out.uid, preset: preset.id, cwd: wt?.path ?? cwd, branch: wt?.branch });
    await core.refreshTmuxPath();
    return send(res, 201, { id: out.windowId, uid: out.uid });
  }

  // Sessions are addressed by registry id, or `harness:harnessId` for discovered history.
  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/resume$/))) {
    const out = await core.resume(m[1]);
    if (out.resumed) audit(req, 'session.resume', { ref: m[1], window: out.windowId });
    return send(res, out.resumed ? 201 : 200, { id: out.windowId, uid: out.uid, resumed: out.resumed });
  }

  // Fork (F36): what the dialog needs, then the fork itself.
  if ((m = route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/fork-info$/))) {
    try {
      return send(res, 200, await core.forkInfo(m[1]));
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/fork$/))) {
    const body = await readJson(req);
    const opt = (k: string, max: number) => (body[k] === undefined ? undefined : str(body[k], k, max).trim() || undefined);
    try {
      const out = await core.fork(m[1], {
        name: opt('name', 80),
        prompt: opt('prompt', 32 * 1024),
        model: opt('model', 80),
        effort: opt('effort', 20),
        mode: opt('mode', 40),
      });
      audit(req, 'session.fork', { ref: m[1], uid: out.uid, window: out.id, branch: out.branch });
      return send(res, 201, out);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/send$/))) {
    const body = await readJson(req);
    const out = await core.send(m[1], str(body.text, 'text', 32 * 1024), body.enter !== false);
    audit(req, 'session.send', { ref: m[1], window: out.windowId, outcome: out.outcome, resumed: out.resumed });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/answer$/))) {
    const answer = (await readJson(req)).answer;
    if (answer !== 'approve' && answer !== 'deny') throw new HttpError(400, 'answer must be approve or deny');
    await core.answer(m[1], answer);
    audit(req, `session.${answer}`, { uid: m[1] });
    return send(res, 200, { ok: true });
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/commands$/))) {
    const { preset, cwd } = await core.sessionPlace(m[1]);
    return send(res, 200, preset ? await slashCommands(preset, cwd) : []);
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/files$/))) {
    const { cwd } = await core.sessionPlace(m[1]);
    const q = (url.searchParams.get('q') ?? '').slice(0, 200);
    return send(res, 200, await projectFiles(cwd, q));
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/choose$/))) {
    const key = str((await readJson(req)).key, 'key', 8);
    const option = await core.choose(m[1], key);
    audit(req, 'session.choose', { uid: m[1], key, label: option.label.slice(0, 80) });
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/questions$/))) {
    const body = await readJson(req);
    const answerOf = (a: any) => ({
      picked: Array.isArray(a?.picked) ? a.picked.slice(0, 9) : [],
      ...(a?.text !== undefined ? { text: str(a.text, 'text', 2000) } : {}),
    });
    if (body.current) {
      // One question: the one the dialog shows now.
      const current = body.current as { question?: unknown; answer?: unknown };
      await core.answerDialogQuestion(m[1], str(current.question, 'question', 2000), answerOf(current.answer));
      audit(req, 'session.questions', { uid: m[1], count: 1 });
      return send(res, 200, { ok: true });
    }
    if (!Array.isArray(body.answers) || body.answers.length > 8) throw new HttpError(400, 'answers must be a list');
    const answers = body.answers.map(answerOf);
    await core.answerQuestions(m[1], answers);
    audit(req, 'session.questions', { uid: m[1], count: answers.length });
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/switch$/))) {
    const body = await readJson(req);
    const change = {
      ...(body.model !== undefined ? { model: str(body.model, 'model', 80) } : {}),
      ...(body.effort !== undefined ? { effort: str(body.effort, 'effort', 20) } : {}),
    };
    const out = await core.switchLaunch(m[1], change);
    audit(req, 'session.switch', { uid: m[1], ...change, outcome: out.outcome });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/settings$/))) {
    const setting = (await readJson(req)).setting;
    if (setting !== 'model' && setting !== 'effort' && setting !== 'mode') throw new HttpError(400, 'unknown setting');
    const out = await core.openSettings(m[1], setting);
    audit(req, 'session.settings', { uid: m[1], setting, outcome: out.outcome });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/relaunch$/))) {
    const body = await readJson(req);
    const change = {
      ...(body.model !== undefined ? { model: str(body.model, 'model', 80) } : {}),
      ...(body.effort !== undefined ? { effort: str(body.effort, 'effort', 20) } : {}),
    };
    const out = await core.relaunch(m[1], change);
    audit(req, 'session.relaunch', { uid: m[1], ...change, window: out.id });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/interrupt$/))) {
    await core.interrupt(m[1]);
    audit(req, 'session.interrupt', { uid: m[1] });
    return send(res, 200, { ok: true });
  }

  // GUI view: the session's transcript as typed events (server/feed). A stream of
  // snapshot/append messages, plus pages of older entries on demand.
  if ((m = route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed\/stream$/))) {
    const ref = m[1];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const done = new AbortController();
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const untrack = auth.track(caller, { close: () => res.end() });
    // Reading the GUI is looking at the session, the same as its terminal.
    const device = (url.searchParams.get('device') ?? '').slice(0, 60) || 'browser';
    let leave: (() => void) | null = null;
    void core.current().then((st) => {
      const win = st.windows.find((w) => w.uid === ref);
      if (win && !done.signal.aborted) leave = addViewer(win.id, device);
    });
    req.on('close', () => {
      done.abort();
      clearInterval(ping);
      untrack();
      leave?.();
    });
    streamFeed((fresh) => core.feedSource(ref, fresh ? 3000 : 15_000), (msg) => res.write(`event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`), done.signal);
    return;
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed$/))) {
    const before = Number(url.searchParams.get('before') ?? Infinity);
    const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || SNAPSHOT));
    if (Number.isNaN(before)) throw new HttpError(400, 'invalid before');
    const page = await feedPage(() => core.feedSource(m![1]), before, limit);
    if (!page) throw new HttpError(404, 'no transcript');
    return send(res, 200, page);
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/queue$/))) return send(res, 200, core.queue(m[1]));

  if ((m = route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/queue(?:\/([\w-]{1,40}))?$/))) {
    core.clearQueue(m[1], m[2]);
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/move$/))) {
    const to = (await readJson(req)).to;
    if (!Number.isInteger(to) || (to as number) < 0 || (to as number) > 1000) throw new HttpError(400, 'invalid position');
    try {
      return send(res, 200, core.moveQueued(m[1], m[2], to as number));
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  // Browser preview: one per session, of a port its dev server listens on.
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/preview$/))) {
    const pids = await core.sessionPids(m[1]);
    const ports = pids ? (await listeningPorts(pids)).filter((p) => !isPreviewPort(p)) : [];
    return send(res, 200, { preview: previews.get(m[1]), ports, live: !!pids });
  }
  if ((m = route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/preview$/))) {
    const target = (await readJson(req)).target;
    if (!Number.isInteger(target) || (target as number) < 1 || (target as number) > 65535 || isPreviewPort(target as number)) throw new HttpError(400, 'invalid port');
    if (!(await core.sessionPids(m[1]))) throw new HttpError(404, 'session not running');
    const preview = await previews.start(m[1], target as number);
    core.registry.setMeta(m[1], 'ah.preview', { target });
    audit(req, 'preview.start', { uid: m[1], target, port: preview.port });
    return send(res, 200, { preview });
  }
  if ((m = route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/preview$/))) {
    await previews.stop(m[1]);
    core.registry.setMeta(m[1], 'ah.preview', undefined);
    audit(req, 'preview.stop', { uid: m[1] });
    return send(res, 200, { ok: true });
  }

  // Urgent follow-up: deliver one queued message now, stopping the live turn.
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/send-now$/))) {
    const out = await core.sendNow(m[1], m[2]);
    audit(req, 'session.send-now', { uid: m[1], window: out.windowId });
    return send(res, 200, out);
  }

  // Per-turn snapshots (F39): list, restore (with safety snapshot), toggle.
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/snapshots$/))) {
    try {
      return send(res, 200, await core.listSnapshots(m[1]));
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/snapshots\/(\d{1,9})\/restore$/))) {
    const body = await readJson(req);
    try {
      const out = await core.restoreSnapshot(m[1], Number(m[2]), { interrupt: body.interrupt === true });
      audit(req, 'snapshot.restore', { uid: m[1], turn: Number(m[2]), safetyId: out.safety.id, safetyTurn: out.safety.turn });
      return send(res, 200, out);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/snapshots\/toggle$/))) {
    const body = await readJson(req);
    try {
      core.setSnapshotsEnabled(m[1], body.enabled !== false);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
    audit(req, 'snapshot.toggle', { uid: m[1], enabled: body.enabled !== false });
    return send(res, 200, { ok: true });
  }

  // Handoff: the session this device is on, so another device can offer to continue it.
  if (route('POST', /^\/api\/focus$/)) {
    const body = await readJson(req);
    const key = str(body.key, 'key', 120);
    if (!/^(?:[\w.-]{1,64}\/)?[\w-]{1,40}$/.test(key)) throw new HttpError(400, 'invalid key');
    core.setFocus({ key, device: str(body.device ?? '', 'device', 40).replace(/[^\w .-]/g, '').slice(0, 24) || 'browser', client: str(body.client ?? '', 'client', 40) });
    return send(res, 200, { ok: true });
  }

  // Unsent composer text, so a draft follows you between devices (server/drafts.ts).
  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/draft$/))) return send(res, 200, { draft: drafts.get(m[1]) });
  if ((m = route('PUT', /^\/api\/sessions\/([\w-]{1,40})\/draft$/))) {
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 32 * 1024);
    return send(res, 200, { draft: drafts.set(m[1], text, str(body.device ?? '', 'device', 40), str(body.client ?? '', 'client', 40)) });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/pin$/))) {
    core.setPinned(m[1], (await readJson(req)).pinned !== false);
    return send(res, 200, { ok: true });
  }

  // ---------- system: host-level actions behind Settings → System

  if (route('GET', /^\/api\/system\/hooks$/)) return send(res, 200, { ...hooksStatus(), audit: screenAudit.summary() });
  if (route('DELETE', /^\/api\/system\/screen-audit$/)) {
    screenAudit.reset();
    return send(res, 200, { ok: true });
  }

  // ah in the host's app launcher, in its own window (server/desktop.ts), like the hooks card.
  if (route('GET', /^\/api\/system\/desktop$/)) return send(res, 200, desktopStatus(config.port));
  if (route('POST', /^\/api\/system\/desktop$/)) {
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
  }

  if (route('GET', /^\/api\/omarchy\/theme$/)) return send(res, 200, omarchyTheme());

  if (route('POST', /^\/api\/system\/hooks$/)) {
    const action = (await readJson(req)).action;
    if (action !== 'install' && action !== 'uninstall') throw new HttpError(400, 'action must be install or uninstall');
    const messages = action === 'install' ? [installClaude(), installCodex()] : [uninstallClaude(), uninstallCodex()];
    audit(req, `system.hooks.${action}`);
    return send(res, 200, { messages, status: hooksStatus() });
  }

  if (route('POST', /^\/api\/system\/restart$/)) {
    audit(req, 'system.restart');
    // `systemctl --user restart ah` stops (SIGTERM → graceful drain above) and
    // starts us again. Live processes belong to ah-tmux.service and never
    // notice; ended records keep their resume data in SQLite.
    send(res, 200, { ok: true });
    scheduleRestart();
    return;
  }

  if (route('POST', /^\/api\/system\/rebuild$/)) {
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
        await rebuildWeb(ROOT, DIST);
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
  }

  if (route('POST', /^\/api\/system\/uploads\/clear$/)) {
    try {
      const removed = await clearUploadDir(UPLOAD_DIR);
      audit(req, 'system.uploads.clear', { removed });
      return send(res, 200, { ok: true, removed });
    } catch (err) {
      const msg = (err as Error).message || 'could not clear uploads';
      console.error(`clear uploads failed: ${msg}`);
      return send(res, 500, { error: msg });
    }
  }

  // Manual sidebar order (F43): sparse key, persisted in the registry, synced to every device over SSE.
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/order$/))) {
    const body = await readJson(req);
    const order = Number(body.order);
    if (!Number.isFinite(order)) throw new HttpError(400, 'invalid order');
    try {
      await core.setOrder(m[1], order);
    } catch (err) {
      if (err instanceof CoreError) throw new HttpError(err.status, err.message);
      throw err;
    }
    return send(res, 200, { ok: true });
  }

  if ((m = route('DELETE', /^\/api\/sessions\/([\w:.-]{1,80})$/))) {
    await core.forget(m[1]);
    return send(res, 200, { ok: true });
  }

  // ---------- files (explorer + transfer), confined to config.files.roots

  if (route('GET', /^\/api\/fs\/list$/)) {
    return send(res, 200, { ...(await list(url.searchParams.get('path') || roots()[0], url.searchParams.get('hidden') === '1')), roots: roots().map(shortPath) });
  }

  if (route('GET', /^\/api\/fs\/file$/)) return sendFile(res, url.searchParams.get('path') ?? '', url.searchParams.get('download') === '1');

  if (route('POST', /^\/api\/fs\/upload$/)) {
    const path = await receive(req, url.searchParams.get('dir') ?? '', url.searchParams.get('name') ?? '', FS_UPLOAD_LIMIT);
    audit(req, 'file.upload', { path });
    return send(res, 201, { path });
  }

  if (route('POST', /^\/api\/fs\/mkdir$/)) return send(res, 201, { path: await makeDir(str((await readJson(req)).path, 'path', 1024)) });

  if (route('POST', /^\/api\/upload$/)) {
    // Pasted/dropped files land in ah's own upload folder, readable only by you.
    const name = (url.searchParams.get('name') ?? 'upload').replace(/[^\w.-]+/g, '_').slice(-80) || 'upload';
    const body = await readBody(req, UPLOAD_LIMIT);
    await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    const file = join(UPLOAD_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
    await writeFile(file, body, { mode: 0o600, flag: 'wx' });
    audit(req, 'file.upload', { path: file, bytes: body.length });
    return send(res, 201, { path: file });
  }

  // ---------- web push

  if (route('GET', /^\/api\/push\/key$/)) return send(res, 200, { key: core.push.publicKey });

  if (route('POST', /^\/api\/push\/subscribe$/)) {
    const body = await readJson(req);
    const events = body.events as { waiting?: unknown; done?: unknown } | undefined;
    try {
      core.push.subscribe(body.subscription as never, { waiting: events?.waiting !== false, done: events?.done === true }, String(body.label ?? ''));
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/push\/unsubscribe$/)) {
    core.push.unsubscribe(str((await readJson(req)).endpoint, 'endpoint', 2048));
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/push\/status$/)) return send(res, 200, { events: core.push.settings(str((await readJson(req)).endpoint, 'endpoint', 2048)) });

  // ---------- worktrees, prompts

  if (route('GET', /^\/api\/worktrees$/)) return send(res, 200, await core.worktrees());

  if (route('DELETE', /^\/api\/worktrees$/)) {
    const body = await readJson(req);
    const path = str(body.path, 'path', 1024);
    await core.removeWorktree(path, body.force === true);
    audit(req, 'worktree.remove', { path, forced: body.force === true });
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/worktrees\/remove-bulk$/)) {
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
  }

  if (route('GET', /^\/api\/prompts$/)) return send(res, 200, core.recentPrompts());
  if (route('DELETE', /^\/api\/prompts$/)) {
    core.clearPrompts();
    audit(req, 'prompts.clear');
    return send(res, 200, { ok: true });
  }

  // ---------- windows

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/changes$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    return send(res, 200, await changes(expandHome(w.cwd)));
  }

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/branches$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    return send(res, 200, await listBranches(expandHome(w.cwd)));
  }

  if ((m = route('POST', /^\/api\/windows\/(@\d+)\/branches$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const branch = str((await readJson(req)).branch, 'branch', 200).trim();
    if (!branch) throw new HttpError(400, 'branch required');
    const out = await switchBranch(expandHome(w.cwd), branch);
    audit(req, 'session.branch', { window: m[1], branch: out.branch });
    core.tick().catch(() => {});
    return send(res, 200, out);
  }

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/pull$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const pr = await pullRequest(expandHome(w.cwd));
    return send(res, 200, { number: pr?.number ?? null, url: pr?.url ?? null });
  }

  // ---------- side chat (BYOK change discussion, outside the agent's context)

  if (route('GET', /^\/api\/subscriptions$/)) return send(res, 200, await sidechat.list());

  if (route('POST', /^\/api\/subscriptions$/)) {
    const body = await readJson(req);
    const out = await sidechat.put({
      ...(body.id === undefined ? {} : { id: str(body.id, 'id', 40) }),
      name: str(body.name ?? '', 'name', 80),
      baseUrl: str(body.baseUrl ?? '', 'baseUrl', 200),
      model: str(body.model ?? '', 'model', 80),
      ...(body.apiKey === undefined ? {} : { apiKey: str(body.apiKey, 'apiKey', 500) }),
    });
    audit(req, 'subscription.save', { id: out.id, name: out.name });
    return send(res, 200, out);
  }

  if ((m = route('DELETE', /^\/api\/subscriptions\/([\w-]{1,40})$/))) {
    await sidechat.remove(m[1]);
    audit(req, 'subscription.remove', { id: m[1] });
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/subscriptions\/default$/)) {
    const id = str((await readJson(req)).id, 'id', 40);
    await sidechat.setDefault(id);
    audit(req, 'subscription.default', { id });
    return send(res, 200, { ok: true });
  }

  // Handoff brief: summarize a transcript with the chat subscription. Not stored.
  if (route('POST', /^\/api\/summarize$/)) {
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 24_000).trim();
    if (!text) throw new HttpError(400, 'text required');
    try {
      const summary = await sidechat.summarize(text, body.subscriptionId === undefined ? undefined : str(body.subscriptionId, 'subscriptionId', 40));
      return send(res, 200, { summary });
    } catch (err) {
      if (err instanceof SideChatError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  // Side chats attach to the conversation (`harness:harnessId`), not the window:
  // the key follows the session across uids, and legacy uid rows migrate over.
  const chatKeyFor = async (windowId: string) => {
    const w = (await core.current()).windows.find((w) => w.id === windowId);
    if (!w) throw new HttpError(404, 'window not found');
    const key = sidechat.chatKey(w.agent, w.harnessId, w.uid);
    await sidechat.rekey(w.uid, key);
    return key;
  };

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const key = await chatKeyFor(m![1]);
    const [messages, subscriptionId] = await Promise.all([sidechat.history(key), sidechat.defaultId()]);
    return send(res, 200, { messages, subscriptionId });
  }

  if ((m = route('POST', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const key = sidechat.chatKey(w.agent, w.harnessId, w.uid);
    await sidechat.rekey(w.uid, key);
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 8000).trim();
    if (!text) throw new HttpError(400, 'text required');
    const dir = expandHome(w.cwd);
    const [chg, pr] = await Promise.all([changeContext(dir).catch(() => null), pullRequest(dir).catch(() => null)]);
    try {
      const msg = await sidechat.chat(
        key,
        text,
        { title: w.title, session: w.session, branch: chg?.branch ?? w.branch, pr: pr?.number ?? null, diff: chg?.diff ?? '', dir },
        body.subscriptionId === undefined ? undefined : str(body.subscriptionId, 'subscriptionId', 40),
      );
      return send(res, 200, msg);
    } catch (err) {
      if (err instanceof SideChatError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('DELETE', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const key = await chatKeyFor(m![1]);
    await sidechat.clear(key);
    return send(res, 200, { ok: true });
  }

  // ---------- historic chats (every stored conversation, live session or not)

  if (route('GET', /^\/api\/chats$/)) {
    const q = url.searchParams.get('q') ?? undefined;
    return send(res, 200, await sidechat.listChats(q?.slice(0, 200)));
  }

  if ((m = route('GET', /^\/api\/chats\/([\w:.-]{1,80})$/))) {
    return send(res, 200, { messages: await sidechat.history(m[1], Number(url.searchParams.get('msgId')) || undefined) });
  }

  // ---------- full-text search over transcripts and side chats (issue #9)

  if (route('GET', /^\/api\/search\/status$/)) return send(res, 200, await search.status());

  if (route('GET', /^\/api\/search$/)) return send(res, 200, await search.search(searchParams(url)));

  if (route('GET', /^\/api\/search\/all$/)) {
    // Hub fan-out: our own results plus every peer's, merged. A peer that is
    // offline or errors becomes a note in the response, never a failed search.
    const params = searchParams(url);
    const limit = Math.min(50, Math.max(1, Math.floor(params.limit ?? 20)));
    const offset = Math.max(0, Math.floor(params.offset ?? 0));
    const needed = offset + limit;
    const selected = (host: string) => !params.host || host.toLowerCase().includes(params.host.toLowerCase());
    // Every host supplies the ordered prefix needed for this global page.
    // Applying the global offset on each host would lose or repeat sessions.
    const prefix = async (get: (p: SearchParams) => Promise<Awaited<ReturnType<typeof search.search>>>) => {
      let body: Awaited<ReturnType<typeof search.search>> | undefined;
      const results: NonNullable<typeof body>['results'] = [];
      do {
        const next = await get({ ...params, host: undefined, order: 'recent', limit: Math.min(50, needed - results.length), offset: results.length });
        body = next;
        results.push(...next.results);
        if (!next.results.length || results.length >= next.total) break;
      } while (results.length < needed);
      return { ...body!, results };
    };
    const parts = await Promise.all([
      ...(selected(hostname()) ? [prefix((p) => search.search(p)).then((body) => ({ host: hostname(), body }))] : []),
      ...peers.list().filter((peer) => selected(peer.name)).map(async (peer) => {
        if (!peer.online || !peerUrlAllowed(peer.url)) return { host: peer.name, error: 'offline' };
        try {
          const body = await prefix(async (p) => {
            const qs = new URLSearchParams();
            for (const [k, v] of Object.entries({ q: p.q, in: p.scope, role: p.role, p: p.project, m: p.model, limit: p.limit, offset: p.offset, from: p.from, to: p.to, sort: 'recent' })) {
              if (v !== undefined && v !== 'all') qs.set(k, String(v));
            }
            const r = await fetch(`${peer.url}/api/search?${qs}`, {
              headers: peer.token ? { authorization: `Bearer ${peer.token}` } : {},
              signal: AbortSignal.timeout(3000),
              redirect: 'manual',
            });
            if (!r.ok) throw new Error(`http ${r.status}`);
            return await r.json();
          });
          return { host: peer.name, body };
        } catch { return { host: peer.name, error: 'unreachable' }; }
      }),
    ]);
    return send(res, 200, combineResponses(parts, { offset, limit }));
  }

  if (route('POST', /^\/api\/search\/rebuild$/)) {
    void search.rebuild().catch((err) => console.error('search rebuild failed:', err));
    audit(req, 'search.rebuild');
    return send(res, 200, await search.status());
  }

  if (route('POST', /^\/api\/search\/enabled$/)) {
    const on = (await readJson(req)).enabled === true;
    await search.setEnabled(on);
    audit(req, on ? 'search.enable' : 'search.disable');
    return send(res, 200, await search.status());
  }

  if ((m = path.match(/^\/api\/windows\/(@\d+)(\/capture)?$/))) {
    const id = m[1];
    if (!(await t.windowExists(id))) throw new HttpError(404, 'window not found');
    if (m[2] && method === 'GET') {
      const lines = Math.min(10000, Math.max(1, Number(url.searchParams.get('lines')) || 2000));
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(await t.capturePane(id, lines));
    }
    if (!m[2] && method === 'PATCH') {
      const name = str((await readJson(req)).name, 'name', 80).trim();
      if (!name) throw new HttpError(400, 'name required');
      await t.renameWindow(id, name);
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (!m[2] && method === 'DELETE') {
      await t.killWindow(id);
      audit(req, 'session.kill', { window: id });
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'not found');
}

// ---------- auth routes

async function authApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, caller: Caller | null) {
  const route = (verb: string, re: RegExp) => (method === verb ? path.match(re) : null);
  const label = (b: Record<string, unknown>) => String(b.label ?? '').replace(/[^\w .·()-]/g, '').slice(0, 60);
  const isHost = caller?.kind === 'token' && caller.token.id === 'local';
  const signedIn = (cookie: { cookie: string } | null) => {
    if (cookie) res.setHeader('set-cookie', cookie.cookie);
    return send(res, 200, { ok: true });
  };
  let m: RegExpMatchArray | null;

  if (route('GET', /^\/api\/auth\/status$/)) {
    return send(res, 200, { enabled: auth.enabled, enrolled: auth.enrolled, authenticated: !!caller, password: auth.hasPassword });
  }
  if (route('POST', /^\/api\/auth\/register\/options$/)) {
    const body = await readJson(req);
    return send(res, 200, await auth.registrationOptions(req, caller, typeof body.code === 'string' ? body.code : undefined));
  }
  if (route('POST', /^\/api\/auth\/register\/verify$/)) {
    const body = await readJson(req);
    return signedIn(await auth.verifyRegistration(req, str(body.challengeId, 'challenge', 40), body.response as never, label(body)));
  }
  if (route('POST', /^\/api\/auth\/login\/options$/)) return send(res, 200, await auth.authenticationOptions(req));
  if (route('POST', /^\/api\/auth\/login\/verify$/)) {
    const body = await readJson(req);
    return signedIn(await auth.verifyAuthentication(req, str(body.challengeId, 'challenge', 40), body.response as never, label(body)));
  }
  if (route('POST', /^\/api\/auth\/password\/login$/)) {
    const body = await readJson(req);
    return signedIn(await auth.passwordLogin(req, str(body.password, 'password', 512), label(body)));
  }
  if (route('POST', /^\/api\/auth\/logout$/)) {
    if (caller?.kind === 'session') auth.endSession(caller.session.id, 'signed out');
    res.setHeader('set-cookie', clearCookies());
    return send(res, 200, { ok: true });
  }

  // Management: signed-in devices and the host's own CLI only.
  if (!caller) throw new HttpError(401, 'sign in required');

  if (route('POST', /^\/api\/auth\/cache-key$/)) {
    const key = auth.cacheKey(caller);
    if (!key) throw new HttpError(404, 'no cache for this caller');
    res.setHeader('cache-control', 'no-store');
    return send(res, 200, { key });
  }
  if (route('GET', /^\/api\/auth\/overview$/)) return send(res, 200, { ...auth.overview(caller), audit: auth.recentAudit(50) });
  if (route('POST', /^\/api\/auth\/code$/)) {
    return send(res, 200, { code: auth.issueCode(caller.kind === 'session' ? `device ${caller.session.label}` : 'host CLI'), ttlMinutes: 10 });
  }
  if ((m = route('DELETE', /^\/api\/auth\/sessions\/(\w{1,20})$/))) {
    auth.endSession(m[1], 'revoked');
    return send(res, 200, { ok: true });
  }
  if (route('POST', /^\/api\/auth\/signout-all$/)) {
    auth.signOutEverywhere(caller.kind === 'session' ? caller.session.id : undefined);
    return send(res, 200, { ok: true });
  }
  if ((m = route('DELETE', /^\/api\/auth\/passkeys\/([\w-]{1,512})$/))) {
    auth.removePasskey(m[1]);
    return send(res, 200, { ok: true });
  }
  if (route('POST', /^\/api\/auth\/tokens$/)) return send(res, 200, { token: auth.createToken(str((await readJson(req)).name, 'name', 60)) });
  if ((m = route('DELETE', /^\/api\/auth\/tokens\/(\w{1,20})$/))) {
    auth.removeToken(m[1]);
    return send(res, 200, { ok: true });
  }
  // The master password can only be set from the host itself.
  if (route('POST', /^\/api\/auth\/password$/)) {
    if (!isHost) throw new HttpError(403, 'set the master password on the host: node bin/ah.js auth password');
    const body = await readJson(req);
    await auth.setPassword(body.password === null ? null : str(body.password, 'password', 512));
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, 'not found');
}

// ---------- static files

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  // Ignored over plain http (localhost); pins https for the ts.net name.
  'strict-transport-security': 'max-age=31536000',
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const cspFor = () => [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  // Inline style attributes only (React); no third-party origins anywhere.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
  // Previews: a session's dev server, each on a port of its own (server/preview.ts).
  `frame-src http://localhost:* http://127.0.0.1:*${gate.tailnet ? ` https://${gate.tailnet.dnsName}:*` : ''}`,
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

async function serveStatic(res: ServerResponse, pathname: string) {
  const rel = pathname === '/' ? 'index.html' : safeDecode(pathname).replace(/^\/+/, '');
  let file = resolve(DIST, rel);
  if (!file.startsWith(DIST + '/')) file = join(DIST, 'index.html');
  let body = await readFile(file).catch(() => null);
  if (!body) {
    file = join(DIST, 'index.html');
    body = await readFile(file).catch(() => null);
  }
  if (!body) {
    res.writeHead(503, { 'content-type': 'text/plain', 'content-security-policy': cspFor() });
    return res.end('UI not built. Run `pnpm build`, or use `pnpm dev`.');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': cspFor(),
  });
  res.end(body);
}

// ---------- the gate

function deny(res: ServerResponse, status: number, reason: string) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(reason);
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const verdict = gate.check(req);
  if (!verdict.ok) return deny(res, verdict.status, verdict.reason);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://x');
  } catch {
    return deny(res, 400, 'bad request');
  }
  const method = req.method ?? 'GET';
  try {
    // CSRF: a custom header can't be sent cross-site without a preflight we never answer.
    if (method !== 'GET' && method !== 'HEAD' && (req.headers['x-ah'] !== '1' || !gate.originOk(req))) throw new HttpError(403, 'forbidden');
    const caller = auth.identify(req);

    // /h/<host>/… addresses a host: ourselves (served here) or a peer (proxied).
    let path = safeDecode(url.pathname);
    const h = path.match(/^\/h\/([\w.-]{1,64})(\/.*)$/);
    if (h && h[1] !== hostname()) {
      if (!caller) throw new HttpError(401, 'sign in required');
      const peer = peers.get(h[1]);
      if (!peer) throw new HttpError(502, `host ${h[1]} is offline`);
      return await proxyHttp(peer, h[2] + url.search, req, res);
    }
    if (h) {
      path = h[2];
      url = new URL(h[2] + url.search, 'http://x');
      if (path.startsWith('/h/')) throw new HttpError(404, 'not found');
    }

    if (path.startsWith('/api/')) {
      // Default deny (invariant 4).
      if (!caller && !PUBLIC_ROUTES.has(`${method} ${path}`)) throw new HttpError(401, 'sign in required');
      return await api(req, res, url, path, caller);
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed');
    await serveStatic(res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError || err instanceof CoreError || err instanceof AuthError || err instanceof FsError ? err.status : err instanceof GitError ? 400 : 500;
    if (status === 500) console.error(err);
    // A failure mid-stream (e.g. a download) can't be turned into a JSON error any more.
    if (res.headersSent) return res.destroy();
    const stderr = (err as { stderr?: string }).stderr;
    send(res, status, { error: status === 500 ? 'internal error' : stderr?.trim() || (err as Error).message });
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const reject = (status: string) => {
    socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  const verdict = gate.check(req);
  if (!verdict.ok) return reject(`${verdict.status} Forbidden`);
  if (!gate.originOk(req)) return reject('403 Forbidden');
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://x');
  } catch {
    return reject('400 Bad Request');
  }
  const m = safeDecode(url.pathname).match(/^(?:\/h\/([\w.-]{1,64}))?\/ws\/(@\d+)$/);
  if (!m) return reject('404 Not Found');
  const caller = auth.identify(req);
  if (!caller) return reject('401 Unauthorized');
  const [, host, windowId] = m;
  const peer = host && host !== hostname() ? peers.get(host) : null;
  if (host && host !== hostname() && !peer) return reject('502 Bad Gateway');

  wss.handleUpgrade(req, socket, head, (ws) => {
    // Protocol errors (e.g. a frame over maxPayload) must close this socket, not crash ah:
    // ws closes with 1009/1002 itself; an unhandled 'error' event would kill the process.
    ws.on('error', (err) => console.warn(`websocket closed on error: ${err.message}`));
    // Revoking this device's session closes its terminals too.
    ws.on('close', auth.track(caller, { close: () => ws.close(4401, 'signed out') }));
    if (peer) return proxyWs(peer, `/ws/${encodeURIComponent(windowId)}${url.search}`, ws);
    const cols = Number(url.searchParams.get('cols'));
    const rows = Number(url.searchParams.get('rows'));
    const device = (url.searchParams.get('device') ?? '').replace(/[^\w .-]/g, '').slice(0, 24) || 'browser';
    attach(ws, windowId, cols, rows, device).catch((err) => {
      console.error(err);
      ws.close(1011, 'attach failed');
    });
  });
}

// ---------- start

/** Read-only: is Tailscale Serve set up to forward to us? (ah never changes it.) */
async function serveStatus(port: number): Promise<string | null> {
  try {
    const { stdout } = await promisify(execFile)('tailscale', ['serve', 'status', '--json'], { timeout: 5000 });
    const cfg = JSON.parse(stdout || '{}');
    for (const [hostPort, web] of Object.entries<any>(cfg.Web ?? {})) {
      for (const h of Object.values<any>(web.Handlers ?? {})) {
        if (typeof h.Proxy === 'string' && new RegExp(`(127\\.0\\.0\\.1|localhost):${port}/?$`).test(h.Proxy)) return `https://${hostPort.replace(/:443$/, '')}`;
      }
    }
  } catch {}
  return null;
}

await Promise.all([gate.watch(), t.cleanupViewers(), t.ensureServer()]);
// SQLite is the durable state now: deploy schema, import any pre-Prisma JSON
// once (idempotent), then seed the in-memory mirrors before the first tick.
await ensureMigrated();
await importLegacyJson(getDb()).then(
  (c) => console.log('imported legacy state:', JSON.stringify(c)),
  (err) => console.error('legacy import failed:', err),
);
// Only now, with the schema current and legacy rows imported, read the
// sessions: fail closed rather than start with an empty registry, which would
// re-register live windows under new ids and orphan their links, queues and meta.
try {
  await core.registry.load();
} catch (err) {
  console.error(`Can't read ah's session registry: ${(err as Error).message}`);
  process.exit(1);
}
await core.loadPrompts();
core.start();
search.start();
peers.start();

const server: Server = createServer(handle);
server.on('upgrade', upgrade);
server.listen(PORT, HOST, async () => {
  const { port } = server.address() as AddressInfo;
  const where = HOST.includes(':') ? `[${HOST}]` : HOST;
  console.log(`ah listening on http://${where}:${port}`);
  if (!auth.enabled) {
    console.warn('⚠ auth is off ("auth": {"mode": "off"}): anyone who can reach this port gets a shell.');
  } else if (!auth.enrolled) {
    const code = auth.issueCode('startup');
    console.log(`\n  Set up your first device: open ah and enter this one-time code (valid 10 minutes):\n\n      ${code}\n\n  Need another later? Run \`node bin/ah.js auth code\` on this machine.\n`);
  }
  const exposed = await serveStatus(port);
  console.log(exposed ? `Reachable on your tailnet at ${exposed} (tailscale serve)` : 'Not on your tailnet yet: run `node bin/ah.js setup tailscale` once.');
  console.log(`config: ${CONFIG_PATH}`);
  if (process.env.AH_PREVIEW_PUBLISH !== '0') await removeStaleMappings(config.preview.ports);
  await syncPreviews().catch((err) => console.warn('previews:', err));
  setInterval(() => void syncPreviews().catch(() => {}), 15_000).unref();
});

let stopping = false;
// Graceful shutdown is part of crash persistence: session records are written
// fire-and-forget during ticks, so exiting in 200ms could truncate the very
// rows a post-restart resume needs. Stop the ticker, then drain them (bounded).
async function shutdown(sig: string) {
  if (stopping) process.exit(1); // second signal: out now
  stopping = true;
  console.log(`ah shutting down (${sig})`);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  server.close();
  core.stop();
  await drafts.save();
  // Unpublish preview ports; a crash leaves them for removeStaleMappings at the next start.
  await Promise.race([previews.stopAll(), new Promise((r) => setTimeout(r, 3000))]);
  const drain = (async () => {
    core.registry.flush();
    await core.registry.settled();
    // A tick that was already in flight may have dirtied the registry after
    // the first flush; a second round catches its write too.
    core.registry.flush();
    await core.registry.settled();
  })().catch((err) => console.error('shutdown drain failed:', err));
  await Promise.race([drain, new Promise((r) => setTimeout(r, 5000))]);
  process.exit(0);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => void shutdown(sig));
}
