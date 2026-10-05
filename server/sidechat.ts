// Side chat: BYOK chat about a session's change, kept out of the agent's own
// context. Keys live on the host beside ah's other secrets; every device
// shares them, and chat history follows the session across devices.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { changes } from './git.ts';

const run = promisify(execFile);

export class SideChatError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Subscription = { id: string; name: string; baseUrl: string; model: string; apiKey: string };
export type SubscriptionInfo = { id: string; name: string; baseUrl: string; model: string; hasKey: boolean; isDefault: boolean };
export type ChatMessage = { role: 'user' | 'assistant'; text: string; at: number };
export type ChatContext = { title: string; session: string; branch: string | null; pr: number | null; diff: string };

/**
 * Premade next step under an answer: `session` sends its text to the live
 * session, `chat` asks it as the next side-chat question.
 */
export type Followup = { title: string; kind: 'session' | 'chat'; text: string };
export type ChatReply = { message: ChatMessage; followups: Followup[] };

/**
 * Pull the structured reply out of the model, tolerating chatty models
 * (fences, prose around the JSON). Anything unparseable or misshapen is the
 * answer itself with no follow-ups, so chat never breaks on a bad reply.
 */
export function parseStructured(raw: string): { content: string; followups: Followup[] } {
  const fallback = { content: raw.trim() || raw, followups: [] as Followup[] };
  let obj: unknown;
  try {
    const fenced = raw
      .replace(/^[\s\S]*?```(?:json)?\s*/, '')
      .replace(/\s*```[\s\S]*$/, '')
      .trim();
    const start = fenced.indexOf('{');
    const end = fenced.lastIndexOf('}');
    if (start < 0 || end <= start) return fallback;
    obj = JSON.parse(fenced.slice(start, end + 1));
  } catch {
    return fallback;
  }
  if (!obj || typeof obj !== 'object') return fallback;
  const { content, followups } = obj as { content?: unknown; followups?: unknown };
  if (typeof content !== 'string' || !content.trim()) return fallback;
  const out: Followup[] = [];
  if (Array.isArray(followups)) {
    for (const f of followups) {
      if (out.length >= 2) break;
      if (!f || typeof f !== 'object') continue;
      const { title, kind, text } = f as { title?: unknown; kind?: unknown; text?: unknown };
      if (typeof title !== 'string' || !title.trim() || (kind !== 'session' && kind !== 'chat') || typeof text !== 'string' || !text.trim()) continue;
      out.push({ title: title.trim().slice(0, 60), kind, text: text.trim().slice(0, 2000) });
    }
  }
  return { content: content.trim(), followups: out };
}

const FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'sidechat.json');
const HISTORY_LIMIT = 30;
const CHAT_TIMEOUT_MS = 90_000;
// Context budget: tracked patch + new-file contents + recent log stay small
// enough to leave room for history and the answer.
const TRACKED_LIMIT = 6000;
const UNTRACKED_PER_FILE = 3000;
const UNTRACKED_TOTAL = 12000;
const UNTRACKED_MAX_BYTES = 100_000;
const LOG_LINES = 12;

const SYSTEM = [
  'You are a sidekick inside "ah", an agent hub where every session is a live tmux terminal (a coding-agent TUI or a plain shell) with a working git checkout, a branch, a diff view, and a message queue: text sent to a session goes in now when idle, queues while it works, and resumes it first when dead.',
  'You discuss the change described below: review it, explain it, or help plan next steps.',
  'You cannot run commands or see anything beyond the context given; say so when asked for more.',
  'The human can forward your words to the live session with one click, or fire one of your premade follow-ups.',
  'Keep answers short and concrete. Name file paths and line numbers when you reference code.',
  'Format the content as GitHub-flavored markdown: short sections under ### headings, fenced code blocks with language tags, - bullets for lists, and | tables | for comparisons.',
  'Reply with ONLY a JSON object, no fences, no other text:',
  '{"content": "your markdown answer", "followups": [{"title": "button label, 4 words max", "kind": "session|chat", "text": "premade text"}]}.',
  'A "session" followup sends its text to the live session: use it for commands, review findings, or plans to execute.',
  'A "chat" followup asks you another premade question.',
  'Offer 0-2 followups, only when genuinely useful.',
].join(' ');

