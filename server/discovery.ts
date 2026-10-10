// Finds past conversations in each harness's own on-disk store, so sessions
// ah never started (or whose registry entry is gone) can still be resumed.
// We only read metadata — titles, cwd, model; the GUI's server/feed reads the rest.
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
};

const MAX_AGE_DAYS = 30;
const CLAUDE_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const GROK_DIR = process.env.GROK_HOME ?? join(homedir(), '.grok');
const GEMINI_DIR = join(homedir(), '.gemini');
const MUSE_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'muse');
const OPENCODE_DIR = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'opencode');
const HERMES_DIR = process.env.HERMES_HOME ?? join(homedir(), '.hermes');

// Per-file cache keyed by mtime+size: rescans only touch files that changed.
const cache = new Map<string, { sig: string; value: Transcript | null }>();

async function cached(file: string, parse: (file: string, mtime: number) => Promise<Transcript | null>) {
  const s = await stat(file).catch(() => null);
  if (!s || Date.now() - s.mtimeMs > MAX_AGE_DAYS * 86400_000) return null;
  const sig = `${s.mtimeMs}:${s.size}`;
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
  const t = text.trim();
  if (!t || t.startsWith('<') || t.startsWith('/') || t.startsWith('Caveat:')) return null;
  const first = t.split('\n').find((l) => l.trim()) ?? '';
  return first.length > 90 ? first.slice(0, 87) + '…' : first;
}

// ---------- Claude Code: ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl

