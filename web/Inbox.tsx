import { useContext } from 'react';
import type { HistoryItem, HostApi, ReviewAlert, State, Win } from './api.ts';
import { AskPanel, AskSummary } from './AskPanel.tsx';
import { KIND_LABEL } from './askView.ts';
import { ShortcutHint, shortcutTitle } from './shortcuts.tsx';
import { Icon } from './icons.tsx';
import { age, look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { useSavedGroups } from './groupOrder.ts';
import { sidebarSections } from './sessionOrder.ts';
import { Glide } from './Glide.tsx';
import { useFlip } from './useFlip.ts';
import { statusClass, statusCounts, statusWord } from './status.ts';
import { sessionLine } from './sessionLine.tsx';
import { SessionActionsContext, sessionItems, sessionSwipes, usePressMenu } from './PressMenu.tsx';
import { Swipe } from './Swipe.tsx';

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
  /** Open a stack under review at a layer. */
  onReview?: (stack: string, pr?: number | null) => void;
  /** Continue a session from another device (Handoff), when there is one. */
  handoff?: React.ReactNode;
  /** An empty inbox offers the latest conversations to resume. */
  onResume?: (h: HistoryItem) => void;
};


const where = (w: Win, multiHost: boolean) => [multiHost ? w.host : null, w.project].filter(Boolean).join(' · ');

