// Bridges a browser WebSocket to a real tmux client running in a PTY.
//
// Every connection gets its own throwaway session grouped with the target
// session, so each device can look at a different window independently and
// tmux reaps the viewer as soon as the PTY goes away.
import { randomBytes } from 'node:crypto';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import { markCommand } from './terminalCommands.ts';
import { cleanEnv, tmux, TERMINAL_PREFIX, VIEWER_PREFIX, windowExists, setWindowOption } from './tmux.ts';

/** windowId → labels of the devices currently looking at it ("iPad", "Mac"), one per page. */
export const viewers = new Map<string, string[]>();
/** windowId → page (client id) → its label and how many of its connections are open. */
const pages = new Map<string, Map<string, { device: string; open: number }>>();

/** A page's id as sent with its connections, or null when missing or malformed. */
export function clientId(raw: string | null): string | null {
  return raw && /^[\w-]{1,40}$/.test(raw) ? raw : null;
}

/**
 * A device is looking at a window, in its terminal or its GUI: what it prints
 * meanwhile counts as read, and other devices see it as "also open on …".
 * One page counts once however many connections it holds (a GUI stream and a
 * terminal kept warm after switching views), so it never reads as another device
 * with the same name; a connection without a page id counts on its own.
 * The returned function ends the visit; whatever was on screen counts as read.
 */
export function addViewer(windowId: string, device: string, client: string | null = null): () => void {
  const page = client ?? `conn-${randomBytes(6).toString('hex')}`;
  const here = pages.get(windowId) ?? new Map<string, { device: string; open: number }>();
  pages.set(windowId, here);
  const entry = here.get(page);
  if (entry) entry.open++;
  else here.set(page, { device, open: 1 });
  syncViewers(windowId);
  let left = false;
  return () => {
    if (left) return;
    left = true;
    const e = here.get(page);
    if (e && --e.open <= 0) here.delete(page);
    if (!here.size && pages.get(windowId) === here) pages.delete(windowId);
    syncViewers(windowId);
    tmux('display-message', '-p', '-t', windowId, '#{window_activity}')
      .then((a) => setWindowOption(windowId, '@ah-seen', a.trim()))
      .catch(() => {});
  };
}

function syncViewers(windowId: string) {
  const here = pages.get(windowId);
  if (here?.size) viewers.set(windowId, [...here.values()].map((e) => e.device));
  else viewers.delete(windowId);
}

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

type ClientMessage = { t: 'i'; d: string } | { t: 'r'; c: number; r: number } | { t: 's'; n: number; c?: number; r?: number };

/**
 * Scrolls a window by exact lines (touch scrolling). Wheel reports would scroll
 * however many lines the tmux bindings say per notch (5 by default), so a finger
 * moved five times further than the text. Plain output scrolls tmux's history in
 * copy mode, which leaves on its own at the bottom; an app that took the mouse
 * (vim, htop) still gets wheel reports, one per three lines like a real wheel.
 */
export async function scrollLines(windowId: string, lines: number, wheel: (up: boolean) => void): Promise<boolean> {
  if (!lines) return false;
  const [inMode, mouse, alternate] = (await tmux('display-message', '-p', '-t', windowId, '#{pane_in_mode} #{mouse_any_flag} #{alternate_on}')).trim().split(' ');
  const up = lines > 0;
  if (inMode !== '1' && (mouse === '1' || alternate === '1')) {
    for (let i = 0; i < Math.max(1, Math.round(Math.abs(lines) / 3)); i++) wheel(up);
    return false;
  }
  if (!up && inMode !== '1') return false; // already at the bottom
  if (inMode !== '1') await tmux('copy-mode', '-e', '-t', windowId);
  await tmux('send-keys', '-t', windowId, '-X', '-N', String(Math.min(500, Math.abs(lines))), up ? 'scroll-up' : 'scroll-down');
  return true;
}

