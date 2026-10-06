import { useEffect, useRef, useState } from 'react';
import { PresetsContext } from './ModelPicker.tsx';
import { deviceName, type HistoryItem, type SearchHit, type SendResult, type State, type Win } from './api.ts';
import { useHosts } from './useHosts.ts';
import { Sidebar, sortWindows, type Page } from './Sidebar.tsx';
import { cycleKey } from './keyboard.ts';
import { Inbox, type InboxGroup } from './Inbox.tsx';
import { HistoryView, SessionsView } from './HistoryView.tsx';
import { Session } from './Session.tsx';
import { Workspace } from './Workspace.tsx';
import { leaves, nodeAt, paneLeaves, parseLayout, replaceLeaf, splitLeaf, type LayoutNode, type Path } from './layout.ts';
import { NewDialog } from './NewDialog.tsx';
import { ForkDialog, type ForkTarget } from './ForkDialog.tsx';
import { Switcher } from './Switcher.tsx';
import { ChatSearchDialog } from './ChatHistory.tsx';
import { SearchView } from './SearchView.tsx';
import { WorktreesDialog } from './Git.tsx';
import { pushStatus, pushSupport, registerWorker } from './notify.ts';
import { API_VERSION } from './api.ts';
import { Settings } from './Settings.tsx';
import { showError } from './ask.tsx';
import { Icon } from './icons.tsx';
import { trackViewport } from './viewport.ts';

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

// URL hash: "#@12" (local session), "#<host>/@12" (peer session), "#history", "#sessions".
// "#security" still lands on settings, where Security lives now.
function fromHash(): { page: Page; selected: string | null } {
  let h = '';
  try { h = decodeURIComponent(location.hash.slice(1)); } catch {}
  if (h.includes('@')) return { page: 'inbox', selected: h };
  if (h === 'security') h = 'settings';
  if (h.startsWith('settings/')) h = 'settings';
  return { page: h === 'history' || h === 'sessions' || h === 'settings' || h === 'search' ? h : 'inbox', selected: null };
}