export async function parseClaude(file: string, mtime: number): Promise<Transcript | null> {
  const harnessId = file.split('/').pop()!.replace(/\.jsonl$/, '');
  let cwd = '';
  let prompt: string | null = null;
  await scanHead(file, 512 * 1024, (line) => {
    if (!line.includes('"user"') && !line.includes('"cwd"')) return;
    const d = json(line);
    if (!d) return;
    cwd ||= d.cwd ?? '';
    if (d.type === 'user' && !d.isSidechain && !prompt) {
      const c = d.message?.content;
      prompt = promptTitle(typeof c === 'string' ? c : c?.find?.((p: any) => p.type === 'text')?.text);
    }
    return !!(cwd && prompt);
  });
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
  // session_meta embeds the whole system prompt, so lines can be large.
  await scanHead(file, 4 * 1024 * 1024, (line) => {
    const head = line.slice(0, 200);
    if (head.includes('"session_meta"')) {
      const p = json(line)?.payload;
      id = p?.id ?? p?.session_id ?? '';
      cwd = p?.cwd ?? '';
    } else if (head.includes('"turn_context"')) {
      model ??= json(line)?.payload?.model;
    } else if (!prompt && line.includes('"role":"user"')) {
      const p = json(line)?.payload;
      for (const part of p?.content ?? []) prompt ??= promptTitle(part?.text);
    }
    return !!(id && model && prompt);
  });
  if (!id || !prompt) return null;
  return { harness: 'codex', harnessId: id, cwd, title: prompt, model, updatedAt: mtime, file };
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

// ---------- Grok: ~/.grok/sessions/<encoded-cwd>/<session-id>/chat_history.jsonl
// Metadata lives in the sibling summary.json; the chat lines have no timestamps.
// Subagent sessions (session_kind in summary.json) are skipped, as Grok's own
// session list skips them. Format documented from third-party readers of real
// installs, not verified locally.

export async function parseGrok(file: string, mtime: number): Promise<Transcript | null> {
  const dir = file.split('/').slice(0, -1).join('/');
  const summary = json(await readFile(join(dir, 'summary.json'), 'utf8').catch(() => ''));
  if (summary?.session_kind === 'subagent') return null;
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
  if (!prompt) return null;
  const updated = Date.parse(summary?.last_active_at ?? summary?.updated_at ?? '');
  return {
    harness: 'grok',
    harnessId,
    cwd,
    title: summary?.generated_title || summary?.session_summary || prompt,
    model: typeof summary?.current_model_id === 'string' ? summary.current_model_id : undefined,
    updatedAt: Number.isFinite(updated) ? Math.floor(updated / 1000) : mtime,
    file,
  };
}

async function discoverGrok(): Promise<Transcript[]> {
  const root = join(GROK_DIR, 'sessions');
  const cwds = await readdir(root).catch(() => [] as string[]);
  const out = await Promise.all(
    cwds.map(async (c) => {
      const sessions = await readdir(join(root, c)).catch(() => [] as string[]);
      return Promise.all(sessions.map((s) => cached(join(root, c, s, 'chat_history.jsonl'), parseGrok)));
    }),
  );
  return out.flat().filter((t): t is Transcript => !!t);
}

// ---------- Gemini: ~/.gemini/tmp/<project>/chats/session-*.jsonl (current) or
// session-*.json (older single-document form). The recording's own metadata
// names the session and its directories; `.project_root` beside `chats/` is
// the fallback cwd. Format documented from the upstream recording service's
// published shape via third-party readers, not verified locally.

function geminiUserText(record: any): string | null {
  const content = record?.content;
  if (typeof content === 'string') return content;
  const text = (Array.isArray(content) ? content : []).map((p: any) => p?.text).filter((s: unknown) => typeof s === 'string').join('\n');
  return text || null;
}

export async function parseGemini(file: string, mtime: number): Promise<Transcript | null> {
  const text = await readFile(file, 'utf8').catch(() => '');
  if (!text) return null;
  let sessionId = '';
  let summary: string | undefined;
  let directories: string[] = [];
  let prompt: string | null = null;
  let model: string | undefined;
  const consider = (d: any) => {
    if (!d || typeof d !== 'object') return;
    if (typeof d.sessionId === 'string') sessionId ||= d.sessionId;
    if (typeof d.summary === 'string' && d.summary) summary = d.summary;
    if (Array.isArray(d.directories)) directories = d.directories.filter((s: unknown) => typeof s === 'string');
    if (d.type === 'user' && !prompt) prompt = promptTitle(geminiUserText(d));
    if (d.type === 'gemini' && typeof d.model === 'string') model ??= d.model;
  };
  if (file.endsWith('.jsonl')) {
    for (const line of text.split('\n')) consider(json(line));
  } else {
    const doc = json(text);
    consider(doc);
    for (const m of Array.isArray(doc?.messages) ? doc.messages : []) consider(m);
  }
  if (!sessionId || !prompt) return null;
  let cwd = directories[0] ?? '';
  if (!cwd) {
    const rootFile = join(file.split('/').slice(0, -2).join('/'), '.project_root');
    cwd = (await readFile(rootFile, 'utf8').catch(() => '')).trim();
  }
  return { harness: 'gemini', harnessId: sessionId, cwd, title: summary || prompt, model, updatedAt: mtime, file };
}

async function discoverGemini(): Promise<Transcript[]> {
  const root = join(GEMINI_DIR, 'tmp');
  const projects = await readdir(root).catch(() => [] as string[]);
  const out = await Promise.all(
    projects.map(async (p) => {
      const files = await readdir(join(root, p, 'chats')).catch(() => [] as string[]);
      return Promise.all(files.filter((f) => f.startsWith('session-') && (f.endsWith('.jsonl') || f.endsWith('.json'))).map((f) => cached(join(root, p, 'chats', f), parseGemini)));
    }),
  );
  return out.flat().filter((t): t is Transcript => !!t);
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
  if (typeof info?.id !== 'string' || info.parentID || info.parentId || info.parent_id) return null;
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
    const rows = db.prepare('SELECT id, directory, title, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 200').all();
    return rows
      .filter((r: any) => typeof r.id === 'string')
      .map((r: any) => ({
        harness: 'opencode',
        harnessId: String(r.id),
        cwd: typeof r.directory === 'string' ? r.directory : '',
        title: typeof r.title === 'string' && r.title ? r.title : 'opencode session',
        updatedAt: typeof r.time_updated === 'number' ? Math.floor(r.time_updated / 1000) : 0,
        file: `${dbPath}#${String(r.id)}`,
      }));
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
        `SELECT id, cwd, title, display_name, model, started_at, last_activity_at FROM sessions
         WHERE cwd IS NOT NULL AND source IN ('cli', 'tui') AND parent_session_id IS NULL AND coalesce(hidden, 0) = 0
         ORDER BY coalesce(last_activity_at, started_at) DESC LIMIT 200`,
      )
      .all();
    return rows.map((r: any) => ({
      harness: 'hermes',
      harnessId: String(r.id),
      cwd: String(r.cwd),
      title: (typeof r.title === 'string' && r.title) || (typeof r.display_name === 'string' && r.display_name) || 'Hermes session',
      model: typeof r.model === 'string' ? r.model : undefined,
      updatedAt: Math.floor(Number(r.last_activity_at ?? r.started_at) || 0),
      birthAt: Math.floor(Number(r.started_at) || 0) || undefined,
      file: `${dbPath}#${String(r.id)}`,
    }));
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
  gemini: discoverGemini,
  muse: discoverMuse,
  opencode: discoverOpencode,
  hermes: () => discoverHermes(),
};

let last: { at: number; value: Transcript[] } | null = null;
let running: Promise<Transcript[]> | null = null;

/** All discoverable transcripts, newest first. Rescans at most every `maxAgeMs`. */
export async function discover(maxAgeMs = 15_000): Promise<Transcript[]> {
  if (last && Date.now() - last.at < maxAgeMs) return last.value;
  running ??= Promise.all(Object.values(DISCOVERERS).map((d) => d().catch(() => [])))
    .then((lists) => {
      const value = lists.flat().sort((a, b) => b.updatedAt - a.updatedAt);
      last = { at: Date.now(), value };
      return value;
    })
    .finally(() => (running = null));
  return running;
}
