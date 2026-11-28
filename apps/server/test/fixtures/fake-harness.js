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
//   CRASH [ms]           exits mid-turn (an unexpected process exit), after ms of working
//   AUTHFAIL             answers with the harness's "sign in again" error
//   SLOW <ms>            works that long before answering
//   SPAWN <n> <ms> [BG] [NEST]  spawns n subagents in the harness's own format (Claude Code:
//                        subagents/agent-<id>.jsonl + .meta.json; Codex: a rollout per
//                        thread) that work for ms each; BG starts them in the background
//                        (Claude: an async acknowledgement, then a task notification),
//                        NEST has the first one spawn a child of its own
// FAKE_HARNESS_LOG, when set, gets one line per prompt received (for duplicate checks).
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
  const f = args.indexOf('fork');
  const sessions = join(process.env.CODEX_HOME, 'sessions');
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  const rollout = (tid) => (existsSync(sessions) ? walk(sessions).find((x) => x.endsWith(`-${tid}.jsonl`)) : undefined);
  if (r >= 0) {
    id = args[r + 1];
    file = rollout(id);
  }
  // `codex fork <id>`: a new thread of this process's own, from the parent's history, in the
  // current directory only when told so (`-c tui.resume_cwd="current"`); otherwise Codex
  // asks which directory to use, and so does this.
  let forkedFrom;
  let inherited = [];
  if (f >= 0) {
    forkedFrom = args[f + 1];
    const parent = rollout(forkedFrom);
    if (!parent) {
      console.error(`ERROR: No saved session found with ID ${forkedFrom}.`);
      process.exit(1);
    }
    const parentLines = readFileSync(parent, 'utf8').split('\n').filter(Boolean);
    const parentCwd = JSON.parse(parentLines[0]).payload.cwd;
    // Like the real one, the new thread carries the parent's conversation (its messages).
    inherited = parentLines.filter((l) => l.includes('"response_item"'));
    if (parentCwd !== cwd && !args.includes('tui.resume_cwd="current"')) {
      process.stdout.write('Working directory · fork\r\n  Session = latest cwd recorded in the session\r\n  Current = your current working directory\r\n› 1. Use session directory\r\n  2. Use current directory\r\n  3. Always use session directory\r\n  4. Always use current directory\r\n');
      setInterval(() => {}, 1 << 30);
      await new Promise(() => {});
    }
  }
  if (!file) {
    id ??= randomUUID();
    const d = new Date();
    const day = join(sessions, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    mkdirSync(day, { recursive: true });
    file = join(day, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${id}.jsonl`);
    appendFileSync(file, JSON.stringify({ timestamp: now(), type: 'session_meta', payload: { id, cwd, git: { branch: 'main' }, ...(forkedFrom ? { forked_from_id: forkedFrom } : {}) } }) + '\n');
    appendFileSync(file, JSON.stringify({ timestamp: now(), type: 'turn_context', payload: { model: 'gpt-5.5-codex', cwd } }) + '\n');
    for (const l of inherited) appendFileSync(file, l + '\n');
  }
}

// Like the real one, an assistant message is one line per content block, each with the
// message's id and usage (counted once); ids are unique across resumes.
const claudeLine = (type, content, extra = {}) => {
  const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const line = (blocks) => JSON.stringify({ type, uuid: randomUUID(), sessionId: id, cwd, gitBranch: 'main', timestamp: now(), message: type === 'assistant' ? { role: 'assistant', model: 'claude-opus-5-5', id: msgId, content: blocks, usage: { input_tokens: 1200, cache_read_input_tokens: 800, cache_creation_input_tokens: 100, output_tokens: 60 } } : { role: type, content: blocks }, ...extra }) + '\n';
  appendFileSync(file, line(content));
  if (type === 'assistant' && !extra.isApiErrorMessage) appendFileSync(file, line([{ type: 'thinking', thinking: '' }]));
};
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
  // The screen shows minutes, rounded up, as the real CLIs show a future time.
  const t = new Date(Math.ceil((Date.now() + seconds * 1000) / 60000) * 60000);
  const h = t.getHours() % 12 || 12;
  const m = String(t.getMinutes()).padStart(2, '0');
  const ap = t.getHours() < 12 ? 'am' : 'pm';
  if (kind === 'claude') {
    process.stdout.write(`\r\nYou've hit your session limit · resets ${h}:${m}${ap}\r\n`);
    claudeLine('assistant', [{ type: 'text', text: `Claude AI usage limit reached|${Math.floor(Date.now() / 1000) + seconds}` }], { isApiErrorMessage: true });
  } else {
    process.stdout.write(`\r\nYou've hit your usage limit. Upgrade or try again at ${h}:${m} ${ap.toUpperCase()}.\r\n`);
    codexLine('event_msg', { type: 'error', message: `You've hit your usage limit. Try again at ${h}:${m} ${ap.toUpperCase()}.` });
  }
}


// ---------- subagents, as each harness writes them (server/subagents)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const agentId = () => 'a' + randomUUID().replace(/-/g, '').slice(0, 16);
const toolId = () => `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

/** One Claude child: its sidecar, then its transcript as it works, then its outcome in `parentFile`. */
async function claudeChild(parentFile, n, ms, o) {
  const aid = agentId();
  const call = toolId();
  const dir = join(dirname(file), id, 'subagents');
  mkdirSync(dir, { recursive: true });
  const description = o.description ?? `Task ${n}`;
  const at = (f, line) => appendFileSync(f, JSON.stringify({ ...line, timestamp: now() }) + '\n');
  at(parentFile, { type: 'assistant', uuid: randomUUID(), sessionId: id, cwd, isSidechain: parentFile !== file, ...(o.parent ? { agentId: o.parent } : {}), message: { role: 'assistant', id: `msg_${n}`, content: [{ type: 'tool_use', id: call, name: 'Agent', input: { description, subagent_type: 'general-purpose', prompt: `Do task ${n}`, ...(o.bg ? { run_in_background: true } : {}) } }] } });
  writeFileSync(join(dir, `agent-${aid}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId: call, ...(o.parent ? { parentAgentId: o.parent } : {}), spawnDepth: o.depth, requestShape: o.bg ? 'background' : 'foreground' }));
  const child = join(dir, `agent-${aid}.jsonl`);
  const row = (type, content) => at(child, { type, uuid: randomUUID(), isSidechain: true, agentId: aid, sessionId: id, cwd, message: { role: type, content } });
  row('user', `Do task ${n}`);
  if (o.bg) at(parentFile, { type: 'user', uuid: randomUUID(), sessionId: id, cwd, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: [{ type: 'text', text: `Async agent launched successfully. agentId: ${aid}` }] }] }, toolUseResult: { isAsync: true, status: 'async_launched', agentId: aid } });
  row('assistant', [{ type: 'tool_use', id: `toolu_c${n}`, name: 'Bash', input: { command: `echo working on ${n}`, description: `Working on task ${n}` } }]);
  row('user', [{ type: 'tool_result', tool_use_id: `toolu_c${n}`, content: `working on ${n}` }]);
  const done = (async () => {
    if (o.nest) await claudeChild(child, `${n}.1`, ms, { depth: o.depth + 1, parent: aid, description: `Check task ${n}` });
    await sleep(ms);
    row('assistant', [{ type: 'text', text: `Task ${n} done.` }]);
    if (o.bg) at(parentFile, { type: 'queue-operation', operation: 'enqueue', sessionId: id, content: `<task-notification><task-id>${aid}</task-id><tool-use-id>${call}</tool-use-id><status>completed</status><summary>Agent "${description}" finished</summary></task-notification>` });
    else at(parentFile, { type: 'user', uuid: randomUUID(), sessionId: id, cwd, isSidechain: parentFile !== file, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: call, content: [{ type: 'text', text: `Task ${n} done.` }] }] }, toolUseResult: { status: 'completed', agentId: aid, totalDurationMs: ms } });
  })();
  return o.bg ? undefined : done;
}

