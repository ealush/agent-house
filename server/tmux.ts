// Thin wrapper over the tmux CLI. tmux is the source of truth for every
// process and for our metadata (stored as @ah-* user options on windows), so
// the app can crash or restart without losing anything.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const SEP = '\x1f';

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
    const f = line.split(SEP);
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
    });
  }
  return rows;
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
      const [name, attached] = line.split(SEP);
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
  return /no server running|error connecting|No such file or directory/.test(msg);
}

// tmux session names cannot contain '.' or ':'.
export function sanitizeSessionName(name: string): string {
  return name.replace(/[.:]/g, '-').trim();
}
