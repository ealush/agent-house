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
/** What the agent is doing right now ("Editing src/x.ts", "$ pnpm test"). */
let detail = null;
/** What it's blocked on, shown on the Inbox card: { kind: 'command' | 'tool' | 'question', text }. */
let ask = undefined; // undefined = leave as is, null = clear

const short = (s, n = 240) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** AskUserQuestion's input, trimmed to what a form needs. */
function choiceAsk(input = {}) {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const questions = qs
    .filter((q) => q && typeof q.question === 'string' && Array.isArray(q.options))
    .map((q) => ({
      question: short(q.question, 600),
      header: typeof q.header === 'string' ? short(q.header, 40) : undefined,
      multiSelect: q.multiSelect === true,
      options: q.options
        .filter((o) => o && typeof o.label === 'string')
        .map((o) => ({ label: short(o.label, 200), description: typeof o.description === 'string' ? short(o.description, 300) : undefined })),
    }));
  return questions.length ? { kind: 'choice', text: questions[0].question, questions } : null;
}

/** One line describing a tool call, relative to the session's directory. */
function describe(tool, input = {}, cwd = '') {
  const rel = (p) => (typeof p === 'string' && cwd && p.startsWith(cwd + '/') ? p.slice(cwd.length + 1) : p);
  switch (tool) {
    case 'Bash':
      return { kind: 'command', text: short(String(input.command ?? '').trim()) };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
      return { kind: 'tool', text: `Editing ${rel(input.file_path ?? input.notebook_path ?? '')}` };
    case 'Read':
      return { kind: 'tool', text: `Reading ${rel(input.file_path ?? '')}` };
    case 'Grep':
    case 'Glob':
      return { kind: 'tool', text: `Searching ${short(String(input.pattern ?? ''), 80)}` };
    case 'WebFetch':
    case 'WebSearch':
      return { kind: 'tool', text: `Browsing ${short(String(input.url ?? input.query ?? ''), 80)}` };
    case 'Task':
      return { kind: 'tool', text: `Subagent: ${short(String(input.description ?? ''), 80)}` };
    default:
      return { kind: 'tool', text: tool ?? 'Working' };
  }
}

if (harness === 'claude') {
  const p = parse(await readStdin());
  state = CLAUDE_STATES[p.hook_event_name] ?? null;
  // Notification also fires for "idle for 60s" nags after a turn ended. Only a permission
  // or question prompt means the agent is blocked on you; anything else stays "done".
  if (p.hook_event_name === 'Notification') {
    const kind = p.notification_type ?? '';
    const blocking = /permission|elicitation/.test(kind) || (!kind && /permission|needs your|approve/i.test(p.message ?? ''));
    state = blocking ? 'waiting' : null;
    // The pending tool call (recorded at PreToolUse) is the concrete thing to approve.
    if (blocking) ask = /elicitation/.test(kind) ? { kind: 'question', text: short(p.message ?? '') } : 'pending';
  } else if (p.hook_event_name === 'PreToolUse') {
    detail = describe(p.tool_name, p.tool_input, p.cwd);
    // A question dialog blocks on you by definition; carry its questions so the
    // GUI can answer them (the server checks the dialog is really on screen).
    const choice = p.tool_name === 'AskUserQuestion' ? choiceAsk(p.tool_input) : null;
    if (choice) {
      state = 'waiting';
      ask = choice;
    }
  } else if (['PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'].includes(p.hook_event_name)) {
    ask = null;
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

if (!state && !detail) process.exit(0);

const now = String(Math.floor(Date.now() / 1000));
const args = ['set-option', '-w', '-q', '-t', pane, '@ah-harness', harness];
if (state) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-state', state, ';', 'set-option', '-w', '-q', '-t', pane, '@ah-state-at', now);
if (id) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-harness-id', id);
if (model) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-model', model);
if (detail) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-detail', JSON.stringify(detail));
if (ask === 'pending' || ask?.kind === 'question') {
  // Promote the last tool call to the question; needs a read, so do it as a second step.
  // A question dialog recorded at PreToolUse is richer than either, so it stays.
  execFile('tmux', ['show-options', '-w', '-v', '-q', '-t', pane, '@ah-ask'], (_e, current) => {
    if (/"kind":"choice"/.test(current ?? '')) return execFile('tmux', args, () => process.exit(0));
    if (ask !== 'pending') {
      args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-ask', JSON.stringify(ask));
      return execFile('tmux', args, () => process.exit(0));
    }
    execFile('tmux', ['show-options', '-w', '-v', '-q', '-t', pane, '@ah-detail'], (_e2, out) => {
      if (out?.trim()) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-ask', out.trim());
      execFile('tmux', args, () => process.exit(0));
    });
  });
} else {
  // Every other event writes its state here, clearing the ask (null) or setting it.
  if (ask === null) args.push(';', 'set-option', '-w', '-q', '-u', '-t', pane, '@ah-ask');
  else if (ask) args.push(';', 'set-option', '-w', '-q', '-t', pane, '@ah-ask', JSON.stringify(ask));
  execFile('tmux', args, () => process.exit(0));
}
