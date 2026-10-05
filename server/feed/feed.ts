// Reads a harness transcript incrementally into normalized entries. Transcripts are
// append-only JSONL, so a byte offset is a complete cursor and the line number is a
// stable sequence. A file that shrinks or is replaced bumps `generation`, telling
// every reader to rebuild instead of appending onto a projection that no longer holds.
import { open, stat } from 'node:fs/promises';
import type { Entry } from './schema.ts';
import { parseClaudeLine } from './adapters/claude.ts';
import { parseCodexLine } from './adapters/codex.ts';

export type Adapter = (line: unknown, seq: number) => Entry | null;

/** Adapter table: one per harness; presets opt in with `feed: '<name>'`. */
export const ADAPTERS: Record<string, Adapter> = {
  claude: parseClaudeLine,
  codex: parseCodexLine,
};

const CHUNK = 4 * 1024 * 1024;
/** Entries kept in memory per transcript; older ones are dropped and `floor` rises. */
export const MAX_ENTRIES = 5000;

export class TranscriptFeed {
  entries: Entry[] = [];
  generation = 0;
  /** Line number of the last complete line read. */
  head = 0;
  /** Oldest seq still retained (0 while nothing was dropped). */
  floor = 0;
  private offset = 0;
  private rest = Buffer.alloc(0);
  private ino = 0;
  private reading: Promise<void> | null = null;

  readonly file: string;
  private readonly adapter: Adapter;

  constructor(file: string, adapter: Adapter) {
    this.file = file;
    this.adapter = adapter;
  }

  /** Reads whatever was appended since the last call. Concurrent callers share one read. */
  update(): Promise<void> {
    this.reading ??= this.readNew().finally(() => (this.reading = null));
    return this.reading;
  }

  after(seq: number): Entry[] {
    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1].seq > seq) i--;
    return this.entries.slice(i);
  }

  /** The newest `limit` entries older than `before`. */
  page(before: number, limit: number): { entries: Entry[]; hasOlder: boolean } {
    let end = this.entries.length;
    while (end > 0 && this.entries[end - 1].seq >= before) end--;
    const start = Math.max(0, end - limit);
    return { entries: this.entries.slice(start, end), hasOlder: start > 0 };
  }

  private async readNew() {
    const s = await stat(this.file).catch(() => null);
    if (!s) return;
    if ((this.ino && s.ino !== this.ino) || s.size < this.offset) this.reset();
    this.ino = s.ino;
    if (s.size === this.offset) return;
    const fh = await open(this.file, 'r');
    try {
      while (this.offset < s.size) {
        const buf = Buffer.alloc(Math.min(CHUNK, s.size - this.offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
        if (!bytesRead) break;
        this.offset += bytesRead;
        this.consume(buf.subarray(0, bytesRead));
      }
    } finally {
      await fh.close();
    }
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
      this.floor = this.entries[0].seq;
    }
  }

  /** Splits at byte level so a multi-byte character across chunks stays intact. */
  private consume(chunk: Buffer) {
    let data = this.rest.length ? Buffer.concat([this.rest, chunk]) : chunk;
    let nl: number;
    while ((nl = data.indexOf(0x0a)) >= 0) {
      this.line(data.subarray(0, nl).toString('utf8'));
      data = data.subarray(nl + 1);
    }
    this.rest = Buffer.from(data);
  }

  private line(text: string) {
    const seq = ++this.head;
    if (!text.trim()) return;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    const entry = this.adapter(json, seq);
    if (entry) this.entries.push(entry);
  }

  private reset() {
    this.entries = [];
    this.offset = 0;
    this.head = 0;
    this.floor = 0;
    this.rest = Buffer.alloc(0);
    this.generation++;
  }
}

// Open feeds are shared by every viewer of the same transcript; a few stay cached
// after the last viewer leaves so switching back to the GUI is instant.
const feeds = new Map<string, TranscriptFeed>();
const KEEP = 8;

export function feedFor(file: string, adapter: string): TranscriptFeed | null {
  const parse = ADAPTERS[adapter];
  if (!parse) return null;
  const key = `${adapter}\0${file}`;
  let feed = feeds.get(key);
  if (feed) feeds.delete(key);
  else feed = new TranscriptFeed(file, parse);
  feeds.set(key, feed); // most recently used last
  while (feeds.size > KEEP) feeds.delete(feeds.keys().next().value!);
  return feed;
}
