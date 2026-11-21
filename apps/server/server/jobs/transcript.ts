// What a scheduled run needs from a session's transcript: the messages typed and the
// replies written after a mark (the byte length before the run spoke). Bounded: a long
// turn can write megabytes, so only the head of what's new (where the message lands)
// and its tail (where the latest reply is) are read.
import { open, stat } from 'node:fs/promises';
import { ADAPTERS } from '../feed/feed.ts';

const SPAN = 2 * 1024 * 1024;

export type AfterMark = { size: number; user: string[]; replies: Array<{ text: string; at: number }> };

async function slice(file: string, from: number, length: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, from);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

export async function readAfter(file: string, adapter: string, from: number): Promise<AfterMark | null> {
  const parse = ADAPTERS[adapter];
  const s = await stat(file).catch(() => null);
  if (!s || !parse) return null;
  if (from >= s.size) return { size: s.size, user: [], replies: [] };
  const spans: string[] = [];
  if (s.size - from <= 2 * SPAN) spans.push(await slice(file, from, s.size - from));
  else spans.push(await slice(file, from, SPAN), await slice(file, s.size - SPAN, SPAN));
  const user: string[] = [];
  const replies: Array<{ text: string; at: number }> = [];
  let seq = 0;
  for (const span of spans) {
    for (const line of span.split('\n')) {
      if (!line.trim()) continue;
      let d: unknown;
      try {
        d = JSON.parse(line);
      } catch {
        continue; // a span's cut first or last line
      }
      const e = parse(d, ++seq);
      if (!e) continue;
      const text = e.parts.map((p) => (p.type === 'text' ? p.text : '')).filter(Boolean).join('\n').trim();
      if (!text) continue;
      if (e.role === 'user') user.push(text);
      else if (e.role === 'assistant') replies.push({ text, at: e.at });
    }
  }
  return { size: s.size, user, replies };
}

/**
 * Complete lines written after byte `from` (at most the last 1 MB of them), and the
 * file's length now. A first line cut by the window is dropped; so is an unfinished last one.
 */
export async function linesAfter(file: string, from: number): Promise<{ size: number; lines: string[] }> {
  const s = await stat(file).catch(() => null);
  if (!s || from >= s.size) return { size: s?.size ?? 0, lines: [] };
  const start = Math.max(from, s.size - 1024 * 1024);
  const text = await slice(file, start, s.size - start);
  const lines = text.split('\n');
  if (start > from) lines.shift();
  const done = text.endsWith('\n');
  if (!done) lines.pop();
  // An unfinished last line is read again next time, from where it starts.
  const size = done ? s.size : s.size - Buffer.byteLength(text.slice(text.lastIndexOf('\n') + 1));
  return { size, lines: lines.filter((l) => l.trim()) };
}
