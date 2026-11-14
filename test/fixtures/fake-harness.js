#!/usr/bin/env node
// A stand-in for Claude Code or Codex (by the name it's run as: bin/claude, bin/codex),
// so portable conversations, migration, scheduling and recovery can be tested end to
// end without an AI CLI. It writes each harness's own transcript format where the real
// one does, resumes by id like the real one (claude --resume <id>, codex resume <id>),
// reports status and its conversation id the way hooks do, and takes a bracketed
// paste as one prompt.
//
// What it says back is scripted: "Got: <first line>". A prompt starting with
//   RATELIMIT <seconds>  prints the harness's usage-limit notice (resetting that far ahead)
//   CRASH                exits mid-turn (an unexpected process exit)
//   SLOW <ms>            works that long before answering
// FAKE_HARNESS_LOG, when set, gets one line per prompt received (for duplicate checks).
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const kind = basename(process.argv[1]) === 'codex' ? 'codex' : 'claude';
const args = process.argv.slice(2);
const cwd = process.cwd();

const tmuxSet = (opts) => {
  if (!process.env.TMUX_PANE) return;
  const a = Object.entries(opts).flatMap(([k, v], i) => [...(i ? [';'] : []), 'set-option', '-w', '-t', process.env.TMUX_PANE, k, v]);
  try {
    execFileSync('tmux', a, { stdio: 'ignore' });
  } catch {}
};
const state = (s) => tmuxSet({ '@ah-state': s, '@ah-state-at': String(Math.floor(Date.now() / 1000)) });

let id;
let file;
const now = () => new Date().toISOString();

if (kind === 'claude') {
  const r = args.indexOf('--resume');
  id = r >= 0 ? args[r + 1] : randomUUID();
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  file = join(dir, `${id}.jsonl`);
} else {
  const r = args.indexOf('resume');
  const sessions = join(process.env.CODEX_HOME, 'sessions');
  if (r >= 0) {
    id = args[r + 1];
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    file = existsSync(sessions) ? walk(sessions).find((f) => f.endsWith(`-${id}.jsonl`)) : undefined;
  }
  if (!file) {
    id ??= randomUUID();
    const d = new Date();
    const day = join(sessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(day, { recursive: true });
    file = join(day, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`);
    appendFileSync(file, JSON.stringify({ timestamp: now(), type: 'session_meta', payload: { id, cwd, git: { branch: 'main' } } }) + '\n');
    appendFileSync(file, JSON.stringify({ timestamp: now(), type: 'turn_context', payload: { model: 'gpt-5.5-codex', cwd } }) + '\n');
  }
}

let n = 0;
const claudeLine = (type, content, extra = {}) =>
  appendFileSync(
    file,
    JSON.stringify({ type, uuid: randomUUID(), sessionId: id, cwd, gitBranch: 'main', timestamp: now(), message: type === 'assistant' ? { role: 'assistant', model: 'claude-opus-5-5', id: `msg_${++n}`, content, usage: { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 60 } } : { role: type, content }, ...extra }) + '\n',
  );
const codexLine = (type, payload) => appendFileSync(file, JSON.stringify({ timestamp: now(), type, payload }) + '\n');

function prompt(text) {
  if (process.env.FAKE_HARNESS_LOG) appendFileSync(process.env.FAKE_HARNESS_LOG, `${kind} ${id} ${JSON.stringify(text.split('\n')[0].slice(0, 120))}\n`);
  if (kind === 'claude') claudeLine('user', text);
  else codexLine('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
}

function reply(text) {
  if (kind === 'claude') claudeLine('assistant', [{ type: 'text', text }]);
  else {
    codexLine('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    codexLine('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 80, reasoning_output_tokens: 20, total_tokens: 2080 } }, rate_limits: { primary: { used_percent: 12.5, window_minutes: 300, resets_in_seconds: 3600 }, secondary: { used_percent: 40, window_minutes: 10080, resets_in_seconds: 86400 } } });
  }
}

function limitNotice(seconds) {
  const t = new Date(Date.now() + seconds * 1000);
  const h = t.getHours() % 12 || 12;
  const m = String(t.getMinutes()).padStart(2, '0');
  const ap = t.getHours() < 12 ? 'am' : 'pm';
  if (kind === 'claude') {
    process.stdout.write(`\r\nYou've hit your session limit · resets ${h}:${m}${ap}\r\n`);
    claudeLine('assistant', [{ type: 'text', text: `Claude AI usage limit reached|${Math.floor(t.getTime() / 1000)}` }], { isApiErrorMessage: true });
  } else {
    process.stdout.write(`\r\nYou've hit your usage limit. Upgrade or try again at ${h}:${m} ${ap.toUpperCase()}.\r\n`);
    codexLine('event_msg', { type: 'error', message: `You've hit your usage limit. Try again at ${h}:${m} ${ap.toUpperCase()}.` });
  }
}

tmuxSet({ '@ah-harness': kind, '@ah-harness-id': id });
state('idle');
// Bracketed paste: a multi-line hand-off arrives as one prompt.
process.stdout.write('\x1b[?2004h');
process.stdin.setRawMode(true);
console.log(`READY ${kind} ${id}`);

let buf = '';
let pasting = false;
let busy = false;
const queue = [];

function submit(text) {
  if (!text.trim()) return;
  if (busy) return void queue.push(text);
  busy = true;
  state('working');
  prompt(text);
  const first = text.trim().split('\n')[0];
  const slow = first.match(/^SLOW (\d+)/);
  const limit = first.match(/^RATELIMIT (\d+)/);
  setTimeout(() => {
    if (first.startsWith('CRASH')) process.exit(3);
    if (limit) limitNotice(Number(limit[1]));
    else reply(`Got: ${first.slice(0, 80)}`);
    busy = false;
    state('idle');
    console.log(`DONE ${first.slice(0, 40)}`);
    if (queue.length) submit(queue.shift());
  }, slow ? Number(slow[1]) : 150);
}

process.stdin.on('data', (chunk) => {
  let s = chunk.toString();
  while (s.length) {
    if (pasting) {
      const end = s.indexOf('\x1b[201~');
      if (end < 0) {
        buf += s;
        s = '';
      } else {
        buf += s.slice(0, end);
        s = s.slice(end + 6);
        pasting = false;
      }
      continue;
    }
    const start = s.indexOf('\x1b[200~');
    const cr = s.search(/[\r\n]/);
    if (start >= 0 && (cr < 0 || start < cr)) {
      buf += s.slice(0, start);
      s = s.slice(start + 6);
      pasting = true;
      continue;
    }
    if (cr < 0) {
      buf += s;
      s = '';
      continue;
    }
    buf += s.slice(0, cr);
    s = s.slice(cr + 1);
    const text = buf.replace(/\r/g, '\n');
    buf = '';
    submit(text);
  }
});

process.on('SIGTERM', () => process.exit(0));
