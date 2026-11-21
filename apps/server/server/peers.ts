// Other machines running ah (F4: local is just a host). Every host runs the same
// daemon; whichever one the browser opened proxies the others under /h/<name>/,
// so the UI talks to a single origin and peers never need to accept browsers.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { WebSocket, type RawData } from 'ws';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Tokens other hosts issued to us (`ah auth token <name>` on the peer, then
 * `ah peers trust <peer> <token>` here). Peers stay locked to everyone else.
 */
export const PEER_TOKENS_FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'peer-tokens.json');

function peerTokens(): Record<string, string> {
  try {
    return existsSync(PEER_TOKENS_FILE) ? JSON.parse(readFileSync(PEER_TOKENS_FILE, 'utf8')) : {};
  } catch {
    return {};
  }
}

const exec = promisify(execFile);

export type PeerConfig = { name: string; url: string; token?: string };
export type Peer = { name: string; url: string; online: boolean; checkedAt: number; token?: string };

const PROBE_MS = 30_000;
const TIMEOUT_MS = 2000;

/** Our own Tailscale identity, and the machines owned by the same user. */
export async function tailnet(): Promise<{ login: string | null; candidates: Array<{ name: string; dns: string; ip: string }> }> {
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 5000 });
    const s = JSON.parse(stdout);
    const me = s.Self?.UserID;
    const login = s.User?.[me]?.LoginName ?? null;
    const candidates = Object.values<any>(s.Peer ?? {})
      // Phones and tablets are clients, not hosts.
      .filter((p) => p.UserID === me && p.Online && !['iOS', 'android'].includes(p.OS))
      .map((p) => ({ name: p.HostName as string, dns: String(p.DNSName ?? '').replace(/\.$/, ''), ip: (p.TailscaleIPs ?? []).find((i: string) => !i.includes(':')) }));
    return { login, candidates };
  } catch {
    return { login: null, candidates: [] };
  }
}

/** Peers are reached over https (their own `tailscale serve`), or loopback http for local setups/tests. */
export function peerUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname));
  } catch {
    return false;
  }
}

async function hello(url: string): Promise<boolean> {
  if (!peerUrlAllowed(url)) return false;
  try {
    // Never follow redirects: a peer must answer as itself.
    const res = await fetch(`${url}/api/hello`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    return res.ok && (await res.json()).ah === true;
  } catch {
    return false;
  }
}

export class Peers {
  private peers = new Map<string, Peer>();
  private configured: PeerConfig[] | 'auto';
  private port: number;

  constructor(configured: PeerConfig[] | 'auto', port: number) {
    this.configured = configured;
    this.port = port;
  }

  start() {
    const loop = () => this.probe().finally(() => setTimeout(loop, PROBE_MS));
    loop();
  }

  list(): Peer[] {
    return [...this.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Peer | undefined {
    const p = this.peers.get(name);
    return p?.online ? p : undefined;
  }

  private async probe() {
    let candidates: PeerConfig[][];
    if (this.configured === 'auto') {
      // Only the peer's `tailscale serve` HTTPS endpoint; peers never listen on their tailnet IP.
      const { candidates: found } = await tailnet();
      candidates = found.filter((c) => c.dns).map((c) => [{ name: c.name, url: `https://${c.dns}` }]);
    } else {
      candidates = this.configured.map((c) => [c]);
    }
    const tokens = peerTokens();
    const seen = new Set<string>();
    await Promise.all(
      candidates.map(async (urls) => {
        for (const c of urls) {
          if (await hello(c.url)) {
            this.peers.set(c.name, { name: c.name, url: c.url, online: true, checkedAt: Date.now(), token: c.token ?? tokens[c.name] });
            seen.add(c.name);
            return;
          }
        }
      }),
    );
    for (const p of this.peers.values()) if (!seen.has(p.name)) p.online = false;
  }
}

// ---------- proxying

const FORWARD_REQ = ['content-type', 'x-ah', 'accept'];
const FORWARD_RES = ['content-type', 'content-disposition', 'content-length', 'cache-control', 'content-security-policy', 'x-content-type-options'];

/** Streams one HTTP request to a peer and its response back (SSE included). */
export async function proxyHttp(peer: Peer, path: string, req: IncomingMessage, res: ServerResponse) {
  const target = new URL(path, peer.url);
  const headers: Record<string, string> = { origin: new URL(peer.url).origin };
  // The browser's own session is ours; the peer only trusts the token it issued us.
  if (peer.token) headers.authorization = `Bearer ${peer.token}`;
  for (const h of FORWARD_REQ) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h] as string;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  // Abort upstream only if our client goes away before the response is done
  // (req 'close' fires as soon as the request body has been read).
  const ctrl = new AbortController();
  res.on('close', () => !res.writableFinished && ctrl.abort());
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
    // @ts-expect-error duplex is required by undici for streamed request bodies
    duplex: hasBody ? 'half' : undefined,
    signal: ctrl.signal,
    // Never follow redirects: they could carry our token somewhere else.
    redirect: 'manual',
  });
  const out: Record<string, string> = {};
  // fetch hands the body over decoded, so a compressed answer's length no longer fits it.
  const decoded = !!upstream.headers.get('content-encoding');
  for (const h of FORWARD_RES) {
    const v = upstream.headers.get(h);
    if (v && !(decoded && h === 'content-length')) out[h] = v;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body as never)
    .on('error', () => res.destroy())
    .pipe(res);
}

