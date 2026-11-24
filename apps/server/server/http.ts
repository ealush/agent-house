// Small request/response helpers shared by the routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { pickEncoding } from './compress.ts';
import { DomainError } from './errors.ts';

/** The HTTP layer's own refusals (a malformed body, a missing route): a DomainError like any other. */
export class HttpError extends DomainError {}

/** How long a small (JSON) body may take to arrive. Uploads have their own idle limit (server/uploads.ts). */
const BODY_MS = 30_000;

/**
 * JSON over 1 KB goes compressed to a client that takes it: the state alone is
 * ~40 KB (9 KB in gzip), and phones fetch it over Tailscale on every return to
 * the page. Brotli at a low quality: fast, and still smaller than gzip.
 */
export function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  const encoding = json && json.length >= 1024 ? pickEncoding(res.req?.headers['accept-encoding']) : null;
  const plain = () => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(json);
  };
  if (!encoding) return plain();
  const done = (err: Error | null, out: Buffer) => {
    if (res.headersSent || res.destroyed) return;
    if (err) return plain();
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-encoding': encoding, vary: 'accept-encoding' });
    res.end(out);
  };
  if (encoding === 'br') brotliCompress(json, { params: { [constants.BROTLI_PARAM_QUALITY]: 4, [constants.BROTLI_PARAM_SIZE_HINT]: json.length } }, done);
  else gzip(json, done);
}

/** `ms`: how long the whole body may take (a recording on a phone's connection needs more). */
export async function readBody(req: IncomingMessage, limit: number, ms = BODY_MS): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  // The server has no whole-request timeout (a long upload must not be cut), so a
  // small body that stops arriving is dropped here.
  const timer = setTimeout(() => req.destroy(new HttpError(408, 'request body timed out')), ms);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'body too large');
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'request body ended early');
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(chunks);
}

/**
 * The longest message for an agent (a send, its draft, a fork's prompt), in characters:
 * a pasted spec fits. Under the feed's 256K for a turn (`feed/parts.ts`), so it comes back
 * whole, in an event line under the app's 1 MiB.
 */
export const MESSAGE_MAX = 128 * 1024;
/** A body carrying one: six bytes a character at most (a control character, escaped `\u0001`), plus the JSON around it. */
export const MESSAGE_BODY = 6 * MESSAGE_MAX + 4 * 1024;

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit);
  try {
    const v = JSON.parse(body.toString() || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string') throw new HttpError(400, `invalid ${field}`);
  if (v.length > max) throw new HttpError(400, `${field} too long: ${v.length.toLocaleString('en-US')} characters, at most ${max.toLocaleString('en-US')}`, 'too_long');
  return v;
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * One server-sent event. A client that stopped reading (a phone asleep behind
 * tailscale serve, a stalled proxy) would otherwise buffer every patch and feed
 * append in memory without limit: past 8 MB unread, drop it; it reconnects and
 * gets a fresh snapshot.
 */
export function sse(res: ServerResponse, chunk: string) {
  if (res.destroyed) return;
  if (res.writableLength > 8 * 1024 * 1024) return void res.destroy();
  res.write(chunk);
}

/** Extracts the acting session uid from `X-AH-Session` when a CLI/session calls the daemon. */
export function actorUid(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const raw = req.headers['x-ah-session'];
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[\w-]{1,40}$/.test(s) ? s : null;
}

/** Extracts the per-session launch secret from `X-AH-Session-Token` (when present). */
export function actorToken(req: { headers: Record<string, string | string[] | undefined> }): string | null {
  const raw = req.headers['x-ah-session-token'];
  const s = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{16,128}$/.test(s) ? s : null;
}