function contextBlock(ctx: ChatContext): string {
  const head = [
    `Session: ${ctx.title} (${ctx.session})`,
    ctx.branch ? `Branch: ${ctx.branch}` : null,
    ctx.pr ? `Pull request: #${ctx.pr}` : null,
  ].filter(Boolean).join('\n');
  // Caps and truncation notes are owned by changeContext(); this stays verbatim.
  return `${head}\n${ctx.diff || '(working tree clean)'}`;
}

/** New-file contents: `git diff` never shows untracked files, so read them. */
async function newFileContents(root: string, files: Array<{ code: string; path: string }>): Promise<string> {
  const fresh = files.filter((f) => f.code === '??' || f.code === '?');
  if (!fresh.length) return '';
  const out: string[] = [];
  let budget = UNTRACKED_TOTAL;
  for (const f of fresh) {
    if (budget <= 0) {
      out.push('... (more new files not shown)');
      break;
    }
    const abs = join(root, f.path);
    if (!abs.startsWith(root + sep)) continue;
    try {
      if ((await stat(abs)).size > UNTRACKED_MAX_BYTES) {
        out.push(`--- new file: ${f.path}\n(too large, not shown)`);
        continue;
      }
    } catch {
      continue;
    }
    let text: string;
    try {
      text = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\0')) {
      out.push(`--- new file: ${f.path}\n(binary, not shown)`);
      continue;
    }
    const cap = Math.min(UNTRACKED_PER_FILE, budget);
    const shown = text.length > cap ? `${text.slice(0, cap)}\n... (truncated)` : text;
    budget -= shown.length;
    out.push(`--- new file: ${f.path}\n${shown}`);
  }
  return out.join('\n\n');
}

async function recentLog(root: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', root, 'log', '--oneline', `-${LOG_LINES}`], { maxBuffer: 256 * 1024, timeout: 10_000 });
    return stdout.trim();
  } catch {
    return '';
  }
}

export type ChangeContext = { branch: string | null; diff: string };

/**
 * What the model gets about the change: tracked diff (capped), new-file
 * contents (capped), and recent commits for orientation. Throws GitError
 * outside a repo; every read inside degrades to a note, never a throw.
 */
export async function changeContext(dir: string): Promise<ChangeContext> {
  const c = await changes(dir);
  const log = await recentLog(c.root);
  const work: string[] = [];
  if (c.stat.trim()) work.push(c.stat.trim());
  if (c.patch.trim()) {
    work.push(
      c.patch.length > TRACKED_LIMIT ? `${c.patch.slice(0, TRACKED_LIMIT)}\n... (tracked diff truncated)` : c.patch,
    );
  }
  const fresh = await newFileContents(c.root, c.files);
  if (fresh) work.push(fresh);
  const parts = [...(log ? [`Recent commits:\n${log}`] : []), ...(work.length ? work : ['(working tree clean)'])];
  return { branch: c.branch || null, diff: parts.join('\n\n') };
}

function firstLine(s: string): string {
  return s.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? '';
}

type Store = { subscriptions: Subscription[]; defaultId?: string; chats: Record<string, ChatMessage[]> };

export class SideChatStore {
  private file: string;
  private data: Store = { subscriptions: [], chats: {} };
  private writing: Promise<void> = Promise.resolve();

