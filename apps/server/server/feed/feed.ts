// Reads a harness transcript incrementally into normalized entries. Transcripts are
// append-only JSONL, so a byte offset is a complete cursor and the line number is a
// stable sequence. A file that shrinks or is replaced bumps `generation`, telling
// every reader to rebuild instead of appending onto a projection that no longer holds.
import { open, stat } from 'node:fs/promises';
import type { Entry } from './schema.ts';
import { withoutLinkHints } from '../sessionLinks.ts';
import { parseClaudeLine, parseClaudeSubagentLine } from './adapters/claude.ts';
import { parseCodexLine } from './adapters/codex.ts';
import { parseGrokLine } from './adapters/grok.ts';
import { parseMuseLine } from './adapters/muse.ts';
import { loadOpencode } from './adapters/opencode.ts';
import { loadHermes } from './adapters/hermes.ts';
import { loadAgy } from './adapters/agy.ts';

export type Adapter = (line: unknown, seq: number) => Entry | null;

/** Adapter table: one per harness; presets opt in with `feed: '<name>'`. */
export const ADAPTERS: Record<string, Adapter> = asTyped({
  claude: parseClaudeLine,
  /** A Claude Code subagent's transcript (server/subagents). */
  'claude-subagent': parseClaudeSubagentLine,
  codex: parseCodexLine,
  grok: parseGrokLine,
  muse: parseMuseLine,
});

/**
 * Your messages as you typed them: the line ah put after a session's link
 * (server/sessionLinks.ts) is the agent's to read, not part of what you said.
 */
function asTypedEntry(e: Entry | null): Entry | null {
  if (!e || e.role !== 'user') return e;
  let changed = false;
  const parts = e.parts.map((p) => {
    if (p.type !== 'text') return p;
    const text = withoutLinkHints(p.text);
    if (text === p.text) return p;
    changed = true;
    return { ...p, text };
  });
  return changed ? { ...e, parts } : e;
}

function asTyped(adapters: Record<string, Adapter>): Record<string, Adapter> {
  return Object.fromEntries(Object.entries(adapters).map(([name, parse]) => [name, (line: unknown, seq: number) => asTypedEntry(parse(line, seq))]));
}

/**
 * Document adapters: harnesses whose transcript is not an append-only line
 * stream (a JSON tree, a SQLite store) register a loader instead. The loader
 * returns the conversation's entries in order, or null when there is nothing
 * readable yet.
 */
export type DocAdapter = (source: string) => Promise<Entry[] | null>;

export const DOC_ADAPTERS: Record<string, DocAdapter> = Object.fromEntries(
  Object.entries({
    /** Gemini runs in Antigravity CLI (agy): a SQLite database of protobuf steps per conversation. */
    gemini: loadAgy,
    opencode: loadOpencode,
    hermes: loadHermes,
  } as Record<string, DocAdapter>).map(([name, load]) => [name, async (source: string) => (await load(source))?.map((e) => asTypedEntry(e)!) ?? null]),
);

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
  /** Lines before this one aren't this conversation's (a spawned Codex thread's copy of its parent's history). */
  private readonly from: number;

  constructor(file: string, adapter: Adapter, from = 0) {
    this.file = file;
    this.adapter = adapter;
    this.from = from;
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
    if (!text.trim() || seq < this.from) return;
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

/**
 * A feed over a whole-document transcript. Every poll reloads the document
 * (they are small compared to line transcripts, and two of the sources, a
 * rewritten JSON file and a SQLite store, have no cheaper cursor). Entries
 * keep their position while the document only grows; a document whose
 * entries change identity mid-list bumps `generation`, like a truncated
 * line transcript, so viewers rebuild from a snapshot.
 */
export class DocumentFeed {
  entries: Entry[] = [];
  generation = 0;
  head = 0;
  floor = 0;
  private sig = '';
  private loading: Promise<void> | null = null;

  readonly file: string;
  private readonly load: DocAdapter;

  constructor(file: string, load: DocAdapter) {
    this.file = file;
    this.load = load;
  }

  update(): Promise<void> {
    this.loading ??= this.reload().finally(() => (this.loading = null));
    return this.loading;
  }

  after(seq: number): Entry[] {
    let i = this.entries.length;
    while (i > 0 && this.entries[i - 1].seq > seq) i--;
    return this.entries.slice(i);
  }

  page(before: number, limit: number): { entries: Entry[]; hasOlder: boolean } {
    let end = this.entries.length;
    while (end > 0 && this.entries[end - 1].seq >= before) end--;
    const start = Math.max(0, end - limit);
    return { entries: this.entries.slice(start, end), hasOlder: start > 0 };
  }

  private async reload() {
    const next = await this.load(this.file).catch(() => null);
    if (!next) return;
    const sig = JSON.stringify(next);
    if (sig === this.sig) return;
    const retained = next.slice(-MAX_ENTRIES);
    const floor = next.length > MAX_ENTRIES ? retained[0].seq : 0;
    const bySeq = new Map(next.map((e) => [e.seq, e]));
    // A stream can append new entries, but needs a fresh snapshot when an
    // existing message is edited (tokens, tool results, same-length changes).
    const prefix = this.entries.every((e) => e.seq < floor || JSON.stringify(e) === JSON.stringify(bySeq.get(e.seq)));
    if (this.entries.length && !prefix) this.generation++;
    this.entries = retained;
    this.sig = sig;
    this.head = next.length ? next[next.length - 1].seq : 0;
    this.floor = floor;
  }
}

export type AnyFeed = TranscriptFeed | DocumentFeed;

// Open feeds are shared by every viewer of the same transcript; a few stay cached
// after the last viewer leaves so switching back to the GUI is instant.
const feeds = new Map<string, AnyFeed>();
const KEEP = 8;

export function feedFor(file: string, adapter: string, from = 0): AnyFeed | null {
  const parse = ADAPTERS[adapter];
  const doc = DOC_ADAPTERS[adapter];
  if (!parse && !doc) return null;
  const key = `${adapter}\0${from}\0${file}`;
  let feed = feeds.get(key);
  if (feed) feeds.delete(key);
  else if (doc && !parse) feed = new DocumentFeed(file, doc);
  else feed = new TranscriptFeed(file, parse!, from);
  feeds.set(key, feed); // most recently used last
  while (feeds.size > KEEP) feeds.delete(feeds.keys().next().value!);
  return feed;
}
