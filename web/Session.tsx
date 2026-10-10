import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuViewport, placeFloatingMenu } from './menuPlace.ts';
import { askConfirm, showError, showNotice } from './ask.tsx';
import { copyText } from './selection.ts';
import { focusFirst } from './rove.ts';
import { confirmTerminate } from './Sidebar.tsx';
import { Icon } from './icons.tsx';
import { deviceName, type HostApi, type SendResult, type Win } from './api.ts';
import { look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { SURFACES, VIEW_LABEL, viewsFor, type SurfaceHandle, type View } from './surface.ts';
import { ComposerBar } from './Composer.tsx';
import { BranchPicker, ChangesPanel, PrLink } from './Git.tsx';
import { SideChat } from './SideChat.tsx';
import { ChatHistory } from './ChatHistory.tsx';
import { FilesPanel } from './Files.tsx';
import { QueuePanel } from './Queue.tsx';
import { ForkDialog, ForksDialog } from './ForkDialog.tsx';
import { SendToDialog } from './SendToDialog.tsx';
import { SnapshotsPanel } from './Snapshots.tsx';
import { ShortcutHint, shortcutTitle, useCommand, usePaletteProvider, useShortcutRevision } from './shortcuts.tsx';
import { runCommand } from './shortcuts.ts';
import { useLaunch, useLaunchPalette } from './useLaunch.ts';

type Panel = 'diff' | 'files' | 'chat' | 'queue' | 'snapshots';

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
  onSent: (r: SendResult) => void;
  onKilled: () => void;
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
  /** Send to… → New session. Opens the start dialog with this first message. */
  onStartSession?: (prompt: string) => void;
};

const STATUS_PILL = { waiting: 'Needs you', busy: 'Working', attention: 'Done', idle: 'Idle' };

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

