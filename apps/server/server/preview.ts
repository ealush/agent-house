// Browser preview: a session's dev server (Storybook, Vite, Next…) shown in ah.
// The server runs on this host at localhost:<target>; a device on the tailnet
// can't reach that, so each preview gets its own small proxy on a spare
// loopback port P, published by `tailscale serve` as https://<node>.ts.net:P.
//
// A port of its own, not a path under ah, because dev servers assume they live
// at "/": their assets, client scripts and live-reload sockets all ask for root
// paths. A port is also another origin, so the previewed page can't touch ah's.
//
// The proxy is ah, not a bare forward: it requires the same sign-in as ah (the
// session cookie is host-wide, so it arrives here too) and Serve's owner
// identity, then forwards without that cookie so the dev server never sees it,
// and with Host/Origin rewritten to localhost so the dev server's own host
// checks pass. Only ah's page may frame it.
import { createServer, request, type IncomingMessage, type Server, type ServerResponse, type IncomingHttpHeaders } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Cookies that are ah's own sign-in: never forwarded to, or set by, a previewed app. */
export const AH_COOKIES = new Set(['ah_session', '__Host-ah_session']);

export type PreviewDeps = {
  /** Gate + sign-in, as for ah itself. Null when allowed, else the status and reason. */
  authorize: (req: IncomingMessage) => { status: number; reason: string } | null;
  /** Origins allowed to frame a preview: ah's own. */
  frameAncestors: () => string[];
  /** Publishes a loopback port on the tailnet (`tailscale serve`), or null when there is no tailnet. */
  publish: { add: (port: number) => Promise<void>; remove: (port: number) => Promise<void> } | null;
  /** Ports previews may listen on, inclusive. */
  range: [number, number];
};

export type Preview = { uid: string; target: number; port: number; published: boolean };

type Open = Preview & { server: Server };

/** Request headers for the dev server: no ah cookie, no Tailscale identity, Host and Origin as if local. */
export function upstreamHeaders(h: IncomingHttpHeaders, target: number): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || k.startsWith('tailscale-')) continue;
    out[k] = v;
  }
  const cookie = typeof h.cookie === 'string' ? stripCookies(h.cookie) : '';
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  out.host = `localhost:${target}`;
  if (h.origin) out.origin = `http://localhost:${target}`;
  if (typeof h.referer === 'string') {
    try {
      const r = new URL(h.referer);
      out.referer = `http://localhost:${target}${r.pathname}${r.search}`;
    } catch {
      delete out.referer;
    }
  }
  return out;
}

export function stripCookies(header: string): string {
  return header
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !AH_COOKIES.has(c.split('=')[0].trim()))
    .join('; ');
}

/**
 * Who may frame a preview: ah's page, and the preview itself. The second matters
 * because frame-ancestors covers every ancestor: Storybook draws each story in an
 * iframe of its own page, which sits inside ah's frame.
 */
export const frameAncestors = (ah: string[]) => `frame-ancestors 'self' ${ah.join(' ')}`;

/**
 * Response headers back to the browser: framable by ah only, and no cookie that
 * would overwrite ah's sign-in (cookies ignore ports, so the app could otherwise).
 */
export function downstreamHeaders(h: IncomingHttpHeaders, ancestors: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || k === 'x-frame-options') continue;
    out[k] = v;
  }
  const frame = frameAncestors(ancestors);
  const csp = h['content-security-policy'];
  out['content-security-policy'] =
    typeof csp === 'string' && csp.trim()
      ? [...csp.split(';').map((d) => d.trim()).filter((d) => d && !/^frame-ancestors\b/i.test(d)), frame].join('; ')
      : frame;
  const cookies = h['set-cookie'];
  if (cookies) {
    const kept = cookies.filter((c) => !AH_COOKIES.has(c.split('=')[0].trim()));
    if (kept.length) out['set-cookie'] = kept;
    else delete out['set-cookie'];
  }
  return out;
}

