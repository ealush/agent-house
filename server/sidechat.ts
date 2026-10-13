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
import { checkName } from './env.ts';
import { changes, toplevel, prPatch, prMeta, workingPatch, workingStat, mergeBase, showAtRef, commitShow, type PrMeta } from './git.ts';
import { conversationKey } from './registry.ts';

const run = promisify(execFile);

export class SideChatError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Subscription = { id: string; name: string; baseUrl: string; model: string; apiKey: string; envName?: string | null };
export type SubscriptionInfo = { id: string; name: string; baseUrl: string; model: string; hasKey: boolean; isDefault: boolean; envName: string | null };
export type ChatMessage = { role: 'user' | 'assistant'; text: string; at: number; /** ChatMessage row id, so search results can jump to one message (issue #9). */ id?: number };
export type ChatContext = {
  title: string;
  session: string;
  branch: string | null;
  pr: number | null;
  diff: string;
  /** Session cwd: when set and inside a repo, the model gets read-only repo tools. */
  dir?: string | null;
};

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

const SYSTEM_BASE = [
  'You are a sidekick inside "ah", an agent hub where every session is a live tmux terminal (a coding-agent TUI or a plain shell) with a working git checkout, a branch, a diff view, and a message queue: text sent to a session goes in now when idle, queues while it works, and resumes it first when dead.',
  'You discuss the change described below: review it, explain it, or help plan next steps.',
].join(' ');

const SYSTEM_REST = [
  'The human can forward your words to the live session with one click, or fire one of your premade follow-ups.',
  'Keep answers short and concrete. Name file paths and line numbers when you reference code.',
  'Format the content as GitHub-flavored markdown: short sections under ### headings, fenced code blocks with language tags, - bullets for lists, and | tables | for comparisons.',
  'Reply with ONLY a JSON object, no fences, no other text:',
  '{"content": "your markdown answer", "followups": [{"title": "button label, 4 words max", "kind": "session|chat", "text": "premade text"}]}.',
  'A "session" followup sends its text to the live session: use it for commands, review findings, or plans to execute.',
  'A "chat" followup asks you another premade question.',
  'Offer 0-2 followups, only when genuinely useful.',
].join(' ');

/** Capability line: tool sessions pull repo detail on demand, others get the summary only. */
function systemPrompt(tools: boolean): string {
  const access = tools
    ? 'You have read-only repo tools (repo_map, pr_info, pr_diff, working_diff, read_file, commit_show): call them instead of guessing about code you have not seen, then answer. You cannot run commands or change anything; say so when asked for more.'
    : 'You cannot run commands or see anything beyond the context given; say so when asked for more.';
  return `${SYSTEM_BASE} ${access} ${SYSTEM_REST}`;
}

function contextBlock(ctx: ChatContext, tools: boolean): string {
  const head = [
    `Session: ${ctx.title} (${ctx.session})`,
    ctx.branch ? `Branch: ${ctx.branch}` : null,
    ctx.pr ? `Pull request: #${ctx.pr}` : null,
  ].filter(Boolean).join('\n');
  // Caps and truncation notes are owned by changeContext(); this stays verbatim.
  const tail = tools ? '\nUse the repo tools to read the branch, pull request, or working tree beyond this summary.' : '';
  return `${head}\n${ctx.diff || '(working tree clean)'}${tail}`;
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

// ---------- repo tools: the model pulls detail on demand instead of getting
// a full dump up front. Every tool is read-only and scoped to the session's
// repo; failures degrade to notes, never throws.

const MAX_TOOL_ROUNDS = 6;
const TOOL_RESULT_LIMIT = 12_000;

type ToolDef = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };

const PATHS_SCHEMA = {
  type: 'object',
  properties: {
    paths: { type: 'array', items: { type: 'string' }, description: 'Exact repo-relative file paths to keep; omit for the whole patch.' },
    max_chars: { type: 'number', description: `Cap on returned characters (default ${TOOL_RESULT_LIMIT}, max 60000).` },
  },
  additionalProperties: false,
};

