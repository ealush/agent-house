import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname, homedir } from 'node:os';
import { join, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { loadConfig, expandHome, CONFIG_PATH } from './config.ts';
import { shortPath } from './sessions.ts';
import { Core, CoreError, resolveDir, defaultName } from './core.ts';
import { attach, viewers } from './terminal.ts';
import * as t from './tmux.ts';
import { createWorktree, changes, GitError } from './git.ts';
import { FsError, list, makeDir, receive, sendFile } from './files.ts';
import { Peers, proxyHttp, proxyWs, tailnet } from './peers.ts';
import { Auth, AuthError, clearCookies, type Caller } from './auth.ts';

const config = loadConfig();
const core = new Core(config, viewers);
const auth = new Auth(config.auth);
/** Tailscale login that owns this machine; requests arriving via Serve from anyone else are refused. */
let ownerLogin: string | null = null;
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const PORT = Number(flag('port') ?? process.env.AH_PORT ?? config.port);
// Comma-separated; "tailscale" means this machine's Tailscale IPv4 (plain HTTP, WireGuard-encrypted).
const HOSTS = String(flag('host') ?? process.env.AH_HOST ?? config.host)
  .split(',')
  .map((h) => h.trim())
  .filter(Boolean);
const DIST = fileURLToPath(new URL('../dist', import.meta.url));

const wildcard = HOSTS.find((h) => h === '0.0.0.0' || h === '::');
if (wildcard && !args.includes('--unsafe-bind-all')) {
  console.error(`Refusing to listen on ${wildcard}: this server hands out shells. Bind to 127.0.0.1 behind`);
  console.error('`tailscale serve`, or to your Tailscale IP. Pass --unsafe-bind-all if you really mean it.');
  process.exit(1);
}

// ---------- Host / Origin allowlist (blocks DNS rebinding and cross-site WebSockets)

let tailscaleIPv4: string | null = null;
const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', hostname(), ...config.allowedHosts]);
/** True once Tailscale answered; at boot ah may start before tailscaled is up. */
async function addTailscaleHosts(): Promise<boolean> {
  try {
    const { stdout } = await promisify(execFile)('tailscale', ['status', '--json'], { timeout: 5000 });
    const self = JSON.parse(stdout).Self;
    const dns = String(self.DNSName ?? '').replace(/\.$/, '');
    if (dns) {
      allowedHosts.add(dns);
      allowedHosts.add(dns.split('.')[0]);
    }
    for (const ip of self.TailscaleIPs ?? []) allowedHosts.add(ip);
    tailscaleIPv4 = (self.TailscaleIPs ?? []).find((ip: string) => !ip.includes(':')) ?? null;
    return !!dns;
  } catch {
    // Tailscale not installed or not running yet; localhost still works.
    return false;
  }
}

/** Keeps retrying until Tailscale is up (boot races), then refreshes now and then. */
function watchTailscale() {
  const tick = async () => {
    const ok = await addTailscaleHosts();
    if (ok && !ownerLogin) ownerLogin = (await tailnet()).login;
    setTimeout(tick, ok ? 5 * 60_000 : 5_000);
  };
  tick();
}

function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

function hostAllowed(req: IncomingMessage): boolean {
  const h = hostOf(req.headers.host);
  return h !== null && allowedHosts.has(h);
}

/** Behind `tailscale serve`, the caller's identity arrives in a header. Only the owner gets in. */
function identityAllowed(req: IncomingMessage): boolean {
  const who = req.headers['tailscale-user-login'];
  return !who || !ownerLogin || who === ownerLogin;
}

function originAllowed(req: IncomingMessage): boolean {
  const o = hostOf(req.headers.origin);
  return o !== null && allowedHosts.has(o);
}

// ---------- helpers

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, 64 * 1024);
  try {
    return JSON.parse(body.toString() || '{}');
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `invalid ${field}`);
  return v;
}

const UPLOAD_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ah', 'uploads');
const UPLOAD_LIMIT = 50 * 1024 * 1024;
const FS_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;

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

// ---------- API

