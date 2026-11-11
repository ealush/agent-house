// Compressed static files. The page reaches ah over Tailscale from a phone or an iPad, where
// the bytes are what a cold load waits on: the main chunk is ~490 KB as built and ~130 KB
// in brotli. Each file is compressed once per content (a rebuild changes it) and kept.
import { brotliCompress, gzip, constants } from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

const br = promisify(brotliCompress);
const gz = promisify(gzip);

export type Encoding = 'br' | 'gzip';

/** Text, which compresses; fonts (woff2) and images already are. */
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|manifest\+json|javascript)|image\/svg\+xml)/;
/** Below this, the header costs about what compression saves. */
const MIN_BYTES = 1024;

/** What the client takes, best first: brotli, then gzip; an explicit q=0 refuses one. */
export function pickEncoding(accept: string | undefined): Encoding | null {
  if (!accept) return null;
  const q = new Map<string, number>();
  for (const part of accept.toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    const weight = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    q.set(name.trim(), weight ? Number(weight.slice(2)) || 0 : 1);
  }
  const takes = (e: string) => (q.get(e) ?? q.get('*') ?? 0) > 0;
  if (takes('br')) return 'br';
  if (takes('gzip')) return 'gzip';
  return null;
}

export const compressible = (type: string) => COMPRESSIBLE.test(type);

const cache = new Map<string, { hash: string; br?: Promise<Buffer>; gzip?: Promise<Buffer> }>();

/** The body to send for `file` (its bytes `body`, of `type`), and its encoding, or the bytes as they are. */
export async function encoded(file: string, body: Buffer, type: string, accept: string | undefined): Promise<{ body: Buffer; encoding: Encoding | null }> {
  const encoding = compressible(type) && body.length >= MIN_BYTES ? pickEncoding(accept) : null;
  if (!encoding) return { body, encoding: null };
  const hash = createHash('sha1').update(body).digest('hex');
  let entry = cache.get(file);
  if (!entry || entry.hash !== hash) cache.set(file, (entry = { hash }));
  entry[encoding] ??=
    encoding === 'br'
      ? br(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: body.length } })
      : gz(body, { level: 9 });
  try {
    return { body: await entry[encoding]!, encoding };
  } catch {
    delete entry[encoding];
    return { body, encoding: null };
  }
}
