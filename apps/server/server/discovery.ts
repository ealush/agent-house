// Finds past conversations in each harness's own on-disk store, so sessions
// ah never started (or whose registry entry is gone) can still be resumed.
// We only read metadata — titles, cwd, model; the GUI's server/feed reads the rest.
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agyEntry, agyMeta } from './feed/adapters/agy.ts';

export type Transcript = {
  harness: string;
  harnessId: string;
  cwd: string;
  title: string;
  model?: string;
  updatedAt: number;
  /** Where it lives, for readers of the conversation itself (server/feed). */
  file: string;
  /**
   * Seconds since the epoch when the conversation was born (muse: the session
   * metadata record's time). Absent when the harness does not record one.
   * Adoption uses it to bind a transcript to the window created just before
   * it, so a hungry window cannot steal a newer window's conversation.
   */
  birthAt?: number;
  /**
   * A thread another agent spawned (a Codex sub-agent), not a conversation of its
   * own: history and adoption leave it out, and server/subagents shows it under
   * the conversation that started it.
   */
  spawned?: Spawned;
};

/** Where a spawned thread sits in its tree, as the harness recorded it. */
export type Spawned = {
  /** The conversation (thread) that spawned it. */
  parentId: string;
  /** The tree's first conversation, the one a person started. */
  rootId: string;
  /** 1 for a child of the root, 2 for a grandchild… */
  depth: number;
  /** `thread_spawn`: an agent the model asked for; `other`: one the harness runs itself (a guardian review). */
  kind: 'spawn' | 'other';
  nickname?: string;
  role?: string;
  /** Lines before this one are the parent's history copied in (Codex multi-agent v2). */
  historyStart?: number;
  /** When it was spawned (seconds), from its session_meta. */
  bornAt?: number;
  /** agy: the summary says this child was killed. */
  killed?: boolean;
  /** agy: the summary says this child's run finished. */
  idle?: boolean;
  /** agy: when the summary last changed (seconds), for a child that's idle or killed. Its file's time moves as it's read. */
  endedAt?: number;
};

const MAX_AGE_DAYS = 30;
const CLAUDE_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const GROK_DIR = process.env.GROK_HOME ?? join(homedir(), '.grok');
const AGY_DIR = join(homedir(), '.gemini', 'antigravity-cli');
const MUSE_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'muse');
const OPENCODE_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode');
const HERMES_DIR = process.env.HERMES_HOME ?? join(homedir(), '.hermes');
const PI_SESSIONS_DIR = process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'sessions');

// Per-file cache keyed by mtime+size: rescans only touch files that changed.
const cache = new Map<string, { sig: string; value: Transcript | null }>();

async function cached(file: string, parse: (file: string, mtime: number) => Promise<Transcript | null>, extra = '') {
  const s = await stat(file).catch(() => null);
  if (!s || Date.now() - s.mtimeMs > MAX_AGE_DAYS * 86400_000) return null;
  const sig = `${s.mtimeMs}:${s.size}:${extra}`;
  const hit = cache.get(file);
  if (hit?.sig === sig) return hit.value;
  const value = await parse(file, Math.floor(s.mtimeMs / 1000)).catch(() => null);
  cache.set(file, { sig, value });
  return value;
}

/** Streams JSON lines until `visit` returns true or `maxBytes` have been read. */
async function scanHead(file: string, maxBytes: number, visit: (line: string) => boolean | void) {
  const stream = createReadStream(file, { encoding: 'utf8', end: maxBytes });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) if (visit(line)) break;
  } finally {
    rl.close();
    stream.destroy();
  }
}

/**
 * Complete lines from the start of a file: at most `maxLines` of them and
 * `maxBytes` of them in total. Unlike scanHead the lines are never cut
 * mid-line; one oversized line still visits (and still counts as one line).
 */
