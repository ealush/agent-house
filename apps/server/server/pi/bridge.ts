// ah's side of the pi bridge (experimental: config.json `experimental.piBridge`, docs/pi-bridge.md).
// pi runs as before, its TUI in the session's tmux pane, with ah's extension loaded
// (bin/pi-extension.ts). The extension reports state through the window options ah's hooks
// use, so status, asks and History need nothing here. What this adds is the way in: a
// message, Stop and an approval's answer go to pi itself over a Unix socket instead of being
// typed into its screen.
//
// One connection a request, nothing kept open: the socket lives in pi's process, so ah can
// restart, lose a request, or never have connected, and the next request just connects
// again. Unreachable is not an error: the caller types into the terminal as it always has.
import { existsSync, lstatSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Preset } from '../config.ts';

/** The extension pi loads. */
export const PI_EXTENSION = fileURLToPath(new URL('../../bin/pi-extension.ts', import.meta.url));

/** The per-user runtime folder (systemd's, 0700), else ours under /tmp. */
function socketRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.XDG_RUNTIME_DIR && existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : `/tmp/ah-${process.getuid?.() ?? 'user'}`;
}

/**
 * A folder only you can enter: a real folder (not a link), yours, no access for anyone else.
 * Under /tmp another user could have made it first, and could move what's in it.
 */
export function privateDir(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isDirectory() && !st.isSymbolicLink() && (!process.getuid || st.uid === process.getuid()) && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/**
 * The folder sessions' sockets go in, made if needed, or null when it can't be private
 * (then pi runs without the bridge, typed into as before). Every folder from the root
 * down is checked: a socket path holds at most 107 bytes, so it's short.
 */
export function piSocketDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = socketRoot(env);
  const dir = join(root, 'ah-pi');
  // One folder at a time, each checked before anything goes in it: a link another user
  // left at /tmp/ah-<uid> is never followed to make ours where it points.
  try {
    makeDir(root);
    if (!privateDir(root)) return null;
    makeDir(dir);
  } catch {
    return null;
  }
  return privateDir(dir) ? dir : null;
}

function makeDir(path: string) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
}

/** Where a session's socket lives. */
export function piSocket(uid: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(socketRoot(env), 'ah-pi', `${uid}.sock`);
}

const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/**
 * The pi preset with the bridge: its extension loaded on every start and resume, ah's approval
 * modes (pi has none of its own), and switching models and thinking live, which the extension
 * does directly (typed, `/model provider/id` opens pi's picker instead).
 */
export function withPiBridge(preset: Preset): Preset {
  if (preset.id !== 'pi') return preset;
  // After the program (`pi`, or a path to it), before its own arguments.
  const swap = (cmd: string | undefined) => cmd?.replace(/^((?:\S*\/)?pi)(?=\s|$)/, `$1 -e ${quote(PI_EXTENSION)}`);
  return {
    ...preset,
    command: swap(preset.command)!,
    resume: swap(preset.resume),
    resumeId: swap(preset.resumeId),
    modes: [
      { id: 'default', name: 'Ask', description: 'Asks before it runs a command or changes a file.' },
      { id: 'yolo', name: 'YOLO', args: ['--ah-approval', 'never'], dangerous: true, description: 'Runs commands and changes files without asking.' },
    ],
    switchModel: '/model {model}',
    switchEffort: '/thinking {level}',
  };
}

/** A session ah's extension speaks for: it wrote the state ah is reading. */
export function piBridged(w: { agent: string | null; statusSource?: string }): boolean {
  return w.agent === 'pi' && w.statusSource === 'hook';
}

export type PiReply = { id?: string; ok: boolean; code?: string; error?: string; [k: string]: unknown };

let seq = 0;

/** One request, its reply, or null when nothing listens at the socket (no bridge: type instead). */
export function piRequest(uid: string, msg: Record<string, unknown>, timeoutMs = 4000, path = piSocket(uid)): Promise<PiReply | null> {
  return new Promise((resolve) => {
    // Only a socket of ours, in a folder only we can enter. Gone meanwhile (pi quitting): no bridge.
    try {
      const st = lstatSync(path);
      if (!st.isSocket() || (process.getuid && st.uid !== process.getuid()) || !privateDir(dirname(path)) || !privateDir(dirname(dirname(path)))) return resolve(null);
    } catch {
      return resolve(null);
    }
    const id = `${process.pid}-${++seq}`;
    const sock = connect(path);
    let buf = '';
    let done = false;
    const finish = (r: PiReply | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    // Connected and silent: pi is there but busy beyond reason. It may yet act on it, so
    // this is a failure, never "unreachable" (which would type it a second time).
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout', error: "pi didn't answer in time" }), timeoutMs);
    let connected = false;
    sock.setEncoding('utf8');
    sock.on('connect', () => {
      connected = true;
      sock.write(JSON.stringify({ ...msg, id }) + '\n');
    });
    sock.on('data', (d: string) => {
      buf += d;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const r = JSON.parse(line) as PiReply;
          if (r.id === id) return finish(r);
        } catch {}
      }
    });
    // A socket file nobody listens on (pi gone, the window closed): no bridge.
    sock.on('error', () => finish(connected ? { ok: false, code: 'closed', error: 'pi closed the connection' } : null));
    sock.on('close', () => finish(connected ? { ok: false, code: 'closed', error: 'pi closed the connection' } : null));
  });
}

/**
 * Hands pi a message. `typed`: not pi's to take this way (a slash command for its TUI, or no
 * bridge listening), so the caller types it. `sent`: pi took it, once per `id`.
 */
export async function piPrompt(uid: string, text: string, id?: string, answers?: string): Promise<'sent' | 'typed' | { failed: string }> {
  const r = await piRequest(uid, { type: 'prompt', text, ...(id ? { key: id } : {}), ...(answers ? { answers } : {}) });
  if (!r || r.code === 'command') return 'typed';
  return r.ok ? 'sent' : { failed: r.error ?? 'pi did not take the message' };
}
