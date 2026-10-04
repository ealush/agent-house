import { useMemo, useState } from 'react';
import type { Ended, State, Win } from './api.ts';
import { look } from './agents.ts';

export type GroupBy = 'project' | 'session';

type Props = {
  state: State | null;
  error: string | null;
  selected: string | null;
  groupBy: GroupBy;
  setGroupBy: (g: GroupBy) => void;
  onSelect: (id: string) => void;
  onResume: (uid: string) => void;
  onForget: (uid: string) => void;
  onNew: () => void;
  notify: NotificationPermission | 'unsupported';
  onEnableNotify: () => void;
};

export function Sidebar({ state, error, selected, groupBy, setGroupBy, onSelect, onResume, onForget, onNew, notify, onEnableNotify }: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, Win[]>();
    for (const w of state?.windows ?? []) {
      const key = groupBy === 'project' ? w.project : w.session;
      map.set(key, [...(map.get(key) ?? []), w]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '~' ? 1 : b === '~' ? -1 : a.localeCompare(b)));
  }, [state, groupBy]);

  const waiting = state?.windows.filter((w) => w.status === 'attention' || w.status === 'waiting').length ?? 0;

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
          {(['project', 'session'] as const).map((g) => (
            <button key={g} role="tab" aria-selected={groupBy === g} className={groupBy === g ? 'on' : ''} onClick={() => setGroupBy(g)}>
              {g === 'project' ? 'Projects' : 'tmux sessions'}
            </button>
          ))}
        </div>
        {waiting > 0 && <span className="waiting">{waiting} waiting</span>}
      </div>

      <div className="side-list">
        {error && <div className="side-error">Can't reach server: {error}</div>}
        {state && state.windows.length === 0 && (
          <div className="empty">
            <p>No tmux windows yet.</p>
            <button className="btn" onClick={onNew}>
              Start one
            </button>
          </div>
        )}
        {groups.map(([group, wins]) => (
          <section key={group} className="group">
            <h3 title={groupBy === 'project' ? wins[0].projectPath : `tmux session ${group}`}>{group}</h3>
            <ul>
              {wins.map((w) => (
                <Item key={w.id} w={w} selected={w.id === selected} groupBy={groupBy} onSelect={onSelect} />
              ))}
            </ul>
          </section>
        ))}
        {!!state?.ended.length && <EndedList ended={state.ended} onResume={onResume} onForget={onForget} />}
      </div>

      {notify === 'default' && (
        <footer className="side-foot">
          <button className="btn ghost small" onClick={onEnableNotify}>
            Notify me when an agent is waiting
          </button>
        </footer>
      )}
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
            {context} · {w.agent ?? w.command}
            {w.panes > 1 ? ` · ${w.panes} panes` : ''}
          </span>
        </span>
        <span className="item-meta">
          {elsewhere > 0 && (
            <span className="viewers" title={`Open on ${elsewhere} other device${elsewhere > 1 ? 's' : ''}`}>
              ◉{elsewhere > 1 ? elsewhere : ''}
            </span>
          )}
          <span className={`status ${w.status}`} title={STATUS_TEXT[w.status]} />
        </span>
      </button>
    </li>
  );
}

const STATUS_TEXT = {
  busy: 'Working',
  idle: 'Quiet',
  waiting: 'Waiting for your input',
  attention: 'Finished since you last looked',
};

function EndedList({ ended, onResume, onForget }: { ended: Ended[]; onResume: (uid: string) => void; onForget: (uid: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="group ended">
      <h3>
        <button className="linkish" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? '▾' : '▸'} ended · {ended.length}
        </button>
      </h3>
      {open && (
        <ul>
          {ended.map((r) => {
            const { color, glyph } = look(r.harness);
            return (
              <li key={r.uid} className="ended-item" style={{ '--agent': color } as React.CSSProperties}>
                <span className="chip">{glyph}</span>
                <span className="item-main">
                  <span className="item-name">{r.name}</span>
                  <span className="item-sub" title={r.harnessId ? `${r.harness} session ${r.harnessId}` : undefined}>
                    {r.cwd} · {ago(r.endedAt)}
                  </span>
                </span>
                <button className="btn small" onClick={() => onResume(r.uid)} title={r.harnessId ? 'Resume this exact conversation' : 'Continue the latest conversation in this directory'}>
                  Resume
                </button>
                <button className="icon-btn small" onClick={() => onForget(r.uid)} title="Forget">
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