async function scanLines(file: string, maxLines: number, maxBytes: number, visit: (line: string) => boolean | void) {
  const stream = createReadStream(file, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    let n = 0;
    for await (const line of rl) {
      if (++n > maxLines) break;
      if (visit(line)) break;
      bytes += line.length;
      if (bytes >= maxBytes) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

async function readTail(file: string, bytes: number): Promise<string[]> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    return start > 0 ? lines.slice(1) : lines; // first line is probably partial
  } finally {
    await fh.close();
  }
}

function json(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** First meaningful line of a user prompt; skips injected <tags> and slash-command noise. */
export function promptTitle(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  // A paste is yours, not injected: Claude Code wraps it in <pasted_content>. Without
  // this, a session opened with a paste is never discovered and its GUI stays empty.
  const t = text.replace(/<\/?pasted_content\b[^>]*>/g, '').trim();
  // A leading absolute path (an attached screenshot) is yours too, not a slash command:
  // it's left out of the title, but the prompt still counts.
  const path = /^\/[^\s/]*\//.test(t);
  if (!t || t.startsWith('<') || (t.startsWith('/') && !path) || t.startsWith('Caveat:')) return null;
  const line = t.split('\n').find((l) => l.trim()) ?? '';
  const first = path ? line.replace(/^(\/\S+\s*)+/, '').trim() || line.trim().split(/\s/)[0].split('/').pop()! : line;
  return first.length > 90 ? first.slice(0, 87) + '…' : first;
}

// ---------- Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl

/**
 * The first user text off a line too large to parse whole: a pasted
 * screenshot rides inline as base64, so the prompt sits at the start of a
 * megabyte line. Reads only the line's prefix and unescapes one text value.
 */
const PREFIX_TEXT = /"content":\s*(?:"((?:[^"\\]|\\.){0,4000})"|\[\s*\{\s*"type":\s*"text",\s*"text":\s*"((?:[^"\\]|\\.){0,4000})")/;
function prefixUserText(line: string): string | null {
  if (!line.includes('"type":"user"') && !line.includes('"type": "user"')) return null;
  const m = line.slice(0, 16 * 1024).match(PREFIX_TEXT);
  const raw = m?.[1] ?? m?.[2];
  if (raw == null) return null;
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

export async function parseClaude(file: string, mtime: number): Promise<Transcript | null> {
  const harnessId = file.split('/').pop()!.replace(/\.jsonl$/, '');
  let cwd = '';
  let prompt: string | null = null;
  const visit = (line: string) => {
    if (!line.includes('"user"') && !line.includes('"cwd"')) return;
    const d = json(line);
    if (!d) return;
    cwd ||= d.cwd ?? '';
    if (d.type === 'user' && !d.isSidechain && !prompt) {
      const c = d.message?.content;
      prompt = promptTitle(typeof c === 'string' ? c : c?.find?.((p: any) => p.type === 'text')?.text);
    }
    return !!(cwd && prompt);
  };
  await scanHead(file, 512 * 1024, visit);
  if (!prompt || !cwd) {
    // The head budget above can end mid-line, and a truncated line never
    // parses: the first prompt is lost exactly when the session opens with an
    // attached image. Retry over complete lines, bounded so one pathological
    // file cannot stall discovery; a line no budget can hold still yields the
    // prompt at its start.
    await scanLines(file, 120, 16 * 1024 * 1024, (line) => {
      if (line.length > 8 * 1024 * 1024) {
        prompt ??= promptTitle(prefixUserText(line));
        return !!(cwd && prompt);
      }
      return visit(line);
    });
  }
  if (!prompt) return null; // never got past startup

  let title: string | null = null;
  let model: string | undefined;
  const tail = await readTail(file, 256 * 1024);
  for (let i = tail.length - 1; i >= 0 && (!title || !model); i--) {
    const line = tail[i];
    if (!title && (line.includes('"custom-title"') || line.includes('"ai-title"'))) {
      const d = json(line);
      title = d?.customTitle ?? d?.aiTitle ?? null;
    } else if (!model && line.includes('"model"') && line.includes('"assistant"')) {
      const m = json(line)?.message?.model;
      if (typeof m === 'string' && !m.startsWith('<')) model = m;
    }
  }
  return { harness: 'claude', harnessId, cwd, title: title ?? prompt, model, updatedAt: mtime, file };
}

/**
 * Where a Claude conversation's transcript is, by its id alone: before discovery's next
 * scan has seen it (a session that just started). Null when no project holds it.
 */
const claudeFiles = new Map<string, string>();
/** Ids looked for and not found, and when: a session with no transcript yet isn't looked for on every pass. */
const claudeMisses = new Map<string, number>();
export async function claudeTranscriptOf(sessionId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const known = claudeFiles.get(sessionId);
  if (known && (await stat(known).catch(() => null))?.isFile()) return known;
  if (Date.now() - (claudeMisses.get(sessionId) ?? 0) < 10_000) return null;
  if (claudeMisses.size > 1000) claudeMisses.clear();
  claudeMisses.set(sessionId, Date.now());
  for (const d of await readdir(CLAUDE_DIR).catch(() => [] as string[])) {
    const file = join(CLAUDE_DIR, d, `${sessionId}.jsonl`);
    if ((await stat(file).catch(() => null))?.isFile()) {
      if (claudeFiles.size > 1000) claudeFiles.clear();
      claudeFiles.set(sessionId, file);
      claudeMisses.delete(sessionId);
      return file;
    }
  }
  return null;
}

async function discoverClaude(): Promise<Transcript[]> {
  const dirs = await readdir(CLAUDE_DIR).catch(() => [] as string[]);
  const out = await Promise.all(
    dirs.map(async (d) => {
      const files = await readdir(join(CLAUDE_DIR, d)).catch(() => [] as string[]);
      return Promise.all(files.filter((f) => f.endsWith('.jsonl')).map((f) => cached(join(CLAUDE_DIR, d, f), parseClaude)));
    }),
  );
  return out.flat().filter((t): t is Transcript => !!t);
}

// ---------- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (+ session_index.jsonl for names)

export async function parseCodex(file: string, mtime: number): Promise<Transcript | null> {
  let id = '';
  let cwd = '';
  let model: string | undefined;
  let prompt: string | null = null;
  let spawned: Spawned | undefined;
  let metas = 0;
  // session_meta embeds the whole system prompt, so lines can be large.
  await scanHead(file, 4 * 1024 * 1024, (line) => {
    const head = line.slice(0, 200);
    if (head.includes('"session_meta"')) {
      // Only the first: a spawned thread may carry its parent's history after its own
      // meta, starting with the parent's session_meta, and that id is not this thread's.
      if (metas++) return;
      const p = json(line)?.payload;
      id = p?.id ?? p?.session_id ?? '';
      cwd = p?.cwd ?? '';
      spawned = spawnedOf(p);
    } else if (head.includes('"turn_context"')) {
      model ??= json(line)?.payload?.model;
    } else if (!prompt && line.includes('"role":"user"')) {
      const p = json(line)?.payload;
      for (const part of p?.content ?? []) prompt ??= promptTitle(part?.text);
    }
    return !!(id && model && prompt);
  });
  if (!id || (!prompt && !spawned)) return null;
  const title = prompt ?? spawned?.nickname ?? 'Subagent';
  return { harness: 'codex', harnessId: id, cwd, title, model, updatedAt: mtime, file, ...(spawned ? { spawned } : {}) };
}

const ID = /^[\w-]{1,80}$/;

/**
 * A Codex thread's place in its tree, from its session_meta: `source.subagent`
 * marks a thread the harness spawned (`thread_spawn` when the model asked for an
 * agent, anything else, e.g. `other: "guardian"`, when the harness runs one of
 * its own), `parent_thread_id` its parent and `session_id` the tree's root.
 */
export function spawnedOf(p: any): Spawned | undefined {
  const sub = p?.source && typeof p.source === 'object' ? p.source.subagent : undefined;
  if (!sub) return undefined;
  const spawn = sub.thread_spawn && typeof sub.thread_spawn === 'object' ? sub.thread_spawn : null;
  const parentId = spawn?.parent_thread_id ?? p.parent_thread_id;
  if (typeof parentId !== 'string' || !ID.test(parentId)) return undefined;
  const rootId = typeof p.session_id === 'string' && ID.test(p.session_id) && p.session_id !== p.id ? p.session_id : parentId;
  const depth = Number.isInteger(spawn?.depth) && spawn.depth > 0 ? spawn.depth : 1;
  const nickname = spawn?.agent_nickname ?? p.agent_nickname;
  const role = spawn?.agent_role ?? p.agent_role;
  const start = p.subagent_history_start_ordinal;
  const born = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) : NaN;
  return {
    parentId,
    rootId,
    depth,
    kind: spawn ? 'spawn' : 'other',
    ...(typeof nickname === 'string' && nickname.trim() ? { nickname: nickname.trim().slice(0, 80) } : {}),
    ...(typeof role === 'string' && role.trim() ? { role: role.trim().slice(0, 80) } : {}),
    ...(Number.isInteger(start) && start > 0 ? { historyStart: start } : {}),
    ...(Number.isFinite(born) ? { bornAt: Math.floor(born / 1000) } : {}),
  };
}

async function codexNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const text = await readFile(join(CODEX_DIR, 'session_index.jsonl'), 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const d = json(line);
    if (d?.id && d.thread_name) names.set(d.id, d.thread_name);
  }
  return names;
}

async function discoverCodex(): Promise<Transcript[]> {
  const root = join(CODEX_DIR, 'sessions');
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400_000);
  const files: string[] = [];
  for (const y of await readdir(root).catch(() => [] as string[])) {
    if (Number(y) < cutoff.getFullYear()) continue;
    for (const m of await readdir(join(root, y)).catch(() => [] as string[])) {
      for (const d of await readdir(join(root, y, m)).catch(() => [] as string[])) {
        if (new Date(`${y}-${m}-${d}T23:59:59`) < cutoff) continue;
        for (const f of await readdir(join(root, y, m, d)).catch(() => [] as string[])) {
          if (f.endsWith('.jsonl')) files.push(join(root, y, m, d, f));
        }
      }
    }
  }
  const [names, parsed] = await Promise.all([codexNames(), Promise.all(files.map((f) => cached(f, parseCodex)))]);
  return parsed
    .filter((t): t is Transcript => !!t)
    .map((t) => ({ ...t, title: names.get(t.harnessId) ?? t.title }));
}

