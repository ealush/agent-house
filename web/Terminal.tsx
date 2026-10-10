import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
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


export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ windowId, hidden, wsUrl, transformInput, onGone }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const transform = useRef(transformInput);
  const pasting = useRef(false);
  const gone = useRef(onGone);
  const [conn, setConn] = useState<Conn>('connecting');
  transform.current = transformInput;
  gone.current = onGone;

  const send = (data: string) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ t: 'i', d: data }));
  };

  useImperativeHandle(ref, () => ({
    send,
    paste: (data) => {
      // xterm normalizes line endings and honors the app's bracketed-paste mode.
      // Clipboard content must not be changed by a pending one-shot modifier.
      pasting.current = true;
      try { term.current?.paste(data); } finally { pasting.current = false; }
    },
    focus: () => term.current?.focus(),
  }), []);

  // One xterm instance for the component's lifetime; windows swap underneath it.
  useEffect(() => {
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
    t.open(host.current!);
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
        if (action && ws.current?.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({ t: 'i', d: action.send }));
          return false;
        }
      }
      return true;
    });

    const stopSelectionCopy = autoCopySelection(host.current!, t, () => navigator.clipboard);

    t.onData((d) => send(!pasting.current && transform.current ? transform.current(d) : d));
    t.onBinary((d) => send(d));
    term.current = t;
    fit.current = f;
    document.fonts?.ready.then(() => safeFit());

    let timer: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(safeFit, 40);
    });
    ro.observe(host.current!);

    // Follow the theme live (Omarchy's palette changes with the desktop).
    const stopTheme = subscribeTheme(() => {
      t.options.theme = terminalTheme();
      const font = terminalFont();
      if (t.options.fontFamily !== font) {
        t.options.fontFamily = font;
        clearTimeout(timer);
        timer = window.setTimeout(safeFit, 40);
      }
    });
    const stopTouch = touchScroll(
      host.current!,
      t,
      (n, c, r) => {
        if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ t: 's', n, c, r }));
      },
      () => {
        clearTimeout(timer);
        timer = window.setTimeout(safeFit, 30);
      },
    );

    return () => {
      ro.disconnect();
      stopTheme();
      stopTouch();
      stopSelectionCopy();
      t.dispose();
      term.current = null;
    };
  }, []);

  function safeFit() {
    const t = term.current;
    if (!t || !host.current?.offsetWidth) return;
    fit.current?.fit();
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ t: 'r', c: t.cols, r: t.rows }));
  }

  // Connection lifecycle per window, with reconnect after sleep / network loss.
  useEffect(() => {
    const t = term.current!;
    let disposed = false;
    let attempt = 0;
    let retryTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      safeFit();
      setConn(attempt ? 'retrying' : 'connecting');
      const sock = new WebSocket(wsUrl(windowId, t.cols, t.rows));
      sock.binaryType = 'arraybuffer';
      ws.current = sock;
      sock.onopen = () => {
        attempt = 0;
        // tmux repaints the whole screen on attach, so start from a clean slate.
        t.reset();
        setConn('open');
        // Only when nothing else has the keyboard: a split's other pane (or its
        // chooser), or a reconnect in the background, must not steal it.
        const idle = !document.activeElement || document.activeElement === document.body;
        if (idle && !matchMedia('(pointer: coarse)').matches) t.focus();
      };
      sock.onmessage = (e) => t.write(new Uint8Array(e.data as ArrayBuffer));
      sock.onclose = (e) => {
        if (ws.current === sock) ws.current = null;
        if (disposed) return;
        if (e.code === 4401) {
          // This device was signed out elsewhere: back to the lock screen.
          window.dispatchEvent(new Event('ah:unauthorized'));
          return;
        }
        if (e.code === 4404) {
          setConn('gone');
          gone.current();
          return;
        }
        attempt++;
        setConn('retrying');
        retryTimer = window.setTimeout(connect, Math.min(5000, 300 * 2 ** attempt));
      };
    };

    const wake = () => {
      if (document.visibilityState !== 'visible' || disposed) return;
      const s = ws.current;
      if (!s || s.readyState === WebSocket.CLOSED || s.readyState === WebSocket.CLOSING) {
        clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };

    connect();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
      ws.current?.close();
      ws.current = null;
    };
  }, [windowId]);

  return (
    <div className={`term-wrap ${hidden ? 'hidden' : ''}`}>
      <div ref={host} className="term" />
      {conn !== 'open' && (
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
