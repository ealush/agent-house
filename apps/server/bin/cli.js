// Client commands: a thin view over the local daemon's HTTP API (F5), also usable by
// agents to drive other agents (F37):  ah send reviewer "check this diff" && ah wait reviewer && ah read reviewer
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expandHome, loadConfig } from '../server/config.ts';
import { permissionLevelOf, resolvePermissionMode } from '../server/launch.ts';
import { buildChiefBrief } from '../server/supervision.ts';
import { statusWord } from '../web/status.ts';
import { readableConversation } from '../server/portable/readable.ts';
import {
  applyStateDelta,
  diffFleet,
  formatAsk,
  formatDuration,
  formatFeedEntries,
  parseDuration,
  parseSseChunk,
  resolvePickerChoice,
} from '../server/cliHelpers.ts';

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
  mcp                                         run the built-in stdio MCP server (role-scoped tools for agents)
  open [id|name]                              open this tmux window (or that session) in ah's window
  setup tailscale [--off]                     expose ah on your tailnet via \`tailscale serve\` (once)
  setup desktop [--off]                       add ah to the app launcher, in its own window (Omarchy web app)
  list [--status S] [--agent A] [--space P] [--waiting|--busy|--idle] [--exclude-self] [--json]
                                              live sessions
  show <target> [--json]                      detailed session state, mode, queue, reply & pending prompt (also: inspect, status)
  whoami [--json]                             this session's id and state (when run inside an ah session)
  harnesses [--json]                          configured harnesses, permission modes, models & capabilities
  history [--json]                            ended and saved conversations
  new <harness> [--cwd DIR] [--name N] [--session S] [--continue] [--worktree|--no-worktree]
      [--mode M] [--model M] [--effort E] [--trust] [--prompt "TEXT"] [--args "EXTRA"] [--json]
  attach <target>                             open a session in this terminal
  send <target> <text…|-> [--no-enter] [--id ID] [--now|--urgent] [--wait [--timeout SECS]] [--json]
                                              type in now, queue if busy, resume if dead (also: write)
  write <target> <text…|-> [--no-enter] [--id ID] [--now|--urgent] [--wait [--timeout SECS]] [--json]
                                              write a message to a session (alias for send)
  read <target> [-n LINES] [--screen] [--last] [--feed [--before SEQ]] [--conversation] [--json]
                                              read a session's screen, scrollback, last reply, feed or conversation
  conversation <target|link> [-n MESSAGES] [--json]
                                              what was said in it and what ran, oldest first (last 50; -n 0 all)
  watch [target…] [--events status,ask,reply,started,ended] [--once] [--timeout SECS] [--json]
                                              stream live fleet events over SSE
  wait <target> [target…] [--until settled|idle|waiting|ended|any] [--timeout SECS] [--no-grace] [--json]
                                              block until a session settles, needs input, or ends
  mode <target> [mode|level] [--relaunch] [--json]
                                              show or set permission level (harness id or plan|ask|edits|auto|bypass)
  switch <target> (--model M | --effort E) [--relaunch] [--json]
                                              switch model or effort live (or relaunch with --relaunch)
  relaunch <target> [--mode M | --model M | --effort E] [--json]
                                              restart an idle session in the same conversation
  resume <target> [--json]                    bring an ended/saved conversation back
  fork <target> [--name N] [--prompt "TEXT"] [--mode M] [--model M] [--effort E] [--json]
                                              copy the conversation into a new worktree session
  continue <target> --in AGENT [--fork] [--worktree] [--name N] [--preview] [--json]
                                              carry the conversation into another agent (keeps lineage)
  portable <target> [--out FILE]              the conversation as a portable document (JSON)
  lineage <target> [--json]                   where the conversation came from and what came from it
  move <target> --to HOST [--cwd DIR] [--preview] [--yes] [--json]
                                              move a stopped session to another host (it resumes there)
  migrations [--json] | migrations retry|cancel <id>
                                              moves between hosts and how far they got
  jobs [--json]                               scheduled work: what's next, running, waiting on you
  job add --name N (--launch AGENT --cwd DIR --prompt "…" [--mode M] [--model M] [--effort E] [--worktree]
                    | --send TARGET --text "…"
                    | --decide --title "…" [--body "…"] [--then-send TARGET TEXT | --then-launch AGENT CWD PROMPT])
          [--at "2026-11-15 09:00" | --in 30m | --every 5m | --daily 09:00 | --cron "0 9 * * 1-5" [--tz Zone]
           | --after JOB[:success|failure|any] | --when-idle TARGET|* | --when-waiting TARGET|* | --when-ended TARGET|*]
          [--repeat] [--exclude TARGET] [--skip-if-busy] [--if-live] [--until delivered|finished]
          [--max-runs N] [--concurrency-key K] [--retries N] [--notify] [--allow-dangerous] [--auto-recover] [--json]
                                              schedule agent work (no trigger: run it with \`job run\`)
  job edit <id> [--name N] [--every D | --cron E | --at T] [--skip-if-busy|--no-skip-if-busy] [--if-live|--no-if-live] [--json]
  job show|pause|resume|cancel|run <id> [--json]
                                              one job and its runs; change what it does next
  job decide <run> yes|no [--note "…"] [--json]
                                              answer a job waiting on your decision
  job resolve <run> resend|leave [--json]     a run that may or may not have arrived
  heartbeat <target> --every <dur> [--text "…"] [--name N] [--allow-busy] [--wake-ended] [--until delivered|finished] [--max-runs N] [--json]
  heartbeat list [--target TARGET] [--json] | heartbeat stop|pause|resume <job-id> [--json]
                                              periodic heartbeat wakes on a session (skips if busy/ended by default)
  wake <target> (--in D | --at T | --every D | --cron E [--tz Z] | --when-idle S|* | --when-waiting S|* | --when-ended S|*)
       [--repeat] [--text "…"] [--name N] [--skip-if-busy] [--if-live] [--until delivered|finished] [--max-runs N] [--json]
                                              schedule a wake message to a session on time or fleet events
  usage [--days N] [--by model|provider|harness|session|day] [--json] | usage limits | usage export [--json]
                                              tokens, estimates and limit windows (local telemetry; estimates, not a bill)
  recovery [target] [--retry|--pause|--resume|--cancel] [--auto on|off]
                                              limits, provider errors and crashes, and what ah does about them
  restore [target | --all | --incident ID] [--no-note] [--dismiss]
                                              sessions cut off by a tmux stop, a host restart or a closed window
  answer <target> (<yes|no|N|KEY> | --pick I[,I] [--notes "…"] | --answers JSON | --text "…" | --chat | --gate-text "…" | --gate-back | --gate-callback URL) [--prompt ASK_ID] [--json]
                                              answer what a session is asking: approve, deny, pick, dialog, gate or text
  forward <target> [--title "…"] [--note "…"] [--decide [--then-send TARGET TEXT]] [--wait [--timeout SECS]] [--json]
                                              forward a session's prompt or attention request to the user's devices
  decide --title "…" [--body "…"] [--then-send TARGET TEXT | --then-launch AGENT CWD PROMPT] [--wait [--timeout SECS]] [--json]
                                              ask the user for a decision in Inbox + push (optionally wait for their answer)
  stop <target> [--json]                      stop the agent's current turn (also: interrupt)
  interrupt <target> [--json]                 interrupt the agent's current turn (alias for stop)
  terminate <target> [--json]                 end the session (its conversation stays in history); also: kill
  forget <target> [--json]                    remove an ended session from history
  rename <target> <name…> [--json]            rename the session
  pin <target> [--off] [--json]               pin the session to the top of its group (or unpin)
  queue <target> [--unsent] [--clear | --remove ID | --send-now ID | --move ID POS] [--json]
                                              inspect or manage queued messages
  worktrees [--json] [--orphans]              managed worktrees, with on-disk sizes
  worktrees clean --orphans [--force-dirty] [--yes]
                                              remove orphaned worktrees (dry run unless --yes)
  checkouts [--json] [--repo DIR]             concurrent checkouts, overlaps, and storage
  checkouts gc [--dry-run]                    reclaim eligible clean checkouts (branches kept)
  checkouts check <id>                        check merge compatibility against trunk
  checkouts pin <id> [--unpin]                exempt a checkout from automatic cleanup
  snapshots <target>                          list per-turn file snapshots
  rollback <target> --to TURN [--interrupt]   restore files to before TURN (takes a safety snapshot first)
  hooks install|uninstall|status              wire Claude Code / Codex status hooks
  auth code                                   one-time code to set up a new device (10 min)
  auth password [--remove]                    set the optional master password
  auth token <name>                           token for another host to proxy this one
  auth status                                 passkeys, signed-in devices, recent activity
  peers trust <peer> <token>                  use a token issued by <peer> (on the hub)
  hosts [--json]                              this host and online/offline tailnet peers
  diff <target> [--stat] [--json]             git changes and diff in a session's checkout (also: changes)
  branches <target> [branch] [--json]         list or switch git branches in a session's checkout
  pr <target> [--json]                        open pull request for a session's branch, if any
  terminal <target> [cmd…] [--no-run] [--read] [--close] [--json]
                                              run or read a session's companion shell (without touching its agent)
  verify <target> <cmd…> [--timeout SECS] [--task ID] [--json]
                                              run an independent verification command in a session's companion shell
  subagents <target> [--json]                 tree of subagents spawned by a session
  spaces [--json] | space new|remove|restore|prefs|memory|projects|move|chief … [--json]
                                              Spaces, shared AGENTS.md preferences, and shared memory files
  notes [--json] | note show|new|edit|handoff|export|delete … [--json]
                                              Scratchpad notes synced across devices and handed off to agents
  search <query> [--all] [--host H] [--space P] [--role R] [--in transcripts|chats] [--lineage REF] [-n N] [--json]
                                              full-text search across sessions and chats
  supervise <target> [--role chief|worker|reviewer|none] [--managed-by TARGET|none] [--mute|--unmute]
            [--escalate-after SECS] [--tag T] [--clear-tags] [--json]
                                              configure session role, supervisor ownership, fail-open alert muting & tags
  audit [--session TARGET] [--event PREFIX] [-n LIMIT] [--json]
                                              inspect the host's audit log (including cross-session actor attribution)
  mail send <target|siblings|*> <body…|-> [--subject "…"] [--kind message|directive|report|blocker|handoff] [--thread ID] [--wake] [--json]
  mail broadcast <body…|-> [--fleet] [--subject "…"] [--kind message|report|blocker|handoff] [--thread ID] [--json]
  mail inbox [target=self] [--all] [--thread ID] [--json] | mail show|ack|delete <id> [--json]
                                              asynchronous durable cross-session mailbox
  tasks [--status S] [--assigned TARGET] [--owner TARGET] [--space P] [--json]
  task add <title> [--desc "…"] [--assign TARGET] [--owner TARGET] [--space P] [--priority 0-3] [--depends ID,ID] [--verify "CMD"] [--json]
  task show|update|delete <id> … [--json]     durable fleet task ledger

Global flag: --host <peer> (or AH_TARGET_HOST) proxies any command to a trusted peer host.
<target> is "self" (this session), a session id, a window id (@12), a title or name, or the start of one.`;

let targetHost = process.env.AH_TARGET_HOST?.trim() || null;
function apiPath(path) {
  return targetHost ? `/h/${encodeURIComponent(targetHost)}${path}` : path;
}

