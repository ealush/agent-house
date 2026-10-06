import { useState } from 'react';
import type { State, Win } from './api.ts';
import { askConfirm } from './ask.tsx';
import { Icon } from './icons.tsx';
import { look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';

export type Page = 'inbox' | 'history' | 'sessions' | 'settings';

type Props = {
  state: State | null;
  error: string | null;
  page: Page;
  selected: string | null;
  /** Every session key currently on screen: one in single view, all panes in split view. */
  visibleKeys: string[];
  device: string;
  onPage: (p: Page) => void;
  onSelect: (key: string) => void;
  onSearch: () => void;
  /** Open the new-session dialog. A project passes its directory and machine. */
  onNew: (where?: { cwd: string; host: string }) => void;
  onWorktrees: () => void;
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
export function confirmTerminate(w: Win) {
  const hot = w.status === 'busy' || w.status === 'waiting' || w.queued > 0;
  const why = w.status === 'waiting' ? 'is waiting for your input' : w.status === 'busy' ? 'is currently working' : `has ${w.queued} queued message${w.queued === 1 ? '' : 's'}`;
  return askConfirm({
    title: `Terminate "${w.title}"?`,
    body: hot ? `It ${why}. The running process will be stopped.` : 'The session will be stopped.',
    confirm: 'Terminate',
    danger: true,
  });
}

/** Desktop navigation: inbox, hosts, and every live session grouped by host (or project). */
export function Sidebar({ state, error, page, selected, visibleKeys, device, onPage, onSelect, onSearch, onNew, onWorktrees, onReorder, onKill, onDragSession, onCollapse }: Props) {
  const windows = state?.windows ?? [];
  const visible = new Set(visibleKeys);
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
    const active = w.key === selected;
    const seen = visible.has(w.key);
    return (
      <div
        key={w.key}
        className={`side-row ${overKey === w.key ? 'drop' : ''} ${dragKey === w.key ? 'dragging' : ''}`}
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
        <button className={`side-session ${w.agent ? '' : 'shellish'}${active ? ' on' : ''}${seen && !active ? ' visible' : ''}`} style={{ '--agent': color } as React.CSSProperties} onClick={() => onSelect(w.key)} aria-current={active ? true : undefined} title={`${w.title} — ${w.cwd}${modelLabel ? ` — ${modelLabel}` : ''}${w.launch ? ` — ${w.launch}` : ''}`}>
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
          {w.fork && (
            <span className="count" title={w.fork.parentTitle ? `Fork of ${w.fork.parentTitle}` : `${w.fork.forks} fork${w.fork.forks === 1 ? '' : 's'}`}>
              ⑂{w.fork.forks > 0 ? w.fork.forks : ''}
            </span>
          )}
          {w.queued > 0 && <span className="count">⇥{w.queued}</span>}
        </button>
        <button
          className="row-kill"
          title={`Terminate session (kill ${w.id})`}
          aria-label={`Terminate ${w.title}`}
          onClick={(e) => {
            e.stopPropagation();
            void confirmTerminate(w).then((ok) => {
              if (ok) onKill(w);
            });
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
                void confirmTerminate(w).then((ok) => {
                  if (ok) onKill(w);
                });
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

      <button className={`nav-item ${page === 'settings' && !selected ? 'on' : ''}`} onClick={() => onPage('settings')}>
        <Icon name="gear" />
        <span className="grow">Settings</span>
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
              {!multiHost && (
                <button
                  type="button"
                  className="label-add"
                  title={`New session in ${group}`}
                  aria-label={`New session in ${group}`}
                  onClick={() => {
                    const home = ws.find((w) => !w.worktree) ?? ws[0];
                    onNew({ cwd: home.projectPath, host: home.host });
                  }}
                >
                  <Icon name="plus" size={12} />
                </button>
              )}
            </div>
            {ws.map((w) => row(w, ws))}
          </section>
        ))}
      </div>

      <footer className="side-foot">
        <button className="btn block" onClick={() => onNew()}>
          New session
        </button>
        <div className="row-btns">
          <button className="btn ghost small" onClick={onWorktrees}>
            <Icon name="branch" size={14} /> Worktrees
          </button>
        </div>
      </footer>
    </nav>
  );
}

const ORDER = { waiting: 0, busy: 1, attention: 2, idle: 3 };
const rank = (w: Win) => ORDER[w.status];