/** One Codex thread: a rollout of its own naming its parent, a turn in it, and the spawn call in the parent's. */
async function codexChild(parentId, parentFile, n, ms, depth, nest) {
  const tid = randomUUID();
  const d = new Date();
  const day = join(process.env.CODEX_HOME, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  mkdirSync(day, { recursive: true });
  const f = join(day, `rollout-${d.toISOString().replace(/[:.]/g, '-')}-${tid}.jsonl`);
  const at = (target, type, payload) => appendFileSync(target, JSON.stringify({ timestamp: now(), type, payload }) + '\n');
  at(parentFile, 'response_item', { type: 'function_call', name: 'spawn_agent', arguments: JSON.stringify({ message: `Do task ${n}` }), call_id: `call_s${n}` });
  at(f, 'session_meta', { id: tid, session_id: id, parent_thread_id: parentId, timestamp: now(), cwd, source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth, agent_nickname: `Agent ${n}`, agent_role: null } } }, thread_source: 'subagent' });
  at(f, 'event_msg', { type: 'task_started', turn_id: `t${n}` });
  at(f, 'turn_context', { model: 'gpt-5.5-codex', cwd });
  at(f, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Do task ${n}` }] });
  at(f, 'response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['echo', `working on ${n}`] }), call_id: `call_c${n}` });
  at(parentFile, 'response_item', { type: 'function_call_output', call_id: `call_s${n}`, output: JSON.stringify({ agent_id: tid, nickname: `Agent ${n}` }) });
  if (nest) await codexChild(tid, f, `${n}.1`, ms, depth + 1, false);
  await sleep(ms);
  at(f, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Task ${n} done.` }] });
  at(f, 'event_msg', { type: 'task_complete', turn_id: `t${n}`, last_agent_message: `Task ${n} done.` });
}