export function Session({ w, client, windows, clientFor, narrow, touch, multiHost, home, replyKey, onBack, onAnswer, onSent, onKilled, refresh, onSplit, onReplace, onClosePane, onFlipSplit, panePath, onPaneDrag, onOpenKey, onSplitWith, onStartSession, active = true }: Props) {
  const surface = useRef<SurfaceHandle>(null);
  const body = useRef<HTMLDivElement>(null);
  // 'main' is the session itself, drawn by whichever surface is chosen.
  const [tab, setTab] = useState<'main' | Panel>('main');
  const [panel, setPanel] = stored<Panel | ''>('ah.panel', '');
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
  // Past-chats browser inside the chat panel; resets with the session.
  const [chatHistory, setChatHistory] = useState(false);
  // A search result can ask for one chat at one message (issue #9).
  const [chatJump, setChatJump] = useState<{ uid: string; msgId: number } | null>(null);
  const [keysPref, setKeysPref] = stored<'auto' | 'on' | 'off'>('ah.keys', 'auto');
  const [viewPref, setViewPref] = stored<View>('ah.view', 'terminal');
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

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
      const body = el.getBoundingClientRect();
      const next = {
        ...placeFloatingMenu(anchor, { width: body.width, height: body.height }, view),
        maxHeight,
      };
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
  const [sending, setSending] = useState(false);
  const [forksOpen, setForksOpen] = useState(false);
  const [capture, setCapture] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const { color, name: agentName } = look(w.agent);
  const modelLabel = shortModel(w.model);

  const abs = (p: string) => (p.startsWith('~') ? home + p.slice(1) : p);
  const views = viewsFor(w);
  const view: View = views.includes(viewPref) ? viewPref : 'terminal';
  const Surface = SURFACES[view];

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
  const showKeys = (keysPref === 'on' || (keysPref === 'auto' && touch)) && tab === 'main' && view === 'terminal';
  const elsewhere = others(w.devices);

  /** Switch surfaces; the next one mounts fresh, so focus waits a frame. */
  const switchView = (next: View, focusAfter = false) => {
    setViewPref(next);
    setTab('main');
    if (focusAfter) requestAnimationFrame(() => requestAnimationFrame(() => surface.current?.focus()));
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

  async function commitRename() {
    const name = nameDraft.trim();
    if (nameSaving) return;
    if (!name || name === w.name) {
      setRenaming(false);
      return;
    }
    setNameSaving(true);
    try {
      await client.rename(w.id, name);
    } catch (e) {
      showError(e, "Couldn't rename");
      setNameSaving(false);
      return;
    }
    setNameSaving(false);
    setRenaming(false);
    refresh();
  }

  const cancelRename = () => {
    renameCancelled.current = true;
    setRenaming(false);
  };

  // Terminate kills the tmux window; stronger wording while it is working,
  // waiting, or holding queued prompts (F44).
  const kill = () =>
    act(async () => {
      if (!(await confirmTerminate(w))) return;
      await client.kill(w.id);
      onKilled();
    });

  const comment = async (text: string) => onSent(await client.send(w.uid, text, true));

  // Window keys are the window id, host-prefixed for peers; a fork on this host
  // shares the prefix of the session it was forked from.
  const keyOnThisHost = (id: string) => w.key.slice(0, w.key.length - w.id.length) + id;
  const forked = (id: string) => {
    setForking(false);
    refresh();
    if (onOpenKey) onOpenKey(keyOnThisHost(id));
    else window.dispatchEvent(new CustomEvent('ah:toast', { detail: 'Fork started; find it in the sidebar' }));
  };

  useShortcutRevision();
  const diffTab = w.branch ? 'Diff' : null;
  // Desktop only: a phone would pop the software keyboard every time a session opens.
  // Two frames, because the GUI surface is lazy and the ref is empty on the first.
  useEffect(() => {
    if (!active || touch) return;
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => surface.current?.focus());
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [active, w.key, touch]);
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
      })().catch((e) => showError(e, "Couldn't send now")),
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
  useCommand('fork', () => setForking(true), active);
  useCommand('send-to', () => setSending(true), active && !!w.feed);
  useCommand('pin', () => void act(() => client.pin(w.uid, !w.pinned)), active);
  const togglePanel = (p: Panel) => {
    if (narrow) setTab(tab === p ? 'main' : p);
    else openPanel(p);
  };
  useCommand('panel-diff', () => togglePanel('diff'), active && !!diffTab);
  useCommand('panel-files', () => togglePanel('files'), active);
  useCommand('panel-chat', () => togglePanel('chat'), active);
  useCommand('panel-queue', () => togglePanel('queue'), active);
  useCommand('panel-snapshots', () => togglePanel('snapshots'), active);
  useCommand('copy-last', () => surface.current?.copyLast?.(), active && view === 'gui');
  useCommand('jump-latest', () => surface.current?.jumpLatest?.(), active && view === 'gui');
  useCommand('browse-messages', () => void surface.current?.browse?.(), active && view === 'gui');

  // Model and effort in the terminal view (the GUI's composer covers its own view).
  const launch = useLaunch({
    client,
    w,
    agent: w.agent,
    onNotice: onToast,
    onSent,
    onRelaunched: (id) => {
      refresh();
      onOpenKey?.(keyOnThisHost(id));
    },
  });
  useLaunchPalette(launch, active && view !== 'gui' && !!w.agent);
  const terminalPicker = (setting: 'model' | 'effort') =>
    launch.preset?.settingsCommands?.[setting] ? launch.openSettings(setting) : onToast(`Palette → Session → Model and effort lists the ${setting === 'model' ? 'models' : 'effort levels'}`);
  useCommand('pick-model', () => void terminalPicker('model'), active && view !== 'gui' && !!w.agent);
  useCommand('pick-effort', () => void terminalPicker('effort'), active && view !== 'gui' && !!w.agent);
  useCommand('scrollback', () => void act(async () => setCapture(await client.capture(w.id))), active);
  useCommand(
    'copy-attach',
    () =>
      void copyText(`ah attach ${w.uid}`).then((ok) => onToast(ok ? `Copied “ah attach ${w.uid}”` : "Couldn't copy")),
    active,
  );
  useCommand('toggle-keys', () => setKeysPref(showKeys ? 'off' : 'on'), active && view === 'terminal');
  useCommand('session-menu', () => setMenu(true), active);

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
                await client.clearQueue(w.uid, item.id);
                if (view !== 'gui') switchView('gui');
                requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('ah:compose', { detail: { uid: w.uid, text: item.text } })));
              }, 'Back in the composer'),
            },
            { key: 'cancel', label: 'Cancel', icon: 'close' as const, detail: 'Drop this message', run: act(() => client.clearQueue(w.uid, item.id), 'Cancelled') },
          ],
        };
      });
    },
    active && w.queued > 0,
  );

  const panelView = (p: Panel) =>
    p === 'queue' ? (
      <QueuePanel client={client} uid={w.uid} onChange={refresh} />
    ) : p === 'snapshots' ? (
      <SnapshotsPanel client={client} w={w} onChange={refresh} />
    ) : p === 'diff' ? (
      <ChangesPanel client={client} windowId={w.id} onComment={w.agent ? comment : undefined} />
    ) : p === 'chat' ? (
      chatHistory ? <ChatHistory client={client} jump={chatJump} /> : <SideChat client={client} w={w} onSent={onSent} />
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

  return (
    <>
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
            <span className="eyebrow">
              {w.project}
              {w.agent ? ` · ${agentName}` : ''}
              {modelLabel ? ` · ${modelLabel}` : ''}
              {w.launch ? ` · ${w.launch}` : ''}
            </span>
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
              {w.title}
            </button>
          )}
          {narrow && (
            <span className="eyebrow">
              {[w.agent ? agentName : w.cwd, multiHost ? w.host : null, elsewhere ? `also open on ${elsewhere}` : null].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {narrow ? (
          <>
            <span className={`pill ${w.status}`}>{w.status === 'busy' && !w.agent ? 'Live' : STATUS_PILL[w.status]}</span>
            {(w.fork?.parentTitle || (w.fork?.forks ?? 0) > 0) && (
              <button className="pill" onClick={() => setForksOpen(true)} title="Show the fork family">
                ⑂{w.fork!.forks > 0 ? ` ${w.fork!.forks}` : ''}
              </button>
            )}
          </>
        ) : (
          <>
            <div className="session-pills">
              <span className={`pill ${w.status}`}>
                {w.status === 'waiting' && <span className="dot waiting" />} {STATUS_PILL[w.status]}
              </span>
              {multiHost && <span className="pill mono">{w.host}</span>}
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
            {w.branch && <BranchPicker client={client} windowId={w.id} current={w.branch} onSwitched={refresh} />}
            {w.branch && <PrLink client={client} windowId={w.id} branch={w.branch} />}
          </>
        )}
        {views.length > 1 && (
          <div className={narrow ? 'view-toggle' : 'view-tabs'} role="group" aria-label="View">
            {views.map((v) => (
              narrow ? (
                <button key={v} className={v === view ? 'on' : ''} aria-pressed={v === view} title={shortcutTitle(`${VIEW_LABEL[v]} view`, 'toggle-view')} onClick={() => switchView(v)}>
                  <Icon name={v === 'gui' ? 'chat' : 'terminal'} size={15} />
                </button>
              ) : (
                <button key={v} className="tab-underline" aria-pressed={v === view} title={shortcutTitle(`${VIEW_LABEL[v]} view`, 'toggle-view')} onClick={() => switchView(v)}>
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
            title={shortcutTitle(`Panel: ${lastPanel}${w.queued > 0 ? ` (Queue ${w.queued})` : ''}`, 'toggle-panel')}
          >
            <Icon name={panel && !panelCollapsed ? 'panel-hide' : 'panel'} size={16} />
          </button>
        )}
        <div className="menu-wrap">
          <button ref={menuBtn} className="icon-btn" onClick={() => setMenu(!menu)} aria-label="More" aria-expanded={menu}>
            <Icon name="more" />
          </button>
          {menu &&
            createPortal(
              <div
                ref={menuEl}
                data-rove
                role="menu"
                className="menu"
                onPointerLeave={(e) => {
                  if (e.pointerType === 'touch') return;
                  setMenu(false);
                }}
                style={
                  menuPos
                    ? { position: 'fixed', right: 'auto', top: menuPos.top, left: menuPos.left, maxHeight: menuPos.maxHeight, zIndex: 90, margin: 0 }
                    : { position: 'fixed', right: 'auto', visibility: 'hidden', zIndex: 90, margin: 0 }
                }
              >
              <button onClick={startRename}><span className="grow">Rename</span><ShortcutHint id="rename" /></button>
              <button
                onClick={() => {
                  setMenu(false);
                  setForking(true);
                }}
              >
                <span className="grow">Fork session…</span>
                <ShortcutHint id="fork" />
              </button>
              {w.feed && (
                <button
                  onClick={() => {
                    setMenu(false);
                    setSending(true);
                  }}
                >
                  <span className="grow">Send to…</span>
                  <ShortcutHint id="send-to" />
                </button>
              )}
              <button onClick={() => act(() => client.pin(w.uid, !w.pinned))}>{w.pinned ? 'Unpin' : 'Pin to top'}</button>
              {diffTab && <button onClick={() => { setMenu(false); togglePanel('diff'); }}><span className="grow">Diff</span><ShortcutHint id="panel-diff" /></button>}
              <button onClick={() => { setMenu(false); togglePanel('files'); }}><span className="grow">Files</span><ShortcutHint id="panel-files" /></button>
              <button onClick={() => { setMenu(false); togglePanel('chat'); }}><span className="grow">Chat</span><ShortcutHint id="panel-chat" /></button>
              <button onClick={() => { setMenu(false); togglePanel('queue'); }}><span className="grow">Queued messages ({w.queued})</span><ShortcutHint id="panel-queue" /></button>
              {w.queued > 0 && <button onClick={() => { setMenu(false); runCommand('send-now'); }}><span className="grow">Send next queued now</span><ShortcutHint id="send-now" /></button>}
              <button onClick={() => { setMenu(false); togglePanel('snapshots'); }}><span className="grow">Snapshots</span><ShortcutHint id="panel-snapshots" /></button>
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
              <button
                onClick={() =>
                  act(async () => {
                    setCapture(await client.capture(w.id));
                  })
                }
              >
                Scrollback as text
              </button>
              {view === 'terminal' && (
                <button
                  onClick={() => {
                    setKeysPref(showKeys ? 'off' : 'on');
                    setMenu(false);
                  }}
                >
                  <span className="grow">{showKeys ? 'Hide' : 'Show'} on-screen keys</span>
                  <ShortcutHint id="toggle-keys" />
                </button>
              )}
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(`ah attach ${w.uid}`).catch(() => {});
                  setMenu(false);
                }}
              >
                Copy “ah attach {w.uid}”
              </button>
              <hr />
              <button className="danger" onClick={kill}>
                <span className="grow">Terminate session</span>
                <ShortcutHint id="terminate" />
              </button>
              </div>,
              document.body,
            )}
        </div>
      </header>

      {narrow && (
        <div className="seg-tabs" role="tablist" data-rove>
          <button role="tab" aria-selected={tab === 'main'} className={tab === 'main' ? 'on' : ''} onClick={() => setTab('main')}>
            {VIEW_LABEL[view]}
          </button>
          {diffTab && (
            <button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
              Diff
            </button>
          )}
          <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
            Files
          </button>
          <button role="tab" aria-selected={tab === 'chat'} className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>
            Chat
          </button>
          <button role="tab" aria-selected={tab === 'queue'} className={tab === 'queue' ? 'on' : ''} onClick={() => setTab('queue')}>
            Queue{w.queued > 0 ? ` (${w.queued})` : ''}
          </button>
          <button role="tab" aria-selected={tab === 'snapshots'} className={tab === 'snapshots' ? 'on' : ''} onClick={() => setTab('snapshots')}>
            Snapshots
          </button>
        </div>
      )}

      <div className="session-body" ref={body}>
        <div className="session-main">
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
            />
          </Suspense>
          {tab !== 'main' && <div className="session-main" style={{ minHeight: 0 }}>{panelView(tab)}</div>}
          {view === 'gui' && (
            <ComposerBar client={client} target={w.uid} agent={w.agent} w={w} onSent={onSent} focusKey={focus} active={active}
              onSettingsOpen={() => switchView('terminal', true)}
              onRelaunched={(id) => {
                refresh();
                if (onOpenKey) onOpenKey(keyOnThisHost(id));
              }} />
          )}
        </div>

        {!narrow && panel && (panel === 'files' || panel === 'chat' || panel === 'queue' || panel === 'snapshots' || diffTab) && (
          <>
            {!panelCollapsed && <PanelDivider onResize={resizePanel} onReset={resetPanelWidth} />}
            {panelCollapsed ? (
              <div className="panel-rail">
                <button className="icon-btn small" onClick={() => setPanelCollapsed(false)} aria-label="Expand panel" title="Expand panel">
                  <Icon name="panel" size={14} />
                </button>
              </div>
            ) : (
              <aside className="side-panel" style={{ width: panelWidth }}>
                <div className="tabs" data-rove>
                  {/* The tabs scroll sideways in a narrow panel; the buttons on the right always stay. */}
                  <div className="tabs-scroll">
                  {diffTab && (
                    <button role="tab" aria-selected={panel === 'diff'} className="tab-underline" onClick={() => setPanel('diff')}>
                      Diff
                    </button>
                  )}
                  <button role="tab" aria-selected={panel === 'files'} className="tab-underline" onClick={() => setPanel('files')}>
                    Files
                  </button>
                  <button role="tab" aria-selected={panel === 'chat'} className="tab-underline" onClick={() => setPanel('chat')}>
                    Chat
                  </button>
                  <button role="tab" aria-selected={panel === 'queue'} className="tab-underline" onClick={() => setPanel('queue')}>
                    Queue{w.queued > 0 ? ` (${w.queued})` : ''}
                  </button>
                  <button role="tab" aria-selected={panel === 'snapshots'} className="tab-underline" onClick={() => setPanel('snapshots')}>
                    Snapshots
                  </button>
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
                  <button className="icon-btn small" onClick={() => setPanelCollapsed(true)} aria-label="Collapse panel" title="Collapse panel">
                    <Icon name="panel-hide" size={14} />
                  </button>
                  <button className="icon-btn small" onClick={() => setPanel('')} aria-label="Close panel">
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
      {forking && (
        <ForkDialog client={client} target={{ ref: w.uid, host: w.host, harness: w.agent, title: w.title }} onClose={() => setForking(false)} onForked={forked} />
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
    </>
  );
}

function CaptureDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
    pre.current?.scrollTo(0, pre.current.scrollHeight);
  }, []);
  return (
    <dialog ref={ref} className="dialog capture" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
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
        <button className="btn ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <pre ref={pre}>{text.trimEnd()}</pre>
    </dialog>
  );
}
