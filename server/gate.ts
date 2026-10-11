// Who may talk to ah at all, before authentication: which Host names, which
// Origins, and — for requests that came through `tailscale serve` — which
// Tailscale identity. ah only listens on loopback, so a request either comes
// from this machine directly, or through Serve (Host = this node's ts.net name).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IncomingMessage } from 'node:http';

const exec = promisify(execFile);

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1']);
export const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);

export type Tailnet = { dnsName: string; owner: string };

/** This node's MagicDNS name and owner's login, from tailscale (or env overrides, for tests). */
export async function readTailnet(): Promise<Tailnet | null> {
  if (process.env.AH_TAILNET_DNS && process.env.AH_TAILNET_OWNER) {
    return { dnsName: process.env.AH_TAILNET_DNS, owner: process.env.AH_TAILNET_OWNER };
  }
  try {
    const { stdout } = await exec('tailscale', ['status', '--json'], { timeout: 5000 });
    const s = JSON.parse(stdout);
    const dnsName = String(s.Self?.DNSName ?? '').replace(/\.$/, '');
    const owner = s.User?.[s.Self?.UserID]?.LoginName;
    return dnsName && owner ? { dnsName, owner } : null;
  } catch {
    return null;
  }
}

export function hostOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function parseOrigin(value: string | undefined): { hostname: string; port: number; https: boolean } | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const https = u.protocol === 'https:';
    return { hostname: u.hostname.replace(/^\[|\]$/g, '').toLowerCase(), port: Number(u.port) || (https ? 443 : 80), https };
  } catch {
    return null;
  }
}

/** The explicit port in a Host header, if any. */
function portOf(host: string | undefined): number | null {
  if (!host) return null;
  try {
    return Number(new URL(`http://${host}`).port) || null;
  } catch {
    return null;
  }
}

export type Verdict = { ok: true; via: 'local' | 'serve' } | { ok: false; status: number; reason: string };

export class Gate {
  tailnet: Tailnet | null = null;

  /** Keeps retrying until Tailscale answers (ah can start before tailscaled at boot). */
  watch() {
    const tick = async () => {
      const t = await readTailnet();
      if (t) this.tailnet = t;
      setTimeout(tick, t ? 5 * 60_000 : 5_000).unref();
    };
    return tick();
  }

  private isServeHost(h: string | null): boolean {
    return !!h && !!this.tailnet && h === this.tailnet.dnsName.toLowerCase();
  }

  private known(h: string | null): boolean {
    return !!h && (LOOPBACK_NAMES.has(h) || this.isServeHost(h));
  }

  /**
   * Host allowlist (DNS rebinding) + Serve identity. A request addressed to the
   * ts.net name can only have arrived through Serve, which strips client-sent
   * Tailscale-User-* headers and sets them for user-owned devices — so it must
   * carry the owner's login. Fail closed when the owner can't be determined, and
   * for tagged devices (no identity). Loopback requests never consult the header.
   */
  check(req: IncomingMessage): Verdict {
    const host = hostOf(req.headers.host);
    if (!this.known(host)) return { ok: false, status: 421, reason: 'host not allowed' };
    if (this.isServeHost(host)) {
      const who = req.headers['tailscale-user-login'];
      if (!this.tailnet?.owner) return { ok: false, status: 503, reason: 'tailscale identity unavailable' };
      if (who !== this.tailnet.owner) return { ok: false, status: 403, reason: 'this ah belongs to another Tailscale user' };
      return { ok: true, via: 'serve' };
    }
    return { ok: true, via: 'local' };
  }

  /**
   * Writes and WebSockets must come from a page served by ah itself: the Origin
   * is the exact host and port this request was addressed to. A known name is not
   * enough. Another port on the same name is another site's page (a dev server, a
   * preview), and a WebSocket has no preflight to stop it from driving a terminal.
   */
  originOk(req: IncomingMessage): boolean {
    const origin = parseOrigin(req.headers.origin);
    const host = hostOf(req.headers.host);
    if (!origin || !host || origin.hostname !== host || !this.known(host)) return false;
    // Serve terminates TLS on 443 and forwards the bare name; locally ah speaks plain
    // http and the Host carries the port.
    const serve = this.isServeHost(host);
    const addressed = portOf(req.headers.host) ?? (serve ? 443 : 80);
    return origin.https === serve && origin.port === addressed;
  }
}