// ---------- pi: ~/.pi/agent/sessions/--<cwd>--/<timestamp>_<session-id>.jsonl
// The first line is the header ({type:"session", id, cwd}). A name set with /name is a
// session_info line anywhere after it, the latest one winning; the model is the latest
// model_change. Its tree's other branches are in the same file, so one file is one
// conversation.

export async function parsePi(file: string, mtime: number): Promise<Transcript | null> {
  let id = '';
  let cwd = '';
  let model: string | undefined;
  let name: string | null = null;
  let prompt: string | null = null;
  const meta = (line: string) => {
    const head = line.slice(0, 120);
    if (head.includes('"type":"model_change"')) {
      const d = json(line);
      if (typeof d?.modelId === 'string') model = typeof d.provider === 'string' ? `${d.provider}/${d.modelId}` : d.modelId;
    } else if (head.includes('"type":"session_info"')) {
      const d = json(line);
      if (typeof d?.name === 'string' && d.name.trim()) name = d.name.trim();
    }
  };
  // Its header and first prompt open the file. The system message carries every prompt
  // section and tool declaration: lines can be large.
  await scanHead(file, 8 * 1024 * 1024, (line) => {
    const head = line.slice(0, 120);
    if (!id && head.includes('"type":"session"')) {
      const d = json(line);
      id = typeof d?.id === 'string' ? d.id : '';
      cwd = typeof d?.cwd === 'string' ? d.cwd : '';
    } else if (!prompt && line.includes('"role":"user"')) {
      const c = json(line)?.message?.content;
      for (const part of typeof c === 'string' ? [{ text: c }] : Array.isArray(c) ? c : []) prompt ??= promptTitle(part?.text);
    } else meta(line);
    return !!(id && prompt);
  });
  // The latest name and model are wherever it last changed them: its end, however long it got.
  for (const line of await readTail(file, 1024 * 1024).catch(() => [] as string[])) meta(line);
  // A header past the scan (or cut short): the id is in the file's name too.
  id ||= file.match(/_([\w.-]+)\.jsonl$/)?.[1] ?? '';
  if (!id || !(name || prompt)) return null;
  return { harness: 'pi', harnessId: id, cwd, title: name ?? prompt!, model, updatedAt: mtime, file };
}

