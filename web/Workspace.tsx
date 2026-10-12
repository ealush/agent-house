import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { HistoryItem, HostApi, SendResult, Win } from './api.ts';
import { Session } from './Session.tsx';
import { EndedSession } from './Ended.tsx';
import { useSavedGroups } from './groupOrder.ts';
import { sidebarOrder } from './sessionOrder.ts';
import { closeLeaf, dockLeaf, isPick, moveLeafTo, paneLeaves, pickKey, pickPrevious, replaceLeaf, setRatio, splitLeaf, tileBoxes, toggleSplit, type Box, type LayoutNode, type Path, type Seam } from './layout.ts';
import { glide, popIn } from './motion.ts';
import { PanePicker } from './PanePicker.tsx';
import { ShortcutHint } from './shortcuts.tsx';
import { Glide } from './Glide.tsx';

type Props = {
  layout: LayoutNode;
  windows: Win[];
  narrow: boolean;
  touch: boolean;
  multiHost: boolean;
  home: string;
  replyKey: number;
  focusPath: Path | null;
  clientFor: (host: string | undefined) => HostApi;
  hostHome: (host: string) => string;
  onFocus: (path: Path) => void;
  onLayout: (l: LayoutNode | null) => void;
  onAnswer: (w: Win, a: 'approve' | 'deny') => void;
  onSent: (r: SendResult, opts?: { quiet?: boolean }) => void;
  onTerminate: (w: Win) => void;
  refresh: (host?: string) => void;
  onExit: () => void;
  /** Maximize pane: show the focused pane alone until this is cleared. */
  zoom?: boolean;
  onUnzoom?: () => void;
  /** A chooser pane's "New shell": start one and put it in the pane at `path`. */
  onNewShell: (path: Path) => void;
  /** A chooser pane's "New session…": the new-session form, drawn inside that pane. */
  renderNew: (path: Path, onCancel: () => void) => React.ReactNode;
  /** Send to… → New session, in this pane's project. */
  onStartSession: (w: Win, prompt: string, preset?: string) => void;
  /** The single session this split was made from: it shrinks into its half instead of reappearing there. */
  origin?: string | null;
  /** History for a pane whose session ended, so it can offer Resume in place. */
  endedFor: (key: string) => HistoryItem | null;
  feedFor: (host: string, harness: string) => string | null;
  onResume: (item: HistoryItem) => Promise<void>;
};

/**
 * Multi-session split view (F45/F46). Every pane is an independent
 * browser→PTY→tmux viewer onto its own window; tmux never splits.
 * Layout is device-local (localStorage); phone widths collapse to tabs.
 */
