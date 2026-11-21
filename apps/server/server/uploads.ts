// Uploads, streamed: a phone's screen recording runs to hundreds of megabytes, so
// a body is written to disk as it arrives and never held in memory. Each upload
// goes to a hidden `.part` file first and takes its name only once every byte is
// in, so a cut connection, a refused size or a crash never leaves a half file
// under a real name. Limits are explicit and configurable (`uploads` in config):
// one file's size, the total ah's own upload folder may hold, and the free space
// that must stay on the disk.
import { link, open, readdir, rm, stat, statfs } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import { DomainError } from './errors.ts';

export type UploadLimits = {
  /** Largest single upload. */
  maxBytes: number;
  /** Most ah's own upload folder may hold (pasted and attached files). Not applied to Files uploads into your folders. */
  maxTotalBytes: number;
  /** Free space an upload must leave on the disk it lands on. */
  minFreeBytes: number;
  /** An upload that sends nothing for this long is dropped (a phone that went away mid-upload). */
  idleMs: number;
};

export const DEFAULT_UPLOAD_LIMITS: UploadLimits = {
  maxBytes: 4 * 1024 ** 3,
  maxTotalBytes: 20 * 1024 ** 3,
  minFreeBytes: 1024 ** 3,
  idleMs: 120_000,
};

/** A refused or failed upload. `code` lets clients tell the cases apart without reading the message. */
export class UploadError extends DomainError {
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
  }
}

const PART = /^\.[\w.-]*\.part-[0-9a-f]{8}$/;

const gb = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1).replace(/\.0$/, '')} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** The size the client says it's sending, when it says (raw bodies always do; chunked ones don't). */
export function declaredLength(req: Partial<Pick<IncomingMessage, 'headers'>>): number | null {
  const raw = req.headers?.['content-length'];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Bytes in the files directly inside `dir` (ah's upload folder is flat). */
async function folderBytes(dir: string): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const sizes = await Promise.all(names.map((n) => stat(join(dir, n)).then((s) => (s.isFile() ? s.size : 0), () => 0)));
  return sizes.reduce((a, b) => a + b, 0);
}

async function freeBytes(dir: string): Promise<number> {
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

/**
 * Refuses an upload before reading it, when its declared size already breaks a
 * limit. `quotaDir` is ah's own upload folder (for the total); Files uploads into
 * your folders pass null.
 */
export async function admit(dir: string, declared: number | null, limits: UploadLimits, quotaDir: string | null): Promise<void> {
  if (declared !== null && declared > limits.maxBytes) {
    throw new UploadError(413, 'upload_too_large', `That file is ${gb(declared)}; this host takes uploads up to ${gb(limits.maxBytes)} ("uploads.maxBytes" in the config).`);
  }
  const incoming = declared ?? 0;
  if (quotaDir) {
    const held = await folderBytes(quotaDir);
    if (held + incoming > limits.maxTotalBytes) {
      throw new UploadError(507, 'upload_quota', `ah's upload folder holds ${gb(held)} of its ${gb(limits.maxTotalBytes)}; clear it in Settings → System, or raise "uploads.maxTotalBytes".`);
    }
  }
  const free = await freeBytes(dir).catch(() => Infinity);
  if (free - incoming < limits.minFreeBytes) {
    throw new UploadError(507, 'disk_full', `Not enough free space on the host for that upload (${gb(free)} free, ${gb(limits.minFreeBytes)} kept free).`);
  }
}

/**
 * Streams `body` into a new file at `target` (which must not exist; a function
 * names the n-th candidate instead), up to the limits. Returns where it landed
 * and the bytes written. Nothing is left behind on any failure: the
 * hidden part file is removed, and `target` appears only when the upload is whole.
 */
export async function streamToFile(body: Readable, target: string | ((n: number) => string), limits: UploadLimits, opts: { declared?: number | null; quotaDir?: string | null } = {}): Promise<{ path: string; bytes: number }> {
  const name = typeof target === 'string' ? () => target : target;
  const dir = dirname(name(0));
  const part = join(dir, `.${basename(name(0)).replace(/[^\w.-]/g, '_').slice(-60)}.part-${randomUUID().slice(0, 8)}`);
  // Owner-only: uploads (screenshots, logs, recordings) often hold things you wouldn't share.
  const fh = await open(part, 'wx', 0o600);
  let size = 0;
  // Budget for this upload while it streams: the free space and the folder quota
  // can both run out mid-way when the client didn't say how big it is.
  const free = await freeBytes(dir).catch(() => Infinity);
  const quota = opts.quotaDir ? limits.maxTotalBytes - (await folderBytes(opts.quotaDir)) : Infinity;
  const budget = Math.min(limits.maxBytes, free - limits.minFreeBytes, quota);
  const req = body as Partial<IncomingMessage>;
  const socket = req.socket;
  let stalled = false;
  if (socket) {
    socket.setTimeout(limits.idleMs, () => {
      stalled = true;
      body.destroy(new UploadError(408, 'upload_stalled', 'the upload stopped sending'));
    });
  }
  try {
    for await (const chunk of body) {
      size += (chunk as Buffer).length;
      if (size > budget) {
        if (size > limits.maxBytes) throw new UploadError(413, 'upload_too_large', `That file is over ${gb(limits.maxBytes)}, the most this host takes ("uploads.maxBytes" in the config).`);
        throw new UploadError(507, size > quota ? 'upload_quota' : 'disk_full', size > quota ? "ah's upload folder is full; clear it in Settings → System." : 'The host ran out of room for that upload.');
      }
      await fh.write(chunk as Buffer);
    }
    // An HTTP body that ended early (the client hung up between chunks) is not an upload.
    if (req.complete === false || (opts.declared != null && size !== opts.declared)) {
      throw new UploadError(400, 'upload_incomplete', 'the upload ended before the whole file arrived');
    }
    await fh.close();
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(part, { force: true });
    if (err instanceof UploadError) throw err;
    if (stalled) throw new UploadError(408, 'upload_stalled', 'the upload stopped sending');
    // A client that hung up: nobody is left to read the answer, but say what happened.
    throw new UploadError(400, 'upload_incomplete', 'the upload ended before the whole file arrived');
  } finally {
    socket?.setTimeout(0);
  }
  // link() fails rather than replace a file that took the name meanwhile: the
  // next candidate name is tried ("a.png", then "a (1).png", …).
  try {
    for (let n = 0; ; n++) {
      const path = name(n);
      try {
        await link(part, path);
        return { path, bytes: size };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || typeof target === 'string' || n >= 999) throw err;
      }
    }
  } finally {
    await rm(part, { force: true });
  }
}

/** Part files a crash or a kill left behind, older than `olderThanMs`. Returns how many went. */
export async function sweepParts(dir: string, olderThanMs = 3600_000): Promise<number> {
  const names = await readdir(dir).catch(() => [] as string[]);
  let removed = 0;
  for (const name of names) {
    if (!PART.test(name)) continue;
    const s = await stat(join(dir, name)).catch(() => null);
    if (s && Date.now() - s.mtimeMs > olderThanMs) {
      await rm(join(dir, name), { force: true });
      removed++;
    }
  }
  return removed;
}