async function api(req: IncomingMessage, res: ServerResponse, url: URL, caller: Caller | null) {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    // A custom header can't be sent cross-site without a CORS preflight we never answer.
    if (req.headers['x-ah'] !== '1' || !originAllowed(req)) throw new HttpError(403, 'forbidden');
  }
  const path = safeDecode(url.pathname);
  const route = (verb: string, re: RegExp) => (method === verb ? path.match(re) : null);
  let m: RegExpMatchArray | null;

  if (route('GET', /^\/api\/hello$/)) return send(res, 200, { ah: true, hostname: hostname(), auth: auth.enabled });
  if (path.startsWith('/api/auth/')) return authApi(req, res, path, method, caller);
  // Everything past this point needs a signed-in device or a machine token.
  if (!caller) throw new HttpError(401, 'sign in required');

  if (route('GET', /^\/api\/state$/)) return send(res, 200, await core.current());

  if (route('GET', /^\/api\/events$/)) {
    // Server-sent state pushes: one stream per client instead of polling.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
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
    const preset = core.preset(str(body.preset, 'preset', 40));
    const cwd = await resolveDir(str(body.cwd ?? '~', 'cwd', 1024));
    const session = t.sanitizeSessionName(str(body.session || config.defaultSession, 'session', 64));
    if (!session) throw new HttpError(400, 'invalid session');
    const name = str(body.label ?? '', 'label', 80).trim() || defaultName(preset, cwd);
    const command = body.resume && preset.resume ? preset.resume : preset.command;
    // One writing agent per checkout (F29): optionally start in a fresh worktree + branch.
    const wt = body.worktree ? await createWorktree(cwd, name) : null;
    const out = await core.launch({ preset, cwd: wt?.path ?? cwd, session, name, command, meta: wt ? { 'ah.worktree': wt } : undefined });
    audit(req, `create ${out.windowId} (${out.uid}) preset=${preset.id} session=${session} cwd=${wt?.path ?? cwd}${wt ? ` branch=${wt.branch}` : ''}`);
    await core.refreshTmuxPath();
    return send(res, 201, { id: out.windowId, uid: out.uid });
  }

  // Sessions are addressed by registry id, or `harness:harnessId` for discovered history.
  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/resume$/))) {
    const out = await core.resume(m[1]);
    if (out.resumed) audit(req, `resume ${m[1]} as ${out.windowId}`);
    return send(res, out.resumed ? 201 : 200, { id: out.windowId, uid: out.uid, resumed: out.resumed });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w:.-]{1,80})\/send$/))) {
    const body = await readJson(req);
    const text = str(body.text, 'text', 32 * 1024);
    const out = await core.send(m[1], text, body.enter !== false);
    audit(req, `send ${m[1]} → ${out.windowId}: ${out.outcome}${out.resumed ? ' (resumed)' : ''}`);
    return send(res, 200, out);
  }

  // ---------- files (explorer + transfer)

  if (route('GET', /^\/api\/fs\/list$/)) {
    return send(res, 200, await list(url.searchParams.get('path') || '~', url.searchParams.get('hidden') === '1'));
  }

  if (route('GET', /^\/api\/fs\/file$/)) {
    return sendFile(res, url.searchParams.get('path') ?? '', url.searchParams.get('download') === '1');
  }

  if (route('POST', /^\/api\/fs\/upload$/)) {
    const path = await receive(req, url.searchParams.get('dir') ?? '', url.searchParams.get('name') ?? '', FS_UPLOAD_LIMIT);
    audit(req, `upload ${path}`);
    return send(res, 201, { path });
  }

  if (route('POST', /^\/api\/fs\/mkdir$/)) {
    const body = await readJson(req);
    return send(res, 201, { path: await makeDir(str(body.path, 'path', 1024)) });
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

  if (route('POST', /^\/api\/push\/status$/)) {
    return send(res, 200, { events: core.push.settings(str((await readJson(req)).endpoint, 'endpoint', 2048)) });
  }

  if (route('GET', /^\/api\/worktrees$/)) return send(res, 200, await core.worktrees());

  if (route('DELETE', /^\/api\/worktrees$/)) {
    const body = await readJson(req);
    const path = str(body.path, 'path', 1024);
    await core.removeWorktree(path, body.force === true);
    audit(req, `remove worktree ${path}${body.force ? ' (forced)' : ''}`);
    return send(res, 200, { ok: true });
  }

  if (route('GET', /^\/api\/prompts$/)) return send(res, 200, core.recentPrompts());

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/answer$/))) {
    const answer = (await readJson(req)).answer;
    if (answer !== 'approve' && answer !== 'deny') throw new HttpError(400, 'answer must be approve or deny');
    await core.answer(m[1], answer);
    audit(req, `${answer} ${m[1]}`);
    return send(res, 200, { ok: true });
  }

  if ((m = route('GET', /^\/api\/sessions\/([\w-]{1,40})\/queue$/))) return send(res, 200, core.queue(m[1]));

  if ((m = route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/queue(?:\/([\w-]{1,40}))?$/))) {
    core.clearQueue(m[1], m[2]);
    return send(res, 200, { ok: true });
  }

  if ((m = route('POST', /^\/api\/sessions\/([\w-]{1,40})\/pin$/))) {
    const body = await readJson(req);
    core.setPinned(m[1], body.pinned !== false);
    return send(res, 200, { ok: true });
  }

  if ((m = route('DELETE', /^\/api\/sessions\/([\w:.-]{1,80})$/))) {
    await core.forget(m[1]);
    return send(res, 200, { ok: true });
  }

  if (route('POST', /^\/api\/upload$/)) {
    // Files land on the host so agents can read them (screenshots from a phone, logs, etc.).
    const name = (url.searchParams.get('name') ?? 'upload').replace(/[^\w.-]+/g, '_').slice(-80) || 'upload';
    const body = await readBody(req, UPLOAD_LIMIT);
    await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    const file = join(UPLOAD_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
    await writeFile(file, body, { mode: 0o600 });
    audit(req, `upload ${file} (${body.length} bytes)`);
    return send(res, 201, { path: file });
  }

  if ((m = route('GET', /^\/api\/windows\/(@\d+)\/changes$/))) {
    const w = (await core.current()).windows.find((w) => w.id === m![1]);
    if (!w) throw new HttpError(404, 'window not found');
    return send(res, 200, await changes(expandHome(w.cwd)));
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
      const body = await readJson(req);
      const name = str(body.name, 'name', 80).trim();
      if (!name) throw new HttpError(400, 'name required');
      await t.renameWindow(id, name);
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }
    if (!m[2] && method === 'DELETE') {
      await t.killWindow(id);
      audit(req, `kill ${id}`);
      core.tick().catch(() => {});
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'not found');
}