export async function discoverPi(dir = PI_SESSIONS_DIR): Promise<Transcript[]> {
  const files: string[] = [];
  for (const c of await readdir(dir).catch(() => [] as string[])) {
    for (const f of await readdir(join(dir, c)).catch(() => [] as string[])) if (f.endsWith('.jsonl')) files.push(join(dir, c, f));
  }
  return (await Promise.all(files.map((f) => cached(f, parsePi)))).filter((t): t is Transcript => !!t);
}

// ---------- Grok: ~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
// Metadata lives in the sibling summary.json; the chat lines have no timestamps.
// Subagent sessions (session_kind in summary.json) belong under the one that
// started them. The parent keeps `<session>/subagents/<id>/meta.json` with
// parent_session_id; the child's own folder is still its transcript.

export async function parseGrok(file: string, mtime: number): Promise<Transcript | null> {
  const dir = file.split('/').slice(0, -1).join('/');
  const summary = json(await readFile(join(dir, 'summary.json'), 'utf8').catch(() => ''));
  const child = summary?.session_kind === 'subagent';
  const harnessId = summary?.info?.id ?? dir.split('/').pop() ?? '';
  if (!harnessId) return null;
  let cwd = typeof summary?.info?.cwd === 'string' ? summary.info.cwd : '';
  if (!cwd) {
    try {
      cwd = decodeURIComponent(dir.split('/').slice(0, -1).pop() ?? '');
    } catch {}
  }
  let prompt: string | null = null;
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (prompt || !line.includes('"user"')) continue;
    const d = json(line);
    if (!d || d.type !== 'user' || d.synthetic_reason) continue;
    const raw = (Array.isArray(d.content) ? d.content : []).map((c: any) => c?.text).filter(Boolean).join('\n');
    prompt = promptTitle(raw.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1] ?? (d.prompt_index !== undefined ? raw : null));
  }
  if (!prompt && !child) return null;
  const updated = Date.parse(summary?.last_active_at ?? summary?.updated_at ?? '');
  return {
    harness: 'grok',
    harnessId,
    cwd,
    title: summary?.generated_title || summary?.session_summary || prompt || (typeof summary?.agent_name === 'string' ? summary.agent_name : 'Subagent'),
    model: typeof summary?.current_model_id === 'string' ? summary.current_model_id : undefined,
    updatedAt: Number.isFinite(updated) ? Math.floor(updated / 1000) : mtime,
    file,
  };
}

async function discoverGrok(): Promise<Transcript[]> {
  const root = join(GROK_DIR, 'sessions');
  const cwds = await readdir(root).catch(() => [] as string[]);
  const [parsed, links] = await Promise.all([
    Promise.all(
      cwds.map(async (c) => {
        const sessions = await readdir(join(root, c)).catch(() => [] as string[]);
        return Promise.all(sessions.map((s) => cached(join(root, c, s, 'chat_history.jsonl'), parseGrok)));
      }),
    ),
    grokLinks(root),
  ]);
  return parsed
    .flat()
    .filter((t): t is Transcript => !!t)
    .map((t) => {
      const link = links.get(t.harnessId);
      const spawned = link ? hang(t.harnessId, (id) => links.get(id)?.parent, { ...(link.role ? { role: link.role, nickname: link.role } : {}) }) : undefined;
      return spawned ? { ...t, title: link?.name || t.title, spawned } : t;
    });
}

