// Full-text search across transcripts and side chats (F27 extension, issue #9).
//
// One FTS5 index in the same SQLite file as the rest of ah's state: one row
// per transcript entry (keyed by its feed `seq`, so a result is a jump target)
// and one per side-chat message. The index is derived data: it is rebuilt from
// the transcripts on disk and the ChatMessage table, fingerprinted per source
// so a refresh only re-reads what changed. Disabling search drops the FTS
// tables outright; the indexed text does not linger.
import { createReadStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { Prisma, type PrismaClient } from '@prisma/client';
import { ADAPTERS, DOC_ADAPTERS } from './feed/feed.ts';
import type { Entry } from './feed/schema.ts';

export type TranscriptSource = {
  file: string;
  harness: string;
  /** Feed adapter name (preset `feed`), used to parse the transcript. */
  adapter: string;
  harnessId: string;
  /** Registry id when ah ran the session, else `harness:harnessId`. */
  ref: string;
  uid: string | null;
  title: string;
  cwd: string;
  model?: string;
};

export type SearchParams = {
  q: string;
  scope?: 'transcripts' | 'chats' | 'all';
  /** 'user' or 'agent' (assistant). */
  role?: string;
  project?: string;
  host?: string;
  model?: string;
  limit?: number;
  offset?: number;
  from?: number;
  to?: number;
  order?: 'recent';
};

export type SearchExcerpt = { seq: number | null; msgId: number | null; role: string; at: number; snippet: string };

export type SearchHit = {
  kind: 'transcript' | 'chat';
  host: string;
  ref: string | null;
  uid: string | null;
  harness: string | null;
  harnessId: string | null;
  title: string;
  cwd: string;
  at: number;
  matches: number;
  excerpts: SearchExcerpt[];
};

export type SearchResponse = {
  enabled: boolean;
  building: boolean;
  results: SearchHit[];
  total: number;
  tookMs: number;
  notes: Array<{ host: string; error: string }>;
};

export type SearchStatus = {
  enabled: boolean;
  building: boolean;
  sourcesIndexed: number;
  sourcesKnown: number;
  entries: number;
  transcriptEntries: number;
  chatEntries: number;
  lastBuiltAt: number;
};

const ENABLED_KEY = 'search.enabled';
const CLIP = 64 * 1024;
const BATCH = 200;
/** Snippet highlight markers: control characters that never appear in real text. */
export const MARK_START = '\u0001';
export const MARK_END = '\u0002';

// ---------- query building

/**
 * Splits a raw user query into FTS terms and quoted phrases. Anything that is
 * not a word character is dropped, so FTS operators typed literally (quotes,
 * AND/OR/NEAR, column filters, parens) can never become query syntax: the
 * MATCH string below is built only from sanitized tokens and is always passed
 * as a bound parameter.
 */
export function tokenizeQuery(raw: string): { terms: string[]; phrases: string[] } {
  const phrases: string[] = [];
  const rest = raw.replace(/"([^"]*)"/g, (_m, inner: string) => {
    const words = inner.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (words.length) phrases.push(words.join(' '));
    return ' ';
  });
  const terms = (rest.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 0);
  return { terms, phrases };
}

/**
 * Builds the FTS5 MATCH expression: phrases must match exactly; terms are
 * ANDed, with prefix matching on the final term for typed-ahead search.
 * Returns null when nothing searchable remains (punctuation-only queries).
 */
export function buildFtsMatch(raw: string): string | null {
  const { terms, phrases } = tokenizeQuery(raw);
  const parts: string[] = phrases.map((p) => `"${p}"`);
  // Every term is quoted: a bare word like "or" or "near" in a MATCH string
  // would be query syntax, not a search term.
  terms.forEach((t, i) => parts.push(i === terms.length - 1 && !raw.trimEnd().endsWith('"') ? `"${t}"*` : `"${t}"`));
  return parts.length ? parts.join(' AND ') : null;
}

