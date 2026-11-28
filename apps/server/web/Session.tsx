import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTabFlow } from './tabFlow.ts';
import { useHardwareKeyboard } from './hardwareKeyboard.ts';
import { createPortal } from 'react-dom';
import { menuViewport, placeFloatingMenu } from './menuPlace.ts';
import { askConfirm, offerResume, showError, showNotice } from './ask.tsx';
import { copyText } from './selection.ts';
import { focusFirst } from './rove.ts';
import { confirmTerminate } from './Sidebar.tsx';
import { Icon } from './icons.tsx';
import { deviceName, type HistoryItem, type HostApi, type SendResult, type Win } from './api.ts';
import { look } from './agents.ts';
import { statusClass, statusWord } from './status.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { continuePrompt } from './handoff.ts';
import type { Recovery } from './api.ts';
import { HostFeaturesContext, HostPresetsContext } from './ModelPicker.tsx';
import { recentFor, ResumeContext } from './recent.ts';
import { defaultView, surfaceFor, VIEW_LABEL, viewsFor, type SurfaceHandle, type View } from './surface.ts';
import { ComposerBar, type ComposerHandle } from './Composer.tsx';
import { MobileOverlay } from './MobileOverlay.tsx';
import { useFileDrop } from './useFileDrop.ts';
import { BranchPicker, BranchSheet, ChangesPanel, PrLink } from './Git.tsx';
import { ReviewContext, useReviewFor } from './reviewContext.ts';
import { reviewApi } from './reviewApi.ts';
// Side chat and past chats (with the markdown renderer) load when the Chat panel first opens.
const SideChat = lazy(() => import('./SideChat.tsx').then((m) => ({ default: m.SideChat })));
const ChatHistory = lazy(() => import('./ChatHistory.tsx').then((m) => ({ default: m.ChatHistory })));
const StackPanel = lazy(() => import('./review/SessionStack.tsx'));
// A session's panels and dialogs load when first opened, not with the first screen: they were
// ~15% of the main chunk. They're fetched in the background a few seconds after start.
const load = {
  files: () => import('./Files.tsx'),
  queue: () => import('./Queue.tsx'),
  preview: () => import('./Preview.tsx'),
  fork: () => import('./ForkDialog.tsx'),
  continueIn: () => import('./ContinueDialog.tsx'),
  sendTo: () => import('./SendToDialog.tsx'),
  snapshots: () => import('./Snapshots.tsx'),
};
const FilesPanel = lazy(() => load.files().then((m) => ({ default: m.FilesPanel })));
const QueuePanel = lazy(() => load.queue().then((m) => ({ default: m.QueuePanel })));
const PreviewPanel = lazy(() => load.preview().then((m) => ({ default: m.PreviewPanel })));
const ForkDialog = lazy(() => load.fork().then((m) => ({ default: m.ForkDialog })));
const ForksDialog = lazy(() => load.fork().then((m) => ({ default: m.ForksDialog })));
const ContinueDialog = lazy(() => load.continueIn().then((m) => ({ default: m.ContinueDialog })));
const SendToDialog = lazy(() => load.sendTo().then((m) => ({ default: m.SendToDialog })));
const SnapshotsPanel = lazy(() => load.snapshots().then((m) => ({ default: m.SnapshotsPanel })));
const AttachedTerminalPanel = lazy(() => import('./AttachedTerminal.tsx').then((m) => ({ default: m.AttachedTerminalPanel })));
if (typeof window !== 'undefined') window.setTimeout(() => Object.values(load).forEach((f) => void f().catch(() => {})), 5000);
import { ShortcutHint, shortcutTitle, useCommand, usePaletteProvider, useShortcutRevision } from './shortcuts.tsx';
import { commandLabel as L } from './shortcuts.ts';
import { runCommand } from './shortcuts.ts';
import { useLaunch, useLaunchPalette } from './useLaunch.ts';
import { Glide } from './Glide.tsx';
import { toggleSteps, useStepsHidden } from './gui/steps.ts';
import { ActionSheet, SheetBar, useSheet } from './sheet.tsx';
import { SubagentsDialog, SubagentsPill } from './Subagents.tsx';
import { placeOf } from './requeue.ts';
import { runInShell, runPlace } from './runInShell.ts';
import { MoveToSpaceDialog } from './SpaceDialogs.tsx';

type Panel = 'diff' | 'files' | 'chat' | 'queue' | 'snapshots' | 'preview' | 'stack' | 'terminal';

type Props = {
  w: Win;
  client: HostApi;
  /** Live sessions in sidebar order. Send to… picks one of the others. */
  windows: Win[];
  clientFor: (host: string | undefined) => HostApi;
  narrow: boolean;
  touch: boolean;
  multiHost: boolean;
  /** Host home dir, to turn "~/x" into an absolute path. */
  home: string;
  /** Bumped when the user chose "Reply" somewhere, to focus input. */
  replyKey: number;
  onBack: () => void;
  onAnswer: (w: Win, answer: 'approve' | 'deny') => void;
  onSent: (r: SendResult, opts?: { quiet?: boolean }) => void;
  /** Confirmed: the parent closes this view and kills the window (optimistically). */
  onTerminate: () => void;
  refresh: () => void;
  /** Navigate to another session by key (fork focus, fork family). */
  onOpenKey?: (key: string) => void;
  /** This session receives UI shortcuts. Split view sets it on the focused pane. */
  active?: boolean;
  /** Open another session beside this one in split view (fork comparison). */
  onSplitWith?: (key: string) => void;
  /** Split this pane (F45). Provided by the workspace; hidden in single view. */
  onSplit?: (direction: 'right' | 'below') => void;
  /** Replace this pane's session (F45). */
  onReplace?: () => void;
  /** Close this pane without killing the session (F45). */
  onClosePane?: () => void;
  /** Flip the split that holds this pane, side by side or stacked. */
  onFlipSplit?: () => void;
  /** This pane's path in the split tree (`first/second`). Set while it can be dragged. */
  panePath?: string;
  /** Fires when a pane drag starts or ends, so the workspace can show edge docks. */
  onPaneDrag?: (active: boolean) => void;
  /** Send to… → New session, and Continue in…: the start dialog with this first message (and agent). */
  onStartSession?: (prompt: string, preset?: string) => void;
};


const onToast = (msg: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: msg }));

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
    (next) => {
      setV(next);
      try {
        localStorage.setItem(key, next);
      } catch {}
    },
  ];
}

/** "iPad and Mac" — other devices looking at this session right now. */
function others(devices: string[]): string | null {
  const rest = [...devices];
  const mine = rest.indexOf(deviceName());
  if (mine >= 0) rest.splice(mine, 1);
  const uniq = [...new Set(rest)];
  if (!uniq.length) return null;
  return uniq.length === 1 ? uniq[0] : `${uniq.slice(0, -1).join(', ')} and ${uniq.at(-1)}`;
}

/** Drag handle on the side panel's edge. Double-click resets the width. */
function PanelDivider({ onResize, onReset }: { onResize: (dx: number) => void; onReset: () => void }) {
  const dragging = useRef<number | null>(null);
  const lastX = useRef(0);
  return (
    <div
      className="divider v panel-divider"
      title="Drag to resize (double-click to reset). Focused: arrows resize, Home resets."
      tabIndex={0}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize side panel"
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          onResize((e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 120 : 40));
        } else if (e.key === 'Home') {
          e.preventDefault();
          onReset();
        }
      }}
      onPointerDown={(e) => {
        dragging.current = e.pointerId;
        lastX.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (dragging.current !== e.pointerId) return;
        onResize(e.clientX - lastX.current);
        lastX.current = e.clientX;
      }}
      onPointerUp={() => {
        dragging.current = null;
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
      onLostPointerCapture={() => {
        dragging.current = null;
      }}
      onDoubleClick={onReset}
    />
  );
}

const DEFAULT_PANEL_WIDTH = 420;