/** Grok's parent link: `<session>/subagents/<child>/meta.json`, not the child's own summary. */
async function grokLinks(root: string): Promise<Map<string, { parent: string; name?: string; role?: string }>> {
  const out = new Map<string, { parent: string; name?: string; role?: string }>();
  const safe = (id: string) => /^[A-Za-z0-9_.:-]{1,80}$/.test(id) && !id.includes('..');
  const cwds = await readdir(root).catch(() => [] as string[]);
  for (const c of cwds) {
    const sessions = await readdir(join(root, c)).catch(() => [] as string[]);
    for (const s of sessions) {
      const kids = await readdir(join(root, c, s, 'subagents')).catch(() => [] as string[]);
      for (const k of kids) {
        if (!safe(k)) continue;
        const meta = json(await readFile(join(root, c, s, 'subagents', k, 'meta.json'), 'utf8').catch(() => ''));
        const child = typeof meta?.child_session_id === 'string' ? meta.child_session_id : k;
        const parent = typeof meta?.parent_session_id === 'string' ? meta.parent_session_id : s;
        if (!safe(child) || !safe(parent)) continue;
        out.set(child, {
          parent,
          ...(typeof meta?.description === 'string' && meta.description ? { name: meta.description } : {}),
          ...(typeof meta?.subagent_type === 'string' && meta.subagent_type ? { role: meta.subagent_type } : {}),
        });
      }
    }
  }
  return out;
}

/** A child's place from a parent id, walked up to the conversation a person started. */
function hang(id: string, parentOf: (id: string) => string | undefined, extra: Partial<Spawned> = {}): Spawned | undefined {
  const parent = parentOf(id);
  if (!parent || parent === id) return undefined;
  const chain = [id];
  let at = parent;
  while (parentOf(at) && parentOf(at) !== at && !chain.includes(at) && chain.length < 16) {
    chain.push(at);
    at = parentOf(at)!;
  }
  return { parentId: parent, rootId: at, depth: chain.length, kind: 'spawn', ...extra };
}

// ---------- Gemini, in Antigravity CLI (agy): ~/.gemini/antigravity-cli/conversations/<id>.db,
// one SQLite database per conversation (server/feed/adapters/agy.ts reads its steps).
// Its trajectory metadata has the folder and start; conversation_summaries.db beside
// it has the title agy gave it and, for a subagent's conversation, the one that
// started it. A conversation agy hasn't summed up yet is titled by your first message.

const AGY_STEP_USER = 14;
/** A conversation with no title from agy and no message from you. */
const AGY_UNTITLED = 'Gemini session';

/** agy's "2026-11-21 23:36:29.079203975+00:00" → seconds. */
function agyTime(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value.replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(t) && t > 0 ? Math.floor(t / 1000) : 0;
}

export async function parseAgy(file: string, mtime: number): Promise<Transcript | null> {
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  let db: any;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
  try {
    const blob = db.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main'").get()?.data;
    const { cwd, createdAt } = agyMeta(blob ?? null);
    if (!cwd) return null;
    const first = db.prepare('SELECT idx, step_type, status, step_payload FROM steps WHERE step_type = ? ORDER BY idx LIMIT 1').get(AGY_STEP_USER);
    const said = first ? agyEntry(Number(first.idx), Number(first.step_type), Number(first.status), first.step_payload) : null;
    const prompt = promptTitle(said?.parts[0]?.type === 'text' ? said.parts[0].text : null);
    const harnessId = file.slice(file.lastIndexOf('/') + 1).replace(/\.db$/, '');
    return { harness: 'gemini', harnessId, cwd, title: prompt ?? AGY_UNTITLED, updatedAt: mtime, ...(createdAt ? { birthAt: Math.floor(createdAt / 1000) } : {}), file };
  } catch {
    return null;
  } finally {
    try {
      db.close();
    } catch {}
  }
}

type AgySummary = { title: string; updatedAt: number; parent: string; depth: number; agent?: string; killed?: boolean; idle?: boolean };

