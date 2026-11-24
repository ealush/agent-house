import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DecisionCard } from './DecisionCard.tsx';
import { InterruptedCard } from './InterruptedCard.tsx';
import type { HistoryItem, HostApi, ReviewAlert, SearchHit, State, Win } from './api.ts';
import { AskPanel, AskSummary } from './AskPanel.tsx';
import { KIND_LABEL } from './askView.ts';
import { ShortcutHint, shortcutTitle } from './shortcuts.tsx';
import { Icon } from './icons.tsx';
import { Reveal } from './Handoff.tsx';
import { age, look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { useSavedGroups } from './groupOrder.ts';
import { byRecency, lastActive, pinsFirst, sidebarSections } from './sessionOrder.ts';
import { Glide } from './Glide.tsx';
import { useFlip } from './useFlip.ts';
import { statusClass, statusCounts, statusWord } from './status.ts';
import { sessionLine } from './sessionLine.tsx';
import { SessionActionsContext, sessionItems, sessionSwipes, usePressMenu } from './PressMenu.tsx';
import { Swipe } from './Swipe.tsx';
import { SearchResults } from './SearchResults.tsx';
import { canonicalProjectPath, chosenProject, inboxProjects, inProject, NOT_IN_A_SPACE, projectFolder, projectLabel, storedProject, type InboxProject } from './inboxProject.ts';
import { ActionSheet } from './sheet.tsx';
import { useDismiss } from './useDismiss.ts';
import { focusFirst } from './rove.ts';
import { NewSpaceDialog, SpaceSettingsDialog } from './SpaceDialogs.tsx';
import { SpaceMenu, SpacePortal, spaceAbilities, type SpaceTool } from './SpacePortal.tsx';
import { chiefsInSpace } from './spacePortal.ts';
import { plainSpaces, spaceOn, useSpaces } from './spaces.ts';

export type InboxGroup = 'status' | 'host' | 'project';

type Props = {
  state: State;
  narrow: boolean;
  groupBy: InboxGroup;
  setGroupBy: (g: InboxGroup) => void;
  onOpen: (w: Win, reply?: boolean) => void;
  onOpenKey?: (key: string) => void;
  onAnswer: (w: Win, answer: 'approve' | 'deny') => void;
  clientFor: (host: string | undefined) => HostApi;
  /** Open New session; in a chosen Space, `where` carries its folder, host and Space Chief context. */
  onNew: (where?: { cwd?: string; host?: string; spaceContext?: { name: string; host: string; chiefs: Win[] } }) => void;
  refresh?: (host?: string) => Promise<State | null>;
  hostHome?: (host: string) => string;
  hostStateFor?: (host: string) => State | null | undefined;
  onSettings: () => void;
  /** The Notes page, from a phone's header (no sidebar there). */
  onNotes?: () => void;
  /** Open a stack under review at a layer. */
  onReview?: (stack: string, pr?: number | null) => void;
  /** Continue a session from another device (Handoff), when there is one. */
  handoff?: React.ReactNode;
  /** An empty inbox offers the latest conversations to resume. */
  onResume?: (h: HistoryItem) => void;
  /** Opens an ended conversation where it was (an interrupted one, from its card). */
  onOpenHistory?: (h: HistoryItem) => void;
  /**
   * The search field's state. It lives with App, so a session opened from the results
   * comes back to the same search, as an iOS search does.
   */
  search: InboxSearch;
  setSearch: (s: InboxSearch) => void;
  /** Bumped to put the keyboard in the search field (⌃⇧5, a link to #search). */
  focusSearch: number;
  touch: boolean;
  onOpenHit: (host: string, hit: SearchHit, target?: number) => void;
  onForget: (h: HistoryItem) => void;
  onFork?: (h: HistoryItem) => void;
  onMove?: (h: HistoryItem) => void;
  /** The project the Inbox shows (inboxProject.ts), as stored on this device; '' for all. */
  project: string;
  setProject: (stored: string) => void;
};

/** `open`: the Inbox shows search results instead of its sections, from the field's first focus until Cancel. */
export type InboxSearch = { open: boolean; query: string };

// A press on a result blurs the field before its click lands: a blur this soon after a
// press there is that press, and leaves search open for the row it opens.
const PRESS_MS = 800;


const where = (w: Win, multiHost: boolean) => {
  const spaceLabel = w.space && w.space !== w.project ? `${w.space} · ${w.project}` : (w.space || w.project);
  return [multiHost ? w.host : null, spaceLabel].filter(Boolean).join(' · ');
};

/** The home screen: what's blocked on you first, then what's working, then the rest; or every session by project or host. */
export function Inbox({ state: all, project: storedChoice, setProject, narrow, groupBy, setGroupBy, onOpen, onOpenKey, onAnswer, clientFor, onNew: openNew, refresh, hostHome, hostStateFor, onSettings, onNotes, onReview, handoff, onResume, onOpenHistory, search, setSearch, focusSearch, touch, onOpenHit, onForget, onFork, onMove }: Props) {
  // One Space, when one is chosen from the title: enters that Space's Portal (sessions, Chief of Staff, Space notes, files/artifacts, tasks, memory).
  // An empty plain Space is one too (server/spaces): its host lists it.
  const spaces = useSpaces(all, (h) => clientFor(h));
  const [spaceDialog, setSpaceDialog] = useState<'new' | 'settings' | null>(null);
  // The hosts that say which Space each session is in (`spaces` 3): there a project is never a Space.
  const spaced = new Set(all.hosts.map((h) => h.name).filter((h) => ((hostStateFor?.(h) ?? (h === all.hostname ? all : null))?.features?.spaces ?? 0) >= 3));
  const projects = inboxProjects(all.windows, all.history, plainSpaces(spaces.lists), spaced);
  const chosen = chosenProject(storedChoice, projects);
  const hubSpaces = spaces.lists.find((l) => l.host === all.hostname);
  const chosenSpace = chosen?.name ? spaceOn(spaces.lists, chosen.host, chosen.name) : null;
  const state: State = chosen ? { ...all, windows: all.windows.filter((w) => inProject(w, chosen, spaced)), history: all.history.filter((h) => inProject(h, chosen, spaced)) } : all;
  const chosenLabel = chosen ? projectLabel(chosen, all.hosts.length > 1) : '';
  const spaceChiefs = chosen?.name ? chiefsInSpace(all.windows, chosen.name, chosen.host, spaced.has(chosen.host)) : [];
  // What the Space's menu asked of its page (a sheet, a new note, Start Chief), until it's done.
  const [spaceTool, setSpaceTool] = useState<SpaceTool | null>(null);
  const toolFor = chosen?.name ? `${chosen.host}\n${chosen.name}` : '';
  useEffect(() => setSpaceTool(null), [toolFor]);
  const chosenHostState = chosen ? (hostStateFor?.(chosen.host) ?? all) : all;
  const spaceMenu = chosen?.name ? (
    <SpaceMenu
      spaceName={chosen.name}
      path={chosenSpace?.path ? canonicalProjectPath(chosenSpace.path) : null}
      abilities={spaceAbilities({ space: chosenSpace, spaceName: chosen.name, host: chosen.host, home: hostHome ? hostHome(chosen.host) : all.home, windows: state.windows, allWindows: all.windows, hostState: chosenHostState })}
      narrow={narrow}
      onTool={setSpaceTool}
      onSettings={chosenSpace ? () => setSpaceDialog('settings') : undefined}
    />
  ) : null;
  // New session, with a Space chosen, starts in its first project (else its own folder) and offers its Chief(s) for supervision.
  const onNew = () => {
    if (!chosen) return openNew(undefined);
    if (!chosen.name) return openNew({ host: chosen.host, spaceContext: { name: '', host: chosen.host, chiefs: [] } });
    const attached = chosenSpace?.projects?.[0];
    const folder = spaced.has(chosen.host)
      ? { cwd: attached ?? chosenSpace?.path ?? undefined, host: chosen.host }
      : (projectFolder(chosen, all.windows, all.history) ?? (chosenSpace?.path ? { cwd: chosenSpace.path, host: chosen.host } : { host: chosen.host }));
    openNew({ ...folder, spaceContext: { name: chosen.name, host: chosen.host, chiefs: spaceChiefs } });
  };
  const cutOff = state.history.filter((h) => h.interrupted && h.host === state.hostname);
  // Sessions cut off by a crash or restart (server/interruptions), on the host you opened: one card per incident
  // (with a project chosen, the incidents that cut off one of its sessions).
  const incidents = (state.interruptions?.incidents ?? []).filter((i) => !chosen || cutOff.some((h) => h.interrupted!.incident === i.id));
  const recent = state.windows.length ? [] : state.history.filter((h) => !h.interrupted).slice(0, 3);
  const multiHost = state.hosts.length > 1;
  // Grouping by host says nothing with one host, so it is only offered with several.
  // A device that chose it then sees its sessions by project, the nearest grouping.
  const groups: InboxGroup[] = multiHost ? ['status', 'host', 'project'] : ['status', 'project'];
  const by = groupBy === 'host' && !multiHost ? 'project' : groupBy;
  const waiting = pinsFirst(state.windows.filter((w) => w.status === 'waiting'));
  const reviews = onReview ? (state.review?.alerts ?? []) : [];
  // Scheduled workflows waiting on you (server/jobs), on the host you opened.
  const decisions = state.jobs?.waiting ?? [];
  const needs = waiting.length + reviews.length + decisions.length + incidents.length;
  const running = pinsFirst(state.windows.filter((w) => w.status === 'busy'));
  const rest = byRecency(state.windows.filter((w) => w.status === 'attention' || w.status === 'idle'));
  const flip = useFlip<HTMLDivElement>([by, waiting, running, rest, reviews.map((r) => ({ key: `${r.stackId}:${r.pr}:${r.kind}` }))].map((l) => (typeof l === 'string' ? l : l.map((w) => w.key).join(','))).join('|'));
  const online = state.hosts.filter((h) => h.online).length;
  const seg = (
    <div className={`seg ${narrow ? 'inbox-seg' : ''}`} role="tablist" aria-label="Group by">
      <Glide match=".on" className="thumb" />
      {groups.map((g) => (
        <button key={g} role="tab" aria-selected={by === g} className={by === g ? 'on' : ''} onClick={() => setGroupBy(g)}>
          {g === 'project' ? 'Space' : g[0].toUpperCase() + g.slice(1)}
        </button>
      ))}
    </div>
  );

  // A phone has no sidebar to show hosts in: it says how many are up, when there is more than one.
  const hosts = narrow && state.hosts.length > 1 ? `${online} of ${state.hosts.length} hosts online. ` : '';
  // "All quiet." isn't true while sessions sit cut off by a crash.
  const cutCount = chosen ? cutOff.length : (state.interruptions?.count ?? 0);
  const cutWord = cutCount ? `${cutCount} interrupted.` : '';
  const counts = hosts + (cutCount && !state.windows.length ? cutWord : [statusCounts(state.windows), cutWord].filter(Boolean).join(' '));
  // The title names the project; with several hosts the tagline says which host's it is.
  const subtitle = chosen && multiHost ? `On ${chosen.host} · ${counts}` : counts;

  const empty = state.windows.length === 0 && (
    <div className="empty-state">
      <p className="empty-title">{chosen ? `Nothing running in ${chosenLabel}.` : 'Nothing running.'}</p>
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
  );

  const field = useRef<HTMLInputElement>(null);
  const pressed = useRef(0);
  const bar = useRef<HTMLDivElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const { open: searching, query } = search;
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    if (focusSearch) field.current?.focus();
  }, [focusSearch]);
  // "/" finds, as in most lists a power user knows (GitHub, Gmail), unless you are typing.
  useEffect(() => {
    const slash = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], .xterm, dialog')) return;
      e.preventDefault();
      field.current?.focus();
    };
    window.addEventListener('keydown', slash);
    return () => window.removeEventListener('keydown', slash);
  }, []);
  const cancel = () => {
    setSearch({ open: false, query: '' });
    field.current?.blur();
  };
  const searchBar = (
    <div className="inbox-search" ref={bar}>
      <label className="field">
        <input
          ref={field}
          type="search"
          value={query}
          // A phone's field shares its row with Cancel: the one word, as iOS's.
          placeholder={narrow ? 'Search' : 'Search sessions, past conversations and what was said'}
          aria-label="Search sessions and conversations"
          enterKeyHint="search"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => !searchRef.current.open && setSearch({ ...searchRef.current, open: true })}
          onChange={(e) => setSearch({ open: true, query: e.target.value })}
          onBlur={(e) => {
            // An empty field let go of goes back to the Inbox; not for a press on a result
            // (the row it opens comes back to this search), the window losing focus, or Cancel.
            if (query || !document.hasFocus() || performance.now() - pressed.current < PRESS_MS) return;
            if (e.relatedTarget instanceof Node && (results.current?.contains(e.relatedTarget) || bar.current?.contains(e.relatedTarget))) return;
            setSearch({ open: false, query: '' });
          }}
          onKeyDown={(e) => {
            // The on-screen keyboard's Search key puts it away, to show what was found.
            if (e.key === 'Enter' && document.documentElement.dataset.keyboard !== undefined) return e.currentTarget.blur();
            // Down from the field lands on the first row; Enter opens it.
            const first = e.currentTarget.closest('.page')?.querySelector<HTMLElement>('.search-lists button.row, .search-lists button.resume, button.search-hit-head');
            if (first && (e.key === 'ArrowDown' || e.key === 'Enter')) {
              e.preventDefault();
              if (e.key === 'Enter') first.click();
              else first.focus();
            } else if (e.key === 'Escape') {
              // Clears first; an empty field leaves search, back to the Inbox.
              e.preventDefault();
              if (query) setSearch({ open: true, query: '' });
              else cancel();
            }
          }}
        />
      </label>
      {searching && (
        <button className="btn ghost inbox-search-cancel" onPointerDown={(e) => e.preventDefault()} onClick={cancel}>
          Cancel
        </button>
      )}
    </div>
  );

  return (
    <div className="page" data-title={chosen ? chosen.name || NOT_IN_A_SPACE : 'Inbox'} ref={flip} data-rove={searching ? 'button.row, button.resume, button.search-hit-head' : 'button.card-title, button.row, button.empty-recent-row'}>
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">
            <ProjectMenu
              projects={projects}
              virtualSpaceKeys={new Set(plainSpaces(spaces.lists).map((s) => `${s.host}\n${s.project}`))}
              detailOf={(p) => (spaceOn(spaces.lists, p.host, p.name)?.projects ?? []).map((x) => x.split('/').pop()).join(', ')}
              chosen={chosen}
              multiHost={all.hosts.length > 1}
              narrow={narrow}
              onPick={(p) => setProject(storedProject(p))}
              onNewSpace={hubSpaces ? () => setSpaceDialog('new') : undefined}
            />
          </h1>
          <p className="tagline">{subtitle}</p>
        </div>
        {narrow ? (
          <>
            {/* A phone has no sidebar: its notes are a button away, beside Settings. */}
            {spaceMenu}
            {/* In a Space, its notes are its page's (Sessions · Notes). */}
            {onNotes && !chosen?.name && (state.features?.notes ?? 0) > 0 && (
              <button className="icon-btn round" onClick={onNotes} aria-label="Notes">
                <Icon name="note" size={19} />
              </button>
            )}
            <button className="icon-btn round" onClick={onSettings} aria-label="Settings">
              <Icon name="gear" size={19} />
            </button>
            <button className="icon-btn round light" onClick={onNew} aria-label="New session">
              <Icon name="plus" size={22} />
            </button>
          </>
        ) : (
          <>
            {!searching && !chosen && seg}
            {spaceMenu}
            <button className="btn light" onClick={onNew}>
              New session
            </button>
          </>
        )}
      </header>
      {/* Outside the title: a dialog there would wear the heading's type. */}
      {spaceDialog === 'new' && hubSpaces && (
        <NewSpaceDialog
          client={clientFor(all.hostname)}
          root={hubSpaces.list.root}
          withProjects={spaced.has(all.hostname)}
          extra={all.windows.filter((w) => w.host === all.hostname).map((w) => w.projectPath)}
          onClose={() => setSpaceDialog(null)}
          onMade={(s) => {
            setSpaceDialog(null);
            setProject(storedProject({ name: s.name, host: all.hostname }));
            spaces.reload();
          }}
        />
      )}
      {spaceDialog === 'settings' && chosen && chosenSpace && (
        <SpaceSettingsDialog
          client={clientFor(chosen.host)}
          host={chosen.host}
          space={chosenSpace}
          multiHost={all.hosts.length > 1}
          supportsSpaceContext={((hostStateFor?.(chosen.host) ?? all).features?.spaces ?? 0) >= 2}
          extra={all.windows.filter((w) => w.host === chosen.host).map((w) => w.projectPath)}
          onChanged={() => spaces.reload()}
          onClose={() => setSpaceDialog(null)}
          onRemoved={() => {
            setSpaceDialog(null);
            setProject('');
            spaces.reload();
          }}
        />
      )}
      {searchBar}
      {searching ? (
        <div ref={results} onPointerDownCapture={() => (pressed.current = performance.now())} onPointerUpCapture={() => (pressed.current = performance.now())}>
          <SearchResults query={query} project={chosen} client={clientFor(state.hostname)} onOpenHit={onOpenHit} state={state} narrow={narrow} touch={touch} onOpen={onOpen} onResume={(h) => onResume?.(h)} onForget={onForget} onFork={onFork} onMove={onMove} />
        </div>
      ) : (() => {
        const sessionContent = (
          <>
            {/* A phone's header has no room beside the title: the grouping gets its own row under it (not inside a single Space Portal). */}
            {narrow && !chosen && state.windows.length > 0 && seg}
            <Reveal>{handoff}</Reveal>

            {!incidents.length && empty}

            {/* What needs you leads in every grouping, as cards; the rows below leave those sessions out. */}
            {needs > 0 && (
              <>
                <h2 className="section-label waiting first" data-flip="h:waiting">
                  Needs you <span className="count">{needs}</span>
                </h2>
                <div className="cards">
                  {incidents.map((i) => (
                    <InterruptedCard key={i.id} incident={i} sessions={cutOff.filter((h) => h.interrupted!.incident === i.id).sort((a, b) => Number(b.interrupted!.midTurn) - Number(a.interrupted!.midTurn))} client={clientFor(state.hostname)} onOpen={(h) => (onOpenHistory ?? onResume)?.(h)} />
                  ))}
                  {waiting.map((w) => (
                    <AskCard key={w.key} w={w} client={clientFor(w.host)} multiHost={multiHost} narrow={narrow} onOpen={onOpen} onAnswer={onAnswer} />
                  ))}
                  {reviews.map((r) => (
                    <ReviewCard key={`${r.stackId}:${r.pr}:${r.kind}`} r={r} onOpen={() => onReview!(r.stackId, r.pr)} />
                  ))}
                  {decisions.map((d) => (
                    <DecisionCard key={d.runId} d={d} client={clientFor(state.hostname)} />
                  ))}
                </div>
              </>
            )}
            {!chosen && by !== 'status' ? (
              <Grouped windows={state.windows.filter((w) => w.status !== 'waiting')} allWindows={all.windows} by={by} multiHost={multiHost} narrow={narrow} onOpen={onOpen} below={needs > 0} />
            ) : (
              <>
                {running.length > 0 && (
                  <>
                    <h2 className={`section-label busy ${needs ? '' : 'first'}`} data-flip="h:running">
                      Working <span className="count">{running.length}</span>
                    </h2>
                    {!narrow && <ListHead flip="lh:running" />}
                    <Rows windows={running} allWindows={all.windows} multiHost={multiHost} narrow={narrow} onOpen={onOpen} inProject={!!chosen} />
                  </>
                )}
                {rest.length > 0 && (
                  <>
                    <h2 className={`section-label ${needs || running.length ? '' : 'first'}`} data-flip="h:rest">Idle and done <span className="count">{rest.length}</span></h2>
                    {!narrow && <ListHead flip="lh:rest" />}
                    <Rows windows={rest} allWindows={all.windows} multiHost={multiHost} narrow={narrow} onOpen={onOpen} quiet inProject={!!chosen} />
                  </>
                )}
              </>
            )}
            {incidents.length > 0 && empty}
          </>
        );
        if (!chosen || !chosen.name) return sessionContent;
        return (
          <SpacePortal
            space={chosenSpace}
            spaceName={chosen.name}
            host={chosen.host}
            home={hostHome ? hostHome(chosen.host) : all.home}
            windows={state.windows}
            allWindows={all.windows}
            state={all}
            hostState={chosenHostState}
            client={clientFor(chosen.host)}
            narrow={narrow}
            onOpen={(w) => onOpen(w)}
            onOpenKey={(k) => (onOpenKey ? onOpenKey(k) : undefined)}
            onNewSession={onNew}
            tool={spaceTool}
            onTool={setSpaceTool}
            refresh={refresh ?? (async () => null)}
          >
            {sessionContent}
          </SpacePortal>
        );
      })()}
    </div>
  );
}

