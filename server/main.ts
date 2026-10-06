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
import { execFile } from 'node:child_process';
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
import { attach, viewers } from './terminal.ts';
import { feedPage, streamFeed, SNAPSHOT } from './feed/stream.ts';
import * as t from './tmux.ts';
import { createWorktree, changes, listBranches, switchBranch, pullRequest, GitError } from './git.ts';
import { SideChatStore, SideChatError, changeContext } from './sidechat.ts';
import { ensureMigrated, getDb } from './db.ts';
import { importLegacyJson } from './migrate.ts';
import { FsError, list, makeDir, receive, sendFile, setRoots, roots } from './files.ts';
import { Peers, proxyHttp, proxyWs } from './peers.ts';
import { Auth, AuthError, clearCookies, type Caller } from './auth.ts';
import { Gate, LOOPBACK_BIND } from './gate.ts';
import { HttpError, send, readBody, readJson, str, safeDecode } from './http.ts';

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
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

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
const sidechat = new SideChatStore();
const gate = new Gate();
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
    const unsubscribe = core.subscribe((json) => res.write(`event: state\ndata: ${json}\n\n`));
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

  if (route('POST', /^\/api\/windows$/)) {
    const body = await readJson(req);
    const preset = await withCatalog(core.preset(str(body.preset, 'preset', 40)));
    const cwd = await resolveDir(str(body.cwd ?? '~', 'cwd', 1024));
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
    const wt = body.worktree ? await createWorktree(cwd, name) : null;
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
    req.on('close', () => {
      done.abort();
      clearInterval(ping);
      untrack();
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

  // Urgent follow-up: deliver one queued message now, stopping the live turn.
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/queue\/([\w-]{1,40})\/send-now$/))) {
    const out = await core.sendNow(m[1], m[2]);
    audit(req, 'session.send-now', { uid: m[1], window: out.windowId });
    return send(res, 200, out);
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/pin$/))) {
    core.setPinned(m[1], (await readJson(req)).pinned !== false);
    return send(res, 200, { ok: true });
  }

  // Manual sidebar order (F43): sparse key, persisted in the registry, synced to every device over SSE.
  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/order$/))) {
    const body = await readJson(req);
    const order = Number(body.order);
    if (!Number.isFinite(order)) throw new HttpError(400, 'invalid order');
    try {
      core.setOrder(m[1], order);
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

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const [messages, subscriptionId] = await Promise.all([sidechat.history(w.uid), sidechat.defaultId()]);
    return send(res, 200, { messages, subscriptionId });
  }

  if ((m = route('POST', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    const body = await readJson(req);
    const text = str(body.text ?? '', 'text', 8000).trim();
    if (!text) throw new HttpError(400, 'text required');
    const dir = expandHome(w.cwd);
    const [chg, pr] = await Promise.all([changeContext(dir).catch(() => null), pullRequest(dir).catch(() => null)]);
    try {
      const msg = await sidechat.chat(
        w.uid,
        text,
        { title: w.title, session: w.session, branch: chg?.branch ?? w.branch, pr: pr?.number ?? null, diff: chg?.diff ?? '' },
        body.subscriptionId === undefined ? undefined : str(body.subscriptionId, 'subscriptionId', 40),
      );
      return send(res, 200, msg);
    } catch (err) {
      if (err instanceof SideChatError) throw new HttpError(err.status, err.message);
      throw err;
    }
  }

  if ((m = route('DELETE', /^\/api\/windows\/(@\d+)\/chat$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    await sidechat.clear(w.uid);
    return send(res, 200, { ok: true });
  }

  // ---------- historic chats (every stored conversation, live session or not)

  if (route('GET', /^\/api\/chats$/)) {
    const q = url.searchParams.get('q') ?? undefined;
    return send(res, 200, await sidechat.listChats(q?.slice(0, 200)));
  }

  if ((m = route('GET', /^\/api\/chats\/([\w-]{1,64})$/))) {
    return send(res, 200, { messages: await sidechat.history(m[1]) });
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

const CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  // Inline style attributes only (React); no third-party origins anywhere.
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "script-src 'self'",
  "frame-ancestors 'none'",
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
    res.writeHead(503, { 'content-type': 'text/plain', 'content-security-policy': CSP });
    return res.end('UI not built. Run `pnpm build`, or use `pnpm dev`.');
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': CSP,
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

await Promise.all([gate.watch(), t.cleanupViewers()]);
// SQLite is the durable state now: deploy schema, import any pre-Prisma JSON
// once (idempotent), then seed the in-memory mirrors before the first tick.
await ensureMigrated();
await importLegacyJson(getDb()).then(
  (c) => console.log('imported legacy state:', JSON.stringify(c)),
  (err) => console.error('legacy import failed:', err),
);
await core.loadPrompts();
core.start();
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
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    server.close();
    setTimeout(() => process.exit(0), 200);
  });
}