  constructor(file = FILE) {
    this.file = file;
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this.data = {
          subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions : [],
          defaultId: typeof raw.defaultId === 'string' ? raw.defaultId : undefined,
          chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {},
        };
      }
    } catch {
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        renameSync(file, aside);
      } catch {}
      this.data = { subscriptions: [], chats: {} };
    }
  }

  private save(): Promise<void> {
    const body = JSON.stringify(this.data);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      await writeFile(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.file);
    });
    return this.writing;
  }

  private redact(s: Subscription): SubscriptionInfo {
    return { id: s.id, name: s.name, baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey, isDefault: s.id === this.data.defaultId };
  }

  list(): SubscriptionInfo[] {
    return this.data.subscriptions.map((s) => this.redact(s));
  }

  defaultId(): string | null {
    return this.data.subscriptions.some((s) => s.id === this.data.defaultId) ? this.data.defaultId! : (this.data.subscriptions[0]?.id ?? null);
  }

  async put(input: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string }): Promise<SubscriptionInfo> {
    const name = input.name.trim();
    const model = input.model.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    if (!name) throw new SideChatError(400, 'name required');
    if (!model) throw new SideChatError(400, 'model required');
    if (!/^https?:\/\/[^/]+/.test(baseUrl)) throw new SideChatError(400, 'base URL must be http(s)');
    if (input.id) {
      const s = this.data.subscriptions.find((x) => x.id === input.id);
      if (!s) throw new SideChatError(404, 'subscription not found');
      s.name = name;
      s.baseUrl = baseUrl;
      s.model = model;
      if (input.apiKey !== undefined && input.apiKey !== '') s.apiKey = input.apiKey;
      if (!s.apiKey) throw new SideChatError(400, 'API key required');
      await this.save();
      return this.redact(s);
    }
    if (!input.apiKey) throw new SideChatError(400, 'API key required');
    const s: Subscription = { id: randomUUID(), name, baseUrl, model, apiKey: input.apiKey };
    this.data.subscriptions.push(s);
    if (!this.data.defaultId) this.data.defaultId = s.id;
    await this.save();
    return this.redact(s);
  }

  async remove(id: string): Promise<void> {
    const i = this.data.subscriptions.findIndex((s) => s.id === id);
    if (i < 0) throw new SideChatError(404, 'subscription not found');
    this.data.subscriptions.splice(i, 1);
    if (this.data.defaultId === id) this.data.defaultId = this.data.subscriptions[0]?.id;
    await this.save();
  }

  async setDefault(id: string): Promise<void> {
    if (!this.data.subscriptions.some((s) => s.id === id)) throw new SideChatError(404, 'subscription not found');
    this.data.defaultId = id;
    await this.save();
  }

  history(uid: string): ChatMessage[] {
    return this.data.chats[uid] ?? [];
  }

  async clear(uid: string): Promise<void> {
    delete this.data.chats[uid];
    await this.save();
  }

  private resolve(subscriptionId?: string): Subscription {
    const id = subscriptionId ?? this.defaultId();
    const s = this.data.subscriptions.find((x) => x.id === id);
    if (!s) throw new SideChatError(400, 'no chat subscription configured yet — add one under Settings → Subscriptions');
    return s;
  }

  async chat(uid: string, text: string, ctx: ChatContext, subscriptionId?: string): Promise<ChatReply> {
    const sub = this.resolve(subscriptionId);
    const prior = this.history(uid).slice(-HISTORY_LIMIT);
    const messages = [
      { role: 'system', content: `${SYSTEM}\n\n${contextBlock(ctx)}` },
      ...prior.map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: text },
    ];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${sub.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sub.apiKey}` },
        body: JSON.stringify({ model: sub.model, messages }),
        signal: ctrl.signal,
      });
    } catch (err) {
      throw new SideChatError(err instanceof Error && err.name === 'AbortError' ? 504 : 502, err instanceof Error && err.name === 'AbortError' ? 'chat provider timed out' : 'chat provider unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SideChatError(502, `chat provider: ${res.status} ${firstLine(body) || res.statusText}`.trim());
    }
    let data: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      data = await res.json();
    } catch {
      throw new SideChatError(502, 'chat provider returned invalid JSON');
    }
    const raw = data.choices?.[0]?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) throw new SideChatError(502, 'chat provider returned an empty reply');
    // Follow-ups are ephemeral UI; history keeps the answer text only.
    const { content, followups } = parseStructured(raw);
    const at = Math.floor(Date.now() / 1000);
    const log = [...prior, { role: 'user' as const, text, at }, { role: 'assistant' as const, text: content, at }].slice(-HISTORY_LIMIT);
    this.data.chats[uid] = log;
    await this.save();
    return { message: { role: 'assistant', text: content, at }, followups };
  }
}
