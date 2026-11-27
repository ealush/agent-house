// Thin wrapper over the tmux CLI. tmux is the source of truth for every
// process and for our metadata (stored as @ah-* user options on windows), so
// the app can crash or restart without losing anything.
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { imagePieces } from './imagePaths.ts';

const run = promisify(execFile);
const SEP = '\x1f';

/**
 * Splits one line of `-F` output. tmux ≥ 3.5 prints the separator raw (with `-u`,
 * whatever the locale); older releases (3.4, as shipped by Ubuntu LTS) escape
 * control characters in output, so it arrives as the four characters "\037". Values
 * are escaped the same way, so splitting on the escaped form is unambiguous there too.
 */
export function fields(line: string): string[] {
  return line.includes(SEP) ? line.split(SEP) : line.split('\\037');
}

export const VIEWER_PREFIX = 'ah-v-';
/** Private shells owned by a registry uid, never registered as sessions themselves. */
export const TERMINAL_PREFIX = 'ah-terminal-';

export async function tmux(...args: string[]): Promise<string> {
  // Bounded: a wedged tmux server would otherwise hang the tick (and every caller
  // waiting on it) forever instead of failing one pass. `-u`: without a UTF-8 locale
  // (ah started over ssh or by launchd on a Mac, LANG unset) tmux prints every
  // control character and non-ASCII letter of its output as "_", the field
  // separator and window names included, and no window would read.
  const { stdout } = await run('tmux', ['-u', ...args], { env: cleanEnv(), maxBuffer: 16 * 1024 * 1024, timeout: 15_000 });
  return stdout;
}

// Strip TMUX so we never talk to tmux as if nested inside the server's own pane.
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.TMUX;
  delete env.TMUX_PANE;
  // A TMUX_TMPDIR that no longer exists makes tmux fall back to the default socket in
  // /tmp: the real server of whoever runs this, with every session in it. Refuse instead.
  // (On 2026-11-19 a test whose temporary TMUX_TMPDIR was removed before its own
  // `kill-server` killed the developer's tmux server four times.)
  if (env.TMUX_TMPDIR && !existsSync(env.TMUX_TMPDIR)) throw new Error(`TMUX_TMPDIR ${env.TMUX_TMPDIR} is gone: refusing to fall back to the default tmux server`);
  return env;
}

export type RawWindow = {
  session: string;
  sessionId: string;
  windowId: string;
  index: number;
  name: string;
  active: boolean;
  activity: number;
  bell: boolean;
  panePid: number;
  command: string;
  path: string;
  title: string;
  panes: number;
  agentTag: string;
  seen: number;
  createdAt: number;
  /** Registry id, assigned the first time we see an agent in this window. */
  uid: string;
  /** Written by agent hooks (see bin/ah-hook.js). */
  hookState: string;
  hookAt: number;
  harness: string;
  harnessId: string;
  model: string;
  /** JSON from hooks: what the agent is doing / what it's blocked on. */
  hookDetail: string;
  hookAsk: string;
};

const WINDOW_FIELDS = [
  'session_name',
  'session_id',
  'window_id',
  'window_index',
  'window_name',
  'window_active',
  'window_activity',
  'window_bell_flag',
  'pane_pid',
  'pane_current_command',
  'pane_current_path',
  'pane_title',
  'window_panes',
  '@ah-agent',
  '@ah-seen',
  '@ah-created',
  '@ah-uid',
  '@ah-state',
  '@ah-state-at',
  '@ah-harness',
  '@ah-harness-id',
  '@ah-model',
  '@ah-detail',
  '@ah-ask',
  // The server's own pid (any row says it): a new one means the old server died.
  'pid',
];

/**
 * The tmux server as ah last listed it (server/interruptions.ts). `gone`: no server
 * answered; `pid` 0 when never seen. An empty server still has a pid.
 */
