// Thin wrapper over the tmux CLI. tmux is the source of truth for every
// process and for our metadata (stored as @ah-* user options on windows), so
// the app can crash or restart without losing anything.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);
const SEP = '\x1f';

/**
 * Splits one line of `-F` output. tmux ≥ 3.5 prints the separator raw; older
 * releases (3.4, as shipped by Ubuntu LTS) escape control characters in output,
 * so it arrives as the four characters "\037". Values are escaped the same way,
 * so splitting on the escaped form is unambiguous there too.
 */
export function fields(line: string): string[] {
  return line.includes(SEP) ? line.split(SEP) : line.split('\\037');
}

export const VIEWER_PREFIX = 'ah-v-';

export async function tmux(...args: string[]): Promise<string> {
  const { stdout } = await run('tmux', args, { env: cleanEnv(), maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

// Strip TMUX so we never talk to tmux as if nested inside the server's own pane.
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.TMUX;
  delete env.TMUX_PANE;
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
];

export async function listWindows(): Promise<RawWindow[]> {
  let out: string;
  try {
    // list-windows reports the active pane's fields for pane_* formats.
    out = await tmux('list-windows', '-a', '-F', WINDOW_FIELDS.map((f) => `#{${f}}`).join(SEP));
  } catch (err) {
    if (isNoServer(err)) return [];
    throw err;
  }
  const rows: RawWindow[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const f = fields(line);
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
      path: f[10],
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

/** Creates a window (and its session if needed) running the user's default shell. */
export async function createWindow(opts: { session: string; cwd: string; name: string }): Promise<string> {
  const fmt = ['-P', '-F', '#{window_id}'];
  const out = (await hasSession(opts.session))
    ? await tmux('new-window', '-d', '-t', `=${opts.session}:`, '-n', opts.name, '-c', opts.cwd, ...fmt)
    : await tmux('new-session', '-d', '-s', opts.session, '-n', opts.name, '-c', opts.cwd, ...fmt);
  return out.trim();
}

export async function sendLine(target: string, text: string): Promise<void> {
  await tmux('send-keys', '-t', target, '-l', text);
  await tmux('send-keys', '-t', target, 'Enter');
}

export async function setWindowOption(windowId: string, key: string, value: string): Promise<void> {
  await tmux('set-option', '-w', '-q', '-t', windowId, key, value);
}

export async function renameWindow(windowId: string, name: string): Promise<void> {
  await tmux('rename-window', '-t', windowId, name);
}

export async function killWindow(windowId: string): Promise<void> {
  await tmux('kill-window', '-t', windowId);
}

export async function capturePane(windowId: string, lines: number): Promise<string> {
  return tmux('capture-pane', '-p', '-J', '-t', windowId, '-S', String(-lines));
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

/**
 * Types text into a window as one paste (bracketed if the app asked for it), so a
 * multi-line prompt arrives as a single message instead of one submit per line.
 */
/** A paste that failed. `typed` says whether any of the text reached the window. */
export class PasteError extends Error {
  typed: boolean;
  constructor(message: string, typed: boolean) {
    super(message);
    this.typed = typed;
  }
}

export async function pasteText(target: string, text: string, enter: boolean): Promise<void> {
  const buffer = `ah-${process.pid}-${randomUUID()}`;
  const fail = (typed: boolean) => (err: unknown) => {
    throw new PasteError((err as Error)?.message ?? String(err), typed);
  };
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tmux', ['load-buffer', '-b', buffer, '-'], { env: cleanEnv(), stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `load-buffer exited ${code}`))));
    p.stdin.end(text);
  }).catch(fail(false));
  try {
    await tmux('paste-buffer', '-p', '-d', '-b', buffer, '-t', target).catch(fail(false));
    if (enter) {
      // Give TUIs a beat to finish ingesting the paste before submitting it.
      await new Promise((r) => setTimeout(r, 150));
      await tmux('send-keys', '-t', target, 'Enter').catch(fail(true));
    }
  } finally {
    await tmux('delete-buffer', '-b', buffer).catch(() => {});
  }
}