const REPO_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'repo_map',
      description: 'Orient on the checkout: branch and HEAD, pull-request metadata with CI check counts, working-tree stat, and the PR file list. Call first when the summary is not enough.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pr_info',
      description: 'Pull-request title, base and head branches, state, mergeability, and per-check results.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pr_diff',
      description: 'The pull-request patch (branch vs base). Large PRs truncate: narrow with paths or expect a list of omitted files.',
      parameters: PATHS_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'working_diff',
      description: 'Uncommitted changes (git diff HEAD). Same truncation rules as pr_diff.',
      parameters: PATHS_SCHEMA,
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the working tree, HEAD, or the PR base. Paths stay inside the repo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Repo-relative file path.' },
          ref: { type: 'string', enum: ['working', 'HEAD', 'base'], description: 'Which version to read (default working).' },
          max_chars: { type: 'number', description: `Cap on returned characters (default ${TOOL_RESULT_LIMIT}, max 60000).` },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'commit_show',
      description: 'Stat plus patch of one commit, by full or abbreviated sha.',
      parameters: {
        type: 'object',
        properties: { sha: { type: 'string', description: 'Commit sha.' }, max_chars: { type: 'number', description: 'Patch cap (default 12000, max 60000).' } },
        required: ['sha'],
        additionalProperties: false,
      },
    },
  },
];

type ToolEnv = {
  root: string;
  pr: number | null;
  branch: string | null;
  working: () => Promise<string>;
  prPatchText: () => Promise<string | null>;
  meta: () => Promise<PrMeta | null>;
};

/** Tool scope for a session dir: null outside a repo (legacy one-shot chat). */
export async function repoToolEnv(dir: string | null | undefined, pr: number | null, branch: string | null): Promise<ToolEnv | null> {
  if (!dir) return null;
  let root: string;
  try {
    root = await toplevel(dir);
  } catch {
    return null;
  }
  const memo = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
    let p: Promise<T> | null = null;
    return () => (p ??= fn());
  };
  return {
    root,
    pr,
    branch,
    working: memo(() => workingPatch(root)),
    prPatchText: memo(async () => (pr === null ? null : await prPatch(root, pr).catch(() => null))),
    meta: memo(async () => (pr === null ? null : await prMeta(root, pr).catch(() => null))),
  };
}

function toolMax(args: Record<string, unknown>): number {
  const n = args.max_chars;
  if (typeof n !== 'number' || !Number.isFinite(n)) return TOOL_RESULT_LIMIT;
  return Math.min(60000, Math.max(1000, Math.floor(n)));
}

function toolPaths(args: Record<string, unknown>): string[] | undefined {
  const p = args.paths;
  if (p === undefined) return undefined;
  if (!Array.isArray(p)) throw new Error('paths must be an array of strings');
  const out = p.map((x) => {
    if (typeof x !== 'string' || !x.trim() || x.length > 500) throw new Error('paths must be an array of strings');
    return x.trim();
  });
  return [...new Set(out)].slice(0, 50);
}

/**
 * File paths from a `diff --git` header. Generation forces canonical a/ b/,
 * but a quoted or single-letter (mnemonic) prefix is tolerated so foreign
 * patches (e.g. pasted `gh` output) still slice.
 */
function diffNames(header: string): string[] {
  const m = header.match(/^diff --git (?:"([^"]+)"|(\S+)) (?:"([^"]+)"|(\S+))\s*$/);
  if (!m) return [];
  const norm = (p: string) => p.replace(/^[a-z]\//, '');
  return [norm(m[1] ?? m[2]), norm(m[3] ?? m[4])];
}

/** Keep only the hunks for `paths`, then cap: omitted files are named so the model can ask again. */
function slicePatch(patch: string, paths: string[] | undefined, max: number): string {
  const blocks = patch.split(/(?=^diff --git )/m).filter((b) => b.startsWith('diff --git '));
  const names = (b: string): string[] => diffNames(b.split('\n', 1)[0]);
  const kept = paths ? blocks.filter((b) => names(b).some((n) => paths.includes(n))) : blocks;
  if (!kept.length) return paths ? `(no patch hunks for: ${paths.join(', ')})` : '(empty patch)';
  let out = '';
  const omitted: string[] = [];
  for (const b of kept) {
    if (out.length + b.length > max) {
      omitted.push(names(b)[0] || 'unknown');
      continue;
    }
    out += b;
  }
  if (paths) {
    const missing = paths.filter((p) => !blocks.some((b) => names(b).includes(p)));
    if (missing.length) out += `\n(no patch hunks for: ${missing.join(', ')})`;
  }
  if (omitted.length) out += `\n... (truncated: ${omitted.length} more file${omitted.length === 1 ? '' : 's'} omitted: ${omitted.slice(0, 8).join(', ')})`;
  return out;
}

function prFileList(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    const [first] = diffNames(line);
    if (first) files.add(first);
  }
  return [...files];
}

/**
 * One repo-tool call. Returns display text (capped), never throws: bad input
 * and backend failures become notes the model can react to.
 */