async function spawn(count, ms, bg, nest) {
  const kids = [];
  for (let i = 1; i <= count; i++) {
    // One spawn call at a time, as the real ones make them.
    if (i > 1) await sleep(5);
    kids.push(kind === 'claude' ? claudeChild(file, i, ms, { depth: 1, bg, nest: nest && i === 1 }) : codexChild(id, file, i, ms, 1, nest && i === 1));
  }
  await Promise.all(kids);
}

tmuxSet({ '@ah-harness': kind, '@ah-harness-id': id });
state('idle');
// Bracketed paste: a multi-line hand-off arrives as one prompt.
process.stdout.write('\x1b[?2004h');
process.stdin.setRawMode(true);
console.log(`READY ${kind} ${id}`);

let buf = '';
let pasting = false;
// FAKE_HARNESS_EAT_ENTER: its first Enter is lost, the text left in its box (Grok's start screen).
let eatEnter = !!process.env.FAKE_HARNESS_EAT_ENTER;
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
  const crash = first.match(/^CRASH(?: (\d+))?/);
  const kids = first.match(/^SPAWN (\d+) (\d+)((?: BG| NEST)*)/);
  const spawning = kids ? spawn(Number(kids[1]), Number(kids[2]), kids[3].includes('BG'), kids[3].includes('NEST')) : Promise.resolve();
  setTimeout(async () => {
    await spawning;
    if (crash) process.exit(3);
    if (limit) limitNotice(Number(limit[1]));
    else if (first.startsWith('AUTHFAIL')) {
      if (kind === 'claude') claudeLine('assistant', [{ type: 'text', text: 'Invalid API key · Please run /login' }], { isApiErrorMessage: true });
      else codexLine('event_msg', { type: 'error', message: 'unexpected status 401 Unauthorized: Please run codex login' });
    }
    else reply(`Got: ${first.slice(0, 80)}`);
    busy = false;
    state('idle');
    console.log(`DONE ${first.slice(0, 40)}`);
    if (queue.length) submit(queue.shift());
  }, slow ? Number(slow[1]) : crash?.[1] ? Number(crash[1]) : 150);
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
    if (eatEnter) {
      eatEnter = false;
      continue;
    }
    const text = buf.replace(/\r/g, '\n');
    buf = '';
    submit(text);
  }
});

process.on('SIGTERM', () => process.exit(0));
