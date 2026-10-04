#!/usr/bin/env node
// ah — see `ah help`. `serve` runs the daemon; `hooks` wires agent status hooks;
// everything else is a client of the running daemon (bin/cli.js).
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./ah-hook.js', import.meta.url));
const CLAUDE_SETTINGS = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'settings.json');
const CODEX_CONFIG = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml');
const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SessionEnd'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
const isOurs = (h) => typeof h?.command === 'string' && h.command.includes('ah-hook.js');

const [cmd = 'serve', sub] = process.argv.slice(2);

if (cmd === 'serve' || cmd.startsWith('--')) {
  await import('../server/main.ts');
} else if (cmd === 'hooks' && sub === 'install') {
  installClaude();
  installCodex();
} else if (cmd === 'hooks' && sub === 'uninstall') {
  uninstallClaude();
  if (existsSync(CODEX_CONFIG) && readFileSync(CODEX_CONFIG, 'utf8').includes('ah-hook.js')) {
    console.log(`Codex: remove the \`notify = [...ah-hook.js...]\` line from ${CODEX_CONFIG}`);
  }
} else if (cmd === 'hooks' && sub === 'status') {
  const claude = readJson(CLAUDE_SETTINGS);
  const wired = CLAUDE_EVENTS.filter((e) => claude.hooks?.[e]?.some((g) => g.hooks?.some(isOurs)));
  console.log(`Claude Code: ${wired.length}/${CLAUDE_EVENTS.length} events (${CLAUDE_SETTINGS})`);
  const codex = existsSync(CODEX_CONFIG) && readFileSync(CODEX_CONFIG, 'utf8').includes('ah-hook.js');
  console.log(`Codex: ${codex ? 'wired' : 'not wired'} (${CODEX_CONFIG})`);
} else {
  const { run } = await import('./cli.js');
  await run(cmd, process.argv.slice(3));
}

function readJson(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

function backup(file) {
  if (existsSync(file)) copyFileSync(file, `${file}.ah-backup`);
}

function installClaude() {
  const settings = readJson(CLAUDE_SETTINGS);
  settings.hooks ??= {};
  const command = `node ${JSON.stringify(HOOK)} claude`;
  for (const event of CLAUDE_EVENTS) {
    const groups = (settings.hooks[event] ?? []).map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }));
    const kept = groups.filter((g) => g.hooks.length);
    kept.push({ ...(TOOL_EVENTS.has(event) ? { matcher: '*' } : {}), hooks: [{ type: 'command', command, timeout: 5 }] });
    settings.hooks[event] = kept;
  }
  backup(CLAUDE_SETTINGS);
  mkdirSync(dirname(CLAUDE_SETTINGS), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Claude Code: hooks installed in ${CLAUDE_SETTINGS} (backup: settings.json.ah-backup)`);
  console.log('  Already-running Claude sessions pick them up after a restart (or /hooks).');
}

function uninstallClaude() {
  const settings = readJson(CLAUDE_SETTINGS);
  if (!settings.hooks) return console.log('Claude Code: nothing to remove');
  for (const event of Object.keys(settings.hooks)) {
    const kept = settings.hooks[event]
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  backup(CLAUDE_SETTINGS);
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
  console.log(`Claude Code: hooks removed from ${CLAUDE_SETTINGS}`);
}

function installCodex() {
  const line = `notify = ["node", ${JSON.stringify(HOOK)}, "codex"]`;
  const text = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : '';
  if (text.includes('ah-hook.js')) return console.log('Codex: already wired');
  if (/^\s*notify\s*=/m.test(text)) {
    console.log(`Codex: ${CODEX_CONFIG} already has a notify program; Codex allows only one.`);
    console.log(`  Replace it with:  ${line}`);
    return;
  }
  // notify is a top-level key, so it must come before the first [table].
  const firstTable = text.search(/^\s*\[/m);
  const next = firstTable < 0 ? `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n` : `${text.slice(0, firstTable)}${line}\n\n${text.slice(firstTable)}`;
  backup(CODEX_CONFIG);
  mkdirSync(dirname(CODEX_CONFIG), { recursive: true });
  writeFileSync(CODEX_CONFIG, next);
  console.log(`Codex: notify installed in ${CODEX_CONFIG} (backup: config.toml.ah-backup)`);
}
