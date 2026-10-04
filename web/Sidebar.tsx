import type { State, Win } from './api.ts';
import { Icon } from './icons.tsx';

export type Page = 'inbox' | 'history' | 'sessions';

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
};

/** Desktop navigation: inbox, hosts, and every live session grouped by host (or project). */
export function Sidebar({ state, error, page, selected, device, onPage, onSelect, onSearch, onNew, onWorktrees, onNotify }: Props) {
  const windows = state?.windows ?? [];
  const waiting = windows.filter((w) => w.status === 'waiting').length;
  const multiHost = (state?.hosts.length ?? 0) > 1;

  const groups = new Map<string, Win[]>();
  for (const w of [...windows].sort((a, b) => Number(b.pinned) - Number(a.pinned) || rank(a) - rank(b) || b.activity - a.activity)) {
    const k = multiHost ? w.host : w.project;
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }

  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="logo">&gt;_</span>
        <span className="brand-name">ah</span>
        <span className="host-pill" title="This device">
          <span className="dot online" /> {device}
        </span>
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
            {ws.map((w) => (
              <button key={w.key} className={`side-session ${w.key === selected ? 'on' : ''} ${w.agent ? '' : 'shellish'}`} onClick={() => onSelect(w.key)} title={`${w.title} — ${w.cwd}`}>
                <span className={`dot ${w.status}`} />
                <span className="name">
                  {w.pinned ? '★ ' : ''}
                  {w.agent ? w.title : `${w.title === w.command || w.title === 'shell' ? w.command : w.title} ${w.cwd}`}
                </span>
                {w.queued > 0 && <span className="count">⇥{w.queued}</span>}
              </button>
            ))}
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
