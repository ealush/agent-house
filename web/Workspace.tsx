import { useRef, useState } from 'react';
import type { HostApi, SendResult, Win } from './api.ts';
import { Session } from './Session.tsx';
import { sortWindows } from './Sidebar.tsx';
import { cycleKey } from './keyboard.ts';
import { closeLeaf, paneLeaves, replaceLeaf, setRatio, splitLeaf, type LayoutNode, type Path } from './layout.ts';

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
  onSent: (r: SendResult) => void;
  onKilledSession: () => void;
  refresh: (host?: string) => void;
  onExit: () => void;
};

/**
 * Multi-session split view (F45/F46). Every pane is an independent
 * browser→PTY→tmux viewer onto its own window; tmux never splits.
 * Layout is device-local (localStorage); phone widths collapse to tabs.
 */
export function Workspace(props: Props) {
  const { layout, windows } = props;
  const [picking, setPicking] = useState<Path | null>(null);
  const [dropPane, setDropPane] = useState<string | null>(null);

  const byKey = new Map(windows.map((w) => [w.key, w]));
  const panes = paneLeaves(layout);
  const [tab, setTab] = useState('');
  const activeTab = panes.find((p) => p.path.join('/') === tab) ?? panes[0];

  function dropKey(e: React.DragEvent): string | null {
    // Sidebar rows set text/ah-session; fall back to plain text for other sources.
    return e.dataTransfer.getData('text/ah-session') || e.dataTransfer.getData('text/plain') || null;
  }

  function handleDrop(target: Path, where: 'left' | 'right' | 'top' | 'bottom' | 'center', key: string | null) {
    if (!key || !byKey.has(key)) return;
    if (where === 'center') props.onLayout(replaceLeaf(layout, target, key));
    else if (where === 'left') props.onLayout(splitLeaf(layout, target, 'horizontal', key, 'before'));
    else if (where === 'right') props.onLayout(splitLeaf(layout, target, 'horizontal', key, 'after'));
    else if (where === 'top') props.onLayout(splitLeaf(layout, target, 'vertical', key, 'before'));
    else props.onLayout(splitLeaf(layout, target, 'vertical', key, 'after'));
  }

  function pane(sessionKey: string, path: Path) {
    const w = byKey.get(sessionKey);
    const paneId = path.join('/');
    const focused = props.focusPath?.join('/') === paneId;
    if (!w) {
      // The session was terminated elsewhere: show the end state, keep history resumable.
      return (
        <div className="pane terminated" onClick={() => props.onFocus(path)}>
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
        className={`pane ${focused ? 'focused' : ''} ${dropPane === paneId ? 'dropping' : ''}`}
        onClick={() => props.onFocus(path)}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/ah-session') || e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault();
            setDropPane(paneId);
          }
        }}
        onDragLeave={() => setDropPane((k) => (k === paneId ? null : k))}
        onDrop={(e) => {
          e.preventDefault();
          setDropPane(null);
          handleDrop(path, 'center', dropKey(e));
        }}
      >
        <Session
          key={w.key}
          w={w}
          client={props.clientFor(w.host)}
          narrow={props.narrow}
          touch={props.touch}
          multiHost={props.multiHost}
          home={props.hostHome(w.host)}
          replyKey={props.replyKey}
          onBack={() => props.onLayout(closeLeaf(layout, path))}
          onAnswer={props.onAnswer}
          onSent={props.onSent}
          onKilled={() => {
            props.onKilledSession();
            props.refresh(w.host);
          }}
          refresh={() => props.refresh(w.host)}
          onSplit={(dir) => {
            // Second half starts on the most recent other session (or the same one twice).
            const other = windows.find((x) => x.key !== w.key)?.key ?? w.key;
            props.onLayout(splitLeaf(layout, path, dir === 'right' ? 'horizontal' : 'vertical', other));
          }}
          onOpenKey={(key) => {
            const hit = panes.find((p) => p.sessionKey === key);
            if (hit) props.onFocus(hit.path);
            else props.onLayout(replaceLeaf(layout, path, key));
          }}
          onCycleSession={(dir) => {
            const next = cycleKey(sortWindows(windows).map((x) => x.key), w.key, dir);
            if (next) props.onLayout(replaceLeaf(layout, path, next));
          }}
          onSplitWith={(key) => props.onLayout(splitLeaf(layout, path, 'horizontal', key))}
          onReplace={() => setPicking(path)}
          onClosePane={() => props.onLayout(closeLeaf(layout, path))}
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
                  handleDrop(path, where, dropKey(e));
                }}
              >
                {where === 'center' ? 'Replace' : `Drop ${where}`}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function node(n: LayoutNode, path: Path): React.ReactNode {
    if (n.type === 'session') return pane(n.sessionKey, path);
    const row = n.direction === 'horizontal';
    return (
      <div className={`split ${row ? 'row' : 'col'}`}>
        <div className="split-first" style={{ flexGrow: n.ratio, flexBasis: 0 }}>
          {node(n.first, [...path, 'first'])}
        </div>
        <Divider row={row} onRatio={(ratio) => props.onLayout(setRatio(layout, path, ratio))} />
        <div className="split-second" style={{ flexGrow: 1 - n.ratio, flexBasis: 0 }}>
          {node(n.second, [...path, 'second'])}
        </div>
      </div>
    );
  }

  return (
    <div className="workspace">
      <div className="ws-bar">
        <span className="hint">
          Split view · {panes.length} pane{panes.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <button className="btn ghost small" onClick={props.onExit}>
          Exit split
        </button>
      </div>
      {props.narrow ? (
        <div className="ws-tabs">
          <div className="seg-tabs" role="tablist">
            {panes.map((p) => (
              <button key={p.path.join('/')} role="tab" aria-selected={p === activeTab} className={p === activeTab ? 'on' : ''} onClick={() => {
                setTab(p.path.join('/'));
                props.onFocus(p.path);
              }}>
                {byKey.get(p.sessionKey)?.title ?? 'Ended'}
              </button>
            ))}
          </div>
          <div className="ws-tab-body">{activeTab && pane(activeTab.sessionKey, activeTab.path)}</div>
        </div>
      ) : (
        <div className="ws-root">{node(layout, [])}</div>
      )}
      {picking && (
        <div className="picker-veil" onClick={() => setPicking(null)}>
          <div className="menu picker" onClick={(e) => e.stopPropagation()}>
            {windows.map((w) => (
              <button
                key={w.key}
                onClick={() => {
                  props.onLayout(replaceLeaf(layout, picking, w.key));
                  setPicking(null);
                }}
              >
                {w.title} · {w.project}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// Keep the component identity stable while a drag updates the layout.
function Divider({ row, onRatio }: { row: boolean; onRatio: (ratio: number) => void }) {
  const dragging = useRef<number | null>(null);
  return (
    <div
      className={`divider ${row ? 'v' : 'h'}`}
      onPointerDown={(e) => {
        dragging.current = e.pointerId;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (dragging.current !== e.pointerId) return;
        const rect = e.currentTarget.parentElement!.getBoundingClientRect();
        const size = row ? rect.width : rect.height;
        if (size > 0) onRatio(row ? (e.clientX - rect.left) / size : (e.clientY - rect.top) / size);
      }}
      onPointerUp={() => { dragging.current = null; }}
      onPointerCancel={() => { dragging.current = null; }}
      onLostPointerCapture={() => { dragging.current = null; }}
    />
  );
}
