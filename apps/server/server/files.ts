// File explorer + transfer: browse the host, pull files to the device you're on,
// push files from it into any folder, so a path can be handed to a shell or agent.
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { open, readdir, realpath, stat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { admit, declaredLength, streamToFile, UploadError, DEFAULT_UPLOAD_LIMITS, type UploadLimits } from './uploads.ts';
import { DomainError } from './errors.ts';
import { expandHome } from './config.ts';

/** `code`: a stable reason (`upload_too_large`, …) when there is one. */
export class FsError extends DomainError {}

// A signed-in device has a shell anyway, but file APIs are easier to misuse than
// typing, so the browser only reaches configured roots (projects, ah's uploads, /tmp
// by default). Your whole home — keys, tokens, dotfiles — is opt-in via config.
let ROOTS: string[] = [];
// The media viewers also read pictures, video and sound (nothing else) from the media
// folders, read-only: where a screen recording or a render is left for you to watch.
let MEDIA_ROOTS: string[] = [];

/** Real paths, so containment checks compare like with like. */
const realRoots = (input: string[]) => [...new Set(input.map((r) => resolve(r)).map((r) => (existsSync(r) ? realpathSync(r) : r)))];

/** Resolves a root path through symlinks, even if the leaf directory does not exist yet. */
function resolveRoot(r: string): string {
  const abs = resolve(r);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent !== abs && existsSync(parent)) return join(realpathSync(parent), basename(abs));
  return abs;
}

/** Sets the browsable roots (resolved through symlinks, so containment checks compare real paths). */
export function setRoots(input: string[]) {
  ROOTS = [...new Set(input.map(resolveRoot))];
}

/**
 * Sets the folders media is also streamed from (config files.media). Resolved through symlinks
 * as each request comes rather than now: ~/Videos may not exist yet when ah starts (or be a link
 * made later), and an unresolved path never matches a file's real one.
 */
export function setMediaRoots(input: string[]) {
  MEDIA_ROOTS = [...new Set(input.map((r) => resolve(r)))];
}

export function roots(): string[] {
  return ROOTS.filter((r) => existsSync(r));
}

function within(p: string, roots = ROOTS): boolean {
  return roots.some((r) => p === r || p.startsWith(r + sep));
}

/** Resolves `input` (absolute, or ~-relative) to a real path inside the allowed roots. */
export async function safePath(input: string, { mustExist = true } = {}): Promise<string> {
  const expanded = expandHome(input);
  if (!expanded.startsWith('/')) throw new FsError(400, 'path must be absolute');
  const abs = resolve(expanded);
  // Follow symlinks so a link can't point the explorer outside the roots.
  const real = mustExist ? await realpath(abs).catch(() => null) : await realpath(dirname(abs)).then((d) => join(d, basename(abs))).catch(() => null);
  if (!real) throw new FsError(404, `no such file or directory: ${input}`);
  if (!within(real)) throw new FsError(403, 'outside the browsable folders (see "files.roots" in the config)');
  return real;
}

export type Entry = { name: string; type: 'dir' | 'file' | 'other'; size: number; mtime: number };

export async function list(dir: string, hidden: boolean): Promise<{ path: string; parent: string | null; entries: Entry[] }> {
  const path = await safePath(dir);
  const s = await stat(path);
  if (!s.isDirectory()) throw new FsError(400, 'not a directory');
  const names = await readdir(path).catch(() => {
    throw new FsError(403, 'permission denied');
  });
  const entries = await Promise.all(
    names
      .filter((n) => hidden || !n.startsWith('.'))
      .map(async (name): Promise<Entry | null> => {
        const st = await stat(join(path, name)).catch(() => null); // follows links
        if (!st) return null;
        return { name, type: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.size, mtime: Math.floor(st.mtimeMs / 1000) };
      }),
  );
  const parent = dirname(path);
  return {
    path,
    parent: parent !== path && within(parent) ? parent : null,
    entries: entries
      .filter((e): e is Entry => !!e)
      .sort((a, b) => (a.type === 'dir') !== (b.type === 'dir') ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true })),
  };
}

const IMAGE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

async function looksLikeText(path: string): Promise<boolean> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return !buf.subarray(0, bytesRead).includes(0);
  } finally {
    await fh.close();
  }
}

/**
 * Streams a file. Images show inline; anything that looks like text (HTML and SVG
 * included) is shown as text/plain; the rest downloads. Every response is CSP-sandboxed
 * with nosniff, so no file can run script on this origin.
 */
export async function sendFile(res: ServerResponse, input: string, download: boolean) {
  const path = await safePath(input);
  const s = await stat(path);
  if (!s.isFile()) throw new FsError(400, 'not a file');
  const image = IMAGE[extname(path).toLowerCase()];
  const text = !image && (await looksLikeText(path));
  const inline = !download && (image || text);
  const name = basename(path).replace(/["\\\r\n]/g, '_');
  res.writeHead(200, {
    'content-type': inline ? (image ?? 'text/plain; charset=utf-8') : 'application/octet-stream',
    'content-length': s.size,
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  });
  await pipeline(createReadStream(path), res);
}

const MEDIA: Record<string, string> = {
  ...IMAGE,
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
};

/** The media type a viewer streams for this path, by its extension; null for anything else. */
export function mediaType(path: string): string | null {
  return MEDIA[extname(path).toLowerCase()] ?? null;
}

/**
 * The one byte range a `Range` header asks of a `size`-byte file: null to send it whole
 * (no header, one this doesn't read, or several ranges, which RFC 9110 lets a server
 * answer in full), 'unsatisfiable' when it starts past the end (416).
 */
export function byteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    return suffix && size ? { start: Math.max(0, size - suffix), end: size - 1 } : 'unsatisfiable';
  }
  const start = Number(m[1]);
  const last = m[2] ? Number(m[2]) : Infinity;
  if (last < start) return null;
  return start < size ? { start, end: Math.min(last, size - 1) } : 'unsatisfiable';
}

