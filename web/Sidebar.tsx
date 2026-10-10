import { useState } from 'react';
import type { State, Win } from './api.ts';
import { askConfirm } from './ask.tsx';
import { Icon } from './icons.tsx';
import { look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { useSavedGroups, setGroupList } from './groupOrder.ts';
import { movedSessionOrders, saveGroupMove, sidebarSections } from './sessionOrder.ts';
import { runCommand, type CommandId } from './shortcuts.ts';
import { ShortcutHint, shortcutTitle, useShortcutRevision } from './shortcuts.tsx';

export type Page = 'inbox' | 'history' | 'sessions' | 'settings' | 'search';

type Props = {
  /** Workspaces 1–9: where you are, and which hold something. */
  workspaces?: { current: number; used: number[] };
  onWorkspace?: (n: number) => void;
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
  /** Fork the live session into a fresh worktree (F36). */
  onFork?: (w: Win) => void;
  /** Start dragging a session toward a split pane (F46). */
  onDragSession?: (w: Win) => void;
  /** Collapse the sidebar into a rail. */
  onCollapse: () => void;
};

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
export function Sidebar({ workspaces, onWorkspace, state, error, page, selected, visibleKeys, device, onPage, onSelect, onSearch, onNew, onWorktrees, onReorder, onKill, onFork, onDragSession, onCollapse }: Props) {
  useShortcutRevision();
  const windows = state?.windows ?? [];
  const visible = new Set(visibleKeys);
  const waiting = windows.filter((w) => w.status === 'waiting').length;
  const multiHost = (state?.hosts.length ?? 0) > 1;
  const savedGroups = useSavedGroups(multiHost);
  const [drag, setDrag] = useState<{ kind: 'session'; key: string } | { kind: 'group'; id: string } | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [overAfter, setOverAfter] = useState(false);
  const [overGroup, setOverGroup] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);

  const sections = sidebarSections(windows, multiHost, savedGroups);

  function lowerHalf(e: React.DragEvent<HTMLElement>) {
    const box = e.currentTarget.getBoundingClientRect();
    return e.clientY >= box.top + box.height / 2;
  }

  function dropSession(group: Win[], target: Win, after: boolean) {
    if (drag?.kind !== 'session') return;
    // Cross-group drags never mutate project/host metadata (F43 v1): ignore them.
    if (!group.some((w) => w.key === drag.key) || drag.key === target.key) return;
    for (const change of movedSessionOrders(group, drag.key, target.key, after)) {
      const row = group.find((w) => w.key === change.key);
      if (row) onReorder(row.uid, row.host, change.order);
    }
  }

  /** Keyboard reorder (Alt+Shift+↑/↓ on a focused row): one place up or down within its group. */
  function nudgeSession(group: Win[], w: Win, dir: -1 | 1) {
    const at = group.findIndex((x) => x.key === w.key);
    const target = group[at + dir];
    if (!target) return;
    for (const change of movedSessionOrders(group, w.key, target.key, dir > 0)) {
      const row = group.find((x) => x.key === change.key);
      if (row) onReorder(row.uid, row.host, change.order);
    }
  }

  function dropGroup(targetId: string, after: boolean) {
    if (drag?.kind !== 'group' || drag.id === targetId) return;
    setGroupList(multiHost ? 'host' : 'project', saveGroupMove(sections.map((section) => section.id), savedGroups, drag.id, targetId, after));
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
        className={`side-row ${overKey === w.key ? (overAfter ? 'drop-after' : 'drop') : ''} ${drag?.kind === 'session' && drag.key === w.key ? 'dragging' : ''}`}
        draggable
        onDragStart={(e) => {
          setDrag({ kind: 'session', key: w.key });
          onDragSession?.(w);
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/ah-session', w.key);
        }}
        onDragEnd={() => {
          setDrag(null);
          setOverKey(null);
          setOverGroup(null);
        }}
        onDragOver={(e) => {
          if (drag?.kind === 'group') return;
          if (drag?.kind === 'session' && drag.key !== w.key) {
            e.preventDefault();
            e.stopPropagation();
            setOverKey(w.key);
            setOverAfter(lowerHalf(e));
          }
        }}
        onDragLeave={() => setOverKey((k) => (k === w.key ? null : k))}
        onDrop={(e) => {
          if (drag?.kind === 'group') return;
          e.preventDefault();
          e.stopPropagation();
          setOverKey(null);
          dropSession(group, w, lowerHalf(e));
        }}
      >
        <button
          className={`side-session ${w.agent ? '' : 'shellish'}${active ? ' on' : ''}${seen && !active ? ' visible' : ''}`}
          style={{ '--agent': color } as React.CSSProperties}
          onClick={() => onSelect(w.key)}
          onKeyDown={(e) => {
            if (!e.altKey || !e.shiftKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
            e.preventDefault();
            nudgeSession(group, w, e.key === 'ArrowUp' ? -1 : 1);
          }} aria-current={active ? true : undefined} title={`${w.title} — ${w.cwd}${modelLabel ? ` — ${modelLabel}` : ''}${w.launch ? ` — ${w.launch}` : ''}`}>
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
            {onFork && w.agent && (
              <button
                onClick={() => {
                  setMenuKey(null);
                  onFork(w);
                }}
              >
                Fork session…
              </button>
            )}
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
    <nav
      className="sidebar"
      data-rove="button.nav-item, button.side-session"
      onKeyDown={(e) => {
        // Escape hands the keyboard back to the open session.
        if (e.key === 'Escape' && (e.target as HTMLElement).closest('.side-session, .nav-item')) {
          e.preventDefault();
          runCommand('focus-main');
        }
      }}
    >
      <div className="brand">
        <span className="logo">&gt;_</span>
        <span className="brand-name">ah</span>
        <span className="host-pill" title="This device">
          <span className="dot online" /> {device}
        </span>
        <button className="icon-btn small" onClick={onCollapse} title={shortcutTitle('Hide sidebar', 'toggle-sidebar')} aria-label="Hide sidebar">
          <Icon name="panel-hide" />
        </button>
      </div>

      {/* Like Omarchy's bar: shown once a second workspace is in use. */}
      {workspaces && (workspaces.current !== 1 || workspaces.used.some((n) => n !== workspaces.current)) && (
        <div className="ws-dots" role="group" aria-label="Workspaces">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9]
            .filter((n) => n === workspaces.current || workspaces.used.includes(n))
            .map((n) => (
              <button
                key={n}
                className={n === workspaces.current ? 'on' : ''}
                aria-current={n === workspaces.current ? true : undefined}
                title={shortcutTitle(`Workspace ${n}`, `workspace-${n}` as CommandId)}
                onClick={() => onWorkspace?.(n)}
              >
                {n}
              </button>
            ))}
        </div>
      )}

      <button className="search" onClick={onSearch}>
        <Icon name="search" size={15} />
        <span>Search or jump to</span>
        <ShortcutHint id="switcher" />
      </button>

      <button className={`nav-item ${page === 'inbox' && !selected ? 'on' : ''}`} title={shortcutTitle('Inbox', 'go-inbox')} onClick={() => onPage('inbox')}>
        <Icon name="inbox" />
        <span className="grow">Inbox</span>
        {waiting > 0 ? <span className="badge">{waiting}</span> : <span className="count">{windows.length}</span>}
      </button>
      <button className={`nav-item ${page === 'history' && !selected ? 'on' : ''}`} title={shortcutTitle('History', 'go-history')} onClick={() => onPage('history')}>
        <Icon name="history" />
        <span className="grow">History</span>
        <span className="count">{state?.history.length ?? ''}</span>
      </button>

      <button className={`nav-item ${page === 'settings' && !selected ? 'on' : ''}`} title={shortcutTitle('Settings', 'go-settings')} onClick={() => onPage('settings')}>
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
        {sections.map((section) => {
          const group = section.id;
          const ws = section.windows;
          const dragging = drag?.kind === 'group' && drag.id === group;
          const over = overGroup === group && !dragging;
          return (
            <section
              key={group}
              className={`side-block${dragging ? ' dragging' : ''}${over ? (overAfter ? ' drop-after' : ' drop') : ''}`}
              onDragOver={(e) => {
                if (drag?.kind !== 'group' || drag.id === group) return;
                e.preventDefault();
                setOverGroup(group);
                setOverAfter(lowerHalf(e));
              }}
              onDrop={(e) => {
                if (drag?.kind !== 'group') return;
                e.preventDefault();
                setOverGroup(null);
                dropGroup(group, lowerHalf(e));
              }}
            >
              <div
                className={`side-label ${multiHost ? 'host' : ''}`}
                draggable
                onDragStart={(e) => {
                  setDrag({ kind: 'group', id: group });
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/ah-group', group);
                }}
                onDragEnd={() => {
                  setDrag(null);
                  setOverGroup(null);
                }}
              >
                <span className="grip" title="Drag to reorder" aria-hidden>
                  ⠿
                </span>
                {multiHost && <span className="dot online" />}
                <span className="grow">{group}</span>
                {!multiHost && (
                  <button
                    type="button"
                    className="label-add"
                    title={`New session in ${group}`}
                    aria-label={`New session in ${group}`}
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
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
          );
        })}
      </div>

      <footer className="side-foot">
        <button className="btn block" onClick={() => onNew()} title={shortcutTitle('New session', 'new-session')}>
          <span>New session</span>
          <ShortcutHint id="new-session" />
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