export function App({ onLock }: { onLock: () => void }) {
  const [{ page, selected }, setRoute] = useState(fromHash);
  const [inboxGroup, setInboxGroup] = stored<InboxGroup>('ah.inboxGroup', 'status');
  const [creating, setCreating] = useState<{ cwd?: string; host?: string } | null>(null);
  const [forking, setForking] = useState<ForkTarget | null>(null);
  const [switching, setSwitching] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [pastChatJump, setPastChatJump] = useState<{ host: string; uid: string; msgId: number } | null>(null);
  const [dialog, setDialog] = useState<'worktrees' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [replyKey, setReplyKey] = useState(0);
  const narrow = useMedia('(max-width: 760px)');
  const touch = useMedia('(pointer: coarse)');
  const [sideOpen, setSideOpen] = useState(() => {
    try {
      return localStorage.getItem('ah.side') !== '0';
    } catch {
      return true;
    }
  });
  // Split layout is device-local (F45): a 32" arrangement never follows you to a phone.
  const [layout, setLayoutState] = useState<LayoutNode | null>(() => {
    try {
      return parseLayout(JSON.parse(localStorage.getItem('ah.layout.v1') ?? 'null'));
    } catch {
      return null;
    }
  });
  const [focusPath, setFocusPath] = useState<Path | null>(null);
  const focused = layout ? nodeAt(layout, focusPath ?? []) : null;
  const focusKey = focused?.type === 'session' ? focused.sessionKey : null;
  // Every pane on screen, so the sidebar can mark them all (split view shows several at once).
  const visibleKeys = layout ? leaves(layout) : selected ? [selected] : [];
  const pushActive = useRef(false);
  const prevStatus = useRef(new Map<string, string>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const { state, error, refresh, clientFor, hostState } = useHosts((s: State) => announce(s.windows));

  function toggleSide() {
    setSideOpen((v) => {
      try {
        localStorage.setItem('ah.side', v ? '0' : '1');
      } catch {}
      return !v;
    });
  }

  function setLayout(next: LayoutNode | null) {
    setLayoutState(next);
    const at = next && focusPath ? nodeAt(next, focusPath) : null;
    if (!next) setFocusPath(null);
    else if (at?.type === 'split') setFocusPath([...focusPath!, ...paneLeaves(at)[0].path]);
    else if (!at) setFocusPath(paneLeaves(next)[0].path);
    try {
      if (next) localStorage.setItem('ah.layout.v1', JSON.stringify(next));
      else localStorage.removeItem('ah.layout.v1');
    } catch {}
  }

  function go(next: { page?: Page; selected?: string | null }) {
    const route = { page: next.page ?? page, selected: next.selected === undefined ? selected : next.selected };
    setRoute(route);
    const hash = route.selected ?? (route.page === 'inbox' ? '' : route.page);
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
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

  /** Option+Up/Down in a terminal steps through sessions in sidebar order. */
  const cycleSession = (dir: -1 | 1) => {
    const keys = sortWindows(state?.windows ?? []).map((w) => w.key);
    const next = cycleKey(keys, focusKey ?? selected, dir);
    if (next) open(next);
  };

  /** Enter split view from the single session: the new half shows the most recent other session. */
  function splitFrom(key: string, dir: 'right' | 'below', otherKey?: string) {
    const other = otherKey ?? state?.windows.find((w) => w.key !== key)?.key ?? key;
    setLayout(splitLeaf({ type: 'session', sessionKey: key }, key, dir === 'right' ? 'horizontal' : 'vertical', other));
    setFocusPath(['first']);
  }

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }

  // In-page notifications are the fallback when Web Push isn't on (plain http).
  function announce(windows: Win[]) {
    const prev = prevStatus.current;
    for (const w of windows) {
      const was = prev.get(w.key);
      const alerting = w.status === 'waiting' || (w.status === 'attention' && was === 'busy');
      if (was && was !== w.status && alerting && !pushActive.current && 'Notification' in window && Notification.permission === 'granted') {
        if (document.hidden || w.key !== selectedRef.current) {
          const n = new Notification(w.status === 'waiting' ? `${w.title} needs you` : `${w.title} finished`, { body: `${w.project} · ${w.agent ?? w.command}`, tag: w.key, icon: '/icon-512.png' });
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
  }

  useEffect(() => {
    const onHash = () => setRoute(fromHash()); // e.g. opened from a push notification
    window.addEventListener('hashchange', onHash);
    if (pushSupport() === 'ok') {
      registerWorker();
      pushStatus()
        .then((e) => (pushActive.current = !!e))
        .catch(() => {});
    }
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // ⌘K / Ctrl+Shift+K opens the switcher. Captured before xterm so the shell never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog.ask[open]')) return;
      if (e.key.toLowerCase() === 'k' && ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        setSwitching((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Fill the screen normally; shrink only while the software keyboard is open.
  useEffect(() => trackViewport(window, document), []);

  const current = state?.windows.find((w) => w.key === selected) ?? null;
  // A session killed elsewhere: fall back to where we were (split panes show an ended state instead).
  useEffect(() => {
    if (state && selected && !current && !layout) open(null);
  }, [state, selected, current]);

  const keyFor = (host: string, id: string) => (host === state?.hostname ? id : `${host}/${id}`);

  async function answer(w: Win, a: 'approve' | 'deny') {
    try {
      await clientFor(w.host).answer(w.uid, a);
      flash(a === 'approve' ? `Approved · ${w.title}` : `Denied · ${w.title}`);
    } catch (e) {
      flash((e as Error).message);
    }
    refresh(w.host);
  }

  async function resume(host: string, ref: string) {
    try {
      const out = await clientFor(host).resume(ref);
      await refresh(host);
      open(keyFor(host, out.id));
      if (out.resumed) flash('Resuming…');
    } catch (e) {
      showError(e, "Couldn't resume");
    }
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
      open(keyFor(host, out.id));
      if (out.resumed) flash('Resuming…');
    } catch (e) {
      showError(e, "Couldn't open that session");
    }
  }

  function sent(r: SendResult) {
    if (r.outcome === 'delivered') flash('Sent');
    else flash(r.resumed ? 'Resuming the session; your message goes in once it is ready' : `Queued (${r.queued}) — sent when the agent is free`);
    refresh(current?.host);
  }

  async function shellIn(path: string) {
    setDialog(null);
    const host = current?.host ?? state?.hostname ?? '';
    try {
      const out = await clientFor(host).create({ preset: 'shell', cwd: path, session: current?.session ?? state?.defaultSession ?? '', label: '', resume: false });
      await refresh(host);
      open(keyFor(host, out.id));
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

  return (
    <PresetsContext.Provider value={presetFor}>
    <div className={`app ${narrow ? 'narrow' : ''}`}>
      {sideOpen ? (
        <Sidebar
          state={state}
          error={error}
          page={page}
          selected={focusKey ?? selected}
          visibleKeys={visibleKeys}
          device={deviceName()}
          onCollapse={toggleSide}
          onPage={(p) => {
            setLayout(null);
            setFocusPath(null);
            go({ page: p, selected: null });
          }}
          onSelect={open}
          onSearch={() => setSwitching(true)}
          onNew={(where) => setCreating(where ?? {})}
          onWorktrees={() => setDialog('worktrees')}
          onReorder={(uid, host, order) => {
            clientFor(host)
              .order(uid, order)
              .catch((e) => flash((e as Error).message));
            refresh(host);
          }}
          onKill={(w) => {
            clientFor(w.host)
              .kill(w.id)
              .then(() => refresh(w.host))
              .catch((e) => showError(e, "Couldn't terminate"));
          }}
          onRunAction={(host, runId, action) => {
            const client = clientFor(host);
            (action === 'stop' ? client.stopRun(runId) : client.archiveRun(runId))
              .then(() => refresh(host))
              .catch((e) => showError(e, action === 'stop' ? "Couldn't stop the run" : "Couldn't archive the run"));
          }}
        />
      ) : (
        !narrow && (
          <div className="rail">
            <button className="icon-btn" onClick={toggleSide} title="Show sidebar" aria-label="Show sidebar">
              <Icon name="panel" />
            </button>
          </div>
        )
      )}

      <main className="main">
        {state && (state.api ?? 0) < API_VERSION && (
          <div className="stale-banner">
            This page is newer than the running ah server. Restart it (<code>pnpm serve</code>) to finish updating.
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
            onKilledSession={() => {}}
            refresh={refresh}
            onExit={() => {
              setLayout(null);
              setFocusPath(null);
            }}
          />
        ) : current && state ? (
          <Session
            key={current.key}
            w={current}
            client={clientFor(current.host)}
            narrow={narrow}
            touch={touch}
            multiHost={state.hosts.length > 1}
            home={hostState(current.host)?.home ?? state.home}
            replyKey={replyKey}
            onBack={() => open(null)}
            onAnswer={answer}
            onSent={sent}
            onKilled={() => open(null)}
            refresh={() => refresh(current.host)}
            onSplit={(dir) => splitFrom(current.key, dir)}
            onOpenKey={open}
            onCycleSession={cycleSession}
            onSplitWith={(key) => splitFrom(current.key, 'right', key)}
          />
        ) : state ? (
          <>
            {page === 'search' ? (
              <SearchView key={searchQuery} initialQuery={searchQuery} client={clientFor(state.hostname)} onOpenHit={openSearchHit} />
            ) : page === 'settings' ? (
              <Settings onLocked={onLock} onNotifyChange={(on) => (pushActive.current = on)} />
            ) : page === 'history' ? (
              <HistoryView
                state={state}
                onResume={(h) => resume(h.host, h.ref)}
                onForget={forget}
                onFork={(h) => setForking({ ref: h.ref, host: h.host, harness: h.harness, title: h.title })}
              />
            ) : page === 'sessions' && narrow ? (
              <SessionsView state={state} onOpen={(w) => open(w.key)} onNew={() => setCreating({})} />
            ) : (
              <Inbox
                state={state}
                narrow={narrow}
                groupBy={inboxGroup}
                setGroupBy={setInboxGroup}
                onOpen={(w, reply) => {
                  open(w.key);
                  if (reply) setReplyKey((n) => n + 1);
                }}
                onAnswer={answer}
                onNew={() => setCreating({})}
                onSearch={() => setSwitching(true)}
                onSettings={() => go({ page: 'settings', selected: null })}
              />
            )}
            {narrow && (
              <nav className="tabbar">
                {(['inbox', 'sessions', 'history'] as const).map((p) => (
                  <button key={p} className={page === p ? 'on' : ''} onClick={() => go({ page: p, selected: null })}>
                    {p[0].toUpperCase() + p.slice(1)}
                    {p === 'inbox' && waiting > 0 && <span className="badge">{waiting}</span>}
                  </button>
                ))}
              </nav>
            )}
          </>
        ) : (
          <div className="page">
            <p className="hint">{error ? `Can't reach the server: ${error}` : 'Connecting…'}</p>
          </div>
        )}
      </main>

      {creating && state && (
        <NewDialog
          hosts={state.hosts.filter((h) => h.online).map((h) => h.name)}
          initialHost={creating.host ?? current?.host ?? state.hostname}
          hostState={hostState}
          clientFor={clientFor}
          initialCwd={creating.cwd ?? current?.projectPath ?? '~'}
          onClose={() => setCreating(null)}
          onCreated={async (host, id) => {
            setCreating(null);
            await refresh(host);
            open(keyFor(host, id));
          }}
        />
      )}

      {forking && state && (
        <ForkDialog
          client={clientFor(forking.host)}
          target={forking}
          onClose={() => setForking(null)}
          onForked={async (id) => {
            const host = forking.host;
            setForking(null);
            await refresh(host);
            open(keyFor(host, id));
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
            open(key);
          }}
          onResume={(host, ref) => {
            setSwitching(false);
            resume(host, ref);
          }}
          onContent={(host, hit) => void openSearchHit(host, hit)}
          onShowAll={(text) => {
            setSwitching(false);
            setSearchQuery(text);
            setLayout(null);
            setFocusPath(null);
            go({ page: 'search', selected: null });
          }}
          onClose={() => setSwitching(false)}
        />
      )}

      {pastChatJump && <ChatSearchDialog key={`${pastChatJump.host}:${pastChatJump.uid}:${pastChatJump.msgId}`} client={clientFor(pastChatJump.host)} jump={pastChatJump} onClose={() => setPastChatJump(null)} />}

      {dialog === 'worktrees' && <WorktreesDialog client={clientFor(current?.host)} onClose={() => setDialog(null)} onShell={shellIn} />}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
    </PresetsContext.Provider>
  );
}