/**
 * Streams a picture, video or sound for the media viewers, in byte ranges (video players
 * seek with them; Safari and AVPlayer won't play a video without). Read-only, media types
 * only (by the real path's extension, so a link named .mp4 can't hand out anything else),
 * from the roots or the media folders. Sandboxed like any download.
 */
export async function sendMedia(res: ServerResponse, input: string, rangeHeader: string | undefined) {
  const expanded = expandHome(input);
  if (!expanded.startsWith('/')) throw new FsError(400, 'path must be absolute');
  const path = await realpath(resolve(expanded)).catch(() => null);
  if (!path) throw new FsError(404, `no such file: ${input}`);
  if (!within(path) && !within(path, realRoots(MEDIA_ROOTS))) throw new FsError(403, 'outside the folders ah serves (see "files.roots" and "files.media" in the config)');
  const type = mediaType(path);
  if (!type) throw new FsError(415, 'not a picture, video or sound file', 'not_media');
  const s = await stat(path);
  if (!s.isFile()) throw new FsError(400, 'not a file');
  const range = byteRange(rangeHeader, s.size);
  const common = {
    'accept-ranges': 'bytes',
    'content-security-policy': "sandbox; default-src 'none'",
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  };
  if (range === 'unsatisfiable') {
    res.writeHead(416, { ...common, 'content-range': `bytes */${s.size}`, 'content-length': 0 });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: s.size - 1 };
  res.writeHead(range ? 206 : 200, {
    ...common,
    'content-type': type,
    'content-length': end - start + 1,
    ...(range ? { 'content-range': `bytes ${start}-${end}/${s.size}` } : {}),
    'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
  });
  if (end < start) return void res.end();
  await pipeline(createReadStream(path, { start, end }), res);
}

/** Writes an upload into `dir` without overwriting: "a.png" becomes "a (1).png". Streamed (server/uploads.ts). */
export async function receive(body: Readable, dirInput: string, rawName: string, limits: UploadLimits | number): Promise<string> {
  const dir = await safePath(dirInput);
  if (!(await stat(dir)).isDirectory()) throw new FsError(400, 'not a directory');
  const name = basename(rawName).replace(/[\x00-\x1f/\\]/g, '_').trim() || 'upload';
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const lim = typeof limits === 'number' ? { ...DEFAULT_UPLOAD_LIMITS, maxBytes: limits, minFreeBytes: 0 } : limits;
  const declared = declaredLength(body as never);
  try {
    await admit(dir, declared, lim, null);
    const out = await streamToFile(body, (n) => join(dir, n ? `${stem} (${n})${ext}` : name), lim, { declared });
    return out.path;
  } catch (err) {
    if (err instanceof UploadError) throw new FsError(err.status, err.message, err.code);
    throw err;
  }
}

export async function makeDir(input: string): Promise<string> {
  const path = await safePath(input, { mustExist: false });
  await mkdir(path);
  return path;
}

export type DirState = 'dir' | 'new' | 'file' | 'missing' | 'outside';

/**
 * What starting a session in `input` would mean: an existing folder, a new one
 * ah may create (its parent exists, inside the roots), or something it can't use.
 */
export async function dirStatus(input: string): Promise<DirState> {
  const expanded = expandHome(input);
  if (!expanded.startsWith('/')) return 'missing';
  const found = await stat(resolve(expanded)).catch(() => null);
  if (found) return found.isDirectory() ? 'dir' : 'file';
  try {
    await safePath(input, { mustExist: false });
    return 'new';
  } catch (err) {
    return err instanceof FsError && err.status === 403 ? 'outside' : 'missing';
  }
}

const UPLOADS_SUFFIX = `${sep}ah${sep}uploads`;

/**
 * Delete every entry in ah's paste-upload directory (`~/.cache/ah/uploads`).
 * The directory stays. A path that is not that directory is refused, including
 * a symlink that points somewhere else.
 */
export async function clearUploadDir(dir: string): Promise<number> {
  let real: string;
  try {
    real = await realpath(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const resolved = resolve(dir);
    if (!resolved.endsWith(UPLOADS_SUFFIX)) throw new Error(`refusing to clear ${resolved}`);
    await mkdir(resolved, { recursive: true, mode: 0o700 });
    return 0;
  }
  if (!real.endsWith(UPLOADS_SUFFIX)) throw new Error(`refusing to clear ${real}`);
  const names = await readdir(real);
  await Promise.all(names.map((name) => rm(join(real, name), { recursive: true, force: true })));
  return names.length;
}