function clamp(n: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

export async function attach(ws: WebSocket, windowId: string, cols: number, rows: number, device: string, client: string | null = null): Promise<void> {
  const target = await windowExists(windowId);
  // Closed while we looked (a quick tab switch): its 'close' already fired, before the
  // handler below exists, so a tmux client and viewer started now would never be released.
  if (ws.readyState !== ws.OPEN) return;
  if (!target) {
    ws.close(4404, 'window not found');
    return;
  }

  const companion = target.session.startsWith(TERMINAL_PREFIX);
  const viewer = VIEWER_PREFIX + randomBytes(4).toString('hex');
  const term = pty.spawn(
    'tmux',
    [
      '-u',
      'new-session', '-t', `=${target.session}`, '-s', viewer,
      ';', 'set-option', 'destroy-unattached', 'on',
      ';', 'set-option', 'status', 'off',
      ';', 'set-option', 'mouse', 'on',
      // Let TUI apps copy to the browser clipboard via OSC 52: tmux forwards the
      // sequence to the viewer PTY, where xterm's ClipboardAddon writes it out.
      ';', 'set-option', 'set-clipboard', 'on',
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

  const leave = addViewer(windowId, device, client);
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
      const d = msg.d;
      // Typing into history scrolled back by touch goes to the prompt, as in any terminal:
      // copy mode would take the first keys as its own commands. Only copy mode this viewer's
      // scrolling entered; one you entered yourself (prefix [) keeps its keys.
      // A Return to a companion shell: the line it ends is noted first, while it still
      // shows the command, so the command and its output can be read back for the chat.
      const command = companion && d === '\r';
      if (!queued && !scrolledBack && !scrolling && !command) term.write(d);
      else {
        queued++;
        typing = typing
          .then(backToPrompt)
          .then(() => (command ? markCommand(windowId) : undefined))
          .then(() => !closed && term.write(d))
          .finally(() => queued--);
      }
    } else if (msg.t === 'r') {
      term.resize(clamp(msg.c, 2, 1000, 80), clamp(msg.r, 2, 500, 24));
    } else if (msg.t === 's' && Number.isFinite(msg.n)) {
      // One scroll at a time per viewer, coalescing whatever arrives meanwhile.
      scrollDebt += Math.max(-500, Math.min(500, Math.trunc(msg.n)));
      // The cell under the finger, so a wheel report reaches the pane it is over.
      scrollAt = [clamp(Number(msg.c), 1, 1000, 1), clamp(Number(msg.r), 1, 500, 1)];
      if (!scrolling) void drainScroll();
    }
  });

  let scrollDebt = 0;
  let scrollAt: [number, number] = [1, 1];
  let scrolling: Promise<void> | null = null;
  let scrolledBack = false;
  let typing: Promise<unknown> = Promise.resolve();
  let queued = 0;
  function drainScroll() {
    const run = (async () => {
      while (scrollDebt && !closed) {
        const n = scrollDebt;
        scrollDebt = 0;
        if (await scrollLines(windowId, n, (up) => term.write(`\x1b[<${up ? 64 : 65};${scrollAt[0]};${scrollAt[1]}M`)).catch(() => false)) scrolledBack = true;
      }
    })();
    scrolling = run;
    void run.finally(() => {
      if (scrolling === run) scrolling = null;
    });
  }
  async function backToPrompt() {
    if (scrolling) await scrolling;
    if (!scrolledBack || closed) return;
    scrolledBack = false;
    const inMode = await tmux('display-message', '-p', '-t', windowId, '#{pane_in_mode}').catch(() => '0');
    if (inMode.trim() === '1') await tmux('send-keys', '-t', windowId, '-X', 'cancel').catch(() => {});
  }

  ws.on('close', () => {
    cleanup();
    term.kill();
  });

  function cleanup() {
    if (closed) return;
    closed = true;
    leave();
    tmux('kill-session', '-t', `=${viewer}`).catch(() => {});
  }
}
