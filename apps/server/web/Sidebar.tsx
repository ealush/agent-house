import { useNotes } from './useNotes.ts';
import { useEffect, useRef, useState } from 'react';
import { contextMenu, useFitMenu } from './contextMenu.ts';
import type { State, Win } from './api.ts';
import { askConfirm } from './ask.tsx';
import { AhMark, Icon } from './icons.tsx';
import { Reveal } from './Handoff.tsx';
import { look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { useSavedGroups, setGroupList } from './groupOrder.ts';
import { movedSessionOrders, saveGroupMove, sidebarSections } from './sessionOrder.ts';
import { commandLabel, isMac, runCommand, runCommandSoon, type CommandId } from './shortcuts.ts';
import { ShortcutHint, shortcutTitle, useShortcutRevision } from './shortcuts.tsx';
import { Glide } from './Glide.tsx';
import { useFlip } from './useFlip.ts';
import { useDismiss } from './useDismiss.ts';
import { copySessionLink } from './selection.ts';

export type Page = 'inbox' | 'settings' | 'review' | 'notes' | 'jobs' | 'usage';

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
  /** Create a folder and start a session in it. */
  onNewProject: () => void;
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
  /** Continue a session from another device (Handoff), when there is one. */
  handoff?: React.ReactNode;
};

/** Terminate means killing the tmux window, not forgetting history (F44). */
export function confirmTerminate(w: Win) {
  const hot = w.status === 'busy' || w.status === 'waiting' || w.queued > 0;
  const why = w.status === 'waiting' ? 'is waiting for your input' : w.status === 'busy' ? 'is currently working' : `has ${w.queued} queued message${w.queued === 1 ? '' : 's'}`;
  return askConfirm({
    title: `Terminate "${w.title}"?`,
    // Say what survives: an agent's conversation can be picked up again; a shell's processes can't.
    body: (w.agent
      ? `${hot ? `It ${why}, and will be stopped.` : 'The agent will be stopped.'} Its conversation stays in History, and Resume picks it up again.`
      : `${hot ? `It ${why}. ` : ''}The shell and anything running in it will be stopped.`) + (w.terminal ? ' Its attached terminal and anything running in it will also stop.' : ''),
    confirm: 'Terminate',
    danger: true,
  });
}

/** Desktop navigation: inbox, hosts, and every live session grouped by host (or project). */
/** A shell's folder inside its project ("web/gui"), or "" at the project root. */
const lastFolder = (path: string) => (path.includes('/') ? `…/${path.replace(/\/+$/, '').split('/').pop()}` : path);

function subdir(w: Win): string {
  if (w.cwd === w.projectPath) return '';
  return w.cwd.startsWith(`${w.projectPath}/`) ? w.cwd.slice(w.projectPath.length + 1) : w.cwd;
}

