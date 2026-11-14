// Client commands: a thin view over the local daemon's HTTP API (F5), also usable by
// agents to drive other agents (F37):  ah send reviewer "check this diff" && ah wait reviewer && ah read reviewer
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { statusWord } from '../web/status.ts';

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
  open [id|name]                              open this tmux window (or that session) in ah's window
  setup tailscale [--off]                     expose ah on your tailnet via \`tailscale serve\` (once)
  setup desktop [--off]                       add ah to the app launcher, in its own window (Omarchy web app)
  list [--json]                               live sessions
  history [--json]                            ended and saved conversations
  new <harness> [--cwd DIR] [--name N] [--session S] [--continue] [--mode M] [--model M] [--args "EXTRA"]
  attach <target>                             open a session in this terminal
  send <target> <text…|->  [--no-enter]       type in now, queue if busy, resume if dead
  read <target> [-n LINES]                    print the session's screen + scrollback
  wait <target> [--timeout SECS]              block until the agent stops working
  resume <target>                             bring an ended/saved conversation back
  fork <target> [--name N] [--prompt "TEXT"]  copy the conversation into a new worktree session
  continue <target> --in AGENT [--fork] [--worktree] [--name N] [--preview] [--json]
                                              carry the conversation into another agent (keeps lineage)
  portable <target> [--out FILE]              the conversation as a portable document (JSON)
  lineage <target> [--json]                   where the conversation came from and what came from it
  move <target> --to HOST [--cwd DIR] [--preview] [--yes] [--json]
                                              move a stopped session to another host (it resumes there)
  migrations [--json] | migrations retry|cancel <id>
                                              moves between hosts and how far they got
  answer <target> <yes|no|N>                  answer what it's asking: approve, deny, or pick option N
  stop <target>                               stop the agent's current turn
  terminate <target>                          end the session (its conversation stays in history); also: kill
  rename <target> <name…>                     rename the session
  pin <target> [--off]                        pin the session to the top of its group (or unpin)
  queue <target> [--clear]                    show or drop queued messages
  worktrees [--json] [--orphans]              managed worktrees, with on-disk sizes
  worktrees clean --orphans [--force-dirty] [--yes]
                                              remove orphaned worktrees (dry run unless --yes)
  snapshots <target>                          list per-turn file snapshots
  rollback <target> --to TURN [--interrupt]   restore files to before TURN (takes a safety snapshot first)
  hooks install|uninstall|status              wire Claude Code / Codex status hooks
  auth code                                   one-time code to set up a new device (10 min)
  auth password [--remove]                    set the optional master password
  auth token <name>                           token for another host to proxy this one
  auth status                                 passkeys, signed-in devices, recent activity
  peers trust <peer> <token>                  use a token issued by <peer> (on the hub)

<target> is a session id, a window id (@12), a title or name, or the start of one.`;

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
  switch (cmd) {
    case 'list': {
      const { windows } = await call('GET', '/api/state');
      if (flag(args, '--json')) return console.log(JSON.stringify(windows, null, 2));
      if (!windows.length) return console.log('nothing running');
      table([
        ['ID', 'WINDOW', 'TITLE', 'AGENT', 'STATUS', 'PROJECT', 'QUEUED'],
        ...windows.map((w) => [w.uid, `${w.session}:${w.index}`, w.title || w.name, w.agent ?? w.command, status(w), w.project, w.queued || '']),
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
        mode: opt(args, '--mode', undefined),
        model: opt(args, '--model', undefined),
        extraArgs: opt(args, '--args', undefined),
      };
      for (const k of ['mode', 'model', 'extraArgs']) if (body[k] === undefined) delete body[k];
      const out = await call('POST', '/api/windows', body);
      console.log(`${out.uid} ${out.id}`);
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
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/resume`);
      console.log(`${out.uid} ${out.id}${out.resumed ? ' (resumed)' : ' (already running)'}`);
      return;
    }
    case 'fork': {
      const name = opt(args, '--name', undefined);
      const prompt = opt(args, '--prompt', undefined);
      const found = await find(args[0], { history: true });
      const ref = found.live?.uid ?? found.past.ref;
      const body = {};
      if (name !== undefined) body.name = name;
      if (prompt !== undefined) body.prompt = prompt;
      const out = await call('POST', `/api/sessions/${encodeURIComponent(ref)}/fork`, body);
      console.log(`${out.uid} ${out.id}  ${out.branch}  ${out.worktree}`);
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
      process.stdout.write(await call('GET', `/api/sessions/${encodeURIComponent(live.uid)}/capture?lines=${lines}`));
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
    case 'answer': {
      const { live } = await find(args[0]);
      const choice = (args[1] ?? '').toLowerCase();
      if (!choice) fail('usage: ah answer <target> <yes|no|N>');
      if (live.status !== 'waiting') fail(`"${live.title || live.name}" isn't waiting for an answer`);
      const uid = encodeURIComponent(live.uid);
      if (/^\d+$/.test(choice)) {
        const picked = await call('POST', `/api/sessions/${uid}/choose`, { key: choice });
        console.log(`answered: ${picked.label ?? choice}`);
      } else if (['yes', 'y', 'approve'].includes(choice) || ['no', 'n', 'deny'].includes(choice)) {
        const answer = ['no', 'n', 'deny'].includes(choice) ? 'deny' : 'approve';
        await call('POST', `/api/sessions/${uid}/answer`, { answer });
        console.log(answer === 'approve' ? 'approved' : 'denied');
      } else fail(`"${choice}" isn't an answer: use yes, no, or an option number`);
      return;
    }
    case 'stop': {
      const { live } = await find(args[0]);
      await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/interrupt`);
      console.log('stopped');
      return;
    }
    case 'kill':
    case 'terminate': {
      const { live } = await find(args[0]);
      await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/terminate`);
      console.log(`terminated "${live.title || live.name}"; \`ah resume ${live.uid}\` brings it back`);
      return;
    }
    case 'rename': {
      const { live } = await find(args[0]);
      const name = args.slice(1).join(' ').trim();
      if (!name) fail('usage: ah rename <target> <name…>');
      await call('PUT', `/api/sessions/${encodeURIComponent(live.uid)}/name`, { name });
      console.log(`renamed to "${name}"`);
      return;
    }
    case 'pin': {
      const off = flag(args, '--off');
      const { live } = await find(args[0]);
      await call('POST', `/api/sessions/${encodeURIComponent(live.uid)}/pin`, { pinned: !off });
      console.log(off ? 'unpinned' : 'pinned');
      return;
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