async function call(method, path, body, { throwOnError = false } = {}) {
  let res;
  const selfUid = currentSessionUid();
  const selfToken = currentSessionToken();
  try {
    res = await fetch(BASE + apiPath(path), {
      method,
      headers: {
        authorization: `Bearer ${localToken()}`,
        ...(selfUid ? { 'x-ah-session': selfUid } : {}),
        ...(selfToken ? { 'x-ah-session-token': selfToken } : {}),
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
    let code = null;
    try {
      const j = JSON.parse(text);
      msg = j.error ?? text;
      code = j.code ?? null;
    } catch {}
    if (throwOnError) {
      const err = new Error(msg);
      err.status = res.status;
      err.code = code;
      throw err;
    }
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

function opts(args, name) {
  const out = [];
  for (;;) {
    const i = args.indexOf(name);
    if (i < 0) break;
    out.push(args[i + 1]);
    args.splice(i, 2);
  }
  return out;
}

function optPair(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = [args[i + 1], args[i + 2]];
  args.splice(i, 3);
  return v;
}

function optTriple(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = [args[i + 1], args[i + 2], args[i + 3]];
  args.splice(i, 4);
  return v;
}

function flag(args, name) {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

/** The uid of the ah session running this CLI, if any (env set on launch, or tmux window option). */
function currentSessionUid() {
  if (process.env.AH_SESSION_UID) return process.env.AH_SESSION_UID.trim();
  if (process.env.TMUX) {
    const r = spawnSync('tmux', ['display-message', '-p', '#{@ah-uid}'], { encoding: 'utf8' });
    const uid = r.stdout?.trim();
    if (uid) return uid;
  }
  return null;
}

function currentSessionToken() {
  return process.env.AH_SESSION_TOKEN?.trim() || null;
}

/** Expand a `~` path using a target host's home directory (never the local machine's when using --host). */
function expandOnHost(path, hostHome) {
  if (!path) return path;
  if (!hostHome) return expandHome(path);
  const cleanHome = hostHome.length > 1 && hostHome.endsWith('/') ? hostHome.slice(0, -1) : hostHome;
  if (path === '~') return cleanHome;
  if (path.startsWith('~/')) return cleanHome + path.slice(1);
  return path;
}

/** Opens the host's SSE state stream (`/api/events?delta=1`) and invokes `onState(next, prev)` on each frame. */
async function streamEvents(onState, { signal } = {}) {
  let res;
  const selfUid = currentSessionUid();
  const selfToken = currentSessionToken();
  try {
    res = await fetch(`${BASE}${apiPath('/api/events?delta=1')}`, {
      headers: {
        authorization: `Bearer ${localToken()}`,
        ...(selfUid ? { 'x-ah-session': selfUid } : {}),
        ...(selfToken ? { 'x-ah-session-token': selfToken } : {}),
        accept: 'text/event-stream',
      },
      signal,
    });
  } catch (err) {
    if (signal?.aborted) return;
    fail(`ah isn't running on ${BASE} (start it with \`systemctl --user start ah\` or \`pnpm start\`)`);
  }
  if (!res.ok || !res.body) fail(`event stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let state = null;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = parseSseChunk(buf, decoder.decode(value, { stream: true }), ({ event, data }) => {
        if (event !== 'state' && event !== 'patch') return;
        const prev = state;
        state = event === 'state' ? data : applyStateDelta(state, data);
        onState(state, prev);
      });
    }
  } catch (err) {
    if (!signal?.aborted) throw err;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Blocks over SSE until one of `uids` matches `until` ('settled' | 'idle' | 'waiting' | 'ended' | 'any').
 * Preserves legacy exit codes for `settled`: 0 done/idle, 2 waiting/needs input, 1 ended/timeout.
 */
async function waitForSessions(uids, { until = 'settled', timeout = 0, grace = true, json = false } = {}) {
  if (grace && until === 'settled') await new Promise((r) => setTimeout(r, 2000));
  const initialStatus = new Map();
  const ac = new AbortController();
  let timer = null;
  let result = null;
  if (timeout > 0) {
    timer = setTimeout(() => {
      result = { kind: 'timeout' };
      ac.abort();
    }, timeout * 1000);
  }
  const check = (state) => {
    const byUid = new Map((state.windows ?? []).map((w) => [w.uid, w]));
    for (const uid of uids) {
      const w = byUid.get(uid);
      if (!initialStatus.has(uid)) initialStatus.set(uid, w?.status ?? null);
      if (!w) {
        if (until === 'ended' || until === 'any') {
          result = { kind: 'ended', uid, window: null };
          ac.abort();
          return;
        }
        if (uids.length === 1) {
          result = { kind: 'ended', uid, window: null };
          ac.abort();
          return;
        }
        continue;
      }
      if (until === 'settled' && w.status !== 'busy' && !w.queued) {
        result = { kind: w.status === 'waiting' ? 'waiting' : 'done', uid, window: w };
        ac.abort();
        return;
      }
      if (until === 'idle' && (w.status === 'idle' || w.status === 'attention') && !w.queued) {
        result = { kind: 'done', uid, window: w };
        ac.abort();
        return;
      }
      if (until === 'waiting' && w.status === 'waiting') {
        result = { kind: 'waiting', uid, window: w };
        ac.abort();
        return;
      }
      if (until === 'any' && w.status !== initialStatus.get(uid)) {
        result = { kind: w.status === 'waiting' ? 'waiting' : 'changed', uid, window: w };
        ac.abort();
        return;
      }
    }
  };
  try {
    await streamEvents((state) => {
      if (!result) check(state);
    }, { signal: ac.signal });
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!result || result.kind === 'timeout') fail('timed out');
  if (result.kind === 'ended' && until !== 'ended' && until !== 'any') fail('session ended');
  if (json) {
    console.log(JSON.stringify({
      event: result.kind,
      uid: result.uid,
      status: result.window?.status ?? 'ended',
      ask: result.window?.ask ?? null,
      askId: result.window?.askId ?? null,
      answerable: result.window?.answerable ?? false,
      reply: result.window?.reply ?? null,
    }, null, 2));
  } else {
    const label = result.kind === 'waiting' ? 'needs input' : result.kind === 'ended' ? 'ended' : result.kind === 'changed' ? `${result.uid} ${result.window.status}` : 'done';
    console.log(label);
  }
  process.exit(result.kind === 'waiting' && until === 'settled' ? 2 : 0);
}

/** Polls a decision job run until the user approves, declines, or it finishes (or times out). */
async function waitForDecision(runId, { timeout = 0 } = {}) {
  const start = Date.now();
  for (;;) {
    const r = await call('GET', `/api/jobs/runs/${encodeURIComponent(runId)}`);
    if (r.state !== 'eligible' && r.state !== 'waiting') return r;
    if (timeout && Date.now() - start > timeout * 1000) fail('timed out waiting for decision');
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** Resolves a user-typed target to a live window or a history entry. */
/**
 * A session's link as it was copied (web or app: "https://host/#<uid>", "…/#<host>/<uid>?m=…",
 * "ah://host/<uid>"), as the session it names; anything else as it is.
 */
export function linkTarget(target) {
  if (!/^[a-z][\w+.-]*:\/\//i.test(target)) return target;
  let url;
  try {
    url = new URL(target);
  } catch {
    return target;
  }
  const place = decodeURIComponent((url.hash ? url.hash.slice(1) : url.pathname.slice(1)).split('?')[0]);
  // Another host's session ("mac/<uid>") is that host's to read.
  if (place.includes('/')) fail(`"${target}" is a session on ${place.slice(0, place.indexOf('/'))}: run this there`);
  return place || target;
}

async function find(target, { history = false } = {}) {
  if (!target) fail('missing <target>');
  if (target === 'self') {
    const selfUid = currentSessionUid();
    if (!selfUid) fail('"self" requires running inside an ah session (AH_SESSION_UID or tmux @ah-uid)');
    target = selfUid;
  }
  target = linkTarget(target);
  const state = await call('GET', '/api/state');
  const t = target.toLowerCase();
  // Titles first ("Fix Safari login flash"), as every screen names a session, then tmux window names.
  const names = (w) => [w.title, w.name].filter(Boolean).map((n) => n.toLowerCase());
  const live =
    state.windows.find((w) => w.uid === target || w.id === target) ??
    unique(state.windows.filter((w) => names(w).includes(t)), target) ??
    unique(state.windows.filter((w) => names(w).some((n) => n.startsWith(t))), target);
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
  if (list.length > 1) fail(`"${target}" is ambiguous: ${list.map((x) => x.title ?? x.name).join(', ')}`);
  return list[0];
}

async function resolveRef(target, { history = true } = {}) {
  const f = await find(target, { history });
  return f.live?.uid ?? f.past.ref;
}

/** The status in the one vocabulary every surface uses (web/status.ts), with a mark for a terminal. */
const MARK = { 'needs you': '●', working: '◌', done: '◆', 'new output': '◆', limited: '◑', idle: '○' };
const status = (w) => `${MARK[statusWord(w)] ?? '○'} ${statusWord(w)}`;

function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
}

export async function run(cmd, args) {
  if (cmd !== 'search') {
    const h = opt(args, '--host', undefined);
    if (h) targetHost = h;
  }
  switch (cmd) {
    case 'hosts': {
      const json = flag(args, '--json');
      const { hosts } = await call('GET', '/api/state');
      if (json) return console.log(JSON.stringify(hosts, null, 2));
      table([['HOST', 'SELF', 'ONLINE'], ...(hosts ?? []).map((h) => [h.name, h.self ? 'yes' : '', h.online ? 'yes' : 'no'])]);
      return;
    }
    case 'whoami': {
      const json = flag(args, '--json');
      const uid = currentSessionUid();
      if (!uid) fail('not inside an ah session (AH_SESSION_UID and tmux @ah-uid are unset)');
      const state = await call('GET', '/api/state');
      const w = state.windows.find((x) => x.uid === uid) ?? null;
      if (json) return console.log(JSON.stringify({ uid, window: w }, null, 2));
      if (!w) return console.log(uid);
      console.log(`${w.uid}  ${w.title || w.name}  (${w.agent ?? w.command}, ${status(w)})`);
      return;
    }
    case 'list': {
      const json = flag(args, '--json');
      const filterStatus = opt(args, '--status', undefined) ?? (flag(args, '--waiting') ? 'waiting' : flag(args, '--busy') ? 'busy' : flag(args, '--idle') ? 'idle' : undefined);
      const filterAgent = opt(args, '--agent', undefined)?.toLowerCase();
      const filterSpace = opt(args, '--space', undefined)?.toLowerCase();
      const filterRole = opt(args, '--role', undefined)?.toLowerCase();
      const filterManagedBy = opt(args, '--managed-by', undefined);
      const filterTag = opt(args, '--tag', undefined);
      const excludeSelf = flag(args, '--exclude-self');
      const selfUid = excludeSelf ? currentSessionUid() : null;
      const managedByUid = filterManagedBy ? (filterManagedBy === 'self' ? currentSessionUid() : filterManagedBy) : null;
      let { windows } = await call('GET', '/api/state');
      if (filterStatus) {
        const want = filterStatus.toLowerCase();
        windows = windows.filter((w) => w.status === want || statusWord(w) === want);
      }
      if (filterAgent) windows = windows.filter((w) => (w.agent ?? w.command ?? '').toLowerCase() === filterAgent);
      if (filterSpace) windows = windows.filter((w) => (w.space || '').toLowerCase() === filterSpace);
      if (filterRole) windows = windows.filter((w) => (w.supervision?.role ?? '').toLowerCase() === filterRole);
      if (managedByUid) windows = windows.filter((w) => w.supervision?.managedBy === managedByUid);
      if (filterTag) windows = windows.filter((w) => (w.supervision?.tags ?? []).includes(filterTag));
      if (selfUid) windows = windows.filter((w) => w.uid !== selfUid);
      if (json) return console.log(JSON.stringify(windows, null, 2));
      if (!windows.length) return console.log('nothing running');
      table([
        ['ID', 'WINDOW', 'TITLE', 'AGENT', 'STATUS', 'SPACE', 'QUEUED'],
        ...windows.map((w) => [w.uid, `${w.session}:${w.index}`, w.title || w.name, w.agent ?? w.command, status(w), w.space || '', w.queued || '']),
      ]);
      return;
    }
    case 'show':
    case 'inspect':
    case 'status': {
      const json = flag(args, '--json');
      const found = await find(args[0], { history: true });
      const w = found.live ?? null;
      if (!w) {
        const h = found.past;
        if (json) return console.log(JSON.stringify({ window: null, history: h }, null, 2));
        console.log(`${h.ref}  ${h.title || '(untitled)'}  [${h.kind}]`);
        console.log(`Harness: ${h.harness}  Space: ${h.project}  Cwd: ${h.cwd}`);
        return;
      }
      const preset = found.state.presets?.find((p) => p.id === (w.agent ?? 'shell')) ?? null;
      const queue = await call('GET', `/api/sessions/${encodeURIComponent(w.uid)}/queue?unsent=1`).catch(() => []);
      const modes = (preset?.modes ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        level: permissionLevelOf(preset, m.id),
        dangerous: !!m.dangerous,
        description: m.description ?? null,
      }));
      if (json) {
        return console.log(JSON.stringify({
          window: w,
          preset: preset
            ? {
                id: preset.id,
                name: preset.name,
                modes,
                canSwitchModeLive: !!preset.modeCycle,
                canSwitchModelLive: !!preset.switchModel,
                canSwitchEffortLive: !!preset.switchEffort,
              }
            : null,
          queue,
        }, null, 2));
      }
      const modeId = w.launchMode ?? 'default';
      const modeLevel = preset ? permissionLevelOf(preset, modeId) : null;
      console.log(`${w.uid}  ${w.title || w.name}  (${w.id}, ${w.session}:${w.index})`);
      console.log(`Agent: ${w.agent ?? w.command}  Status: ${status(w)} (${w.status}, via ${w.statusSource})`);
      console.log(`Space: ${w.project}  Cwd: ${w.cwd}${w.branch ? `  Branch: ${w.branch}${w.worktree ? ' (worktree)' : ''}` : ''}`);
      console.log(`Mode: ${modeId}${modeLevel ? ` (${modeLevel})` : ''}${w.model || w.launchModel ? `  Model: ${w.model ?? w.launchModel}` : ''}${w.launchEffort ? `  Effort: ${w.launchEffort}` : ''}`);
      if (modes.length) console.log(`Available modes: ${modes.map((m) => `${m.id}${m.level && m.level !== m.id ? `/${m.level}` : ''}${m.dangerous ? '!' : ''}`).join(', ')}`);
      if (w.detail) console.log(`Detail: ${w.detail}`);
      if (w.limit) console.log(`Limit: ${w.limit}`);
      if (w.busySince) console.log(`Busy since: ${new Date(w.busySince * 1000).toLocaleTimeString()} (${Math.max(0, Math.floor(Date.now() / 1000) - w.busySince)}s)`);
      if (w.supervision) {
        const s = w.supervision;
        console.log(`Supervision: ${[s.role ? `role=${s.role}` : null, s.managedBy ? `managedBy=${s.managedBy}` : null, s.muteAlerts !== undefined ? `mute=${s.muteAlerts}` : null, s.escalateAfterSeconds ? `escalateAfter=${s.escalateAfterSeconds}s` : null, s.tags?.length ? `tags=${s.tags.join(',')}` : null].filter(Boolean).join('  ')}`);
      }
      if (queue.length) console.log(`Queued: ${queue.length}${w.unsent ? ` (${w.unsent} unsent)` : ''}`);
      if (w.reply?.text) console.log(`Last ${w.reply.role}: ${w.reply.text.split('\n')[0].slice(0, 160)}`);
      if (w.ask) for (const line of formatAsk(w.ask, { askId: w.askId, answerable: w.answerable })) console.log(line);
      return;
    }
    case 'harnesses': {
      const json = flag(args, '--json');
      const { presets } = await call('GET', '/api/state');
      const list = (presets ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        available: !!p.available,
        hidden: !!p.hidden,
        feed: p.feed ?? null,
        canSwitchModeLive: !!p.modeCycle,
        canSwitchModelLive: !!p.switchModel,
        canSwitchEffortLive: !!p.switchEffort,
        modes: (p.modes ?? []).map((m) => ({ id: m.id, name: m.name, level: permissionLevelOf(p, m.id), dangerous: !!m.dangerous })),
        effortLevels: p.effort?.levels ?? [],
      }));
      if (json) return console.log(JSON.stringify(list, null, 2));
      table([
        ['ID', 'NAME', 'AVAILABLE', 'LIVE MODE', 'MODES'],
        ...list.map((p) => [
          p.id,
          p.name,
          p.available ? 'yes' : 'no',
          p.canSwitchModeLive ? 'yes' : 'relaunch',
          p.modes.map((m) => `${m.id}${m.level && m.level !== m.id ? `(${m.level})` : ''}${m.dangerous ? '!' : ''}`).join(', '),
        ]),
      ]);
      return;
    }
    case 'history': {
      const { history } = await call('GET', '/api/state');
      if (flag(args, '--json')) return console.log(JSON.stringify(history, null, 2));
      table([['REF', 'HARNESS', 'WHEN', 'SPACE', 'TITLE'], ...history.map((h) => [h.ref, h.harness, new Date(h.at * 1000).toLocaleString(), h.project, h.title])]);
      return;
    }
    case 'new': {
      const json = flag(args, '--json');
      const harness = args.shift() ?? 'shell';
      const wantWt = flag(args, '--worktree');
      const noWt = flag(args, '--no-worktree');
      const trust = flag(args, '--trust');
      const promptText = opt(args, '--prompt', undefined);
      const role = opt(args, '--role', undefined);
      const managedByRaw = opt(args, '--managed-by', undefined);
      const supSpace = opt(args, '--space', undefined);
      const muteAlerts = flag(args, '--mute') || flag(args, '--mute-alerts') ? true : flag(args, '--unmute') ? false : undefined;
      const escalateAfterRaw = opt(args, '--escalate-after', undefined);
      const tags = opts(args, '--tag');
      let supervision;
      if (role || managedByRaw || supSpace || muteAlerts !== undefined || escalateAfterRaw !== undefined || tags.length) {
        const managedBy = managedByRaw ? (await find(managedByRaw)).live.uid : undefined;
        supervision = {
          ...(role ? { role } : {}),
          ...(managedBy ? { managedBy } : {}),
          ...(supSpace ? { space: supSpace } : {}),
          ...(muteAlerts !== undefined ? { muteAlerts } : {}),
          ...(escalateAfterRaw !== undefined ? { escalateAfterSeconds: parseDuration(escalateAfterRaw) ?? Number(escalateAfterRaw) } : {}),
          ...(tags.length ? { tags } : {}),
        };
      }
      const body = {
        preset: harness,
        cwd: resolve(opt(args, '--cwd', process.cwd())),
        label: opt(args, '--name', ''),
        session: opt(args, '--session', ''),
        resume: flag(args, '--continue'),
        ...(wantWt ? { worktree: true } : noWt ? { worktree: false } : {}),
        ...(trust ? { trust: true } : {}),
        ...(supSpace ? { space: supSpace } : {}),
        ...(supervision ? { supervision } : {}),
        mode: opt(args, '--mode', undefined),
        model: opt(args, '--model', undefined),
        effort: opt(args, '--effort', undefined),
        extraArgs: opt(args, '--args', undefined),
      };
      for (const k of ['mode', 'model', 'effort', 'extraArgs']) if (body[k] === undefined) delete body[k];
      const out = await call('POST', '/api/windows', body);
      let promptOut = null;
      if (promptText) {
        promptOut = await call('POST', `/api/sessions/${encodeURIComponent(out.uid)}/send`, { text: promptText, enter: true });
      }
      if (json) return console.log(JSON.stringify({ ...out, ...(promptOut ? { prompt: promptOut } : {}) }, null, 2));
      console.log(`${out.uid} ${out.id}${out.branch ? `  ${out.branch}` : ''}${out.worktree ? `  ${out.worktree}` : ''}`);
      return;
    }
    case 'open': {
      // The session you are in (or the one named) in ah's own window: from a terminal into the app.
      let target = args[0];
      if (!target && process.env.TMUX) target = spawnSync('tmux', ['display-message', '-p', '#{window_id}'], { encoding: 'utf8' }).stdout.trim();
      const { appUrl } = await import('../server/desktop.ts');
      const base = appUrl(PORT);
      const found = target ? await find(target, { history: true }) : null;
      // A live session, or an ended one (it opens in place with Resume); a bare base otherwise.
      const key = found?.live?.uid ?? (found?.past?.kind === 'ended' ? found.past.ref : '');
      const url = key ? `${base}/#${key}` : base;
      const launcher = spawnSync('sh', ['-c', 'command -v omarchy-launch-webapp'], { stdio: 'ignore' }).status === 0 ? 'omarchy-launch-webapp' : 'xdg-open';
      spawnSync(launcher, [url], { stdio: 'ignore', detached: true });
      return console.log(url);
    }
    case 'attach': {
      const { live } = await find(args[0]);
      return attach(live);
    }
    case 'resume': {
      const json = flag(args, '--json');
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/resume`);
      if (json) return console.log(JSON.stringify(out, null, 2));
      console.log(`${out.uid} ${out.id}${out.resumed ? ' (resumed)' : ' (already running)'}`);
      return;
    }
    case 'fork': {
      const json = flag(args, '--json');
      const name = opt(args, '--name', undefined);
      const prompt = opt(args, '--prompt', undefined);
      const mode = opt(args, '--mode', undefined);
      const model = opt(args, '--model', undefined);
      const effort = opt(args, '--effort', undefined);
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const body = {};
      if (name !== undefined) body.name = name;
      if (prompt !== undefined) body.prompt = prompt;
      if (mode !== undefined) body.mode = mode;
      if (model !== undefined) body.model = model;
      if (effort !== undefined) body.effort = effort;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/fork`, body);
      if (json) return console.log(JSON.stringify(out, null, 2));
      console.log(`${out.uid} ${out.id}  ${out.branch}  ${out.worktree}`);
      return;
    }
    case 'mode': {
      const json = flag(args, '--json');
      const allowRelaunch = flag(args, '--relaunch');
      const { live, state } = await find(args[0]);
      const preset = state.presets?.find((p) => p.id === (live.agent ?? 'shell')) ?? null;
      const requested = args[1];
      if (!requested) {
        const current = live.launchMode ?? 'default';
        const modes = (preset?.modes ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          level: permissionLevelOf(preset, m.id),
          dangerous: !!m.dangerous,
          description: m.description ?? null,
        }));
        if (json) return console.log(JSON.stringify({ uid: live.uid, agent: live.agent, mode: current, level: preset ? permissionLevelOf(preset, current) : null, canSwitchLive: !!preset?.modeCycle, modes }, null, 2));
        const level = preset ? permissionLevelOf(preset, current) : null;
        console.log(`${live.uid}  mode: ${current}${level ? ` (${level})` : ''}${preset?.modeCycle ? '' : '  [changes require --relaunch]'}`);
        for (const m of modes) console.log(`  ${m.id}${m.level && m.level !== m.id ? ` (${m.level})` : ''}${m.dangerous ? ' [dangerous]' : ''}${m.description ? ` — ${m.description}` : ''}`);
        return;
      }
      const resolved = preset ? resolvePermissionMode(preset, requested) : null;
      const modeId = resolved?.id ?? requested;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/mode`, { mode: modeId });
      if (out.switched) {
        const res = { switched: true, relaunched: false, uid: live.uid, mode: out.mode ?? modeId };
        if (json) return console.log(JSON.stringify(res, null, 2));
        return console.log(`mode set to ${res.mode}`);
      }
      if (allowRelaunch) {
        const rel = await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/relaunch`, { mode: modeId });
        const res = { switched: true, relaunched: true, uid: rel.uid, id: rel.id, mode: modeId };
        if (json) return console.log(JSON.stringify(res, null, 2));
        return console.log(`relaunched as ${rel.uid} (${rel.id}) with mode ${modeId}`);
      }
      if (json) {
        console.log(JSON.stringify({ switched: false, needsRelaunch: true, uid: live.uid, mode: modeId }, null, 2));
        process.exit(2);
      }
      fail(`${live.agent ?? 'session'} can't switch to "${modeId}" live; re-run with --relaunch when idle`);
      return;
    }
    case 'switch': {
      const json = flag(args, '--json');
      const allowRelaunch = flag(args, '--relaunch');
      const model = opt(args, '--model', undefined);
      const effort = opt(args, '--effort', undefined);
      if (Number(model !== undefined) + Number(effort !== undefined) !== 1) fail('usage: ah switch <target> (--model M | --effort E) [--relaunch] [--json]');
      const { live } = await find(args[0]);
      const change = model !== undefined ? { model } : { effort };
      try {
        const out = await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/switch`, change, { throwOnError: allowRelaunch });
        if (json) return console.log(JSON.stringify({ ...out, relaunched: false, uid: live.uid, ...change }, null, 2));
        console.log(`${out.outcome === 'delivered' ? 'switched' : `queued (${out.queued})`}`);
      } catch (err) {
        if (!allowRelaunch || err.status !== 400) fail(err.message);
        const rel = await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/relaunch`, change);
        if (json) return console.log(JSON.stringify({ relaunched: true, ...rel, ...change }, null, 2));
        console.log(`relaunched as ${rel.uid} (${rel.id})`);
      }
      return;
    }
    case 'relaunch': {
      const json = flag(args, '--json');
      const mode = opt(args, '--mode', undefined);
      const model = opt(args, '--model', undefined);
      const effort = opt(args, '--effort', undefined);
      const { live } = await find(args[0]);
      const body = {};
      if (mode !== undefined) body.mode = mode;
      if (model !== undefined) body.model = model;
      if (effort !== undefined) body.effort = effort;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/relaunch`, body);
      if (json) return console.log(JSON.stringify(out, null, 2));
      console.log(`${out.uid} ${out.id}`);
      return;
    }
    case 'continue': {
      const to = opt(args, '--in', undefined);
      if (!to) fail('which agent? --in claude|codex|…');
      const name = opt(args, '--name', undefined);
      const preview = flag(args, '--preview');
      const json = flag(args, '--json');
      const body = { to, intent: flag(args, '--fork') ? 'fork' : 'continue', ...(flag(args, '--worktree') ? { worktree: true } : {}), ...(name ? { name } : {}) };
      const found = await find(args[0], { history: true });
      const ref = encodeURIComponent(found.live?.uid ?? found.past.ref);
      if (preview) {
        const plan = await call('POST', `/api/portable/conversations/${ref}/preview`, body);
        if (json) return console.log(JSON.stringify(plan, null, 2));
        if (plan.blocked) fail(plan.blocked.message);
        console.log(`${plan.strategy}: ${plan.source.harness} → ${plan.destination.harness}${plan.destination.worktree ? ' (own worktree)' : ''}`);
        for (const t of plan.transfers) console.log(`  + ${t}`);
        for (const l of plan.limitations) console.log(`  - ${l.message}`);
        return;
      }
      const out = await call('POST', `/api/portable/conversations/${ref}/continue`, { ...body, idempotencyKey: `cli:${randomBytes(8).toString('hex')}` });
      if (json) return console.log(JSON.stringify(out, null, 2));
      const op = out.operation;
      console.log(`${op.childUid}  ${op.strategy}  ${op.fromName} → ${op.toName}  (${op.id}, ${op.state})`);
      return;
    }
    case 'portable': {
      const file = opt(args, '--out', undefined);
      const found = await find(args[0], { history: true });
      const out = await call('GET', `/api/portable/conversations/${encodeURIComponent(found.live?.uid ?? found.past.ref)}`);
      const doc = JSON.stringify(out.conversation, null, 2);
      if (file) {
        writeFileSync(file, doc, { mode: 0o600 });
        console.log(`${out.conversation.id}: ${out.conversation.messages.length} messages → ${file}`);
      } else console.log(doc);
      return;
    }
    case 'lineage': {
      const json = flag(args, '--json');
      const found = await find(args[0], { history: true });
      const tree = await call('GET', `/api/portable/conversations/${encodeURIComponent(found.live?.uid ?? found.past.ref)}/lineage`);
      if (json) return console.log(JSON.stringify(tree, null, 2));
      if (!tree.nodes.length) return console.log('no lineage: this conversation was not carried anywhere, nor from anywhere');
      const byId = new Map(tree.nodes.map((n) => [n.conversationId, n]));
      const kids = new Map();
      for (const e of tree.edges) if (e.childId) kids.set(e.parentId, [...(kids.get(e.parentId) ?? []), e]);
      const line = (n, depth, via) => {
        const tag = via ? `${via.kind}/${via.strategy}${via.state === 'linked' ? '' : ` [${via.state}]`} ` : '';
        console.log(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${tag}${n.harnessName ?? n.harness ?? '?'}: ${n.title || '(untitled)'}${n.uids.length ? `  ${n.uids.join(' ')}` : ''}${n.current ? '  ← this' : ''}`);
        for (const e of kids.get(n.conversationId) ?? []) if (byId.has(e.childId)) line(byId.get(e.childId), depth + 1, e);
      };
      line(byId.get(tree.root), 0, null);
      return;
    }
    case 'move': {
      const to = opt(args, '--to', undefined);
      if (!to) fail('which host? --to <host>');
      const cwd = opt(args, '--cwd', undefined);
      const preview = flag(args, '--preview');
      const yes = flag(args, '--yes');
      const json = flag(args, '--json');
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const shown = await call('POST', '/api/migrations/preview', { ref, to, ...(cwd ? { cwd } : {}) });
      const pre = shown.preflight;
      if (json && preview) return console.log(JSON.stringify(shown, null, 2));
      console.log(`${pre.ok ? '✓' : '✗'} ${pre.host}: ${pre.destCwd ?? '(no folder)'}${pre.resolvedBy ? `  (found by ${pre.resolvedBy.replace('_', ' ')})` : ''}`);
      for (const r of pre.requirements) console.log(`  ${r.blocking ? '✗' : '!'} ${r.message}`);
      if (preview) return;
      if (!pre.ok) process.exit(1);
      const warnings = pre.requirements.filter((r) => !r.blocking).length;
      if (warnings && !yes) fail('confirm the warnings above with --yes');
      const out = await call('POST', '/api/migrations', { ref, to, ...(cwd ? { cwd } : {}), acceptWarnings: yes, idempotencyKey: `cli:${randomBytes(8).toString('hex')}` });
      let m = out.migration;
      while (!['completed', 'failed', 'cancelled'].includes(m.state)) {
        await new Promise((r) => setTimeout(r, 500));
        m = await call('GET', `/api/migrations/${m.id}`);
      }
      if (json) return console.log(JSON.stringify(m, null, 2));
      if (m.state !== 'completed') fail(`${m.id} ${m.state}: ${m.error ?? ''} (ah migrations retry ${m.id})`);
      console.log(`moved: ${m.id} → ${m.peer} as ${m.destUid} in ${m.destCwd}; resume it there (ah resume on ${m.peer}, or from any device)`);
      return;
    }
    case 'usage': {
      if (args[0] === 'limits') {
        const l = await call('GET', '/api/usage/limits');
        if (flag(args, '--json')) return console.log(JSON.stringify(l, null, 2));
        if (!l.windows.length && !l.cooldowns.length) return console.log('no limits known right now');
        for (const w of l.windows) console.log(`${w.harness} ${w.window}: ${w.usedPercent ?? '?'}% used${w.resetsAt ? `, resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : ''} (${w.source})`);
        for (const c of l.cooldowns) console.log(`${c.harness} ${c.uid}: ${c.text}${c.resetsAt ? ` until ${new Date(c.resetsAt * 1000).toLocaleString()}` : ''} (${c.source})`);
        return;
      }
      if (args[0] === 'export') return process.stdout.write(await call('GET', `/api/usage/export?format=${flag(args, '--json') ? 'json' : 'csv'}`).then((x) => (typeof x === 'string' ? x : JSON.stringify(x))));
      if (args[0] && !args[0].startsWith('--')) {
        const json = flag(args, '--json');
        const found = await find(args[0], { history: true });
        const uid = found.live?.uid ?? found.past.ref;
        const out = await call('GET', `/api/sessions/${encodeURIComponent(uid)}/usage`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        if (!out.models?.length) return console.log('no token usage recorded for this session');
        const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
        table([
          ['MODEL', 'IN', 'OUT', 'CACHE READ', 'MSGS', 'ESTIMATE*'],
          ...out.models.map((m) => [m.model, k(m.input + m.cacheWrite), k(m.output), k(m.cacheRead), m.messages, m.cost?.estimateUsd == null ? 'no price' : `$${m.cost.estimateUsd.toFixed(2)}`]),
        ]);
        return;
      }
      const days = Number(opt(args, '--days', '30'));
      const by = opt(args, '--by', 'model');
      const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
      await call('POST', '/api/usage/refresh');
      const rep = await call('GET', `/api/usage?by=${encodeURIComponent(by)}&from=${from}`);
      if (flag(args, '--json')) return console.log(JSON.stringify(rep, null, 2));
      if (!rep.rows.length) return console.log(`nothing recorded in the last ${days} days`);
      const k = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));
      table([[by.toUpperCase(), 'IN', 'OUT', 'CACHE READ', 'ESTIMATE*'], ...rep.rows.map((r) => [r.key, k(r.tokens.input + r.tokens.cacheWrite), k(r.tokens.output), k(r.tokens.cacheRead), r.cost.estimateUsd === null ? 'no price' : `$${r.cost.estimateUsd.toFixed(2)}`])]);
      console.log(`\n* ${rep.notes.cost}`);
      return;
    }
    case 'recovery': {
      if (!args[0] || args[0].startsWith('--')) {
        const { recoveries, config: cfg } = await call('GET', '/api/recovery');
        if (!recoveries.length) return console.log(`nothing to recover (automatic recovery is ${cfg.auto ? 'on' : 'off'} by default)`);
        table([['SESSION', 'STATE', 'WHY', 'ATTEMPTS', 'NEXT'], ...recoveries.map((r) => [r.uid, r.state, r.reason, `${r.attempts}/${r.maxAttempts}`, r.nextAttemptAt ? new Date(r.nextAttemptAt * 1000).toLocaleTimeString() : ''])]);
        return;
      }
      const auto = opt(args, '--auto', undefined);
      const action = ['--retry', '--pause', '--resume', '--cancel'].find((f) => flag(args, f))?.slice(2);
      const found = await find(args[0], { history: true });
      const uid = found.live?.uid ?? found.past.ref;
      if (auto !== undefined) await call('POST', `/api/sessions/${encodeURIComponent(uid)}/recovery`, { auto: auto === 'on' });
      if (action) await call('POST', `/api/sessions/${encodeURIComponent(uid)}/recovery`, { action });
      const r = await call('GET', `/api/sessions/${encodeURIComponent(uid)}/recovery`);
      console.log(`automatic recovery: ${r.auto ? 'on' : 'off'}`);
      if (r.recovery) console.log(`${r.recovery.state}: ${r.recovery.reason}, ${r.recovery.attempts}/${r.recovery.maxAttempts} attempts${r.recovery.nextAttemptAt ? `, next at ${new Date(r.recovery.nextAttemptAt * 1000).toLocaleTimeString()}` : ''}`);
      for (const e of r.events.slice(0, 8).reverse()) console.log(`  ${new Date(e.at * 1000).toLocaleTimeString()}  ${e.state}  ${e.detail}`);
      return;
    }
    case 'restore': {
      const note = !flag(args, '--no-note');
      const dismiss = flag(args, '--dismiss');
      const incident = opt(args, '--incident', undefined);
      const all = flag(args, '--all');
      const target = args.find((a) => !a.startsWith('--'));
      const why = { tmux_server: 'the tmux server stopped', host_restart: 'the host restarted', window: 'its window closed' };
      if (!target && !all && !incident) {
        const { interruptions: list } = await call('GET', '/api/interruptions');
        if (flag(args, '--json')) return console.log(JSON.stringify(list, null, 2));
        if (!list.length) return console.log('nothing was interrupted');
        table([['SESSION', 'TITLE', 'WHEN', 'WHY', 'WAS', 'QUEUED'], ...list.map((s) => [s.uid, s.title, new Date(s.at * 1000).toLocaleString(), why[s.cause] ?? s.cause, s.midTurn ? s.lastStatus : 'done', String(s.queued || '')])]);
        console.log(`
ah restore --all   (mid-turn ones first; they're told where they stopped)`);
        return;
      }
      const found = target ? await find(target, { history: true }) : null;
      const body = found ? { uids: [found.live?.uid ?? found.past.ref] } : incident ? { incident } : { all: true };
      if (dismiss) return console.log(`dismissed ${(await call('POST', '/api/interruptions/dismiss', body)).dismissed}`);
      const out = await call('POST', '/api/interruptions/restore', { ...body, note });
      for (const r of out.restored) console.log(`restored ${r.uid}${r.noted ? ' (told where it stopped)' : ''}${r.resumed ? '' : ' (already running)'}`);
      for (const f of out.failed) console.log(`could not restore ${f.uid}: ${f.error}`);
      if (!out.restored.length && !out.failed.length) console.log('nothing to restore');
      if (out.failed.length) process.exitCode = 1;
      return;
    }
    case 'jobs': {
      const { jobs, state } = await call('GET', '/api/jobs');
      if (flag(args, '--json')) return console.log(JSON.stringify({ jobs, state }, null, 2));
      if (!jobs.length) return console.log('no jobs');
      table([['ID', 'NAME', 'STATE', 'NEXT', 'LAST RUN'], ...jobs.map((j) => [j.id, j.name, j.state, j.nextRunAt ? new Date(j.nextRunAt * 1000).toLocaleString() : '', j.lastRun ? `${j.lastRun.state}${j.lastRun.error ? `: ${j.lastRun.error}` : ''}` : ''])]);
      for (const w of state.waiting) console.log(`\n● ${w.name} needs your decision (run ${w.runId}): ${w.title}\n  ah job decide ${w.runId} yes|no`);
      for (const u of state.uncertain) console.log(`\n? ${u.name}: may not have arrived (run ${u.runId}): ah job resolve ${u.runId} resend|leave`);
      return;
    }
    case 'job': {
      const sub = args.shift();
      const json = flag(args, '--json');
      if (sub === 'add') {
        const name = opt(args, '--name', undefined) ?? 'Job';
        const launchAgent = opt(args, '--launch', undefined);
        const sendTo = opt(args, '--send', undefined);
        const isDecide = flag(args, '--decide');
        const cwd = opt(args, '--cwd', process.cwd());
        const prompt = opt(args, '--prompt', undefined);
        const text = opt(args, '--text', undefined);
        const mode = opt(args, '--mode', undefined);
        const model = opt(args, '--model', undefined);
        const effort = opt(args, '--effort', undefined);
        const worktree = flag(args, '--worktree');
        const title = opt(args, '--title', undefined);
        const body = opt(args, '--body', undefined);
        const thenSend = optPair(args, '--then-send');
        const thenLaunch = optTriple(args, '--then-launch');
        const at = opt(args, '--at', undefined);
        const inDelay = opt(args, '--in', undefined);
        const every = opt(args, '--every', undefined);
        const daily = opt(args, '--daily', undefined);
        const cron = opt(args, '--cron', undefined);
        const tz = opt(args, '--tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
        const afterJob = opt(args, '--after', undefined);
        const idle = opt(args, '--when-idle', undefined);
        const waitingOn = opt(args, '--when-waiting', undefined);
        const stalledOn = opt(args, '--when-stalled', undefined);
        const ended = opt(args, '--when-ended', undefined);
        const afterRaw = opt(args, '--after-stall', undefined);
        const overlapTrig = flag(args, '--when-overlap');
        const overlapRepo = opt(args, '--repo', undefined);
        const repeat = flag(args, '--repeat');
        const excludes = opts(args, '--exclude');
        const retries = opt(args, '--retries', undefined);
        const maxRuns = opt(args, '--max-runs', undefined);
        const until = opt(args, '--until', undefined);
        const concurrencyKey = opt(args, '--concurrency-key', undefined);
        const notify = flag(args, '--notify');
        const skipIfBusy = flag(args, '--skip-if-busy');
        const ifLive = flag(args, '--if-live');
        const allowDangerous = flag(args, '--allow-dangerous');
        const autoRecover = flag(args, '--auto-recover');
        let action;
        if (isDecide) {
          if (!title) fail('--title is required with --decide');
          let then;
          if (thenSend) {
            const [tRef, tText] = thenSend;
            if (!tRef || !tText) fail('--then-send takes TARGET TEXT');
            const target = tRef.includes('{{') ? tRef : await find(tRef, { history: true }).then((f) => f.live?.uid ?? f.past.ref);
            then = { kind: 'send', target, text: tText };
          } else if (thenLaunch) {
            const [lAgent, lCwd, lPrompt] = thenLaunch;
            if (!lAgent || !lCwd || !lPrompt) fail('--then-launch takes AGENT CWD PROMPT');
            then = { kind: 'launch', preset: lAgent, cwd: resolve(lCwd), prompt: lPrompt };
          }
          action = { kind: 'decide', title, ...(body ? { body } : {}), ...(then ? { then } : {}) };
        } else if (launchAgent) {
          if (!prompt) fail('--prompt is required with --launch');
          action = {
            kind: 'launch',
            preset: launchAgent,
            cwd: resolve(cwd),
            prompt,
            ...(mode ? { mode } : {}),
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(worktree ? { worktree: true } : {}),
          };
        } else if (sendTo) {
          if (!text) fail('--text is required with --send');
          const target = sendTo.includes('{{') ? sendTo : await find(sendTo, { history: true }).then((f) => f.live?.uid ?? f.past.ref);
          action = { kind: 'send', target, text };
        } else fail('what should it do? --launch AGENT --prompt "…", --send TARGET --text "…", or --decide --title "…"');
        let trigger = { kind: 'manual' };
        if (at) trigger = { kind: 'at', at: Math.floor(new Date(at).getTime() / 1000) };
        else if (inDelay) {
          const secs = parseDuration(inDelay);
          if (!secs) fail('--in takes e.g. 30s, 10m, 2h or 1d');
          trigger = { kind: 'at', at: Math.floor(Date.now() / 1000) + secs };
        } else if (every) {
          const secs = parseDuration(every);
          if (!secs) fail('--every takes e.g. 30s, 5m, 1h or 1d');
          trigger = { kind: 'every', seconds: secs };
        } else if (daily) {
          const [h, mm] = daily.split(':').map(Number);
          trigger = { kind: 'cron', expr: `${mm} ${h} * * *`, tz };
        } else if (cron) trigger = { kind: 'cron', expr: cron, tz };
        else if (afterJob) {
          const [job, on = 'success'] = afterJob.split(':');
          trigger = { kind: 'after', job, on };
        } else if (overlapTrig) {
          trigger = { kind: 'overlap', ...(overlapRepo ? { repo: overlapRepo } : {}), ...(repeat ? { repeat: true } : {}) };
        } else if (idle || waitingOn || stalledOn || ended) {
          const rawTarget = idle ?? waitingOn ?? stalledOn ?? ended;
          const uid = rawTarget === '*' ? '*' : (await find(rawTarget)).live.uid;
          const on = idle ? 'idle' : waitingOn ? 'waiting' : stalledOn ? 'stalled' : 'ended';
          const afterSeconds = stalledOn && afterRaw ? parseDuration(afterRaw) : undefined;
          if (stalledOn && afterRaw && !afterSeconds) fail('--after-stall takes e.g. 5m, 10m, 300s');
          const exclude = excludes.length
            ? await Promise.all(excludes.map((e) => find(e, { history: true }).then((f) => f.live?.uid ?? f.past.ref)))
            : undefined;
          trigger = { kind: 'session', uid, on, ...(afterSeconds ? { afterSeconds } : {}), ...(repeat ? { repeat: true } : {}), ...(exclude ? { exclude } : {}) };
        }
        if (trigger.kind === 'at' && !Number.isFinite(trigger.at)) fail('could not read that time');
        const policy = {
          ...(retries !== undefined ? { retries: Number(retries) } : {}),
          ...(maxRuns !== undefined ? { maxRuns: Number(maxRuns) } : {}),
          ...(until ? { until } : {}),
          ...(concurrencyKey ? { concurrencyKey } : {}),
          ...(notify ? { notify: true } : {}),
          ...(skipIfBusy ? { skipIfBusy: true } : {}),
          ...(ifLive ? { ifLive: true } : {}),
          ...(allowDangerous ? { allowDangerous: true } : {}),
          ...(autoRecover ? { autoRecover: true } : {}),
        };
        const job = await call('POST', '/api/jobs', { name, action, trigger, policy });
        if (json) return console.log(JSON.stringify(job, null, 2));
        return console.log(`${job.id}  ${job.name}  ${job.state}${job.nextRunAt ? `  next ${new Date(job.nextRunAt * 1000).toLocaleString()}` : ''}`);
      }
      if (sub === 'edit') {
        const jobId = args.shift();
        if (!jobId) fail('usage: ah job edit <id> [--name N] [--every D | --cron E | --at T] [--skip-if-busy|--no-skip-if-busy] [--if-live|--no-if-live]');
        const existing = await call('GET', `/api/jobs/${encodeURIComponent(jobId)}`);
        const name = opt(args, '--name', undefined);
        const every = opt(args, '--every', undefined);
        const cron = opt(args, '--cron', undefined);
        const tz = opt(args, '--tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
        const at = opt(args, '--at', undefined);
        const patch = {};
        if (name !== undefined) patch.name = name;
        if (every) {
          const secs = parseDuration(every);
          if (!secs) fail('--every takes e.g. 30s, 5m, 1h or 1d');
          patch.trigger = { kind: 'every', seconds: secs };
        } else if (cron) patch.trigger = { kind: 'cron', expr: cron, tz };
        else if (at) patch.trigger = { kind: 'at', at: Math.floor(new Date(at).getTime() / 1000) };
        const policy = { ...(existing.policy ?? {}) };
        let changedPolicy = false;
        if (flag(args, '--skip-if-busy')) (policy.skipIfBusy = true), (changedPolicy = true);
        if (flag(args, '--no-skip-if-busy')) (policy.skipIfBusy = false), (changedPolicy = true);
        if (flag(args, '--if-live')) (policy.ifLive = true), (changedPolicy = true);
        if (flag(args, '--no-if-live')) (policy.ifLive = false), (changedPolicy = true);
        if (changedPolicy) patch.policy = policy;
        const job = await call('PATCH', `/api/jobs/${encodeURIComponent(jobId)}`, patch);
        if (json) return console.log(JSON.stringify(job, null, 2));
        return console.log(`${job.id}  ${job.name}  ${job.state}${job.nextRunAt ? `  next ${new Date(job.nextRunAt * 1000).toLocaleString()}` : ''}`);
      }
      if (sub === 'show') {
        const j = await call('GET', `/api/jobs/${encodeURIComponent(args[0] ?? '')}`);
        if (json) return console.log(JSON.stringify(j, null, 2));
        console.log(`${j.id}  ${j.name}  ${j.state}  trigger ${JSON.stringify(j.trigger)}`);
        table([['RUN', 'STATE', 'TRY', 'STARTED', 'SESSION', 'RESULT'], ...j.runs.map((r) => [r.id, r.state, r.attempt, r.startedAt ? new Date(r.startedAt * 1000).toLocaleString() : '', r.sessionUid ?? '', (r.error ?? r.outcome.skippedBecause ?? r.outcome.reply ?? '').split('\n')[0].slice(0, 60)])]);
        return;
      }
      if (['pause', 'resume', 'cancel', 'run'].includes(sub)) {
        const out = await call('POST', `/api/jobs/${encodeURIComponent(args[0] ?? '')}/${sub}`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`${out.id} ${out.state}`);
      }
      if (sub === 'decide') {
        const note = opt(args, '--note', undefined);
        const yes = args[1] === 'yes' ? true : args[1] === 'no' ? false : fail('yes or no');
        const out = await call('POST', `/api/jobs/runs/${encodeURIComponent(args[0] ?? '')}/decide`, { approve: yes, ...(note ? { note } : {}) });
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`${out.id} ${out.state}`);
      }
      if (sub === 'resolve') {
        const resend = args[1] === 'resend' ? true : args[1] === 'leave' ? false : fail('resend or leave');
        const out = await call('POST', `/api/jobs/runs/${encodeURIComponent(args[0] ?? '')}/resolve`, { resend });
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`${out.id} ${out.state}`);
      }
      fail('job add|edit|show|pause|resume|cancel|run|decide|resolve');
      return;
    }
    case 'heartbeat': {
      const json = flag(args, '--json');
      const sub = args[0];
      if (sub === 'list') {
        args.shift();
        const targetFilter = opt(args, '--target', undefined);
        const targetUid = targetFilter ? (await find(targetFilter, { history: true })).live?.uid ?? null : null;
        const { jobs } = await call('GET', '/api/jobs');
        const beats = jobs.filter(
          (j) =>
            j.trigger?.kind === 'every' &&
            j.action?.kind === 'send' &&
            (!targetUid || j.action.target === targetUid),
        );
        if (json) return console.log(JSON.stringify(beats, null, 2));
        if (!beats.length) return console.log('no heartbeats');
        table([
          ['ID', 'TARGET', 'EVERY', 'STATE', 'NEXT', 'NAME'],
          ...beats.map((j) => [
            j.id,
            j.action.target,
            formatDuration(j.trigger.seconds),
            j.state,
            j.nextRunAt ? new Date(j.nextRunAt * 1000).toLocaleTimeString() : '',
            j.name,
          ]),
        ]);
        return;
      }
      if (['stop', 'cancel', 'pause', 'resume'].includes(sub)) {
        args.shift();
        const verb = sub === 'stop' ? 'cancel' : sub;
        const id = args[0] || fail(`usage: ah heartbeat ${sub} <job-id>`);
        const out = await call('POST', `/api/jobs/${encodeURIComponent(id)}/${verb}`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`${out.id} ${out.state}`);
      }
      const targetArg = args.shift();
      const every = opt(args, '--every', undefined);
      const text = opt(args, '--text', 'Heartbeat: check on active sessions and pending prompts.');
      const name = opt(args, '--name', undefined);
      const allowBusy = flag(args, '--allow-busy');
      const wakeEnded = flag(args, '--wake-ended');
      const until = opt(args, '--until', 'delivered');
      const maxRuns = opt(args, '--max-runs', undefined);
      if (!targetArg || !every) fail('usage: ah heartbeat <target> --every <dur> [--text "…"] [--name N] [--allow-busy] [--wake-ended] [--json]');
      const seconds = parseDuration(every);
      if (!seconds) fail('--every takes e.g. 30s, 5m, 1h or 1d');
      const found = await find(targetArg, { history: true });
      const uid = found.live?.uid ?? found.past.ref;
      const label = found.live?.title || found.live?.name || found.past?.title || uid;
      const job = await call('POST', '/api/jobs', {
        name: name ?? `Heartbeat: ${label}`,
        action: { kind: 'send', target: uid, text },
        trigger: { kind: 'every', seconds },
        policy: {
          skipIfBusy: !allowBusy,
          ifLive: !wakeEnded,
          until,
          concurrencyKey: `heartbeat:${uid}`,
          ...(maxRuns !== undefined ? { maxRuns: Number(maxRuns) } : {}),
        },
      });
      if (json) return console.log(JSON.stringify(job, null, 2));
      console.log(`${job.id}  heartbeat every ${formatDuration(seconds)} → ${uid}${job.nextRunAt ? `  next ${new Date(job.nextRunAt * 1000).toLocaleTimeString()}` : ''}`);
      return;
    }
    case 'wake': {
      const json = flag(args, '--json');
      const targetArg = args.shift();
      if (!targetArg) fail('usage: ah wake <target> (--in D | --at T | --every D | --cron E | --when-idle S|* | --when-waiting S|* | --when-ended S|*) [--repeat] [--text "…"] [--json]');
      const inDelay = opt(args, '--in', undefined);
      const at = opt(args, '--at', undefined);
      const every = opt(args, '--every', undefined);
      const cron = opt(args, '--cron', undefined);
      const tz = opt(args, '--tz', Intl.DateTimeFormat().resolvedOptions().timeZone);
      const idle = opt(args, '--when-idle', undefined);
      const waitingOn = opt(args, '--when-waiting', undefined);
      const stalledOn = opt(args, '--when-stalled', undefined);
      const afterRaw = opt(args, '--after', undefined);
      const ended = opt(args, '--when-ended', undefined);
      const overlapTrig = flag(args, '--when-overlap');
      const overlapRepo = opt(args, '--repo', undefined);
      const repeat = flag(args, '--repeat');
      const excludes = opts(args, '--exclude');
      const name = opt(args, '--name', undefined);
      const skipIfBusy = flag(args, '--skip-if-busy');
      const ifLive = flag(args, '--if-live');
      const until = opt(args, '--until', 'delivered');
      const maxRuns = opt(args, '--max-runs', undefined);
      const explicitText = opt(args, '--text', undefined);
      const found = await find(targetArg, { history: true });
      const uid = found.live?.uid ?? found.past.ref;
      let trigger = null;
      let defaultText = 'Wake: check status and continue.';
      if (inDelay) {
        const secs = parseDuration(inDelay);
        if (!secs) fail('--in takes e.g. 30s, 10m, 2h or 1d');
        trigger = { kind: 'at', at: Math.floor(Date.now() / 1000) + secs };
      } else if (at) {
        trigger = { kind: 'at', at: Math.floor(new Date(at).getTime() / 1000) };
      } else if (every) {
        const secs = parseDuration(every);
        if (!secs) fail('--every takes e.g. 30s, 5m, 1h or 1d');
        trigger = { kind: 'every', seconds: secs };
      } else if (cron) {
        trigger = { kind: 'cron', expr: cron, tz };
      } else if (overlapTrig) {
        trigger = { kind: 'overlap', ...(overlapRepo ? { repo: overlapRepo } : {}), ...(repeat ? { repeat: true } : {}) };
        defaultText = '[ah overlap] Concurrent checkouts in "{{trigger.repo}}" touched overlapping files ({{trigger.files}}) across sessions: {{trigger.sessions}}';
      } else if (idle || waitingOn || stalledOn || ended) {
        const rawWatch = idle ?? waitingOn ?? stalledOn ?? ended;
        const watchUid = rawWatch === '*' ? '*' : (await find(rawWatch)).live.uid;
        const on = idle ? 'idle' : waitingOn ? 'waiting' : stalledOn ? 'stalled' : 'ended';
        const afterSeconds = stalledOn && afterRaw ? parseDuration(afterRaw) : undefined;
        if (stalledOn && afterRaw && !afterSeconds) fail('--after takes e.g. 5m, 10m, 300s');
        const exclude = excludes.length
          ? await Promise.all(excludes.map((e) => find(e, { history: true }).then((f) => f.live?.uid ?? f.past.ref)))
          : undefined;
        trigger = { kind: 'session', uid: watchUid, on, ...(afterSeconds ? { afterSeconds } : {}), ...(repeat ? { repeat: true } : {}), ...(exclude ? { exclude } : {}) };
        defaultText =
          on === 'waiting'
            ? '[ah event] Session "{{trigger.title}}" ({{trigger.session}}) needs input: {{trigger.ask}}'
            : on === 'stalled'
              ? '[ah event] Session "{{trigger.title}}" ({{trigger.session}}) appears stalled ({{trigger.stalledSeconds}}s without progress).'
              : on === 'idle'
                ? '[ah event] Session "{{trigger.title}}" ({{trigger.session}}) finished its turn.'
                : '[ah event] Session "{{trigger.title}}" ({{trigger.session}}) ended.';
      }
      if (!trigger) fail('specify when to wake: --in, --at, --every, --cron, --when-idle, --when-waiting, --when-stalled, --when-ended, or --when-overlap');
      const job = await call('POST', '/api/jobs', {
        name: name ?? `Wake ${found.live?.title || found.live?.name || uid}`,
        action: { kind: 'send', target: uid, text: explicitText ?? defaultText },
        trigger,
        policy: {
          until,
          ...(skipIfBusy ? { skipIfBusy: true } : {}),
          ...(ifLive ? { ifLive: true } : {}),
          ...(maxRuns !== undefined ? { maxRuns: Number(maxRuns) } : {}),
        },
      });
      if (json) return console.log(JSON.stringify(job, null, 2));
      console.log(`${job.id}  ${job.name}  ${job.state}${job.nextRunAt ? `  next ${new Date(job.nextRunAt * 1000).toLocaleString()}` : ''}`);
      return;
    }
    case 'migrations': {
      const json = flag(args, '--json');
      if (args[0] === 'retry' || args[0] === 'cancel') {
        const m = await call('POST', `/api/migrations/${encodeURIComponent(args[1] ?? '')}/${args[0]}`);
        return console.log(`${m.id} ${m.state}${m.error ? `: ${m.error}` : ''}`);
      }
      const { migrations } = await call('GET', '/api/migrations');
      if (json) return console.log(JSON.stringify(migrations, null, 2));
      if (!migrations.length) return console.log('no moves between hosts yet');
      table([['ID', 'DIRECTION', 'STATE', 'SESSION', 'WHERE'], ...migrations.map((m) => [m.id, m.role === 'outgoing' ? `→ ${m.peer}` : `← ${m.peer}`, m.state, m.title || m.harness, m.destCwd ?? ''])]);
      return;
    }
    case 'write':
    case 'send': {
      const json = flag(args, '--json');
      const enter = !flag(args, '--no-enter');
      const urgent = flag(args, '--now') || flag(args, '--urgent');
      const shouldWait = flag(args, '--wait');
      const timeout = Number(opt(args, '--timeout', '0'));
      const id = opt(args, '--id', undefined);
      const target = args.shift();
      let text = args.join(' ');
      if (text === '-' || (!text && !process.stdin.isTTY)) text = readFileSync(0, 'utf8').replace(/\n$/, '');
      if (!text) fail('nothing to send');
      const found = await find(target, { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      let out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/send`, { text, enter, ...(id ? { id } : {}) });
      if (urgent && out.outcome === 'queued' && out.queueId && found.live) {
        out = await call('POST', `/api/sessions/${encodeURIComponent(found.live.uid)}/queue/${encodeURIComponent(out.queueId)}/send-now`);
      }
      if (shouldWait) {
        const waitUid = found.live?.uid ?? (await call('GET', '/api/state')).windows.find((w) => w.id === out.windowId)?.uid ?? ref;
        await waitForSessions([waitUid], { until: 'settled', timeout, grace: true, json });
        return;
      }
      if (json) return console.log(JSON.stringify({ uid: found.live?.uid ?? ref, ...out }, null, 2));
      console.log(out.outcome === 'delivered' ? 'sent' : out.resumed ? 'resuming; queued until ready' : `queued (${out.queued})`);
      return;
    }
    case 'read': {
      const json = flag(args, '--json');
      const screenOnly = flag(args, '--screen');
      const lastOnly = flag(args, '--last');
      const wantFeed = flag(args, '--feed');
      const wantConv = flag(args, '--conversation') || flag(args, '-c');
      const before = opt(args, '--before', undefined);
      const lines = Number(opt(args, '-n', wantFeed || wantConv ? '50' : '200'));
      const found = await find(args[0], { history: wantFeed || wantConv });
      const ref = found.live?.uid ?? found.past.ref;
      if (wantConv) {
        const out = await call('GET', `/api/portable/conversations/${encodeURIComponent(ref)}`);
        if (json) return console.log(JSON.stringify(out.conversation, null, 2));
        const harness = out.conversation.source.harness;
        const harnessName = found.state.presets?.find((p) => p.id === harness)?.name;
        process.stdout.write(readableConversation(out.conversation, { last: lines, harnessName }));
        return;
      }
      if (wantFeed) {
        const qs = new URLSearchParams({ limit: String(lines), ...(before !== undefined ? { before } : {}) });
        const page = await call('GET', `/api/sessions/${encodeURIComponent(ref)}/feed?${qs.toString()}`);
        if (json) return console.log(JSON.stringify(page, null, 2));
        process.stdout.write(formatFeedEntries(page.entries));
        return;
      }
      const live = found.live;
      if (lastOnly) {
        if (live.reply?.text) {
          if (json) return console.log(JSON.stringify({ uid: live.uid, title: live.title || live.name, status: live.status, reply: live.reply, ask: live.ask, askId: live.askId }, null, 2));
          console.log(live.reply.text);
          return;
        }
        // Fallback for non-transcript harnesses (shells, Cursor, Copilot, etc.): last non-empty screen lines.
        const cap = await call('GET', `/api/sessions/${encodeURIComponent(live.uid)}/capture?screen=1`);
        const tail = cap.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-20).join('\n');
        if (json) return console.log(JSON.stringify({ uid: live.uid, title: live.title || live.name, status: live.status, reply: null, screenTail: tail, ask: live.ask, askId: live.askId }, null, 2));
        console.log(tail);
        return;
      }
      const qs = screenOnly ? 'screen=1' : `lines=${lines}`;
      const text = await call('GET', `/api/sessions/${encodeURIComponent(live.uid)}/capture?${qs}`);
      if (json) {
        return console.log(JSON.stringify({
          uid: live.uid,
          id: live.id,
          title: live.title || live.name,
          agent: live.agent,
          status: live.status,
          mode: live.launchMode ?? 'default',
          ask: live.ask,
          askId: live.askId,
          answerable: live.answerable,
          reply: live.reply ?? null,
          text,
        }, null, 2));
      }
      process.stdout.write(text);
      return;
    }
    case 'conversation': {
      const json = flag(args, '--json');
      const last = Number(opt(args, '-n', '50'));
      const found = await find(args[0], { history: true });
      const out = await call('GET', `/api/portable/conversations/${encodeURIComponent(found.live?.uid ?? found.past.ref)}`);
      if (json) return console.log(JSON.stringify(out.conversation, null, 2));
      const harness = out.conversation.source.harness;
      const harnessName = found.state.presets?.find((p) => p.id === harness)?.name;
      process.stdout.write(readableConversation(out.conversation, { last, harnessName }));
      return;
    }
    case 'watch': {
      const json = flag(args, '--json');
      const once = flag(args, '--once');
      const timeout = Number(opt(args, '--timeout', '0'));
      const evOpt = opt(args, '--events', undefined);
      const allowed = evOpt ? new Set(evOpt.split(',').map((s) => s.trim()).filter(Boolean)) : null;
      let onlyUids = null;
      if (args.length) {
        const resolved = await Promise.all(args.map((t) => find(t).then((f) => f.live.uid)));
        onlyUids = new Set(resolved);
      }
      const ac = new AbortController();
      let timer = null;
      let timedOut = false;
      if (timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, timeout * 1000);
      }
      try {
        await streamEvents((next, prev) => {
          if (!prev) return;
          const events = diffFleet(prev.windows, next.windows, onlyUids).filter((e) => !allowed || allowed.has(e.event));
          for (const ev of events) {
            if (json) {
              const { window: _w, ...compact } = ev;
              console.log(JSON.stringify(compact));
            } else {
              const ts = new Date(ev.at * 1000).toLocaleTimeString();
              const detail =
                ev.event === 'status'
                  ? `${ev.from} → ${ev.to}`
                  : ev.event === 'ask'
                    ? (ev.ask?.text?.split('\n')[0] ?? 'waiting for input').slice(0, 100)
                    : ev.event === 'reply'
                      ? (ev.reply?.text?.split('\n')[0] ?? '').slice(0, 100)
                      : ev.status ?? '';
              console.log(`${ts}  ${ev.event.padEnd(7)}  ${ev.uid}  ${ev.title}${detail ? `  ${detail}` : ''}`);
            }
            if (once) {
              ac.abort();
              return;
            }
          }
        }, { signal: ac.signal });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (timedOut) fail('timed out');
      return;
    }
    case 'wait': {
      const json = flag(args, '--json');
      const grace = !flag(args, '--no-grace');
      const until = opt(args, '--until', 'settled');
      const timeout = Number(opt(args, '--timeout', '0'));
      if (!['settled', 'idle', 'waiting', 'ended', 'any'].includes(until)) fail('--until must be settled, idle, waiting, ended or any');
      if (!args.length) fail('usage: ah wait <target> [target…] [--until settled|idle|waiting|ended|any] [--timeout SECS] [--json]');
      const targets = await Promise.all(args.map((t) => find(t)));
      await waitForSessions(targets.map((f) => f.live.uid), { until, timeout, grace, json });
      return;
    }
    case 'answer': {
      const json = flag(args, '--json');
      const promptId = opt(args, '--prompt', undefined);
      const pickRaw = opt(args, '--pick', undefined);
      const notes = opt(args, '--notes', undefined);
      const answersRaw = opt(args, '--answers', undefined);
      const freeText = opt(args, '--text', undefined);
      const chat = flag(args, '--chat');
      const gateText = opt(args, '--gate-text', undefined);
      const gateBack = flag(args, '--gate-back');
      const gateCallback = opt(args, '--gate-callback', undefined);
      const { live } = await find(args[0]);
      if (live.status !== 'waiting') fail(`"${live.title || live.name}" isn't waiting for an answer`);
      const uid = encodeURIComponent(live.uid);
      if (gateBack || gateText !== undefined || gateCallback !== undefined) {
        const body = gateCallback !== undefined ? { callback: gateCallback } : gateBack ? { back: true } : { text: gateText };
        const out = await call('POST', `/api/sessions/${uid}/gate`, body);
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'gate', uid: live.uid, ...out }, null, 2));
        console.log(gateBack ? 'went back' : gateCallback !== undefined ? `callback relayed (${out.status ?? 'ok'})` : 'gate answered');
        return;
      }
      if (chat) {
        await call('POST', `/api/sessions/${uid}/questions`, { chat: true, ...(live.ask?.dialog?.question ? { question: live.ask.dialog.question } : {}) });
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'questions.chat', uid: live.uid }, null, 2));
        console.log('switched to chat');
        return;
      }
      if (answersRaw !== undefined) {
        let answers;
        try {
          answers = JSON.parse(answersRaw);
        } catch {
          fail('--answers must be valid JSON array');
        }
        await call('POST', `/api/sessions/${uid}/questions`, { answers });
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'questions', uid: live.uid, count: answers.length }, null, 2));
        console.log(`answered ${answers.length} question(s)`);
        return;
      }
      if (pickRaw !== undefined) {
        const picked = pickRaw.split(',').map((s) => Number(s.trim()) - 1).filter((n) => Number.isInteger(n) && n >= 0);
        if (!picked.length) fail('--pick takes 1-based option numbers (e.g. --pick 1 or --pick 1,3)');
        const answer = { picked, ...(notes !== undefined ? { notes } : {}) };
        if (live.ask?.dialog?.question) {
          await call('POST', `/api/sessions/${uid}/questions`, { current: { question: live.ask.dialog.question, answer } });
        } else {
          await call('POST', `/api/sessions/${uid}/questions`, { answers: [answer] });
        }
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'questions', uid: live.uid, picked }, null, 2));
        console.log(`picked ${pickRaw}`);
        return;
      }
      if (freeText !== undefined) {
        if (live.ask?.kind === 'choice' && live.ask?.dialog?.question) {
          await call('POST', `/api/sessions/${uid}/questions`, { current: { question: live.ask.dialog.question, answer: { picked: [], text: freeText } } });
          if (json) return console.log(JSON.stringify({ ok: true, kind: 'questions', uid: live.uid, text: freeText }, null, 2));
          console.log('answered');
          return;
        }
        const out = await call('POST', `/api/sessions/${uid}/send`, { text: freeText, enter: true });
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'text', uid: live.uid, ...out }, null, 2));
        console.log('answered');
        return;
      }
      const rawChoice = args[1] ?? '';
      const choice = rawChoice.toLowerCase();
      if (!choice) fail('usage: ah answer <target> (<yes|no|N|KEY> | --pick I[,I] | --answers JSON | --text "…" | --chat | --gate-text "…")');
      const matchedOpt = resolvePickerChoice(live.ask?.options, rawChoice);
      if (matchedOpt && (/^\d+$/.test(choice) || choice.startsWith('nav:') || !['yes', 'y', 'approve', 'no', 'n', 'deny'].includes(choice) || !live.answerable)) {
        const picked = await call('POST', `/api/sessions/${uid}/choose`, { key: matchedOpt.key });
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'choose', uid: live.uid, key: matchedOpt.key, label: picked.label }, null, 2));
        console.log(`answered: ${picked.label ?? matchedOpt.key}`);
        return;
      }
      if (/^\d+$/.test(choice)) {
        const picked = await call('POST', `/api/sessions/${uid}/choose`, { key: choice });
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'choose', uid: live.uid, key: choice, label: picked.label }, null, 2));
        console.log(`answered: ${picked.label ?? choice}`);
      } else if (['yes', 'y', 'approve'].includes(choice) || ['no', 'n', 'deny'].includes(choice)) {
        const answer = ['no', 'n', 'deny'].includes(choice) ? 'deny' : 'approve';
        if (answer === 'approve' && !live.answerable && live.ask?.trust?.accept) {
          const picked = await call('POST', `/api/sessions/${uid}/choose`, { key: live.ask.trust.accept });
          if (json) return console.log(JSON.stringify({ ok: true, kind: 'choose', uid: live.uid, key: live.ask.trust.accept, label: picked.label }, null, 2));
          console.log(`answered: ${picked.label ?? 'trusted'}`);
          return;
        }
        await call('POST', `/api/sessions/${uid}/answer`, { answer, ...(promptId ? { prompt: promptId } : {}) });
        if (json) return console.log(JSON.stringify({ ok: true, kind: 'answer', uid: live.uid, answer, ...(promptId ? { prompt: promptId } : {}) }, null, 2));
        console.log(answer === 'approve' ? 'approved' : 'denied');
      } else fail(`"${rawChoice}" isn't an answer: use yes, no, an option number/key, --pick, --text, or --gate-text`);
      return;
    }
    case 'forward': {
      const json = flag(args, '--json');
      const asDecide = flag(args, '--decide');
      const shouldWait = flag(args, '--wait');
      const timeout = Number(opt(args, '--timeout', '0'));
      const title = opt(args, '--title', undefined);
      const note = opt(args, '--note', undefined);
      const thenSend = optPair(args, '--then-send');
      const { live } = await find(args[0]);
      if (asDecide) {
        const askLines = formatAsk(live.ask, { askId: live.askId, answerable: live.answerable }).join('\n');
        const bodyParts = [note, askLines].filter(Boolean);
        let then;
        if (thenSend) {
          const [tRef, tText] = thenSend;
          if (!tRef || !tText) fail('--then-send takes TARGET TEXT');
          const target = tRef.includes('{{') ? tRef : await find(tRef, { history: true }).then((f) => f.live?.uid ?? f.past.ref);
          then = { kind: 'send', target, text: tText };
        }
        const decideTitle = title ?? `Decision for ${live.title || live.name}`;
        const job = await call('POST', '/api/jobs', {
          name: decideTitle,
          action: { kind: 'decide', title: decideTitle, ...(bodyParts.length ? { body: bodyParts.join('\n\n') } : {}), ...(then ? { then } : {}) },
          trigger: { kind: 'manual' },
          policy: { notify: true },
        });
        const run = await call('POST', `/api/jobs/${encodeURIComponent(job.id)}/run`);
        if (!shouldWait) {
          if (json) return console.log(JSON.stringify({ forwarded: true, mode: 'decide', uid: live.uid, jobId: job.id, runId: run.id }, null, 2));
          console.log(`forwarded as decision ${run.id} (job ${job.id}); answer in Inbox or: ah job decide ${run.id} yes|no`);
          return;
        }
        const settled = await waitForDecision(run.id, { timeout });
        if (json) return console.log(JSON.stringify({ forwarded: true, mode: 'decide', uid: live.uid, jobId: job.id, runId: run.id, state: settled.state, decision: settled.outcome?.decision ?? null, note: settled.outcome?.note ?? null }, null, 2));
        console.log(`${settled.outcome?.decision ?? settled.state}${settled.outcome?.note ? `: ${settled.outcome.note}` : ''}`);
        process.exit(settled.outcome?.decision === 'approved' ? 0 : 2);
      }
      const out = await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/forward`, { ...(title ? { title } : {}), ...(note ? { note } : {}) });
      if (shouldWait) {
        const beforeAsk = live.askId;
        const ac = new AbortController();
        let timer = null;
        let resolvedWin = null;
        if (timeout > 0) timer = setTimeout(() => ac.abort(), timeout * 1000);
        try {
          await streamEvents((state) => {
            const w = (state.windows ?? []).find((x) => x.uid === live.uid);
            if (!w || w.status !== 'waiting' || (beforeAsk && w.askId !== beforeAsk)) {
              resolvedWin = w ?? null;
              ac.abort();
            }
          }, { signal: ac.signal });
        } finally {
          if (timer) clearTimeout(timer);
        }
        if (resolvedWin === null && timeout > 0) {
          const cur = (await call('GET', '/api/state')).windows.find((x) => x.uid === live.uid);
          if (cur && cur.status === 'waiting' && cur.askId === beforeAsk) fail('timed out waiting for user answer');
        }
        if (json) return console.log(JSON.stringify({ ...out, resolved: true, status: resolvedWin?.status ?? 'ended' }, null, 2));
        console.log(`resolved (${resolvedWin?.status ?? 'ended'})`);
        return;
      }
      if (json) return console.log(JSON.stringify(out, null, 2));
      console.log(`forwarded "${live.title || live.name}" to user${out.answerable ? ' (approve/deny available)' : ''}`);
      return;
    }
    case 'decide': {
      const json = flag(args, '--json');
      const shouldWait = flag(args, '--wait');
      const timeout = Number(opt(args, '--timeout', '0'));
      const title = opt(args, '--title', undefined);
      const body = opt(args, '--body', undefined);
      const thenSend = optPair(args, '--then-send');
      const thenLaunch = optTriple(args, '--then-launch');
      if (!title) fail('usage: ah decide --title "…" [--body "…"] [--then-send TARGET TEXT | --then-launch AGENT CWD PROMPT] [--wait] [--json]');
      let then;
      if (thenSend) {
        const [tRef, tText] = thenSend;
        if (!tRef || !tText) fail('--then-send takes TARGET TEXT');
        const target = tRef.includes('{{') ? tRef : await find(tRef, { history: true }).then((f) => f.live?.uid ?? f.past.ref);
        then = { kind: 'send', target, text: tText };
      } else if (thenLaunch) {
        const [lAgent, lCwd, lPrompt] = thenLaunch;
        if (!lAgent || !lCwd || !lPrompt) fail('--then-launch takes AGENT CWD PROMPT');
        then = { kind: 'launch', preset: lAgent, cwd: resolve(lCwd), prompt: lPrompt };
      }
      const job = await call('POST', '/api/jobs', {
        name: title,
        action: { kind: 'decide', title, ...(body ? { body } : {}), ...(then ? { then } : {}) },
        trigger: { kind: 'manual' },
        policy: { notify: true },
      });
      const run = await call('POST', `/api/jobs/${encodeURIComponent(job.id)}/run`);
      if (!shouldWait) {
        if (json) return console.log(JSON.stringify({ jobId: job.id, runId: run.id, state: 'waiting' }, null, 2));
        console.log(`${run.id}  waiting for decision (job ${job.id}); answer with: ah job decide ${run.id} yes|no`);
        return;
      }
      const settled = await waitForDecision(run.id, { timeout });
      if (json) return console.log(JSON.stringify({ jobId: job.id, runId: run.id, state: settled.state, decision: settled.outcome?.decision ?? null, note: settled.outcome?.note ?? null }, null, 2));
      console.log(`${settled.outcome?.decision ?? settled.state}${settled.outcome?.note ? `: ${settled.outcome.note}` : ''}`);
      process.exit(settled.outcome?.decision === 'approved' ? 0 : 2);
    }
    case 'interrupt':
    case 'stop': {
      const json = flag(args, '--json');
      const { live } = await find(args[0]);
      await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/interrupt`);
      if (json) return console.log(JSON.stringify({ ok: true, uid: live.uid }, null, 2));
      console.log('stopped');
      return;
    }
    case 'kill':
    case 'terminate': {
      const json = flag(args, '--json');
      const { live } = await find(args[0]);
      await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/terminate`);
      if (json) return console.log(JSON.stringify({ ok: true, uid: live.uid }, null, 2));
      console.log(`terminated "${live.title || live.name}"; \`ah resume ${live.uid}\` brings it back`);
      return;
    }
    case 'forget': {
      const json = flag(args, '--json');
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      await call('DELETE', `/api/sessions/${encodeURIComponent(ref)}`);
      if (json) return console.log(JSON.stringify({ ok: true, ref }, null, 2));
      console.log(`forgot ${ref}`);
      return;
    }
    case 'rename': {
      const json = flag(args, '--json');
      const { live } = await find(args[0]);
      const name = args.slice(1).join(' ').trim();
      if (!name) fail('usage: ah rename <target> <name…>');
      await call('PUT', `/api/sessions/${encodeURIComponent(live.uid)}/name`, { name });
      if (json) return console.log(JSON.stringify({ ok: true, uid: live.uid, name }, null, 2));
      console.log(`renamed to "${name}"`);
      return;
    }
    case 'pin': {
      const json = flag(args, '--json');
      const off = flag(args, '--off');
      const { live } = await find(args[0]);
      await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/pin`, { pinned: !off });
      if (json) return console.log(JSON.stringify({ ok: true, uid: live.uid, pinned: !off }, null, 2));
      console.log(off ? 'unpinned' : 'pinned');
      return;
    }
    case 'queue': {
      const json = flag(args, '--json');
      const unsent = flag(args, '--unsent');
      const clear = flag(args, '--clear');
      const removeId = opt(args, '--remove', undefined);
      const sendNowId = opt(args, '--send-now', undefined);
      const movePair = optPair(args, '--move');
      const { live } = await find(args[0]);
      const uid = encodeURIComponent(live.uid);
      if (clear) {
        await call('DELETE', `/api/sessions/${uid}/queue`);
        if (json) return console.log(JSON.stringify({ ok: true, uid: live.uid, cleared: true }, null, 2));
        return console.log('cleared');
      }
      if (removeId) {
        await call('DELETE', `/api/sessions/${uid}/queue/${encodeURIComponent(removeId)}`);
        if (json) return console.log(JSON.stringify({ ok: true, uid: live.uid, removed: removeId }, null, 2));
        return console.log(`removed ${removeId}`);
      }
      if (sendNowId) {
        const out = await call('POST', `/api/sessions/${uid}/queue/${encodeURIComponent(sendNowId)}/send-now`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log('sent');
      }
      if (movePair) {
        const [itemId, pos] = movePair;
        const to = Number(pos);
        if (!itemId || !Number.isInteger(to)) fail('usage: ah queue <target> --move <item-id> <pos>');
        const order = await call('POST', `/api/sessions/${uid}/queue/${encodeURIComponent(itemId)}/move`, { to });
        if (json) return console.log(JSON.stringify(order, null, 2));
        return console.log(`moved ${itemId} to ${to}`);
      }
      const q = await call('GET', `/api/sessions/${uid}/queue${unsent ? '?unsent=1' : ''}`);
      if (json) return console.log(JSON.stringify(q, null, 2));
      if (!q.length) return console.log('queue empty');
      for (const item of q) console.log(`${item.id}${item.unsent ? ' [unsent]' : ''}  ${item.text.split('\n')[0]}`);
      return;
    }
    case 'checkouts': {
      const sub = args[0];
      if (sub === 'gc') {
        args.shift();
        const dryRun = flag(args, '--dry-run');
        const out = await call('POST', '/api/checkouts/gc', { dryRun });
        if (flag(args, '--json')) return console.log(JSON.stringify(out, null, 2));
        if (!out.reclaimed.length) return console.log(dryRun ? 'nothing eligible to reclaim' : 'no eligible checkouts reclaimed');
        for (const r of out.reclaimed) console.log(`${dryRun ? 'would reclaim' : 'reclaimed'} ${r.id}  ${r.branch ?? ''}  ${fmtBytes(r.reclaimedBytes)}  (${r.reason})`);
        console.log(`${dryRun ? 'would reclaim' : 'reclaimed'} ${out.reclaimed.length} checkout(s), ${fmtBytes(out.reclaimedBytes)}`);
        return;
      }
      if (sub === 'check') {
        const id = args[1] || fail('usage: ah checkouts check <id>');
        const out = await call('POST', `/api/checkouts/${encodeURIComponent(id)}/check`, {});
        if (flag(args, '--json')) return console.log(JSON.stringify(out, null, 2));
        const i = out.integration;
        if (i?.clean) console.log(`${out.branch ?? out.id}: clean against ${i.trunk} (${i.trunkSha})`);
        else console.log(`${out.branch ?? out.id}: conflicts against ${i?.trunk ?? 'trunk'}: ${(i?.conflicts ?? []).join(', ') || i?.error || 'unknown'}`);
        return;
      }
      if (sub === 'pin') {
        const id = args[1] || fail('usage: ah checkouts pin <id> [--unpin]');
        const pinned = !flag(args, '--unpin');
        const out = await call('POST', `/api/checkouts/${encodeURIComponent(id)}/pin`, { pinned });
        console.log(`${out.id} ${out.pinned ? 'pinned' : 'unpinned'}`);
        return;
      }
      const repo = opt(args, '--repo', undefined);
      const out = await call('GET', repo ? `/api/checkouts?repo=${encodeURIComponent(resolve(repo))}` : '/api/checkouts');
      if (flag(args, '--json')) return console.log(JSON.stringify(out, null, 2));
      const s = out.storage;
      console.log(`Storage: ${fmtBytes(s.totalBytes)} across ${s.counts.total} worktrees (active ${fmtBytes(s.activeBytes)}, retained ${fmtBytes(s.retainedBytes)}, reclaimable ${fmtBytes(s.reclaimableBytes)})`);
      if (!out.checkouts.length) return console.log('no tracked checkouts');
      table([
        ['ID', 'REPO', 'BRANCH', 'STATE', 'OWNER', 'OVERLAPS', 'SIZE'],
        ...out.checkouts.map((c) => [
          c.id,
          c.repoName,
          c.kind === 'main' ? `${c.branch ?? 'main'} (main)` : (c.branch ?? '(detached)'),
          `${c.lifecycle}${c.pinned ? ' ★' : ''}${c.dirty ? ` · ${c.dirty}*` : ''}`,
          c.owner ? `${c.owner.agent}:${c.owner.title}` : '—',
          c.overlaps.length ? String(c.overlaps.reduce((n, o) => n + o.files.length, 0)) : '0',
          c.sizeBytes === null ? '—' : fmtBytes(c.sizeBytes),
        ]),
      ]);
      return;
    }
    case 'worktrees': {
      const list = await call('GET', '/api/worktrees');
      if (args[0] === 'clean') {
        args.shift();
        if (!flag(args, '--orphans')) fail('usage: ah worktrees clean --orphans [--force-dirty] [--yes]');
        const forceDirty = flag(args, '--force-dirty');
        const yes = flag(args, '--yes');
        const orphans = list.filter((w) => w.orphan);
        const targets = orphans.filter((w) => forceDirty || w.dirty === 0);
        const heldDirty = orphans.length - targets.length;
        if (heldDirty) console.log(`holding back ${heldDirty} dirty orphan${heldDirty === 1 ? '' : 's'} (pass --force-dirty to include)`);
        if (!targets.length) return console.log('no orphaned worktrees to clean');
        const total = targets.reduce((n, w) => n + (w.sizeBytes ?? 0), 0);
        for (const w of targets) console.log(`${w.branch}  ${w.sizeBytes === null ? 'size unknown' : fmtBytes(w.sizeBytes)}  ${w.path}${w.dirty ? `  (${w.dirty} uncommitted)` : ''}`);
        console.log(`${targets.length} worktree${targets.length === 1 ? '' : 's'}, about ${fmtBytes(total)} to reclaim`);
        if (!yes) return console.log('dry run; nothing removed. Re-run with --yes to remove.');
        const { results } = await call('POST', '/api/worktrees/remove-bulk', {
          paths: targets.map((w) => w.path),
          force: targets.filter((w) => w.dirty > 0).map((w) => w.path),
        });
        let reclaimed = 0;
        for (const r of results) {
          if (r.ok) {
            reclaimed += r.reclaimedBytes;
            console.log(`removed ${r.path}${r.gone ? ' (already gone)' : ''}`);
          } else console.log(`skipped ${r.path}: ${r.error}`);
        }
        return console.log(`reclaimed about ${fmtBytes(reclaimed)}`);
      }
      const orphansOnly = flag(args, '--orphans');
      const rows = orphansOnly ? list.filter((w) => w.orphan) : list;
      if (flag(args, '--json')) return console.log(JSON.stringify(rows, null, 2));
      if (!rows.length) return console.log('no managed worktrees');
      table([
        ['BRANCH', 'SIZE', 'STATE', 'PATH'],
        ...rows.map((w) => [
          w.branch,
          w.sizeBytes === null ? (w.sizeTooLarge ? 'too large' : 'measuring') : (w.sizePartial ? '~' : '') + fmtBytes(w.sizeBytes),
          w.live.length ? `in use (${w.live.map((l) => l.name).join(', ')})` : w.dirty ? `orphan, ${w.dirty} uncommitted` : 'orphan, clean',
          w.path,
        ]),
      ]);
      return;
    }
    case 'snapshots': {
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const out = await call('GET', `/api/sessions/${encodeURIComponent(ref)}/snapshots`);
      if (!out.available) return console.log('snapshots unavailable: not a git repository');
      if (!out.snapshots.length) return console.log('no snapshots yet');
      table([
        ['TURN', 'KIND', 'WHEN', 'BRANCH', 'CHANGES', 'PROMPT'],
        ...out.snapshots.map((s) => [
          s.turn,
          s.kind,
          new Date(s.createdAt * 1000).toLocaleString(),
          s.branch || '',
          `${s.filesChanged} files +${s.insertions}/-${s.deletions}`,
          s.promptExcerpt,
        ]),
      ]);
      return;
    }
    case 'rollback': {
      const interrupt = flag(args, '--interrupt');
      const to = opt(args, '--to', undefined);
      if (!to || !/^\d+$/.test(to)) fail('usage: ah rollback <target> --to TURN [--interrupt]');
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/snapshots/${to}/restore`, { interrupt });
      console.log(`restored to before turn ${to}; safety snapshot is turn ${out.safety.turn} (restore it to undo)`);
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
      if (args[0] === 'desktop') {
        // A launcher entry (SUPER+SPACE on Omarchy) that opens ah in its own app window.
        const { desktopStatus, installDesktop, removeDesktop } = await import('../server/desktop.ts');
        const off = flag(args, '--off');
        try {
          for (const line of off ? removeDesktop() : installDesktop(PORT)) console.log(line);
        } catch (e) {
          fail(e.message);
        }
        if (!off) console.log(`For a key, add to ~/.config/hypr/bindings.conf:\n  ${desktopStatus(PORT).bind}`);
        return;
      }
      if (args[0] !== 'tailscale') fail('usage: ah setup tailscale [--off] | desktop [--off]');
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
    case 'changes':
    case 'diff': {
      const json = flag(args, '--json');
      const statOnly = flag(args, '--stat');
      const { live } = await find(args[0]);
      const out = await call('GET', `/api/sessions/${encodeURIComponent(live.uid)}/changes`);
      if (json) return console.log(JSON.stringify(out, null, 2));
      if (!out.files?.length) return console.log('working tree clean');
      for (const f of out.files) {
        console.log(`${String(f.status ?? 'M').padEnd(3)} ${f.path}${f.additions != null ? `  +${f.additions}/-${f.deletions}` : ''}`);
        if (!statOnly && f.diff) process.stdout.write(f.diff.endsWith('\n') ? f.diff : `${f.diff}\n`);
      }
      return;
    }
    case 'branches': {
      const json = flag(args, '--json');
      const { live } = await find(args[0]);
      const uid = encodeURIComponent(live.uid);
      if (args[1]) {
        const out = await call('POST', `/api/sessions/${uid}/branches`, { branch: args[1] });
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`switched to ${out.branch}`);
      }
      const out = await call('GET', `/api/sessions/${uid}/branches`);
      if (json) return console.log(JSON.stringify(out, null, 2));
      for (const b of out.branches ?? []) console.log(`${b === out.current ? '* ' : '  '}${b}`);
      return;
    }
    case 'pr': {
      const json = flag(args, '--json');
      const { live } = await find(args[0]);
      const out = await call('GET', `/api/sessions/${encodeURIComponent(live.uid)}/pull`);
      if (json) return console.log(JSON.stringify(out, null, 2));
      if (!out.number) return console.log('no pull request for this branch');
      console.log(`#${out.number}  ${out.url}`);
      return;
    }
    case 'terminal': {
      const json = flag(args, '--json');
      const close = flag(args, '--close');
      const readOnly = flag(args, '--read');
      const noRun = flag(args, '--no-run');
      const target = args.shift();
      const { live } = await find(target);
      const uid = encodeURIComponent(live.uid);
      if (close) {
        await call('DELETE', `/api/sessions/${uid}/terminal`);
        if (json) return console.log(JSON.stringify({ ok: true, uid: live.uid, closed: true }, null, 2));
        return console.log('terminal closed');
      }
      if (readOnly) {
        const out = await call('GET', `/api/sessions/${uid}/terminal/text`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        if (out.last) console.log(`$ ${out.last.command}\n${out.last.output}`);
        else if (out.screen) console.log(out.screen);
        else console.log('no terminal open');
        return;
      }
      const command = args.join(' ').trim();
      if (!command) {
        const out = await call('GET', `/api/sessions/${uid}/terminal`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(out.terminal ? `${out.terminal.id}  ${out.terminal.cwd}  ${out.terminal.command}${out.terminal.busy ? ' (busy)' : ''}` : 'no terminal open');
      }
      const out = await call('POST', `/api/sessions/${uid}/terminal`, { command, run: !noRun });
      if (json) return console.log(JSON.stringify(out, null, 2));
      console.log(`${out.terminal.id}  ${noRun ? 'typed' : 'running'}`);
      return;
    }
    case 'verify': {
      const json = flag(args, '--json');
      const timeout = Number(opt(args, '--timeout', '120'));
      const taskId = opt(args, '--task', undefined);
      const target = args.shift();
      let command = args.join(' ').trim();
      if (!target) fail('usage: ah verify <target> [command…] [--timeout SECS] [--task ID] [--json]');
      if (!command && taskId) {
        const task = await call('GET', `/api/fleet/tasks/${encodeURIComponent(taskId)}`);
        command = (task?.verifyCmd ?? '').trim();
        if (!command) fail(`task ${taskId} has no verifyCmd stored; pass a command explicitly`);
      }
      if (!command) fail('usage: ah verify <target> <command…> [--timeout SECS] [--task ID] [--json]');
      const { live } = await find(target);
      const uid = encodeURIComponent(live.uid);
      const tag = `AHV_${randomBytes(4).toString('hex')}`;
      const wrapped = `printf '\\n${tag}_START\\n'; ( ${command} ); printf '\\n${tag}_EXIT=%d\\n' $?`;
      await call('POST', `/api/sessions/${uid}/terminal`, { command: wrapped, run: true });
      const deadline = Date.now() + Math.max(5, timeout) * 1000;
      let exitCode = null;
      let output = '';
      const endRe = new RegExp(`${tag}_EXIT=(\\d+)`);
      const startMarker = `${tag}_START`;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 350));
        const txt = await call('GET', `/api/sessions/${uid}/terminal/text`);
        const blob = `${txt.last?.output ?? ''}\n${txt.screen ?? ''}`;
        const m = blob.match(endRe);
        if (m) {
          exitCode = Number(m[1]);
          const sIdx = blob.lastIndexOf(startMarker);
          const eIdx = blob.lastIndexOf(m[0]);
          output = (sIdx >= 0 && eIdx > sIdx ? blob.slice(sIdx + startMarker.length, eIdx) : blob.slice(0, eIdx)).trim();
          break;
        }
      }
      if (exitCode === null) fail(`verify timed out after ${timeout}s`);
      const record = { at: Math.floor(Date.now() / 1000), command, exitCode, ok: exitCode === 0, output: output.slice(-8000) };
      if (taskId) {
        await call('PATCH', `/api/fleet/tasks/${encodeURIComponent(taskId)}`, { lastVerify: record });
      }
      if (json) console.log(JSON.stringify({ uid: live.uid, ...record }, null, 2));
      else {
        if (output) console.log(output);
        console.log(`verify ${record.ok ? 'PASSED' : 'FAILED'} (exit ${exitCode})`);
      }
      process.exit(exitCode === 0 ? 0 : 1);
    }
    case 'subagents': {
      const json = flag(args, '--json');
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const tree = await call('GET', `/api/sessions/${encodeURIComponent(ref)}/subagents`);
      if (json) return console.log(JSON.stringify(tree, null, 2));
      if (!tree.nodes?.length) return console.log('no subagents');
      for (const n of tree.nodes) {
        const pad = '  '.repeat(Math.max(0, (n.depth ?? 1) - 1));
        console.log(`${pad}${n.ref}  [${n.state}]  ${n.name || n.role || '(subagent)'}${n.activity ? `  · ${n.activity}` : ''}`);
      }
      return;
    }
    case 'spaces': {
      const json = flag(args, '--json');
      const out = await call('GET', '/api/spaces');
      if (json) return console.log(JSON.stringify(out, null, 2));
      if (!out.spaces?.length) return console.log('no spaces');
      table([
        ['NAME', 'LIVE', 'HISTORY', 'PROJECTS', 'PATH'],
        ...out.spaces.map((s) => [s.name, s.live, s.conversations, (s.projects ?? []).join(', '), s.path ?? '']),
      ]);
      return;
    }
    case 'space': {
      const json = flag(args, '--json');
      const sub = args.shift();
      if (sub === 'new') {
        const name = args.shift() || fail('usage: ah space new <name> [--prefs "…" | --file FILE]');
        const file = opt(args, '--file', undefined);
        const prefs = file ? readFileSync(file, 'utf8') : opt(args, '--prefs', undefined);
        const out = await call('POST', '/api/spaces', { name, ...(prefs !== undefined ? { preferences: prefs } : {}) });
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`created space "${out.space.name}" at ${out.space.path}`);
      }
      if (sub === 'remove' || sub === 'restore') {
        const name = args.join(' ').trim() || fail(`usage: ah space ${sub} <name>`);
        const out = await call('POST', `/api/spaces/${sub}`, { name });
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`${sub === 'remove' ? 'removed' : 'restored'} "${name}"`);
      }
      if (sub === 'prefs') {
        const name = args.shift() || fail('usage: ah space prefs <name> [text | --file FILE]');
        const file = opt(args, '--file', undefined);
        const text = file ? readFileSync(file, 'utf8') : args.join(' ');
        if (file || text) {
          const out = await call('PUT', `/api/spaces/${encodeURIComponent(name)}/preferences`, { text });
          if (json) return console.log(JSON.stringify(out, null, 2));
          return console.log(`saved ${out.file}`);
        }
        const out = await call('GET', `/api/spaces/${encodeURIComponent(name)}/preferences`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        return process.stdout.write(out.text.endsWith('\n') ? out.text : `${out.text}\n`);
      }
      if (sub === 'memory') {
        const name = args.shift() || fail('usage: ah space memory <name> [file.md] [--set "…" | --file FILE | --delete]');
        const del = flag(args, '--delete');
        const setFile = opt(args, '--file', undefined);
        const setText = opt(args, '--set', undefined);
        const memFile = args.shift();
        if (del) {
          if (!memFile) fail('specify memory file to delete');
          await call('DELETE', `/api/spaces/${encodeURIComponent(name)}/memory/${encodeURIComponent(memFile)}`);
          if (json) return console.log(JSON.stringify({ ok: true, name, file: memFile }, null, 2));
          return console.log(`deleted ${memFile}`);
        }
        if (setFile !== undefined || setText !== undefined) {
          if (!memFile) fail('specify memory file name (e.g. notes.md)');
          const text = setFile !== undefined ? readFileSync(setFile, 'utf8') : setText;
          const out = await call('PUT', `/api/spaces/${encodeURIComponent(name)}/memory/${encodeURIComponent(memFile)}`, { text });
          if (json) return console.log(JSON.stringify(out, null, 2));
          return console.log(`saved ${out.name} (${out.bytes} B)`);
        }
        const out = await call('GET', `/api/spaces/${encodeURIComponent(name)}/memory`);
        if (memFile) {
          const hit = (out.files ?? []).find((f) => f.name === memFile);
          if (!hit) fail(`no memory file "${memFile}" in "${name}"`);
          if (json) return console.log(JSON.stringify(hit, null, 2));
          return process.stdout.write(hit.text.endsWith('\n') ? hit.text : `${hit.text}\n`);
        }
        if (json) return console.log(JSON.stringify(out, null, 2));
        if (!out.files?.length) return console.log('no memory files');
        table([['FILE', 'SIZE', 'UPDATED'], ...out.files.map((f) => [f.name, fmtBytes(f.bytes), new Date(f.updatedAt * 1000).toLocaleString()])]);
        return;
      }
      if (sub === 'chief') {
        const spaceName = args.shift() || fail('usage: ah space chief <space> [--agent A] [--name N] [--adopt] [--global] [--mode M] [--model M] [--prompt "…"] [--json]');
        const agent = opt(args, '--agent', undefined);
        const label = opt(args, '--name', `Chief of Staff · ${spaceName}`);
        const adopt = flag(args, '--adopt');
        const globalScope = flag(args, '--global');
        const mode = opt(args, '--mode', undefined);
        const model = opt(args, '--model', undefined);
        const customPrompt = opt(args, '--prompt', undefined);
        const [spacesOut, st] = await Promise.all([call('GET', '/api/spaces'), call('GET', '/api/state')]);
        const sp = (spacesOut.spaces ?? []).find((s) => s.name === spaceName);
        if (!sp) fail(`no Space called "${spaceName}"`);
        const preset = agent
          ? (st.presets ?? []).find((p) => p.id === agent)
          : (st.presets ?? []).find((p) => p.available && p.command && p.id !== 'shell');
        if (!preset || !preset.command || preset.id === 'shell') {
          fail('no agent preset available for Chief of Staff (refusing to launch a plain shell; pass --agent <id>)');
        }
        const presetId = preset.id;
        const cwd = sp.path ? expandOnHost(sp.path, st.home) : st.home;
        const spaceWins = (st.windows ?? []).filter((w) => w.space === sp.name);
        const created = await call('POST', '/api/windows', {
          preset: presetId,
          cwd,
          label,
          worktree: false,
          space: sp.name,
          ...(mode ? { mode } : {}),
          ...(model ? { model } : {}),
          supervision: { role: 'chief', ...(!globalScope ? { space: sp.name } : {}) },
        });
        const adopted = [];
        const adoptFailed = [];
        if (adopt) {
          for (const w of spaceWins) {
            if (w.supervision?.role === 'chief' || w.supervision?.managedBy) continue;
            try {
              await call('PUT', `/api/sessions/${encodeURIComponent(w.uid)}/supervision`, { role: 'worker', managedBy: created.uid, muteAlerts: true }, { throwOnError: true });
              adopted.push(w.uid);
            } catch (err) {
              adoptFailed.push({ uid: w.uid, error: err.message });
            }
          }
        }
        let brief;
        try {
          const qs = customPrompt ? `?instructions=${encodeURIComponent(customPrompt)}` : '';
          const res = await call('GET', `/api/spaces/${encodeURIComponent(sp.name)}/brief${qs}`, undefined, { throwOnError: true });
          brief = res.brief;
        } catch {
          brief = buildChiefBrief({
            spaceName: sp.name,
            spacePath: cwd,
            spaceKind: sp.kind,
            contextDir: sp.contextPath ? expandOnHost(sp.contextPath, st.home) : cwd,
            sessions: spaceWins.map((w) => ({ uid: w.uid, title: w.title || w.name, agent: w.agent, status: w.status })),
            customInstructions: customPrompt,
          });
        }
        await call('POST', `/api/sessions/${encodeURIComponent(created.uid)}/send`, { text: brief, enter: true });
        if (json) return console.log(JSON.stringify({ ...created, space: sp.name, preset: presetId, adopted, adoptFailed }, null, 2));
        console.log(`${created.uid} ${created.id}  Chief of Staff for "${sp.name}" (${presetId})${adopted.length ? `  adopted ${adopted.length}` : ''}${adoptFailed.length ? `  (${adoptFailed.length} failed to adopt)` : ''}`);
        return;
      }
      if (sub === 'context') {
        const name = args.shift() || process.env.AH_SPACE || fail('usage: ah space context [space] [--json] (defaults to $AH_SPACE)');
        const out = await call('GET', `/api/spaces/${encodeURIComponent(name)}/context`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        return process.stdout.write(out.markdown.endsWith('\n') ? out.markdown : `${out.markdown}\n`);
      }
      if (sub === 'artifacts') {
        const action = args[0];
        if (action === 'add') {
          args.shift();
          const src = args.shift() || fail('usage: ah space artifacts add <file> [space] [--name <as>] [--json]');
          const asName = opt(args, '--name', undefined);
          const name = args.shift() || process.env.AH_SPACE || fail('specify a Space or run inside a Space session ($AH_SPACE)');
          const ctx = await call('GET', `/api/spaces/${encodeURIComponent(name)}/context`);
          const baseName = asName || src.split('/').pop();
          if (!baseName || baseName.includes('/') || baseName.includes('..') || baseName.startsWith('.')) {
            fail('invalid artifact filename');
          }
          const destDir = ctx.artifactsDir;
          await call('POST', '/api/fs/mkdir', { path: destDir }, { throwOnError: true }).catch(() => {});
          const dest = `${destDir.replace(/\/+$/, '')}/${baseName}`;
          const content = readFileSync(src);
          const u = new URL(apiPath('/api/fs/upload'), BASE);
          u.searchParams.set('dir', destDir);
          u.searchParams.set('name', baseName);
          const selfUid = currentSessionUid();
          const selfToken = currentSessionToken();
          const upRes = await fetch(u, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${localToken()}`,
              'x-ah': '1',
              origin: BASE,
              ...(selfUid ? { 'x-ah-session': selfUid } : {}),
              ...(selfToken ? { 'x-ah-session-token': selfToken } : {}),
              'content-type': 'application/octet-stream',
              'content-length': String(content.length),
            },
            body: content,
          });
          if (!upRes.ok) fail(`upload failed (${upRes.status}): ${await upRes.text()}`);
          // Refresh Space context snapshot so the new artifact appears immediately.
          const refreshed = await call('GET', `/api/spaces/${encodeURIComponent(name)}/context`).catch(() => null);
          const item = refreshed?.artifacts?.find((a) => a.name === baseName) ?? { name: baseName, path: dest, bytes: content.length };
          if (json) return console.log(JSON.stringify(item, null, 2));
          console.log(`artifact saved → ${item.path} (${item.bytes} B)`);
          return;
        }
        const name = args.shift() || process.env.AH_SPACE || fail('usage: ah space artifacts [space] [--json] | ah space artifacts add <file> [space] [--name N]');
        const ctx = await call('GET', `/api/spaces/${encodeURIComponent(name)}/context`);
        if (json) return console.log(JSON.stringify({ space: ctx.space, artifactsDir: ctx.artifactsDir, artifacts: ctx.artifacts }, null, 2));
        if (!ctx.artifacts.length) return console.log(`no artifacts in ${ctx.space} (${ctx.artifactsDir})`);
        table([
          ['FILE', 'BYTES', 'PATH'],
          ...ctx.artifacts.map((a) => [a.name, String(a.bytes), a.path]),
        ]);
        return;
      }
      if (sub === 'move') {
        const target = args.shift();
        const clear = flag(args, '--clear');
        const none = flag(args, '--none');
        const spaceArg = clear ? null : none ? '' : args.shift();
        if (!target || (!clear && !none && !spaceArg)) fail("usage: ah space move <target> <space|--none|--clear> [--json]  (--none: in no Space; --clear: its project's Space)");
        const { live } = await find(target);
        const out = await call('PUT', `/api/sessions/${encodeURIComponent(live.uid)}/space`, { space: spaceArg });
        if (json) return console.log(JSON.stringify(out, null, 2));
        console.log(`${out.uid}  space=${out.space ?? '(none)'}`);
        return;
      }
      if (sub === 'projects') {
        const name = args.shift() || fail('usage: ah space projects <space> [add|remove <folder>…] [--json]');
        const op = args[0] === 'add' || args[0] === 'remove' ? args.shift() : null;
        const st = op ? await call('GET', '/api/state') : null;
        const sp = ((await call('GET', '/api/spaces')).spaces ?? []).find((s) => s.name === name);
        if (!sp) fail(`no Space called "${name}"`);
        let projects = sp.projects ?? [];
        if (op) {
          if (!args.length) fail(`usage: ah space projects <space> ${op} <folder>…`);
          const given = args.map((p) => (p.startsWith('/') || p.startsWith('~') ? p : resolve(p)));
          const home = st?.home ?? '';
          const short = (p) => (home && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p);
          const norm = given.map(short);
          projects = op === 'add' ? [...projects, ...norm] : projects.filter((p) => !norm.includes(p) && !given.includes(p));
          const out = await call('PUT', `/api/spaces/${encodeURIComponent(name)}/projects`, { projects });
          projects = out.space.projects ?? [];
          if (json) return console.log(JSON.stringify(out, null, 2));
        } else if (json) return console.log(JSON.stringify({ space: name, projects }, null, 2));
        if (!projects.length) return console.log(`no projects attached to "${name}" (sessions join it when started in one, or with: ah space move)`);
        for (const p of projects) console.log(p);
        return;
      }
      if (sub === 'promote') {
        const name = args.shift() || fail('usage: ah space promote <space> --title <T> [--file F] [--source S] [<markdown> | --text T | --from FILE]');
        const title = opt(args, '--title', undefined) || fail('--title is required');
        const file = opt(args, '--file', undefined);
        const source = opt(args, '--source', 'cli');
        const fromFile = opt(args, '--from', undefined);
        let markdown = fromFile ? readFileSync(fromFile, 'utf8') : opt(args, '--text', undefined);
        if (markdown === undefined) {
          const rest = args.join(' ');
          markdown = rest === '-' || (!rest && !process.stdin.isTTY) ? readFileSync(0, 'utf8') : rest;
        }
        if (!markdown?.trim()) fail('provide knowledge text, --text, --from, or stdin');
        const out = await call('POST', `/api/spaces/${encodeURIComponent(name)}/knowledge/promote`, { title, markdown, ...(file ? { file } : {}), source });
        if (json) return console.log(JSON.stringify(out, null, 2));
        console.log(`promoted → ${name}/memory/${out.file.name} (indexed in MEMORY.md)`);
        return;
      }
      fail('usage: ah space new|chief|context|artifacts|move|promote|remove|restore|prefs|memory …');
      return;
    }
    case 'notes': {
      const json = flag(args, '--json');
      const spaceFilter = opt(args, '--space', undefined);
      const [out, st] = await Promise.all([call('GET', '/api/notes?since=0'), spaceFilter ? call('GET', '/api/state') : Promise.resolve(null)]);
      let live = (out.notes ?? []).filter((n) => !n.deleted);
      if (spaceFilter) {
        const spacesOut = await call('GET', '/api/spaces').catch(() => ({ spaces: [] }));
        const allSpaces = spacesOut.spaces ?? [];
        const sp = allSpaces.find((s) => s.name === spaceFilter);
        const explicitPath = spaceFilter.startsWith('/') || spaceFilter.startsWith('~') || spaceFilter.startsWith('.');
        if (!sp && !explicitPath) {
          const names = allSpaces.map((s) => s.name).filter((n) => n.toLowerCase().includes(spaceFilter.toLowerCase()));
          fail(`no Space called "${spaceFilter}"${names.length ? ` (did you mean: ${names.join(', ')}?)` : ''}`);
        }
        const wantPath = sp?.path ? expandOnHost(sp.path, st?.home) : expandOnHost(spaceFilter, st?.home);
        live = live.filter(
          (n) =>
            (!st?.hostname || !n.project?.host || n.project.host === st.hostname) &&
            n.project?.path &&
            n.project.path.replace(/\/+$/, '') === wantPath.replace(/\/+$/, ''),
        );
      }
      if (json) return console.log(JSON.stringify(live, null, 2));
      if (!live.length) return console.log('no notes');
      table([
        ['ID', 'REV', 'TITLE', 'SPACE', 'UPDATED'],
        ...live.map((n) => [n.id, n.revision, n.title || '(untitled)', n.project?.path ?? '', new Date(n.updatedAt * 1000).toLocaleString()]),
      ]);
      return;
    }
    case 'note': {
      const json = flag(args, '--json');
      const sub = args.shift();
      if (sub === 'show') {
        const id = args[0] || fail('usage: ah note show <id>');
        const n = await call('GET', `/api/notes/${encodeURIComponent(id)}`);
        if (json) return console.log(JSON.stringify(n, null, 2));
        console.log(`# ${n.title || '(untitled)'}  (rev ${n.revision})\n`);
        return process.stdout.write(n.markdown.endsWith('\n') ? n.markdown : `${n.markdown}\n`);
      }
      if (sub === 'new') {
        const title = opt(args, '--title', '') ?? '';
        const file = opt(args, '--file', undefined);
        const spaceInput = opt(args, '--space', undefined);
        let markdown = file ? readFileSync(file, 'utf8') : opt(args, '--text', undefined);
        if (markdown === undefined) {
          const rest = args.join(' ');
          markdown = rest === '-' || (!rest && !process.stdin.isTTY) ? readFileSync(0, 'utf8') : rest;
        }
        const id = randomUUID();
        let project = null;
        if (spaceInput) {
          const [st, spacesOut] = await Promise.all([call('GET', '/api/state'), call('GET', '/api/spaces').catch(() => ({ spaces: [] }))]);
          const allSpaces = spacesOut.spaces ?? [];
          const sp = allSpaces.find((s) => s.name === spaceInput);
          const explicitPath = spaceInput.startsWith('/') || spaceInput.startsWith('~') || spaceInput.startsWith('.');
          if (!sp && !explicitPath) {
            const names = allSpaces.map((s) => s.name).filter((n) => n.toLowerCase().includes(spaceInput.toLowerCase()));
            fail(`no Space called "${spaceInput}"${names.length ? ` (did you mean: ${names.join(', ')}?)` : ''}`);
          }
          const abs = sp?.path ? expandOnHost(sp.path, st.home) : expandOnHost(spaceInput, st.home);
          project = { host: st.hostname, path: abs };
        }
        const note = await call('PUT', `/api/notes/${id}`, {
          baseRevision: 0,
          writeId: `cli-${randomBytes(6).toString('hex')}`,
          title,
          markdown: markdown ?? '',
          project,
        });
        if (json) return console.log(JSON.stringify(note, null, 2));
        return console.log(`${note.id}  rev ${note.revision}  ${note.title || '(untitled)'}`);
      }
      if (sub === 'edit') {
        const id = args.shift() || fail('usage: ah note edit <id> [--title "…"] [--text "…" | --file FILE]');
        const cur = await call('GET', `/api/notes/${encodeURIComponent(id)}`);
        const title = opt(args, '--title', cur.title);
        const file = opt(args, '--file', undefined);
        let markdown = file ? readFileSync(file, 'utf8') : opt(args, '--text', undefined);
        if (markdown === undefined) {
          const rest = args.join(' ');
          markdown = rest === '-' ? readFileSync(0, 'utf8') : rest || cur.markdown;
        }
        const note = await call('PUT', `/api/notes/${encodeURIComponent(id)}`, {
          baseRevision: cur.revision,
          writeId: `cli-${randomBytes(6).toString('hex')}`,
          title,
          markdown,
          project: cur.project ?? null,
        });
        if (json) return console.log(JSON.stringify(note, null, 2));
        return console.log(`${note.id}  rev ${note.revision}`);
      }
      if (sub === 'handoff') {
        const id = args.shift();
        const target = args.shift();
        if (!id || !target) fail('usage: ah note handoff <note-id> <target>');
        const [note, found] = await Promise.all([call('GET', `/api/notes/${encodeURIComponent(id)}`), find(target, { history: true })]);
        const ref = found.live?.uid ?? found.past.ref;
        const out = await call('POST', '/api/notes/handoffs', {
          id: `cli-${randomBytes(6).toString('hex')}`,
          noteId: note.id,
          revision: note.revision,
          target: ref,
          text: note.markdown,
        });
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`handed off (${out.outcome}) → ${ref}`);
      }
      if (sub === 'export') {
        const id = args.shift();
        const dir = opt(args, '--dir', undefined);
        const rel = opt(args, '--path', undefined);
        const replace = flag(args, '--replace');
        if (!id || !dir || !rel) fail('usage: ah note export <note-id> --dir DIR --path REL [--replace]');
        const note = await call('GET', `/api/notes/${encodeURIComponent(id)}`);
        const out = await call('POST', '/api/notes/export', { dir: resolve(dir), path: rel, markdown: note.markdown, replace, noteId: note.id, revision: note.revision });
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`exported → ${out.path} (${out.bytes} B)`);
      }
      if (sub === 'delete') {
        const id = args[0] || fail('usage: ah note delete <id>');
        const cur = await call('GET', `/api/notes/${encodeURIComponent(id)}`);
        const out = await call('DELETE', `/api/notes/${encodeURIComponent(id)}?baseRevision=${cur.revision}&writeId=cli-${randomBytes(6).toString('hex')}`);
        if (json) return console.log(JSON.stringify(out, null, 2));
        return console.log(`deleted ${id}`);
      }
      fail('usage: ah note show|new|edit|handoff|export|delete …');
      return;
    }
    case 'search': {
      const json = flag(args, '--json');
      const all = flag(args, '--all');
      const host = opt(args, '--host', undefined);
      const space = opt(args, '--space', undefined);
      const role = opt(args, '--role', undefined);
      const scope = opt(args, '--in', undefined);
      const lineage = opt(args, '--lineage', undefined);
      const limit = opt(args, '-n', '20');
      const q = args.join(' ').trim();
      if (!q) fail('usage: ah search <query> [--all] [--host H] [--space P] [--role R] [--in transcripts|chats] [--lineage REF] [-n N] [--json]');
      const qs = new URLSearchParams({
        q,
        limit: String(limit),
        ...(host ? { h: host } : {}),
        ...(space ? { p: space } : {}),
        ...(role ? { role } : {}),
        ...(scope ? { in: scope } : {}),
        ...(lineage ? { lineage } : {}),
      });
      const out = await call('GET', `${all ? '/api/search/all' : '/api/search'}?${qs.toString()}`);
      if (json) return console.log(JSON.stringify(out, null, 2));
      if (!out.results?.length) return console.log('no matches');
      for (const r of out.results) {
        console.log(`${r.ref ?? r.uid ?? ''}${r.host ? ` @${r.host}` : ''}  ${r.title || '(untitled)'}  [${r.project ?? ''}]`);
        for (const h of (r.hits ?? []).slice(0, 2)) console.log(`  ${h.role}: ${String(h.snippet ?? '').replace(/\s+/g, ' ').slice(0, 140)}`);
      }
      return;
    }
    case 'supervise': {
      const json = flag(args, '--json');
      const role = opt(args, '--role', undefined);
      const managedByRaw = opt(args, '--managed-by', undefined);
      const spaceVal = opt(args, '--space', undefined);
      const mute = flag(args, '--mute');
      const unmute = flag(args, '--unmute');
      const escalateRaw = opt(args, '--escalate-after', undefined);
      const clearTags = flag(args, '--clear-tags');
      const tags = opts(args, '--tag');
      const found = await find(args[0], { history: true });
      const uid = found.live?.uid ?? found.past.ref;
      const patch = {};
      if (role !== undefined) patch.role = role === 'none' ? null : role;
      if (managedByRaw !== undefined) patch.managedBy = managedByRaw === 'none' ? null : (await find(managedByRaw)).live.uid;
      if (spaceVal !== undefined) patch.space = spaceVal === 'none' ? null : spaceVal;
      if (mute) patch.muteAlerts = true;
      if (unmute) patch.muteAlerts = false;
      if (escalateRaw !== undefined) {
        const secs = parseDuration(escalateRaw);
        if (!secs) fail('--escalate-after takes e.g. 60s, 2m, 5m');
        patch.escalateAfterSeconds = secs;
      }
      if (clearTags) patch.tags = [];
      else if (tags.length) patch.tags = tags;
      const out = await call('PUT', `/api/sessions/${encodeURIComponent(uid)}/supervision`, patch);
      if (json) return console.log(JSON.stringify(out, null, 2));
      console.log(`${out.uid}  supervision: ${out.supervision ? JSON.stringify(out.supervision) : 'cleared'}`);
      return;
    }
    case 'audit': {
      const json = flag(args, '--json');
      const sessionRaw = opt(args, '--session', undefined);
      const event = opt(args, '--event', undefined);
      const limit = opt(args, '-n', '50');
      const session = sessionRaw ? (await find(sessionRaw, { history: true }).then((f) => f.live?.uid ?? f.past.ref).catch(() => sessionRaw)) : undefined;
      const qs = new URLSearchParams({ limit: String(limit), ...(session ? { session } : {}), ...(event ? { event } : {}) });
      const out = await call('GET', `/api/system/audit?${qs.toString()}`);
      if (json) return console.log(JSON.stringify(out.entries, null, 2));
      if (!out.entries?.length) return console.log('no audit entries');
      table([
        ['TIME', 'EVENT', 'ACTOR', 'TARGET', 'DETAIL'],
        ...out.entries.map((e) => [
          e.at ? new Date(e.at).toLocaleTimeString() : '',
          e.event ?? '',
          e.actorUid ?? e.from ?? '',
          e.uid ?? e.ref ?? e.to ?? e.id ?? '',
          Object.entries(e)
            .filter(([k]) => !['at', 'event', 'actorUid', 'from', 'uid', 'ref', 'to', 'id'].includes(k))
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
            .slice(0, 60),
        ]),
      ]);
      return;
    }
    case 'mail': {
      const json = flag(args, '--json');
      const sub = args.shift();
      if (sub === 'send') {
        const subject = opt(args, '--subject', '') ?? '';
        const kind = opt(args, '--kind', 'message');
        const threadId = opt(args, '--thread', undefined);
        const wake = flag(args, '--wake');
        const rawTo = args.shift();
        if (!rawTo) fail('usage: ah mail send <target|siblings|*> <body…|-> [--subject "…"] [--kind K] [--thread ID] [--wake]');
        const toUid = rawTo === '*' || rawTo === 'siblings' || rawTo.startsWith('siblings:') ? rawTo : await resolveRef(rawTo);
        let body = args.join(' ');
        if (body === '-' || (!body && !process.stdin.isTTY)) body = readFileSync(0, 'utf8').replace(/\n$/, '');
        if (!body) fail('nothing to send');
        const msg = await call('POST', '/api/fleet/mailbox', {
          toUid,
          kind,
          subject,
          body,
          ...(threadId ? { threadId } : {}),
          ...(wake ? { wake: true } : {}),
        });
        if (json) return console.log(JSON.stringify(msg, null, 2));
        return console.log(`${msg.id}  → ${msg.toUid}  [${msg.kind}]${msg.subject ? `  ${msg.subject}` : ''}`);
      }
      if (sub === 'broadcast') {
        const fleet = flag(args, '--fleet');
        const subject = opt(args, '--subject', '') ?? '';
        const kind = opt(args, '--kind', 'message');
        const threadId = opt(args, '--thread', undefined);
        let body = args.join(' ');
        if (body === '-' || (!body && !process.stdin.isTTY)) body = readFileSync(0, 'utf8').replace(/\n$/, '');
        if (!body) fail('usage: ah mail broadcast <body…|-> [--fleet] [--subject "…"] [--kind message|report|blocker|handoff] [--thread ID]');
        const msg = await call('POST', '/api/fleet/mailbox', {
          toUid: fleet ? '*' : 'siblings',
          kind,
          subject,
          body,
          ...(threadId ? { threadId } : {}),
        });
        if (json) return console.log(JSON.stringify(msg, null, 2));
        return console.log(`${msg.id}  → ${msg.toUid}  [${msg.kind}]${msg.subject ? `  ${msg.subject}` : ''}`);
      }
      if (sub === 'inbox' || !sub) {
        const showAll = flag(args, '--all');
        const thread = opt(args, '--thread', undefined);
        const limit = opt(args, '-n', '50');
        const rawTarget = args[0] ?? 'self';
        const toUid = rawTarget === '*' ? '*' : await resolveRef(rawTarget);
        const qs = new URLSearchParams({
          ...(toUid !== '*' ? { to: toUid } : {}),
          ...(!showAll ? { unread: '1' } : {}),
          ...(thread ? { thread } : {}),
          limit: String(limit),
        });
        const { messages } = await call('GET', `/api/fleet/mailbox?${qs.toString()}`);
        if (json) return console.log(JSON.stringify(messages, null, 2));
        if (!messages.length) return console.log('inbox empty');
        table([
          ['ID', 'KIND', 'FROM', 'SUBJECT', 'BODY'],
          ...messages.map((m) => [m.id, m.kind, m.fromUid ?? 'user', m.subject, m.body.split('\n')[0].slice(0, 70)]),
        ]);
        return;
      }
      if (sub === 'show') {
        const id = args[0] || fail('usage: ah mail show <id>');
        const m = await call('GET', `/api/fleet/mailbox/${encodeURIComponent(id)}`);
        if (json) return console.log(JSON.stringify(m, null, 2));
        console.log(`${m.id}  [${m.kind}]  from=${m.fromUid ?? 'user'}  to=${m.toUid}${m.subject ? `  subject=${m.subject}` : ''}${m.ackedAt ? '  (acked)' : ''}`);
        console.log(m.body);
        return;
      }
      if (sub === 'ack') {
        const id = args[0] || fail('usage: ah mail ack <id>');
        const m = await call('POST', `/api/fleet/mailbox/${encodeURIComponent(id)}/ack`);
        if (json) return console.log(JSON.stringify(m, null, 2));
        return console.log(`acked ${m.id}`);
      }
      if (sub === 'delete') {
        const id = args[0] || fail('usage: ah mail delete <id>');
        await call('DELETE', `/api/fleet/mailbox/${encodeURIComponent(id)}`);
        if (json) return console.log(JSON.stringify({ ok: true, id }, null, 2));
        return console.log(`deleted ${id}`);
      }
      fail('usage: ah mail send|broadcast|inbox|show|ack|delete …');
      return;
    }
    case 'tasks': {
      const json = flag(args, '--json');
      const statusFilter = opt(args, '--status', undefined);
      const assignedRaw = opt(args, '--assigned', undefined);
      const ownerRaw = opt(args, '--owner', undefined);
      const space = opt(args, '--space', undefined);
      const assigned = assignedRaw ? await resolveRef(assignedRaw) : undefined;
      const owner = ownerRaw ? await resolveRef(ownerRaw) : undefined;
      const qs = new URLSearchParams({
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(assigned ? { assigned } : {}),
        ...(owner ? { owner } : {}),
        ...(space ? { space } : {}),
      });
      const { tasks } = await call('GET', `/api/fleet/tasks?${qs.toString()}`);
      if (json) return console.log(JSON.stringify(tasks, null, 2));
      if (!tasks.length) return console.log('no tasks');
      table([
        ['ID', 'P', 'STATUS', 'ASSIGNED', 'SPACE', 'VERIFY', 'TITLE'],
        ...tasks.map((t) => [
          t.id,
          `P${t.priority}`,
          t.status,
          t.assignedUid ?? '—',
          t.space ?? '',
          t.lastVerify ? (t.lastVerify.ok ? '✓' : `✗(${t.lastVerify.exitCode})`) : '',
          t.title,
        ]),
      ]);
      return;
    }
    case 'task': {
      const json = flag(args, '--json');
      const sub = args.shift();
      if (sub === 'add') {
        const description = opt(args, '--desc', '') ?? '';
        const assignRaw = opt(args, '--assign', undefined);
        const ownerRaw = opt(args, '--owner', undefined);
        const space = opt(args, '--space', undefined);
        const checkoutId = opt(args, '--checkout', undefined);
        const priority = opt(args, '--priority', undefined);
        const dependsRaw = opt(args, '--depends', undefined);
        const verifyCmd = opt(args, '--verify', undefined);
        const title = args.join(' ').trim();
        if (!title) fail('usage: ah task add <title> [--desc "…"] [--assign TARGET] [--space P] [--priority 0-3] [--depends ID,ID] [--verify "CMD"]');
        const assignedUid = assignRaw ? await resolveRef(assignRaw) : undefined;
        const ownerUid = ownerRaw ? await resolveRef(ownerRaw) : undefined;
        const dependsOn = dependsRaw ? dependsRaw.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const t = await call('POST', '/api/fleet/tasks', {
          title,
          description,
          ...(assignedUid ? { assignedUid } : {}),
          ...(ownerUid ? { ownerUid } : {}),
          ...(space ? { space } : {}),
          ...(checkoutId ? { checkoutId } : {}),
          ...(priority !== undefined ? { priority: Number(priority) } : {}),
          ...(dependsOn ? { dependsOn } : {}),
          ...(verifyCmd ? { verifyCmd } : {}),
        });
        if (json) return console.log(JSON.stringify(t, null, 2));
        return console.log(`${t.id}  P${t.priority}  ${t.status}  ${t.title}`);
      }
      if (sub === 'show') {
        const id = args[0] || fail('usage: ah task show <id>');
        const t = await call('GET', `/api/fleet/tasks/${encodeURIComponent(id)}`);
        if (json) return console.log(JSON.stringify(t, null, 2));
        console.log(`${t.id}  P${t.priority}  [${t.status}]  ${t.title}`);
        if (t.description) console.log(t.description);
        console.log(`Owner: ${t.ownerUid ?? '—'}  Assigned: ${t.assignedUid ?? '—'}  Space: ${t.space ?? '—'}`);
        if (t.dependsOn?.length) console.log(`Depends on: ${t.dependsOn.join(', ')}`);
        if (t.verifyCmd) console.log(`Verify: ${t.verifyCmd}${t.lastVerify ? ` → ${t.lastVerify.ok ? 'PASS' : `FAIL (${t.lastVerify.exitCode})`}` : ''}`);
        if (t.result) console.log(`Result: ${t.result}`);
        return;
      }
      if (sub === 'update') {
        const id = args.shift() || fail('usage: ah task update <id> [--status S] [--assign TARGET|none] [--priority 0-3] [--result "…"] [--verify "CMD"]');
        const statusVal = opt(args, '--status', undefined);
        const assignRaw = opt(args, '--assign', undefined);
        const title = opt(args, '--title', undefined);
        const description = opt(args, '--desc', undefined);
        const priority = opt(args, '--priority', undefined);
        const result = opt(args, '--result', undefined);
        const verifyCmd = opt(args, '--verify', undefined);
        const patch = {};
        if (statusVal !== undefined) patch.status = statusVal;
        if (assignRaw !== undefined) patch.assignedUid = assignRaw === 'none' ? null : await resolveRef(assignRaw);
        if (title !== undefined) patch.title = title;
        if (description !== undefined) patch.description = description;
        if (priority !== undefined) patch.priority = Number(priority);
        if (result !== undefined) patch.result = result;
        if (verifyCmd !== undefined) patch.verifyCmd = verifyCmd;
        const t = await call('PATCH', `/api/fleet/tasks/${encodeURIComponent(id)}`, patch);
        if (json) return console.log(JSON.stringify(t, null, 2));
        return console.log(`${t.id}  [${t.status}]  ${t.title}`);
      }
      if (sub === 'delete') {
        const id = args[0] || fail('usage: ah task delete <id>');
        await call('DELETE', `/api/fleet/tasks/${encodeURIComponent(id)}`);
        if (json) return console.log(JSON.stringify({ ok: true, id }, null, 2));
        return console.log(`deleted ${id}`);
      }
      fail('usage: ah task add|show|update|delete …');
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