export function Sidebar({ workspaces, onWorkspace, state, error, page, selected, visibleKeys, device, onPage, onSelect, onSearch, onNew, onNewProject, onWorktrees, onReorder, onKill, onFork, onDragSession, onCollapse, handoff }: Props) {
  useShortcutRevision();
  const windows = state?.windows ?? [];
  const visible = new Set(visibleKeys);
  const waiting = windows.filter((w) => w.status === 'waiting').length;
  // This browser's notes (web/notes.ts): the count follows what's on the device.
  const notes = useNotes().list().length;
  const multiHost = (state?.hosts.length ?? 0) > 1;
  const savedGroups = useSavedGroups(multiHost);
  const [drag, setDrag] = useState<{ kind: 'session'; key: string } | { kind: 'group'; id: string } | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const [overAfter, setOverAfter] = useState(false);
  const [overGroup, setOverGroup] = useState<string | null>(null);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const menuRow = useRef<HTMLDivElement>(null);
  useDismiss(menuKey !== null, menuRow, () => setMenuKey(null));
  const rowMenuEl = useRef<HTMLDivElement>(null);
  useFitMenu(rowMenuEl, menuKey !== null);

  const sections = sidebarSections(windows, multiHost, savedGroups);
  const flip = useFlip<HTMLDivElement>(sections.map((s) => `${s.id}:${s.windows.map((w) => w.key).join(',')}`).join('|'));

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

  // Each session's status as last drawn, so a dot can tell a change from a first draw.
  const shown = useRef(new Map<string, string>());
  // The status each dot last popped for: kept while it lasts, so a re-render can't cut the pop short.
  const popped = useRef(new Map<string, string>());
  useEffect(() => {
    for (const w of state?.windows ?? []) shown.current.set(w.key, w.status);
  });

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
    // The dot pops when the status changes, not every time the sidebar draws it.
    if (shown.current.has(w.key) && shown.current.get(w.key) !== w.status) popped.current.set(w.key, w.status);
    const pop = popped.current.get(w.key) === w.status;
    const { color } = look(w.agent);
    const modelLabel = shortModel(w.model);
    const active = w.key === selected;
    const seen = visible.has(w.key);
    // Its ··· menu, from a secondary click or a finger held on the row too.
    const press = contextMenu(() => setMenuKey(w.key));
    return (
      <div
        key={w.key}
        ref={menu ? menuRow : undefined}
        data-flip={w.key}
        className={`side-row ${overKey === w.key ? (overAfter ? 'drop-after' : 'drop') : ''} ${drag?.kind === 'session' && drag.key === w.key ? 'dragging' : ''}`}
        {...press}
        draggable
        onDragStart={(e) => {
          press.onDragStart();
          setMenuKey(null);
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
          <span key={w.status} className={`dot ${w.status} ${pop ? 'pop' : ''}`} />
          <span className="name">
            {w.pinned ? '★ ' : ''}
            {w.agent ? w.title : w.title === 'shell' ? w.command : w.title}
          </span>
          {/* The model is in the title's tooltip and the session's header: the row keeps its room for the title. */}
          {/* The group already names the project; a shell elsewhere in it says where. */}
          {/* Its last folder ("…/components"): the end of a path is the part that tells them apart. */}
          {!w.agent && subdir(w) && <span className="side-model mono" title={subdir(w)}>{lastFolder(subdir(w))}</span>}
          {w.fork && (
            <span className="count" title={w.fork.parentTitle ? `Fork of ${w.fork.parentTitle}` : `${w.fork.forks} fork${w.fork.forks === 1 ? '' : 's'}`}>
              ⑂{w.fork.forks > 0 ? w.fork.forks : ''}
            </span>
          )}
          {w.queued > 0 && <span className="count">⇥{w.queued}</span>}
          {w.terminal && <span className={`terminal-indicator${w.terminal.busy ? ' busy' : ''}`} title={w.terminal.busy ? `Attached terminal running ${w.terminal.command}` : 'Terminal attached'} aria-label={w.terminal.busy ? 'Attached terminal active' : 'Terminal attached'}><Icon name="terminal" size={13} /></span>}
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
          <div className="menu row-menu" ref={rowMenuEl} onMouseLeave={() => setMenuKey(null)}>
            {/* The session menu's own rows and words: opening the session, then the command, as its ··· would. */}
            <button
              onClick={() => {
                setMenuKey(null);
                onSelect(w.key);
              }}
            >
              Open
            </button>
            {(['panel-terminal', 'rename', 'pin', ...(w.agent ? (['send-to'] as const) : [])] as const).map((id) => (
              <button
                key={id}
                onClick={() => {
                  setMenuKey(null);
                  onSelect(w.key);
                  runCommandSoon(id);
                }}
              >
                {id === 'pin' && w.pinned ? 'Unpin' : commandLabel(id)}
              </button>
            ))}
            {/* To paste into another session's box. */}
            <button
              onClick={() => {
                setMenuKey(null);
                copySessionLink(w.key);
              }}
            >
              Copy Link
            </button>
            {onFork && w.agent && (
              <button
                onClick={() => {
                  setMenuKey(null);
                  onFork(w);
                }}
              >
                {commandLabel('fork')}
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
              {commandLabel('terminate')}
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
        // Escape hands the keyboard back to the open session. Slid over the page, it puts the
        // sidebar away instead (useSideSwipe), and focus goes back with it (App).
        if (e.key === 'Escape' && (e.target as HTMLElement).closest('.side-session, .nav-item') && !(e.target as HTMLElement).closest('.side-over')) {
          e.preventDefault();
          runCommand('focus-main');
        }
      }}
    >
      <div className="brand">
        <span className="logo"><AhMark /></span>
        <span className="brand-name">ah</span>
        {/* The machine ah runs on, and whether this device is connected to it right now. */}
        <span className="host-pill" title={error ? `Can't reach ${state?.hostname ?? 'the host'}: ${error}` : `Connected to ${state?.hostname ?? 'the host'} from this ${device}`}>
          <span key={error ? 'off' : 'on'} className={`dot ${error ? 'offline' : 'online'}`} /> {state?.hostname ?? device}
        </span>
        <button className="icon-btn small" onClick={onCollapse} title={shortcutTitle('Hide sidebar', 'toggle-sidebar')} aria-label="Hide sidebar">
          <Icon name="panel-hide" />
        </button>
      </div>

      {/* Like Omarchy's bar: shown once a second workspace is in use. */}
      {workspaces && (workspaces.current !== 1 || workspaces.used.some((n) => n !== workspaces.current)) && (
        <div className="ws-dots" role="group" aria-label="Workspaces">
          <Glide match=".on" className="ws-glide" />
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

      {/* Off a Mac the chord is three worded caps: they show when the field is reached for, so the label keeps its room. */}
      <button className="search" data-wordy={!isMac() || undefined} title={shortcutTitle(commandLabel('switcher'), 'switcher')} onClick={onSearch}>
        <Icon name="search" size={15} />
        <span>{commandLabel('switcher')}</span>
        <ShortcutHint id="switcher" />
      </button>

      <Reveal>{handoff}</Reveal>

      <div className="side-nav">
      <Glide match=".nav-item.on" className="side-glide" />
      <button className={`nav-item ${page === 'inbox' && !selected ? 'on' : ''}`} title={shortcutTitle('Inbox', 'go-inbox')} onClick={() => onPage('inbox')}>
        <Icon name="inbox" />
        <span className="grow">Inbox</span>
        {/* No count at nothing, as a Mac sidebar's: an empty list says "0" by being empty. */}
        {waiting > 0 ? <span className="badge">{waiting}</span> : windows.length > 0 && <span className="count">{windows.length}</span>}
      </button>
      <button className={`nav-item ${page === 'review' && !selected ? 'on' : ''}`} title={shortcutTitle('Review', 'go-review')} onClick={() => onPage('review')}>
        <Icon name="stack" />
        <span className="grow">Review</span>
        {(state?.review?.alerts.length ?? 0) > 0 && <span className="badge">{state!.review!.alerts.length}</span>}
      </button>
      {(state?.features?.notes ?? 0) > 0 && (
        <button className={`nav-item ${page === 'notes' && !selected ? 'on' : ''}`} title={shortcutTitle('Notes', 'go-notes')} onClick={() => onPage('notes')}>
          <Icon name="note" />
          <span className="grow">Notes</span>
          {notes > 0 && <span className="count">{notes}</span>}
        </button>
      )}
      {(state?.features?.jobs ?? 0) > 0 && (
        <button className={`nav-item ${page === 'jobs' && !selected ? 'on' : ''}`} title={shortcutTitle('Jobs', 'go-jobs')} onClick={() => onPage('jobs')}>
          <Icon name="queue" />
          <span className="grow">Jobs</span>
          {(state?.jobs?.waiting.length ?? 0) > 0 ? <span className="badge">{state!.jobs!.waiting.length}</span> : (state?.jobs?.running.length ?? 0) > 0 && <span className="count">{state!.jobs!.running.length}</span>}
        </button>
      )}
      {(state?.features?.usage ?? 0) > 0 && (
        <button className={`nav-item ${page === 'usage' && !selected ? 'on' : ''}`} title={shortcutTitle('Usage', 'go-usage')} onClick={() => onPage('usage')}>
          <Icon name="effort" />
          <span className="grow">Usage</span>
        </button>
      )}

      <button className={`nav-item ${page === 'settings' && !selected ? 'on' : ''}`} title={shortcutTitle('Settings', 'go-settings')} onClick={() => onPage('settings')}>
        <Icon name="gear" />
        <span className="grow">Settings</span>
      </button>
      </div>

      <div className="side-scroll" ref={flip}>
        <Glide match=".side-session.on" className="side-glide accent" />
        {error && <div className="side-error" role="status">{error}</div>}
        {multiHost && (
          <>
            <div className="side-label">
              <span className="grow">Hosts</span>
            </div>
            {state!.hosts.map((h) => (
              <div key={h.name} className="nav-item" style={{ cursor: 'default' }}>
                <span className={`dot ${h.online ? 'online' : 'offline'}`} />
                <span className="grow mono">{h.name}</span>
                <span className="count">{h.online ? windows.filter((w) => w.host === h.name).length : 'offline'}</span>
              </div>
            ))}
          </>
        )}
        <div className="side-label projects-label">
          <span className="grow">Spaces</span>
          <button type="button" className="label-add" title={shortcutTitle('New Space', 'new-project')} aria-label="New Space" onClick={onNewProject}>
            <Icon name="plus" size={12} />
          </button>
        </div>
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
                data-flip={`g:${group}`}
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
                <span className="grow" title={group}>{group}</span>
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

