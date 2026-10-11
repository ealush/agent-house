import type { HistoryItem, HostApi, State, Win } from './api.ts';
import { AskPanel, cleanScreen, questionLine } from './AskPanel.tsx';
import { ShortcutHint, shortcutTitle } from './shortcuts.tsx';
import { Icon } from './icons.tsx';
import { age, look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { useSavedGroups } from './groupOrder.ts';
import { sidebarSections } from './sessionOrder.ts';

export type InboxGroup = 'status' | 'host' | 'project';

type Props = {
  state: State;
  narrow: boolean;
  groupBy: InboxGroup;
  setGroupBy: (g: InboxGroup) => void;
  onOpen: (w: Win, reply?: boolean) => void;
  onAnswer: (w: Win, answer: 'approve' | 'deny') => void;
  clientFor: (host: string | undefined) => HostApi;
  onNew: () => void;
  onSearch: () => void;
  onSettings: () => void;
  /** Continue a session from another device (Handoff), when there is one. */
  handoff?: React.ReactNode;
  /** An empty inbox offers the latest conversations to resume. */
  onResume?: (h: HistoryItem) => void;
};

const KIND_LABEL = { command: 'Wants to run a command', tool: 'Wants to use a tool', question: 'Asked a question', screen: 'Waiting for you', choice: 'Asked you' };

const where = (w: Win, multiHost: boolean) => [multiHost ? w.host : null, w.project].filter(Boolean).join(' · ');

/** The home screen: what's blocked on you first, then what's working, then the rest. */
export function Inbox({ state, narrow, groupBy, setGroupBy, onOpen, onAnswer, clientFor, onNew, onSearch, onSettings, handoff, onResume }: Props) {
  const recent = state.windows.length ? [] : state.history.slice(0, 3);
  const multiHost = state.hosts.length > 1;
  const waiting = state.windows.filter((w) => w.status === 'waiting');
  const running = state.windows.filter((w) => w.status === 'busy');
  const rest = state.windows.filter((w) => w.status === 'attention' || w.status === 'idle').sort((a, b) => b.activity - a.activity);
  const online = state.hosts.filter((h) => h.online).length;

  // The design's tagline reads as live counts ("1 session needs you. 3 working. 6 idle.").
  const counts = [
    waiting.length ? `${waiting.length} session${waiting.length === 1 ? ' needs' : 's need'} you` : null,
    running.length ? `${running.length} working` : null,
    rest.length ? `${rest.length} idle` : null,
  ].filter(Boolean);
  const subtitle = narrow
    ? `${online} host${online === 1 ? '' : 's'} online · ${counts.join('. ') || 'all quiet'}.`
    : counts.length
      ? `${counts.join('. ')}.`
      : 'All quiet.';

  return (
    <div className="page" data-rove="button.card-title, button.row, button.empty-recent-row">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">Inbox<span className="period">.</span></h1>
          <p className="tagline">{subtitle}</p>
        </div>
        {narrow ? (
          <>
            <button className="icon-btn round" onClick={onSettings} aria-label="Settings">
              <Icon name="gear" size={19} />
            </button>
            <button className="icon-btn round" onClick={onSearch} aria-label="Search">
              <Icon name="search" size={20} />
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
      {handoff}

      {state.windows.length === 0 && (
        <div className="empty-state">
          <p className="empty-title">Nothing running.</p>
          <p className="hint">Start something new, or pick up where you left off.</p>
          <button className="btn light" onClick={onNew}>
            Start a session <ShortcutHint id="new-session" />
          </button>
          {recent.length > 0 && onResume && (
            <ul className="empty-recent">
              {recent.map((h) => (
                <li key={`${h.host}:${h.ref}`}>
                  <button className="empty-recent-row" onClick={() => onResume(h)} title={`Resume ${h.title}`}>
                    <span className="chip sm" style={{ '--agent': look(h.harness).color } as React.CSSProperties}>
                      <AgentLogo id={h.harness} size={13} />
                    </span>
                    <span className="grow">{h.title}</span>
                    <span className="when">{[h.project, age(h.at)].filter(Boolean).join(' · ')}</span>
                    <span className="resume-word">Resume</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {groupBy !== 'status' && !narrow ? (
        <Grouped windows={state.windows} by={groupBy} multiHost={multiHost} onOpen={onOpen} />
      ) : (
        <>
          {waiting.length > 0 && (
            <>
              <h2 className="section-label waiting first">
                Needs you <span className="count">{waiting.length}</span>
              </h2>
              <div className="cards">
                {waiting.map((w) => (
                  <AskCard key={w.key} w={w} client={clientFor(w.host)} multiHost={multiHost} narrow={narrow} onOpen={onOpen} onAnswer={onAnswer} />
                ))}
              </div>
            </>
          )}
          {running.length > 0 && (
            <>
              <h2 className={`section-label busy ${waiting.length ? '' : 'first'}`}>
                Running <span className="count">{running.length}</span>
              </h2>
              {!narrow && <ListHead />}
              <Rows windows={running} multiHost={multiHost} narrow={narrow} onOpen={onOpen} />
            </>
          )}
          {rest.length > 0 && (
            <>
              <h2 className={`section-label ${waiting.length || running.length ? '' : 'first'}`}>Idle and done <span className="count">{rest.length}</span></h2>
              {!narrow && <ListHead />}
              <Rows windows={rest} multiHost={multiHost} narrow={narrow} onOpen={onOpen} quiet />
            </>
          )}
        </>
      )}
    </div>
  );
}

function AskCard({ w, client, multiHost, narrow, onOpen, onAnswer }: { w: Win; client: HostApi; multiHost: boolean; narrow: boolean; onOpen: Props['onOpen']; onAnswer: Props['onAnswer'] }) {
  const { color, name } = look(w.agent);
  const modelLabel = shortModel(w.model);
  const ask = w.ask;
  const code = ask?.kind === 'command' || ask?.kind === 'screen';
  // Answerable right here: the agent's questions, or the rows of its picker.
  const inline = !!ask && ((ask.kind === 'choice' && (!!ask.questions?.length || !!ask.dialog)) || !!ask.options?.length);
  // Lead with the prompt's question; the rest of the screen is context, without the TUI's rules.
  const showText = !!ask?.text && !(ask.kind === 'choice' && inline);
  const question = showText && ask!.kind !== 'command' ? questionLine(ask!.text) : null;
  const context = showText ? cleanScreen(ask!.text, question) : '';
  return (
    <article className="card card-needs" style={{ '--agent': color } as React.CSSProperties}>
      <div className="card-head">
        <span className="glow">
          <span className="chip">
            <AgentLogo id={w.agent} />
          </span>
        </span>
        <button className="card-title" onClick={() => onOpen(w)}>
          {w.title}
        </button>
        <span className="card-age">{age(w.activity)}</span>
      </div>
      {!narrow && ask && <div className="card-kind">{KIND_LABEL[ask.kind]}</div>}
      {question && <p className="card-question">{question}</p>}
      {context && <pre className={`ask-box ${code ? 'code' : ''}`}>{context}</pre>}
      {inline && <AskPanel w={w} client={client} onAnswer={onAnswer} compact />}
      {!narrow && (
        <div className="card-where">
          Where <span className="mono">{multiHost ? `${w.host}:` : ''}{w.projectPath}</span>
        </div>
      )}
      <div className="card-foot">
        {inline ? (
          <button className="btn" onClick={() => onOpen(w)}>
            Open
          </button>
        ) : w.answerable ? (
          <>
            <button className="btn primary" title={shortcutTitle('Approve', 'approve')} onClick={() => onAnswer(w, 'approve')}>
              Approve
            </button>
            <button className="btn" title={shortcutTitle('Deny', 'deny')} onClick={() => onAnswer(w, 'deny')}>
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
            <button className="btn primary" title={shortcutTitle('Reply', 'reply')} onClick={() => onOpen(w, true)}>
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
          {[name, modelLabel, where(w, multiHost)].filter(Boolean).map((t) => (
            <span key={t} className="tag">{t}</span>
          ))}
        </span>
      </div>
    </article>
  );
}

/** Column headers over desktop session rows. */
function ListHead() {
  return (
    <div className="list-head" aria-hidden="true">
      {/* The first column is the agent's icon: too narrow for a word. */}
      <span />
      <span>Session</span>
      <span>Detail</span>
      <span>Status · Project</span>
      <span>Active</span>
    </div>
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
  const sections = sidebarSections(windows, by === 'host', useSavedGroups(by === 'host'));
  return (
    <>
      {sections.map((section, i) => (
        <section key={section.id}>
          <h2 className={`section-label ${i === 0 ? 'first' : ''}`}>{section.id} <span className="count">{section.windows.length}</span></h2>
          <Rows windows={section.windows} multiHost={multiHost && by !== 'host'} narrow={false} onOpen={onOpen} />
        </section>
      ))}
    </>
  );
}
