// Client commands: a thin view over the local daemon's HTTP API (F5), also usable by
// agents to drive other agents (F37):  ah send reviewer "check this diff" && ah wait reviewer && ah read reviewer
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../server/config.ts';

const config = loadConfig();
const PORT = Number(process.env.AH_PORT ?? config.port);
const BASE = `http://127.0.0.1:${PORT}`;

export const HELP = `usage: ah <command>

  serve [--port N] [--host H] [--tailscale]   run the daemon (default command)
  list [--json]                               live sessions
  history [--json]                            ended and saved conversations
  new <harness> [--cwd DIR] [--name N] [--session S] [--continue]
  attach <target>                             open a session in this terminal
  send <target> <text…|->  [--no-enter]       type in now, queue if busy, resume if dead
  read <target> [-n LINES]                    print the session's screen + scrollback
  wait <target> [--timeout SECS]              block until the agent stops working
  resume <target>                             bring an ended/saved conversation back
  queue <target> [--clear]                    show or drop queued messages
  hooks install|uninstall|status              wire Claude Code / Codex status hooks

<target> is a session id, a window id (@12), a name, or the start of a history title.`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ah': '1', origin: BASE },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`ah isn't running on ${BASE} (start it with \`pnpm serve\` or \`ah serve\`)`);
  }
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).error ?? text;
    } catch {}
    fail(msg);
  }
  return (res.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;
}

function fail(msg) {
  console.error(`ah: ${msg}`);
  process.exit(1);
}

function opt(args, name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

/** Resolves a user-typed target to a live window or a history entry. */
async function find(target, { history = false } = {}) {
  if (!target) fail('missing <target>');
  const state = await call('GET', '/api/state');
  const t = target.toLowerCase();
  const live =
    state.windows.find((w) => w.uid === target || w.id === target) ??
    state.windows.find((w) => w.name.toLowerCase() === t) ??
    unique(state.windows.filter((w) => w.name.toLowerCase().startsWith(t)), target);
  if (live) return { live, state };
  if (history) {
    const past =
      state.history.find((h) => h.ref === target || h.harnessId === target) ??
      unique(state.history.filter((h) => h.title.toLowerCase().startsWith(t) || h.title.toLowerCase().includes(t)), target);
    if (past) return { past, state };
  }
  fail(`no session matches "${target}"`);
}

function unique(list, target) {
  if (list.length > 1) fail(`"${target}" is ambiguous: ${list.map((x) => x.name ?? x.title).join(', ')}`);
  return list[0];
}

const STATUS = { waiting: '● needs you', attention: '◆ done', busy: '◌ working', idle: '○ idle' };

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
}

export async function run(cmd, args) {
  switch (cmd) {
    case 'list': {
      const { windows } = await call('GET', '/api/state');
      if (flag(args, '--json')) return console.log(JSON.stringify(windows, null, 2));
      if (!windows.length) return console.log('nothing running');
      table([
        ['ID', 'WINDOW', 'NAME', 'AGENT', 'STATUS', 'PROJECT', 'QUEUED'],
        ...windows.map((w) => [w.uid, `${w.session}:${w.index}`, w.name, w.agent ?? w.command, STATUS[w.status], w.project, w.queued || '']),
      ]);
      return;
    }
    case 'history': {
      const { history } = await call('GET', '/api/state');
      if (flag(args, '--json')) return console.log(JSON.stringify(history, null, 2));
      table([['REF', 'HARNESS', 'WHEN', 'PROJECT', 'TITLE'], ...history.map((h) => [h.ref, h.harness, new Date(h.at * 1000).toLocaleString(), h.project, h.title])]);
      return;
    }
    case 'new': {
      const harness = args.shift() ?? 'shell';
      const body = {
        preset: harness,
        cwd: resolve(opt(args, '--cwd', process.cwd())),
        label: opt(args, '--name', ''),
        session: opt(args, '--session', ''),
        resume: flag(args, '--continue'),
      };
      const out = await call('POST', '/api/windows', body);
      console.log(`${out.uid} ${out.id}`);
      return;
    }
    case 'attach': {
      const { live } = await find(args[0]);
      return attach(live);
    }
    case 'resume': {
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/resume`);
      console.log(`${out.uid} ${out.id}${out.resumed ? ' (resumed)' : ' (already running)'}`);
      return;
    }
    case 'send': {
      const enter = !flag(args, '--no-enter');
      const target = args.shift();
      let text = args.join(' ');
      if (text === '-' || (!text && !process.stdin.isTTY)) text = readFileSync(0, 'utf8').replace(/\n$/, '');
      if (!text) fail('nothing to send');
      const found = await find(target, { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/send`, { text, enter });
      console.log(out.outcome === 'delivered' ? 'sent' : out.resumed ? 'resuming; queued until ready' : `queued (${out.queued})`);
      return;
    }
    case 'read': {
      const lines = Number(opt(args, '-n', '200'));
      const { live } = await find(args[0]);
      process.stdout.write(await call('GET', `/api/windows/${encodeURIComponent(live.id)}/capture?lines=${lines}`));
      return;
    }
    case 'wait': {
      const timeout = Number(opt(args, '--timeout', '0'));
      const { live } = await find(args[0]);
      const start = Date.now();
      // Give a just-sent prompt a moment to register as work before treating quiet as done.
      await new Promise((r) => setTimeout(r, 2000));
      for (;;) {
        const { windows } = await call('GET', '/api/state');
        const w = windows.find((x) => x.uid === live.uid);
        if (!w) fail('session ended');
        if (w.status !== 'busy' && !w.queued) {
          console.log(w.status === 'waiting' ? 'needs input' : 'done');
          process.exit(w.status === 'waiting' ? 2 : 0);
        }
        if (timeout && Date.now() - start > timeout * 1000) fail('timed out');
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    case 'queue': {
      const { live } = await find(args[0]);
      if (flag(args, '--clear')) {
        await call('DELETE', `/api/sessions/${live.uid}/queue`);
        return console.log('cleared');
      }
      const q = await call('GET', `/api/sessions/${live.uid}/queue`);
      if (!q.length) return console.log('queue empty');
      for (const item of q) console.log(`${item.id}  ${item.text.split('\n')[0]}`);
      return;
    }
    default:
      console.log(HELP);
      process.exit(cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1);
  }
}

// Same trick as the web UI: a throwaway session grouped with the target, so attaching
// here doesn't switch windows under any other client looking at that session.
function attach(w) {
  const env = { ...process.env };
  if (env.TMUX) {
    // Already inside tmux: just jump there.
    spawnSync('tmux', ['switch-client', '-t', `=${w.session}`, ';', 'select-window', '-t', w.id], { stdio: 'inherit' });
    return;
  }
  const viewer = `ah-v-${randomBytes(4).toString('hex')}`;
  const r = spawnSync(
    'tmux',
    ['new-session', '-t', `=${w.session}`, '-s', viewer, ';', 'set-option', 'destroy-unattached', 'on', ';', 'select-window', '-t', `${viewer}:${w.id}`],
    { stdio: 'inherit', env },
  );
  process.exit(r.status ?? 0);
}
