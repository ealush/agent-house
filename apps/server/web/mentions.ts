// "@path" in a message: a file you point the agent at (the composer's @ completion, the
// Files panel's Insert). Where it names a file that is there, ah draws it as a chip you
// can open: in the composer and in your turns in the feed.
import { useEffect, useState } from 'react';
import type { HostApi } from './api.ts';

export type Mention = { start: number; end: number; path: string };

// After a space or at the start, up to the next space; quotes and backticks end it.
const MENTION = /(?<=^|\s)@([^\s@`'"<>]+)/g;
// What follows a mention in a sentence, not part of its name: "see @a.md, then".
const TRAILING = /[.,;:!?)\]}]+$/;

/** Every "@path" in the text, where it starts (its @) and ends, and the path it names. */
export function findMentions(text: string): Mention[] {
  const out: Mention[] = [];
  for (const m of text.matchAll(MENTION)) {
    const path = m[1].replace(TRAILING, '');
    if (!path) continue;
    out.push({ start: m.index, end: m.index + 1 + path.length, path });
  }
  return out;
}

/** A mention's path on the host: as written when absolute or ~, else in the session's folder. */
export function resolveMention(cwd: string, path: string): string {
  if (path.startsWith('/') || path === '~' || path.startsWith('~/')) return path;
  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^(\.\/)+/, '')}`;
}

const split = (abs: string) => {
  const i = abs.lastIndexOf('/');
  return { dir: abs.slice(0, i) || '/', name: abs.slice(i + 1) };
};

// The files in a folder, per host, for a little while: one listing answers every mention in it.
const KEEP_MS = 20_000;
const folders = new Map<string, { at: number; names: Promise<Set<string>> }>();

function filesIn(fs: HostApi['fs'], dir: string): Promise<Set<string>> {
  const key = `${fs.url('')}\n${dir}`;
  const hit = folders.get(key);
  if (hit && Date.now() - hit.at < KEEP_MS) return hit.names;
  // A folder that can't be listed (missing, outside the browsable roots) has nothing to open.
  const names = fs.list(dir, true).then(
    (l) => new Set(l.entries.filter((e) => e.type === 'file').map((e) => e.name)),
    () => new Set<string>(),
  );
  folders.set(key, { at: Date.now(), names });
  return names;
}

/** Whether a mention names a file that is there (and so can be opened). */
export async function mentionExists(fs: HostApi['fs'], cwd: string, path: string): Promise<boolean> {
  const { dir, name } = split(resolveMention(cwd, path));
  return !!name && (await filesIn(fs, dir)).has(name);
}

/**
 * The mentions in `text` that name a file on the host, as they are found. `skip` leaves out
 * the one still being typed (the @ completion's), so it doesn't turn into a chip mid-word.
 */
export function useFileMentions(fs: HostApi['fs'] | null, cwd: string | undefined, text: string, skip?: number): Mention[] {
  const [found, setFound] = useState<{ key: string; paths: Set<string> }>({ key: '', paths: new Set() });
  const mentions = fs && cwd ? findMentions(text).filter((m) => m.start !== skip) : [];
  const paths = [...new Set(mentions.map((m) => m.path))];
  const key = `${cwd}\n${paths.join('\n')}`;
  useEffect(() => {
    if (!fs || !cwd || !paths.length) return;
    let live = true;
    void Promise.all(paths.map(async (p) => ((await mentionExists(fs, cwd, p)) ? p : null))).then((hits) => {
      if (live) setFound({ key, paths: new Set(hits.filter((p): p is string => !!p)) });
    });
    return () => {
      live = false;
    };
  }, [fs, key]);
  // Until this text's answer is in, the last one: a chip doesn't blink off while you type elsewhere.
  return mentions.filter((m) => found.paths.has(m.path));
}

/** The text without one mention, and the space after it, for the chip's ×. Where the caret goes. */
export function removeMention(text: string, m: Mention): { text: string; caret: number } {
  // The space after it, or else the one before: "see @a.md, then" → "see, then".
  if (text[m.end] === ' ') return { text: text.slice(0, m.start) + text.slice(m.end + 1), caret: m.start };
  const start = text[m.start - 1] === ' ' ? m.start - 1 : m.start;
  return { text: text.slice(0, start) + text.slice(m.end), caret: start };
}