// ---------- entry text

/**
 * Bump when entryText changes what it produces: every transcript is indexed
 * again once, so old rows don't keep the old text (2: calls as words, not JSON).
 */
const TEXT_VERSION = 2;

/** The words in a value: its strings, at any depth, without the JSON around them ("echo hi · Create hello.txt"). */
function words(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
  } else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) words(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) words(v, out);
  return out;
}

/** The searchable text of one feed entry: prose, reasoning, tool calls and results, as words a person reads. */
export function entryText(entry: Entry): string {
  const out: string[] = [];
  for (const part of entry.parts) {
    if (part.type === 'text' || part.type === 'reasoning') out.push(part.text);
    else if (part.type === 'tool_call') out.push(`${part.call.name}: ${words(part.call.args).join(' · ')}`);
    else if (part.type === 'tool_result') out.push(part.result.text);
    else if (part.type === 'notice') out.push(part.text);
    else if (part.type === 'widget') out.push(words(part.widget).join(' · '));
  }
  const text = out.join('\n').trim();
  return text.length > CLIP ? text.slice(0, CLIP) : text;
}

// ---------- result merging across hosts

/** Merges per-host responses (hub fan-out): failures become notes, never a failed search. */
export function combineResponses(parts: Array<{ host: string; body?: SearchResponse; error?: string }>, page: { offset?: number; limit?: number } = {}): SearchResponse {
  const notes: Array<{ host: string; error: string }> = [];
  const results: SearchHit[] = [];
  let enabled = false;
  let building = false;
  let tookMs = 0;
  let total = 0;
  for (const part of parts) {
    if (!part.body) {
      notes.push({ host: part.host, error: part.error ?? 'unreachable' });
      continue;
    }
    enabled ||= part.body.enabled;
    building ||= part.body.building;
    tookMs = Math.max(tookMs, part.body.tookMs);
    total += part.body.total;
    results.push(...part.body.results.map((hit) => ({ ...hit, host: part.host })));
    notes.push(...part.body.notes);
  }
  results.sort((a, b) => b.at - a.at || a.host.localeCompare(b.host) || a.kind.localeCompare(b.kind) || (a.ref ?? a.uid ?? '').localeCompare(b.ref ?? b.uid ?? ''));
  return { enabled, building, results: results.slice(page.offset ?? 0, page.limit === undefined ? undefined : (page.offset ?? 0) + page.limit), total, tookMs, notes };
}

// ---------- the indexer

type SourceRow = { source: string; kind: string; ref: string; sig: string; last_key: number; entries: number };

/** Raw rows come back with 64-bit integers as BigInt (epoch ms does not fit an Int). */
function normalizeSourceRow(row: Record<string, unknown>): SourceRow {
  return {
    source: String(row.source),
    kind: String(row.kind),
    ref: String(row.ref),
    sig: String(row.sig),
    last_key: Number(row.last_key),
    entries: Number(row.entries),
  };
}