/**
 * The Inbox's title, and the menu it opens: All Spaces, then every Space with a session or
 * a conversation (and every plain one), then New Space… (docs/spec/17-spaces.md); the shown
 * Space's settings are its own menu's (SpaceMenu). A desktop's drops from the title; a phone's is an action sheet,
 * as its other menus are. Arrows move, Enter picks, Escape closes.
 */
function ProjectMenu({ projects, virtualSpaceKeys, detailOf, chosen, multiHost, narrow, onPick, onNewSpace }: { projects: InboxProject[]; virtualSpaceKeys: Set<string>; detailOf: (p: InboxProject) => string; chosen: InboxProject | null; multiHost: boolean; narrow: boolean; onPick: (p: InboxProject | null) => void; onNewSpace?: () => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useDismiss(open && !narrow, wrap, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    // Opens on the current choice, as a native menu does; arrows move from there.
    requestAnimationFrame(() => {
      const on = menu.current?.querySelector<HTMLElement>('[aria-checked="true"]');
      if (on) on.focus();
      else focusFirst(menu.current);
    });
    // Closed by a choice or Escape: the keyboard goes back to the title.
    return () => {
      const a = document.activeElement;
      if (!a || a === document.body || menu.current?.contains(a) || !a.isConnected) requestAnimationFrame(() => button.current?.focus({ preventScroll: true }));
    };
  }, [open]);
  const pick = (p: InboxProject | null) => {
    setOpen(false);
    onPick(p);
  };
  const item = (p: InboxProject | null) => {
    const on = p ? !!chosen && p.name === chosen.name && p.host === chosen.host : !chosen;
    const detail = p?.name ? detailOf(p) : '';
    return (
      <button key={p ? `${p.host}\n${p.name}` : 'all'} role="menuitemradio" aria-checked={on} onClick={() => pick(p)} className={p && !p.name ? 'menu-none' : undefined}>
        <span className="grow menu-item-text">
          <span>{p ? projectLabel(p, multiHost) : 'All sessions'}</span>
          {detail && <span className="menu-item-detail">{detail}</span>}
        </span>
        {on && <Icon name="check" size={15} />}
      </button>
    );
  };
  const virtualSpaces = projects.filter((p) => virtualSpaceKeys.has(`${p.host}\n${p.name}`));
  // Not in a Space (name ''): a spaces 3 host's sessions in none, after the Spaces.
  const none = projects.filter((p) => !p.name);
  // An older host's projects, which were its Spaces.
  const repoProjects = projects.filter((p) => p.name && !virtualSpaceKeys.has(`${p.host}\n${p.name}`));
  const body = (
    <div ref={menu} data-rove role="menu" aria-label="Show sessions from" className={narrow ? 'menu sheet' : 'menu project-menu'} style={narrow ? { margin: 0 } : undefined}>
      {item(null)}
      {virtualSpaces.length > 0 && (
        <>
          <div className="menu-section" role="presentation">Spaces</div>
          {virtualSpaces.map(item)}
        </>
      )}
      {none.map(item)}
      {repoProjects.length > 0 && (
        <>
          {virtualSpaces.length > 0 && <div className="menu-section" role="presentation">Projects</div>}
          {repoProjects.map(item)}
        </>
      )}
      {onNewSpace && <hr />}
      {onNewSpace && (
        <button role="menuitem" onClick={() => (setOpen(false), onNewSpace())}>
          <span className="grow">New Space…</span>
          <Icon name="plus" size={15} />
        </button>
      )}
    </div>
  );
  return (
    <span className="menu-wrap title-menu" ref={wrap}>
      <button ref={button} type="button" className={`title-pick ${chosen ? 'chosen' : ''}`} aria-haspopup="menu" aria-expanded={open} title={chosen ? `Showing ${projectLabel(chosen, multiHost)} only` : 'Show one Space only'} onClick={() => setOpen(!open)}>
        {/* A Space's name stands in for "Inbox"; a long one ends in an ellipsis, as an iOS title does. */}
        <span className="title-name">
          {chosen ? chosen.name || NOT_IN_A_SPACE : 'Inbox'}
          <span className="period">.</span>
        </span>
        <Icon name="chevron-down" size={narrow ? 18 : 16} />
      </button>
      {open && (narrow ? createPortal(<ActionSheet onClose={() => setOpen(false)}>{body}</ActionSheet>, document.body) : body)}
    </span>
  );
}