export function Workspace(props: Props) {
  const { layout, windows } = props;
  // The chooser pane whose "New session…" form is open (it fills that pane).
  const [newIn, setNewIn] = useState<string | null>(null);
  const [dropPane, setDropPane] = useState<string | null>(null);
  const [paneDrag, setPaneDrag] = useState<Path | null>(null);

  const savedGroups = useSavedGroups(props.multiHost);
  const orderedWindows = sidebarOrder(windows, props.multiHost, savedGroups);
  const byKey = new Map(windows.map((w) => [w.key, w]));
  const panes = paneLeaves(layout);
  const [tab, setTab] = useState('');
  // Directional shortcuts only update focusPath. Prefer that over the tab last
  // clicked, so a narrow split follows the keyboard.
  const focusId = props.focusPath?.join('/') ?? '';
  const activeTab = panes.find((p) => p.path.join('/') === (focusId || tab)) ?? panes[0];
  const keyboardId = (props.narrow ? activeTab?.path : (props.focusPath ?? panes[0]?.path))?.join('/');
  // Maximized: the focused pane (or the first) fills the workspace; the others stay mounted in the layout.
  const zoomed = props.zoom && !props.narrow ? (panes.find((p) => p.path.join('/') === focusId) ?? panes[0]) : null;

  // The keyboard follows the focused pane, whatever it holds: a chooser or a New session
  // form takes it as a session does, and so does a pane that was just maximized, restored
  // or moved. Claimed every frame until it lands (pane contents are lazy), never from a dialog.
  const shape = JSON.stringify(layout);
  useEffect(() => {
    if (!keyboardId || props.touch) return;
    const until = performance.now() + 1000;
    let raf = 0;
    const claim = () => {
      const el = document.querySelector<HTMLElement>(`.pane[data-pane="${CSS.escape(keyboardId)}"]`);
      const a = document.activeElement as HTMLElement | null;
      // Not from a dialog or a floating layer over the workspace (the scratchpad).
      if (a?.closest('dialog[open], [role="dialog"]') || document.querySelector('.scratchpad')) return;
      if (el && a && a !== el && el.contains(a)) return;
      const target = el && PANE_FOCUS.map((q) => [...el.querySelectorAll<HTMLElement>(q)].find((x) => x.getClientRects().length > 0)).find(Boolean);
      target?.focus({ preventScroll: true });
      if (performance.now() < until) raf = requestAnimationFrame(claim);
    };
    raf = requestAnimationFrame(claim);
    return () => cancelAnimationFrame(raf);
  }, [keyboardId, props.zoom, newIn, shape, props.touch]);

  function dropKey(e: React.DragEvent): string | null {
    // Sidebar rows set text/ah-session; fall back to plain text for other sources.
    return e.dataTransfer.getData('text/ah-session') || e.dataTransfer.getData('text/plain') || null;
  }

  function panePath(raw: string): Path | null {
    if (!raw) return null;
    const parts = raw.split('/');
    if (!parts.every((part) => part === 'first' || part === 'second')) return null;
    return parts as Path;
  }

  function dropPaneOnto(from: Path, target: Path, where: 'left' | 'right' | 'top' | 'bottom' | 'center') {
    const next = moveLeafTo(layout, from, target, where);
    props.onLayout(next.layout);
    props.onFocus(next.path);
  }

  function dock(from: Path, where: 'left' | 'right' | 'top' | 'bottom') {
    const next = dockLeaf(layout, from, where === 'top' ? 'up' : where === 'bottom' ? 'down' : where);
    props.onLayout(next.layout);
    props.onFocus(next.path);
  }

  function handleDrop(target: Path, where: 'left' | 'right' | 'top' | 'bottom' | 'center', key: string | null) {
    if (!key || !byKey.has(key)) return;
    if (where === 'center') props.onLayout(replaceLeaf(layout, target, key));
    else if (where === 'left') props.onLayout(splitLeaf(layout, target, 'horizontal', key, 'before'));
    else if (where === 'right') props.onLayout(splitLeaf(layout, target, 'horizontal', key, 'after'));
    else if (where === 'top') props.onLayout(splitLeaf(layout, target, 'vertical', key, 'before'));
    else props.onLayout(splitLeaf(layout, target, 'vertical', key, 'after'));
  }

  function pane(sessionKey: string, path: Path, frame: Frame = {}) {
    const w = byKey.get(sessionKey);
    const paneId = path.join('/');
    frame = { ...frame, 'data-pane': paneId };
    const focused = props.focusPath?.join('/') === paneId;
    if (isPick(sessionKey)) {
      const previous = pickPrevious(sessionKey);
      const cancel = () => props.onLayout(previous ? replaceLeaf(layout, path, previous) : closeLeaf(layout, path));
      return (
        <div {...frame} className={`pane chooser ${focused ? 'focused' : ''} ${frame.className ?? ''}`} onClick={() => props.onFocus(path)}>
          {newIn === paneId ? (
            props.renderNew(path, () => setNewIn(null))
          ) : (
            <PanePicker
              windows={orderedWindows}
              onScreen={panes.map((p) => p.sessionKey)}
              replacing={(previous && byKey.get(previous)) || null}
              focus={keyboardId === paneId}
              onChoose={(key) => {
                props.onLayout(replaceLeaf(layout, path, key));
                props.onFocus(path);
              }}
              onNewShell={() => props.onNewShell(path)}
              onNewSession={() => setNewIn(paneId)}
              onCancel={cancel}
            />
          )}
        </div>
      );
    }
    const ended = w ? null : props.endedFor(sessionKey);
    if (ended) {
      // Ended (or gone with a reboot): the conversation and Resume, in the pane it was in.
      return (
        <div {...frame} className={`pane ${focused ? 'focused' : ''} ${frame.className ?? ''}`} onClick={() => props.onFocus(path)}>
          <EndedSession
            key={sessionKey}
            item={ended}
            client={props.clientFor(ended.host)}
            feed={props.feedFor(ended.host, ended.harness)}
            narrow={props.narrow}
            onResume={() => props.onResume(ended)}
            onClose={() => props.onLayout(closeLeaf(layout, path))}
            closeLabel="Close pane"
          />
        </div>
      );
    }
    if (!w) {
      // The session was terminated elsewhere: show the end state, keep history resumable.
      return (
        <div {...frame} className={`pane terminated ${frame.className ?? ''}`} onClick={() => props.onFocus(path)}>
          <p className="hint">This session ended.</p>
          <div className="actions">
            <button className="btn small" onClick={() => props.onLayout(closeLeaf(layout, path))}>
              Close pane
            </button>
          </div>
        </div>
      );
    }
    return (
      <div
        {...frame}
        className={`pane ${focused ? 'focused' : ''} ${dropPane === paneId ? 'dropping' : ''} ${paneDrag && paneDrag.join('/') === paneId ? 'dragging' : ''} ${frame.className ?? ''}`}
        onClick={() => props.onFocus(path)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/ah-pane') || e.dataTransfer.types.includes('text/ah-session') || e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault();
            setDropPane((k) => (k === paneId ? k : paneId));
          }
        }}
        onDragLeave={(e) => {
          // Moving onto the drop-grid overlay (a child of the pane) is not
          // leaving the pane. Without this the overlay flickers under the
          // cursor and drops land on the wrong zone (or replace the pane).
          if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
          setDropPane((k) => (k === paneId ? null : k));
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropPane(null);
          const from = panePath(e.dataTransfer.getData('text/ah-pane'));
          if (from) dropPaneOnto(from, path, 'center');
          else handleDrop(path, 'center', dropKey(e));
        }}
      >
        <Session
          key={w.key}
          w={w}
          client={props.clientFor(w.host)}
          windows={orderedWindows}
          clientFor={props.clientFor}
          narrow={props.narrow}
          touch={props.touch}
          multiHost={props.multiHost}
          home={props.hostHome(w.host)}
          replyKey={props.replyKey}
          onBack={() => props.onLayout(closeLeaf(layout, path))}
          onAnswer={props.onAnswer}
          onSent={props.onSent}
          onTerminate={() => props.onTerminate(w)}
          refresh={() => props.refresh(w.host)}
          onSplit={(dir) => {
            // The new half asks what goes in it: never the same session twice.
            props.onLayout(splitLeaf(layout, path, dir === 'right' ? 'horizontal' : 'vertical', pickKey()));
            props.onFocus([...path, 'second']);
          }}
          active={keyboardId === paneId}
          onOpenKey={(key) => {
            const hit = panes.find((p) => p.sessionKey === key);
            if (hit) props.onFocus(hit.path);
            else props.onLayout(replaceLeaf(layout, path, key));
          }}
          onSplitWith={(key) => props.onLayout(splitLeaf(layout, path, 'horizontal', key))}
          onReplace={() => props.onLayout(replaceLeaf(layout, path, pickKey(w.key)))}
          onClosePane={() => props.onLayout(closeLeaf(layout, path))}
          onFlipSplit={() => props.onLayout(toggleSplit(layout, path))}
          panePath={paneId}
          onPaneDrag={(active) => {
            setPaneDrag(active ? path : null);
            if (!active) setDropPane(null);
          }}
          onStartSession={(prompt, preset) => props.onStartSession(w, prompt, preset)}
        />
        {dropPane === paneId && (
          <div className="drop-grid">
            {(['left', 'right', 'top', 'bottom', 'center'] as const).map((where) => (
              <div
                key={where}
                className={`drop-zone ${where}`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropPane(null);
                  const from = panePath(e.dataTransfer.getData('text/ah-pane'));
                  if (from) dropPaneOnto(from, path, where);
                  else handleDrop(path, where, dropKey(e));
                }}
              >
                {where === 'center' ? (paneDrag ? 'Swap' : 'Replace') : `Drop ${where}`}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Panes are drawn flat, each placed by its box, so one stays mounted (terminal
  // and all) while splits open and close around it. Every change of place
  // plays from where the pane was, like windows on a tiling desktop.
  const { tiles, seams } = tileBoxes(layout);
  const seen = new Map<string, number>();
  const placed = tiles.map((t) => {
    const n = seen.get(t.sessionKey) ?? 0;
    seen.set(t.sessionKey, n + 1);
    const zoom = zoomed && t.path.join('/') === zoomed.path.join('/');
    return { ...t, id: `${t.sessionKey}#${n}`, box: zoom ? FULL : t.box, zoom, hidden: !!zoomed && !zoom };
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const shown = useRef<Map<string, Box> | null>(null);
  const resizing = useRef(false);
  const geometry = JSON.stringify(placed.map((t) => [t.id, t.box, t.hidden]));
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const next = new Map(placed.filter((t) => !t.hidden).map((t) => [t.id, t.box]));
    const prev = shown.current ?? (props.origin ? new Map([[`${props.origin}#0`, FULL]]) : null);
    shown.current = next;
    // A wholly different set of panes (another workspace) is a switch, not a move: the page slides instead.
    if (!prev || resizing.current || ![...next.keys()].some((id) => prev.has(id))) return;
    const { width, height } = root.getBoundingClientRect();
    const px = (b: Box) => ({ x: b.x * width, y: b.y * height, w: b.w * width, h: b.h * height });
    for (const el of root.querySelectorAll<HTMLElement>(':scope > .pane[data-tile]')) {
      const to = next.get(el.dataset.tile!);
      if (!to) continue;
      const from = prev.get(el.dataset.tile!);
      if (from) glide(el, px(from), px(to));
      else popIn(el);
    }
  }, [geometry]);

  const tiled = () => (
    <>
      {placed.map((t) =>
        <Fragment key={t.id}>
          {pane(t.sessionKey, t.path, {
            'data-tile': t.id,
            className: `${t.zoom ? 'zoomed' : ''} ${t.hidden ? 'stowed' : ''}`,
            style: place(t.box),
            inert: t.hidden || undefined,
          })}
        </Fragment>
      )}
      {!zoomed &&
        seams.map((s) => (
          <Divider
            key={s.path.join('/') || 'root'}
            seam={s}
            root={rootRef}
            onDrag={(on) => (resizing.current = on)}
            onRatio={(ratio) => props.onLayout(setRatio(layout, s.path, ratio))}
          />
        ))}
    </>
  );

  return (
    <div className="workspace">
      <div className="ws-bar">
        <span className="hint">
          {zoomed ? `Maximized · 1 of ${panes.length} panes` : `Split view · ${panes.length} pane${panes.length === 1 ? '' : 's'}`}
        </span>
        {zoomed && (
          <button className="btn ghost small" onClick={props.onUnzoom}>
            Show all panes
            <ShortcutHint id="maximize-pane" />
          </button>
        )}
        <span className="spacer" />
        <button className="btn ghost small" onClick={props.onExit}>
          Exit split
          <ShortcutHint id="exit-split" />
        </button>
      </div>
      {props.narrow ? (
        <div className="ws-tabs">
          <div className="seg-tabs" role="tablist">
            <Glide match=".on" className="thumb" />
            {panes.map((p) => (
              <button key={p.path.join('/')} role="tab" aria-selected={p === activeTab} className={p === activeTab ? 'on' : ''} onClick={() => {
                setTab(p.path.join('/'));
                props.onFocus(p.path);
              }}>
                {isPick(p.sessionKey) ? 'New pane' : (byKey.get(p.sessionKey)?.title ?? 'Ended')}
              </button>
            ))}
          </div>
          <div className="ws-tab-body">{activeTab && pane(activeTab.sessionKey, activeTab.path)}</div>
        </div>
      ) : (
        <div className="ws-root tiled" ref={rootRef}>
          {tiled()}
          {paneDrag && (
            <div className="dock-frame">
              {(['left', 'right', 'top', 'bottom'] as const).map((where) => (
                <div
                  key={where}
                  className={`dock-zone ${where}`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const from = panePath(e.dataTransfer.getData('text/ah-pane'));
                    setPaneDrag(null);
                    setDropPane(null);
                    if (from) dock(from, where);
                  }}
                >
                  {where === 'left' || where === 'right' ? 'Full height' : 'Full width'}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


const FULL: Box = { x: 0, y: 0, w: 1, h: 1 };

type Frame = { 'data-tile'?: string; 'data-pane'?: string; className?: string; style?: React.CSSProperties; inert?: boolean };

/** What takes the keyboard in a pane, best first: a field asked for, a chooser's filter, a composer, a terminal. */
const PANE_FOCUS = ['[data-autofocus]', '.pane-picker-filter', '.gui .composer textarea', '.xterm-helper-textarea', 'input:not([type="hidden"])', 'textarea', 'button'];

const pct = (n: number) => `${+(n * 100).toFixed(4)}%`;
const place = (b: Box): React.CSSProperties => ({ left: pct(b.x), top: pct(b.y), right: pct(1 - b.x - b.w), bottom: pct(1 - b.y - b.h) });

// Keyed by its split's path, so a drag keeps the same element while the layout updates.
function Divider({ seam, root, onDrag, onRatio }: { seam: Seam; root: React.RefObject<HTMLDivElement | null>; onDrag: (on: boolean) => void; onRatio: (ratio: number) => void }) {
  const { row, ratio, box } = seam;
  const dragging = useRef<number | null>(null);
  const at = row ? box.x + box.w * ratio : box.y + box.h * ratio;
  const style: React.CSSProperties = row ? { left: pct(at), top: pct(box.y), height: pct(box.h) } : { top: pct(at), left: pct(box.x), width: pct(box.w) };
  const stop = () => {
    dragging.current = null;
    onDrag(false);
  };
  return (
    <div
      className={`divider ${row ? 'v' : 'h'}`}
      style={style}
      // Focusable, so Tab reaches it and the arrows move it (Shift for big steps).
      tabIndex={0}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={15}
      aria-valuemax={85}
      aria-label="Resize panes"
      onKeyDown={(e) => {
        const back = row ? 'ArrowLeft' : 'ArrowUp';
        const fwd = row ? 'ArrowRight' : 'ArrowDown';
        if (e.key !== back && e.key !== fwd) return;
        e.preventDefault();
        onRatio(ratio + (e.key === fwd ? 1 : -1) * (e.shiftKey ? 0.15 : 0.05));
      }}
      onPointerDown={(e) => {
        dragging.current = e.pointerId;
        onDrag(true);
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (dragging.current !== e.pointerId || !root.current) return;
        // The pointer, as a fraction of the workspace, then of this split.
        const r = root.current.getBoundingClientRect();
        const along = row ? (e.clientX - r.left) / r.width : (e.clientY - r.top) / r.height;
        const span = row ? box.w : box.h;
        if (span > 0 && Number.isFinite(along)) onRatio((along - (row ? box.x : box.y)) / span);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
    />
  );
}
