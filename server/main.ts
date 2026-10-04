import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hostname, homedir } from 'node:os';
import { join, extname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { loadConfig, expandHome, isExecutableOnPath, CONFIG_PATH } from './config.ts';
import { buildWindows as build, shortPath } from './sessions.ts';
import { Registry } from './registry.ts';
import { attach, viewerCounts } from './terminal.ts';
import * as t from './tmux.ts';

const config = loadConfig();
const registry = new Registry();

// Concurrent requests share one tmux/proc scan (and never double-register a window).
let inflight: ReturnType<typeof build> | null = null;
function buildWindows() {
  inflight ??= build(config, viewerCounts, registry).finally(() => (inflight = null));
  return inflight;
}
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
async function addTailscaleHosts() {
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
  } catch {
    // Tailscale not installed or not running; localhost still works.
  }
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

const WINDOW_ID = /^@\d+$/;
const UPLOAD_DIR = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ah', 'uploads');
const UPLOAD_LIMIT = 50 * 1024 * 1024;

async function resolveDir(input: string): Promise<string> {
  const dir = resolve(expandHome(input.trim() || '~'));
  const s = await stat(dir).catch(() => null);
  if (!s?.isDirectory()) throw new HttpError(400, `not a directory: ${input}`);
  return dir;
}

let tmuxPath = process.env.PATH ?? '';
async function refreshTmuxPath() {
  // Agents launch inside tmux shells, so check availability against tmux's PATH.
  try {
    const out = await t.tmux('show-environment', '-g', 'PATH');
    tmuxPath = out.trim().replace(/^PATH=/, '') + ':' + (process.env.PATH ?? '');
  } catch {
    // no tmux server yet
  }
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

// ---------- API

async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
  const method = req.method ?? 'GET';
  if (method !== 'GET') {
    // A custom header can't be sent cross-site without a CORS preflight we never answer.
    if (req.headers['x-ah'] !== '1' || !originAllowed(req)) throw new HttpError(403, 'forbidden');
  }

  if (url.pathname === '/api/state' && method === 'GET') {
    const windows = await buildWindows();
    const sessions = await t.listSessions();
    return send(res, 200, {
      hostname: hostname(),
      defaultSession: config.defaultSession,
      sessions,
      windows,
      ended: registry.ended().slice(0, 30).map((r) => ({ ...r, cwd: shortPath(r.cwd) })),
      presets: config.presets.map((p) => ({ ...p, available: isExecutableOnPath(p.command, tmuxPath) })),
    });
  }

  if (url.pathname === '/api/projects' && method === 'GET') {
    const windows = await buildWindows();
    return send(res, 200, await projectSuggestions([...new Set(windows.map((w) => w.projectPath))]));
  }

  if (url.pathname === '/api/windows' && method === 'POST') {
    const body = await readJson(req);
    const preset = config.presets.find((p) => p.id === body.preset);
    if (!preset) throw new HttpError(400, 'unknown preset');
    const cwd = await resolveDir(str(body.cwd ?? '~', 'cwd', 1024));
    const session = t.sanitizeSessionName(str(body.session || config.defaultSession, 'session', 64));
    if (!session) throw new HttpError(400, 'invalid session');
    const label = str(body.label ?? '', 'label', 80).trim();
    const name = label || (preset.command ? preset.id : basename(cwd) || 'shell');

    const command = body.resume && preset.resume ? preset.resume : preset.command;
    const id = await launch({ session, cwd, name, preset: preset.id, command, uid: preset.command ? Registry.newId() : null });
    audit(req, `create ${id} preset=${preset.id} session=${session} cwd=${cwd}`);
    await refreshTmuxPath();
    return send(res, 201, { id });
  }

  const s = url.pathname.match(/^\/api\/sessions\/([\w-]{1,40})(\/resume)?$/);
  if (s) {
    const rec = registry.get(s[1]);
    if (!rec) throw new HttpError(404, 'session not found');
    if (s[2] && method === 'POST') {
      if (!rec.endedAt) throw new HttpError(409, 'session is still running');
      const preset = config.presets.find((p) => p.id === rec.harness);
      if (!preset) throw new HttpError(400, `no preset for ${rec.harness}`);
      // Exact conversation when hooks told us its id, else "most recent in this directory".
      const command =
        rec.harnessId && preset.resumeId ? preset.resumeId.replace('{id}', rec.harnessId) : preset.resume ?? preset.command;
      const cwd = await resolveDir(rec.cwd).catch(() => resolveDir('~'));
      const session = (await t.hasSession(rec.tmuxSession)) ? rec.tmuxSession : config.defaultSession;
      const id = await launch({ session, cwd, name: rec.name, preset: preset.id, command, uid: rec.uid });
      audit(req, `resume ${rec.uid} as ${id}: ${command}`);
      return send(res, 201, { id });
    }
    if (!s[2] && method === 'DELETE') {
      registry.remove(rec.uid);
      return send(res, 200, { ok: true });
    }
  }

  if (url.pathname === '/api/upload' && method === 'POST') {
    // Files land on the host so agents can read them (screenshots from a phone, logs, etc.).
    const name = (url.searchParams.get('name') ?? 'upload').replace(/[^\w.-]+/g, '_').slice(-80) || 'upload';
    const body = await readBody(req, UPLOAD_LIMIT);
    await mkdir(UPLOAD_DIR, { recursive: true, mode: 0o700 });
    const file = join(UPLOAD_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
    await writeFile(file, body, { mode: 0o600 });
    audit(req, `upload ${file} (${body.length} bytes)`);
    return send(res, 201, { path: file });
  }

  const m = safeDecode(url.pathname).match(/^\/api\/windows\/(@\d+)(\/capture)?$/);
  if (m && WINDOW_ID.test(m[1])) {
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
      return send(res, 200, { ok: true });
    }
    if (!m[2] && method === 'DELETE') {
      await t.killWindow(id);
      audit(req, `kill ${id}`);
      return send(res, 200, { ok: true });
    }
  }

  throw new HttpError(404, 'not found');
}

async function launch(o: { session: string; cwd: string; name: string; preset: string; command: string; uid: string | null }) {
  const id = await t.createWindow({ session: o.session, cwd: o.cwd, name: o.name });
  const now = String(Math.floor(Date.now() / 1000));
  await t.setWindowOption(id, '@ah-agent', o.preset);
  await t.setWindowOption(id, '@ah-created', now);
  await t.setWindowOption(id, '@ah-seen', now);
  if (o.uid) {
    await t.setWindowOption(id, '@ah-uid', o.uid);
    registry.upsert(o.uid, { tmuxSession: o.session, windowId: id, name: o.name, cwd: o.cwd, harness: o.preset, status: 'busy' });
  }
  if (o.command) await t.sendLine(id, o.command);
  return id;
}

function audit(req: IncomingMessage, msg: string) {
  const who = req.headers['tailscale-user-login'] ?? req.socket.remoteAddress;
  console.log(`[${new Date().toISOString()}] ${who} ${msg}`);
}

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
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
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
  const url = new URL(req.url ?? '/', 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await serveStatic(res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) console.error(err);
    const stderr = (err as { stderr?: string }).stderr;
    send(res, status, { error: stderr?.trim() || (err as Error).message });
  }
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const url = new URL(req.url ?? '/', 'http://x');
  const m = safeDecode(url.pathname).match(/^\/ws\/(@\d+)$/);
  if (!m || !hostAllowed(req) || !originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const cols = Number(url.searchParams.get('cols'));
    const rows = Number(url.searchParams.get('rows'));
    attach(ws, m[1], cols, rows).catch((err) => {
      console.error(err);
      ws.close(1011, 'attach failed');
    });
  });
}

await Promise.all([addTailscaleHosts(), refreshTmuxPath(), t.cleanupViewers()]);
const servers = HOSTS.map((h) => {
  const host = h === 'tailscale' ? tailscaleIPv4 : h;
  if (!host) {
    console.error('host "tailscale" requested, but Tailscale is not running');
    process.exit(1);
  }
  const server = createServer(handle);
  server.on('upgrade', upgrade);
  server.listen(PORT, host, () => console.log(`ah listening on http://${host.includes(':') ? `[${host}]` : host}:${PORT}`));
  return server;
});
if (HOSTS.every((h) => h === '127.0.0.1' || h === 'localhost')) {
  console.log('Expose it to your tailnet (HTTPS, tailnet-only) with:');
  console.log(`  tailscale serve --bg ${PORT}`);
}
console.log(`config: ${CONFIG_PATH}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
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
