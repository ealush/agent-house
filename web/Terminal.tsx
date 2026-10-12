import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { autoCopySelection, copyText } from './selection.ts';
import { terminalArrow } from './keyboard.ts';
import { subscribeTheme, terminalFont, terminalTheme } from './theme.ts';

export type TerminalHandle = {
  send: (data: string) => void;
  paste: (data: string) => void;
  focus: () => void;
};

type Props = {
  windowId: string;
  /** Kept mounted (and connected) while another tab is showing. */
  hidden?: boolean;
  /** Builds the socket URL for this window on its host (local, or proxied peer). */
  wsUrl: (windowId: string, cols: number, rows: number) => string;
  /** Lets the on-screen key bar rewrite typed input (sticky Ctrl/Alt). */
  transformInput?: (data: string) => string;
  onGone: () => void;
};

type Conn = 'connecting' | 'open' | 'retrying' | 'gone';

/** What the component showing a live terminal tells it; swapped when another adopts it. */
type Handlers = {
  wsUrl: Props['wsUrl'];
  transform?: (data: string) => string;
  gone: () => void;
  conn: (c: Conn) => void;
};

/**
 * A live terminal: xterm in a container of its own, attached to one tmux window, with
 * its socket, reconnects, resizing and touch handling. It outlives the component showing
 * it by a few seconds (parked), so the same window shown again (a split forming around
 * it, switching back to it) adopts it already painted, instead of a blank terminal
 * attaching and measuring again.
 */
type Live = {
  windowId: string;
  el: HTMLDivElement;
  t: XTerm;
  conn: Conn;
  on: Handlers;
  pasting: boolean;
  ws: () => WebSocket | null;
  send: (data: string) => void;
  dispose: () => void;
  timer?: number;
};

const PARK_MS = 4000;
const PARK_MAX = 3;
const parked = new Map<string, Live>();

function park(l: Live) {
  l.el.remove();
  l.on = { ...l.on, transform: undefined, gone: () => {}, conn: (c) => void (l.conn = c) };
  const old = parked.get(l.windowId);
  if (old && old !== l) old.dispose();
  parked.delete(l.windowId);
  parked.set(l.windowId, l);
  l.timer = window.setTimeout(() => {
    if (parked.get(l.windowId) !== l) return;
    parked.delete(l.windowId);
    l.dispose();
  }, PARK_MS);
  for (const [id, oldest] of parked) {
    if (parked.size <= PARK_MAX) break;
    parked.delete(id);
    clearTimeout(oldest.timer);
    oldest.dispose();
  }
}

function adopt(windowId: string): Live | null {
  const l = parked.get(windowId);
  if (!l) return null;
  parked.delete(windowId);
  clearTimeout(l.timer);
  return l;
}

