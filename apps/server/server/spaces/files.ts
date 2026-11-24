// The Spaces folder on disk: SpaceFs (service.ts) over node:fs. Every path comes in
// absolute and already checked (model.ts names never hold "/" or "..").
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SpaceFs } from './service.ts';

const secs = (ms: number) => Math.floor(ms / 1000);

export const nodeSpaceFs: SpaceFs = {
  isDir: async (path) => !!(await stat(path).catch(() => null))?.isDirectory(),
  exists: (path) => existsSync(path),
  folders: async (path) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const out: Array<{ name: string; at: number }> = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const s = await stat(`${path}/${e.name}`).catch(() => null);
      out.push({ name: e.name, at: s ? secs(s.mtimeMs) : 0 });
    }
    return out;
  },
  makeDir: async (path) => {
    await mkdir(dirname(path), { recursive: true });
    try {
      await mkdir(path);
      return 'made';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'exists';
      throw err;
    }
  },
  read: async (path, limit) => {
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) return null;
    if (s.size <= limit) return { text: await readFile(path, 'utf8'), bytes: s.size, at: secs(s.mtimeMs) };
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(limit);
      const { bytesRead } = await fh.read(buf, 0, limit, 0);
      return { text: buf.subarray(0, bytesRead).toString('utf8'), bytes: s.size, at: secs(s.mtimeMs) };
    } finally {
      await fh.close();
    }
  },
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    // Whole or not at all: a reader never sees half a file.
    const tmp = `${path}.ah-${process.pid}-${Date.now()}`;
    await writeFile(tmp, text);
    await rename(tmp, path);
    return secs((await stat(path)).mtimeMs);
  },
  remove: async (path) => {
    if (!(await stat(path).catch(() => null))?.isFile()) return false;
    await rm(path);
    return true;
  },
  markdown: async (path) => (await readdir(path, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name),
  listFiles: async (path) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
    const out: Array<{ name: string; bytes: number; at: number }> = [];
    for (const e of entries) {
      if (!e.isFile() || e.name.startsWith('.')) continue;
      const s = await stat(`${path}/${e.name}`).catch(() => null);
      if (s?.isFile()) out.push({ name: e.name, bytes: s.size, at: secs(s.mtimeMs) });
    }
    return out.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  },
  move: async (from, to) => {
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  },
  loadJson: async (path) => JSON.parse(await readFile(path, 'utf8')),
  saveJson: async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, path);
  },
};
