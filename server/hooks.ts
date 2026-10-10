// Agent status hooks: Claude Code hook entries and Codex's notify program, all
// pointing at bin/ah-hook.js. Shared by `ah hooks …` and Settings → System.
// Every write keeps a `.ah-backup` of the file it changes and touches only
// entries that run ah-hook.js.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../bin/ah-hook.js', import.meta.url));
const claudeSettings = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
const codexConfig = () => join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const isOurs = (h: any) => typeof h?.command === 'string' && h.command.includes('ah-hook.js');

type Group = { matcher?: string; hooks?: any[] };
type Settings = { hooks?: Record<string, Group[]>; [k: string]: unknown };

function readJson(file: string): Settings {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

function backup(file: string) {
  if (existsSync(file)) copyFileSync(file, `${file}.ah-backup`);
}

export type HooksStatus = {
  claude: { wired: number; of: number; file: string };
  codex: { wired: boolean; otherNotify: boolean; file: string };
};

export function hooksStatus(): HooksStatus {
  let claude: Settings = {};
  try {
    claude = readJson(claudeSettings());
  } catch {}
  const wired = CLAUDE_EVENTS.filter((e) => claude.hooks?.[e]?.some((g) => g.hooks?.some(isOurs))).length;
  const codexText = existsSync(codexConfig()) ? readFileSync(codexConfig(), 'utf8') : '';
  return {
    claude: { wired, of: CLAUDE_EVENTS.length, file: claudeSettings() },
    codex: { wired: codexText.includes('ah-hook.js'), otherNotify: !codexText.includes('ah-hook.js') && /^\s*notify\s*=/m.test(codexText), file: codexConfig() },
  };
}

export function installClaude(): string {
  const file = claudeSettings();
  const settings = readJson(file);
  settings.hooks ??= {};
  const command = `node ${JSON.stringify(HOOK)} claude`;
  for (const event of CLAUDE_EVENTS) {
    const groups = (settings.hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }));
    const kept = groups.filter((g) => g.hooks.length);
    kept.push({ ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
    settings.hooks[event] = kept;
  }
  backup(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return `Claude Code: hooks installed in ${file} (backup: settings.json.ah-backup). Running Claude sessions pick them up after a restart (or /hooks).`;
}

export function uninstallClaude(): string {
  const file = claudeSettings();
  const settings = readJson(file);
  if (!settings.hooks) return 'Claude Code: nothing to remove';
  for (const event of Object.keys(settings.hooks)) {
    const kept = settings.hooks[event].map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) })).filter((g) => g.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  backup(file);
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return `Claude Code: hooks removed from ${file}`;
}

export function installCodex(): string {
  const file = codexConfig();
  const line = `notify = ["node", ${JSON.stringify(HOOK)}, "codex"]`;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (text.includes('ah-hook.js')) return 'Codex: already wired';
  if (/^\s*notify\s*=/m.test(text)) return `Codex: ${file} already has a notify program, and Codex allows only one. Replace it with: ${line}`;
  // notify is a top-level key, so it must come before the first [table].
  const firstTable = text.search(/^\s*\[/m);
  const next = firstTable < 0 ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n` : `${text.slice(0, firstTable)}${line}\n\n${text.slice(firstTable)}`;
  backup(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);
  return `Codex: notify installed in ${file} (backup: config.toml.ah-backup)`;
}

export function uninstallCodex(): string {
  const file = codexConfig();
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (!text.includes('ah-hook.js')) return 'Codex: nothing to remove';
  backup(file);
  writeFileSync(file, text.replace(/^\s*notify\s*=\s*\[[^\]]*ah-hook\.js[^\]]*\]\s*\n?/m, ''));
  return `Codex: notify removed from ${file}`;
}