/** A new live terminal, opened inside `host` (xterm measures on open, so it must be in the page). */
function create(windowId: string, host: HTMLElement, on: Handlers): Live {
  const el = document.createElement('div');
  el.className = 'term-live';
  host.appendChild(el);
  const t = new XTerm({
    allowProposedApi: true,
    cursorBlink: true,
    fontFamily: terminalFont(),
    fontSize: storedFontSize(),
    lineHeight: 1.15,
    scrollback: 0, // tmux owns scrollback
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    theme: terminalTheme(),
  });
  const f = new FitAddon();
  t.loadAddon(f);
  t.loadAddon(new WebLinksAddon());
  t.loadAddon(new ClipboardAddon());
  t.loadAddon(new Unicode11Addon());
  t.unicode.activeVersion = '11';
  t.open(el);
  // WebGL is fastest on desktop, but mobile Safari drops GL contexts when backgrounded
  // and headless browsers paint it unreliably; the DOM renderer is the safe default there.
  if (matchMedia('(pointer: fine)').matches && !navigator.webdriver) {
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      t.loadAddon(gl);
    } catch {
      // DOM renderer fallback
    }
  }

  let ws: WebSocket | null = null;
  const live: Live = {
    windowId,
    el,
    t,
    conn: 'connecting',
    on,
    pasting: false,
    ws: () => ws,
    send: (data) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'i', d: data }));
    },
    dispose: () => {},
  };
  const setConn = (c: Conn) => {
    live.conn = c;
    live.on.conn(c);
  };

  // Copy a local (shift/option-drag) selection instead of sending ^C.
  t.attachCustomKeyEventHandler((e) => {
    const copy = (e.metaKey && e.key === 'c') || (e.ctrlKey && e.shiftKey && e.key === 'C');
    if (e.type === 'keydown' && copy && t.hasSelection()) {
      void copyText(t.getSelection());
      return false;
    }
    // Cmd/Option arrows go to the pty with terminal-native encodings (and
    // never reach the browser as Back/Forward navigation). Returning false
    // prevents xterm's default handling of the same event.
    if (e.type === 'keydown') {
      const action = terminalArrow(e.key, { meta: e.metaKey, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey });
      if (action && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: 'i', d: action.send }));
        return false;
      }
    }
    return true;
  });

  const stopSelectionCopy = autoCopySelection(el, t, () => navigator.clipboard);
  t.onData((d) => live.send(!live.pasting && live.on.transform ? live.on.transform(d) : d));
  t.onBinary((d) => live.send(d));

  const safeFit = () => {
    if (!el.offsetWidth) return;
    f.fit();
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'r', c: t.cols, r: t.rows }));
  };
  document.fonts?.ready.then(() => safeFit());
  let timer: number | undefined;
  const refit = (ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(safeFit, ms);
  };
  // Also fires when an adopted terminal lands in a pane of another size.
  const ro = new ResizeObserver(() => refit(40));
  ro.observe(el);

  // Follow the theme live (Omarchy's palette changes with the desktop).
  const stopTheme = subscribeTheme(() => {
    t.options.theme = terminalTheme();
    const font = terminalFont();
    if (t.options.fontFamily !== font) {
      t.options.fontFamily = font;
      refit(40);
    }
  });
  const stopTouch = touchScroll(
    el,
    t,
    (n, c, r) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 's', n, c, r }));
    },
    () => refit(30),
  );

  // The connection, with reconnect after sleep / network loss.
  let disposed = false;
  let attempt = 0;
  let retryTimer: number | undefined;
  const connect = () => {
    if (disposed) return;
    safeFit();
    setConn(attempt ? 'retrying' : 'connecting');
    const sock = new WebSocket(live.on.wsUrl(windowId, t.cols, t.rows));
    sock.binaryType = 'arraybuffer';
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      // tmux repaints the whole screen on attach, so start from a clean slate.
      t.reset();
      setConn('open');
      // Only when nothing else has the keyboard: a split's other pane (or its
      // chooser), or a reconnect in the background, must not steal it.
      const idle = !document.activeElement || document.activeElement === document.body;
      if (idle && el.isConnected && !matchMedia('(pointer: coarse)').matches) t.focus();
    };
    sock.onmessage = (e) => t.write(new Uint8Array(e.data as ArrayBuffer));
    sock.onclose = (e) => {
      if (ws === sock) ws = null;
      if (disposed) return;
      if (e.code === 4401) {
        // This device was signed out elsewhere: back to the lock screen.
        window.dispatchEvent(new Event('ah:unauthorized'));
        return;
      }
      if (e.code === 4404) {
        setConn('gone');
        live.on.gone();
        return;
      }
      attempt++;
      setConn('retrying');
      retryTimer = window.setTimeout(connect, Math.min(5000, 300 * 2 ** attempt));
    };
  };
  const wake = () => {
    if (document.visibilityState !== 'visible' || disposed) return;
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
      clearTimeout(retryTimer);
      attempt = 0;
      connect();
    }
  };
  connect();
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('focus', wake);

  live.dispose = () => {
    disposed = true;
    clearTimeout(retryTimer);
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('focus', wake);
    ws?.close();
    ws = null;
    ro.disconnect();
    stopTheme();
    stopTouch();
    stopSelectionCopy();
    t.dispose();
    el.remove();
  };
  return live;
}

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ windowId, hidden, wsUrl, transformInput, onGone }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef<Live | null>(null);
  const [conn, setConn] = useState<Conn>('connecting');
  const handlers: Handlers = { wsUrl, transform: transformInput, gone: onGone, conn: setConn };
  if (live.current) live.current.on = handlers;

  // "Attaching…" only when it is slow: a local attach takes a few frames, and a pill that
  // flashes on every session switch reads as a hiccup.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (conn === 'open' || conn === 'gone') return;
    const t = window.setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(t);
  }, [conn]);

  useImperativeHandle(ref, () => ({
    send: (data) => live.current?.send(data),
    paste: (data) => {
      // xterm normalizes line endings and honors the app's bracketed-paste mode.
      // Clipboard content must not be changed by a pending one-shot modifier.
      const l = live.current;
      if (!l) return;
      l.pasting = true;
      try { l.t.paste(data); } finally { l.pasting = false; }
    },
    focus: () => live.current?.t.focus(),
  }), []);

  // The window's live terminal: the one parked for it if it was just shown, else a new one.
  useLayoutEffect(() => {
    const target = host.current!;
    const was = adopt(windowId);
    const l = was ?? create(windowId, target, handlers);
    if (was) {
      target.appendChild(was.el);
      was.on = handlers;
      setConn(was.conn);
    }
    live.current = l;
    return () => {
      live.current = null;
      park(l);
    };
  }, [windowId]);

  return (
    <div className={`term-wrap ${hidden ? 'hidden' : ''}`}>
      <div ref={host} className="term" />
      {conn !== 'open' && (conn === 'gone' || slow) && (
        <div className="term-overlay">
          <span className={`pill ${conn}`}>
            {conn === 'connecting' ? 'Attaching…' : conn === 'retrying' ? 'Reconnecting…' : 'This window has closed'}
          </span>
        </div>
      )}
    </div>
  );
});

