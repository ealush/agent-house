// Client commands: a thin view over the local daemon's HTTP API (F5), also usable by
// agents to drive other agents (F37):  ah send reviewer "check this diff" && ah wait reviewer && ah read reviewer
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../server/config.ts';

const STATE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah');
/** Written 0600 by the running server; proves we're on the host as its user. */
function localToken() {
  try {
    return readFileSync(join(STATE, 'local-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const config = loadConfig();
const PORT = Number(process.env.AH_PORT ?? config.port);
const BASE = `http://127.0.0.1:${PORT}`;

export const HELP = `usage: ah <command>

  serve [--port N]                            run the daemon on loopback (default command)
  setup tailscale [--off]                     expose ah on your tailnet via \`tailscale serve\` (once)
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
  auth code                                   one-time code to set up a new device (10 min)
  auth password [--remove]                    set the optional master password
  auth token <name>                           token for another host to proxy this one
  auth status                                 passkeys, signed-in devices, recent activity
  peers trust <peer> <token>                  use a token issued by <peer> (on the hub)

<target> is a session id, a window id (@12), a name, or the start of a history title.`;

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: {
        authorization: `Bearer ${localToken()}`,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json', 'x-ah': '1', origin: BASE }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    fail(`ah isn't running on ${BASE} (start it with \`systemctl --user start ah\` or \`pnpm start\`)`);
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
    case 'auth': {
      const sub = args.shift();
      if (sub === 'code') {
        const { code, ttlMinutes } = await call('POST', '/api/auth/code');
        return console.log(`\n  ${code}\n\n  Enter it on the new device within ${ttlMinutes} minutes. It works once.\n`);
      }
      if (sub === 'password') {
        if (flag(args, '--remove')) {
          await call('POST', '/api/auth/password', { password: null });
          return console.log('master password removed');
        }
        const a = await secret('New master password (12+ chars): ');
        const b = await secret('Again: ');
        if (a !== b) fail("passwords don't match");
        await call('POST', '/api/auth/password', { password: a });
        return console.log('master password set');
      }
      if (sub === 'token') {
        const name = args[0] || fail('usage: ah auth token <name-of-the-host-that-will-use-it>');
        const { token } = await call('POST', '/api/auth/tokens', { name });
        return console.log(`\n  ${token}\n\n  On ${name}, run:  node bin/ah.js peers trust ${hostnameGuess()} ${token}\n  Shown once; revoke it from Security in the app.\n`);
      }
      if (sub === 'status' || !sub) {
        const o = await call('GET', '/api/auth/overview');
        console.log(`passkeys (${o.passkeys.length}):`);
        for (const p of o.passkeys) console.log(`  ${p.label}  ${p.rpID}  last used ${new Date(p.lastUsedAt).toLocaleString()}`);
        console.log(`signed-in devices (${o.sessions.length}), idle timeout ${o.idleHours}h, max ${o.maxDays}d:`);
        for (const s of o.sessions) console.log(`  ${s.id}  ${s.label}  via ${s.via}  seen ${new Date(s.lastSeenAt).toLocaleString()}`);
        console.log(`master password: ${o.password ? 'set' : 'not set'}; host tokens: ${o.tokens.map((t) => t.name).join(', ') || 'none'}`);
        return;
      }
      fail('usage: ah auth code | password [--remove] | token <name> | status');
    }
    case 'setup': {
      if (args[0] !== 'tailscale') fail('usage: ah setup tailscale [--off]');
      // A one-time, persistent Serve config owned by tailscaled. ah itself never changes
      // its exposure; it only ever listens on loopback.
      const off = flag(args, '--off');
      const cmd = off ? ['serve', '--https=443', 'off'] : ['serve', '--bg', '--https=443', `http://127.0.0.1:${PORT}`];
      console.log(`$ tailscale ${cmd.join(' ')}`);
      const r = spawnSync('tailscale', cmd, { stdio: 'inherit' });
      if (r.status !== 0) fail('tailscale serve failed (is Serve enabled on your tailnet? the command above prints a link if not)');
      if (!off) spawnSync('tailscale', ['serve', 'status'], { stdio: 'inherit' });
      return;
    }
    case 'peers': {
      if (args[0] !== 'trust' || !args[1] || !args[2]) fail('usage: ah peers trust <peer> <token>');
      const file = join(STATE, 'peer-tokens.json');
      let tokens = {};
      try {
        tokens = JSON.parse(readFileSync(file, 'utf8'));
      } catch {}
      tokens[args[1]] = args[2];
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(file, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      return console.log(`trusting ${args[1]}; it will show up within 30s`);
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

function hostnameGuess() {
  return process.env.HOSTNAME || spawnSync('hostname', { encoding: 'utf8' }).stdout.trim() || 'this-host';
}

let pipedLines = null;

/** Reads a line from the terminal without echoing it. */
function secret(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // Piped (e.g. scripts/tests): one line per prompt.
      pipedLines ??= readFileSync(0, 'utf8').split('\n');
      process.stdout.write('\n');
      resolve(pipedLines.shift() ?? '');
      return;
    }
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
