// File explorer + transfer: browse the host, pull files to the device you're on,
// push files from it into any folder, so a path can be handed to a shell or agent.
import { createReadStream, existsSync, realpathSync } from 'node:fs';
import { open, readdir, realpath, stat, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export class FsError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// A signed-in device has a shell anyway, but file APIs are easier to misuse than
// typing, so the browser only reaches configured roots (projects, ah's uploads, /tmp
// by default). Your whole home — keys, tokens, dotfiles — is opt-in via config.
let ROOTS: string[] = [];

/** Sets the browsable roots (resolved through symlinks, so containment checks compare real paths). */
export function setRoots(input: string[]) {
  ROOTS = [...new Set(input.map((r) => resolve(r)).map((r) => (existsSync(r) ? realpathSync(r) : r)))];
}

export function roots(): string[] {
  return ROOTS.filter((r) => existsSync(r));
}

function within(p: string): boolean {
  return ROOTS.some((r) => p === r || p.startsWith(r + sep));
}

/** Resolves `input` (absolute, or ~-relative) to a real path inside the allowed roots. */
export async function safePath(input: string, { mustExist = true } = {}): Promise<string> {
  const expanded = input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input;
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

/** Writes an upload into `dir` without overwriting: "a.png" becomes "a (1).png". */
export async function receive(body: Readable, dirInput: string, rawName: string, limit: number): Promise<string> {
  const dir = await safePath(dirInput);
  if (!(await stat(dir)).isDirectory()) throw new FsError(400, 'not a directory');
  const name = basename(rawName).replace(/[\x00-\x1f/\\]/g, '_').trim() || 'upload';
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let target = join(dir, name);
  for (let i = 1; existsSync(target); i++) target = join(dir, `${stem} (${i})${ext}`);

  // Owner-only: uploads (screenshots, logs) often hold things you wouldn't share.
  const fh = await open(target, 'wx', 0o600);
  let size = 0;
  try {
    for await (const chunk of body) {
      size += chunk.length;
      if (size > limit) throw new FsError(413, 'file too large');
      await fh.write(chunk);
    }
  } catch (err) {
    await fh.close();
    await rm(target, { force: true });
    throw err;
  }
  await fh.close();
  return target;
}

export async function makeDir(input: string): Promise<string> {
  const path = await safePath(input, { mustExist: false });
  await mkdir(path);
  return path;
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
