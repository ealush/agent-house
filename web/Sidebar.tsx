import { useMemo, useState } from 'react';
import type { HistoryItem, State, Win } from './api.ts';
import { look } from './agents.ts';

export type GroupBy = 'status' | 'project' | 'session';

type Props = {
  state: State | null;
  error: string | null;
  selected: string | null;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  onSelect: (id: string) => void;
  onResume: (ref: string) => void;
  onForget: (ref: string) => void;
  onNew: () => void;
  onWorktrees: () => void;
  notify: NotificationPermission | 'unsupported';
  onEnableNotify: () => void;
};

// Needs-you first (F21): the dashboard is for what's blocked on you.
const STATUS_GROUPS: Array<[Win['status'], string]> = [
  ['waiting', 'needs you'],
  ['attention', 'done'],
  ['busy', 'working'],
  ['idle', 'idle'],
];

const GROUP_LABELS: Record<GroupBy, string> = { status: 'Status', project: 'Projects', session: 'tmux' };

export function Sidebar({ state, error, selected, groupBy, setGroupBy, onSelect, onResume, onForget, onNew, onWorktrees, notify, onEnableNotify }: Props) {
  const groups = useMemo(() => {
    const windows = state?.windows ?? [];
    const pinned = windows.filter((w) => w.pinned);
    const rest = windows.filter((w) => !w.pinned);
    let out: Array<[string, Win[]]>;
    if (groupBy === 'status') {
      out = STATUS_GROUPS.map(([s, label]): [string, Win[]] => [label, rest.filter((w) => w.status === s)]).filter(([, ws]) => ws.length);
    } else {
      const map = new Map<string, Win[]>();
      for (const w of rest) {
        const key = groupBy === 'project' ? w.project : w.session;
        map.set(key, [...(map.get(key) ?? []), w]);
      }
      out = [...map.entries()].sort(([a], [b]) => (a === '~' ? 1 : b === '~' ? -1 : a.localeCompare(b)));
    }
    return pinned.length ? [['pinned', pinned] as [string, Win[]], ...out] : out;
  }, [state, groupBy]);

  const waiting = state?.windows.filter((w) => w.status === 'waiting').length ?? 0;

  return (
    <nav className="sidebar">
      <header className="side-head">
        <div className="brand">
          <span className="brand-mark">ah</span>
          <span className="host">{state?.hostname ?? '…'}</span>
        </div>
        <button className="btn primary" onClick={onNew}>
          <span aria-hidden>＋</span> New
        </button>
      </header>

      <div className="side-tools">
        <div className="seg" role="tablist">
          {(['status', 'project', 'session'] as const).map((g) => (
            <button key={g} role="tab" aria-selected={groupBy === g} className={groupBy === g ? 'on' : ''} onClick={() => setGroupBy(g)}>
              {GROUP_LABELS[g]}
            </button>
          ))}
        </div>
        {waiting > 0 && <span className="waiting">{waiting} need you</span>}
      </div>

      <div className="side-list">
        {error && <div className="side-error">Can't reach server: {error}</div>}
        {state && state.windows.length === 0 && (
          <div className="empty">
            <p>Nothing running.</p>
            <button className="btn" onClick={onNew}>
              Start a session
            </button>
          </div>
        )}
        {groups.map(([group, wins]) => (
          <section key={group} className="group">
            <h3 title={groupBy === 'project' ? wins[0].projectPath : undefined}>{group}</h3>
            <ul>
              {wins.map((w) => (
                <Item key={w.id} w={w} selected={w.id === selected} groupBy={groupBy} onSelect={onSelect} />
              ))}
            </ul>
          </section>
        ))}
        {!!state?.history.length && <History items={state.history} onResume={onResume} onForget={onForget} />}
      </div>

      <footer className="side-foot">
        <button className="btn ghost small" onClick={onWorktrees}>
          ⎇ Worktrees
        </button>
        {notify === 'default' && (
          <button className="btn ghost small" onClick={onEnableNotify}>
            🔔 Notify me
          </button>
        )}
      </footer>
    </nav>
  );
}

function Item({ w, selected, groupBy, onSelect }: { w: Win; selected: boolean; groupBy: GroupBy; onSelect: (id: string) => void }) {
  const { color, glyph } = look(w.agent);
  const elsewhere = w.viewers - (selected ? 1 : 0);
  const context = groupBy === 'project' ? w.session : w.project;
  return (
    <li>
      <button className={`item ${selected ? 'selected' : ''} ${w.status}`} onClick={() => onSelect(w.id)} style={{ '--agent': color } as React.CSSProperties}>
        <span className="chip" aria-hidden>
          {glyph}
        </span>
        <span className="item-main">
          <span className="item-name">{w.name}</span>
          <span className="item-sub">
            {context}
            {w.branch && w.worktree ? ` ⎇ ${w.branch}` : ''} · {w.agent ?? w.command}
            {w.panes > 1 ? ` · ${w.panes} panes` : ''}
          </span>
        </span>
        <span className="item-meta">
          {w.queued > 0 && (
            <span className="queued" title={`${w.queued} queued prompt${w.queued > 1 ? 's' : ''}`}>
              ⇥{w.queued}
            </span>
          )}
          {elsewhere > 0 && (
            <span className="viewers" title={`Open on ${elsewhere} other device${elsewhere > 1 ? 's' : ''}`}>
              ◉{elsewhere > 1 ? elsewhere : ''}
            </span>
          )}
          <span className={`status ${w.status}`} title={STATUS_TEXT[w.status] + (w.statusSource === 'hook' ? '' : ` (from ${w.statusSource})`)} />
        </span>
      </button>
    </li>
  );
}

export const STATUS_TEXT = {
  busy: 'Working',
  idle: 'Quiet',
  waiting: 'Needs your input',
  attention: 'Finished since you last looked',
};

const HISTORY_PREVIEW = 6;

function History({ items, onResume, onForget }: { items: HistoryItem[]; onResume: (ref: string) => void; onForget: (ref: string) => void }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, HISTORY_PREVIEW);
  return (
    <section className="group history">
      <h3>
        <button className="linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'} history · {items.length}
        </button>
      </h3>
      {open && (
        <ul>
          {shown.map((h) => {
            const { color, glyph } = look(h.harness);
            return (
              <li key={h.ref} className="ended-item" style={{ '--agent': color } as React.CSSProperties}>
                <span className="chip">{glyph}</span>
                <span className="item-main">
                  <span className="item-name" title={h.title}>
                    {h.title}
                  </span>
                  <span className="item-sub" title={h.harnessId ? `${h.harness} ${h.harnessId}` : undefined}>
                    {h.project} · {ago(h.at)}
                    {h.kind === 'saved' ? '' : ' · ended'}
                  </span>
                </span>
                <button className="btn small" onClick={() => onResume(h.ref)} title={h.harnessId ? 'Resume this exact conversation' : 'Continue the latest conversation in this directory'}>
                  Resume
                </button>
                <button className="icon-btn small" onClick={() => onForget(h.ref)} title="Hide from history">
                  ×
                </button>
              </li>
            );
          })}
          {items.length > HISTORY_PREVIEW && (
            <li>
              <button className="linkish more" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : `Show all ${items.length}`}
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

export function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