/** The home screen: what's blocked on you first, then what's working, then the rest. */
export function Inbox({ state, narrow, groupBy, setGroupBy, onOpen, onAnswer, clientFor, onNew, onSearch, onSettings, onReview, handoff, onResume }: Props) {
  const recent = state.windows.length ? [] : state.history.slice(0, 3);
  const multiHost = state.hosts.length > 1;
  const waiting = state.windows.filter((w) => w.status === 'waiting');
  const reviews = onReview ? (state.review?.alerts ?? []) : [];
  const running = state.windows.filter((w) => w.status === 'busy');
  const rest = state.windows.filter((w) => w.status === 'attention' || w.status === 'idle').sort((a, b) => b.activity - a.activity);
  const flip = useFlip<HTMLDivElement>([groupBy, waiting, running, rest, reviews.map((r) => ({ key: `${r.stackId}:${r.pr}:${r.kind}` }))].map((l) => (typeof l === 'string' ? l : l.map((w) => w.key).join(','))).join('|'));
  const online = state.hosts.filter((h) => h.online).length;

  // A phone has no sidebar to show hosts in: it says how many are up, when there is more than one.
  const hosts = narrow && state.hosts.length > 1 ? `${online} of ${state.hosts.length} hosts online. ` : '';
  const subtitle = hosts + statusCounts(state.windows);

  return (
    <div className="page" data-title="Inbox" ref={flip} data-rove="button.card-title, button.row, button.empty-recent-row">
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
              <Glide match=".on" className="thumb" />
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
          {waiting.length + reviews.length > 0 && (
            <>
              <h2 className="section-label waiting first" data-flip="h:waiting">
                Needs you <span className="count">{waiting.length + reviews.length}</span>
              </h2>
              <div className="cards">
                {waiting.map((w) => (
                  <AskCard key={w.key} w={w} client={clientFor(w.host)} multiHost={multiHost} narrow={narrow} onOpen={onOpen} onAnswer={onAnswer} />
                ))}
                {reviews.map((r) => (
                  <ReviewCard key={`${r.stackId}:${r.pr}:${r.kind}`} r={r} onOpen={() => onReview!(r.stackId, r.pr)} />
                ))}
              </div>
            </>
          )}
          {running.length > 0 && (
            <>
              <h2 className={`section-label busy ${waiting.length + reviews.length ? '' : 'first'}`} data-flip="h:running">
                Working <span className="count">{running.length}</span>
              </h2>
              {!narrow && <ListHead flip="lh:running" />}
              <Rows windows={running} multiHost={multiHost} narrow={narrow} onOpen={onOpen} />
            </>
          )}
          {rest.length > 0 && (
            <>
              <h2 className={`section-label ${waiting.length || reviews.length || running.length ? '' : 'first'}`} data-flip="h:rest">Idle and done <span className="count">{rest.length}</span></h2>
              {!narrow && <ListHead flip="lh:rest" />}
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
  // Answerable right here: the agent's questions, or the rows of its picker.
  const inline = !!ask && ((ask.kind === 'choice' && (!!ask.questions?.length || !!ask.dialog)) || !!ask.options?.length);
  const form = ask?.kind === 'choice' && inline;
  return (
    <article
      className="card card-needs"
      data-flip={w.key}
      style={{ '--agent': color } as React.CSSProperties}
      onKeyDown={(e) => {
        // The keys drawn on the choices answer from anywhere on the card, the title
        // included (where ↓ lands), not only once Tab has reached the choices.
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
        if ((e.target as HTMLElement).closest('.ask-options, input, textarea, [contenteditable="true"]')) return;
        const option = e.currentTarget.querySelectorAll<HTMLButtonElement>('.ask-options .ask-option')[Number(e.key) - 1];
        if (!option || option.getAttribute('aria-disabled') === 'true') return;
        e.preventDefault();
        option.focus();
        option.click();
      }}
    >
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
      {/* The same summary the session shows: what it wants, the command or the question, the screen on request. */}
      {ask && (form ? <div className="card-kind">{KIND_LABEL[ask.kind]}</div> : <AskSummary w={w} terminalText={!narrow} />)}
      {inline && <AskPanel w={w} client={client} onAnswer={onAnswer} compact />}
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

const REVIEW_KIND = {
  rereview: { line: 'Updated since your review', action: 'Re-review' },
  nopush: { line: 'The agent finished without pushing', action: 'Open' },
  restack: { line: 'Needs a restack after a merge', action: 'Open' },
  ready: { line: 'Reviewed, checks pass, next in line', action: 'Merge…' },
} as const;

/** A layer of a stack under review that's waiting on you (server/review). */
function ReviewCard({ r, onOpen }: { r: ReviewAlert; onOpen: () => void }) {
  const k = REVIEW_KIND[r.kind];
  return (
    <article className="card card-needs card-review" data-flip={`${r.stackId}:${r.pr}:${r.kind}`}>
      <div className="card-head">
        <span className="glow">
          <span className="chip">
            <Icon name="diff" size={14} />
          </span>
        </span>
        <button className="card-title" onClick={onOpen}>
          {r.role ? `${r.role} · ` : ''}
          {r.title}
        </button>
        <span className="card-age">{r.at ? age(r.at) : ''}</span>
      </div>
      <div className="card-kind">{k.line}</div>
      <div className="card-foot">
        <button className="btn primary" onClick={onOpen}>
          {k.action}
        </button>
        <span className="meta">
          <span className="tag">{r.stackTitle}</span>
          <span className="tag">#{r.pr}</span>
        </span>
      </div>
    </article>
  );
}

/** Column headers over desktop session rows. */
function ListHead({ flip }: { flip: string }) {
  return (
    <div className="list-head" data-flip={flip} aria-hidden="true">
      {/* The first column is the agent's icon: too narrow for a word. */}
      <span />
      <span>Session</span>
      <span>Detail</span>
      <span>Status · Project</span>
      <span>Active</span>
    </div>
  );
}

/** `inProject`: the rows sit under their project's heading, so they don't repeat it. */
export function Rows({ windows, multiHost, narrow, onOpen, quiet, inProject }: { windows: Win[]; multiHost: boolean; narrow: boolean; onOpen: Props['onOpen']; quiet?: boolean; inProject?: boolean }) {
  // A finger held on a row: its menu, as iOS lists open one (PressMenu.tsx).
  const actions = useContext(SessionActionsContext);
  const { bind, menu } = usePressMenu();
  return (
    <ul className="rows">
      {menu}
      {windows.map((w) => {
        const { color } = look(w.agent);
        const place = inProject ? (multiHost ? w.host : '') : where(w, multiHost);
        const pill = <span className={`pill ${statusClass(w) === 'idle' ? '' : statusClass(w)}`}>{statusWord(w)}</span>;
        return (
          <li key={w.key} data-flip={w.key}>
            <Swipe actions={actions ? sessionSwipes(w, actions) : []}>
              <button className={`row ${quiet ? 'quiet' : ''}`} style={{ '--agent': color } as React.CSSProperties} onClick={() => onOpen(w)} {...(actions ? bind(() => sessionItems(w, actions)) : {})}>
                <span className="chip">
                  <AgentLogo id={w.agent} />
                </span>
                {narrow ? (
                  <>
                    <span className="stack">
                      <span className="name">{w.title}</span>
                      <span className="sub">{sessionLine(w, { project: !inProject, host: multiHost })}</span>
                    </span>
                    <span className="when">{pill}</span>
                  </>
                ) : (
                  <>
                    {/* With nothing to say in Detail, the title takes its column. */}
                    <span className={`name ${w.detail ? '' : 'solo'}`}>{w.title}</span>
                    {w.detail && <span className="detail">{w.detail}</span>}
                    <span className="meta">
                      {pill}
                      {w.queued > 0 && <span className="pill waiting">⇥ {w.queued} queued</span>}
                      <span className="where" title={place}>{place}</span>
                    </span>
                    <span className="when">{age(w.activity)}</span>
                  </>
                )}
              </button>
            </Swipe>
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
          <h2 className={`section-label ${i === 0 ? 'first' : ''}`} data-flip={`h:${section.id}`}>
            <span className="section-name" title={section.id}>{section.id}</span> <span className="count">{section.windows.length}</span>
          </h2>
          <Rows windows={section.windows} multiHost={multiHost && by !== 'host'} narrow={false} onOpen={onOpen} inProject={by === 'project'} />
        </section>
      ))}
    </>
  );
}