function audit(req: IncomingMessage, msg: string) {
  const who = req.headers['tailscale-user-login'] ?? req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${who} ${msg}`);
}

// ---------- auth routes

async function authApi(req: IncomingMessage, res: ServerResponse, path: string, method: string, caller: Caller | null) {
  const route = (verb: string, re: RegExp) => (method === verb ? path.match(re) : null);
  const label = (b: Record<string, unknown>) => String(b.label ?? '').replace(/[^\w .·()-]/g, '').slice(0, 60);
  const isHost = caller?.kind === 'token' && caller.token.id === 'local';
  const signedIn = (cookie: { cookie: string } | null, body: unknown = { ok: true }) => {
    if (cookie) res.setHeader('set-cookie', cookie.cookie);
    return send(res, 200, body);
  };
  let m: RegExpMatchArray | null;

  if (route('GET', /^\/api\/auth\/status$/)) {
    return send(res, 200, { enabled: auth.enabled, enrolled: auth.enrolled, authenticated: !!caller, password: auth.overview(null).password });
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
  if (route('POST', /^\/api\/auth\/tokens$/)) {
    const body = await readJson(req);
    return send(res, 200, { token: auth.createToken(str(body.name, 'name', 60)) });
  }
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

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
  // Ignored over plain http; pins https once ah has been seen through tailscale serve.
  'strict-transport-security': 'max-age=31536000',
};

// ---------- static files

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
].join('; ');

async function serveStatic(res: ServerResponse, pathname: string) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = resolve(DIST, rel);
  if (!file.startsWith(DIST + '/')) file = join(DIST, 'index.html');
  let body = await readFile(file).catch(() => null);
  if (!body) {
    file = join(DIST, 'index.html');
    body = await readFile(file).catch(() => null);
  }
  if (!body) {
    res.writeHead(503, { 'content-type': 'text/plain' });
    return res.end('UI not built. Run `pnpm build`, or use `pnpm dev`.');
  }
  const immutable = rel.startsWith('assets/');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

// ---------- server

async function handle(req: IncomingMessage, res: ServerResponse) {
  if (!hostAllowed(req)) {
    res.writeHead(421, { 'content-type': 'text/plain' });
    return res.end(`Host not allowed. Add it to allowedHosts in ${CONFIG_PATH}.`);
  }
  if (!identityAllowed(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('This ah belongs to another Tailscale user.');
  }
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  let url = new URL(req.url ?? '/', 'http://x');
  try {
    const caller = auth.identify(req);
    // /h/<host>/… addresses a host: ourselves (served here) or a peer (proxied).
    const h = url.pathname.match(/^\/h\/([\w.-]{1,64})(\/.*)$/);
    if (h) {
      if (h[1] !== hostname()) {
        if (req.method !== 'GET' && (req.headers['x-ah'] !== '1' || !originAllowed(req))) throw new HttpError(403, 'forbidden');
        if (!caller) throw new HttpError(401, 'sign in required');
        const peer = peers.get(h[1]);
        if (!peer) throw new HttpError(502, `host ${h[1]} is offline`);
        return await proxyHttp(peer, h[2] + url.search, req, res);
      }
      url = new URL(h[2] + url.search, 'http://x');
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url, caller);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError || err instanceof CoreError || err instanceof AuthError || err instanceof FsError ? err.status : err instanceof GitError ? 400 : 500;
    if (status === 500) console.error(err);
    // A failure mid-stream (e.g. a download) can't be turned into a JSON error any more.
    if (res.headersSent) return res.destroy();
    const stderr = (err as { stderr?: string }).stderr;
    send(res, status, { error: stderr?.trim() || (err as Error).message });
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = safeDecode(url.pathname).match(/^(?:\/h\/([\w.-]{1,64}))?\/ws\/(@\d+)$/);
  if (!m || !hostAllowed(req) || !originAllowed(req) || !identityAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  const caller = auth.identify(req);
  if (!caller) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const [, host, windowId] = m;
  const peer = host && host !== hostname() ? peers.get(host) : null;
  if (host && host !== hostname() && !peer) {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
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

const peers = new Peers(config.peers, PORT);
core.peers = peers;
await Promise.all([addTailscaleHosts(), t.cleanupViewers(), tailnet().then((t) => (ownerLogin = t.login))]);
watchTailscale();
core.start();
if (!auth.enabled) {
  console.warn('⚠ auth is off ("auth": {"mode": "off"}): anyone who can reach this port gets a shell.');
} else if (!auth.enrolled) {
  const code = auth.issueCode('startup');
  console.log(`\n  Set up your first device: open ah and enter this one-time code (valid 10 minutes):\n\n      ${code}\n\n  Need another later? Run \`node bin/ah.js auth code\` on this machine.\n`);
}
peers.start();
const servers: ReturnType<typeof createServer>[] = [];
function listen(host: string) {
  const server = createServer(handle);
  server.on('upgrade', upgrade);
  server.listen(PORT, host, () => console.log(`ah listening on http://${host.includes(':') ? `[${host}]` : host}:${PORT}`));
  servers.push(server);
}

