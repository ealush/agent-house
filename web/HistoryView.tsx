import type { HistoryItem, State, Win } from './api.ts';
import { Icon } from './icons.tsx';
import { age, look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { Rows } from './Inbox.tsx';

/** Ended and saved conversations from every host; one tap resumes on the host that has it. */
export function HistoryView({ state, onResume, onForget, onFork }: { state: State; onResume: (h: HistoryItem) => void; onForget: (h: HistoryItem) => void; onFork?: (h: HistoryItem) => void }) {
  const multiHost = state.hosts.length > 1;
  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>History</h1>
          <p>Ended sessions and past conversations. Resuming continues the same conversation.</p>
        </div>
      </header>
      {state.history.length === 0 && <p className="empty-state">Nothing here yet.</p>}
      <ul className="rows">
        {state.history.map((h) => {
          const { color, name } = look(h.harness);
          const modelLabel = shortModel(h.model);
          return (
            <li key={`${h.host}:${h.ref}`}>
              <div className="row quiet history-row" style={{ '--agent': color } as React.CSSProperties}>
                <span className="chip">
                  <AgentLogo id={h.harness} />
                </span>
                <span className="stack">
                  <span className="name" title={h.title}>
                    {h.title}
                  </span>
                  <span className="sub">
                    {[name, modelLabel, multiHost ? h.host : null, h.project, h.kind === 'ended' ? 'ended' : null, h.worktree ? '⎇ worktree' : null, h.fork ? `⑂ fork of ${h.fork.parentTitle}` : null].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="when">{age(h.at)}</span>
                <span style={{ display: 'flex', gap: 4 }}>
                  <button className="btn small" onClick={() => onResume(h)}>
                    Resume
                  </button>
                  {onFork && (h.harness === 'claude' || h.harness === 'codex') && (
                    <button className="btn small ghost" onClick={() => onFork(h)}>
                      Fork
                    </button>
                  )}
                  <button className="icon-btn small" title="Hide" onClick={() => onForget(h)}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Phone "Sessions" tab: everything live, grouped by project. */
export function SessionsView({ state, onOpen, onNew }: { state: State; onOpen: (w: Win) => void; onNew: () => void }) {
  const multiHost = state.hosts.length > 1;
  const groups = new Map<string, Win[]>();
  for (const w of state.windows) groups.set(w.project, [...(groups.get(w.project) ?? []), w]);
  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Sessions</h1>
          <p>{state.windows.length} live</p>
        </div>
        <button className="icon-btn round" onClick={() => window.location.reload()} aria-label="Reload page">
          <Icon name="recall" size={19} />
        </button>
        <button className="icon-btn round light" onClick={onNew} aria-label="New session">
          <Icon name="plus" size={22} />
        </button>
      </header>
      {[...groups.entries()]
        .sort(([a], [b]) => (a === '~' ? 1 : b === '~' ? -1 : a.localeCompare(b)))
        .map(([project, ws], i) => (
          <section key={project}>
            <h2 className={`section-label ${i === 0 ? 'first' : ''}`}>{project}</h2>
            <Rows windows={ws} multiHost={multiHost} narrow onOpen={onOpen} />
          </section>
        ))}
    </div>
  );
}