export class SearchIndexer {
  private db: PrismaClient;
  private listTranscripts: () => Promise<TranscriptSource[]>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  building = false;
  private lastBuiltAt = 0;
  private sourcesKnown = 0;
  private mutations: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.mutations.catch(() => {}).then(fn);
    this.mutations = task;
    return task;
  }

  constructor(db: PrismaClient, listTranscripts: () => Promise<TranscriptSource[]>) {
    this.db = db;
    this.listTranscripts = listTranscripts;
  }

  async enabled(): Promise<boolean> {
    const row = await this.db.setting.findUnique({ where: { key: ENABLED_KEY } }).catch(() => null);
    return row?.value !== '0';
  }

  private async setSetting(value: string) {
    await this.db.setting.upsert({ where: { key: ENABLED_KEY }, create: { key: ENABLED_KEY, value }, update: { value } });
  }

  /** Creates the FTS tables and the fingerprint table if they are not there. Safe to repeat. */
  async ensureTables(): Promise<void> {
    await this.db.$executeRawUnsafe(
      `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
         text,
         title UNINDEXED, uid UNINDEXED, ref UNINDEXED, harness UNINDEXED, harness_id UNINDEXED,
         cwd UNINDEXED, model UNINDEXED, seq UNINDEXED, role UNINDEXED, at UNINDEXED)`,
    );
    await this.db.$executeRawUnsafe(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chat_fts USING fts5(
         text,
         title UNINDEXED, uid UNINDEXED, msg_id UNINDEXED, role UNINDEXED, at UNINDEXED)`,
    );
    await this.db.$executeRawUnsafe(
      `CREATE TABLE IF NOT EXISTS SearchSource (
         source TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT '', ref TEXT NOT NULL DEFAULT '',
         sig TEXT NOT NULL DEFAULT '', last_key INTEGER NOT NULL DEFAULT 0,
         entries INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL DEFAULT 0)`,
    );
  }

  /** Disable drops the indexed content itself, not just the UI. Enable rebuilds from scratch. */
  setEnabled(on: boolean): Promise<void> {
    return this.serialize(async () => {
      await this.setSetting(on ? '1' : '0');
      if (!on) {
        await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS transcript_fts`);
        await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS chat_fts`);
        await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS SearchSource`);
        return;
      }
      await this.ensureTables();
      await this.run(true);
    });
  }

  start() {
    void this.refresh().catch((err) => console.error('search index build failed:', err));
    this.timer = setInterval(() => void this.refresh().catch(() => {}), 5000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Full rebuild: every source is re-read, stale rows for it are dropped first. */
  rebuild(): Promise<void> {
    return this.serialize(async () => {
      if (!(await this.enabled())) return;
      await this.ensureTables();
      await this.run(true);
    });
  }

  /** Incremental pass, serialized with rebuilds and toggles. */
  refresh(): Promise<void> {
    return this.serialize(async () => {
      if (!(await this.enabled())) return;
      await this.ensureTables();
      await this.run(false);
    });
  }

  private run(force: boolean): Promise<void> {
    this.running ??= (async () => {
      this.building = true;
      try {
        const sources = await this.listTranscripts();
        this.sourcesKnown = sources.length + 1; // transcripts + the chat store
        for (const src of sources) await this.indexTranscript(src, force).catch((err) => console.error(`search index ${src.file}:`, err));
        await this.pruneTranscripts(sources);
        await this.indexChats(force).catch((err) => console.error('search index chats:', err));
        this.lastBuiltAt = Date.now();
      } finally {
        this.building = false;
      }
    })().finally(() => (this.running = null));
    return this.running;
  }

  private async sourceRow(source: string): Promise<SourceRow | null> {
    // The 64-bit columns are cast to TEXT: Prisma decodes a declared INTEGER
    // as 32-bit and refuses epoch-ms values outright.
    const rows = await this.db.$queryRawUnsafe<Array<Record<string, unknown>>>(
      `SELECT source, kind, ref, sig, CAST(last_key AS TEXT) AS last_key, CAST(entries AS TEXT) AS entries FROM SearchSource WHERE source = ?`,
      source,
    );
    return rows[0] ? normalizeSourceRow(rows[0]) : null;
  }

  private async saveSource(row: SourceRow): Promise<void> {
    await this.db.$executeRawUnsafe(
      `INSERT INTO SearchSource (source, kind, ref, sig, last_key, entries, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET kind = excluded.kind, ref = excluded.ref, sig = excluded.sig,
         last_key = excluded.last_key, entries = excluded.entries, indexed_at = excluded.indexed_at`,
      row.source, row.kind, row.ref, row.sig, row.last_key, row.entries, Date.now(),
    );
  }

  private async indexTranscript(src: TranscriptSource, force: boolean): Promise<void> {
    const doc = DOC_ADAPTERS[src.adapter];
    if (doc && (src.adapter === 'opencode' || src.adapter === 'hermes' || src.file.endsWith('.json'))) return this.indexDocument(src, doc, force);
    const parse = ADAPTERS[src.adapter];
    if (!parse) return;
    const s = await stat(src.file).catch(() => null);
    if (!s) return;
    const meta = createHash('sha256').update(JSON.stringify([TEXT_VERSION, src.ref, src.uid, src.title, src.cwd, src.model])).digest('hex');
    const sig = `${s.ino}:${s.size}:${Math.floor(s.mtimeMs)}:${meta}`;
    const key = `t:${src.file}`;
    const prev = await this.sourceRow(key);
    if (!force && prev?.sig === sig) return;

    // Appends continue where the last pass stopped; a shrunk or replaced file
    // (a /clear, a rotation) starts over and its stale rows are deleted first.
    let fromSeq = 0;
    let kept = 0;
    if (!force && prev) {
      const [ino, size] = prev.sig.split(':').map(Number);
      if (ino === s.ino && s.size > size && prev.ref === src.ref && prev.sig.split(':')[3] === meta) {
        fromSeq = prev.last_key;
        kept = prev.entries;
      }
    }
    if (prev && prev.ref !== src.ref) await this.db.$executeRaw`DELETE FROM transcript_fts WHERE ref = ${prev.ref}`;
    // Clean any uncommitted tail left by a failed indexing pass before retrying.
    await this.db.$executeRaw`DELETE FROM transcript_fts WHERE ref = ${src.ref} AND seq > ${fromSeq}`;

    let lastSeq = fromSeq;
    let inserted = 0;
    let batch: Prisma.Sql[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.db.$executeRaw`INSERT INTO transcript_fts (text, title, uid, ref, harness, harness_id, cwd, model, seq, role, at) VALUES ${Prisma.join(batch)}`;
      inserted += batch.length;
      batch = [];
    };
    if (!s.size) {
      await this.saveSource({ source: key, kind: 'transcript', ref: src.ref, sig, last_key: 0, entries: 0 });
      return;
    }
    const fh = await open(src.file, 'r');
    let complete = false;
    try {
      const tail = Buffer.alloc(1);
      await fh.read(tail, 0, 1, s.size - 1);
      complete = tail[0] === 10;
    } finally { await fh.close(); }
    const stream = createReadStream(src.file, { encoding: 'utf8', end: s.size - 1 });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    const consume = async (line: string) => {
      lineNo++;
      if (lineNo <= fromSeq) return;
      lastSeq = lineNo;
      if (!line.trim()) return;
      let json: unknown;
      try { json = JSON.parse(line); } catch { return; }
      const entry = parse(json, lineNo);
      if (!entry) return;
      const text = entryText(entry);
      if (!text) return;
      batch.push(Prisma.sql`(${text}, ${src.title}, ${src.uid ?? ''}, ${src.ref}, ${src.harness}, ${src.harnessId}, ${src.cwd}, ${src.model ?? ''}, ${entry.seq}, ${entry.role}, ${entry.at})`);
      if (batch.length >= BATCH) await flush();
    };
    let pending: string | undefined;
    try {
      for await (const line of rl) {
        if (pending !== undefined) await consume(pending);
        pending = line;
      }
      if (complete && pending !== undefined) await consume(pending);
    } finally {
      rl.close();
      stream.destroy();
    }
    await flush();
    await this.saveSource({ source: key, kind: 'transcript', ref: src.ref, sig, last_key: lastSeq, entries: kept + inserted });
  }

  private async indexDocument(src: TranscriptSource, load: (file: string) => Promise<Entry[] | null>, force: boolean): Promise<void> {
    const entries = await load(src.file);
    if (!entries) return;
    const key = `t:${src.file}`;
    const sig = createHash('sha256').update(JSON.stringify([TEXT_VERSION, src, entries])).digest('hex');
    const prev = await this.sourceRow(key);
    if (!force && prev?.sig === sig) return;
    if (prev && prev.ref !== src.ref) await this.db.$executeRaw`DELETE FROM transcript_fts WHERE ref = ${prev.ref}`;
    await this.db.$executeRaw`DELETE FROM transcript_fts WHERE ref = ${src.ref}`;
    const rows = entries.filter((e) => entryText(e)).map((e) => Prisma.sql`(${entryText(e)}, ${src.title}, ${src.uid ?? ''}, ${src.ref}, ${src.harness}, ${src.harnessId}, ${src.cwd}, ${src.model ?? ''}, ${e.seq}, ${e.role}, ${e.at})`);
    for (let i = 0; i < rows.length; i += BATCH) {
      await this.db.$executeRaw`INSERT INTO transcript_fts (text, title, uid, ref, harness, harness_id, cwd, model, seq, role, at) VALUES ${Prisma.join(rows.slice(i, i + BATCH))}`;
    }
    await this.saveSource({ source: key, kind: 'transcript', ref: src.ref, sig, last_key: entries.at(-1)?.seq ?? 0, entries: rows.length });
  }

  /** Transcripts that vanished from discovery lose their rows and fingerprint. */
  private async pruneTranscripts(sources: TranscriptSource[]): Promise<void> {
    const keep = new Set(sources.map((s) => `t:${s.file}`));
    const rows = (
      await this.db.$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT source, kind, ref, sig, CAST(last_key AS TEXT) AS last_key, CAST(entries AS TEXT) AS entries FROM SearchSource WHERE kind = 'transcript'`,
      )
    ).map(normalizeSourceRow);
    for (const row of rows) {
      if (keep.has(row.source)) continue;
      await this.db.$executeRaw`DELETE FROM transcript_fts WHERE ref = ${row.ref}`;
      await this.db.$executeRawUnsafe(`DELETE FROM SearchSource WHERE source = ?`, row.source);
    }
  }

  private async indexChats(force: boolean): Promise<void> {
    const key = 'chats';
    const prev = await this.sourceRow(key);
    const agg = await this.db.$queryRawUnsafe<Array<{ maxId: number | null; count: number }>>(
      `SELECT MAX(id) AS maxId, COUNT(*) AS count FROM ChatMessage`,
    );
    const maxId = Number(agg[0]?.maxId ?? 0);
    const count = Number(agg[0]?.count ?? 0);
    const sig = `${maxId}:${count}`;
    if (!force && prev?.sig === sig) return;

    let fromId = 0;
    let kept = 0;
    if (!force && prev && maxId > prev.last_key && count - Number(prev.sig.split(':')[1]) === await this.db.chatMessage.count({ where: { id: { gt: prev.last_key } } })) {
      fromId = prev.last_key;
      kept = prev.entries;
    }
    await this.db.$executeRaw`DELETE FROM chat_fts WHERE msg_id > ${fromId}`;

    const sessions = await this.db.session.findMany({ select: { uid: true, harness: true, harnessId: true, title: true } });
    const titles = new Map<string, string>();
    for (const s of sessions) {
      titles.set(s.uid, s.title || s.uid);
      if (s.harnessId) titles.set(`${s.harness}:${s.harnessId}`, s.title || s.uid);
    }
    let inserted = 0;
    let batch: Prisma.Sql[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.db.$executeRaw`INSERT INTO chat_fts (text, title, uid, msg_id, role, at) VALUES ${Prisma.join(batch)}`;
      inserted += batch.length;
      batch = [];
    };
    // Page through messages so a huge history never loads whole.
    let after = fromId;
    for (;;) {
      const rows = await this.db.chatMessage.findMany({ where: { id: { gt: after } }, orderBy: { id: 'asc' }, take: BATCH * 5 });
      if (!rows.length) break;
      for (const m of rows) {
        after = m.id;
        if (!m.text.trim()) continue;
        // ChatMessage.at is seconds; transcript entries are ms. Store ms so
        // ranking and display treat both the same.
        batch.push(Prisma.sql`(${m.text.slice(0, CLIP)}, ${titles.get(m.uid) ?? m.uid}, ${m.uid}, ${m.id}, ${m.role}, ${m.at * 1000})`);
        if (batch.length >= BATCH) await flush();
      }
    }
    await flush();
    await this.saveSource({ source: key, kind: 'chat', ref: '', sig, last_key: maxId, entries: kept + inserted });
  }

  // ---------- query

  search(params: SearchParams): Promise<SearchResponse> {
    return this.serialize(() => this.query(params));
  }

  private async query(params: SearchParams): Promise<SearchResponse> {
    const t0 = Date.now();
    const empty: SearchResponse = { enabled: true, building: this.building, results: [], total: 0, tookMs: 0, notes: [] };
    if (!(await this.enabled())) return { ...empty, enabled: false };
    const match = buildFtsMatch(params.q ?? '');
    if (!match) return { ...empty, tookMs: Date.now() - t0 };
    if (params.host && !hostname().toLowerCase().includes(params.host.toLowerCase())) return { ...empty, tookMs: Date.now() - t0 };
    const limit = Math.min(50, Math.max(1, params.limit ?? 20));
    const offset = Math.max(0, params.offset ?? 0);
    const role = params.role === 'agent' ? 'assistant' : params.role === 'user' ? 'user' : null;
    const scope = params.scope ?? 'all';
    const { terms, phrases } = tokenizeQuery(params.q);
    const needles = [...terms, ...phrases];
    const hits = new Map<string, SearchHit & { score: number }>();

    const addRows = (kind: 'transcript' | 'chat', rows: Array<Record<string, unknown>>) => {
      for (const row of rows) {
        const ref = kind === 'transcript' ? String(row.ref) : null;
        const uid = String(row.uid) || null;
        const key = `${kind}:${ref ?? uid}`;
        let hit = hits.get(key);
        if (!hit) {
          hit = {
            kind,
            host: hostname(),
            ref,
            uid,
            harness: kind === 'transcript' ? String(row.harness) : null,
            harnessId: kind === 'transcript' ? String(row.harness_id) : null,
            title: String(row.title),
            cwd: kind === 'transcript' ? String(row.cwd) : '',
            at: 0,
            matches: 0,
            excerpts: [],
            score: 0,
          };
          hits.set(key, hit);
        }
        hit.matches = Number(row.matches);
        const at = Number(row.at) || 0;
        hit.at = Math.max(hit.at, Number(row.latest_at) || at);
        if (hit.excerpts.length < 3) {
          hit.excerpts.push({
            seq: kind === 'transcript' ? Number(row.seq) : null,
            msgId: kind === 'chat' ? Number(row.msg_id) : null,
            role: String(row.role),
            at,
            snippet: String(row.snippet),
          });
        }
        // bm25 returns lower-is-better negatives; add recency and a title
        // boost so ordering is useful and, for a fixed corpus, deterministic.
        const titleHit = needles.some((n) => hit!.title.toLowerCase().includes(n)) ? 1.5 : 0;
        hit.score = Math.max(hit.score, -Number(row.rank) + titleHit + hit.at / 1e13);
      }
    };

    if (scope !== 'chats') {
      const filters: Prisma.Sql[] = [Prisma.sql`transcript_fts MATCH ${match}`];
      if (role) filters.push(Prisma.sql`role = ${role}`);
      if (params.project) filters.push(Prisma.sql`instr(lower(cwd), lower(${params.project})) > 0`);
      if (params.from) filters.push(Prisma.sql`at >= ${params.from}`);
      if (params.to) filters.push(Prisma.sql`at <= ${params.to}`);
      if (params.model) filters.push(Prisma.sql`instr(lower(model), lower(${params.model})) > 0`);
      const rows = await this.db.$queryRaw<Array<Record<string, unknown>>>`
        WITH matched AS MATERIALIZED (
          SELECT uid, ref, harness, harness_id, cwd, title, seq, role, at,
                 snippet(transcript_fts, 0, ${MARK_START}, ${MARK_END}, '…', 24) AS snippet,
                 bm25(transcript_fts) AS rank
          FROM transcript_fts WHERE ${Prisma.join(filters, ' AND ')}
        ), grouped AS (
          SELECT *, COUNT(*) OVER (PARTITION BY ref) AS matches,
                 MAX(at) OVER (PARTITION BY ref) AS latest_at,
                 ROW_NUMBER() OVER (PARTITION BY ref ORDER BY rank, seq) AS excerpt
          FROM matched
        ) SELECT * FROM grouped WHERE excerpt <= 3 ORDER BY rank, seq`;
      addRows('transcript', rows);
    }
    if (scope !== 'transcripts' && !params.model) {
      const filters: Prisma.Sql[] = [Prisma.sql`chat_fts MATCH ${match}`];
      if (role) filters.push(Prisma.sql`role = ${role}`);
      if (params.project) filters.push(Prisma.sql`uid IN (SELECT uid FROM Session WHERE instr(lower(cwd), lower(${params.project})) > 0)`);
      if (params.from) filters.push(Prisma.sql`at >= ${params.from}`);
      if (params.to) filters.push(Prisma.sql`at <= ${params.to}`);
      const rows = await this.db.$queryRaw<Array<Record<string, unknown>>>`
        WITH matched AS MATERIALIZED (
          SELECT uid, msg_id, title, role, at,
                 snippet(chat_fts, 0, ${MARK_START}, ${MARK_END}, '…', 24) AS snippet,
                 bm25(chat_fts) AS rank
          FROM chat_fts WHERE ${Prisma.join(filters, ' AND ')}
        ), grouped AS (
          SELECT *, COUNT(*) OVER (PARTITION BY uid) AS matches,
                 MAX(at) OVER (PARTITION BY uid) AS latest_at,
                 ROW_NUMBER() OVER (PARTITION BY uid ORDER BY rank, at DESC, msg_id DESC) AS excerpt
          FROM matched
        ) SELECT * FROM grouped WHERE excerpt <= 3 ORDER BY rank, at DESC, msg_id DESC`;
      addRows('chat', rows);
    }

    const all = [...hits.values()].sort((a, b) => (params.order === 'recent' ? 0 : b.score - a.score) || b.at - a.at || (a.ref ?? a.uid ?? '').localeCompare(b.ref ?? b.uid ?? ''));
    const page = all.slice(offset, offset + limit).map(({ score: _score, ...hit }) => hit);
    return { enabled: true, building: this.building, results: page, total: all.length, tookMs: Date.now() - t0, notes: [] };
  }

  async status(): Promise<SearchStatus> {
    const enabled = await this.enabled();
    let transcriptEntries = 0;
    let chatEntries = 0;
    let sourcesIndexed = 0;
    if (enabled) {
      const t = await this.db.$queryRawUnsafe<Array<{ c: number }>>(`SELECT COUNT(*) AS c FROM transcript_fts`).catch(() => [{ c: 0 }]);
      const c = await this.db.$queryRawUnsafe<Array<{ c: number }>>(`SELECT COUNT(*) AS c FROM chat_fts`).catch(() => [{ c: 0 }]);
      transcriptEntries = Number(t[0]?.c ?? 0);
      chatEntries = Number(c[0]?.c ?? 0);
      const s = await this.db.$queryRawUnsafe<Array<{ c: number }>>(`SELECT COUNT(*) AS c FROM SearchSource`).catch(() => [{ c: 0 }]);
      sourcesIndexed = Number(s[0]?.c ?? 0);
    }
    return {
      enabled,
      building: this.building,
      sourcesIndexed,
      sourcesKnown: this.sourcesKnown,
      entries: transcriptEntries + chatEntries,
      transcriptEntries,
      chatEntries,
      lastBuiltAt: this.lastBuiltAt,
    };
  }
}
