// Small request/response helpers shared by the routes.
import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'body too large');
    chunks.push(chunk);
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