export type ServerSeen = { pid: number; gone: boolean; empty: boolean };
let server: ServerSeen = { pid: 0, gone: false, empty: false };
export const serverSeen = (): ServerSeen => ({ ...server });
/** The pid of the last server that answered on ah's socket (0 for none yet). */
let lastPid = 0;
/** The server an earlier ah saw (tmux-server.json), until one answers this run. */
let rememberedPid = 0;

/**
 * At ah's start: the server the previous ah saw answer (server/interruptions.ts keeps it).
 * If its socket was deleted while ah was down, it's still the one to ask back, not replace.
 */
export function rememberServer(pid: number): void {
  if (pid > 0 && !lastPid) rememberedPid = pid;
}

/**
 * A pane's folder as a path. Linux reads it from /proc, which names a folder that was
 * deleted under the shell "<path> (deleted)": that's still where the pane is, not a
 * folder of its own, so it never becomes a project called "ah-native (deleted)".
 */
export function livePath(path: string): string {
  return path.endsWith(' (deleted)') ? path.slice(0, -' (deleted)'.length) : path;
}

export async function listWindows(): Promise<RawWindow[]> {
  let out: string;
  try {
    // list-windows reports the active pane's fields for pane_* formats.
    out = await tmux('list-windows', '-a', '-F', WINDOW_FIELDS.map((f) => `#{${f}}`).join(SEP));
  } catch (err) {
    if (!isNoServer(err)) throw err;
    if (!/no current target/.test(String((err as { stderr?: string }).stderr ?? err))) server = { pid: 0, gone: true, empty: false };
    else if (!server.empty || !server.pid) {
      // Alive but empty: its pid once (it may be a new server), then while it stays empty, as is.
      const pid = Number((await tmux('display-message', '-p', '#{pid}').catch(() => '')).trim()) || 0;
      server = { pid, gone: !pid, empty: !!pid };
      if (pid) lastPid = pid;
    }
    return [];
  }
  const rows: RawWindow[] = [];
  let pid = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const f = fields(line);
    pid ||= Number(f[24]) || 0;
    if (f[0].startsWith(VIEWER_PREFIX)) continue;
    rows.push({
      session: f[0],
      sessionId: f[1],
      windowId: f[2],
      index: Number(f[3]),
      name: f[4],
      active: f[5] === '1',
      activity: Number(f[6]),
      bell: f[7] === '1',
      panePid: Number(f[8]),
      command: f[9],
      path: livePath(f[10]),
      title: f[11],
      panes: Number(f[12]),
      agentTag: f[13],
      seen: Number(f[14]) || 0,
      createdAt: Number(f[15]) || 0,
      uid: f[16],
      hookState: f[17],
      hookAt: Number(f[18]) || 0,
      harness: f[19],
      harnessId: f[20],
      model: f[21],
      hookDetail: f[22] ?? '',
      hookAsk: f[23] ?? '',
    });
  }
  if (pid) {
    server = { pid, gone: false, empty: false };
    lastPid = pid;
  }
  return rows;
}

/**
 * Idempotent: guarantees a (possibly empty) tmux server that outlives us.
 * `exit-empty off` keeps the server — and our socket — around when the last
 * window closes, so a mass window death never strands ah with a stale socket
 * and every ah restart finds the same server its sessions live in.
 */
export async function ensureServer(): Promise<void> {
  // One client invocation: the commands run back-to-back on the server, so an
  // empty server cannot exit in between (it would before `exit-empty off` lands).
  await tmux('start-server', ';', 'set-option', '-s', 'exit-empty', 'off').catch(() => {});
}

/**
 * Whether a tmux server answers on ah's socket now: 'down' only when tmux says there's none
 * (no socket, nothing listening on it); a slow or wedged one, or any other error, is
 * 'unknown', never taken for gone. The pid of one that answers is remembered: a server whose
 * socket was deleted under it reads 'down' too, and bringServerBack asks it back.
 */
export async function serverState(): Promise<'up' | 'down' | 'unknown'> {
  return tmux('display-message', '-p', '#{pid}').then(
    (out) => {
      const pid = Number(out.trim());
      if (!(pid > 0)) return 'unknown';
      lastPid = pid;
      return 'up';
    },
    (err) => stateOfError(err),
  );
}