const FONT_KEY = 'ah.termFont';
const MIN_FONT = 8;
const MAX_FONT = 22;

/** This device's terminal font size: pinch-adjusted, else 12 on a phone, 14 elsewhere. */
export function storedFontSize(): number {
  try {
    const v = Number(localStorage.getItem(FONT_KEY));
    if (v >= MIN_FONT && v <= MAX_FONT) return v;
  } catch {}
  return window.matchMedia('(max-width: 600px)').matches ? 12 : 14;
}

/**
 * Touch: one finger scrolls tmux by exact lines, with momentum after a flick; two
 * fingers pinch the terminal's font size (kept per device) instead of zooming the page.
 * Scroll requests go to the server as line counts (see scrollLines in server/terminal.ts).
 */
function touchScroll(el: HTMLElement, t: XTerm, scroll: (lines: number, col: number, row: number) => void, refit: () => void) {
  let lastY: number | null = null;
  let lastAt = 0;
  let velocity = 0; // px per ms, finger-down positive
  let acc = 0;
  let cell: [number, number] = [1, 1];
  let glide: number | null = null;
  let pinch: { dist: number; size: number } | null = null;
  const lineHeight = () => el.clientHeight / t.rows;
  const distance = (e: TouchEvent) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
  const flush = () => {
    const step = lineHeight();
    const lines = Math.trunc(acc / step);
    if (!lines) return;
    acc -= lines * step;
    scroll(lines, cell[0], cell[1]);
  };
  const stopGlide = () => {
    if (glide !== null) cancelAnimationFrame(glide);
    glide = null;
  };
  const start = (e: TouchEvent) => {
    stopGlide();
    if (e.touches.length === 2) {
      pinch = { dist: distance(e), size: t.options.fontSize ?? 12 };
      lastY = null;
      return;
    }
    pinch = null;
    if (e.touches.length !== 1) return (lastY = null);
    const touch = e.touches[0];
    const rect = el.getBoundingClientRect();
    cell = [Math.max(1, Math.ceil(((touch.clientX - rect.left) / rect.width) * t.cols)), Math.max(1, Math.ceil(((touch.clientY - rect.top) / rect.height) * t.rows))];
    lastY = touch.clientY;
    lastAt = e.timeStamp;
    velocity = 0;
    acc = 0;
  };
  const move = (e: TouchEvent) => {
    if (pinch && e.touches.length === 2) {
      const size = Math.round(Math.min(MAX_FONT, Math.max(MIN_FONT, pinch.size * (distance(e) / pinch.dist))));
      if (size !== t.options.fontSize) {
        t.options.fontSize = size;
        refit();
      }
      e.preventDefault();
      return;
    }
    if (lastY === null) return;
    const y = e.touches[0].clientY;
    const dt = Math.max(1, e.timeStamp - lastAt);
    velocity = 0.7 * velocity + 0.3 * ((y - lastY) / dt);
    acc += y - lastY;
    lastY = y;
    lastAt = e.timeStamp;
    flush();
    e.preventDefault();
  };
  const end = (e: TouchEvent) => {
    if (pinch && e.touches.length < 2) {
      try {
        localStorage.setItem(FONT_KEY, String(t.options.fontSize));
      } catch {}
      pinch = null;
      return;
    }
    if (lastY === null) return;
    lastY = null;
    // A flick keeps going and slows down, like native scrolling.
    if (Math.abs(velocity) < 0.25 || e.timeStamp - lastAt > 80) return;
    let prev = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - prev);
      prev = now;
      acc += velocity * dt;
      velocity *= Math.pow(0.995, dt);
      flush();
      glide = Math.abs(velocity) > 0.03 ? requestAnimationFrame(tick) : null;
    };
    glide = requestAnimationFrame(tick);
  };
  // Safari's own pinch would zoom the whole page instead.
  const gesture = (e: Event) => e.preventDefault();
  el.addEventListener('gesturestart', gesture);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', end);
  el.addEventListener('touchcancel', end);
  return () => {
    stopGlide();
    el.removeEventListener('gesturestart', gesture);
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchmove', move);
    el.removeEventListener('touchend', end);
    el.removeEventListener('touchcancel', end);
  };
}
