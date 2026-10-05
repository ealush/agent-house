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
};

const MAX_AGE_DAYS = 30;
const CLAUDE_DIR = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
const CODEX_DIR = process.env.CODEX_HOME ?? join(homedir(), '.codex');

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

// ---------- adapter table: harness id → discoverer

const DISCOVERERS: Record<string, () => Promise<Transcript[]>> = {
  claude: discoverClaude,
  codex: discoverCodex,
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