/** What tmux's error says of its server: only "nothing there" is 'down'. */
export function stateOfError(err: unknown): 'down' | 'unknown' {
  const msg = String((err as { stderr?: string }).stderr ?? err);
  return /no server running|No such file or directory|Connection refused/.test(msg) ? 'down' : 'unknown';
}

export async function serverUp(): Promise<boolean> {
  return (await serverState()) === 'up';
}

/**
 * The systemd user unit that owns ah's tmux server (contrib/ah-tmux.service), when this ah
 * runs as a systemd service on tmux's default socket; null otherwise (a dev or test host
 * with a TMUX_TMPDIR of its own, or no systemd), where ah starts the server itself.
 * `AH_TMUX_UNIT` names another unit, or none (empty).
 */
async function tmuxUnit(): Promise<string | null> {
  // Named: that unit owns this socket, whichever it is. Unnamed: ah-tmux.service, for the
  // default socket of an ah that systemd runs.
  const named = process.env.AH_TMUX_UNIT;
  const unit = named ?? 'ah-tmux.service';
  if (!unit || (named === undefined && (process.env.TMUX_TMPDIR || !process.env.INVOCATION_ID))) return null;
  return run('systemctl', ['--user', 'cat', unit], { timeout: 5000 }).then(
    () => unit,
    () => null,
  );
}

/** What's still running in the unit's cgroup ('' for nothing, null when it can't be told). */
async function unitProcs(unit: string): Promise<string | null> {
  try {
    const { stdout } = await run('systemctl', ['--user', 'show', '-p', 'ControlGroup', '--value', unit], { timeout: 5000 });
    const cg = stdout.trim();
    if (!cg) return '';
    // cgroup v2's file; anything else (v1, hybrid) can't be read this way: can't tell.
    const file = `/sys/fs/cgroup${cg}/cgroup.procs`;
    return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  } catch {
    return null;
  }
}

/**
 * A tmux server again after the one ah's sessions lived in died, without anyone acting.
 * Under systemd its unit starts it, so the server is the unit's (its cgroup), not ah's:
 * restarting a oneshot unit stops what's left in its cgroup first, so it's only done when
 * nothing is (a server ah merely couldn't reach is never killed for this). Otherwise ah
 * starts one itself. Either way it idles empty (`exit-empty off`).
 * A server still running whose socket is gone (deleted from under it: a /tmp cleaner) is
 * asked to make it again (SIGUSR1), never replaced: a second server would have its sessions
 * brought back beside the ones still running in the first ('reconnected').
 */
export function bringServerBack(): Promise<BringBack> {
  // One at a time, shared: two callers each seeing no server and an empty cgroup would both
  // restart the unit, and the second restart would stop the server the first one started.
  bringing ??= bringBackWith(realBringDeps).finally(() => (bringing = null));
  return bringing;
}

export type BringBack = 'up' | 'reconnected' | 'unit' | 'started' | 'failed';

let bringing: Promise<BringBack> | null = null;

/** What bringing a server back reads and does (injected in tests). */
export type BringDeps = {
  state: () => Promise<'up' | 'down' | 'unknown'>;
  /** The pid of the server ah last saw answer, this run or (until one does) the last (0 for none). */
  lastServer: () => number;
  /** Whether pid is ah's tmux server, still running (serverIdentity). */
  isServer: (pid: number) => 'yes' | 'no' | 'unknown';
  /** Asks a running server to make its socket again. */
  wake: (pid: number) => void;
  unit: () => Promise<string | null>;
  /** The unit's cgroup's pids ('' none, null can't tell). */
  procs: (unit: string) => Promise<string | null>;
  restartUnit: (unit: string) => Promise<void>;
  ensure: () => Promise<void>;
  sleep: (ms: number) => Promise<void>;
};

