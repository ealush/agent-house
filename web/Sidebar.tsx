import { useState } from 'react';
import type { State, Win } from './api.ts';
import { Icon } from './icons.tsx';
import { look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';

export type Page = 'inbox' | 'history' | 'sessions' | 'security';

type Props = {
  state: State | null;
  error: string | null;
  page: Page;
  selected: string | null;
  device: string;
  onPage: (p: Page) => void;
  onSelect: (key: string) => void;
  onSearch: () => void;
  onNew: () => void;
  onWorktrees: () => void;
  onNotify: (() => void) | null;
  /** Persist a sparse order key (F43). */
  onReorder: (uid: string, host: string, order: number) => void;
  /** Terminate the live session (F44). */
  onKill: (w: Win) => void;
  /** Start dragging a session toward a split pane (F46). */
  onDragSession?: (w: Win) => void;
  /** Collapse the sidebar into a rail. */
  onCollapse: () => void;
};

/** Sort: pinned first, then manual order, then status/activity for never-arranged rows. */
export function sortWindows(windows: Win[]): Win[] {
  return [...windows].sort((a, b) => {
    if (Number(b.pinned) !== Number(a.pinned)) return Number(b.pinned) - Number(a.pinned);
    if (a.order != null && b.order != null) return a.order - b.order;
    if (a.order != null) return -1;
    if (b.order != null) return 1;
    return rank(a) - rank(b) || b.activity - a.activity;
  });
}

/** Sparse key between two neighbors: midpoint, or ±100 at the ends. */
export function orderBetween(before: number | null, after: number | null): number {
  if (before == null && after == null) return 100;
  if (before == null) return after! - 100;
  if (after == null) return before + 100;
  if (after - before < 0.001) return before + 0.5; // degenerate: still lands between
  return (before + after) / 2;
}

/** Terminate means killing the tmux window, not forgetting history (F44). */
export function terminatePrompt(w: Win): string {
  const hot = w.status === 'busy' || w.status === 'waiting' || w.queued > 0;
  if (hot) {
    const why = w.status === 'waiting' ? 'is waiting for your input' : w.status === 'busy' ? 'is currently working' : `has ${w.queued} queued message${w.queued === 1 ? '' : 's'}`;
    return `Terminate "${w.title}"?\n\nIt ${why}.\nThe running process will be stopped.`;
  }
  return `Terminate "${w.title}"? The session will be stopped.`;
}

/** Desktop navigation: inbox, hosts, and every live session grouped by host (or project). */
export function Sidebar({ state, error, page, selected, device, onPage, onSelect, onSearch, onNew, onWorktrees, onNotify, onReorder, onKill, onDragSession, onCollapse }: Props) {
  const windows = state?.windows ?? [];
  const waiting = windows.filter((w) => w.status === 'waiting').length;
  const multiHost = (state?.hosts.length ?? 0) > 1;
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);

  const groups = new Map<string, Win[]>();
  for (const w of sortWindows(windows)) {
    const k = multiHost ? w.host : w.project;
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }

  function dropOnto(group: Win[], target: Win) {
    if (!dragKey) return;
    const dragged = group.find((w) => w.key === dragKey);
    // Cross-group drags never mutate project/host metadata (F43 v1): ignore them.
    if (!dragged || dragged.key === target.key) return;
    const rest = group.filter((w) => w.key !== dragKey);
    const idx = rest.findIndex((w) => w.key === target.key);
    const before = idx > 0 ? rest[idx - 1].order : null;
    const after = rest[idx]?.order ?? null;
    onReorder(dragged.uid, dragged.host, orderBetween(before, after));
  }

  function row(w: Win, group: Win[]) {
    const menu = menuKey === w.key;
    const { color } = look(w.agent);
    const modelLabel = shortModel(w.model);
    return (
      <div
        key={w.key}
        className={`side-row ${w.key === selected ? 'on' : ''} ${overKey === w.key ? 'drop' : ''} ${dragKey === w.key ? 'dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          setDragKey(w.key);
          onDragSession?.(w);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/ah-session', w.key);
        }}
        onDragEnd={() => {
          setDragKey(null);
          setOverKey(null);
        }}
        onDragOver={(e) => {
          if (dragKey && dragKey !== w.key) {
            e.preventDefault();
            setOverKey(w.key);
          }
        }}
        onDragLeave={() => setOverKey((k) => (k === w.key ? null : k))}
        onDrop={(e) => {
          e.preventDefault();
          setOverKey(null);
          dropOnto(group, w);
        }}
      >
        <button className={`side-session ${w.agent ? '' : 'shellish'}`} style={{ '--agent': color } as React.CSSProperties} onClick={() => onSelect(w.key)} title={`${w.title} — ${w.cwd}${modelLabel ? ` — ${modelLabel}` : ''}${w.launch ? ` — ${w.launch}` : ''}`}>
          <span className="grip" aria-hidden>
            ⠿
          </span>
          <span className="chip sm">
            <AgentLogo id={w.agent} size={13} />
          </span>
          <span className={`dot ${w.status}`} />
          <span className="name">
            {w.pinned ? '★ ' : ''}
            {w.agent ? w.title : `${w.title === w.command || w.title === 'shell' ? w.command : w.title} ${w.cwd}`}
          </span>
          {modelLabel && <span className="side-model">{modelLabel}</span>}
          {w.queued > 0 && <span className="count">⇥{w.queued}</span>}
        </button>
        <button
          className="row-kill"
          title={`Terminate session (kill ${w.id})`}
          aria-label={`Terminate ${w.title}`}
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(terminatePrompt(w))) onKill(w);
          }}
        >
          <Icon name="trash" size={14} />
        </button>
        <button className="row-more" aria-label={`Actions for ${w.title}`} aria-expanded={menu} onClick={() => setMenuKey(menu ? null : w.key)}>
          <Icon name="more" size={14} />
        </button>
        {menu && (
          <div className="menu row-menu" onMouseLeave={() => setMenuKey(null)}>
            <button
              onClick={() => {
                setMenuKey(null);
                onSelect(w.key);
              }}
            >
              Open
            </button>
            <button
              className="danger"
              onClick={() => {
                setMenuKey(null);
                if (confirm(terminatePrompt(w))) onKill(w);
              }}
            >
              Terminate session
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="logo">&gt;_</span>
        <span className="brand-name">ah</span>
        <span className="host-pill" title="This device">
          <span className="dot online" /> {device}
        </span>
        <button className="icon-btn small" onClick={onCollapse} title="Hide sidebar" aria-label="Hide sidebar">
          <Icon name="panel-hide" />
        </button>
      </div>

      <button className="search" onClick={onSearch}>
        <Icon name="search" size={15} />
        <span>Search or jump to</span>
        <kbd>⌘K</kbd>
      </button>

      <button className={`nav-item ${page === 'inbox' && !selected ? 'on' : ''}`} onClick={() => onPage('inbox')}>
        <Icon name="inbox" />
        <span className="grow">Inbox</span>
        {waiting > 0 ? <span className="badge">{waiting}</span> : <span className="count">{windows.length}</span>}
      </button>
      <button className={`nav-item ${page === 'history' && !selected ? 'on' : ''}`} onClick={() => onPage('history')}>
        <Icon name="history" />
        <span className="grow">History</span>
        <span className="count">{state?.history.length ?? ''}</span>
      </button>

      <button className={`nav-item ${page === 'security' && !selected ? 'on' : ''}`} onClick={() => onPage('security')}>
        <Icon name="shield" />
        <span className="grow">Security</span>
      </button>

      <div className="side-scroll">
        {error && <div className="side-error">Can't reach server: {error}</div>}
        {multiHost && (
          <>
            <div className="side-label">
              <span className="grow">Hosts</span>
            </div>
            {state!.hosts.map((h) => (
              <div key={h.name} className="nav-item" style={{ cursor: 'default' }}>
                <span className={`dot ${h.online ? 'online' : 'offline'}`} />
                <span className="grow mono">{h.name}</span>
                <span className="count">{h.online ? `${windows.filter((w) => w.host === h.name).length} live` : 'offline'}</span>
              </div>
            ))}
          </>
        )}
        {[...groups.entries()].map(([group, ws]) => (
          <section key={group}>
            <div className={`side-label ${multiHost ? 'host' : ''}`}>
              {multiHost && <span className="dot online" />}
              <span className="grow">{group}</span>
            </div>
            {ws.map((w) => row(w, ws))}
          </section>
        ))}
      </div>

      <footer className="side-foot">
        <button className="btn block" onClick={onNew}>
          New session
        </button>
        <div className="row-btns">
          <button className="btn ghost small" onClick={onWorktrees}>
            <Icon name="branch" size={14} /> Worktrees
          </button>
          {onNotify && (
            <button className="btn ghost small" onClick={onNotify}>
              <Icon name="bell" size={14} /> Notifications
            </button>
          )}
        </div>
      </footer>
    </nav>
  );
}

const ORDER = { waiting: 0, busy: 1, attention: 2, idle: 3 };
const rank = (w: Win) => ORDER[w.status];
