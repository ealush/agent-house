import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeFloatingMenu } from './menuPlace.ts';
import { showError, showNotice } from './ask.tsx';
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
import { ShortcutHint, shortcutTitle, useCommand, useShortcutRevision } from './shortcuts.tsx';

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
  /** Send to… → New session. Opens the start dialog with this first message. */
  onStartSession?: (prompt: string) => void;
};

const STATUS_PILL = { waiting: 'Needs you', busy: 'Working', attention: 'Done', idle: 'Idle' };

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
      title="Drag to resize (double-click to reset)"
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

export function Session({ w, client, windows, clientFor, narrow, touch, multiHost, home, replyKey, onBack, onAnswer, onSent, onKilled, refresh, onSplit, onReplace, onClosePane, onOpenKey, onSplitWith, onStartSession, active = true }: Props) {
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
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // Past-chats browser inside the chat panel; resets with the session.
  const [chatHistory, setChatHistory] = useState(false);
  // A search result can ask for one chat at one message (issue #9).
  const [chatJump, setChatJump] = useState<{ uid: string; msgId: number } | null>(null);
  const [keysPref, setKeysPref] = stored<'auto' | 'on' | 'off'>('ah.keys', 'auto');
  const [viewPref, setViewPref] = stored<View>('ah.view', 'terminal');
  const [menu, setMenu] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  // The overflow menu is portalled to the body: split panes clip with
  // `.pane { overflow: hidden }`, which cut the menu off in short panes.
  useLayoutEffect(() => {
    if (!menu) {
      setMenuPos(null);
      return;
    }
    const anchor = menuBtn.current?.getBoundingClientRect();
    const body = menuEl.current?.getBoundingClientRect();
    if (!anchor || !body) return;
    setMenuPos(
      placeFloatingMenu(
        anchor,
        { width: body.width, height: body.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (menuEl.current?.contains(e.target as Node)) return;
      if (menuBtn.current?.contains(e.target as Node)) return;
      setMenu(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(false);
    };
    const onShift = () => setMenu(false);
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onShift);
    window.addEventListener('scroll', onShift, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onShift);
      window.removeEventListener('scroll', onShift, true);
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
  useEffect(() => {
    if (replyKey) {
      setTab('main');
      focusInput();
    }
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
  useCommand('approve', () => onAnswer(w, 'approve'), active && w.answerable && w.status === 'waiting');
  useCommand('deny', () => onAnswer(w, 'deny'), active && w.answerable && w.status === 'waiting');
  useCommand('reply', focusInput, active);

  const diffTab = w.branch ? 'Diff' : null;
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
          <span className="chip lg" style={{ '--agent': color } as React.CSSProperties}>
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
          <div className="view-toggle" role="group" aria-label="View">
            {views.map((v) => (
              <button key={v} className={v === view ? 'on' : ''} aria-pressed={v === view} title={shortcutTitle(`${VIEW_LABEL[v]} view`, 'toggle-view')} onClick={() => switchView(v)}>
                <Icon name={v === 'gui' ? 'chat' : 'terminal'} size={15} />
                {!narrow && <span>{VIEW_LABEL[v]}</span>}
              </button>
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
        {narrow && (
          <button className="icon-btn" onClick={() => window.location.reload()} aria-label="Reload page" title="Reload">
            <Icon name="recall" />
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
                className="menu"
                onMouseLeave={() => setMenu(false)}
                style={
                  menuPos
                    ? { position: 'fixed', right: 'auto', top: menuPos.top, left: menuPos.left, zIndex: 90, margin: 0 }
                    : { position: 'fixed', right: 'auto', visibility: 'hidden', zIndex: 90, margin: 0 }
                }
              >
              <button onClick={startRename}>Rename</button>
              <button
                onClick={() => {
                  setMenu(false);
                  setForking(true);
                }}
              >
                Fork session…
              </button>
              {w.feed && (
                <button
                  onClick={() => {
                    setMenu(false);
                    setSending(true);
                  }}
                >
                  Send to…
                </button>
              )}
              <button onClick={() => act(() => client.pin(w.uid, !w.pinned))}>{w.pinned ? 'Unpin' : 'Pin to top'}</button>
              {diffTab && <button onClick={() => { setMenu(false); openPanel('diff'); }}>Diff</button>}
              <button onClick={() => { setMenu(false); openPanel('files'); }}>Files</button>
              <button onClick={() => { setMenu(false); openPanel('chat'); }}>Chat</button>
              <button onClick={() => { setMenu(false); openPanel('queue'); }}>Queued messages ({w.queued})</button>
              <button onClick={() => { setMenu(false); openPanel('snapshots'); }}>Snapshots</button>
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
                </>
              )}
              {onReplace && (
                <button
                  onClick={() => {
                    setMenu(false);
                    onReplace();
                  }}
                >
                  Replace pane…
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
                  {showKeys ? 'Hide' : 'Show'} on-screen keys
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
                Terminate session
              </button>
              </div>,
              document.body,
            )}
        </div>
      </header>

      {narrow && (
        <div className="seg-tabs" role="tablist">
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
            <ComposerBar client={client} target={w.uid} agent={w.agent} w={w} onSent={onSent} focusKey={focus}
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
                <div className="tabs">
                  {diffTab && (
                    <button className={`tab ${panel === 'diff' ? 'on' : ''}`} onClick={() => setPanel('diff')}>
                      Diff
                    </button>
                  )}
                  <button className={`tab ${panel === 'files' ? 'on' : ''}`} onClick={() => setPanel('files')}>
                    Files
                  </button>
                  <button className={`tab ${panel === 'chat' ? 'on' : ''}`} onClick={() => setPanel('chat')}>
                    Chat
                  </button>
                  <button className={`tab ${panel === 'queue' ? 'on' : ''}`} onClick={() => setPanel('queue')}>
                    Queue{w.queued > 0 ? ` (${w.queued})` : ''}
                  </button>
                  <button className={`tab ${panel === 'snapshots' ? 'on' : ''}`} onClick={() => setPanel('snapshots')}>
                    Snapshots
                  </button>
                  <span className="spacer" />
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
