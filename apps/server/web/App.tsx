import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { HostFeaturesContext, HostPresetsContext, PresetsContext } from './ModelPicker.tsx';
import { ResumeContext } from './recent.ts';
import { CLIENT_ID, deviceName, waitForWindow, type HistoryItem, type SearchHit, type SendResult, type State, type Win } from './api.ts';
import { useHosts } from './useHosts.ts';
import { Sidebar, type Page } from './Sidebar.tsx';
import { useSavedGroups } from './groupOrder.ts';
import { sidebarOrder } from './sessionOrder.ts';
import { look } from './agents.ts';
import { loadSpaces, occupied, saveSpaces, sendTo, switchTo, type Slot, type Spaces } from './workspaces.ts';
import { useTheme } from './useTheme.ts';
import { setOmarchyPalette } from './theme.ts';
import { focusPage } from './rove.ts';
import { hasLegacy, isLegacyKey, upgradeKey, upgradeLayout, upgradeSpaces } from './sessionKeys.ts';


const SUBMAP_KEYS: Record<'resize' | 'pane', Array<[string[], string]>> = {
  resize: [
    [['←', '↓', '↑', '→'], 'move the divider'],
    [['H', 'J', 'K', 'L'], 'same'],
    [[modLabel('shift')], 'bigger steps'],
    [['Esc'], 'done'],
  ],
  pane: [
    [['H', 'J', 'K', 'L'], 'focus'],
    [[modLabel('shift'), 'HJKL'], 'move'],
    [['V'], 'split right'],
    [['S'], 'split below'],
    [['P'], 'replace'],
    [['X'], 'close'],
    [['F'], 'maximize'],
    [['T'], 'flip'],
    [['R'], 'resize'],
    [['O'], 'open here'],
    [['N'], 'new session'],
    [['1–9'], 'workspace'],
    [['Esc'], 'done'],
  ],
};
import { cycleKey } from './keyboard.ts';
import { Inbox, type InboxGroup, type InboxSearch } from './Inbox.tsx';
import { Session } from './Session.tsx';
import { EndedSession } from './Ended.tsx';
import { HandoffOffer } from './Handoff.tsx';
import { Workspace, focusPaneNow } from './Workspace.tsx';
import { closeLeaf, isPick, pickKey, leaves, moveLeaf, nudgeDivider, neighborPane, nodeAt, normalizeSplit, paneLeaves, parseLayout, replaceLeaf, splitLeaf, toggleSplit, type LayoutNode, type PaneDir, type Path } from './layout.ts';
import { lastCwd, NewDialog } from './NewDialog.tsx';
import type { ForkTarget } from './ForkDialog.tsx';
import { Switcher } from './Switcher.tsx';
import { WorktreesDialog } from './Git.tsx';
import { pushStatus, pushSupport, registerWorker } from './notify.ts';
import { API_VERSION } from './api.ts';
import { showError } from './ask.tsx';
import { Icon } from './icons.tsx';
import { useSwipeBack } from './useSwipeBack.ts';
import { edgeGesture } from './edges.ts';
import { useSideSwipe } from './useSideSwipe.ts';
import { SessionActionsContext, type SessionActions } from './PressMenu.tsx';
import { Sheet } from './sheet.tsx';
import { trackViewport } from './viewport.ts';
import { glide, transition, type Heading } from './motion.ts';
import { modLabel, runCommand } from './shortcuts.ts';
import { statusWord } from './status.ts';
import { CommandPalette, Keycaps, Shortcuts, ShortcutsDialog, WhichKey, shortcutTitle, useCommand, usePaletteProvider } from './shortcuts.tsx';
import { TabBar } from './TabBar.tsx';
import { errorText } from './errors.ts';
import { backToList, restartServer, sectionHash, SECTIONS, settingsNodes, useSectionPart } from './settingsMenu.ts';
import { reviewHash } from './reviewApi.ts';
import { ReviewContext } from './reviewContext.ts';
import { notesBook } from './useNotes.ts';
import { noteTitle } from './notes.ts';

// Pages and dialogs most visits never open load on first use.
const Settings = lazy(() => import('./Settings.tsx').then((m) => ({ default: m.Settings })));
const ReviewPage = lazy(() => import('./review/ReviewPage.tsx'));
const JobsView = lazy(() => import('./JobsView.tsx').then((m) => ({ default: m.JobsView })));
const UsageView = lazy(() => import('./UsageView.tsx').then((m) => ({ default: m.UsageView })));
const NotesView = lazy(() => import('./NotesView.tsx').then((m) => ({ default: m.NotesView })));
const ForkDialog = lazy(() => import('./ForkDialog.tsx').then((m) => ({ default: m.ForkDialog })));
const MoveDialog = lazy(() => import('./MoveDialog.tsx').then((m) => ({ default: m.MoveDialog })));
const ChatSearchDialog = lazy(() => import('./ChatHistory.tsx').then((m) => ({ default: m.ChatSearchDialog })));

function scratchKey(): string | null {
  try {
    return localStorage.getItem('ah.scratch');
  } catch {
    return null;
  }
}

function useMedia(query: string) {
  const [match, setMatch] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const m = matchMedia(query);
    const on = () => setMatch(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return match;
}

function stored<T extends string>(key: string, fallback: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || fallback;
    } catch {
      return fallback;
    }
  });
  return [
    v,
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, next);
      } catch {}
    },
  ];
}

/** Shows a popover element in the top layer: over an open sheet or dialog, which a z-index can't reach.
 * With a session's title bar in view the toast sits under it, not over the title you just arrived at. */
const onTop = (el: HTMLElement | null) => {
  if (!el) return;
  if (!document.querySelector('dialog[open]')) {
    const bars = [...document.querySelectorAll<HTMLElement>('.mobile-session-chrome, .session-head')]
      .filter((h) => h.checkVisibility?.() !== false)
      .map((h) => h.getBoundingClientRect())
      .filter((r) => r.height > 0 && r.top < 60);
    if (bars.length) el.style.top = `${Math.round(Math.max(...bars.map((r) => r.bottom)) + 8)}px`;
  }
  try {
    el.showPopover?.();
  } catch {}
};

// URL hash: "#<uid>" (local session), "#<host>/<uid>" (peer session),
// "#interrupted" (the Inbox, where interrupted sessions are), "#sessions" (the Inbox, which
// took in the phone's Sessions tab), "#search" and "#history" (the Inbox searching: it
// took in Search, which had taken in History).
// "#security" still lands on settings, where Security lives now. Old links
// ("#@12", a tmux window id) still open: App upgrades them once windows are known.
const PAGES = ['settings', 'review', 'notes', 'jobs', 'usage'] as const;
/** The sidebar's pages, top to bottom (its sessions follow), so navigation knows which way it goes. */
const NAV_PAGES = ['inbox', 'review', 'notes', 'jobs', 'usage', 'settings'] as const;
const sameRoute = (a: { page: Page; selected: string | null }, b: { page: Page; selected: string | null }) => a.page === b.page && a.selected === b.selected;

/** A link to Search or History: the Inbox, searching. */
function searchLink(): boolean {
  return location.hash === '#search' || location.hash === '#history';
}

function fromHash(): { page: Page; selected: string | null } {
  let h = '';
  try { h = decodeURIComponent(location.hash.slice(1)); } catch {}
  if (h === 'security' || h.startsWith('settings/')) h = 'settings';
  // Review keeps its own place after the page: #review/<stack>/<pr> (web/review/ReviewPage.tsx).
  if (h.startsWith('review/')) h = 'review';
  // Notes keep the open note after the page: #notes/<id> (web/NotesView.tsx).
  if (h.startsWith('notes/')) h = 'notes';
  // A notification about sessions a crash cut off (server/interruptions): their card is on the Inbox.
  if (h === 'interrupted' || h === 'sessions') return { page: 'inbox', selected: null };
  if (searchLink()) return { page: 'inbox', selected: null };
  if ((PAGES as readonly string[]).includes(h)) return { page: h as Page, selected: null };
  if (/^(?:[\w.-]+\/)?(?:@\d+|[\w-]{4,40})$/.test(h)) return { page: 'inbox', selected: h };
  return { page: 'inbox', selected: null };
}

/** What a message held behind a screen in front of the agent's prompt waits for. */
const HELD: Record<NonNullable<SendResult['held']>, string> = {
  signin: "Your message goes in once you've signed in",
  trust: 'Your message goes in once the folder is trusted',
  setup: 'Your message goes in once the setup screen is answered',
  picker: 'Your message goes in once its question is answered',
};