export async function bringBackWith(d: BringDeps): Promise<BringBack> {
  const now = await d.state();
  if (now === 'up') {
    // Up already (ah's start on a server someone else began): it still idles empty.
    await d.ensure();
    return 'up';
  }
  // Not answering, but not gone either (wedged, slow): nothing is restarted or started over it.
  if (now === 'unknown') return 'failed';
  const unit = await d.unit();
  const procs = unit ? await d.procs(unit) : null;
  // Still running, its socket gone: asked to make it again, never a second server beside it.
  const seen = [d.lastServer(), ...(procs ?? '').split('\n').map(Number)].filter((pid, i, all) => pid > 0 && all.indexOf(pid) === i).map((pid) => ({ pid, is: d.isServer(pid) }));
  const alive = seen.filter((x) => x.is === 'yes').map((x) => x.pid);
  // A tmux that may be it, and can't be told: not woken (the signal ends any other program), and
  // nothing started beside it either.
  if (!alive.length && seen.some((x) => x.is === 'unknown')) {
    console.error(`tmux: no server answers, and whether ${seen.filter((x) => x.is === 'unknown').map((x) => x.pid).join(', ')} is it can't be told; not starting another`);
    return 'failed';
  }
  if (alive.length) {
    for (const pid of alive) d.wake(pid);
    for (let i = 0; i < 10; i++) {
      await d.sleep(200);
      if ((await d.state()) === 'up') {
        await d.ensure();
        return 'reconnected';
      }
    }
    console.error(`tmux: the server (${alive.join(', ')}) is still running but its socket didn't come back; not starting another`);
    return 'failed';
  }
  if (unit && procs === '') {
    await d.restartUnit(unit).catch((err) => console.error(`tmux: restarting ${unit} failed:`, (err as Error).message));
    if ((await d.state()) === 'up') {
      await d.ensure();
      return 'unit';
    }
  }
  await d.ensure();
  return (await d.state()) === 'up' ? 'started' : 'failed';
}