/** Bridges a browser WebSocket to the peer's terminal socket. */
export function proxyWs(peer: Peer, path: string, client: WebSocket) {
  const url = new URL(path, peer.url);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const upstream = new WebSocket(url, {
    followRedirects: false,
    maxPayload: 4 * 1024 * 1024, headers: { origin: new URL(peer.url).origin, ...(peer.token ? { authorization: `Bearer ${peer.token}` } : {}) } });
  const pending: Array<[RawData, boolean]> = [];
  client.on('message', (data, binary) => (upstream.readyState === WebSocket.OPEN ? upstream.send(data, { binary }) : pending.push([data, binary])));
  upstream.on('open', () => {
    for (const [data, binary] of pending.splice(0)) upstream.send(data, { binary });
  });
  upstream.on('message', (data, binary) => client.readyState === WebSocket.OPEN && client.send(data, { binary }));
  const closeBoth = (code?: number, reason?: Buffer) => {
    const c = code && code >= 3000 ? code : 1011;
    if (client.readyState === WebSocket.OPEN) client.close(code === 1000 ? 1000 : c, reason?.toString());
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
  };
  upstream.on('close', closeBoth);
  upstream.on('error', () => closeBoth(1011));
  client.on('error', () => upstream.terminate());
  client.on('close', () => upstream.terminate());
}

/**
 * A request to a peer as this host (a migration's calls), with the same rules as the
 * proxy: only the token that peer issued us, its exact origin, X-AH on writes, never
 * a redirect. `body` may be a file stream (sent with its length, never buffered).
 */
export async function peerFetch(peer: Peer, path: string, init: { method?: string; json?: unknown; body?: Readable; length?: number; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Response> {
  if (!peerUrlAllowed(peer.url)) throw new Error(`${peer.name}'s address isn't https (or loopback)`);
  const method = init.method ?? (init.json !== undefined || init.body ? 'POST' : 'GET');
  const headers: Record<string, string> = { origin: new URL(peer.url).origin, accept: 'application/json', ...init.headers };
  if (peer.token) headers.authorization = `Bearer ${peer.token}`;
  if (method !== 'GET') headers['x-ah'] = '1';
  if (init.json !== undefined) headers['content-type'] = 'application/json';
  if (init.body) {
    headers['content-type'] = 'application/octet-stream';
    if (init.length !== undefined) headers['content-length'] = String(init.length);
  }
  return fetch(new URL(path, peer.url), {
    method,
    headers,
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body ? (Readable.toWeb(init.body) as ReadableStream) : undefined,
    // @ts-expect-error duplex is required by undici for streamed request bodies
    duplex: init.body ? 'half' : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
  });
}