export function Session({ w, client, windows, clientFor, narrow, touch: touchScreen, multiHost, home, replyKey, onBack, onAnswer, onSent, onTerminate, refresh, onSplit, onReplace, onClosePane, onFlipSplit, panePath, onPaneDrag, onOpenKey, onSplitWith, onStartSession, active = true }: Props) {
  // A touch screen with a hardware keyboard (an iPad on a Magic Keyboard) is a keyboard device:
  // the session takes the keyboard as it opens, and the terminal needs no on-screen keys.
  const hw = useHardwareKeyboard();
  const touch = touchScreen && !hw;
  const surface = useRef<SurfaceHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  const tabRow = useRef<HTMLDivElement>(null);
  const review = useReviewFor(w.host, w.uid, w.branch, w.project);
  const [openingReview, setOpeningReview] = useState(false);
  const features = useContext(HostFeaturesContext)(w.host);
  const terminalSupported = (features?.attachedTerminal ?? 0) > 0;
  // Snippets always target this session's companion shell. Keep the transcript callback
  // stable as polling changes the session's status and the attachment's activity.
  const latest = useRef({ w, client, narrow, refresh });
  latest.current = { w, client, narrow, refresh };
  const runsIn = runPlace(w);
  const snippetRun = useMemo(
    () =>
      w.agent && terminalSupported
        ? {
            place: runsIn,
            run: (snippet: string) => {
              const { w, client, narrow, refresh } = latest.current;
              if (narrow) setTab('terminal');
              else { setPanel('terminal'); setPanelCollapsed(false); }
              void runInShell(client, w, snippet)
                .then(() => refresh())
                .catch((e) => showError(e, "Couldn't run it"));
            },
          }
        : undefined,
    [!!w.agent, runsIn, terminalSupported],
  );
  // 'main' is the session itself, drawn by whichever surface is chosen.
  const [tab, setTab] = useState<'main' | Panel>('main');
  const [storedPanel, setPanel] = stored<Panel | ''>('ah.panel', '');
  // Turns, a queue and forks belong to agents: a plain shell has none. The open
  // panel is remembered per device, so on a shell an agent-only one shows Files.
  const turns = !!w.agent;
  // The queue stays reachable while something waits in it, its agent gone or not (an exited
  // agent's queue is where Resume is offered).
  const queueShown = turns || w.queued > 0;
  // The stack a session builds is read on the host Review lives on, in a git checkout.
  const reviewHost = useContext(ReviewContext)?.host;
  const stackTab = reviewHost === w.host && !!w.branch;
  const panel: Panel | '' = (!terminalSupported && storedPanel === 'terminal') || ((!queueShown && storedPanel === 'queue') || (!turns && storedPanel === 'snapshots')) || (!stackTab && storedPanel === 'stack') ? 'files' : storedPanel;
  // Last non-empty panel, so the single header toggle reopens where you left off.
  const [lastPanel, setLastPanel] = useState<Panel>('files');
  useEffect(() => {
    if (panel) setLastPanel(panel);
  }, [panel]);
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      const v = Number(localStorage.getItem('ah.panelWidth'));
      return Number.isFinite(v) && v > 0 ? Math.min(720, Math.max(280, v)) : DEFAULT_PANEL_WIDTH;
    } catch {
      return DEFAULT_PANEL_WIDTH;
    }
  });
  // A split mounts a fresh session per pane. The open tab is remembered in
  // ah.panel, but collapsed is not, so the panel would expand in every pane
  // just as the space gets tighter. Start collapsed; the toggle still opens it.
  const [panelCollapsed, setPanelCollapsed] = useState(() => !!panePath);
  // Open when the session opened: there already. Opened later: it slides out from the edge.
  const panelAtOpen = useRef(!!panel && !panelCollapsed);
  if (!panel || panelCollapsed) panelAtOpen.current = false;
  // Past-chats browser inside the chat panel; resets with the session.
  const [chatHistory, setChatHistory] = useState(false);
  // A search result can ask for one chat at one message (issue #9).
  const [chatJump, setChatJump] = useState<{ uid: string; msgId: number } | null>(null);
  const [keysPref, setKeysPref] = stored<'auto' | 'on' | 'off'>('ah.keys', 'auto');
  const [viewPref, setViewPref] = stored<View>('ah.view', defaultView());
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const menuScrim = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; maxHeight: number; above: boolean } | null>(null);

  // Opened from the keyboard or with a click, the first item takes focus once the
  // menu is placed (it is invisible until then, and can't take focus), so arrows work at once.
  // Escape hands focus back to wherever it was (the terminal, the composer).
  const beforeMenu = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!menu) return;
    const was = document.activeElement as HTMLElement | null;
    beforeMenu.current = was && !menuEl.current?.contains(was) ? was : null;
  }, [menu]);
  useEffect(() => {
    if (menu && menuPos) focusFirst(menuEl.current);
  }, [menu, !!menuPos]);

  // The overflow menu is portalled to the body: split panes clip with
  // `.pane { overflow: hidden }`, which cut the menu off in short panes.
  // Cap it to the visible viewport (a sideways phone, or the band above the
  // keyboard) before measuring, so placement sees the box that will scroll.
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    const place = () => {
      const anchor = menuBtn.current?.getBoundingClientRect();
      const el = menuEl.current;
      if (!anchor || !el) return;
      const view = menuViewport(
        { width: window.innerWidth, height: window.innerHeight },
        window.visualViewport,
      );
      const maxHeight = Math.max(0, view.height - 16);
      el.style.maxHeight = `${maxHeight}px`;
      // Its layout size, not its box: the menu grows from the button as it opens, and a box
      // read mid-grow is smaller than the menu, so a tall one was placed below and ran off
      // the screen (an iPad's 44px rows).
      const at = placeFloatingMenu(anchor, { width: el.offsetWidth, height: el.offsetHeight }, view);
      // Flipped above the button when there is no room below: it grows from there instead.
      const next = { ...at, maxHeight: at.maxHeight ?? maxHeight, above: at.top < anchor.top };
      setMenuPos((prev) =>
        prev && prev.top === next.top && prev.left === next.left && prev.maxHeight === next.maxHeight ? prev : next,
      );
    };
    place();
    const vv = window.visualViewport;
    vv?.addEventListener('resize', place);
    vv?.addEventListener('scroll', place);
    return () => {
      vv?.removeEventListener('resize', place);
      vv?.removeEventListener('scroll', place);
    };
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (menuEl.current?.contains(e.target as Node)) return;
      if (menuBtn.current?.contains(e.target as Node)) return;
      // The sheet's scrim closes on its click, so the tap that closes the
      // sheet can't land on whatever was under it.
      if (menuScrim.current?.contains(e.target as Node)) return;
      // A phone's action sheet closes itself, sliding down (Cancel, a drag).
      if ((e.target as Element | null)?.closest?.('.action-sheet')) return;
      setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenu(false);
      const back = beforeMenu.current?.isConnected ? beforeMenu.current : menuBtn.current;
      back?.focus();
    };
    const close = () => setMenu(false);
    // Scrolling the menu itself must not dismiss it. Scroll does not bubble,
    // but this listener is on the capture path, so it still hears the menu.
    const onScroll = (e: Event) => {
      const t = e.target;
      if (t instanceof Node && menuEl.current && (t === menuEl.current || menuEl.current.contains(t))) return;
      setMenu(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [menu]);
  const [forking, setForking] = useState(false);
  /** Continue in (server/portable): the agent chosen, while its dialog is open. */
  const [continuing, setContinuing] = useState<string | null>(null);
  /** This session's automatic recovery switch (server/recovery), read when its menu opens. */
  const [autoRecover, setAutoRecover] = useState(false);
  useEffect(() => {
    if (!menu || !w.agent || !(features?.recovery ?? 0)) return;
    client.recovery(w.uid).then((r) => setAutoRecover(r.auto), () => {});
  }, [menu, w.uid, w.agent, client, features?.recovery]);
  const [branching, setBranching] = useState(false);
  const [movingSpace, setMovingSpace] = useState(false);
  const [sending, setSending] = useState(false);
  const [forksOpen, setForksOpen] = useState(false);
  /** The subagents dialog: closed, open, or open on a child (its ref or the call that spawned it). */
  const [subagents, setSubagents] = useState<{ open?: string } | null>(null);
  const openSubagent = useCallback((callId: string) => setSubagents({ open: callId }), []);
  const hostWindows = useMemo(() => windows.filter((x) => x.host === w.host), [windows, w.host]);
  const openHostSession = useCallback((uid: string) => onOpenKey?.(keyOnThisHost(uid)), [onOpenKey, w.host]);
  const [capture, setCapture] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const { color, name: agentName } = look(w.agent);
  const modelLabel = shortModel(w.model);
  // The launch summary repeats the model ("Haiku 4.5 · high · Plan"): keep only what it adds.
  const launchExtras = (w.launch ?? '').split(' · ').filter((p) => p && p.toLowerCase() !== modelLabel?.toLowerCase() && shortModel(p) !== modelLabel);
  // spaces 3: the Space it's in, never its project (shown beside it); an older host's sessions are in their project's.
  const spaced = (features?.spaces ?? 0) >= 3;
  const spaceName = w.space || (spaced ? null : w.project);
  const repoDiff = spaceName !== w.project ? w.project : null;
  const eyebrow = [spaceName, repoDiff, w.agent ? agentName : null, modelLabel, ...launchExtras].filter(Boolean).join(' · ');
  // Where the session works, on a phone's second line: the Space (or project) and its branch.
  const place = [spaceName ?? w.project, w.branch ? `⎇ ${w.branch}` : null].filter(Boolean).join(' ') || null;
  const chiefWorkers = w.supervision?.role === 'chief' ? windows.filter((x) => x.host === w.host && x.supervision?.managedBy === w.uid) : [];
  const chiefManager = w.supervision?.managedBy ? windows.find((x) => x.host === w.host && x.uid === w.supervision!.managedBy) ?? null : null;
  const jumpToSpace = () => {
    if (!spaceName) return;
    window.dispatchEvent(new CustomEvent('ah:open-space', { detail: { name: spaceName, host: w.host } }));
  };

  const abs = (p: string) => (p.startsWith('~') ? home + p.slice(1) : p);
  const views = viewsFor(w);
  const view: View = views.includes(viewPref) ? viewPref : 'terminal';
  // For callbacks that outlive this render (the keyboard claim runs across frames).
  const live = useRef({ view, status: w.status });
  live.current = { view, status: w.status };
  // Files dropped anywhere on the conversation wait in the composer, as pasted ones do.
  const composer = useRef<ComposerHandle>(null);
  const fileDrop = useFileDrop((files) => composer.current?.attach(files), view === 'gui');
  const Surface = surfaceFor(view);
  // A blank session offers the project's past ones; the one you pick takes its place.
  const resumer = useContext(ResumeContext);
  const recent = resumer && onOpenKey && w.agent && !w.launch ? recentFor(resumer.history, w) : [];
  const resumeRecent = async (h: HistoryItem) => {
    const key = await resumer!.resume(h);
    if (!key) return;
    onOpenKey!(key);
    // Nothing was said in it in the meantime: it would only be left behind, empty.
    if (live.current.status === 'idle' && !w.queued) resumer!.discard(w);
  };

  useEffect(() => {
    setTab('main');
    setRenaming(false);
    setChatHistory(false);
    setChatJump(null);
    try {
      const seqJump = JSON.parse(sessionStorage.getItem('ah.seqJump') ?? 'null');
      if (seqJump?.host === w.host && seqJump?.uid === w.uid) setViewPref('gui');
      const raw = sessionStorage.getItem('ah.chatJump');
      if (raw) {
        const jump = JSON.parse(raw) as { host?: string; uid?: string; msgId?: number };
        if (jump.host === w.host && jump.uid === w.uid && typeof jump.msgId === 'number') {
          sessionStorage.removeItem('ah.chatJump');
          setChatJump({ uid: jump.uid, msgId: jump.msgId });
          setChatHistory(true);
          setPanel('chat');
          setPanelCollapsed(false);
          setTab('chat');
        }
      }
    } catch {}
  }, [w.key]);
  useEffect(() => {
    const jump = (event: Event) => {
      const detail = (event as CustomEvent<{ host: string; uid: string; seq?: number; msgId?: number }>).detail;
      if (detail.host !== w.host || detail.uid !== w.uid) return;
      if (detail.seq != null) { setViewPref('gui'); setTab('main'); }
      if (detail.msgId != null) {
        sessionStorage.removeItem('ah.chatJump');
        setChatJump({ uid: w.uid, msgId: detail.msgId });
        setChatHistory(true); setPanel('chat'); setPanelCollapsed(false); setTab('chat');
      }
    };
    window.addEventListener('ah:search-jump', jump);
    return () => window.removeEventListener('ah:search-jump', jump);
  }, [w.host, w.uid]);
  // The terminal supplies its own input, so the graphical composer lives only
  // in the GUI view. "Reply" focuses whichever input is showing.
  const focusInput = () => {
    if (view === 'gui') setFocus((n) => n + 1);
    else surface.current?.focus();
  };
  /** Reply: a waiting session's answer controls first, else the input. */
  const reply = () => {
    setTab('main');
    if (w.status === 'waiting' && surface.current?.focusAsk?.()) return;
    focusInput();
  };
  useEffect(() => {
    if (replyKey) reply();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replyKey]);
  const keysEnabled = keysPref === 'on' || (keysPref === 'auto' && touch);
  const showKeys = keysEnabled && tab === 'main' && view === 'terminal';
  const elsewhere = others(w.devices);

  /**
   * Give the session the keyboard: its terminal, or in the GUI its composer. Claimed every
   * frame until it lands, because surfaces are lazy (the GUI may not be loaded yet, the
   * ref empty) and, during a view transition, the session you left still holds focus.
   * Never from a dialog or a field outside the workspace, which someone chose.
   */
  function claimKeyboard(ms = 1500): () => void {
    const until = performance.now() + ms;
    let raf = 0;
    // Once you act (a key, a click, a tap) and focus goes somewhere outside the session, it's
    // yours: the claim stands down, so a menu opened by a chord or the next row in the sidebar
    // isn't pulled back. Typing in the session keeps it watching for a remounting composer.
    let acted = false;
    const act = () => (acted = true);
    window.addEventListener('keydown', act, true);
    window.addEventListener('pointerdown', act, true);
    const release = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', act, true);
      window.removeEventListener('pointerdown', act, true);
    };
    // Watched until the deadline, not just until it lands: a surface still loading can
    // replace the element that took focus (the composer remounts once the feed is in).
    const claim = () => {
      // A screen over the session (New session) owns the keyboard: stop, or keys
      // typed into it would land in this session's hidden terminal.
      if (document.querySelector('[data-focus-owner]')) return release();
      const a = document.activeElement as HTMLElement | null;
      const mine = body.current;
      const landed = !!mine && !!a && mine.contains(a) && a.getClientRects().length > 0;
      if (!landed) {
        if (acted && a && a !== document.body && a.isConnected) return release();
        const elsewhere = a && a !== document.body && a.isConnected && (a.closest('dialog[open]') || (a.matches('input, textarea, select, [contenteditable="true"]') && !a.closest('.session-body, .pane')));
        if (elsewhere) return release();
        focusSurface();
      }
      if (performance.now() < until) raf = requestAnimationFrame(claim);
      else release();
    };
    raf = requestAnimationFrame(claim);
    return release;
  }

  /** The session's input, now: true when the keyboard is in it. */
  function focusSurface(): boolean {
    // In the GUI the composer is on the page before the (lazy) feed surface has loaded:
    // focus it directly, so keys typed right after the switch aren't lost. A waiting
    // session's answer controls come first, as Reply does.
    if (live.current.view === 'gui' && !(live.current.status === 'waiting' && surface.current?.focusAsk?.())) composer.current?.focus();
    else surface.current?.focus();
    const a = document.activeElement;
    return !!a && !!body.current?.contains(a);
  }

  // Moving between panes (App's focusPane) hands the keyboard over within the keystroke:
  // a key typed straight after it would otherwise reach the pane just left (its terminal)
  // before the next frame's claim.
  useEffect(() => {
    const el = body.current;
    if (!el || touch) return;
    const take = (e: Event) => {
      if (focusSurface()) e.preventDefault();
    };
    el.addEventListener('ah:take-keyboard', take);
    return () => el.removeEventListener('ah:take-keyboard', take);
  });

  /** Switch surfaces; the next one mounts fresh (and may still be loading). */
  const switchView = (next: View, focusAfter = false) => {
    setViewPref(next);
    setTab('main');
    if (focusAfter && !touch) claimKeyboard();
  };

  /** Open a side panel tab, expanding the panel when it was collapsed. */
  const openPanel = (p: Panel) => {
    setPanel(panel === p ? '' : p);
    setPanelCollapsed(false);
  };

  /** Dragging the panel's edge left (negative dx) widens it. */
  const resizePanel = (dx: number) => {
    const max = body.current ? Math.max(320, body.current.clientWidth * 0.7) : 720;
    setPanelWidth((prev) => {
      const next = Math.min(max, Math.max(280, prev - dx));
      try {
        localStorage.setItem('ah.panelWidth', String(Math.round(next)));
      } catch {}
      return next;
    });
  };

  // Keyboard resize (App's resize commands and resize mode) when there's no split.
  useEffect(() => {
    if (!active) return;
    const onResize = (e: Event) => {
      if (!panel || panelCollapsed || narrow) return;
      resizePanel((e as CustomEvent<number>).detail);
    };
    window.addEventListener('ah:resize-panel', onResize);
    return () => window.removeEventListener('ah:resize-panel', onResize);
  });

  const resetPanelWidth = () => {
    setPanelWidth(DEFAULT_PANEL_WIDTH);
    try {
      localStorage.setItem('ah.panelWidth', String(DEFAULT_PANEL_WIDTH));
    } catch {}
  };

  async function act(fn: () => Promise<unknown>) {
    setMenu(false);
    try {
      await fn();
    } catch (e) {
      showError(e);
    }
    refresh();
  }

  // Inline rename: clicking the title turns it into a field. Enter commits,
  // Escape cancels, leaving the field commits too.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);
  const renameCancelled = useRef(false);

  const startRename = () => {
    setNameDraft(w.name);
    renameCancelled.current = false;
    setRenaming(true);
    setMenu(false);
  };

  // The new name shows at once (the server confirms it on its next state) and goes back
  // if saving fails; either way the keyboard returns to the session.
  const [pendingName, setPendingName] = useState<string | null>(null);
  useEffect(() => {
    if (pendingName !== null && w.name === pendingName) setPendingName(null);
  }, [w.name, pendingName]);
  const backToSession = () => void claimKeyboard(600);

  async function commitRename() {
    const name = nameDraft.trim();
    if (nameSaving) return;
    setRenaming(false);
    backToSession();
    if (!name || name === w.name) return;
    setPendingName(name);
    setNameSaving(true);
    try {
      await client.rename(w.uid, name);
      refresh();
    } catch (e) {
      setPendingName(null);
      showError(e, "Couldn't rename");
    } finally {
      setNameSaving(false);
    }
  }

  const cancelRename = () => {
    renameCancelled.current = true;
    setRenaming(false);
    backToSession();
  };

  // Terminate kills the tmux window; stronger wording while it is working,
  // waiting, or holding queued prompts (F44).
  const kill = async () => {
    setMenu(false);
    if (await confirmTerminate(w)) onTerminate();
  };

  const comment = async (text: string) => onSent(await client.send(w.uid, text, true));

  // Session keys are the uid, host-prefixed for peers; a fork or relaunch on this
  // host shares the prefix of the session it came from.
  const keyOnThisHost = (uid: string) => w.key.slice(0, w.key.length - w.uid.length) + uid;
  const forked = (uid: string) => {
    setForking(false);
    refresh();
    if (onOpenKey) onOpenKey(keyOnThisHost(uid));
    else window.dispatchEvent(new CustomEvent('ah:toast', { detail: 'Fork started; find it in the sidebar' }));
  };

  useShortcutRevision();
  const diffTab = w.branch ? 'Diff' : null;
  // The header's status settles in when it changes here, not when the session opens.
  // Sticky for as long as that status lasts, so a re-render can't cut the animation short.
  const lastStatus = useRef<{ key: string; status: string } | null>(null);
  const popped = useRef<{ key: string; status: string } | null>(null);
  if (lastStatus.current?.key === w.key && lastStatus.current.status !== statusClass(w)) popped.current = { key: w.key, status: statusClass(w) };
  const changed = popped.current?.key === w.key && popped.current.status === statusClass(w);
  useEffect(() => {
    lastStatus.current = { key: w.key, status: statusClass(w) };
  });
  // Desktop only: a phone would pop the software keyboard every time a session opens.
  // The keyboard belongs here once a session opens, so it is claimed every frame until it
  // lands: the surfaces are lazy (their ref is empty at first), and during the view
  // transition the session you left still holds focus. Never from a dialog or a field
  // somewhere else, which someone chose.
  // Opening is what claims: the first key from a keyboard joined to a tablet turns `touch`
  // off mid-session, and claiming then pulled that key's focus (a tab, a segment) into the composer.
  const touchNow = useRef(touch);
  touchNow.current = touch;
  useEffect(() => {
    if (!active || touchNow.current) return;
    return claimKeyboard();
  }, [active, w.key]);
  useCommand('toggle-view', () => switchView(view === 'gui' ? 'terminal' : 'gui', true), active && views.length > 1);
  useCommand(
    'toggle-panel',
    () => {
      if (panel && !panelCollapsed) setPanelCollapsed(true);
      else if (panel) setPanelCollapsed(false);
      else {
        setPanel(lastPanel);
        setPanelCollapsed(false);
      }
    },
    active && !narrow,
  );
  useCommand('split-right', () => onSplit?.('right'), active && !!onSplit);
  useCommand('split-below', () => onSplit?.('below'), active && !!onSplit);
  useCommand('close-pane', () => onClosePane?.(), active && !!onClosePane);
  useCommand('replace-pane', () => onReplace?.(), active && !!onReplace);
  useCommand('terminate', () => {
    void kill();
  }, active);
  useCommand('approve', () => onAnswer(w, 'approve'), active && w.answerable && w.status === 'waiting');
  useCommand('deny', () => onAnswer(w, 'deny'), active && w.answerable && w.status === 'waiting');
  useCommand('reply', reply, active);
  useCommand('focus-main', focusInput, active);

  // Every menu action is also a command, so the palette and chords reach it.
  const working = w.status === 'busy' || w.status === 'waiting';
  useCommand('interrupt', () => void client.interrupt(w.uid).then(() => onToast('Interrupted'), (e) => showError(e, "Couldn't interrupt")), active && working);
  useCommand(
    'send-now',
    () =>
      void (async () => {
        const [next] = await client.queue(w.uid);
        if (!next) return onToast('Nothing queued');
        await client.sendNow(w.uid, next.id);
        onToast('Sent the next queued message');
        refresh();
      })().catch(async (e) => {
        if (!((features?.resumeInPlace ?? 0) > 0 && (await offerResume(e, () => client.resume(w.uid).then(refresh))))) showError(e, "Couldn't send now");
      }),
    active && w.queued > 0,
  );
  useCommand(
    'clear-queue',
    () =>
      void act(async () => {
        if (await askConfirm({ title: `Cancel ${w.queued} queued message${w.queued === 1 ? '' : 's'}?`, confirm: 'Cancel them', cancel: 'Keep', danger: true })) await client.clearQueue(w.uid);
      }),
    active && w.queued > 0,
  );
  useCommand('rename', startRename, active && !renaming);
  useCommand('switch-branch', () => setBranching(true), active && !!w.branch);
  useCommand('fork', () => setForking(true), active && turns);
  useCommand('send-to', () => setSending(true), active && !!w.feed);
  useCommand('pin', () => void act(() => client.pin(w.uid, !w.pinned)), active);
  // Its close (or collapse) button goes with it: the keyboard goes back to the session, not to the page
  // (no finger here, where the composer would raise the on-screen keyboard).
  const closePanel = (collapse = false) => {
    if (collapse) setPanelCollapsed(true);
    else setPanel('');
    if (touch) return;
    requestAnimationFrame(() => {
      const a = document.activeElement;
      if (!a || a === document.body) focusSurface();
    });
  };
  const togglePanel = (p: Panel) => {
    if (narrow) setTab(tab === p ? 'main' : p);
    else openPanel(p);
  };
  useCommand('panel-terminal', () => togglePanel('terminal'), active && terminalSupported);
  useCommand('panel-diff', () => togglePanel('diff'), active && !!diffTab);
  useCommand('panel-files', () => togglePanel('files'), active);
  useCommand('panel-chat', () => togglePanel('chat'), active);
  useCommand('panel-queue', () => togglePanel('queue'), active && queueShown);
  useCommand('panel-snapshots', () => togglePanel('snapshots'), active && turns);
  useCommand('panel-preview', () => togglePanel('preview'), active);
  useCommand('panel-stack', () => togglePanel('stack'), active && stackTab);
  useCommand('copy-last', () => surface.current?.copyLast?.(), active && view === 'gui');
  useCommand('jump-latest', () => surface.current?.jumpLatest?.(), active && view === 'gui');
  useCommand('browse-messages', () => void surface.current?.browse?.(), active && view === 'gui');
  const stepsHidden = useStepsHidden();
  useCommand('toggle-steps', () => {
    toggleSteps();
    onToast(stepsHidden ? 'Showing steps' : 'Steps hidden: each run of tool calls is one line');
  }, active && view === 'gui');

  // Model and effort in the terminal view (the GUI's composer covers its own view).
  const launch = useLaunch({
    client,
    w,
    agent: w.agent,
    onNotice: onToast,
    onSent,
    onRelaunched: (uid) => {
      refresh();
      onOpenKey?.(keyOnThisHost(uid));
    },
  });
  useLaunchPalette(launch, active && view !== 'gui' && !!w.agent);
  const terminalPicker = (setting: 'model' | 'effort') =>
    launch.preset?.settingsCommands?.[setting] ? launch.openSettings(setting) : onToast(`Palette → Session → Model and effort lists the ${setting === 'model' ? 'models' : 'effort levels'}`);
  useCommand('pick-model', () => void terminalPicker('model'), active && view !== 'gui' && !!w.agent);
  useCommand('pick-effort', () => void terminalPicker('effort'), active && view !== 'gui' && !!w.agent);
  useCommand('scrollback', () => void act(async () => setCapture(await client.capture(w.uid))), active);
  useCommand(
    'copy-attach',
    () =>
      void copyText(`ah attach ${w.uid}`).then((ok) => onToast(ok ? `Copied “ah attach ${w.uid}”` : "Couldn't copy")),
    active,
  );
  useCommand('toggle-keys', () => setKeysPref(keysEnabled ? 'off' : 'on'), active && (view === 'terminal' || panel === 'terminal' || tab === 'terminal'));
  useCommand('session-menu', () => setMenu(true), active);

  // Continue in…: the same conversation, handed to another agent in a new session here.
  const otherAgents = useContext(HostPresetsContext)(w.host).filter((p) => p.available && !p.hidden && p.command && p.id !== 'shell' && p.id !== w.agent);
  // The host carries it over itself (preview, lineage, a native copy where it can); a host
  // without portable conversations gets the earlier way: a new session primed by this page.
  function continueIn(preset: string) {
    if (!onStartSession) return;
    setContinuing(preset);
  }
  async function continueHere(preset: string) {
    if (!onStartSession) return;
    onToast('Reading the conversation…');
    try {
      onStartSession(await continuePrompt(client, w), preset);
    } catch (e) {
      showError(e, "Couldn't read the conversation");
    }
  }
  usePaletteProvider(
    'agents',
    () => otherAgents.map((p) => ({ key: `continue:${p.id}`, label: `Continue in ${p.name}`, agent: p.id, detail: 'A new session here, primed with this conversation', run: () => void continueIn(p.id) })),
    active && !!w.feed && !!onStartSession,
  );

  // Palette → Session → Turn and queue: each queued message, with what you can do to it.
  usePaletteProvider(
    'queue',
    async () => {
      const items = await client.queue(w.uid);
      const act = (fn: () => Promise<unknown>, done: string) => () =>
        void fn().then(
          () => {
            onToast(done);
            refresh();
          },
          (e) => showError(e, "Couldn't change the queue"),
        );
      return items.map((item, n) => {
        const first = item.text.split('\n')[0];
        return {
          key: `queued:${item.id}`,
          label: first.length > 70 ? `${first.slice(0, 69)}…` : first,
          icon: 'queue' as const,
          detail: n === 0 ? 'Queued · next' : `Queued · #${n + 1}`,
          children: [
            { key: 'send', label: 'Send now', icon: 'send' as const, detail: 'Stop the current turn and deliver this now', run: act(() => client.sendNow(w.uid, item.id), 'Sent') },
            {
              key: 'edit',
              label: 'Edit',
              icon: 'edit' as const,
              detail: 'Take it out of the queue and into the composer',
              run: act(async () => {
                const before = placeOf(items, item.id);
                await client.clearQueue(w.uid, item.id);
                if (view !== 'gui') switchView('gui');
                requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('ah:compose', { detail: { uid: w.uid, text: item.text, before } })));
              }, 'Back in the composer'),
            },
            { key: 'cancel', label: 'Cancel', icon: 'close' as const, detail: 'Drop this message', run: act(() => client.clearQueue(w.uid, item.id), 'Cancelled') },
          ],
        };
      });
    },
    active && w.queued > 0,
  );

  const panelView = (p: Panel) => <Suspense fallback={<div className="panel-body" />}>{panelOf(p)}</Suspense>;
  const panelOf = (p: Panel) =>
    p === 'terminal' ? (
      <AttachedTerminalPanel key={w.key} w={w} client={client} refresh={refresh} showKeys={keysEnabled} focusOnOpen={active && !touch} />
    ) : p === 'queue' ? (
      <QueuePanel client={client} uid={w.uid} canResume={(features?.resumeInPlace ?? 0) > 0} onChange={refresh} />
    ) : p === 'snapshots' ? (
      <SnapshotsPanel client={client} w={w} onChange={refresh} />
    ) : p === 'preview' ? (
      <PreviewPanel client={client} uid={w.uid} />
    ) : p === 'diff' ? (
      <ChangesPanel client={client} uid={w.uid} onComment={w.agent ? comment : undefined} />
    ) : p === 'stack' ? (
      <Suspense fallback={<div className="panel-body" />}>
        <StackPanel uid={w.uid} />
      </Suspense>
    ) : p === 'chat' ? (
      <Suspense fallback={<div className="panel-body" />}>
        {chatHistory ? <ChatHistory client={client} jump={chatJump} /> : <SideChat client={client} w={w} onSent={onSent} />}
      </Suspense>
    ) : (
      <FilesPanel
        fs={client.fs}
        start={abs(w.cwd)}
        cwd={abs(w.cwd)}
        agent={w.agent}
        onInsert={(text) => {
          setTab('main');
          surface.current?.insert(text);
        }}
      />
    );

  // What you look at (the session, or one of its panels); the glass capsule above picks how (GUI
  // or terminal). Icons, the open one with its name, so every tab fits a phone (as on a desktop).
  const mobileTabs = (
    [
      ['main', 'sessions', 'Session', true],
      ['terminal', 'terminal', 'Terminal', !!w.terminal || tab === 'terminal'],
      ['diff', 'diff', L('panel-diff'), diffTab],
      ['files', 'files', L('panel-files'), true],
      // A side chat's own mark: the chat bubble is the header's GUI view, right above.
      ['chat', 'sparkle', L('panel-chat'), true],
      // Nothing queued: the tab steps aside (the menu and palette still open it).
      ['queue', 'queue', L('panel-queue'), queueShown && (w.queued > 0 || tab === 'queue')],
      ['snapshots', 'history', L('panel-snapshots'), turns],
      ['preview', 'globe', L('panel-preview'), true],
      // Its branch in review, or open: otherwise the menu opens it.
      ['stack', 'stack', L('panel-stack'), stackTab && (!!review?.layer || tab === 'stack')],
    ] as const
  ).filter(([, , , shown]) => shown);
  // Picking a tab moves the others too: the open one shows its name.
  // On a phone the strip is where panels open: the menu leaves out the ones it shows.
  const onStrip = (id: Panel) => narrow && mobileTabs.some(([t]) => t === id);
  useTabFlow(tabRow, `${mobileTabs.map(([id]) => id).join(' ')} ${tab}`);
  const menuBody = (
    <div
      ref={menuEl}
      data-rove
      role="menu"
      className={narrow ? 'menu sheet' : 'menu'}
      onPointerLeave={(e) => {
        if (e.pointerType === 'touch') return;
        setMenu(false);
      }}
      style={
        narrow
          ? { margin: 0 }
          : menuPos
          ? { position: 'fixed', right: 'auto', top: menuPos.top, left: menuPos.left, maxHeight: menuPos.maxHeight, zIndex: 90, margin: 0, transformOrigin: menuPos.above ? 'bottom right' : 'top right' }
          : { position: 'fixed', right: 'auto', visibility: 'hidden', zIndex: 90, margin: 0 }
      }
    >
      <button onClick={startRename}><span className="grow">{L('rename')}</span><ShortcutHint id="rename" /></button>
      {/* Here on every device, so the menu is the same wherever it opens (the desktop header's pill is a shortcut to it). */}
      {w.branch && (
        <button
          onClick={() => {
            setMenu(false);
            setBranching(true);
          }}
        >
          <span className="grow">{L('switch-branch')}</span>
          <span className="menu-value mono">{w.branch}</span>
        </button>
      )}
      {turns && (
        <button
          onClick={() => {
            setMenu(false);
            setForking(true);
          }}
        >
          <span className="grow">{L('fork')}</span>
          <ShortcutHint id="fork" />
        </button>
      )}
      {w.feed && (
        <button
          onClick={() => {
            setMenu(false);
            setSending(true);
          }}
        >
          <span className="grow">{L('send-to')}</span>
          <ShortcutHint id="send-to" />
        </button>
      )}
      {w.feed && onStartSession && otherAgents.length > 0 && (
        <div className="menu-agents" role="group" aria-label="Continue in another agent" style={{ '--agents': otherAgents.length } as React.CSSProperties}>
          <span className="menu-agents-label">Continue in</span>
          {otherAgents.map((p) => (
            <button
              key={p.id}
              className="menu-agent"
              title={`Continue this conversation in ${p.name}`}
              aria-label={`Continue in ${p.name}`}
              onClick={() => {
                setMenu(false);
                void continueIn(p.id);
              }}
            >
              <AgentLogo id={p.id} size={16} />
              <span className="menu-agent-name" aria-hidden>{p.name}</span>
            </button>
          ))}
        </div>
      )}
      <button onClick={() => act(() => client.pin(w.uid, !w.pinned))}>{w.pinned ? 'Unpin' : L('pin')}</button>
      {(features?.spaces ?? 0) >= 2 && (
        <button
          onClick={() => {
            setMenu(false);
            setMovingSpace(true);
          }}
        >
          <span className="grow">Move to Space…</span>
          {w.space && <span className="menu-value">{w.space}</span>}
        </button>
      )}
      <hr />
      {terminalSupported && <button aria-label="Terminal" onClick={() => { setMenu(false); togglePanel('terminal'); }}><Icon name="terminal" size={14} /><span className="grow">Terminal</span>{w.terminal && <span className={`terminal-indicator${w.terminal.busy ? ' busy' : ''}`} aria-hidden>●</span>}</button>}
      {diffTab && !onStrip('diff') && <button onClick={() => { setMenu(false); togglePanel('diff'); }}><span className="grow">{L('panel-diff')}</span><ShortcutHint id="panel-diff" /></button>}
      {!onStrip('files') && <button onClick={() => { setMenu(false); togglePanel('files'); }}><span className="grow">{L('panel-files')}</span><ShortcutHint id="panel-files" /></button>}
      {!onStrip('chat') && <button onClick={() => { setMenu(false); togglePanel('chat'); }}><span className="grow">{L('panel-chat')}</span><ShortcutHint id="panel-chat" /></button>}
      {queueShown && !onStrip('queue') && <button onClick={() => { setMenu(false); togglePanel('queue'); }}><span className="grow">{L('panel-queue')}</span>{w.queued > 0 && <span className="menu-value">{w.queued}</span>}<ShortcutHint id="panel-queue" /></button>}
      {w.queued > 0 && <button onClick={() => { setMenu(false); runCommand('send-now'); }}><span className="grow">{L('send-now')}</span><ShortcutHint id="send-now" /></button>}
      {turns && !onStrip('snapshots') && <button onClick={() => { setMenu(false); togglePanel('snapshots'); }}><span className="grow">{L('panel-snapshots')}</span><ShortcutHint id="panel-snapshots" /></button>}
      {!onStrip('preview') && <button onClick={() => { setMenu(false); togglePanel('preview'); }}><span className="grow">{L('panel-preview')}</span><ShortcutHint id="panel-preview" /></button>}
      {stackTab && !onStrip('stack') && <button onClick={() => { setMenu(false); togglePanel('stack'); }}><span className="grow">{L('panel-stack')}</span><ShortcutHint id="panel-stack" /></button>}
      {(onSplit || onReplace || onClosePane) && <hr />}
      {onSplit && (
        <>
          <button
            onClick={() => {
              setMenu(false);
              onSplit('right');
            }}
          >
            <span className="grow">Split right</span>
            <ShortcutHint id="split-right" />
          </button>
          <button
            onClick={() => {
              setMenu(false);
              onSplit('below');
            }}
          >
            <span className="grow">Split below</span>
            <ShortcutHint id="split-below" />
          </button>
          {onFlipSplit && (
            <button
              onClick={() => {
                setMenu(false);
                onFlipSplit();
              }}
            >
              <span className="grow">Flip split</span>
              <ShortcutHint id="toggle-split" />
            </button>
          )}
        </>
      )}
      {onReplace && (
        <button
          onClick={() => {
            setMenu(false);
            onReplace();
          }}
        >
          <span className="grow">Replace pane…</span>
          <ShortcutHint id="replace-pane" />
        </button>
      )}
      {onClosePane && (
        <button
          onClick={() => {
            setMenu(false);
            onClosePane();
          }}
        >
          <span className="grow">Close pane</span>
          <ShortcutHint id="close-pane" />
        </button>
      )}
      {w.agent && (features?.recovery ?? 0) > 0 && (
        <>
          <hr />
          {w.recovery && w.recovery.state !== 'resuming' && w.recovery.state !== 'needs_user' && (
            <button onClick={() => act(() => client.recoveryAction(w.uid, { action: 'retry' }))}>
              <span className="grow">Go on now</span>
            </button>
          )}
          {w.recovery && ['scheduled', 'waiting_capacity', 'recoverable'].includes(w.recovery.state) && (
            <button onClick={() => act(() => client.recoveryAction(w.uid, { action: 'pause' }))}>
              <span className="grow">Pause recovery</span>
            </button>
          )}
          {w.recovery?.state === 'stopped' && (
            <button onClick={() => act(() => client.recoveryAction(w.uid, { action: 'resume' }))}>
              <span className="grow">Resume recovery</span>
            </button>
          )}
          {w.recovery && (
            <button onClick={() => act(() => client.recoveryAction(w.uid, { action: 'cancel' }))}>
              <span className="grow">Stop retrying</span>
            </button>
          )}
          <button role="menuitemcheckbox" aria-checked={!!w.recovery?.auto || autoRecover} onClick={() => act(async () => setAutoRecover((await client.recoveryAction(w.uid, { auto: !(w.recovery?.auto ?? autoRecover) })).auto))}>
            <span className="grow">Keep going after limits and crashes</span>
            {(w.recovery?.auto ?? autoRecover) && <span className="check">✓</span>}
          </button>
        </>
      )}
      <hr />
      <button
        onClick={() =>
          act(async () => {
            setCapture(await client.capture(w.uid));
          })
        }
      >
        Scrollback as text
      </button>
      {view === 'gui' && (
        <button
          onClick={() => {
            toggleSteps();
            setMenu(false);
          }}
        >
          <span className="grow">{stepsHidden ? 'Show' : 'Hide'} steps</span>
          <ShortcutHint id="toggle-steps" />
        </button>
      )}
      {(view === 'terminal' || panel === 'terminal' || tab === 'terminal') && (
        <button
          onClick={() => {
            setKeysPref(keysEnabled ? 'off' : 'on');
            setMenu(false);
          }}
        >
          <span className="grow">{keysEnabled ? 'Hide' : 'Show'} on-screen keys</span>
          <ShortcutHint id="toggle-keys" />
        </button>
      )}
      <button
        onClick={() => {
          navigator.clipboard?.writeText(`ah attach ${w.uid}`).catch(() => {});
          setMenu(false);
        }}
      >
        <span className="grow">{L('copy-attach')}</span>
        <span className="menu-value mono">ah attach {w.uid}</span>
      </button>
      {/* Everything else this session can do; on a touch screen, the palette's only way in. */}
      <button
        onClick={() => {
          setMenu(false);
          runCommand('command-palette');
        }}
      >
        <span className="grow">All commands…</span>
        <ShortcutHint id="command-palette" />
      </button>
      <hr />
      <button className="danger" onClick={kill}>
        <span className="grow">{L('terminate')}</span>
        <ShortcutHint id="terminate" />
      </button>
    </div>
  );

  const openSessionReview = async () => {
    if (!review || openingReview) return;
    if (review.fixing) return review.open(review.fixing.stackId, review.fixing.pr);
    if (review.link) return review.open(review.link.stackId, review.link.pr);
    if (review.layer) return review.open(review.layer.stackId, review.layer.pr);
    setOpeningReview(true);
    try {
      const out = await reviewApi().openForSession(w.uid);
      if (out.created) window.dispatchEvent(new CustomEvent('ah:toast', { detail: 'Started review for this session' }));
      review.open(out.stack.id, out.pr);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/no open pull request/i.test(msg)) {
        openPanel('stack');
        window.dispatchEvent(new CustomEvent('ah:toast', { detail: 'No open pull request for this session yet' }));
      } else {
        showError(e, "Couldn't open review");
      }
    } finally {
      setOpeningReview(false);
    }
  };
  const reviewPill = !review ? null : review.fixing ? (
    <button type="button" className="pill busy review-pill" onClick={() => review.open(review.fixing!.stackId, review.fixing!.pr)} title="Findings from Review this session is working on">
      <Icon name="stack" size={13} />
      {narrow ? (review.fixing.role || `#${review.fixing.pr}`) : `${review.fixing.merge ? 'Merging' : review.fixing.count ? `Fixing ${review.fixing.count}` : 'Review'} · ${review.fixing.role || `#${review.fixing.pr}`}`}
    </button>
  ) : review.link ? (
    <button
      type="button"
      className={`pill review-pill ${review.link.readyToMerge ? 'attention' : review.link.needsYou > 0 || review.link.status === 'rereview' ? 'waiting' : ''}`}
      onClick={() => review.open(review.link!.stackId, review.link!.pr)}
      title={`Open "${review.link.stackTitle}" in Review`}
    >
      <Icon name="stack" size={13} />
      {narrow
        ? (review.link.role || (review.link.pr ? `#${review.link.pr}` : 'Review'))
        : review.link.readyToMerge
          ? `Ready to merge · ${review.link.role || `#${review.link.pr}`}`
          : review.link.status === 'rereview'
            ? `Re-review · ${review.link.role || `#${review.link.pr}`}`
            : review.link.openFindings > 0
              ? `${review.link.openFindings} comment${review.link.openFindings === 1 ? '' : 's'} · ${review.link.role || `#${review.link.pr}`}`
              : `Review · ${review.link.role || (review.link.pr ? `#${review.link.pr}` : review.link.stackTitle)}`}
    </button>
  ) : review.layer ? (
    <button type="button" className="pill review-pill" onClick={() => review.open(review.layer!.stackId, review.layer!.pr)} title={`${review.layer.stackTitle}, in Review`}>
      <Icon name="stack" size={13} />
      {review.layer.role || `#${review.layer.pr}`}
    </button>
  ) : w.branch ? (
    <button
      type="button"
      className={`pill review-pill quiet${openingReview ? ' busy' : ''}`}
      disabled={openingReview}
      onClick={() => void openSessionReview()}
      title="Open or start a review for this session's PR or stack"
    >
      <Icon name="stack" size={13} />
      {openingReview ? 'Opening…' : 'Review'}
    </button>
  ) : null;

  const mobileGlass = narrow || touchScreen;
  const floatGlass = mobileGlass && view === 'gui' && tab === 'main';
  return (
    <>
      <MobileOverlay enabled={mobileGlass} edge="top" floating={floatGlass}>
      <header className="session-head">
        {narrow && (
          <button className="icon-btn" onClick={onBack} aria-label="Back">
            <Icon name="back" size={24} />
          </button>
        )}
        {!narrow && (
          <span
            className={`chip lg${panePath ? ' pane-drag' : ''}`}
            style={{ '--agent': color } as React.CSSProperties}
            draggable={!!panePath}
            title={panePath ? 'Drag to move this pane' : undefined}
            onDragStart={(e) => {
              if (!panePath) return;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/ah-pane', panePath);
              onPaneDrag?.(true);
            }}
            onDragEnd={() => onPaneDrag?.(false)}
          >
            <AgentLogo id={w.agent} size={17} />
          </span>
        )}
        <div className="session-title">
          {!narrow && (
            <span className="eyebrow">{eyebrow}</span>
          )}
          {renaming ? (
            <input
              className="name editing"
              autoFocus
              value={nameDraft}
              disabled={nameSaving}
              maxLength={80}
              aria-label="Session name"
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelRename();
                }
              }}
              onBlur={() => {
                if (renameCancelled.current) {
                  renameCancelled.current = false;
                  return;
                }
                commitRename();
              }}
            />
          ) : (
            <button className="name" onClick={startRename} title="Rename">
              {pendingName ?? w.title}
            </button>
          )}
          {narrow && (
            <span className="eyebrow">
              {/* The status leads the second line, so the title keeps the first line's width. */}
              <span className={`pill ${statusClass(w)}`}>{statusWord(w)}</span>
              {/* A phone's header has room for two things: another device viewing it leads, then
                  where the session works (its project and branch), then which agent it is. */}
              {[elsewhere ? `On ${elsewhere} too` : null, place, elsewhere ? null : w.agent ? agentName : 'Shell', multiHost ? w.host : null].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {narrow ? (
          <>
            {reviewPill}
            <SubagentsPill w={w} onOpen={() => setSubagents({})} />
            {(w.fork?.parentTitle || (w.fork?.forks ?? 0) > 0) && (
              <button className="pill" onClick={() => setForksOpen(true)} title="Show the fork family">
                ⑂{w.fork!.forks > 0 ? ` ${w.fork!.forks}` : ''}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="session-pills">
              {spaceName && (
                <button type="button" className="pill" onClick={jumpToSpace} title={`Open ${spaceName} Space Portal`}>
                  {spaceName}
                </button>
              )}
              {w.supervision?.role === 'chief' && (
                <button
                  type="button"
                  className="pill chief-pill"
                  onClick={jumpToSpace}
                  title={w.supervision.space ? `Chief of Staff · ${w.supervision.space}` : 'Fleet-wide Chief of Staff'}
                >
                  Chief{chiefWorkers.length > 0 ? ` · ${chiefWorkers.length} ${chiefWorkers.length === 1 ? 'worker' : 'workers'}` : ''}
                </button>
              )}
              {chiefManager && (
                <button
                  type="button"
                  className="pill"
                  disabled={!onOpenKey}
                  onClick={() => onOpenKey?.(chiefManager.key)}
                  title={`Open supervising Chief (${chiefManager.title || chiefManager.name})`}
                >
                  ↳ {chiefManager.title || chiefManager.name}
                </button>
              )}
              <span key={statusClass(w)} className={`pill ${statusClass(w)} ${changed ? 'pill-change' : ''}`}>
                {w.status === 'waiting' && <span className="dot waiting" />} {statusWord(w)}
              </span>
              {multiHost && <span className="pill">{w.host}</span>}
              {w.recovery && (
                <span className={`pill ${w.recovery.state === 'needs_user' || w.recovery.state === 'failed' ? 'waiting' : ''}`} title={recoveryTitle(w.recovery)}>
                  ↻ {recoveryWord(w.recovery)}
                </span>
              )}
              {w.continued && (
                <button
                  className="pill"
                  disabled={!w.continued.fromUid || !onOpenKey}
                  onClick={() => w.continued?.fromUid && onOpenKey?.(keyOnThisHost(w.continued.fromUid))}
                  title={`Continued from “${w.continued.fromTitle}” in ${look(w.continued.fromHarness).name}${w.continued.kind === 'portable' ? ' (handed over as a record of the conversation)' : w.continued.kind === 'migration' ? ` (moved from ${w.continued.fromHost ?? 'another host'})` : ''}`}
                >
                  ↪ {w.continued.kind === 'migration' ? (w.continued.fromHost ?? 'another host') : look(w.continued.fromHarness).name}
                </button>
              )}
              <SubagentsPill w={w} onOpen={() => setSubagents({})} />
              {w.queued > 0 && (
                <button className="pill waiting" onClick={() => openPanel('queue')} title="Review queued messages">
                  ⇥ {w.queued} queued
                </button>
              )}
              {w.fork?.parentTitle && (
                <button className="pill" onClick={() => setForksOpen(true)} title="Show the fork family">
                  ⑂ fork of {w.fork.parentTitle}
                </button>
              )}
              {(w.fork?.forks ?? 0) > 0 && (
                <button className="pill" onClick={() => setForksOpen(true)} title="Show the fork family">
                  Forks ({w.fork!.forks})
                </button>
              )}
              {elsewhere && <span className="devices">On {elsewhere}</span>}
            </div>
            {/* Outside .session-pills: it clips overflow, which would cut off the dropdown. */}
            {w.branch && <BranchPicker client={client} uid={w.uid} current={w.branch} onSwitched={refresh} />}
            {w.branch && <PrLink client={client} uid={w.uid} branch={w.branch} />}
            {reviewPill}
          </>
        )}
        {/* The trailing controls share one glass capsule, as iOS and macOS 26 group a bar's buttons. */}
        <div className="nav-group">
          {w.terminal && <button className={`icon-btn terminal-indicator${w.terminal.busy ? ' busy' : ''}`} aria-label={w.terminal.busy ? 'Attached terminal active' : 'Open attached terminal'} title={w.terminal.busy ? `Terminal running ${w.terminal.command}` : 'Open attached terminal'} onClick={() => togglePanel('terminal')}><Icon name="terminal" size={15} />{w.terminal.busy && <span aria-hidden>●</span>}</button>}
          {views.length > 1 && (
            <div className={narrow ? 'view-toggle' : 'view-toggle labels'} role="group" aria-label="View">
              <Glide match="[aria-pressed='true']" className="thumb" />
              {views.map((v) => (
                narrow ? (
                  <button key={v} className={v === view ? 'on' : ''} aria-pressed={v === view} title={shortcutTitle(`${VIEW_LABEL[v]} view`, 'toggle-view')} onClick={() => switchView(v)}>
                    <Icon name={v === 'gui' ? 'chat' : 'terminal'} size={15} />
                  </button>
                ) : (
                  <button key={v} className={v === view ? 'on' : ''} aria-pressed={v === view} title={shortcutTitle(`${VIEW_LABEL[v]} view`, 'toggle-view')} onClick={() => switchView(v)}>
                    {VIEW_LABEL[v]}
                  </button>
                )
              ))}
            </div>
          )}
          {!narrow && (
            <button
              className="icon-btn"
              onClick={() => {
                if (panel && !panelCollapsed) setPanelCollapsed(true);
                else if (panel) setPanelCollapsed(false);
                else {
                  setPanel(lastPanel);
                  setPanelCollapsed(false);
                }
              }}
              aria-label="Toggle panel"
              aria-pressed={!!panel && !panelCollapsed}
              title={shortcutTitle(`Side panel: ${lastPanel}${w.queued > 0 ? ` (Queue ${w.queued})` : ''}`, 'toggle-panel')}
            >
              <Icon name={panel && !panelCollapsed ? 'panel-hide' : 'panel'} size={16} />
            </button>
          )}
          <div className="menu-wrap">
            <button ref={menuBtn} className="icon-btn" onClick={() => setMenu(!menu)} aria-label="More" title="More" aria-expanded={menu}>
              <Icon name="more" />
            </button>
            {menu &&
              createPortal(
                narrow ? (
                  <ActionSheet scrim={menuScrim} onClose={() => setMenu(false)}>
                    {menuBody}
                  </ActionSheet>
                ) : (
                  menuBody
                ),
                document.body,
              )}
          </div>
        </div>
      </header>

      {narrow && (
        <div className="seg-tabs" role="tablist" data-rove ref={tabRow}>
          <Glide match=".on" className="thumb" />
          {mobileTabs.map(([id, icon, label]) => (
            <button key={id} data-tab={id} role="tab" aria-selected={tab === id} aria-label={label} className={`tab-icon ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>
              <Icon name={icon} size={18} />
              <span className="tab-label">{label}</span>
              {id === 'queue' && w.queued > 0 && <span className="badge">{w.queued}</span>}
            </button>
          ))}
        </div>
      )}

      {(() => {
        const subSessions = w.supervision?.role === 'chief' ? hostWindows.filter((x) => x.supervision?.managedBy === w.uid) : [];
        const manager = w.supervision?.managedBy ? hostWindows.find((x) => x.uid === w.supervision!.managedBy) : undefined;
        if (!subSessions.length && !manager) return null;
        return (
          <div className="chief-subsessions-bar" aria-label={subSessions.length ? 'Managed sub-sessions' : 'Supervisor'}>
            {manager && (
              <div className="subsessions-group">
                <span className="subsessions-label">Managed by</span>
                <button
                  type="button"
                  className="worker-chip"
                  disabled={!onOpenKey}
                  onClick={() => onOpenKey?.(manager.key)}
                  title={`Open Chief ${manager.title || manager.name}`}
                >
                  <span className={`dot ${manager.status}`} />
                  <span>♛ {manager.title || manager.name}</span>
                </button>
              </div>
            )}
            {subSessions.length > 0 && (
              <div className="subsessions-group">
                <span className="subsessions-label">Sub-sessions ({subSessions.length})</span>
                {subSessions.map((sub) => (
                  <span key={sub.key} className="subsession-chip-wrap">
                    <button
                      type="button"
                      className="worker-chip"
                      disabled={!onOpenKey}
                      onClick={() => onOpenKey?.(sub.key)}
                      title={`Open ${sub.title || sub.name} (${sub.uid})`}
                    >
                      <span className={`dot ${sub.status}`} />
                      <span>{sub.title || sub.name}</span>
                    </button>
                    {view === 'gui' && (
                      <button
                        type="button"
                        className="subsession-mention-btn"
                        onClick={() => composer.current?.insert(`#${sub.uid}`)}
                        title={`Reference #${sub.uid} in chat`}
                        aria-label={`Reference ${sub.title || sub.name} in chat`}
                      >
                        #
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })()}
      </MobileOverlay>
      <div className="session-body" ref={body}>
        <div className={`session-main${floatGlass ? ' mobile-chat' : ''}`} {...fileDrop.handlers}>
          <Suspense fallback={<div className="surface" />}>
            <Surface
              key={`${view}:${w.key}`}
              ref={surface}
              w={w}
              client={client}
              hidden={tab !== 'main'}
              showKeys={showKeys}
              onAnswer={onAnswer}
              onReply={focusInput}
              onUseTerminal={() => switchView('terminal', true)}
              refresh={refresh}
              recent={recent}
              onResume={recent.length ? (h) => void resumeRecent(h) : undefined}
              snippetRun={snippetRun}
              onOpenSubagent={w.subagents ? openSubagent : undefined}
              hostSessions={hostWindows}
              onOpenSession={onOpenKey ? openHostSession : undefined}
            />
          </Suspense>
          {tab !== 'main' && <div className="session-main" style={{ minHeight: 0 }}>{panelView(tab)}</div>}
          {view === 'gui' && tab !== 'terminal' && (
            <MobileOverlay enabled={mobileGlass} edge="bottom" floating={floatGlass}>
            <ComposerBar ref={composer} compact={narrow || touchScreen} client={client} target={w.uid} agent={w.agent} w={w} onSent={onSent} onChange={refresh} focusKey={focus} active={active}
              sessions={hostWindows}
              onSettingsOpen={() => switchView('terminal', true)}
              onRelaunched={(uid) => {
                refresh();
                if (onOpenKey) onOpenKey(keyOnThisHost(uid));
              }} />
            </MobileOverlay>
          )}
          {fileDrop.over && <div className="drop-hint">Drop to attach to your message</div>}
        </div>

        {!narrow && panel && (panel === 'terminal' || panel === 'files' || panel === 'chat' || panel === 'queue' || panel === 'snapshots' || panel === 'preview' || panel === 'stack' || diffTab) && (
          <>
            {!panelCollapsed && <PanelDivider onResize={resizePanel} onReset={resetPanelWidth} />}
            {panelCollapsed ? (
              <div className="panel-rail">
                <button className="icon-btn small" onClick={() => setPanelCollapsed(false)} aria-label="Expand panel" title="Expand panel">
                  <Icon name="panel" size={14} />
                </button>
              </div>
            ) : (
              <aside className={`side-panel ${panelAtOpen.current ? '' : 'arrive'}`} style={{ width: panelWidth }}>
                <div className="tabs" data-rove>
                  {/* The tabs scroll sideways in a narrow panel; the buttons on the right always stay. */}
                  <div className="tabs-scroll">
                  <Glide match="[aria-selected='true']" className="underline" />
                  {/* Always the same tabs in the same order (agent-only ones absent for a shell): icons,
                      the open one with its label, so all six fit in the narrowest panel. */}
                  {(
                    [
                      ['terminal', 'terminal', terminalSupported],
                      ['diff', 'diff', diffTab],
                      // Beside Diff: both are about the branch.
                      ['stack', 'stack', stackTab],
                      ['files', 'files', true],
                      ['chat', 'sparkle', true],
                      ['queue', 'queue', turns],
                      ['snapshots', 'history', turns],
                      ['preview', 'globe', true],
                    ] as const
                  ).map(([id, icon, shown]) => {
                    if (!shown) return null;
                    const label = id === 'terminal' ? 'Terminal' : L(`panel-${id}`);
                    return (
                      <button
                        key={id}
                        role="tab"
                        aria-selected={panel === id}
                        aria-label={label}
                        title={shortcutTitle(label, `panel-${id}`)}
                        className="tab-underline tab-icon"
                        onClick={() => setPanel(id)}
                      >
                        <Icon name={icon} size={15} />
                        <span className="tab-label">{label}</span>
                        {id === 'queue' && w.queued > 0 && <span className="badge">{w.queued}</span>}
                      </button>
                    );
                  })}
                  </div>
                  {panel === 'chat' && (
                    <button
                      className="icon-btn small"
                      onClick={() => setChatHistory(!chatHistory)}
                      aria-label={chatHistory ? 'Back to current chat' : 'Past chats'}
                      aria-pressed={chatHistory}
                      title={chatHistory ? 'Back to current chat' : 'Past chats'}
                    >
                      <Icon name="history" size={14} />
                    </button>
                  )}
                  <button className="icon-btn small" onClick={() => closePanel(true)} aria-label="Collapse panel" title="Collapse panel">
                    <Icon name="panel-hide" size={14} />
                  </button>
                  <button className="icon-btn small" onClick={() => closePanel()} aria-label="Close panel" title="Close panel">
                    <Icon name="close" size={14} />
                  </button>
                </div>
                {panelView(panel)}
              </aside>
            )}
          </>
        )}
      </div>

      {capture !== null && <CaptureDialog text={capture} onClose={() => setCapture(null)} />}
      {movingSpace && (
        <MoveToSpaceDialog
          client={client}
          uid={w.uid}
          title={w.title || w.name}
          current={w.space ?? null}
          projectPath={w.projectPath}
          home={home}
          spaced={spaced}
          onClose={() => setMovingSpace(false)}
          onMoved={() => void refresh()}
        />
      )}
      {branching && w.branch && <BranchSheet client={client} uid={w.uid} branch={w.branch} onSwitched={refresh} onClose={() => setBranching(false)} />}
      <Suspense fallback={null}>
      {forking && (
        <ForkDialog client={client} target={{ ref: w.uid, host: w.host, harness: w.agent, title: w.title }} onClose={() => setForking(false)} onForked={forked} />
      )}
      {continuing && (
        <ContinueDialog
          client={client}
          target={{ ref: w.uid, host: w.host, harness: w.agent, title: w.title }}
          to={continuing}
          onClose={() => setContinuing(null)}
          onUnsupported={() => {
            const to = continuing;
            setContinuing(null);
            void continueHere(to);
          }}
          onContinued={(uid) => {
            setContinuing(null);
            refresh();
            if (onOpenKey) onOpenKey(keyOnThisHost(uid));
          }}
        />
      )}
      {sending && (
        <SendToDialog
          client={client}
          clientFor={clientFor}
          source={w}
          windows={windows}
          multiHost={multiHost}
          onClose={() => setSending(false)}
          onSent={onSent}
          onNewSession={(prompt) => onStartSession?.(prompt)}
        />
      )}
      {subagents && <SubagentsDialog w={w} client={client} open={subagents.open} onClose={() => setSubagents(null)} />}
      {forksOpen && (
        <ForksDialog
          client={client}
          w={w}
          onClose={() => setForksOpen(false)}
          onOpen={
            onOpenKey
              ? (key) => {
                  setForksOpen(false);
                  onOpenKey(key);
                }
              : undefined
          }
          onSplitWith={
            onSplitWith
              ? (key) => {
                  setForksOpen(false);
                  onSplitWith(key);
                }
              : undefined
          }
        />
      )}
      </Suspense>
    </>
  );
}

function CaptureDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { dismiss } = useSheet(ref, onClose);
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, []);
  return (
    <dialog ref={ref} className="dialog capture" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <SheetBar onClose={dismiss} />
      <div className="capture-head">
        <h2>Scrollback</h2>
        <button
          className="btn small"
          onClick={() =>
            navigator.clipboard
              ?.writeText(text.trimEnd())
              .then(() => setCopied(true))
              .catch(() => showNotice('Clipboard needs HTTPS', 'Select the text and copy it yourself.'))
          }
        >
          {copied ? 'Copied' : 'Copy all'}
        </button>
        <button className="btn ghost small desk-close" onClick={onClose}>
          Close
        </button>
      </div>
      <pre ref={pre}>{text.trimEnd()}</pre>
    </dialog>
  );
}

/** A recovery as a few words for the header pill. */
function recoveryWord(r: Recovery): string {
  const at = r.nextAttemptAt ?? r.resetsAt;
  const time = at ? new Date(at * 1000).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : null;
  switch (r.state) {
    case 'scheduled':
      return time ? `going on at ${time}` : 'going on soon';
    case 'waiting_capacity':
      return time ? `limited until ${time}` : 'limited';
    case 'resuming':
      return 'picking up';
    case 'needs_user':
      return r.reason === 'credentials' ? 'sign in again' : 'needs you';
    case 'failed':
      return 'kept failing';
    case 'stopped':
      return 'recovery paused';
    default:
      return r.reason === 'process_exit' ? 'stopped unexpectedly' : 'stopped';
  }
}

function recoveryTitle(r: Recovery): string {
  return `${r.evidence}${r.attempts ? `\nAttempts: ${r.attempts} of ${r.maxAttempts}` : ''}${r.auto ? '' : '\nAutomatic recovery is off for this session (session menu).'}`;
}