const page = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>` +
  `<style>body{font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#111316;color:#ececed}` +
  `div{max-width:28em;padding:24px;text-align:center}p{color:#9a9ea6}</style><div><h3>${title}</h3><p>${body}</p></div>`;

export class Previews {
  private open = new Map<string, Open>();
  private deps: PreviewDeps;

  constructor(deps: PreviewDeps) {
    this.deps = deps;
  }

  get(uid: string): Preview | null {
    const p = this.open.get(uid);
    return p ? { uid: p.uid, target: p.target, port: p.port, published: p.published } : null;
  }

  list(): Preview[] {
    return [...this.open.keys()].map((uid) => this.get(uid)!);
  }

  /** One preview per session: a new target keeps its port (the pane's URL stays). */
  async start(uid: string, target: number): Promise<Preview> {
    if (!Number.isInteger(target) || target < 1 || target > 65535) throw new Error('invalid port');
    const used = new Set([...this.open.values()].map((p) => p.port));
    if (used.has(target) || (target >= this.deps.range[0] && target <= this.deps.range[1])) throw new Error('that port is a preview itself');
    const existing = this.open.get(uid);
    if (existing) {
      existing.target = target;
      return this.get(uid)!;
    }
    const entry = { uid, target, port: 0, published: false } as Open;
    entry.server = createServer((req, res) => this.http(entry, req, res));
    entry.server.on('upgrade', (req, socket, head) => this.upgrade(entry, req, socket, head));
    entry.port = await this.listen(entry.server, used);
    this.open.set(uid, entry);
    if (this.deps.publish) {
      try {
        await this.deps.publish.add(entry.port);
        entry.published = true;
      } catch (err) {
        console.warn(`preview: couldn't publish port ${entry.port} on the tailnet: ${(err as Error).message}`);
      }
    }
    return this.get(uid)!;
  }

  async stop(uid: string): Promise<void> {
    const p = this.open.get(uid);
    if (!p) return;
    this.open.delete(uid);
    p.server.closeAllConnections?.();
    await new Promise<void>((r) => p.server.close(() => r()));
    if (p.published) await this.deps.publish?.remove(p.port).catch(() => {});
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((uid) => this.stop(uid)));
  }

  private async listen(server: Server, used: Set<number>): Promise<number> {
    const [lo, hi] = this.deps.range;
    for (let port = lo; port <= hi; port++) {
      if (used.has(port)) continue;
      const ok = await new Promise<boolean>((resolve) => {
        const fail = () => resolve(false);
        server.once('error', fail);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', fail);
          resolve(true);
        });
      });
      if (ok) return (server.address() as AddressInfo).port;
    }
    throw new Error(`no free preview port in ${lo}–${hi}`);
  }

  private http(p: Open, req: IncomingMessage, res: ServerResponse) {
    const denied = this.deps.authorize(req);
    if (denied) {
      res.writeHead(denied.status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': frameAncestors(this.deps.frameAncestors()) });
      return res.end(page('Sign in to ah first', 'This preview is part of your ah. Open ah on this device and sign in, then reload.'));
    }
    const up = request({ host: '127.0.0.1', port: p.target, method: req.method, path: req.url, headers: upstreamHeaders(req.headers, p.target) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.statusMessage, downstreamHeaders(r.headers, this.deps.frameAncestors()));
      r.pipe(res);
    });
    up.on('error', () => {
      if (res.headersSent) return res.destroy();
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': frameAncestors(this.deps.frameAncestors()) });
      res.end(page(`Nothing on port ${p.target} yet`, `Start the dev server in this session (it should listen on localhost:${p.target}), then reload.`));
    });
    req.pipe(up);
  }

  /** Live reload (Vite, webpack, Storybook): the WebSocket handshake goes through as-is, rewritten the same way. */
  private upgrade(p: Open, req: IncomingMessage, socket: Duplex, head: Buffer) {
    if (this.deps.authorize(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    const up = connect(p.target, '127.0.0.1', () => {
      const headers = upstreamHeaders(req.headers, p.target);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on('error', end);
    socket.on('error', end);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
  }
}

const exec = promisify(execFile);

/**
 * Publishes preview ports with `tailscale serve`, next to ah's own 443 mapping
 * (needs Tailscale's operator permission, as `tailscale serve` for ah itself does).
 */
export const tailscalePublish = {
  add: async (port: number) => {
    await exec('tailscale', ['serve', '--bg', '--yes', `--https=${port}`, `http://127.0.0.1:${port}`], { timeout: 15_000 });
  },
  remove: async (port: number) => {
    await exec('tailscale', ['serve', '--yes', `--https=${port}`, 'off'], { timeout: 15_000 });
  },
};

/**
 * Preview mappings a previous ah left behind (a crash skips stop()): a port in
 * the preview range proxied to the same loopback port is ours. Anything else in
 * the Serve config is left alone.
 */
export function staleMappings(status: unknown, range: [number, number]): number[] {
  const web = (status as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> })?.Web ?? {};
  const out: number[] = [];
  for (const [hostPort, cfg] of Object.entries(web)) {
    const port = Number(hostPort.split(':').pop());
    if (!(port >= range[0] && port <= range[1])) continue;
    if (cfg.Handlers?.['/']?.Proxy === `http://127.0.0.1:${port}`) out.push(port);
  }
  return out;
}

export async function removeStaleMappings(range: [number, number]): Promise<void> {
  try {
    const { stdout } = await exec('tailscale', ['serve', 'status', '--json'], { timeout: 5000 });
    for (const port of staleMappings(JSON.parse(stdout || '{}'), range)) await tailscalePublish.remove(port).catch(() => {});
  } catch {
    // No tailscale, or no Serve config: nothing to clean.
  }
}
