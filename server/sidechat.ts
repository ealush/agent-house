// Side chat: BYOK chat about a session's change, kept out of the agent's own
// context. Keys live on the host beside ah's other secrets; every device
// shares them, and chat history follows the session across devices.
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { defaultDbPath, getDb } from './db.ts';
import { changes } from './git.ts';
import { conversationKey } from './registry.ts';

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
export type ChatMessage = { role: 'user' | 'assistant'; text: string; at: number; /** ChatMessage row id, so search results can jump to one message (issue #9). */ id?: number };
export type ChatContext = { title: string; session: string; branch: string | null; pr: number | null; diff: string };

/**
 * Premade next step under an answer: `session` sends its text to the live
 * session, `chat` asks it as the next side-chat question.
 */
export type Followup = { title: string; kind: 'session' | 'chat'; text: string };
export type ChatReply = { message: ChatMessage; followups: Followup[] };

/** One row in the historic-chats browser: newest first. */
export type ChatSummary = { uid: string; title: string; count: number; firstAt: number; lastAt: number; preview: string };

/** First `{...}` in `text` when it is JSON; undefined when it is not. */
function parseObject(text: string): unknown | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Pull the structured reply out of the model, tolerating chatty models
 * (fences, prose around the JSON). Anything unparseable or misshapen is the
 * answer itself with no follow-ups, so chat never breaks on a bad reply.
 *
 * Parse the raw text before stripping fences. `content` is markdown and often
 * contains its own ``` blocks; stripping the first fence first corrupts the
 * object, JSON.parse throws, and the raw blob is shown with literal `\n`.
 */
export function parseStructured(raw: string): { content: string; followups: Followup[] } {
  const fallback = { content: raw.trim() || raw, followups: [] as Followup[] };
  let obj = parseObject(raw);
  if (obj === undefined) {
    const unwrapped = raw
      .replace(/^[\s\S]*?```(?:json)?\s*/, '')
      .replace(/\s*```[\s\S]*$/, '')
      .trim();
    if (unwrapped && unwrapped !== raw.trim()) obj = parseObject(unwrapped);
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

/**
 * A reply stored before a fenced `content` could be parsed is the raw JSON
 * envelope. Show the answer. Leave everything else, including user text, as stored.
 */
function answerText(role: string, text: string): string {
  if (role !== 'assistant') return text;
  // Repair whole envelopes only: normal answers can contain JSON examples.
  const envelope = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    const obj = JSON.parse(envelope) as { content?: unknown } | null;
    if (!obj || typeof obj.content !== 'string' || !obj.content.trim()) return text;
  } catch { return text; }
  return parseStructured(envelope).content;
}

const DB_FILE = process.env.AH_DB_FILE ?? defaultDbPath();
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

const DEFAULT_SETTING = 'sidechat.defaultId';

export class SideChatStore {
  private db: PrismaClient;

  constructor(dbPath = DB_FILE) {
    this.db = getDb(dbPath);
  }

  private redact(s: Subscription, defaultId: string | null): SubscriptionInfo {
    return { id: s.id, name: s.name, baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey, isDefault: s.id === defaultId };
  }

  async list(): Promise<SubscriptionInfo[]> {
    const [subs, def] = await Promise.all([
      this.db.subscription.findMany({ orderBy: { name: 'asc' } }),
      this.defaultId(),
    ]);
    return subs.map((s) => this.redact(s, def));
  }

  async defaultId(): Promise<string | null> {
    const [ids, def] = await Promise.all([
      this.db.subscription.findMany({ select: { id: true }, orderBy: { name: 'asc' } }),
      this.db.setting.findUnique({ where: { key: DEFAULT_SETTING } }),
    ]);
    if (def && ids.some((s) => s.id === def.value)) return def.value;
    return ids[0]?.id ?? null;
  }

  async put(input: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string }): Promise<SubscriptionInfo> {
    const name = input.name.trim();
    const model = input.model.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    if (!name) throw new SideChatError(400, 'name required');
    if (!model) throw new SideChatError(400, 'model required');
    if (!/^https?:\/\/[^/]+/.test(baseUrl)) throw new SideChatError(400, 'base URL must be http(s)');
    if (input.id) {
      const s = await this.db.subscription.findUnique({ where: { id: input.id } });
      if (!s) throw new SideChatError(404, 'subscription not found');
      const apiKey = input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : s.apiKey;
      if (!apiKey) throw new SideChatError(400, 'API key required');
      const updated = await this.db.subscription.update({ where: { id: input.id }, data: { name, baseUrl, model, apiKey } });
      return this.redact(updated, await this.defaultId());
    }
    if (!input.apiKey) throw new SideChatError(400, 'API key required');
    const created = await this.db.subscription.create({ data: { id: randomUUID(), name, baseUrl, model, apiKey: input.apiKey } });
    if (!(await this.db.setting.findUnique({ where: { key: DEFAULT_SETTING } }))) {
      await this.db.setting.create({ data: { key: DEFAULT_SETTING, value: created.id } });
    }
    return this.redact(created, await this.defaultId());
  }

  async remove(id: string): Promise<void> {
    try {
      await this.db.subscription.delete({ where: { id } });
    } catch {
      throw new SideChatError(404, 'subscription not found');
    }
    const def = await this.db.setting.findUnique({ where: { key: DEFAULT_SETTING } });
    if (def?.value === id) {
      const [next] = await this.db.subscription.findMany({ select: { id: true }, orderBy: { name: 'asc' }, take: 1 });
      if (next) await this.db.setting.update({ where: { key: DEFAULT_SETTING }, data: { value: next.id } });
      else await this.db.setting.delete({ where: { key: DEFAULT_SETTING } });
    }
  }

  async setDefault(id: string): Promise<void> {
    const s = await this.db.subscription.findUnique({ where: { id }, select: { id: true } });
    if (!s) throw new SideChatError(404, 'subscription not found');
    await this.db.setting.upsert({ where: { key: DEFAULT_SETTING }, create: { key: DEFAULT_SETTING, value: id }, update: { value: id } });
  }

  /**
   * Conversation-stable key for a session's side chat. Follows
   * `harness:harnessId` across ah uids (registry wipes, resumed-as-new
   * sessions); sessions without a harness conversation id keep their uid.
   */
  chatKey(harness: string | null, harnessId: string | null, uid: string): string {
    return harness && harnessId ? conversationKey(harness, harnessId, uid) : uid;
  }

  /**
   * Moves messages stored under a previous key (the ah uid) to the
   * conversation key, merging when both hold messages. History follows the
   * conversation when its harness id is learned after chats already exist.
   */
  async rekey(fromUid: string, toKey: string): Promise<void> {
    if (fromUid === toKey) return;
    const legacy = await this.db.chatMessage.count({ where: { uid: fromUid } });
    if (!legacy) return;
    await this.db.chatMessage.updateMany({ where: { uid: fromUid }, data: { uid: toKey } });
  }

  async history(uid: string, aroundId?: number): Promise<ChatMessage[]> {
    const rows = await this.db.chatMessage.findMany({ where: { uid }, orderBy: { id: 'asc' } });
    const index = aroundId === undefined ? -1 : rows.findIndex((r) => r.id === aroundId);
    const start = index < 0 ? Math.max(0, rows.length - HISTORY_LIMIT) : Math.max(0, index - Math.floor(HISTORY_LIMIT / 2));
    return rows.slice(start, start + HISTORY_LIMIT).map((r) => ({ role: r.role as 'user' | 'assistant', text: answerText(r.role, r.text), at: r.at, id: r.id }));
  }

  /**
   * Every stored conversation, newest first, with the session title when its
   * row still exists (pruned sessions fall back to the uid). `query` matches
   * session title, uid, or message text, case-insensitively.
   */
  async listChats(query?: string): Promise<ChatSummary[]> {
    const q = query?.trim().toLowerCase();
    const groups = await this.db.chatMessage.groupBy({
      by: ['uid'],
      _count: { _all: true },
      _min: { at: true },
      _max: { at: true },
    });
    const uids = groups.map((g) => g.uid);
    if (!uids.length) return [];
    // Chat keys are ah uids or `harness:harnessId` conversation keys: match
    // session rows on either, so titles follow the conversation.
    const pairs = uids.flatMap((u) => {
      const i = u.indexOf(':');
      return i > 0 ? [{ harness: u.slice(0, i), harnessId: u.slice(i + 1) }] : [];
    });
    const [sessions, last] = await Promise.all([
      this.db.session.findMany({
        where: { OR: [{ uid: { in: uids } }, ...pairs.map((p) => ({ harness: p.harness, harnessId: p.harnessId }))] },
        select: { uid: true, harness: true, harnessId: true, title: true },
      }),
      this.db.chatMessage.findMany({ where: { uid: { in: uids } }, orderBy: { id: 'desc' }, select: { uid: true, role: true, text: true } }),
    ]);
    const titles = new Map<string, string>();
    for (const s of sessions) {
      titles.set(s.uid, s.title || s.uid);
      if (s.harnessId) titles.set(`${s.harness}:${s.harnessId}`, s.title || s.uid);
    }
    const previews = new Map<string, string>();
    for (const m of last) if (!previews.has(m.uid)) previews.set(m.uid, answerText(m.role, m.text));
    let textHit: Set<string> | null = null;
    if (q) {
      const hits = await this.db.chatMessage.findMany({
        where: { uid: { in: uids }, text: { contains: q } },
        select: { uid: true },
        distinct: ['uid'],
      });
      textHit = new Set(hits.map((h) => h.uid));
    }
    return groups
      .map((g) => ({
        uid: g.uid,
        title: titles.get(g.uid) ?? g.uid,
        count: g._count._all,
        firstAt: g._min.at ?? 0,
        lastAt: g._max.at ?? 0,
        preview: (previews.get(g.uid) ?? '').slice(0, 140),
      }))
      .filter((c) => !q || c.uid.toLowerCase().includes(q) || c.title.toLowerCase().includes(q) || textHit!.has(c.uid))
      .sort((a, b) => b.lastAt - a.lastAt);
  }

  async clear(uid: string): Promise<void> {
    await this.db.chatMessage.deleteMany({ where: { uid } });
  }

  private async resolve(subscriptionId?: string): Promise<Subscription> {
    const id = subscriptionId ?? (await this.defaultId());
    const s = id ? await this.db.subscription.findUnique({ where: { id } }) : null;
    if (!s) throw new SideChatError(400, 'no chat subscription configured yet — add one under Settings → Subscriptions');
    return s;
  }

  async chat(uid: string, text: string, ctx: ChatContext, subscriptionId?: string): Promise<ChatReply> {
    const sub = await this.resolve(subscriptionId);
    const prior = (await this.history(uid)).slice(-HISTORY_LIMIT);
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
    await this.db.$transaction([
      this.db.chatMessage.deleteMany({ where: { uid } }),
      this.db.chatMessage.createMany({ data: log.map((m) => ({ uid, role: m.role, text: m.text, at: m.at })) }),
    ]);
    const saved = await this.db.chatMessage.findFirst({ where: { uid }, orderBy: { id: 'desc' }, select: { id: true } });
    return { message: { role: 'assistant', text: content, at, id: saved?.id }, followups };
  }
}