function AskCard({ w, client, multiHost, narrow, onOpen, onAnswer }: { w: Win; client: HostApi; multiHost: boolean; narrow: boolean; onOpen: Props['onOpen']; onAnswer: Props['onAnswer'] }) {
  const { color, name } = look(w.agent);
  const modelLabel = shortModel(w.model);
  const ask = w.ask;
  // Answerable right here: the agent's questions, the rows of its picker, or the
  // screen in front of its prompt (its link, code and box).
  const inline = !!ask && ((ask.kind === 'choice' && (!!ask.questions?.length || !!ask.dialog)) || !!ask.options?.length || !!ask.gate);
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
        <span className="card-age">{age(lastActive(w))}</span>
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
      <span>Status · Space</span>
      <span>Active</span>
    </div>
  );
}

/** `inProject`: the rows sit under their Space's heading, so they only show differing repo folders. */
export function Rows({ windows, allWindows, multiHost, narrow, onOpen, quiet, inProject }: { windows: Win[]; allWindows?: Win[]; multiHost: boolean; narrow: boolean; onOpen: Props['onOpen']; quiet?: boolean; inProject?: boolean }) {
  // A finger held on a row: its menu, as iOS lists open one (PressMenu.tsx).
  const actions = useContext(SessionActionsContext);
  const { bind, menu } = usePressMenu();
  const lookup = allWindows ?? windows;
  return (
    <ul className="rows">
      {menu}
      {windows.map((w) => {
        const { color } = look(w.agent);
        const manager = w.supervision?.managedBy ? lookup.find((x) => x.host === w.host && x.uid === w.supervision!.managedBy) : null;
        const place = inProject
          ? [multiHost ? w.host : null, w.space && w.space !== w.project ? w.project : null].filter(Boolean).join(' · ')
          : where(w, multiHost);
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
                      <span className="name">
                        {w.title}
                        {w.supervision?.role === 'chief' && <span className="chief-badge" style={{ marginLeft: 6 }}>Chief</span>}
                      </span>
                      <span className="sub">
                        {manager ? `Under ${manager.title || manager.name} · ` : ''}
                        {sessionLine(w, { project: !inProject, host: multiHost })}
                      </span>
                    </span>
                    <span className="when">{pill}</span>
                  </>
                ) : (
                  <>
                    {/* With nothing to say in Detail, the title takes its column. */}
                    <span className={`name ${w.detail ? '' : 'solo'}`}>{w.title}</span>
                    {w.detail && <span className="detail">{w.detail}</span>}
                    <span className="meta">
                      {w.supervision?.role === 'chief' && <span className="pill chief-pill">Chief</span>}
                      {manager && <span className="worker-pill" title={`Supervised by ${manager.title || manager.name}`}>↳ {manager.title || manager.name}</span>}
                      {pill}
                      {w.queued > 0 && <span className="pill waiting">⇥ {w.queued} queued</span>}
                      {place && <span className="where" title={place}>{place}</span>}
                    </span>
                    <span className="when">{age(lastActive(w))}</span>
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

/** The Inbox by project or host: the sidebar's blocks in its order (pinned first, then as you arranged them), a block only for sessions it still has. A phone has no sidebar, so this is its list of every session too. */
function Grouped({ windows, allWindows, by, multiHost, narrow, onOpen, below }: { windows: Win[]; allWindows?: Win[]; by: 'host' | 'project'; multiHost: boolean; narrow: boolean; onOpen: Props['onOpen']; /** Under the Needs you cards: the first block isn't the page's first heading. */ below: boolean }) {
  const sections = sidebarSections(windows, by === 'host', useSavedGroups(by === 'host'));
  return (
    <>
      {sections.map((section, i) => (
        <section key={section.id}>
          <h2 className={`section-label ${i === 0 && !below ? 'first' : ''}`} data-flip={`h:${section.id}`}>
            <span className="section-name" title={section.id}>{section.id}</span> <span className="count">{section.windows.length}</span>
          </h2>
          <Rows windows={section.windows} allWindows={allWindows} multiHost={multiHost && by !== 'host'} narrow={narrow} onOpen={onOpen} inProject={by === 'project'} />
        </section>
      ))}
    </>
  );
}
