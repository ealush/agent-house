// Composer autocomplete: the agent's slash commands (built in, plus your own
// commands and skills on disk) and files in the session's project for @mentions.
// Read-only and cached briefly; nothing here runs the agent.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import type { Preset } from './config.ts';

export type SlashCommand = { name: string; description: string; source: 'built-in' | 'project' | 'user' | 'skill' };

/** What each agent's own TUI offers. Kept short: the ones you'd type from a phone. */
const BUILT_IN: Record<string, Array<[string, string]>> = {
  claude: [
    ['clear', 'Start a fresh conversation'],
    ['compact', 'Summarize the conversation to free context'],
    ['context', 'Show what fills the context window'],
    ['cost', 'Token usage and cost of this session'],
    ['model', 'Switch the model'],
    ['effort', 'Set reasoning effort'],
    ['permissions', 'Review tool permissions'],
    ['review', 'Review a pull request'],
    ['init', 'Write a CLAUDE.md for this project'],
    ['memory', 'Edit memory files'],
    ['mcp', 'Manage MCP servers'],
    ['agents', 'Manage subagents'],
    ['hooks', 'Manage hooks'],
    ['rewind', 'Rewind the conversation or code'],
    ['status', 'Version, model, account'],
    ['usage', 'Plan usage limits'],
    ['todos', 'Current todo list'],
    ['export', 'Export the conversation'],
    ['doctor', 'Check the installation'],
    ['help', 'All commands'],
  ],
  codex: [
    ['model', 'Choose model and reasoning effort'],
    ['approvals', 'Choose what Codex may do without asking'],
    ['new', 'Start a new conversation'],
    ['compact', 'Summarize the conversation to free context'],
    ['review', 'Review current changes'],
    ['diff', 'Show the git diff'],
    ['init', 'Write an AGENTS.md for this project'],
    ['status', 'Session configuration and token usage'],
    ['mention', 'Mention a file'],
    ['mcp', 'List MCP tools'],
  ],
  gemini: [
    ['clear', 'Clear the screen and context'],
    ['compress', 'Summarize the conversation to free context'],
    ['model', 'Switch the model'],
    ['memory', 'Manage memory'],
    ['stats', 'Session statistics'],
    ['tools', 'List available tools'],
    ['mcp', 'List MCP servers'],
    ['chat', 'Save or resume conversation checkpoints'],
    ['help', 'All commands'],
  ],
};

/** `name:` and `description:` from YAML front matter, folded blocks included. */
export function frontMatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^(name|description):\s*(.*)$/);
    if (!kv) continue;
    let value = kv[2].trim();
    if (/^[>|][-+]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) block.push(lines[++i].trim());
      value = block.join(' ');
    }
    out[kv[1]] = value.replace(/^["']|["']$/g, '');
  }
  return out;
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function commandDir(dir: string, source: SlashCommand['source'], prefix = ''): Promise<SlashCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: SlashCommand[] = [];
  for (const e of entries) {
    if (e.isDirectory()) {
      // Claude namespaces nested commands: commands/git/commit.md is /git:commit.
      out.push(...(await commandDir(join(dir, e.name), source, `${prefix}${e.name}:`)));
    } else if (e.name.endsWith('.md')) {
      const text = await readFile(join(dir, e.name), 'utf8').catch(() => '');
      const fm = frontMatter(text);
      const firstLine = text.replace(/^---[\s\S]*?---\s*/, '').split('\n').find((l) => l.trim())?.trim() ?? '';
      out.push({ name: `${prefix}${basename(e.name, '.md')}`, description: clip(fm.description ?? firstLine), source });
    }
  }
  return out;
}

async function skillDir(dir: string): Promise<SlashCommand[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: SlashCommand[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const fm = frontMatter(await readFile(join(dir, e.name, 'SKILL.md'), 'utf8').catch(() => ''));
    if (fm.name || fm.description) out.push({ name: fm.name ?? e.name, description: clip(fm.description ?? ''), source: 'skill' });
  }
  return out;
}

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Slash commands for an agent in a directory: project ones first, then yours, then built-ins. */
export function slashCommands(preset: Preset, cwd: string, home = homedir()): Promise<SlashCommand[]> {
  return cached(`cmd:${preset.id}:${cwd}`, 10_000, async () => {
    const builtIn = (BUILT_IN[preset.id] ?? []).map(([name, description]) => ({ name, description, source: 'built-in' as const }));
    if (preset.id !== 'claude') return builtIn;
    const found = [
      ...(await commandDir(join(cwd, '.claude', 'commands'), 'project')),
      ...(await commandDir(join(home, '.claude', 'commands'), 'user')),
      ...(await skillDir(join(cwd, '.claude', 'skills'))),
      ...(await skillDir(join(home, '.claude', 'skills'))),
    ];
    const seen = new Set<string>();
    return [...found, ...builtIn].filter((c) => !seen.has(c.name) && seen.add(c.name));
  });
}

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // No optional locks: a completion lookup must never hold index.lock in an agent's checkout.
    execFile('git', args, { cwd, maxBuffer: 32 * 1024 * 1024, timeout: 5000, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, out) => resolve(err ? '' : out));
  });
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'target', '.venv', '__pycache__', '.cache']);

/** Every file the project tracks (or, outside git, a bounded walk), relative to `cwd`. */
async function listFiles(cwd: string): Promise<string[]> {
  return cached(`files:${cwd}`, 15_000, async () => {
    const tracked = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard']);
    if (tracked) return tracked.split('\n').filter(Boolean).slice(0, 50_000);
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 6 || out.length > 5000) return;
      for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p, depth + 1);
        else out.push(relative(cwd, p));
      }
    };
    await walk(cwd, 0);
    return out;
  });
}

/** Subsequence score with a bonus for matches in the file name and at word starts; 0 = no match. */
export function fileScore(query: string, path: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const p = path.toLowerCase();
  const name = p.slice(p.lastIndexOf('/') + 1);
  if (name.startsWith(q)) return 1000 - p.length;
  if (name.includes(q)) return 800 - p.length;
  if (p.includes(q)) return 600 - p.length;
  let at = 0;
  let score = 0;
  for (const ch of q) {
    const found = p.indexOf(ch, at);
    if (found < 0) return 0;
    score += found === at ? 3 : /[/._-]/.test(p[found - 1] ?? '/') ? 2 : 1;
    at = found + 1;
  }
  return score * 10 - p.length / 10;
}

export async function projectFiles(cwd: string, query: string, limit = 30): Promise<string[]> {
  const files = await listFiles(cwd);
  if (!query) return files.slice(0, limit);
  return files
    .map((f) => ({ f, s: fileScore(query, f) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}
