import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

export type TerminalHandle = {
  send: (data: string) => void;
  focus: () => void;
};

type Props = {
  windowId: string;
  /** Lets the on-screen key bar rewrite typed input (sticky Ctrl/Alt). */
  transformInput?: (data: string) => string;
  onGone: () => void;
};

type Conn = 'connecting' | 'open' | 'retrying' | 'gone';

const THEME = {
  background: '#0e1014',
  foreground: '#e8e6e1',
  cursor: '#e8b04a',
  cursorAccent: '#0e1014',
  selectionBackground: '#e8b04a55',
  black: '#1a1d23',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#d7dae0',
  brightBlack: '#5c6370',
  brightRed: '#ef7b84',
  brightGreen: '#a9d48a',
  brightYellow: '#f0cd8c',
  brightBlue: '#74bdfa',
  brightMagenta: '#d58ce9',
  brightCyan: '#68c7d3',
  brightWhite: '#ffffff',
};

const FONT = "'JetBrainsMono Nerd Font', 'JetBrains Mono', 'SF Mono', Menlo, ui-monospace, monospace";

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal({ windowId, transformInput, onGone }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const transform = useRef(transformInput);
  const gone = useRef(onGone);
  const [conn, setConn] = useState<Conn>('connecting');
  transform.current = transformInput;
  gone.current = onGone;

  const send = (data: string) => {
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ t: 'i', d: data }));
  };

  useImperativeHandle(ref, () => ({ send, focus: () => term.current?.focus() }), []);

  // One xterm instance for the component's lifetime; windows swap underneath it.
  useEffect(() => {
    const t = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: FONT,
      fontSize: window.matchMedia('(max-width: 600px)').matches ? 12 : 14,
      lineHeight: 1.15,
      scrollback: 0, // tmux owns scrollback
      macOptionIsMeta: true,
      macOptionClickForcesSelection: true,
      theme: THEME,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.loadAddon(new WebLinksAddon());
    t.loadAddon(new ClipboardAddon());
    t.loadAddon(new Unicode11Addon());
    t.unicode.activeVersion = '11';
    t.open(host.current!);
    try {
      const gl = new WebglAddon();
      gl.onContextLoss(() => gl.dispose());
      t.loadAddon(gl);
    } catch {
      // DOM renderer fallback
    }

    // Copy a local (shift/option-drag) selection instead of sending ^C.
    t.attachCustomKeyEventHandler((e) => {
      const copy = (e.metaKey && e.key === 'c') || (e.ctrlKey && e.shiftKey && e.key === 'C');
      if (e.type === 'keydown' && copy && t.hasSelection()) {
        navigator.clipboard?.writeText(t.getSelection()).catch(() => {});
        return false;
      }
      return true;
    });

    t.onData((d) => send(transform.current ? transform.current(d) : d));
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

    const stopTouch = touchScroll(host.current!, t, send);

    return () => {
      ro.disconnect();
      stopTouch();
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
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const sock = new WebSocket(
        `${proto}://${location.host}/ws/${encodeURIComponent(windowId)}?cols=${t.cols}&rows=${t.rows}`,
      );
      sock.binaryType = 'arraybuffer';
      ws.current = sock;
      sock.onopen = () => {
        attempt = 0;
        // tmux repaints the whole screen on attach, so start from a clean slate.
        t.reset();
        setConn('open');
        if (!matchMedia('(pointer: coarse)').matches) t.focus();
      };
      sock.onmessage = (e) => t.write(new Uint8Array(e.data as ArrayBuffer));
      sock.onclose = (e) => {
        if (ws.current === sock) ws.current = null;
        if (disposed) return;
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
    <div className="term-wrap">
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

// Touch drag scrolls tmux (via SGR mouse wheel reports) instead of doing nothing.
function touchScroll(el: HTMLElement, t: XTerm, send: (d: string) => void) {
  let lastY: number | null = null;
  let acc = 0;
  const lineHeight = () => el.clientHeight / t.rows;
  const start = (e: TouchEvent) => {
    lastY = e.touches.length === 1 ? e.touches[0].clientY : null;
    acc = 0;
  };
  const move = (e: TouchEvent) => {
    if (lastY === null || t.modes.mouseTrackingMode === 'none') return;
    const touch = e.touches[0];
    const y = touch.clientY;
    acc += y - lastY;
    lastY = y;
    const step = lineHeight();
    // Report the wheel at the finger's cell so tmux scrolls the pane under it.
    const rect = el.getBoundingClientRect();
    const col = Math.max(1, Math.ceil(((touch.clientX - rect.left) / rect.width) * t.cols));
    const row = Math.max(1, Math.ceil(((y - rect.top) / rect.height) * t.rows));
    while (Math.abs(acc) >= step) {
      const up = acc > 0;
      send(`\x1b[<${up ? 64 : 65};${col};${row}M`);
      acc += up ? -step : step;
    }
    e.preventDefault();
  };
  const end = () => (lastY = null);
  el.addEventListener('touchstart', start, { passive: true });
  el.addEventListener('touchmove', move, { passive: false });
  el.addEventListener('touchend', end);
  return () => {
    el.removeEventListener('touchstart', start);
    el.removeEventListener('touchmove', move);
    el.removeEventListener('touchend', end);
  };
}
