// The last thing said in each live session, for lists to show the way a chat app shows a
// conversation's last message: read from the end of the agent's own transcript, and read
// again only when that file has grown. Lists used to show `detail`, the last tool the
// agent ran ("$ git push …"), which says little once a turn is over.
import { open, stat } from 'node:fs/promises';
import { ADAPTERS } from './feed/feed.ts';
import type { Entry } from './feed/schema.ts';

/** `role`: who said it (the person, or the agent); `text`: its words, plain, clipped. */
export type LastReply = { role: 'assistant' | 'user'; text: string; at: number };

/** How much of a transcript's end is read: enough for a long last answer and its tools. */
const TAIL_BYTES = 256 * 1024;
const MAX_CHARS = 300;

/** Harness wrappers around a typed command or its output, which nobody said. */
const WRAPPER = /^<(command-|local-command-|system-reminder|bash-|user-memory-input)/;

/** Plain words for a one- or two-line preview: no Markdown marks, no runs of whitespace. */
export function plain(text: string): string {
  const flat = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > MAX_CHARS ? flat.slice(0, MAX_CHARS - 1).trimEnd() + '…' : flat;
}

/** The newest message with words in it (the person's or the agent's), or null. */
export function lastSaid(entries: Entry[]): LastReply | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.role !== 'assistant' && e.role !== 'user') continue;
    const words = e.parts.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n').trim();
    if (!words || WRAPPER.test(words)) continue;
    const text = plain(words);
    if (text) return { role: e.role, text, at: e.at };
  }
  return null;
}

/** The last message in the final `TAIL_BYTES` of a line transcript. */
export async function readLastSaid(file: string, size: number, adapter: string): Promise<LastReply | null> {
  const parse = ADAPTERS[adapter];
  if (!parse) return null;
  const start = Math.max(0, size - TAIL_BYTES);
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    // A read from the middle starts inside a line; the last one may still be being written.
    if (start > 0) lines.shift();
    const entries: Entry[] = [];
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const entry = parse(JSON.parse(line), i);
        if (entry) entries.push(entry);
      } catch {}
    });
    return lastSaid(entries);
  } finally {
    await fh.close();
  }
}

export type ReplyTarget = { uid: string; file: string; adapter: string };

/** Each live session's last message, kept between ticks. */
export class LastReplies {
  private known = new Map<string, { file: string; size: number; reply: LastReply | null }>();
  private running: Promise<boolean> | null = null;

  /** What `uid` last said, as far as read so far. */
  peek(uid: string): LastReply | null {
    return this.known.get(uid)?.reply ?? null;
  }

  /**
   * Reads again each transcript that grew (or moved) since the last look, one pass at a time;
   * a tick never waits for it and picks up the result on its next pass. True if anything changed.
   */
  refresh(targets: ReplyTarget[]): Promise<boolean> {
    return (this.running ??= this.pass(targets).finally(() => (this.running = null)));
  }

  /**
   * These sessions read now, after any pass under way: one that just stopped working, whose
   * answer its "finished" alert and Live Activity say, can't wait for the next pass. The others
   * are left as they are.
   */
  async readNow(targets: ReplyTarget[]): Promise<void> {
    await this.running?.catch(() => false);
    await this.pass(targets, false);
  }

  private async pass(targets: ReplyTarget[], prune = true): Promise<boolean> {
    let changed = false;
    const live = new Set(targets.map((t) => t.uid));
    if (prune) for (const uid of [...this.known.keys()]) if (!live.has(uid)) this.known.delete(uid);
    for (const t of targets) {
      const s = await stat(t.file).catch(() => null);
      if (!s) continue;
      const before = this.known.get(t.uid);
      if (before && before.file === t.file && before.size === s.size) continue;
      const reply = await readLastSaid(t.file, s.size, t.adapter).catch(() => before?.reply ?? null);
      this.known.set(t.uid, { file: t.file, size: s.size, reply });
      if (JSON.stringify(reply) !== JSON.stringify(before?.reply ?? null)) changed = true;
    }
    return changed;
  }
}
