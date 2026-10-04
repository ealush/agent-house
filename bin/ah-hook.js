#!/usr/bin/env node
// Agent hook → tmux window options. Runs inside the agent's pane, so it works
// even when the ah server is down; the server reads these options on its next poll.
//
//   Claude Code:  ah-hook.js claude        (hook payload on stdin)
//   Codex notify: ah-hook.js codex <json>  (payload appended as the last argument)
//
// Never fails loudly: a broken hook must not break the agent.
import { execFile } from 'node:child_process';

const pane = process.env.TMUX_PANE;
const harness = process.argv[2];
if (!pane || !harness) process.exit(0);

setTimeout(() => process.exit(0), 3000).unref();

const CLAUDE_STATES = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  PreToolUse: 'working',
  PostToolUse: 'working',
  Notification: 'waiting',
  Stop: 'done',
  SubagentStop: null,
  SessionEnd: 'ended',
};

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

let state = null;
let id = '';
let model = '';

if (harness === 'claude') {
  const p = parse(await readStdin());
  state = CLAUDE_STATES[p.hook_event_name] ?? null;
  // Notification also fires for "idle for 60s" nags after a turn ended. Only a permission
  // or question prompt means the agent is blocked on you; anything else stays "done".
  if (p.hook_event_name === 'Notification') {
    const kind = p.notification_type ?? '';
    const blocking = /permission|elicitation/.test(kind) || (!kind && /permission|needs your|approve/i.test(p.message ?? ''));
    state = blocking ? 'waiting' : null;
  }
  id = p.session_id ?? '';
  model = typeof p.model === 'string' ? p.model : (p.model?.id ?? '');
} else if (harness === 'codex') {
  const p = parse(process.argv.at(-1));
  if (p.type === 'agent-turn-complete') state = 'done';
  id = p['thread-id'] ?? p.thread_id ?? '';
} else {
  // Generic: ah-hook.js <harness> <state> [session-id]
  state = process.argv[3] ?? null;
  id = process.argv[4] ?? '';
}

if (!state) process.exit(0);

const now = String(Math.floor(Date.now() / 1000));
const args = ['set-option', '-w', '-q', '-t', pane, '@ah-state', state, ';', 'set-option', '-w', '-q', '-t', pane, '@ah-state-at', now, ';', 'set-option', '-w', '-q', '-t', pane, '@ah-harness', harness];
if (id) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-harness-id', id);
if (model) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-model', model);
execFile('tmux', args, () => process.exit(0));
