import type { State, Win } from './api.ts';
import { Icon } from './icons.tsx';
import { age, look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';

export type InboxGroup = 'status' | 'host' | 'project';

type Props = {
  state: State;
  narrow: boolean;
  groupBy: InboxGroup;
  setGroupBy: (g: InboxGroup) => void;
  onOpen: (w: Win, reply?: boolean) => void;
  onAnswer: (w: Win, answer: 'approve' | 'deny') => void;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
};

const KIND_LABEL = { command: 'Wants to run a command', tool: 'Wants to use a tool', question: 'Asked a question', screen: 'Waiting for you' };

const where = (w: Win, multiHost: boolean) => [multiHost ? w.host : null, w.project].filter(Boolean).join(' · ');

/** The home screen: what's blocked on you first, then what's working, then the rest. */
export function Inbox({ state, narrow, groupBy, setGroupBy, onOpen, onAnswer, onNew, onSearch, onSettings }: Props) {
  const multiHost = state.hosts.length > 1;
  const waiting = state.windows.filter((w) => w.status === 'waiting');
  const running = state.windows.filter((w) => w.status === 'busy');
  const rest = state.windows.filter((w) => w.status === 'attention' || w.status === 'idle').sort((a, b) => b.activity - a.activity);
  const online = state.hosts.filter((h) => h.online).length;

  const subtitle = narrow
    ? `${online} host${online === 1 ? '' : 's'} online · ${state.windows.length} live session${state.windows.length === 1 ? '' : 's'}`
    : waiting.length || running.length
      ? `${waiting.length ? `${waiting.length} session${waiting.length > 1 ? 's are' : ' is'} waiting on you. ` : ''}${running.length} ${running.length === 1 ? 'is' : 'are'} still working.`
      : 'All quiet.';

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Inbox</h1>
          <p>{subtitle}</p>
        </div>
        {narrow ? (
          <>
            <button className="icon-btn round" onClick={onSettings} aria-label="Settings">
              <Icon name="gear" size={19} />
            </button>
            <button className="icon-btn round" onClick={onSearch} aria-label="Search">
              <Icon name="search" size={20} />
            </button>
            <button className="icon-btn round" onClick={() => window.location.reload()} aria-label="Reload page">
              <Icon name="recall" size={19} />
            </button>
            <button className="icon-btn round light" onClick={onNew} aria-label="New session">
              <Icon name="plus" size={22} />
            </button>
          </>
        ) : (
          <>
            <div className="seg" role="tablist">
              {(['status', 'host', 'project'] as const).map((g) => (
                <button key={g} role="tab" aria-selected={groupBy === g} className={groupBy === g ? 'on' : ''} onClick={() => setGroupBy(g)}>
                  {g[0].toUpperCase() + g.slice(1)}
                </button>
              ))}
            </div>
            <button className="btn light" onClick={onNew}>
              New session
            </button>
          </>
        )}
      </header>

      {state.windows.length === 0 && (
        <div className="empty-state">
          <p>Nothing running.</p>
          <button className="btn light" onClick={onNew}>
            Start a session
          </button>
        </div>
      )}

      {groupBy !== 'status' && !narrow ? (
        <Grouped windows={state.windows} by={groupBy} multiHost={multiHost} onOpen={onOpen} />
      ) : (
        <>
          {waiting.length > 0 && (
            <>
              <h2 className="section-label waiting first">
                <span className="dot waiting" /> Needs you
              </h2>
              <div className="cards">
                {waiting.map((w) => (
                  <AskCard key={w.key} w={w} multiHost={multiHost} narrow={narrow} onOpen={onOpen} onAnswer={onAnswer} />
                ))}
              </div>
            </>
          )}
          {running.length > 0 && (
            <>
              <h2 className={`section-label busy ${waiting.length ? '' : 'first'}`}>
                <span className="dot busy" /> Running
              </h2>
              <Rows windows={running} multiHost={multiHost} narrow={narrow} onOpen={onOpen} />
            </>
          )}
          {rest.length > 0 && (
            <>
              <h2 className={`section-label ${waiting.length || running.length ? '' : 'first'}`}>Idle and done</h2>
              <Rows windows={rest} multiHost={multiHost} narrow={narrow} onOpen={onOpen} quiet />
            </>
          )}
        </>
      )}
    </div>
  );
}

