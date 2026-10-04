import { useEffect, useRef, useState } from 'react';
import { deviceName, type HistoryItem, type SendResult, type State, type Win } from './api.ts';
import { useHosts } from './useHosts.ts';
import { Sidebar, type Page } from './Sidebar.tsx';
import { Inbox, type InboxGroup } from './Inbox.tsx';
import { HistoryView, SessionsView } from './HistoryView.tsx';
import { Session } from './Session.tsx';
import { NewDialog } from './NewDialog.tsx';
import { Switcher } from './Switcher.tsx';
import { WorktreesDialog } from './Git.tsx';
import { NotifyDialog } from './NotifyDialog.tsx';
import { pushStatus, pushSupport, registerWorker } from './notify.ts';
import { API_VERSION } from './api.ts';
import { Security } from './Security.tsx';
import { Icon } from './icons.tsx';

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
function fromHash(): { page: Page; selected: string | null } {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.includes('@')) return { page: 'inbox', selected: h };
  return { page: h === 'history' || h === 'sessions' || h === 'security' ? h : 'inbox', selected: null };
}

export function App({ onLock }: { onLock: () => void }) {
  const [{ page, selected }, setRoute] = useState(fromHash);
  const [inboxGroup, setInboxGroup] = stored<InboxGroup>('ah.inboxGroup', 'status');
  const [creating, setCreating] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [dialog, setDialog] = useState<'worktrees' | 'notify' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [replyKey, setReplyKey] = useState(0);
  const narrow = useMedia('(max-width: 760px)');
  const touch = useMedia('(pointer: coarse)');
  const pushActive = useRef(false);
  const prevStatus = useRef(new Map<string, string>());
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const { state, error, refresh, clientFor, hostState } = useHosts((s: State) => announce(s.windows));

  function go(next: { page?: Page; selected?: string | null }) {
    const route = { page: next.page ?? page, selected: next.selected === undefined ? selected : next.selected };
    setRoute(route);
    const hash = route.selected ?? (route.page === 'inbox' ? '' : route.page);
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
  }
  const open = (key: string | null) => go({ selected: key });

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
      if (e.key.toLowerCase() === 'k' && ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        setSwitching((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Keep the layout pinned to the visual viewport so the iOS keyboard doesn't cover the input.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty('--vh', `${vv.height}px`);
    set();
    vv.addEventListener('resize', set);
    return () => vv.removeEventListener('resize', set);
  }, []);

  const current = state?.windows.find((w) => w.key === selected) ?? null;
  // A session killed elsewhere: fall back to where we were.
  useEffect(() => {
    if (state && selected && !current) open(null);
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
      alert((e as Error).message);
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
      alert((e as Error).message);
    }
  }

  async function enableNotify() {
    if (pushSupport() === 'ok') setDialog('notify');
    else if ('Notification' in window) await Notification.requestPermission();
  }

  const waiting = state?.windows.filter((w) => w.status === 'waiting').length ?? 0;
  const forget = async (h: HistoryItem) => {
    await clientFor(h.host)
      .forget(h.ref)
      .catch((e) => alert(e.message));
    refresh(h.host);
  };

  return (
    <div className={`app ${narrow ? 'narrow' : ''}`}>
      <Sidebar
        state={state}
        error={error}
        page={page}
        selected={selected}
        device={deviceName()}
        onPage={(p) => go({ page: p, selected: null })}
        onSelect={open}
        onSearch={() => setSwitching(true)}
        onNew={() => setCreating(true)}
        onWorktrees={() => setDialog('worktrees')}
        onNotify={'Notification' in window ? enableNotify : null}
      />

      <main className="main">
        {state && (state.api ?? 0) < API_VERSION && (
          <div className="stale-banner">
            This page is newer than the running ah server. Restart it (<code>pnpm serve</code>) to finish updating.
          </div>
        )}
        {current && state ? (
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
          />
        ) : state ? (
          <>
            {page === 'security' ? (
              <Security onLocked={onLock} />
            ) : page === 'history' ? (
              <HistoryView state={state} onResume={(h) => resume(h.host, h.ref)} onForget={forget} />
            ) : page === 'sessions' && narrow ? (
              <SessionsView state={state} onOpen={(w) => open(w.key)} onNew={() => setCreating(true)} />
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
                onNew={() => setCreating(true)}
                onSearch={() => setSwitching(true)}
                onSecurity={() => go({ page: 'security', selected: null })}
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
          initialHost={current?.host ?? state.hostname}
          hostState={hostState}
          clientFor={clientFor}
          initialCwd={current?.projectPath ?? '~'}
          onClose={() => setCreating(false)}
          onCreated={async (host, id) => {
            setCreating(false);
            await refresh(host);
            open(keyFor(host, id));
          }}
        />
      )}

      {switching && state && (
        <Switcher
          windows={state.windows}
          history={state.history}
          onPick={(key) => {
            setSwitching(false);
            open(key);
          }}
          onResume={(host, ref) => {
            setSwitching(false);
            resume(host, ref);
          }}
          onClose={() => setSwitching(false)}
        />
      )}

      {dialog === 'notify' && <NotifyDialog onClose={() => setDialog(null)} onChange={(on) => (pushActive.current = on)} />}
      {dialog === 'worktrees' && <WorktreesDialog client={clientFor(current?.host)} onClose={() => setDialog(null)} onShell={shellIn} />}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