async function agySummaries(dir: string): Promise<Map<string, AgySummary>> {
  const out = new Map<string, AgySummary>();
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  let db: any;
  try {
    db = new DatabaseSync(join(dir, 'conversation_summaries.db'), { readOnly: true });
  } catch {
    return out;
  }
  try {
    const rows = db.prepare('SELECT conversation_id, title, last_modified_time, parent_conversation_id, nesting_depth FROM conversation_summaries').all();
    // Status and the agent name arrived with later agy builds; a summaries db without them still titles.
    const extra = new Map<string, { status: string; killed: boolean; busy: boolean; agent: string }>();
    try {
      for (const r of db.prepare('SELECT conversation_id, status, killed, not_fully_idle, agent_name FROM conversation_summaries').all()) {
        extra.set(String(r.conversation_id), {
          status: typeof r.status === 'string' ? r.status : '',
          killed: r.killed === 1 || r.killed === true,
          busy: r.not_fully_idle === 1 || r.not_fully_idle === true,
          agent: typeof r.agent_name === 'string' ? r.agent_name.trim() : '',
        });
      }
    } catch {}
    for (const r of rows) {
      const more = extra.get(String(r.conversation_id));
      const running = !!more && (more.busy || more.status.includes('RUNNING'));
      const idle = !!more && !more.killed && !running && /IDLE|COMPLETE|SUCCESS/.test(more.status);
      out.set(String(r.conversation_id), {
        title: typeof r.title === 'string' ? r.title.trim() : '',
        updatedAt: agyTime(r.last_modified_time),
        parent: typeof r.parent_conversation_id === 'string' ? r.parent_conversation_id : '',
        depth: Number(r.nesting_depth) || 0,
        ...(more?.agent ? { agent: more.agent } : {}),
        ...(more?.killed ? { killed: true } : {}),
        ...(idle ? { idle: true } : {}),
      });
    }
  } catch {
  } finally {
    try {
      db.close();
    } catch {}
  }
  return out;
}

export async function discoverAgy(dir = AGY_DIR): Promise<Transcript[]> {
  const root = join(dir, 'conversations');
  const files = (await readdir(root).catch(() => [] as string[])).filter((f) => f.endsWith('.db'));
  const [summaries, parsed] = await Promise.all([
    agySummaries(dir),
    Promise.all(
      files.map(async (f) => {
        const file = join(root, f);
        // agy writes through a WAL: the conversation changes while its .db file doesn't.
        const wal = await stat(`${file}-wal`).catch(() => null);
        const t = await cached(file, parseAgy, wal ? `${wal.mtimeMs}:${wal.size}` : '');
        return t && wal ? { ...t, updatedAt: Math.max(t.updatedAt, Math.floor(wal.mtimeMs / 1000)) } : t;
      }),
    ),
  ]);
  const rootOf = (id: string) => {
    let at = id;
    for (let i = 0; i < 16 && summaries.get(at)?.parent; i++) at = summaries.get(at)!.parent;
    return at;
  };
  return parsed
    .filter((t): t is Transcript => !!t)
    .map((t) => {
      const s = summaries.get(t.harnessId);
      if (!s) return t;
      return {
        ...t,
        // A child's task is a system step, not a message: until agy titles it, its agent's name.
        title: s.title || (s.parent && s.agent && t.title === AGY_UNTITLED ? s.agent : t.title),
        updatedAt: Math.max(t.updatedAt, s.updatedAt),
        // A subagent's conversation belongs under the one that started it.
        ...(s.parent
          ? {
              spawned: {
                parentId: s.parent,
                rootId: rootOf(s.parent),
                depth: s.depth || 1,
                kind: 'spawn' as const,
                ...(s.agent ? { nickname: s.agent, role: s.agent } : {}),
                ...(s.killed ? { killed: true } : {}),
                ...(s.idle ? { idle: true } : {}),
                ...((s.idle || s.killed) && s.updatedAt ? { endedAt: s.updatedAt } : {}),
              },
            }
          : {}),
      };
    });
}

// ---------- Muse: ~/.local/share/muse/sessions/YYYY/MM/DD/<id>/session.jsonl
// Envelope records; the metadata record carries stream.id and the workspace
// root, a `started` run event carries the first prompt. Subagent transcripts
// nested under a session are skipped (they have no metadata of their own and
// the parent session covers the work). Documented from a third-party
// reverse-engineering report on a real corpus, not verified locally.

export async function parseMuse(file: string, mtime: number): Promise<Transcript | null> {
  let id = '';
  let cwd = '';
  let model: string | undefined;
  let prompt: string | null = null;
  let birthAt: number | undefined;
  let sawMeta = false;
  await scanHead(file, 4 * 1024 * 1024, (line) => {
    const d = json(line);
    if (!d) return;
    if (d.payload_type === 'runtime.session.metadata') {
      sawMeta = true;
      id ||= typeof d.stream?.id === 'string' ? d.stream.id : '';
      cwd ||= typeof d.payload?.record?.workspace_root === 'string' ? d.payload.record.workspace_root : '';
      if (birthAt == null && typeof d.recorded_at === 'number') birthAt = Math.floor(d.recorded_at / 1_000_000);
    } else if (d.payload_type === 'runtime.session' && d.payload?.kind === 'run') {
      const ev = d.payload.event ?? {};
      if (ev.kind === 'started' && !prompt) prompt = promptTitle(ev.prompt);
      if (ev.kind === 'model_completed' && typeof ev.model === 'string') model ??= ev.model;
    }
    return !!(id && cwd && prompt && model);
  });
  const harnessId = id || file.split('/').slice(0, -1).pop() || '';
  // Approval sidecars (workflow children) carry no metadata record of their
  // own; without it there is no cwd to match and no birth to bind by.
  if (!harnessId || !sawMeta) return null;
  // A session that never got past startup (no prompt yet) still counts: its
  // window is hungry until it binds its own birth transcript, and a hungry
  // window binds whatever is newest — i.e. a newer window's conversation.
  const t: Transcript = { harness: 'muse', harnessId, cwd, title: prompt ?? 'Muse session', model, updatedAt: mtime, file };
  if (birthAt != null) t.birthAt = birthAt;
  return t;
}