export function App({ onLock }: { onLock: () => void }) {
  const [{ page, selected }, setRoute] = useState(fromHash);
  const [inboxGroup, setInboxGroup] = stored<InboxGroup>('ah.inboxGroup', 'status');
  // The Inbox's one project (web/inboxProject.ts), per device; '' is All Projects.
  const [inboxProject, setInboxProject] = stored<string>('ah.inboxProject', '');
  const [creating, setCreating] = useState<{ cwd?: string; host?: string; prompt?: string; preset?: string; project?: boolean } | null>(null);
  const [forking, setForking] = useState<ForkTarget | null>(null);
  /** Move to another host: the History item being moved, while its dialog is open. */
  const [moving, setMoving] = useState<{ ref: string; host: string; title: string } | null>(null);
  const [switching, setSwitching] = useState(false);
  const [palette, setPalette] = useState(false);
  const [keymap, setKeymap] = useState(false);
  const [inboxSearch, setInboxSearch] = useState<InboxSearch>(() => ({ open: searchLink(), query: '' }));
  const [focusSearch, setFocusSearch] = useState(0);
  const [pastChatJump, setPastChatJump] = useState<{ host: string; uid: string; msgId: number } | null>(null);
  const [dialog, setDialog] = useState<'worktrees' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [toastOut, setToastOut] = useState(false);
  const toastNow = useRef<string | null>(null);
  const [replyKey, setReplyKey] = useState(0);
  // Portrait phones, and a phone turned sideways: short, coarse, and still
  // narrower than an iPad. The same query is in web/styles.css. A sideways
  // phone is wider than 760px, but the desktop sidebar and modals don't fit
  // its height.
  const narrow = useMedia('(max-width: 760px), ((pointer: coarse) and (max-height: 500px) and (max-width: 1000px))');
  const touch = useMedia('(pointer: coarse)');
  // A link to Search puts the keyboard in the Inbox's field on a desktop, as Search's own page
  // did; a phone or iPad comes to look through the list, which its keyboard would cover.
  useEffect(() => {
    if (searchLink() && !touch && !narrow) setFocusSearch((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Too narrow to keep the sidebar beside the page, too wide for the phone's layout: an iPad in
  // portrait, a Stage Manager window, a narrow desktop window. The sidebar slides over the page
  // instead, as iPadOS apps' do (the same widths are in web/styles.css).
  const tight = useMedia('(min-width: 761px) and (max-width: 1099px)') && !narrow;
  const [sideOver, setSideOver] = useState(false);
  useEffect(() => {
    if (!tight) setSideOver(false);
  }, [tight]);
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem('ah.side') !== '0';
    } catch {
      return true;
    }
  });
  // A stored one-pane layout is not a split. Remember its session so the first paint can open it.
  const resumeSolo = useRef<string | null>(null);
  // Split layout is device-local (F45): a 32" arrangement never follows you to a phone.
  const [layout, setLayoutState] = useState<LayoutNode | null>(() => {
    try {
      const parsed = parseLayout(JSON.parse(localStorage.getItem('ah.layout.v1') ?? 'null'));
      const split = normalizeSplit(parsed);
      if (parsed && !split) resumeSolo.current = paneLeaves(parsed)[0]?.sessionKey ?? null;
      return split;
    } catch {
      return null;
    }
  });
  const [focusPath, setFocusPath] = useState<Path | null>(null);
  // The single session a split was just made from, so its pane grows out of the full view.
  const splitOrigin = useRef<string | null>(null);
  // Where the last pane of a closing split was, so the single view can grow out of it.
  const collapseFrom = useRef<DOMRect | null>(null);
  const reorders = useRef<Record<string, Promise<unknown>[]>>({});
  useLayoutEffect(() => {
    const from = collapseFrom.current;
    const main = document.querySelector<HTMLElement>('.main');
    collapseFrom.current = null;
    if (!from || !main) return;
    const to = main.getBoundingClientRect();
    glide(main, { x: from.left, y: from.top, w: from.width, h: from.height }, { x: to.left, y: to.top, w: to.width, h: to.height });
  });
  const [zoom, setZoom] = useState(false);
  // Hyprland-style submaps: while one is on, it owns the keyboard (Esc leaves).
  const [submap, setSubmap] = useState<null | 'resize' | 'pane'>(null);
  const [scratch, setScratch] = useState(false);
  // Ctrl+Enter / Pane mode o / Open as a new pane: the switcher tiles instead of navigating.
  const [switchTile, setSwitchTile] = useState(false);
  const focused = layout ? nodeAt(layout, focusPath ?? []) : null;
  // A chooser pane (layout.ts PICK) holds no session yet.
  const focusKey = focused?.type === 'session' && !isPick(focused.sessionKey) ? focused.sessionKey : null;
  // Every pane on screen, so the sidebar can mark them all (split view shows several at once).
  const visibleKeys = layout ? leaves(layout) : selected ? [selected] : [];
  const pushActive = useRef(false);
  const prevStatus = useRef(new Map<string, string>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const { state, error, refresh, clientFor, hostState, hide } = useHosts((s: State) => announce(s.windows));
  // Notes (web/notes.ts) live on this page's host; the stream's cursor says when to pull.
  const notesOn = (state?.features?.notes ?? 0) > 0;
  useEffect(() => {
    if (notesOn) notesBook().heard(state?.notes);
  }, [notesOn, state?.notes?.cursor]);
  const savedGroups = useSavedGroups((state?.hosts.length ?? 0) > 1);
  // Sessions are keyed by their uid, which survives resume and tmux restarts (a window id does not).
  const keyFor = (host: string, uid: string) => (host === state?.hostname ? uid : `${host}/${uid}`);
  /** A session that ended, by key: it stays on screen with Resume instead of disappearing. */
  /** Terminate optimistically: the session leaves the UI now and comes back if tmux refuses. */
  const terminate = (w: Win) => {
    hide(w.key, true);
    clientFor(w.host)
      .kill(w.uid)
      .then(
        () => refresh(w.host),
        (e) => {
          hide(w.key, false);
          showError(e, "Couldn't terminate");
        },
      );
  };
  const endedFor = (key: string | null) => (key && state?.history.find((h) => h.kind === 'ended' && keyFor(h.host, h.ref) === key)) || null;

  function toggleSide() {
    if (tight) return setSideOver((v) => !v);
    setSideOpen((v) => {
      try {
        localStorage.setItem('ah.side', v ? '0' : '1');
      } catch {}
      return !v;
    });
  }

  function setLayout(next: LayoutNode | null) {
    splitOrigin.current = null;
    // Closing the second-to-last pane leaves one session. That is the normal view, not a split of one.
    const split = normalizeSplit(next);
    setLayoutState(split);
    if (!split) {
      setFocusPath(null);
      // A lone chooser is no session to grow into: the split simply ends.
      const solo = next ? paneLeaves(next).filter((p) => !isPick(p.sessionKey)) : [];
      if (solo.length === 1) {
        // The last pane grows into the full view, from where it sat.
        const at = document.querySelector(`.ws-root.tiled > .pane[data-tile="${CSS.escape(solo[0].sessionKey)}#0"]`);
        collapseFrom.current = at?.getBoundingClientRect() ?? null;
        go({ selected: solo[0].sessionKey }, { still: !!at, history: 'replace' });
      } else if (next && !solo.length) go({ selected: null }, { history: 'replace' }); // only a chooser was left
    } else {
      const at = focusPath ? nodeAt(split, focusPath) : null;
      if (at?.type === 'split') setFocusPath([...focusPath!, ...paneLeaves(at)[0].path]);
      else if (!at) setFocusPath(paneLeaves(split)[0].path);
    }
    try {
      if (split) localStorage.setItem('ah.layout.v1', JSON.stringify(split));
      else localStorage.removeItem('ah.layout.v1');
    } catch {}
  }

  /**
   * Navigate. A new place is a browser history entry, so Back (the browser's,
   * a mouse's, Alt+←, Android's) walks back through pages and sessions; fixing
   * up the current place (an upgraded link) replaces it, and a popstate has
   * already moved the URL.
   */
  function go(next: { page?: Page; selected?: string | null }, how: { still?: boolean; history?: 'push' | 'replace' | 'none'; path?: string } = {}) {
    const route = { page: next.page ?? page, selected: next.selected === undefined ? selected : next.selected };
    const hash = route.selected ?? (route.page === 'inbox' ? '' : (how.path ?? route.page));
    const mode = how.history ?? (sameRoute(route, { page, selected }) ? 'replace' : 'push');
    const url = hash ? `#${hash}` : location.pathname;
    if (mode === 'push') history.pushState({ ah: route, back: { page, selected } }, '', url);
    else if (mode === 'replace') history.replaceState({ ...history.state, ah: route }, '', url);
    // A phone's Settings is a sheet that rises over the page (sheet.tsx), not a page to fade to.
    const sheet = narrow && (route.page === 'settings') !== (page === 'settings');
    if (how.still || sheet || (route.page === page && route.selected === selected)) setRoute(route);
    else transition(() => setRoute(route), heading(route));
  }
  /**
   * A view's own Back (the chevron, an edge swipe, closing Settings): the
   * browser's Back when it leads to the same place, so the two never disagree
   * and Forward still works; otherwise a replacing step to that place.
   */
  function goBack(to: { page?: Page; selected?: string | null }, how: { still?: boolean } = {}) {
    const target = { page: to.page ?? page, selected: to.selected === undefined ? selected : to.selected };
    const prev = history.state?.back as { page: Page; selected: string | null } | undefined;
    if (prev && sameRoute(prev, target)) {
      // A still step (a swipe that has already carried the view off) lands now: the
      // popstate comes a beat later (longer on iOS), and the old view would be back in between.
      if (how.still) setRoute(target);
      popStill.current = !!how.still;
      // A Settings section opened from its list sits on the list's entry (settingsMenu.ts): past both.
      history.go(history.state?.section ? -2 : -1);
    } else go(target, { ...how, history: 'replace' });
  }
  const popStill = useRef(false);
  const goRef = useRef(go);
  goRef.current = go;
  /** A page reached by a link or Back leaves the split, as picking it in the sidebar does (showPage). */
  const leaveSplitRef = useRef(() => {});
  leaveSplitRef.current = () => {
    if (!layout) return;
    setLayout(null);
    setFocusPath(null);
  };
  /** Where the next view sits relative to this one: further down the sidebar, or deeper on a phone. */
  function heading(to: { page: Page; selected: string | null }): Heading | null {
    if (narrow) return to.selected && !selected ? 'push' : !to.selected && selected ? 'pop' : null;
    const keys = sidebarOrder(state?.windows ?? [], (state?.hosts.length ?? 0) > 1, savedGroups).map((w) => w.key);
    const place = (r: { page: Page; selected: string | null }) => {
      if (r.selected) return keys.includes(r.selected) ? NAV_PAGES.length + keys.indexOf(r.selected) : -1;
      return NAV_PAGES.indexOf(r.page as (typeof NAV_PAGES)[number]);
    };
    const from = place({ page, selected });
    const next = place(to);
    return from < 0 || next < 0 || from === next ? null : next > from ? 'down' : 'up';
  }
  const open = (key: string | null) => {
    // In split view the sidebar points the focused pane at the session (F46);
    // otherwise it navigates the single view.
    if (layout && key) {
      const target = focused?.type === 'session' && focusPath ? focusPath : paneLeaves(layout)[0]?.path;
      if (target) {
        setLayout(replaceLeaf(layout, target, key));
        setFocusPath(target);
        return;
      }
    }
    go({ selected: key });
  };

  /** Alt+Up/Down steps through sessions in sidebar paint order, from any view. */
  const cycleSession = (dir: -1 | 1) => {
    const keys = sidebarOrder(state?.windows ?? [], (state?.hosts.length ?? 0) > 1, savedGroups).map((w) => w.key);
    const next = cycleKey(keys, focusKey ?? selected, dir);
    if (next) open(next);
  };

  const showPage = (p: Page) => {
    setLayout(null);
    setFocusPath(null);
    go({ page: p, selected: null });
  };
  /** A stack under review, or one of its layers (Inbox cards, session banners). */
  const openReview = (stack: string, pr?: number | null) => {
    const path = reviewHash(stack, pr);
    if (page === 'review' && !selected) {
      // Review already shows: a new place inside it, which it hears as a popstate.
      history.pushState({ ah: { page: 'review', selected: null }, back: { page: 'review', selected: null } }, '', `#${path}`);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
      return;
    }
    setLayout(null);
    setFocusPath(null);
    go({ page: 'review', selected: null }, { path });
  };

  /** A note on the Notes page (the palette, New note). */
  const openNote = (id: string, o: { focus?: boolean } = {}) => {
    const path = `notes/${id}`;
    if (page === 'notes' && !selected) {
      history.pushState({ ah: { page: 'notes', selected: null }, back: { page: 'notes', selected: null } }, '', `#${path}`);
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } else {
      setLayout(null);
      setFocusPath(null);
      go({ page: 'notes', selected: null }, { path });
    }
    if (o.focus) setTimeout(() => document.querySelector<HTMLTextAreaElement>('.note-text')?.focus(), 350);
  };

  const focusPane = (dir: PaneDir) => {
    if (!layout) return;
    const from = focusPath ?? paneLeaves(layout)[0]?.path ?? [];
    const next = neighborPane(layout, from, dir);
    if (!next) return;
    focusPaneNow(next.join('/'));
    setFocusPath(next);
  };

  const movePane = (dir: PaneDir) => {
    if (!layout) return;
    const from = focusPath ?? paneLeaves(layout)[0]?.path ?? [];
    const next = moveLeaf(layout, from, dir);
    setLayout(next.layout);
    setFocusPath(next.path);
  };

  const flipSplit = () => {
    if (!layout) return;
    const from = focusPath ?? paneLeaves(layout)[0]?.path ?? [];
    setLayout(toggleSplit(layout, from));
  };

  const exitSplit = () => {
    setLayout(null);
    setFocusPath(null);
  };

  const splitOpen = !!layout && paneLeaves(layout).length > 1;
  useCommand('command-palette', () => setPalette((v) => !v));
  useCommand('switcher', () => setSwitching((v) => !v));
  useCommand('new-session', () => setCreating({}));
  useCommand('new-project', () => setCreating({ project: true }));
  // A phone has no sidebar; toggling it there would only flip the desktop's setting.
  useCommand('toggle-sidebar', toggleSide, !narrow);
  useCommand('cycle-prev', () => cycleSession(-1));
  useCommand('cycle-next', () => cycleSession(1));
  useCommand('go-inbox', () => showPage('inbox'));
  useCommand('go-review', () => showPage('review'));
  useCommand('go-jobs', () => showPage('jobs'));
  useCommand('go-usage', () => showPage('usage'));
  useCommand('go-notes', () => showPage('notes'), notesOn);
  useCommand('new-note', () => openNote(notesBook().create().id, { focus: true }), notesOn);
  useCommand('go-settings', () => showPage('settings'));
  // Search is the Inbox's field: the command shows the Inbox and puts the keyboard there.
  useCommand('go-search', () => {
    showPage('inbox');
    setInboxSearch((s) => ({ ...s, open: true }));
    setFocusSearch((n) => n + 1);
  });
  useCommand('worktrees', () => setDialog('worktrees'));
  useCommand('show-shortcuts', () => setKeymap(true));
  useCommand('reload-page', () => window.location.reload());
  useCommand('focus-pane-left', () => focusPane('left'), splitOpen);
  useCommand('focus-pane-right', () => focusPane('right'), splitOpen);
  useCommand('focus-pane-up', () => focusPane('up'), splitOpen);
  useCommand('focus-pane-down', () => focusPane('down'), splitOpen);
  useCommand('move-pane-left', () => movePane('left'), splitOpen);
  useCommand('move-pane-right', () => movePane('right'), splitOpen);
  useCommand('move-pane-up', () => movePane('up'), splitOpen);
  useCommand('move-pane-down', () => movePane('down'), splitOpen);
  useCommand('toggle-split', flipSplit, splitOpen);
  useCommand('exit-split', exitSplit, !!layout);
  // A chooser pane holds no session, so nothing in it answers the pane commands a session
  // does: split, close (and pane mode's v, s, x) act on it here instead of doing nothing.
  const chooserFocused = !!layout && focused?.type === 'session' && isPick(focused.sessionKey);
  const splitChooser = (dir: 'horizontal' | 'vertical') => {
    if (!layout || !focusPath) return;
    setLayout(splitLeaf(layout, focusPath, dir, pickKey()));
    setFocusPath([...focusPath, 'second']);
  };
  useCommand('split-right', () => splitChooser('horizontal'), chooserFocused);
  useCommand('split-below', () => splitChooser('vertical'), chooserFocused);
  useCommand('close-pane', () => layout && focusPath && setLayout(closeLeaf(layout, focusPath)), chooserFocused);

  // Workspaces 1–9 (workspaces.ts): Alt+N goes there, Alt+Shift+N sends the focused session.
  const [spaces, setSpacesState] = useState(loadSpaces);
  const setSpaces = (next: Spaces) => {
    setSpacesState(next);
    saveSpaces(next);
  };
  const nowSlot = (): Slot => ({ layout, selected: layout ? null : selected });
  const showSlot = (slot: Slot, how: { still?: boolean } = {}) => {
    setZoom(false);
    setLayout(slot.layout);
    if (!slot.layout) go({ page: 'inbox', selected: slot.selected }, how);
  };
  const switchWorkspace = (n: number) => {
    if (n === spaces.current) return;
    const r = switchTo(spaces, n, nowSlot());
    transition(() => {
      setSpaces(r.spaces);
      showSlot(r.show, { still: true });
    }, n > spaces.current ? 'next' : 'prev');
    // The sidebar's workspace row and the slide already say where you are; only a
    // collapsed sidebar leaves the number unsaid.
    if (!sideOpen || narrow) flash(`Workspace ${n}`);
  };
  const sendToWorkspace = (n: number) => {
    const key = layout ? focusKey : selected;
    if (!key || n === spaces.current) return;
    const r = sendTo(spaces, n, key, nowSlot(), layout ? (focusPath ?? paneLeaves(layout)[0]?.path ?? null) : null);
    transition(() => {
      setSpaces(r.spaces);
      showSlot(r.show, { still: true });
    }, n > spaces.current ? 'next' : 'prev');
    flash(`Sent to workspace ${n}`);
  };
  for (const d of [1, 2, 3, 4, 5, 6, 7, 8, 9] as const) {
    // Fixed count and order, so these hooks are stable across renders.
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCommand(`workspace-${d}`, () => switchWorkspace(d));
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useCommand(`to-workspace-${d}`, () => sendToWorkspace(d), !!(layout ? focusKey : selected));
  }

  // Hyprland-style resizing. In a split the nearest divider moves; in a single
  // session the side panel's edge does (Session listens for ah:resize-panel).
  const nudge = (dir: PaneDir, big = false) => {
    if (layout && splitOpen && !zoom) {
      const from = focusPath ?? paneLeaves(layout)[0]?.path ?? [];
      setLayout(nudgeDivider(layout, from, dir, big ? 0.15 : 0.05));
    } else if (dir === 'left' || dir === 'right') {
      // The panel's left edge moves with the arrow: ← widens it, → narrows it.
      window.dispatchEvent(new CustomEvent('ah:resize-panel', { detail: (dir === 'left' ? -1 : 1) * (big ? 120 : 40) }));
    }
  };
  useCommand('resize-left', () => nudge('left'), !!selected || splitOpen);
  useCommand('resize-right', () => nudge('right'), !!selected || splitOpen);
  useCommand('resize-up', () => nudge('up'), splitOpen);
  useCommand('resize-down', () => nudge('down'), splitOpen);
  useCommand('resize-mode', () => setSubmap('resize'), !!selected || splitOpen);
  useCommand('pane-mode', () => setSubmap('pane'), !!selected || !!layout);
  useCommand('maximize-pane', () => setZoom((z) => !z), splitOpen && !narrow);
  // Replace pane: in a split the pane turns into its chooser (Session handles that);
  // in the single view it is the switcher.
  useCommand('replace-pane', () => setSwitching(true), !!selected && !layout);
  useCommand('open-in-pane', () => {
    setSwitchTile(true);
    setSwitching(true);
  }, !!selected || !!layout);
  useCommand('scratchpad', () => void toggleScratch());
  useEffect(() => {
    if (!submap) return;
    const DIRS: Record<string, PaneDir> = { arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', h: 'left', l: 'right', k: 'up', j: 'down' };
    const key = (e: KeyboardEvent) => {
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
      // A chord (the switcher, the palette, New session) ends the mode and goes through, so
      // the dialog it opens gets the keyboard instead of a mode still listening behind it.
      if (e.ctrlKey || e.metaKey) return setSubmap(null);
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape' || e.key === 'Enter') return setSubmap(null);
      const dir = DIRS[e.key.toLowerCase()];
      if (submap === 'resize') {
        if (dir) nudge(dir, e.shiftKey);
        else setSubmap(null);
        return;
      }
      // Pane mode: stays on for focus, move and resize; actions that open something leave it.
      if (dir) return e.shiftKey ? movePane(dir) : focusPane(dir);
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (digit) {
        setSubmap(null);
        return e.shiftKey ? sendToWorkspace(Number(digit)) : switchWorkspace(Number(digit));
      }
      const leave = (fn: () => void) => {
        setSubmap(null);
        fn();
      };
      switch (e.key.toLowerCase()) {
        case 'v':
          return runCommand('split-right');
        case 's':
          return runCommand('split-below');
        case 'x':
          return runCommand('close-pane');
        case 'p':
          return leave(() => runCommand('replace-pane'));
        case 'f':
          return setZoom((z) => !z);
        case 't':
          return flipSplit();
        case 'r':
          return setSubmap('resize');
        case 'o':
          return leave(() => {
            setSwitchTile(true);
            setSwitching(true);
          });
        case 'n':
          return leave(() => setCreating({}));
        case '`':
          return leave(() => void toggleScratch());
      }
      // Any other key ends it, as resize mode does: a mode you forgot about never eats typing.
      setSubmap(null);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });

  /** Dwindle-style: a new pane splits the focused one along its longer side. */
  const autoDir = (): 'right' | 'below' => {
    const r = (document.querySelector('.ws-root .pane.focused') ?? document.querySelector('.main'))?.getBoundingClientRect();
    return !r || r.width >= r.height * 1.1 ? 'right' : 'below';
  };
  function openTile(key: string) {
    const dir = autoDir();
    if (layout) {
      const at = focusPath ?? paneLeaves(layout)[0]?.path ?? [];
      setZoom(false);
      setLayout(splitLeaf(layout, at, dir === 'right' ? 'horizontal' : 'vertical', key));
      setFocusPath([...at, 'second']);
    } else if (selected && selected !== key) {
      splitFrom(selected, dir, key);
      setFocusPath(['second']);
    } else open(key);
  }

  // The scratchpad: one shell of its own, shown floating over everything.
  async function toggleScratch() {
    if (scratch) {
      setScratch(false);
      // The keyboard goes back to whatever the scratchpad floated over.
      requestAnimationFrame(() => requestAnimationFrame(() => runCommand('focus-main')));
      return;
    }
    if (!state) return;
    let key: string | null = null;
    try {
      key = localStorage.getItem('ah.scratch');
    } catch {}
    if (!key || !state.windows.some((w) => w.key === key)) {
      const host = state.hostname;
      try {
        const out = await clientFor(host).create({ preset: 'shell', cwd: '~', session: state.defaultSession, label: 'scratch', resume: false });
        await waitForWindow(() => refresh(host), { id: out.id, uid: out.uid });
        key = keyFor(host, out.uid);
        localStorage.setItem('ah.scratch', key);
      } catch (e) {
        return showError(e, "Couldn't start the scratchpad shell");
      }
    }
    setScratch(true);
  }
  const scratchWin = scratch ? (state?.windows.find((w) => w.key === scratchKey()) ?? null) : null;

  // Palette → Workspace → Open as a new pane: every session not already on screen.
  usePaletteProvider(
    'tiles',
    () =>
      sidebarOrder(state?.windows ?? [], (state?.hosts.length ?? 0) > 1, savedGroups)
        .filter((w) => !visibleKeys.includes(w.key))
        .map((w) => ({ key: `tile:${w.key}`, label: w.title, agent: w.agent, detail: [statusWord(w), w.project].join(' · '), run: () => openTile(w.key) })),
    !!selected || !!layout,
  );

  // Palette → Run in project: each project, then what to start there.
  usePaletteProvider('projects', async () => {
    if (!state) return [];
    const host = state.hostname;
    const projects = await clientFor(host).projects().catch(() => [] as string[]);
    const presets = state.presets.filter((p) => p.available !== false && !p.hidden);
    return projects.slice(0, 30).map((path) => ({
      key: `project:${path}`,
      label: path.replace(/\/$/, '').split('/').pop() || path,
      icon: 'files' as const,
      detail: path,
      children: [
        ...presets.map((p) => ({
          key: `run:${p.id}`,
          label: `New ${p.name}`,
          agent: p.id === 'shell' ? null : p.id,
          detail: 'Starts at once with its defaults',
          run: () =>
            void clientFor(host)
              .create({ preset: p.id, cwd: path, session: state.defaultSession, label: '', resume: false })
              .then(async (out) => {
                await waitForWindow(() => refresh(host), { id: out.id, uid: out.uid });
                open(keyFor(host, out.uid));
              })
              .catch((e) => showError(e, `Couldn't start ${p.name}`)),
        })),
        { key: 'custom', label: 'New session with options…', icon: 'plus' as const, run: () => setCreating({ cwd: path, host }) },
      ],
    }));
  });

  // Appearance → Omarchy: fetch the host's palette, again whenever it changes there.
  const { mode: themeMode } = useTheme();
  useEffect(() => {
    if (themeMode !== 'omarchy' || !state) return;
    if (!state.omarchy) return setOmarchyPalette(null);
    clientFor(state.hostname)
      .omarchyTheme()
      .then((p) => setOmarchyPalette(p))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeMode, state?.omarchy?.at, state?.omarchy?.name, state?.omarchy?.font]);

  // Palette → Go to: every note, the latest written first.
  usePaletteProvider(
    'notes',
    () =>
      notesBook()
        .list()
        .map((n) => ({ key: `note:${n.id}`, label: noteTitle(n), icon: 'note' as const, detail: n.project ? `Note · ${n.project.path.split('/').pop()}` : 'Note', terms: ['note'] as const, run: () => openNote(n.id) })),
    notesOn,
  );

  // Palette → Go to: every live session, in sidebar order.
  usePaletteProvider('sessions', () => {
    const multi = (state?.hosts.length ?? 0) > 1;
    return sidebarOrder(state?.windows ?? [], multi, savedGroups).map((w) => ({
      key: `session:${w.key}`,
      label: w.title,
      agent: w.agent,
      detail: [statusWord(w), w.agent ? look(w.agent).name : 'Shell', multi ? w.host : null, w.project].filter(Boolean).join(' · '),
      run: () => open(w.key),
    }));
  });

  // Palette → Settings: one-click settings run from there, the rest open their page.
  usePaletteProvider('settings', () =>
    settingsNodes((id) => {
      setLayout(null);
      setFocusPath(null);
      location.hash = sectionHash(id);
    }),
  );

  // Keyboard into the session list: the sidebar, or the Inbox on a phone
  // (there is no sidebar there, and this command used to be absent).
  useCommand('focus-sidebar', () => {
    if (narrow) {
      showPage('inbox');
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const row = document.querySelector<HTMLElement>('.page button.row');
        row?.focus();
        row?.scrollIntoView({ block: 'nearest' });
      }));
      return;
    }
    if (!sideOpen) toggleSide();
    requestAnimationFrame(() => {
      const row = ['.sidebar .side-session[aria-current]', '.sidebar .nav-item.on', '.sidebar .side-session'].map((q) => document.querySelector<HTMLElement>(q)).find(Boolean);
      row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
    });
  });

  // Back to the main view from the sidebar when no session is open: the page's list, or its first control.
  useCommand(
    'focus-main',
    () => {
      if (chooserFocused) return document.querySelector<HTMLElement>('.pane.focused [data-autofocus], .pane.focused .pane-picker-filter')?.focus();
      if (focusPage()) return;
      document.querySelector<HTMLElement>('.page')?.querySelector<HTMLElement>('button, input, a[href]')?.focus();
    },
    (!selected && !layout) || chooserFocused,
  );

  /** Enter split view from the single session. Without a session to show, the new half asks what goes there. */
  function splitFrom(key: string, dir: 'right' | 'below', otherKey?: string) {
    const other = otherKey ?? pickKey();
    setLayout(splitLeaf({ type: 'session', sessionKey: key }, key, dir === 'right' ? 'horizontal' : 'vertical', other));
    splitOrigin.current = key;
    setFocusPath(otherKey ? ['first'] : ['second']);
  }

  /** The session nearest a chooser pane (its split sibling first): where a new shell or session starts. */
  function nearPane(path: Path): Win | null {
    if (!layout || !state) return current ?? null;
    for (let depth = path.length - 1; depth >= 0; depth--) {
      const n = nodeAt(layout, path.slice(0, depth));
      const key = n ? paneLeaves(n).find((p) => !isPick(p.sessionKey))?.sessionKey : undefined;
      const w = key ? state.windows.find((x) => x.key === key) : undefined;
      if (w) return w;
    }
    return current ?? null;
  }

  function fillPane(path: Path, key: string) {
    if (!layout) return open(key);
    setLayout(replaceLeaf(layout, path, key));
    setFocusPath(path);
  }

  async function newShellInto(path: Path) {
    const near = nearPane(path);
    const host = near?.host ?? state?.hostname ?? '';
    try {
      const out = await clientFor(host).create({ preset: 'shell', cwd: near?.projectPath ?? '~', session: near?.session ?? state?.defaultSession ?? '', label: '', resume: false });
      await waitForWindow(() => refresh(host), { id: out.id, uid: out.uid });
      fillPane(path, keyFor(host, out.uid));
    } catch (e) {
      showError(e, "Couldn't open a shell");
    }
  }

  function flash(msg: string) {
    toastNow.current = msg;
    setToast(msg);
    setToastOut(false);
    // As long as it takes to read: a short confirmation goes quickly, an error stays.
    // It rises away before it goes, instead of vanishing mid-read.
    const ms = Math.min(4500, Math.max(1600, 1200 + msg.length * 55));
    window.setTimeout(() => toastNow.current === msg && setToastOut(true), ms - 200);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), ms);
  }

  // In-page notifications are the fallback when Web Push isn't on (plain http).
  function announce(windows: Win[]) {
    const prev = prevStatus.current;
    for (const w of windows) {
      const was = prev.get(w.key);
      const alerting = w.status === 'waiting' || (w.status === 'attention' && was === 'busy');
      if (was && was !== w.status && alerting && !pushActive.current && 'Notification' in window && Notification.permission === 'granted') {
        if (document.hidden || w.key !== selectedRef.current) {
          const n = new Notification(w.status === 'waiting' ? `${w.title} needs you` : `${w.title} finished`, { body: `${w.project} · ${look(w.agent).name}`, tag: w.key, icon: '/icon-512.png' });
          n.onclick = () => {
            window.focus();
            open(w.key);
            n.close();
          };
        }
      }
    }
    prevStatus.current = new Map(windows.map((w) => [w.key, w.status]));
    const waiting = windows.filter((w) => w.status === 'waiting').length;
    document.title = waiting ? `(${waiting}) ah` : 'ah';
    // An installed app's icon (dock, home screen) shows the same count.
    try {
      if (waiting) void navigator.setAppBadge?.(waiting).catch(() => {});
      else void navigator.clearAppBadge?.().catch(() => {});
    } catch {}
  }

  useEffect(() => {
    // Back/Forward, or a hash set from outside (a push notification): the URL has moved already.
    const onHash = () => {
      // A step a swipe has already shown (ours, or the browser's own) lands without a second animation.
      const still = popStill.current || edgeGesture();
      popStill.current = false;
      const route = fromHash();
      if (searchLink()) setInboxSearch((s) => ({ ...s, open: true }));
      if (!route.selected) leaveSplitRef.current();
      goRef.current(route, { history: 'none', still });
    };
    window.addEventListener('popstate', onHash);
    window.addEventListener('hashchange', onHash);
    if (pushSupport() === 'ok') {
      registerWorker();
      pushStatus()
        .then((e) => (pushActive.current = !!e))
        .catch(() => {});
    }
    return () => {
      window.removeEventListener('popstate', onHash);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  // Fill the screen normally; shrink only while the software keyboard is open.
  useEffect(() => trackViewport(window, document), []);

  useEffect(() => {
    const key = resumeSolo.current;
    if (!key) return;
    resumeSolo.current = null;
    try {
      localStorage.removeItem('ah.layout.v1');
    } catch {}
    go({ selected: key });
  }, []);

  // Links, layouts and workspaces saved under tmux window ids: point them at the uid once.
  useEffect(() => {
    if (!state || !hasLegacy(layout, spaces, selected, scratchKey())) return;
    if (layout) setLayout(upgradeLayout(layout, state.windows));
    setSpaces(upgradeSpaces(spaces, state.windows));
    const scratchWas = scratchKey();
    if (scratchWas && isLegacyKey(scratchWas)) {
      try {
        const next = upgradeKey(scratchWas, state.windows);
        if (next) localStorage.setItem('ah.scratch', next);
        else localStorage.removeItem('ah.scratch');
      } catch {}
    }
    if (selected && isLegacyKey(selected)) go({ selected: upgradeKey(selected, state.windows) }, { history: 'replace' });
  }, [state]);

  // Handoff: tell the host which session this device is on whenever it is in use…
  const onScreen = layout ? focusKey : selected;
  const focusNow = useRef(state?.focus);
  focusNow.current = state?.focus;
  const reported = useRef<{ key: string; at: number } | null>(null);
  useEffect(() => {
    if (!state || !onScreen) return;
    const host = state.hostname;
    const report = () => {
      if (document.visibilityState !== 'visible') return;
      // Coming back fires both focus and visibilitychange, and alt-tabbing fires focus each
      // time: each report is a pass on the host and a patch to every device. Skip it while
      // no other device has taken over since this one reported this session, under 30 s ago
      // (and always within 2 s: the other's takeover may not have reached this page yet).
      const f = focusNow.current;
      const last = reported.current;
      const since = last?.key === onScreen ? Date.now() - last.at : Infinity;
      if (since < 2000 || ((!f || f.client === CLIENT_ID) && since < 30_000)) return;
      reported.current = { key: onScreen, at: Date.now() };
      void clientFor(host).focus(onScreen).catch(() => {});
    };
    const t = window.setTimeout(report, 800);
    window.addEventListener('focus', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('focus', report);
      document.removeEventListener('visibilitychange', report);
    };
  }, [onScreen, !!state]);
  // …and offer the one another device was on last, for a quarter of an hour.
  const [handoffSeen, setHandoffSeen] = useState(0);
  const lastFocus = state?.focus;
  const handoffWin =
    lastFocus && lastFocus.client !== CLIENT_ID && lastFocus.at !== handoffSeen && Date.now() - lastFocus.at < 15 * 60_000 && !visibleKeys.includes(lastFocus.key)
      ? (state?.windows.find((w) => w.key === lastFocus.key) ?? null)
      : null;
  const handoff = handoffWin && lastFocus && (
    <HandoffOffer
      w={handoffWin}
      device={lastFocus.device}
      at={lastFocus.at}
      onOpen={() => {
        setHandoffSeen(lastFocus.at);
        open(handoffWin.key);
      }}
      onDismiss={() => setHandoffSeen(lastFocus.at)}
    />
  );

  const current = state?.windows.find((w) => w.key === selected) ?? null;
  // A phone leaves a session the iPhone way too: swipe in from the left edge.
  const mainRef = useRef<HTMLElement>(null);
  const underRef = useRef<HTMLDivElement>(null);
  const [peek, setPeek] = useState(false);
  useSwipeBack(mainRef, narrow && !!selected && !layout && !creating, () => goBack({ selected: null }, { still: true }), { ref: underRef, show: setPeek });
  const ended = current ? null : endedFor(selected);
  // A session that is neither live nor in history (removed, or a bad link): fall back to the
  // inbox. One state update of grace: a window can leave the list a tick before history has it.
  const missing = useRef(0);
  useEffect(() => {
    if (!state || !selected || current || ended || layout || isLegacyKey(selected)) {
      missing.current = 0;
      return;
    }
    if (++missing.current > 1) open(null);
  }, [state, selected, current, ended]);


  async function answer(w: Win, a: 'approve' | 'deny') {
    try {
      await clientFor(w.host).answer(w.uid, a);
      // On screen, the session itself shows the answer land; elsewhere (the inbox) say so.
      if (!visibleKeys.includes(w.key)) flash(a === 'approve' ? `Approved · ${w.title}` : `Denied · ${w.title}`);
    } catch (e) {
      flash(errorText(e));
    }
    refresh(w.host);
  }

  /** The key the session came back under; null when it failed (already reported). */
  async function resumeKey(host: string, ref: string) {
    try {
      // Cut off by a crash or restart (server/interruptions): restored, so one that was
      // working is told where it stopped before anything else goes in.
      const cut = state?.history.find((h) => h.host === host && h.ref === ref)?.interrupted;
      const out = cut ? await clientFor(host).restore(ref).then((x) => ({ id: x.windowId, uid: x.uid, resumed: x.resumed })) : await clientFor(host).resume(ref);
      // Listed before it's shown: a key the state doesn't have yet reads as gone.
      await waitForWindow(() => refresh(host), out);
      if (out.resumed) flash(cut ? 'Restoring…' : 'Resuming…');
      return keyFor(host, out.uid);
    } catch (e) {
      showError(e, "Couldn't resume");
      return null;
    }
  }

  async function resume(host: string, ref: string, opts: { navigate?: boolean } = {}) {
    const key = await resumeKey(host, ref);
    // A pane resuming its own session keeps its key; it turns live where it is.
    if (key && opts.navigate !== false) open(key);
  }

  /**
   * Opens a content search hit (issue #9): a transcript lands in the GUI at
   * the matching seq; a chat opens its session's past-chats at the message.
   * The jump target travels in sessionStorage because the session view (and
   * its surfaces) mount after navigation.
   */
  async function openSearchHit(host: string, hit: SearchHit, target?: number) {
    setSwitching(false);
    const seq = hit.kind === 'transcript' ? (target ?? hit.excerpts[0]?.seq ?? undefined) : undefined;
    const msgId = hit.kind === 'chat' ? (target ?? hit.excerpts[0]?.msgId ?? undefined) : undefined;
    const w = state?.windows.find((x) => x.host === host && (hit.uid ? x.uid === hit.uid : !!hit.harnessId && x.harnessId === hit.harnessId));
    if (hit.kind === 'chat' && hit.uid && msgId != null) {
      try {
        sessionStorage.setItem('ah.chatJump', JSON.stringify({ host, uid: hit.uid, msgId }));
      } catch {}
    }
    if (w) {
      if (seq != null) {
        try {
          sessionStorage.setItem('ah.seqJump', JSON.stringify({ host, uid: w.uid, seq }));
          localStorage.setItem('ah.view', 'gui');
        } catch {}
      }
      open(w.key);
      window.dispatchEvent(new CustomEvent('ah:search-jump', { detail: { host, uid: w.uid, seq, msgId } }));
      return;
    }
    if (hit.kind === 'chat') {
      if (hit.uid && msgId != null) {
        sessionStorage.removeItem('ah.chatJump');
        setPastChatJump({ host, uid: hit.uid, msgId });
      }
      return;
    }
    if (!hit.ref) {
      flash('Session not found.');
      return;
    }
    try {
      const out = await clientFor(host).resume(hit.ref);
      await refresh(host);
      if (seq != null) {
        try {
          sessionStorage.setItem('ah.seqJump', JSON.stringify({ host, uid: out.uid, seq }));
          localStorage.setItem('ah.view', 'gui');
        } catch {}
      }
      open(keyFor(host, out.uid));
      if (out.resumed) flash('Resuming…');
    } catch (e) {
      showError(e, "Couldn't open that session");
    }
  }

  function sent(r: SendResult, opts: { quiet?: boolean } = {}) {
    // The GUI composer shows the message itself (in the feed, or the queue tray).
    if (r.resumed) flash('Resuming the session; your message goes in once it is ready');
    else if (r.starting) flash('Your message goes in once the agent is ready');
    // Held behind a screen in front of the prompt: say what it waits for, even where the tray shows it.
    else if (r.held) flash(HELD[r.held]);
    // Delivered shows itself where it lands; a queued message needs saying.
    else if (!opts.quiet && r.outcome !== 'delivered') flash(`Queued (${r.queued}) — sent when the agent is free`);
    refresh(current?.host);
  }

  async function shellIn(path: string) {
    setDialog(null);
    const host = current?.host ?? state?.hostname ?? '';
    try {
      const out = await clientFor(host).create({ preset: 'shell', cwd: path, session: current?.session ?? state?.defaultSession ?? '', label: '', resume: false });
      await refresh(host);
      open(keyFor(host, out.uid));
    } catch (e) {
      showError(e, "Couldn't open a shell");
    }
  }

  const waiting = state?.windows.filter((w) => w.status === 'waiting').length ?? 0;
  const forget = async (h: HistoryItem) => {
    await clientFor(h.host)
      .forget(h.ref)
      .catch((e) => showError(e, "Couldn't remove it from history"));
    refresh(h.host);
  };

  // Composer notices ("Switched to Sonnet 5.5", "Interrupted") come in as events.
  useEffect(() => {
    const onToast = (e: Event) => flash(String((e as CustomEvent).detail));
    window.addEventListener('ah:toast', onToast);
    return () => window.removeEventListener('ah:toast', onToast);
  }, []);

  const presetFor = (host: string, id: string | null) => (id ? hostState(host)?.presets.find((p) => p.id === id) : undefined);

  // On a phone Settings is a sheet over the page it was opened from, which stays put under it.
  const sheetBase = useRef<Page>('inbox');
  if (page !== 'settings') sheetBase.current = page;
  const shown = narrow && page === 'settings' ? sheetBase.current : page;

  // Each page keeps its place, as an iOS tab does: back from a session, or back on its tab,
  // the list is where you left it, and so is the copy a swipe back shows under the session.
  const pageScroll = useRef(new Map<Page, number>());
  const shownRef = useRef({ shown, selected });
  shownRef.current = { shown, selected };
  useEffect(() => {
    const save = (e: Event) => {
      const el = e.target;
      // Only the page in view: one leaving (a session opening over it) scrolls as it shrinks.
      if (shownRef.current.selected || !(el instanceof HTMLElement) || !el.classList.contains('page') || !mainRef.current?.contains(el)) return;
      pageScroll.current.set(shownRef.current.shown, el.scrollTop);
    };
    document.addEventListener('scroll', save, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', save, { capture: true });
  }, []);
  useLayoutEffect(() => {
    const top = pageScroll.current.get(shown);
    if (!top) return;
    const stops: Array<() => void> = [];
    for (const root of [selected ? null : mainRef.current, peek ? underRef.current : null]) {
      const el = root?.querySelector<HTMLElement>(':scope > .page, :scope > * > .page');
      if (!el) continue;
      el.scrollTop = top;
      if (el.scrollTop >= top - 1) continue;
      // Still filling in (a card that loads after the list): follow it to the place, until a finger or wheel takes over.
      const grow = new ResizeObserver(() => {
        el.scrollTop = top;
        if (el.scrollTop >= top - 1) stop();
      });
      for (const child of Array.from(el.children)) grow.observe(child);
      const timer = window.setTimeout(() => stop(), 1500);
      const stop = () => {
        grow.disconnect();
        window.clearTimeout(timer);
        el.removeEventListener('touchstart', stop);
        el.removeEventListener('wheel', stop);
      };
      el.addEventListener('touchstart', stop, { passive: true });
      el.addEventListener('wheel', stop, { passive: true });
      stops.push(stop);
    }
    return () => stops.forEach((f) => f());
  }, [shown, !!selected, peek, !!state]);

  // The top-level page (and, on a phone, its tab bar). On a phone it also lies under a
  // session while a swipe from the edge pulls the session away (useSwipeBack).
  const pages = state && (
    <>
      {shown === 'review' ? (
        <Suspense fallback={<div className="page" />}>
          <ReviewPage client={clientFor(state.hostname)} state={state} narrow={narrow} onOpenSession={(uid) => open(uid)} />
        </Suspense>
      ) : shown === 'notes' ? (
        <Suspense fallback={<div className="page" />}>
          <NotesView state={state} narrow={narrow} client={clientFor(state.hostname)} onNewSession={(o) => setCreating(o)} onOpenSession={(key) => open(key)} />
        </Suspense>
      ) : shown === 'jobs' ? (
        <Suspense fallback={<div className="page" />}>
          <JobsView client={clientFor(state.hostname)} state={state} onOpenSession={(uid) => open(uid)} />
        </Suspense>
      ) : shown === 'usage' ? (
        <Suspense fallback={<div className="page" />}>
          <UsageView client={clientFor(state.hostname)} state={state} onOpenSession={(uid) => open(uid)} />
        </Suspense>
      ) : shown === 'settings' ? (
        <Suspense fallback={<div className="page" />}>
          <Settings onLocked={onLock} onNotifyChange={(on) => (pushActive.current = on)} />
        </Suspense>
      ) : (
        <Inbox
          state={state}
          narrow={narrow}
          groupBy={inboxGroup}
          setGroupBy={setInboxGroup}
          project={inboxProject}
          setProject={setInboxProject}
          onOpen={(w, reply) => {
            open(w.key);
            if (reply) setReplyKey((n) => n + 1);
          }}
          onAnswer={answer}
          clientFor={clientFor}
          onNew={(where) => setCreating(where ?? {})}
          onSettings={() => go({ page: 'settings', selected: null })}
          onNotes={() => go({ page: 'notes', selected: null })}
          onReview={openReview}
          handoff={narrow ? handoff : null}
          onResume={(h) => resume(h.host, h.ref)}
          onOpenHistory={(h) => open(keyFor(h.host, h.ref))}
          search={inboxSearch}
          setSearch={setInboxSearch}
          focusSearch={focusSearch}
          touch={touch}
          onOpenHit={openSearchHit}
          onForget={forget}
          onFork={(h) => setForking({ ref: h.ref, host: h.host, harness: h.harness, title: h.title })}
          onMove={(h) => setMoving({ ref: h.ref, host: h.host, title: h.title })}
        />
      )}
      {narrow && (
        <TabBar shown={shown} badges={{ inbox: waiting, review: state.review?.alerts.length ?? 0 }} onPick={(p) => go({ page: p, selected: null })} onCommands={() => setPalette(true)} />
      )}
    </>
  );

  // Sliding over the page, picking anything puts it away (as iPadOS apps' sidebars do).
  const over = <A extends unknown[]>(f: (...a: A) => void) => (...a: A) => {
    if (tight) setSideOver(false);
    f(...a);
  };
  const sidebar = (
        <Sidebar
          workspaces={{
            current: spaces.current,
            used: [1, 2, 3, 4, 5, 6, 7, 8, 9].filter((n) => (n === spaces.current ? occupied(nowSlot()) : occupied(spaces.slots[n]))),
          }}
          onWorkspace={switchWorkspace}
          state={state}
          error={error}
          page={page}
          selected={focusKey ?? selected}
          visibleKeys={visibleKeys}
          device={deviceName()}
          handoff={handoff}
          onCollapse={tight ? () => setSideOver(false) : toggleSide}
          onPage={over(showPage)}
          onSelect={over(open)}
          onSearch={over(() => setSwitching(true))}
          onNew={over((where?: Parameters<typeof setCreating>[0]) => setCreating(where ?? {}))}
          onNewProject={over(() => setCreating({ project: true }))}
          onWorktrees={over(() => setDialog('worktrees'))}
          onReorder={(uid, host, order) => {
            // One move can save several rows: refresh once they are all saved,
            // so the list never shows a half-applied order (and rows don't bounce).
            const batch = (reorders.current[host] ??= []);
            batch.push(clientFor(host).order(uid, order).catch((e) => flash(errorText(e))));
            if (batch.length > 1) return;
            queueMicrotask(() => {
              delete reorders.current[host];
              void Promise.all(batch).then(() => refresh(host));
            });
          }}
          onKill={terminate}
          onFork={(w) => setForking({ ref: w.uid, host: w.host, harness: w.agent, title: w.title })}
        />
  );
  // What a list row's held-finger menu does in place (PressMenu.tsx).
  const sessionActions: SessionActions = {
    open: (w) => open(w.key),
    pin: (w) => void clientFor(w.host).pin(w.uid, !w.pinned).then(() => refresh(w.host), (e) => showError(e, "Couldn't pin")),
    fork: (w) => setForking({ ref: w.uid, host: w.host, harness: w.agent, title: w.title }),
    kill: terminate,
  };
  const settingsPart = useSectionPart();
  const sideOverRef = useRef<HTMLDivElement>(null);
  const sideScrimRef = useRef<HTMLDivElement>(null);
  // A drag in from the edge shows the sidebar before it is open: it follows the finger.
  const sidePeek = useSideSwipe(tight, sideOver, setSideOver, sideOverRef, sideScrimRef);
  // Slid over the page, the sidebar has the keyboard, as a dialog does: focus on the row you're
  // on, the page underneath out of reach (inert, so typing can't land in its composer), and
  // focus back where it was when it goes.
  useEffect(() => {
    if (!sideOver) return;
    const before = document.activeElement as HTMLElement | null;
    const main = mainRef.current;
    if (main) main.inert = true;
    const raf = requestAnimationFrame(() => {
      const panel = sideOverRef.current;
      const row = panel?.querySelector<HTMLElement>('.side-session.on, .nav-item.on') ?? panel?.querySelector<HTMLElement>('button, [href], input');
      row?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      if (main) main.inert = false;
      const now = document.activeElement;
      if ((!now || now === document.body || !now.isConnected) && before?.isConnected) before.focus({ preventScroll: true });
    };
  }, [sideOver]);

  return (
    <PresetsContext.Provider value={presetFor}>
    <HostPresetsContext.Provider value={(host) => hostState(host)?.presets ?? []}>
    <HostFeaturesContext.Provider value={(host) => hostState(host)?.features}>
    <ResumeContext.Provider value={state ? { history: state.history, resume: (h) => resumeKey(h.host, h.ref), discard: terminate } : null}>
    <ReviewContext.Provider value={{ host: state?.hostname ?? '', state: state?.review ?? null, open: openReview }}>
    <SessionActionsContext.Provider value={sessionActions}>
    <div className={`app ${narrow ? 'narrow' : ''}`}>
      <Shortcuts />
      <WhichKey />
      {!tight && sideOpen ? (
        sidebar
      ) : (
        !narrow && (
          <div className="rail">
            <button className="icon-btn" onClick={toggleSide} title={shortcutTitle('Show sidebar', 'toggle-sidebar')} aria-label="Show sidebar" aria-expanded={tight ? sideOver : false}>
              <Icon name="panel" />
            </button>
          </div>
        )
      )}
      {tight && (sideOver || sidePeek) && (
        <>
          <div className="side-scrim" ref={sideScrimRef} onClick={() => setSideOver(false)} aria-hidden />
          <div className="side-over" role="dialog" aria-label="Sidebar" ref={sideOverRef}>
            {sidebar}
          </div>
        </>
      )}

      {peek && pages && (
        <div className="under" ref={underRef} aria-hidden inert>
          {pages}
        </div>
      )}
      <main className="main" ref={mainRef}>
        {state && (state.api ?? 0) < API_VERSION && (
          <div className="stale-banner">
            <span className="grow">This page is newer than the running ah server. Restart the server to finish updating; sessions keep running.</span>
            <button className="btn small" onClick={() => void restartServer()}>
              Restart
            </button>
          </div>
        )}
        {layout && state ? (
          <Workspace
            layout={layout}
            windows={state.windows}
            narrow={narrow}
            touch={touch}
            multiHost={state.hosts.length > 1}
            home={state.home}
            replyKey={replyKey}
            focusPath={focusPath}
            clientFor={clientFor}
            hostHome={(host) => hostState(host)?.home ?? state.home}
            onFocus={setFocusPath}
            onLayout={setLayout}
            onAnswer={answer}
            onSent={sent}
            onTerminate={terminate}
            endedFor={endedFor}
            feedFor={(host, harness) => presetFor(host, harness)?.feed ?? null}
            onResume={(h) => resume(h.host, h.ref, { navigate: false })}
            onStartSession={(w, prompt, preset) => setCreating({ cwd: w.projectPath, host: w.host, prompt, preset })}
            refresh={refresh}
            onExit={exitSplit}
            zoom={zoom}
            origin={splitOrigin.current}
            onUnzoom={() => setZoom(false)}
            onNewShell={(path) => void newShellInto(path)}
            renderNew={(path, onCancel) => (
              <NewDialog
                screen
                hosts={state.hosts.filter((h) => h.online).map((h) => h.name)}
                initialHost={nearPane(path)?.host ?? state.hostname}
                hostState={hostState}
                clientFor={clientFor}
                initialCwd={nearPane(path)?.projectPath ?? lastCwd(nearPane(path)?.host ?? state.hostname)}
                onClose={onCancel}
                onSent={sent}
                onCreated={async (host, id, uid) => {
                  await waitForWindow(() => refresh(host), { id, uid });
                  fillPane(path, keyFor(host, uid));
                }}
              />
            )}
          />
        ) : current && state ? (
          <Session
            key={current.key}
            w={current}
            client={clientFor(current.host)}
            windows={sidebarOrder(state.windows, state.hosts.length > 1, savedGroups)}
            clientFor={clientFor}
            narrow={narrow}
            touch={touch}
            multiHost={state.hosts.length > 1}
            home={hostState(current.host)?.home ?? state.home}
            replyKey={replyKey}
            onBack={() => goBack({ selected: null })}
            onAnswer={answer}
            onSent={sent}
            onTerminate={() => {
              open(null);
              terminate(current);
            }}
            refresh={() => refresh(current.host)}
            onStartSession={(prompt, preset) => setCreating({ cwd: current.projectPath, host: current.host, prompt, preset })}
            // A phone has no room for panes beside each other: no split actions on its menu.
            onSplit={narrow ? undefined : (dir) => splitFrom(current.key, dir)}
            onOpenKey={open}
            onSplitWith={narrow ? undefined : (key) => splitFrom(current.key, 'right', key)}
          />
        ) : ended && state ? (
          <EndedSession
            key={selected}
            item={ended}
            client={clientFor(ended.host)}
            feed={presetFor(ended.host, ended.harness)?.feed ?? null}
            narrow={narrow}
            onResume={() => resume(ended.host, ended.ref)}
            onClose={() => open(null)}
          />
        ) : state ? (
          pages
        ) : (
          <div className="page">
            <p className="hint">{error ? `Can't reach the server: ${error}` : 'Connecting…'}</p>
          </div>
        )}
      {/* Never a modal: the form takes the space a session would (phone and desktop alike). */}
      {creating && state && (
        <NewDialog
          key={creating.project ? 'project' : 'session'}
          screen
          hosts={state.hosts.filter((h) => h.online).map((h) => h.name)}
          initialHost={creating.host ?? current?.host ?? state.hostname}
          hostState={hostState}
          clientFor={clientFor}
          initialCwd={creating.cwd ?? current?.projectPath ?? lastCwd(creating.host ?? current?.host ?? state.hostname)}
          initialPrompt={creating.prompt}
          initialPreset={creating.preset}
          newProject={creating.project}
          onClose={() => setCreating(null)}
          onSent={sent}
          onCreated={async (host, id, uid) => {
            setCreating(null);
            // The new window can miss the next tick; opening immediately
            // selects a key nothing matches and the missing-selection
            // fallback bounces to the inbox. Wait until state lists it.
            await waitForWindow(() => refresh(host), { id, uid });
            open(keyFor(host, uid));
          }}
        />
      )}
      </main>


      {narrow && page === 'settings' && state && (
        <Sheet
          label="Settings"
          className="settings-sheet"
          onClose={() => goBack({ page: sheetBase.current }, { still: true })}
          // A section is a page you went into, as in iOS Settings: its name, and Back to the list.
          title={settingsPart ? SECTIONS.find((s) => s.id === settingsPart)?.label : undefined}
          onBack={settingsPart ? backToList : undefined}
          backLabel="Settings"
        >
          <Suspense fallback={<div className="page" />}>
            <Settings phone onLocked={onLock} onNotifyChange={(on) => (pushActive.current = on)} />
          </Suspense>
        </Sheet>
      )}

      <Suspense fallback={null}>
      {forking && state && (
        <ForkDialog
          client={clientFor(forking.host)}
          target={forking}
          onClose={() => setForking(null)}
          onForked={async (uid) => {
            const host = forking.host;
            setForking(null);
            await refresh(host);
            open(keyFor(host, uid));
          }}
        />
      )}
      {moving && state && (
        <MoveDialog
          client={clientFor(moving.host)}
          target={moving}
          hosts={state.hosts.filter((x) => x.online && x.name !== moving.host).map((x) => x.name)}
          onClose={() => setMoving(null)}
          onMoved={(host, uid) => {
            setMoving(null);
            void resume(host, uid);
          }}
        />
      )}
      </Suspense>

      {keymap && <ShortcutsDialog onClose={() => setKeymap(false)} />}
      {submap && (
        // Which-key, like Hyprland submaps in Omarchy: every key the mode answers, as keycaps.
        <div className="submap" role="status">
          <strong>{submap === 'resize' ? 'Resize' : 'Pane'}</strong>
          <ul>
            {SUBMAP_KEYS[submap].map(([keys, label]) => (
              <li key={label}>
                <Keycaps keys={keys} /> {label}
              </li>
            ))}
          </ul>
        </div>
      )}

      {scratchWin && state && (
        <div className="scratchpad" role="dialog" aria-label="Scratchpad shell">
          <Session
            key={`scratch:${scratchWin.key}`}
            w={scratchWin}
            client={clientFor(scratchWin.host)}
            windows={state.windows}
            clientFor={clientFor}
            narrow={narrow}
            touch={touch}
            multiHost={state.hosts.length > 1}
            home={hostState(scratchWin.host)?.home ?? state.home}
            replyKey={0}
            onBack={() => setScratch(false)}
            onAnswer={answer}
            onSent={sent}
            onTerminate={() => {
              setScratch(false);
              terminate(scratchWin);
            }}
            refresh={() => refresh(scratchWin.host)}
          />
        </div>
      )}

      {palette && (
        <CommandPalette
          onClose={() => setPalette(false)}
          onRun={(node) => {
            setPalette(false);
            // After the dialog releases focus, so Reply and the other focus actions land.
            requestAnimationFrame(() => requestAnimationFrame(() => (node.command ? runCommand(node.command) : node.run?.())));
          }}
        />
      )}

      {switching && state && (
        <Switcher
          windows={state.windows}
          history={state.history}
          hosts={state.hosts.filter((h) => h.online).map((h) => h.name)}
          onSearchContent={(host, q) => clientFor(host).search(q)}
          onPick={(key) => {
            setSwitching(false);
            setSwitchTile(false);
            open(key);
          }}
          onResume={(host, ref) => {
            setSwitching(false);
            resume(host, ref);
          }}
          onContent={(host, hit) => void openSearchHit(host, hit)}
          tile={switchTile}
          onSplit={(key) => {
            setSwitching(false);
            setSwitchTile(false);
            openTile(key);
          }}
          onShowAll={(text) => {
            setSwitching(false);
            setInboxSearch({ open: true, query: text });
            if (!touch) setFocusSearch((n) => n + 1);
            setLayout(null);
            setFocusPath(null);
            go({ page: 'inbox', selected: null });
          }}
          onClose={() => {
            setSwitching(false);
            setSwitchTile(false);
          }}
        />
      )}

      {pastChatJump && (
        <Suspense fallback={null}>
          <ChatSearchDialog key={`${pastChatJump.host}:${pastChatJump.uid}:${pastChatJump.msgId}`} client={clientFor(pastChatJump.host)} jump={pastChatJump} onClose={() => setPastChatJump(null)} />
        </Suspense>
      )}

      {dialog === 'worktrees' && (
        <WorktreesDialog
          client={clientFor(current?.host)}
          supportsCheckouts={(hostState(current?.host ?? state?.hostname ?? '')?.features?.checkouts ?? 0) >= 1}
          onClose={() => setDialog(null)}
          onShell={shellIn}
          onOpenSession={(uid) => {
            if (!state) return;
            const h = current?.host ?? state.hostname;
            const target = state.windows.find((w) => w.uid === uid && w.host === h) ?? state.windows.find((w) => w.uid === uid);
            if (target) open(target.key);
          }}
          onNewSession={(cwd) => setCreating({ cwd, host: current?.host })}
        />
      )}

      {toast && (
        <div key={toast} ref={onTop} popover="manual" className={`toast ${toastOut ? 'out' : ''}`} role="status">
          {toast}
        </div>
      )}
    </div>
    </SessionActionsContext.Provider>
    </ReviewContext.Provider>
    </ResumeContext.Provider>
    </HostFeaturesContext.Provider>
    </HostPresetsContext.Provider>
    </PresetsContext.Provider>
  );
}