export async function runRepoTool(env: ToolEnv, name: string, rawArgs: unknown): Promise<string> {
  try {
    const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};
    switch (name) {
      case 'repo_map': {
        const [branchOut, headOut, stat, patch, meta] = await Promise.all([
          run('git', ['-C', env.root, 'branch', '--show-current'], { maxBuffer: 64 * 1024, timeout: 10_000 }).then((r) => r.stdout.trim(), () => ''),
          run('git', ['-C', env.root, 'log', '-1', '--format=%H %s'], { maxBuffer: 64 * 1024, timeout: 10_000 }).then((r) => r.stdout.trim(), () => ''),
          workingStat(env.root),
          env.prPatchText(),
          env.meta(),
        ]);
        const lines = [`Branch: ${branchOut || env.branch || '(unknown)'}`, headOut ? `HEAD: ${headOut}` : null];
        if (env.pr === null) lines.push('Pull request: none for this branch');
        else if (!meta) lines.push(`Pull request: #${env.pr} (unavailable — gh failed or no access)`);
        else {
          lines.push(`Pull request: #${meta.number} "${meta.title}" (${meta.head}...${meta.base}) state=${meta.state}${meta.mergeable ? ` mergeable=${meta.mergeable}` : ''} ${meta.url}`);
          lines.push(
            meta.checks
              ? `Checks: ${meta.checks.pass} pass, ${meta.checks.fail} fail, ${meta.checks.pending} pending${meta.checks.failing.length ? ` (failing: ${meta.checks.failing.join(', ')})` : ''}`
              : 'Checks: none reported',
          );
        }
        lines.push(`Working tree: ${stat || 'clean'}`);
        if (patch) {
          const files = prFileList(patch);
          lines.push(
            files.length <= 60
              ? `PR files (${files.length}): ${files.join(', ')}`
              : `PR files (${files.length}): ${files.slice(0, 60).join(', ')} ... and ${files.length - 60} more — ask pr_diff with paths=[...]`,
          );
        } else if (env.pr !== null) lines.push('PR patch: unavailable (gh failed or no access)');
        return lines.filter(Boolean).join('\n');
      }
      case 'pr_info': {
        if (env.pr === null) return 'No pull request in context for this branch.';
        const meta = await env.meta();
        if (!meta) return `Pull request #${env.pr} is unavailable (gh failed or no access).`;
        const checks = meta.checks
          ? `Checks: ${meta.checks.pass} pass, ${meta.checks.fail} fail, ${meta.checks.pending} pending${meta.checks.failing.length ? `\nFailing: ${meta.checks.failing.join('\n')}` : ''}`
          : 'Checks: none reported';
        return [`#${meta.number} ${meta.title}`, meta.url, `Base: ${meta.base}`, `Head: ${meta.head}`, `State: ${meta.state}`, `Mergeable: ${meta.mergeable ?? 'unknown'}`, checks].join('\n');
      }
      case 'pr_diff': {
        if (env.pr === null) return 'No pull request in context for this branch.';
        const patch = await env.prPatchText();
        if (patch === null) return `Pull request #${env.pr} patch is unavailable (gh failed or no access).`;
        return slicePatch(patch, toolPaths(args), toolMax(args));
      }
      case 'working_diff': {
        const patch = await env.working();
        if (!patch.trim()) return '(working tree clean)';
        return slicePatch(patch, toolPaths(args), toolMax(args));
      }
      case 'read_file': {
        const p = args.path;
        if (typeof p !== 'string' || !p.trim() || p.length > 500) return 'read_file needs a repo-relative path.';
        const max = toolMax(args);
        const ref = args.ref === undefined || args.ref === 'working' ? 'working' : args.ref === 'HEAD' || args.ref === 'base' ? args.ref : null;
        if (!ref) return "ref must be 'working', 'HEAD', or 'base'.";
        if (ref === 'working') {
          const abs = join(env.root, p);
          if (!abs.startsWith(env.root + sep)) return 'Path escapes the repo.';
          let text: string;
          try {
            const size = (await stat(abs)).size;
            if (size > 100_000) return `File too large (${size} bytes), not shown.`;
            text = await readFile(abs, 'utf8');
          } catch {
            return `Cannot read ${p} from the working tree.`;
          }
          if (text.includes('\0')) return 'Binary file, not shown.';
          return text.length > max ? `${text.slice(0, max)}\n... (truncated)` : text;
        }
        const rev = ref === 'HEAD' ? 'HEAD' : await (async () => {
          const meta = await env.meta();
          if (!meta?.base) return null;
          return await mergeBase(env.root, meta.base);
        })();
        if (!rev) return 'PR base is not available locally.';
        try {
          return await showAtRef(env.root, rev, p, max);
        } catch (err) {
          return (err as Error).message;
        }
      }
      case 'commit_show': {
        if (typeof args.sha !== 'string') return 'commit_show needs a sha.';
        try {
          const { stat, patch } = await commitShow(env.root, args.sha, toolMax(args));
          return `${stat}${patch.trim() ? `\n\n${patch}` : '\n\n(no patch — merge or empty commit)'}`;
        } catch (err) {
          return (err as Error).message;
        }
      }
      default:
        return `Unknown tool: ${name}. Available: repo_map, pr_info, pr_diff, working_diff, read_file, commit_show.`;
    }
  } catch (err) {
    return `Tool failed: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
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
    return { id: s.id, name: s.name, baseUrl: s.baseUrl, model: s.model, hasKey: !!s.apiKey, isDefault: s.id === defaultId, envName: s.envName ?? null };
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

  /** `envName` hands the key to sessions as that variable; '' stops it, undefined leaves it as is. */
  async put(input: { id?: string; name: string; baseUrl: string; model: string; apiKey?: string; envName?: string }): Promise<SubscriptionInfo> {
    const name = input.name.trim();
    const model = input.model.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, '');
    if (!name) throw new SideChatError(400, 'name required');
    if (!model) throw new SideChatError(400, 'model required');
    if (!/^https?:\/\/[^/]+/.test(baseUrl)) throw new SideChatError(400, 'base URL must be http(s)');
    const envName = input.envName === undefined ? undefined : await this.checkEnvName(input.envName.trim(), input.id);
    if (input.id) {
      const s = await this.db.subscription.findUnique({ where: { id: input.id } });
      if (!s) throw new SideChatError(404, 'subscription not found');
      const apiKey = input.apiKey !== undefined && input.apiKey !== '' ? input.apiKey : s.apiKey;
      if (!apiKey) throw new SideChatError(400, 'API key required');
      const updated = await this.db.subscription.update({ where: { id: input.id }, data: { name, baseUrl, model, apiKey, ...(envName !== undefined ? { envName } : {}) } });
      return this.redact(updated, await this.defaultId());
    }
    if (!input.apiKey) throw new SideChatError(400, 'API key required');
    const created = await this.db.subscription.create({ data: { id: randomUUID(), name, baseUrl, model, apiKey: input.apiKey, envName: envName ?? null } });
    if (!(await this.db.setting.findUnique({ where: { key: DEFAULT_SETTING } }))) {
      await this.db.setting.create({ data: { key: DEFAULT_SETTING, value: created.id } });
    }
    return this.redact(created, await this.defaultId());
  }

  /** A session variable name no other subscription or saved variable already uses; null for ''. */
  private async checkEnvName(envName: string, id: string | undefined): Promise<string | null> {
    if (!envName) return null;
    try {
      checkName(envName);
    } catch (err) {
      throw new SideChatError(400, `variable name: ${(err as Error).message}`);
    }
    const [other, saved] = await Promise.all([
      this.db.subscription.findFirst({ where: { envName, ...(id ? { id: { not: id } } : {}) }, select: { name: true } }),
      this.db.envVar.findUnique({ where: { name: envName }, select: { name: true } }),
    ]);
    if (other) throw new SideChatError(409, `the "${other.name}" subscription already sets ${envName}`);
    if (saved) throw new SideChatError(409, `${envName} is already set under Settings → Environment`);
    return envName;
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

  /** One provider round; tools attached only when offered. */
  private async complete(
    sub: Subscription,
    messages: Record<string, unknown>[],
    withTools: boolean,
    signal: AbortSignal,
  ): Promise<{ content: unknown; toolCalls: Array<{ id: string; name: string; args: unknown; echoArgs: string }> }> {
    let res: Response;
    try {
      res = await fetch(`${sub.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${sub.apiKey}` },
        body: JSON.stringify({ model: sub.model, messages, ...(withTools ? { tools: REPO_TOOLS, tool_choice: 'auto' } : {}) }),
        signal,
      });
    } catch (err) {
      throw new SideChatError(err instanceof Error && err.name === 'AbortError' ? 504 : 502, err instanceof Error && err.name === 'AbortError' ? 'chat provider timed out' : 'chat provider unreachable');
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SideChatError(502, `chat provider: ${res.status} ${firstLine(body) || res.statusText}`.trim());
    }
    let data: { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }> } }> };
    try {
      data = await res.json();
    } catch {
      throw new SideChatError(502, 'chat provider returned invalid JSON');
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new SideChatError(502, 'chat provider returned an empty reply');
    const toolCalls: Array<{ id: string; name: string; args: unknown; echoArgs: string }> = [];
    if (withTools && Array.isArray(msg.tool_calls)) {
      msg.tool_calls.forEach((c, i) => {
        const fn = c?.function;
        if (c?.type !== 'function' || !fn || typeof fn.name !== 'string' || !fn.name) return;
        const echoArgs = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
        let args: unknown = {};
        try {
          args = JSON.parse(echoArgs);
        } catch {
          args = { _raw: echoArgs };
        }
        toolCalls.push({ id: typeof c.id === 'string' && c.id ? c.id : `call_${i}`, name: fn.name, args, echoArgs });
      });
    }
    return { content: msg.content, toolCalls };
  }

  async chat(uid: string, text: string, ctx: ChatContext, subscriptionId?: string): Promise<ChatReply> {
    const sub = await this.resolve(subscriptionId);
    const prior = (await this.history(uid)).slice(-HISTORY_LIMIT);
    // Repo tools when the session lives in a checkout; otherwise the legacy one-shot.
    const env = await repoToolEnv(ctx.dir, ctx.pr, ctx.branch);
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: `${systemPrompt(!!env)}\n\n${contextBlock(ctx, !!env)}` },
      ...prior.map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: text },
    ];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    // Providers without function calling get the legacy shape on retry.
    let offerTools = !!env;
    let retriedPlain = false;
    try {
      for (let round = 0; ; round++) {
        let content: unknown;
        let toolCalls: Array<{ id: string; name: string; args: unknown; echoArgs: string }>;
        try {
          ({ content, toolCalls } = await this.complete(sub, messages, offerTools, ctrl.signal));
        } catch (err) {
          if (offerTools && !retriedPlain && err instanceof SideChatError && /tool|function/i.test(err.message)) {
            offerTools = false;
            retriedPlain = true;
            ({ content, toolCalls } = await this.complete(sub, messages, false, ctrl.signal));
            toolCalls = [];
          } else throw err;
        }
        if (offerTools && toolCalls.length && round < MAX_TOOL_ROUNDS && env) {
          const results = await Promise.all(toolCalls.map((c) => runRepoTool(env, c.name, c.args)));
          messages.push({
            role: 'assistant',
            content: typeof content === 'string' ? content : '',
            tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.echoArgs } })),
          });
          toolCalls.forEach((c, i) => messages.push({ role: 'tool', tool_call_id: c.id, content: results[i] }));
          continue;
        }
        if (offerTools && toolCalls.length) {
          // Tool budget spent: one last answer without tools.
          messages.push({ role: 'user', content: 'Tool budget spent. Reply now with ONLY the JSON object, no tool calls.' });
          offerTools = false;
          continue;
        }
        if (typeof content !== 'string' || !content.trim()) throw new SideChatError(502, 'chat provider returned an empty reply');
        // Follow-ups and tool chatter are ephemeral UI; history keeps the answer text only.
        const { content: answer, followups } = parseStructured(content);
        const at = Math.floor(Date.now() / 1000);
        const log = [...prior, { role: 'user' as const, text, at }, { role: 'assistant' as const, text: answer, at }].slice(-HISTORY_LIMIT);
        await this.db.$transaction([
          this.db.chatMessage.deleteMany({ where: { uid } }),
          this.db.chatMessage.createMany({ data: log.map((m) => ({ uid, role: m.role, text: m.text, at: m.at })) }),
        ]);
        const saved = await this.db.chatMessage.findFirst({ where: { uid }, orderBy: { id: 'desc' }, select: { id: true } });
        return { message: { role: 'assistant', text: answer, at, id: saved?.id }, followups };
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One-shot handoff brief. Uses the chat subscription and does not write
   * side-chat history or offer repo tools.
   */
  async summarize(text: string, subscriptionId?: string): Promise<string> {
    const body = text.trim();
    if (!body) throw new SideChatError(400, 'text required');
    const sub = await this.resolve(subscriptionId);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
    try {
      const { content } = await this.complete(
        sub,
        [
          {
            role: 'system',
            content: [
              'You write a handoff brief for another coding agent that will continue this session.',
              'The transcript is user and assistant prose. Tool calls were left out.',
              'Cover what is being done, what was decided, what is already done, and what is still open.',
              'Plain prose, a few short paragraphs. No title, no preamble, no JSON.',
            ].join(' '),
          },
          { role: 'user', content: body },
        ],
        false,
        ctrl.signal,
      );
      if (typeof content !== 'string' || !content.trim()) throw new SideChatError(502, 'chat provider returned an empty reply');
      return content.trim();
    } finally {
      clearTimeout(timer);
    }
  }
}