async function discoverMuse(): Promise<Transcript[]> {
  const root = join(MUSE_DIR, 'sessions');
  const files: string[] = [];
  for (const y of await readdir(root).catch(() => [] as string[])) {
    for (const m of await readdir(join(root, y)).catch(() => [] as string[])) {
      for (const d of await readdir(join(root, y, m)).catch(() => [] as string[])) {
        for (const s of await readdir(join(root, y, m, d)).catch(() => [] as string[])) {
          files.push(join(root, y, m, d, s, 'session.jsonl'));
        }
      }
    }
  }
  const parsed = await Promise.all(files.map((f) => cached(f, parseMuse)));
  return parsed.filter((t): t is Transcript => !!t);
}

// ---------- opencode: SQLite store (current) plus the legacy JSON tree.
// DB sessions address their transcript as "<db path>#<session id>"; the feed's
// document loader splits that apart. Tree sessions use their info file.
// Documented from third-party readers of real installs, not verified locally.

export async function parseOpencode(file: string, mtime: number): Promise<Transcript | null> {
  const info = json(await readFile(file, 'utf8').catch(() => ''));
  if (typeof info?.id !== 'string') return null;
  const parent = [info.parentID, info.parentId, info.parent_id].find((p) => typeof p === 'string' && p) as string | undefined;
  const storage = file.split('/').slice(0, -3).join('/');
  let prompt: string | null = null;
  let model: string | undefined;
  const messageDir = join(storage, 'message', info.id);
  const names = (await readdir(messageDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
  for (const name of names) {
    const msg = json(await readFile(join(messageDir, name), 'utf8').catch(() => ''));
    if (!msg) continue;
    if (typeof msg.modelID === 'string') model ??= msg.modelID;
    if (prompt || msg.role !== 'user' || typeof msg.id !== 'string') continue;
    const partDir = join(storage, 'part', msg.id);
    const parts = (await readdir(partDir).catch(() => [] as string[])).filter((f) => f.endsWith('.json')).sort();
    for (const p of parts) {
      const part = json(await readFile(join(partDir, p), 'utf8').catch(() => ''));
      if (part?.type === 'text') prompt ??= promptTitle(part.text);
    }
  }
  const updated = typeof info.time?.updated === 'number' ? Math.floor(info.time.updated / 1000) : mtime;
  return {
    harness: 'opencode',
    harnessId: info.id,
    cwd: typeof info.directory === 'string' ? info.directory : '',
    title: typeof info.title === 'string' && info.title ? info.title : (prompt ?? 'opencode session'),
    model,
    updatedAt: updated,
    file,
    ...(parent ? { spawned: { parentId: parent, rootId: parent, depth: 1, kind: 'spawn' as const } } : {}),
  };
}

async function discoverOpencodeDb(dbPath: string): Promise<Transcript[]> {
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    const rows = db.prepare('SELECT id, directory, title, time_updated, parent_id, time_archived FROM session ORDER BY time_updated DESC LIMIT 400').all();
    const parentOf = new Map<string, string>();
    for (const r of rows) if (typeof r.id === 'string' && typeof r.parent_id === 'string' && r.parent_id) parentOf.set(r.id, r.parent_id);
    return rows
      .filter((r: any) => typeof r.id === 'string')
      .map((r: any) => {
        const spawned = hang(String(r.id), (id) => parentOf.get(id), r.time_archived ? { idle: true, endedAt: Math.floor(Number(r.time_archived) / 1000) } : {});
        return {
          harness: 'opencode',
          harnessId: String(r.id),
          cwd: typeof r.directory === 'string' ? r.directory : '',
          title: typeof r.title === 'string' && r.title ? r.title : 'opencode session',
          updatedAt: typeof r.time_updated === 'number' ? Math.floor(r.time_updated / 1000) : 0,
          file: `${dbPath}#${String(r.id)}`,
          ...(spawned ? { spawned } : {}),
        };
      });
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}

async function discoverOpencode(): Promise<Transcript[]> {
  const fromDb = await discoverOpencodeDb(join(OPENCODE_DIR, 'opencode.db')).catch(() => [] as Transcript[]);
  const seen = new Set(fromDb.map((t) => t.harnessId));
  const treeRoot = join(OPENCODE_DIR, 'storage', 'session');
  const projects = await readdir(treeRoot).catch(() => [] as string[]);
  const parsed = await Promise.all(
    projects.map(async (p) => {
      const files = await readdir(join(treeRoot, p)).catch(() => [] as string[]);
      return Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => cached(join(treeRoot, p, f), parseOpencode)));
    }),
  );
  const fromTree = parsed.flat().filter((t): t is Transcript => !!t && !seen.has(t.harnessId));
  return [...fromDb, ...fromTree];
}

