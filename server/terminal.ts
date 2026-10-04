// Bridges a browser WebSocket to a real tmux client running in a PTY.
//
// Every connection gets its own throwaway session grouped with the target
// session, so each device can look at a different window independently and
// tmux reaps the viewer as soon as the PTY goes away.
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { cleanEnv, tmux, VIEWER_PREFIX, windowExists, setWindowOption } from './tmux.ts';

/** windowId → labels of the devices currently looking at it ("iPad", "Mac"). */
export const viewers = new Map<string, string[]>();

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

type ClientMessage = { t: 'i'; d: string } | { t: 'r'; c: number; r: number };

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export async function attach(ws: WebSocket, windowId: string, cols: number, rows: number, device: string): Promise<void> {
  const target = await windowExists(windowId);
  if (!target) {
    ws.close(4404, 'window not found');
    return;
  }

  const viewer = VIEWER_PREFIX + randomBytes(4).toString('hex');
  const term = pty.spawn(
    'tmux',
    [
      '-u',
      'new-session', '-t', `=${target.session}`, '-s', viewer,
      ';', 'set-option', 'destroy-unattached', 'on',
      ';', 'set-option', 'status', 'off',
      ';', 'set-option', 'mouse', 'on',
      ';', 'select-window', '-t', `${viewer}:${windowId}`,
    ],
    {
      name: 'xterm-256color',
      cols: clamp(cols, 2, 1000, 80),
      rows: clamp(rows, 2, 500, 24),
      cwd: process.env.HOME,
      env: cleanEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8' }),
      encoding: null,
    },
  );

  viewers.set(windowId, [...(viewers.get(windowId) ?? []), device]);
  let closed = false;

  // Coalesce output into fewer frames; full-screen TUIs emit many tiny writes.
  let pending: Buffer[] = [];
  let flushTimer: NodeJS.Timeout | null = null;
  // Backpressure: a slow client (phone on a bad network) pauses the tmux client instead
  // of letting output pile up in memory; tmux keeps the session state regardless.
  let paused = false;
  const flush = () => {
    flushTimer = null;
    if (pending.length && ws.readyState === ws.OPEN) ws.send(Buffer.concat(pending));
    pending = [];
    if (!paused && ws.bufferedAmount > HIGH_WATER) {
      paused = true;
      term.pause();
      const drain = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount < LOW_WATER) {
          clearInterval(drain);
          paused = false;
          term.resume();
        }
      }, 50);
    }
  };

  term.onData((data) => {
    pending.push(data as unknown as Buffer);
    flushTimer ??= setTimeout(flush, 4);
  });

  term.onExit(() => {
    flush();
    cleanup();
    if (ws.readyState === ws.OPEN) ws.close(1000, 'detached');
  });

  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.t === 'i' && typeof msg.d === 'string') {
      term.write(msg.d);
    } else if (msg.t === 'r') {
      term.resize(clamp(msg.c, 2, 1000, 80), clamp(msg.r, 2, 500, 24));
    }
  });

  ws.on('close', () => {
    cleanup();
    term.kill();
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    const rest = [...(viewers.get(windowId) ?? [])];
    rest.splice(rest.indexOf(device), 1);
    if (rest.length) viewers.set(windowId, rest);
    else viewers.delete(windowId);
    // Whatever was on screen when you left counts as read.
    tmux('display-message', '-p', '-t', windowId, '#{window_activity}')
      .then((a) => setWindowOption(windowId, '@ah-seen', a.trim()))
      .catch(() => {});
    tmux('kill-session', '-t', `=${viewer}`).catch(() => {});
  }
}