for (const h of HOSTS) {
  const host = h === 'tailscale' ? tailscaleIPv4 : h;
  if (!host) {
    console.error('host "tailscale" requested, but Tailscale is not running');
    process.exit(1);
  }
  listen(host);
}

// --tailscale: put ah on the tailnet over HTTPS with a foreground `tailscale serve`,
// which tailscale tears down again when ah exits.
let tsServe: ChildProcess | null = null;
if (args.includes('--tailscale')) {
  if (!HOSTS.some((h) => h === '127.0.0.1' || h === 'localhost')) listen('127.0.0.1');
  let fellBack = false;
  const onOutput = (chunk: Buffer) => {
    const text = chunk.toString();
    const url = text.match(/https:\/\/[^\s]+\.ts\.net\/?/)?.[0];
    if (url) console.log(`\n  ➜  ${url}   (tailnet only)\n`);
    if (/not enabled/i.test(text)) {
      const link = text.match(/https:\/\/login\.tailscale\.com\/\S+/)?.[0];
      console.log(`\nTailscale Serve isn't enabled on your tailnet yet. Enable it once at:\n  ${link}`);
      console.log('ah will switch to HTTPS automatically when you do.');
      // Stay reachable meanwhile: plain HTTP on the Tailscale IP (still WireGuard-encrypted).
      if (!fellBack && tailscaleIPv4 && !HOSTS.includes('tailscale') && !HOSTS.includes(tailscaleIPv4)) {
        fellBack = true;
        console.log(`Until then: http://${tailscaleIPv4}:${PORT}  (http, not https)\n`);
        listen(tailscaleIPv4);
      }
    } else if (!url && text.trim() && !/Press Ctrl\+C|^\|--|proxy http/m.test(text)) {
      process.stdout.write(`[tailscale] ${text}`);
    }
  };
  // Restarted if it dies (e.g. tailscaled not up yet at boot), backing off to a minute.
  let delay = 2000;
  const startServe = () => {
    const started = Date.now();
    const child = spawn('tailscale', ['serve', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
    tsServe = child;
    child.stdout!.on('data', onOutput);
    child.stderr!.on('data', onOutput);
    child.on('error', (err) => console.error(`tailscale serve failed: ${err.message}`));
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      if (Date.now() - started > 60_000) delay = 2000;
      console.error(`tailscale serve exited (${signal ?? code}); retrying in ${Math.round(delay / 1000)}s. ah is still on localhost.`);
      setTimeout(startServe, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  startServe();
} else if (HOSTS.every((h) => h === '127.0.0.1' || h === 'localhost')) {
  console.log('Put it on your tailnet (HTTPS, tailnet-only) with `pnpm serve`.');
}
console.log(`config: ${CONFIG_PATH}`);

let shuttingDown = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    tsServe?.kill('SIGINT');
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    for (const server of servers) server.close();
    setTimeout(() => process.exit(0), 200);
  });
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
