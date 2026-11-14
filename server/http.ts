// Small request/response helpers shared by the routes.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { brotliCompress, gzip, constants } from 'node:zlib';
import { pickEncoding } from './compress.ts';

export class HttpError extends Error {
  status: number;
  /** A stable machine-readable reason, sent beside the message as `code` (clients branch on it, not on wording). */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    if (code) this.code = code;
  }
}

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

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  // The server has no whole-request timeout (a long upload must not be cut), so a
  // small body that stops arriving is dropped here.
  const timer = setTimeout(() => req.destroy(new HttpError(408, 'request body timed out')), BODY_MS);
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

export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, 64 * 1024);
  try {
    const v = JSON.parse(body.toString() || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export function str(v: unknown, field: string, max = 200): string {
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, `invalid ${field}`);
  return v;
}

export function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