function AskCard({ w, multiHost, narrow, onOpen, onAnswer }: { w: Win; multiHost: boolean; narrow: boolean; onOpen: Props['onOpen']; onAnswer: Props['onAnswer'] }) {
  const { color, name } = look(w.agent);
  const modelLabel = shortModel(w.model);
  const ask = w.ask;
  const code = ask?.kind === 'command' || ask?.kind === 'screen';
  return (
    <article className="card" style={{ '--agent': color } as React.CSSProperties}>
      <div className="card-head">
        <span className="chip">
          <AgentLogo id={w.agent} />
        </span>
        <button className="card-title" onClick={() => onOpen(w)}>
          {w.title}
        </button>
        <span className="card-age">{age(w.activity)}</span>
      </div>
      {!narrow && ask && <div className="card-kind">{KIND_LABEL[ask.kind]}</div>}
      {ask?.text && <pre className={`ask-box ${code ? 'code' : ''}`}>{ask.text}</pre>}
      <div className="card-foot">
        {w.answerable ? (
          <>
            <button className="btn primary" onClick={() => onAnswer(w, 'approve')}>
              Approve
            </button>
            <button className="btn" onClick={() => onAnswer(w, 'deny')}>
              Deny
            </button>
          </>
        ) : (
          <>
            {narrow && (
              <button className="btn" onClick={() => onOpen(w)}>
                Open
              </button>
            )}
            <button className="btn primary" onClick={() => onOpen(w, true)}>
              Reply
            </button>
            {!narrow && (
              <button className="btn" onClick={() => onOpen(w)}>
                Open
              </button>
            )}
          </>
        )}
        <span className="meta">
          {[name, modelLabel, where(w, multiHost)].filter(Boolean).join(' · ')}
        </span>
      </div>
    </article>
  );
}

export function Rows({ windows, multiHost, narrow, onOpen, quiet }: { windows: Win[]; multiHost: boolean; narrow: boolean; onOpen: Props['onOpen']; quiet?: boolean }) {
  return (
    <ul className="rows">
      {windows.map((w) => {
        const { color } = look(w.agent);
        const pill = w.status === 'attention' ? <span className="pill attention">{w.agent ? 'done' : 'new output'}</span> : w.status === 'idle' ? <span className="pill">idle</span> : null;
        return (
          <li key={w.key}>
            <button className={`row ${quiet ? 'quiet' : ''}`} style={{ '--agent': color } as React.CSSProperties} onClick={() => onOpen(w)}>
              <span className="chip">
                <AgentLogo id={w.agent} />
              </span>
              {narrow ? (
                <>
                  <span className="stack">
                    <span className="name">{w.title}</span>
                    <span className="sub">{[w.detail ?? (w.panes > 1 ? `${w.panes} panes` : w.command), where(w, multiHost)].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="when">{pill ?? age(w.activity)}</span>
                </>
              ) : (
                <>
                  <span className="name">{w.title}</span>
                  <span className="detail">{w.detail ?? ''}</span>
                  <span className="meta">
                    {pill}
                    {w.queued > 0 && <span className="pill waiting">⇥ {w.queued} queued</span>}
                    {where(w, multiHost)}
                  </span>
                  <span className="when">{age(w.activity)}</span>
                </>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Grouped({ windows, by, multiHost, onOpen }: { windows: Win[]; by: 'host' | 'project'; multiHost: boolean; onOpen: Props['onOpen'] }) {
  const groups = new Map<string, Win[]>();
  for (const w of windows) {
    const k = by === 'host' ? w.host : w.project;
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  return (
    <>
      {[...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, ws], i) => (
          <section key={k}>
            <h2 className={`section-label ${i === 0 ? 'first' : ''}`}>{k}</h2>
            <Rows windows={ws} multiHost={multiHost && by !== 'host'} narrow={false} onOpen={onOpen} />
          </section>
        ))}
    </>
  );
}