// ---------- Hermes: one SQLite store for every session; terminal sessions carry a cwd.

async function discoverHermes(dbPath = join(HERMES_DIR, 'state.db')): Promise<Transcript[]> {
  const { DatabaseSync } = (await import('node:sqlite')) as any;
  let db: any;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return [];
  }
  try {
    // Gateway sessions (Telegram, desktop) have no directory to resume in.
    const rows = db
      .prepare(
        `SELECT id, cwd, title, display_name, model, started_at, last_activity_at, ended_at, end_reason, parent_session_id FROM sessions
         WHERE source IN ('cli', 'tui') AND coalesce(hidden, 0) = 0
           AND (cwd IS NOT NULL OR parent_session_id IS NOT NULL)
         ORDER BY coalesce(last_activity_at, started_at) DESC LIMIT 400`,
      )
      .all();
    const parentOf = new Map<string, string>();
    for (const r of rows) if (typeof r.parent_session_id === 'string' && r.parent_session_id) parentOf.set(String(r.id), r.parent_session_id);
    return rows
      .filter((r: any) => r.cwd || parentOf.has(String(r.id)))
      .map((r: any) => {
        const ended = Number(r.ended_at) || 0;
        const killed = typeof r.end_reason === 'string' && /kill|cancel|abort|stop/i.test(r.end_reason);
        const spawned = hang(String(r.id), (id) => parentOf.get(id), {
          ...(ended && !killed ? { idle: true, endedAt: Math.floor(ended) } : {}),
          ...(killed ? { killed: true, endedAt: Math.floor(ended) || undefined } : {}),
        });
        return {
          harness: 'hermes',
          harnessId: String(r.id),
          cwd: typeof r.cwd === 'string' ? r.cwd : '',
          title: (typeof r.title === 'string' && r.title) || (typeof r.display_name === 'string' && r.display_name) || 'Hermes session',
          model: typeof r.model === 'string' ? r.model : undefined,
          updatedAt: Math.floor(Number(r.last_activity_at ?? r.started_at) || 0),
          birthAt: Math.floor(Number(r.started_at) || 0) || undefined,
          file: `${dbPath}#${String(r.id)}`,
          ...(spawned ? { spawned } : {}),
        };
      });
  } catch {
    return [];
  } finally {
    try {
      db.close();
    } catch {}
  }
}

// ---------- adapter table: harness id → discoverer

const DISCOVERERS: Record<string, () => Promise<Transcript[]>> = {
  claude: discoverClaude,
  codex: discoverCodex,
  grok: discoverGrok,
  gemini: () => discoverAgy(),
  muse: discoverMuse,
  opencode: discoverOpencode,
  hermes: () => discoverHermes(),
  pi: () => discoverPi(),
};

let last: { at: number; value: Transcript[] } | null = null;
let running: Promise<Transcript[]> | null = null;

/**
 * A title from a first prompt reads like a title: no "[Image #1]" or
 * "[Pasted text #2 +40 lines]" placeholders, no markup tags, one line.
 * Falls back to the raw text when nothing else is left.
 */
export function cleanTitle(raw: string): string {
  // A file attached from ah reaches the agent as its path in ah's uploads, quoted or not.
  const uploads: string[] = [];
  const t = raw
    .replace(/'([^']*\/ah\/uploads\/[^'/]+)'|"([^"]*\/ah\/uploads\/[^"/]+)"|(\/\S*\/ah\/uploads\/[^\s/]+)/g, (_m, a?: string, b?: string, c?: string) => (uploads.push((a ?? b ?? c)!), ' '))
    .replace(/\[(?:Image|Pasted text|Pasted image)\s*#\d+[^\]]*\]/gi, ' ')
    .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t) return t;
  // Nothing but attachments: name them as you did ("<timestamp>-<name>" on disk).
  if (uploads.length) return uploads.map((p) => p.slice(p.lastIndexOf('/') + 1).replace(/^\d{4}-\d\d-\d\dT[\d-]+Z-/, '')).join(', ');
  return raw.trim();
}

/** All discoverable transcripts, newest first. Rescans at most every `maxAgeMs`. */
export async function discover(maxAgeMs = 15_000): Promise<Transcript[]> {
  if (last && Date.now() - last.at < maxAgeMs) return last.value;
  running ??= Promise.all(Object.values(DISCOVERERS).map((d) => d().catch(() => [])))
    .then((lists) => {
      const value = lists
        .flat()
        .map((t) => ({ ...t, title: cleanTitle(t.title) }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      last = { at: Date.now(), value };
      return value;
    })
    .finally(() => (running = null));
  return running;
}