/** ah's tmux socket (tmux's default one, under TMUX_TMPDIR when set), as given and resolved. */
function socketPaths(): string[] {
  const dir = join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`);
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  return [...new Set([join(dir, 'default'), join(real, 'default')])];
}

/**
 * Whether pid is the tmux server of ah's socket, still running: 'yes', 'no' (gone, another
 * program, a tmux server of another socket: a pid of an earlier boot, reused), or 'unknown'
 * (it can't be told here). On Linux the server still holds its socket bound to the path, its
 * file deleted or not. Without /proc (macOS) only the program can be read: a tmux the server
 * ah saw answer this run is taken for it, any other tmux can't be told.
 */
export function serverIdentity(pid: number, paths = socketPaths()): 'yes' | 'no' | 'unknown' {
  try {
    process.kill(pid, 0);
  } catch {
    return 'no';
  }
  let comm: string | null = null;
  try {
    comm = readFileSync(`/proc/${pid}/comm`, 'utf8');
  } catch {}
  if (comm === null) {
    try {
      comm = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    } catch {
      return 'unknown';
    }
    if (!/(^|\/)tmux/.test(comm.trim())) return 'no';
    return pid === lastPid ? 'yes' : 'unknown';
  }
  if (!/^tmux/.test(comm)) return 'no';
  try {
    const inodes = new Set<string>();
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try {
        const m = readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
        if (m) inodes.add(m[1]);
      } catch {}
    }
    for (const line of readFileSync(`/proc/${pid}/net/unix`, 'utf8').split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length >= 8 && inodes.has(f[6]) && paths.includes(f.slice(7).join(' '))) return 'yes';
    }
    return 'no';
  } catch {
    return 'unknown';
  }
}

const realBringDeps: BringDeps = {
  state: serverState,
  lastServer: () => lastPid || rememberedPid,
  isServer: (pid) => serverIdentity(pid),
  wake: (pid) => {
    try {
      process.kill(pid, 'SIGUSR1');
    } catch {}
  },
  unit: tmuxUnit,
  procs: unitProcs,
  restartUnit: async (unit) => void (await run('systemctl', ['--user', 'restart', unit], { timeout: 15_000 })),
  ensure: ensureServer,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function listSessions(): Promise<string[]> {
  try {
    const out = await tmux('list-sessions', '-F', '#{session_name}');
    return out.split('\n').filter((s) => s && !s.startsWith(VIEWER_PREFIX));
  } catch (err) {
    if (isNoServer(err)) return [];
    throw err;
  }
}

export async function hasSession(name: string): Promise<boolean> {
  return (await listSessions()).includes(name);
}

/**
 * Creates a window (and its session if needed) running the user's default shell.
 * `env` is set for that window's shell only (tmux -e), not tmux's global environment.
 */
export function createWindow(opts: { session: string; cwd: string; name: string; env?: Record<string, string> }): Promise<string> {
  // Two creates into a session that doesn't exist yet would both see it missing and
  // both run new-session; the second fails ("duplicate session"). In this process
  // they take turns per session name; another process racing us is caught below.
  const prior = creating.get(opts.session) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(() => createWindowNow(opts));
  creating.set(opts.session, task);
  return task.finally(() => {
    if (creating.get(opts.session) === task) creating.delete(opts.session);
  });
}

const creating = new Map<string, Promise<string>>();

/**
 * A tmux command whose arguments mustn't show in `ps` (Settings → Environment's values, the
 * session's token): read by tmux from a file only you can read, gone once it ran. On a command
 * line every user of the machine can read them, for as long as the process lives; a tmux server
 * started by one keeps that command line as its own.
 */
export async function tmuxPrivately(...args: string[]): Promise<string> {
  const dir = await mkdtemp(join(process.env.XDG_RUNTIME_DIR || tmpdir(), 'ah-cmd-'));
  const file = join(dir, 'cmd');
  // One command a line (";" between them); each argument quoted as tmux reads it, literally.
  const lines: string[][] = [[]];
  for (const a of args) a === ';' ? lines.push([]) : lines.at(-1)!.push(`'${a.replace(/'/g, `'"'"'`)}'`);
  try {
    await writeFile(file, lines.map((l) => l.join(' ')).join('\n') + '\n', { mode: 0o600 });
    return await tmux('source-file', file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function createWindowNow(opts: { session: string; cwd: string; name: string; env?: Record<string, string> }): Promise<string> {
  const env = Object.entries(opts.env ?? {});
  const fmt = ['-P', '-F', '#{window_id}', ...env.flatMap(([k, v]) => ['-e', `${k}=${v}`])];
  // With values in them, never on a command line (tmuxPrivately).
  const run = env.length ? tmuxPrivately : tmux;
  const newWindow = async () => (await run('new-window', '-d', '-t', `=${opts.session}:`, '-n', opts.name, '-c', opts.cwd, ...fmt)).trim();
  if (await hasSession(opts.session)) {
    try {
      return await newWindow();
    } catch (err) {
      // Its last window closed between our check and now (a session ended, a shell
      // exited), and tmux took the session with it: make it again, below.
      if (!/can't find session/i.test(String((err as { stderr?: string }).stderr ?? err))) throw err;
    }
  }
  // No server answers: brought back the one way that never starts a second beside a live one
  // (its socket deleted, the server running on), before new-session would start one of its own.
  if ((await serverState()) !== 'up' && (await bringServerBack()) === 'failed') {
    throw new Error("tmux's server doesn't answer, and a new one can't be started safely beside it");
  }
  let out: string;
  try {
    // On an empty socket this starts the server: it must idle empty like any of ah's
    // (`exit-empty off`), in the same invocation, before its last window can close.
    // Never the command that starts a server when it carries values: the server would keep it
    // as its own command line (tmuxPrivately); a bare one first, which source-file then needs.
    if (env.length && (await serverState()) !== 'up') await ensureServer();
    out = await run('new-session', '-d', '-s', opts.session, '-n', opts.name, '-c', opts.cwd, ...fmt, ';', 'set-option', '-s', 'exit-empty', 'off');
  } catch (err) {
    // Someone else (the CLI, another ah) made the session between our check and now.
    if (/duplicate session/i.test(String((err as { stderr?: string }).stderr ?? err))) return newWindow();
    throw err;
  }
  // new-session -e also sets the session's environment, which later windows
  // inherit: once the first shell has started with it, take it back off the
  // session so a variable removed in Settings doesn't linger there.
  for (const [k] of env) await tmux('set-environment', '-t', `=${opts.session}`, '-u', k).catch(() => {});
  return out.trim();
}

export async function sendLine(target: string, text: string): Promise<void> {
  await sendKeys(target, '-l', text);
  await sendKeys(target, 'Enter');
}

/**
 * Presses keys in a window as if typed at its prompt. A pane scrolled back (copy mode,
 * which the terminal view's touch scrolling enters) takes keys for itself: an Enter
 * there only ends the scrolling, leaving a pasted prompt typed but never sent, and an
 * Escape meant to stop a turn never reaches the agent. So that's left first.
 */
export async function sendKeys(target: string, ...keys: string[]): Promise<void> {
  await leaveCopyMode(target);
  await tmux('send-keys', '-t', target, ...keys);
}

async function leaveCopyMode(target: string): Promise<void> {
  if ((await tmux('display-message', '-p', '-t', target, '#{pane_in_mode}')).trim() === '1') await tmux('send-keys', '-t', target, '-X', 'cancel');
}

export async function setWindowOption(windowId: string, key: string, value: string): Promise<void> {
  await tmux('set-option', '-w', '-q', '-t', windowId, key, value);
}

/** Several window options in one tmux call. */
export async function setWindowOptions(windowId: string, options: Record<string, string>): Promise<void> {
  const args = Object.entries(options).flatMap(([k, v], i) => [...(i ? [';'] : []), 'set-option', '-w', '-q', '-t', windowId, k, v]);
  if (args.length) await tmux(...args);
}

export async function renameWindow(windowId: string, name: string): Promise<void> {
  await tmux('rename-window', '-t', windowId, name);
}

export async function killWindow(windowId: string): Promise<void> {
  await tmux('kill-window', '-t', windowId);
}

/** What runs in the foreground of a window's pane ("claude", or "bash" back at its prompt). */
export async function paneCommand(windowId: string): Promise<string> {
  return (await tmux('display-message', '-p', '-t', windowId, '#{pane_current_command}')).trim();
}

export async function capturePane(windowId: string, lines: number): Promise<string> {
  return tmux('capture-pane', '-p', '-J', '-t', windowId, '-S', String(-lines));
}

/** The last `lines` of scrollback above a pane's screen, without the screen. */
export async function captureHistory(windowId: string, lines: number): Promise<string> {
  // With none, tmux clamps the range to the screen's first line instead.
  const kept = Number((await tmux('display-message', '-p', '-t', windowId, '#{history_size}')).trim());
  if (!kept) return '';
  return tmux('capture-pane', '-p', '-J', '-t', windowId, '-S', String(-Math.min(lines, kept)), '-E', '-1');
}

export async function windowExists(windowId: string): Promise<{ session: string } | null> {
  const w = (await listWindows()).find((w) => w.windowId === windowId);
  return w ? { session: w.session } : null;
}

/** Removes viewer sessions left behind by a crashed server. */
export async function cleanupViewers(): Promise<void> {
  try {
    const out = await tmux('list-sessions', '-F', `#{session_name}${SEP}#{session_attached}`);
    for (const line of out.split('\n')) {
      const [name, attached] = fields(line);
      if (name?.startsWith(VIEWER_PREFIX) && attached === '0') {
        await tmux('kill-session', '-t', `=${name}`).catch(() => {});
      }
    }
  } catch (err) {
    if (!isNoServer(err)) throw err;
  }
}

function isNoServer(err: unknown): boolean {
  const msg = String((err as { stderr?: string }).stderr ?? err);
  // An alive-but-empty server answers `list-windows -a` with "no current
  // target" — for these list calls that is the same as no server: no windows.
  return /no server running|error connecting|No such file or directory|no current target/.test(msg);
}

// tmux session names cannot contain '.' or ':'.
export function sanitizeSessionName(name: string): string {
  return name.replace(/[.:]/g, '-').trim();
}

/** A paste that failed. `typed` says whether any of the text reached the window. */
export class PasteError extends Error {
  typed: boolean;
  constructor(message: string, typed: boolean) {
    super(message);
    this.typed = typed;
  }
}

/**
 * What sits unsent in an agent's input box. Claude Code draws the box between two
 * rules, "❯ " first: '' when it is empty (or shows its "Try …" hint), null when
 * the screen has no such box (a shell, a dialog, another TUI): then nobody knows.
 */
export function pendingInput(screen: string): string | null {
  const lines = screen.split('\n');
  const rules = lines.flatMap((l, i) => (/^\s*─{8,}\s*$/.test(l) ? [i] : []));
  if (rules.length < 2) return null;
  const box = lines.slice(rules[rules.length - 2] + 1, rules[rules.length - 1]);
  // A picker between the rules ("❯ 1. Yes") is not the input; it says how to answer it under
  // them. A box can start with "1." too: a message that's a numbered list, typed or handed back.
  if (!box.length || !/^❯(\s|$)/.test(box[0]) || lines.slice(rules[rules.length - 1] + 1).some((l) => PICKER_HINT.test(l))) return null;
  const text = [box[0].slice(1), ...box.slice(1)].map((l) => l.trim()).join(' ').trim();
  return /^Try ".*"$/.test(text) ? '' : text;
}

/** The line under a picker that says how to answer it (Claude Code's question dialog, a trust prompt). */
const PICKER_HINT = /Enter to (select|confirm)|to navigate|Esc to cancel/;

const screen = (target: string) => tmux('capture-pane', '-p', '-t', target).then(pendingInput, () => null);
/** What sits unsent in the window's input box now (see pendingInput). */
export const inputBox = screen;

/** Polls the input box until `done` says so, or `ms` pass; returns the last reading. */
async function watchInput(target: string, done: (s: string | null) => boolean, ms: number): Promise<string | null> {
  const until = Date.now() + ms;
  for (;;) {
    const s = await screen(target);
    if (done(s) || Date.now() >= until) return s;
    await new Promise((r) => setTimeout(r, 40));
  }
}

/**
 * Empties an input box (see pendingInput) that has text in it within `ms`, and says
 * whether it did. Ctrl+U takes Claude Code's box a line at a time, read again after
 * each. Not Ctrl+C, which clears it at once: a second Ctrl+C in the next second or
 * so quits Claude Code, even with text in the box, and two stops in a row press two.
 */
export async function clearInput(target: string, ms: number): Promise<boolean> {
  let typed = await watchInput(target, (s) => !!s, ms);
  if (!typed) return false;
  for (let i = 0; typed && i < 40; i++) {
    const was = typed;
    await sendKeys(target, 'C-u');
    typed = await watchInput(target, (s) => s !== was, 200);
  }
  return typed === '';
}

/**
 * Types text into a window as one paste (bracketed if the app asked for it), so a
 * multi-line prompt arrives as a single message instead of one submit per line.
 * With `enter`, an agent that shows its input box gets the Enter once the text is
 * in it, and again if the text is still there after: an Enter can be lost (taken as
 * a newline in the paste), leaving the prompt typed but never sent.
 * Image paths among words go in as pastes of their own, in their places (imagePieces):
 * an agent with an input box swaps each for "[Image #N]" a moment later, which is
 * awaited before the words after them.
 */
/**
 * tmux's own test, made the moment it acts: the pane's foreground isn't a shell (its agent still
 * runs). Read by tmux, not by ah first: an agent exiting between ah's look and the keys can't
 * leave them to its shell.
 */
const AGENT_UP = '#{?#{m/r:^-?(bash|zsh|fish|sh|dash|ksh|mksh|tcsh|nu|xonsh|elvish)$,#{pane_current_command}},,1}';
const q = (a: string) => `'${a.replace(/'/g, `'"'"'`)}'`;

/** The agent left its shell in the pane: nothing of the message was left for the shell to run. */
export class ShellBehind extends PasteError {
  constructor() {
    super("its agent isn't running in its window; nothing was typed into its shell", false);
  }
}

/**
 * Runs `command` (a tmux command line) in `target` only while its agent runs; otherwise `orElse`
 * (keys for the shell that's there instead) and ShellBehind.
 */
async function whileAgent(target: string, command: string, orElse = ''): Promise<void> {
  const mark = randomUUID().slice(0, 8);
  await tmux('if-shell', '-F', '-t', target, AGENT_UP, command, `${orElse ? `${orElse} ; ` : ''}set-option -p -t ${q(target)} @ah-refused ${mark}`);
  if ((await tmux('display-message', '-p', '-t', target, '#{@ah-refused}').catch(() => '')).trim() === mark) throw new ShellBehind();
}

export async function pasteText(target: string, text: string, enter: boolean, o: { agent?: boolean } = {}): Promise<void> {
  const fail = (typed: boolean) => (err: unknown) => {
    if (err instanceof ShellBehind) throw err;
    throw new PasteError((err as Error)?.message ?? String(err), typed);
  };
  await leaveCopyMode(target).catch(fail(false));
  const boxed = enter && (await screen(target).catch(() => null)) !== null;
  const pieces = (boxed && imagePieces(text)) || [{ text, images: 0 }];
  let typed = false;
  for (const piece of pieces) {
    const before = piece.images ? imageTags(await screen(target)) : 0;
    await pasteOnce(target, piece.text, o.agent).catch(fail(typed));
    typed = true;
    // Not there in time (a file it couldn't read stays a path): the words go in anyway.
    if (piece.images) await watchInput(target, (s) => imageTags(s) >= before + piece.images, 3000);
  }
  if (!enter) return;
  // Into an agent's window, the Enter goes only while the agent runs; its shell back instead, the
  // line it would have run is cleared (a bracketed paste there runs nothing by itself).
  const press = () => (o.agent ? whileAgent(target, `send-keys -t ${q(target)} Enter`, `send-keys -t ${q(target)} C-u`) : sendKeys(target, 'Enter')).catch(fail(true));
  if (!boxed) {
    // Give TUIs a beat to finish ingesting the paste before submitting it.
    await new Promise((r) => setTimeout(r, 150));
    await press();
    return;
  }
  const shown = await watchInput(target, (s) => s !== '', 1000);
  if (shown === '') console.warn(`${target}: the paste didn't show in the input box within 1s; pressing Enter anyway`);
  await press();
  // A slash command may open a picker, where a second Enter would choose for you. A message
  // its pictures start ("/up/a.png …") isn't one: the iOS app puts them first.
  for (let retry = 0; retry < 2 && !/^\/[\w:-]+(\s|$)/.test(text.trimStart()); retry++) {
    const left = await watchInput(target, (s) => !s, 1500);
    if (!left) return;
    console.warn(`${target}: Enter didn't submit the prompt (still in the input box); pressing it again`);
    await press();
  }
}

/** How many "[Image #N]" an input box shows. */
const imageTags = (box: string | null) => box?.match(/\[Image #\d+\]/g)?.length ?? 0;

/** One bracketed paste (if the app asked for it) through a buffer of its own. */
async function pasteOnce(target: string, text: string, agent = false): Promise<void> {
  const buffer = `ah-${process.pid}-${randomUUID()}`;
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tmux', ['load-buffer', '-b', buffer, '-'], { env: cleanEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `load-buffer exited ${code}`))));
    p.stdin.end(text);
  });
  try {
    if (agent) await whileAgent(target, `paste-buffer -p -d -b ${q(buffer)} -t ${q(target)}`);
    else await tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', target);
  } finally {
    await tmux('delete-buffer', '-b', buffer).catch(() => {});
  }
}
