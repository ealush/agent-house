import { useCallback, useEffect, useRef, useState } from 'react';
import { shellQuote, type SendResult, type State, type Win } from './api.ts';
import { useHosts } from './useHosts.ts';
import { look } from './agents.ts';
import { Sidebar, STATUS_TEXT, type GroupBy } from './Sidebar.tsx';
import { Terminal, type TerminalHandle } from './Terminal.tsx';
import { NewDialog } from './NewDialog.tsx';
import { KeyBar, applyModifiers } from './KeyBar.tsx';
import { Composer } from './Composer.tsx';
import { Switcher } from './Switcher.tsx';
import { FilesDialog } from './Files.tsx';
import { ChangesDialog, WorktreesDialog } from './Git.tsx';
import { NotifyDialog } from './NotifyDialog.tsx';
import { pushStatus, pushSupport, registerWorker } from './notify.ts';

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
      return (localStorage.getItem(key) as T) ?? fallback;
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

// Window keys: "@12" locally, "<host>/@12" on a peer.
const selectedFromHash = () => (location.hash.includes('@') ? decodeURIComponent(location.hash.slice(1)) : null);

export function App() {
  const [selected, setSelected] = useState<string | null>(selectedFromHash);
  const [groupBy, setGroupBy] = stored<GroupBy>('ah.groupBy', 'status');
  const [toast, setToast] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [capture, setCapture] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [panel, setPanel] = useState<'files' | 'changes' | 'worktrees' | 'notify' | null>(null);
  const pushActive = useRef(false);
  const [dragging, setDragging] = useState(false);
  const narrow = useMedia('(max-width: 760px)');
  const touch = useMedia('(pointer: coarse)');
  const [showList, setShowList] = useState(() => !selectedFromHash());
  const [collapsed, setCollapsed] = stored<'0' | '1'>('ah.collapsed', '0');
  const [keysPref, setKeysPref] = stored<'auto' | 'on' | 'off'>('ah.keys', 'auto');
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [notify, setNotify] = useState<NotificationPermission | 'unsupported'>(() =>
    'Notification' in window ? Notification.permission : 'unsupported',
  );
  const termRef = useRef<TerminalHandle>(null);
  const prevStatus = useRef(new Map<string, string>());

  const { state, error, refresh, clientFor, hostState } = useHosts((s: State) => announce(s.windows));

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }

  function announce(windows: Win[]) {
    const prev = prevStatus.current;
    for (const w of windows) {
      const was = prev.get(w.key);
      const alerting = w.status === 'attention' || w.status === 'waiting';
      // With Web Push on, the service worker notifies; in-page alerts are the http fallback.
      if (was && was !== w.status && alerting && !pushActive.current && 'Notification' in window && Notification.permission === 'granted') {
        if (document.hidden || w.key !== selectedRef.current) {
          const n = new Notification(w.status === 'waiting' ? `${w.name} needs you` : `${w.name} finished`, { body: `${w.project} · ${w.agent ?? w.command}`, tag: w.key, icon: '/icon-512.png' });
          n.onclick = () => {
            window.focus();
            select(w.key);
            n.close();
          };
        }
      }
    }
    prevStatus.current = new Map(windows.map((w) => [w.key, w.status]));
    const waiting = windows.filter((w) => w.status === 'waiting').length;
    document.title = waiting ? `(${waiting}) ah` : 'ah';
  }

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const onHash = () => {
      const id = selectedFromHash();
      setSelected(id);
      if (id) setShowList(false); // e.g. opened from a notification
    };
    if (pushSupport() === 'ok') {
      registerWorker();
      pushStatus()
        .then((e) => (pushActive.current = !!e))
        .catch(() => {});
    }
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // ⌘K / Ctrl+Shift+K opens the switcher. Captured before xterm so the shell never sees it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase() === 'k';
      if (k && ((e.metaKey && !e.ctrlKey) || (e.ctrlKey && e.shiftKey))) {
        e.preventDefault();
        e.stopPropagation();
        setSwitching((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Pasted or dropped files are uploaded to the host and their paths typed in.
  async function sendFiles(files: FileList | File[]) {
    try {
      const paths = await Promise.all([...files].map((f) => client.upload(f)));
      termRef.current?.send(paths.map(shellQuote).join(' ') + ' ');
      termRef.current?.focus();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  // Keep the layout pinned to the visual viewport so the iOS keyboard doesn't cover the terminal.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const set = () => document.documentElement.style.setProperty('--vh', `${vv.height}px`);
    set();
    vv.addEventListener('resize', set);
    return () => vv.removeEventListener('resize', set);
  }, []);

  function select(id: string | null) {
    setSelected(id);
    history.replaceState(null, '', id ? `#${id}` : location.pathname);
    if (id) setShowList(false);
  }

  const current = state?.windows.find((w) => w.key === selected) ?? null;
  /** API of the machine the selected session lives on. */
  const client = clientFor(current?.host);
  // Forget a selection whose window no longer exists (killed elsewhere).
  useEffect(() => {
    if (state && selected && !current) select(null);
  }, [state, selected, current]);

  async function rename() {
    if (!current) return;
    const name = prompt('Rename window', current.name)?.trim();
    if (!name || name === current.name) return;
    await client.rename(current.id, name).catch((e) => alert(e.message));
    refresh(current.host);
  }

  async function kill() {
    if (!current) return;
    if (!confirm(`Kill "${current.name}"? Everything running in it will be terminated.`)) return;
    await client.kill(current.id).catch((e) => alert(e.message));
    select(null);
    setShowList(true);
    refresh(current.host);
  }

  async function openCapture() {
    if (!current) return;
    try {
      setCapture(await client.capture(current.id));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  /** Resumes where the conversation lives (F7); live sessions just get focused. */
  async function resume(host: string, ref: string) {
    try {
      const out = await clientFor(host).resume(ref);
      await refresh(host);
      select(host === state?.hostname ? out.id : `${host}/${out.id}`);
      if (out.resumed) flash('Resuming…');
    } catch (e) {
      alert((e as Error).message);
    }
  }

  function sent(r: SendResult) {
    if (r.outcome === 'delivered') return flash('Sent');
    flash(r.resumed ? 'Resuming the session; your message goes in once it is ready' : `Queued (${r.queued}) — sent when the agent is free`);
    refresh(current?.host);
  }

  async function togglePin() {
    if (!current) return;
    await client.pin(current.uid, !current.pinned).catch((e) => alert(e.message));
    refresh(current.host);
  }

  async function clearQueue() {
    if (!current || !confirm(`Drop ${current.queued} queued message${current.queued > 1 ? 's' : ''}?`)) return;
    await client.clearQueue(current.uid).catch((e) => alert(e.message));
    refresh(current.host);
  }

  const home = (current && hostState(current.host)?.home) ?? state?.home ?? '';
  const abs = (p: string) => (p.startsWith('~') ? home + p.slice(1) : p);

  async function shellIn(path: string) {
    setPanel(null);
    const host = current?.host ?? state?.hostname ?? '';
    try {
      const out = await clientFor(host).create({ preset: 'shell', cwd: path, session: current?.session ?? state?.defaultSession ?? '', label: '', resume: false });
      await refresh(host);
      select(host === state?.hostname ? out.id : `${host}/${out.id}`);
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function enableNotify() {
    if (!('Notification' in window)) return;
    setNotify(await Notification.requestPermission());
  }

  const showKeys = keysPref === 'on' || (keysPref === 'auto' && touch);
  const listVisible = narrow ? showList || !current : collapsed !== '1';
  const termVisible = !narrow || (!showList && !!current);
  const transform = useCallback(
    (d: string) => {
      if (!ctrl && !alt) return d;
      setCtrl(false);
      setAlt(false);
      return applyModifiers(d, ctrl, alt);
    },
    [ctrl, alt],
  );

  return (
    <div className={`app ${narrow ? 'narrow' : ''}`}>
      {listVisible && (
        <Sidebar
          state={state}
          error={error}
          selected={selected}
          groupBy={groupBy}
          setGroupBy={setGroupBy}
          onSelect={select}
          onResume={resume}
          onForget={async (host, ref) => {
            await clientFor(host).forget(ref).catch((e) => alert(e.message));
            refresh(host);
          }}
          onNew={() => setCreating(true)}
          onWorktrees={() => setPanel('worktrees')}
          onNotify={() => (pushSupport() === 'ok' ? setPanel('notify') : enableNotify())}
          notify={notify}
        />
      )}

      {termVisible && (
        <main
          className="main"
          onPasteCapture={(e) => {
            if (current && e.clipboardData.files.length) {
              e.preventDefault();
              e.stopPropagation();
              sendFiles(e.clipboardData.files);
            }
          }}
          onDragOver={(e) => {
            if (current && e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={(e) => {
            setDragging(false);
            if (current && e.dataTransfer.files.length) {
              e.preventDefault();
              sendFiles(e.dataTransfer.files);
            }
          }}
        >
          <header className="main-head">
            <button
              className="icon-btn"
              title={narrow ? 'Sessions' : 'Toggle sidebar'}
              onClick={() => (narrow ? setShowList(true) : setCollapsed(collapsed === '1' ? '0' : '1'))}
            >
              {narrow ? '‹' : '☰'}
            </button>
            {current ? (
              <>
                <span className="chip" style={{ '--agent': look(current.agent).color } as React.CSSProperties}>
                  {look(current.agent).glyph}
                </span>
                <div className="title">
                  <button className="title-name" onClick={rename} title="Rename">
                    {current.name}
                  </button>
                  <span className="title-sub">
                    <span className={`status ${current.status}`} title={STATUS_TEXT[current.status]} /> {current.cwd}
                    {current.branch ? ` ⎇ ${current.branch}` : ''}
                    {current.model ? ` · ${current.model}` : ''} · {state && state.hosts.length > 1 ? `${current.host} · ` : ''}
                    {current.session}:{current.index}
                    {current.viewers > 1 && <span className="shared"> · on {current.viewers} devices</span>}
                  </span>
                </div>
                <div className="head-actions">
                  {current.queued > 0 && (
                    <button className="btn ghost small queued" onClick={clearQueue} title="Queued messages — click to drop">
                      ⇥ {current.queued}
                      <span className="lbl"> queued</span>
                    </button>
                  )}
                  <button className={`btn ghost small ${current.pinned ? 'on' : ''}`} onClick={togglePin} title={current.pinned ? 'Unpin' : 'Pin to top'}>
                    {current.pinned ? '★' : '☆'}
                  </button>
                  <button className="btn ghost small" onClick={() => setComposing(true)} title="Write a prompt in a text box (dictation, attachments)">
                    <span aria-hidden>✎</span>
                    <span className="lbl">Compose</span>
                  </button>
                  <button className="btn ghost small" onClick={() => setPanel('files')} title="Browse, upload and download files on the host">
                    <span aria-hidden>▤</span>
                    <span className="lbl">Files</span>
                  </button>
                  {current.branch && (
                    <button className="btn ghost small" onClick={() => setPanel('changes')} title="Review uncommitted changes">
                      <span aria-hidden>±</span>
                      <span className="lbl">Diff</span>
                    </button>
                  )}
                  <button className="btn ghost small" onClick={openCapture} title="Show scrollback as selectable text">
                    <span aria-hidden>≡</span>
                    <span className="lbl">Text</span>
                  </button>
                  <button
                    className={`btn ghost small ${showKeys ? 'on' : ''}`}
                    onClick={() => setKeysPref(showKeys ? 'off' : 'on')}
                    title="On-screen keys"
                  >
                    <span aria-hidden>⌨</span>
                    <span className="lbl">Keys</span>
                  </button>
                  <button className="btn ghost small danger" onClick={kill} title="Kill window">
                    <span aria-hidden>✕</span>
                    <span className="lbl">Kill</span>
                  </button>
                </div>
              </>
            ) : (
              <div className="title">
                <span className="title-name muted">No session selected</span>
              </div>
            )}
          </header>

          {current ? (
            <>
              <Terminal ref={termRef} key={current.host} windowId={current.id} wsUrl={client.wsUrl} transformInput={transform} onGone={() => refresh(current.host)} />
              {dragging && <div className="drop-hint">Drop to upload to {current.host} and insert the path</div>}
              {showKeys && (
                <KeyBar
                  ctrl={ctrl}
                  alt={alt}
                  setCtrl={setCtrl}
                  setAlt={setAlt}
                  send={(d) => termRef.current?.send(d)}
                  onKeyboard={() => termRef.current?.focus()}
                />
              )}
            </>
          ) : (
            <div className="placeholder">
              <p>Pick a session on the left, or start a new one.</p>
              <button className="btn primary" onClick={() => setCreating(true)}>
                ＋ New session
              </button>
            </div>
          )}
        </main>
      )}

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
            select(host === state.hostname ? id : `${host}/${id}`);
          }}
        />
      )}

      {composing && current && (
        <Composer client={client} target={current.uid} name={current.name} onSent={sent} onClose={() => setComposing(false)} />
      )}

      {switching && state && (
        <Switcher
          windows={state.windows}
          history={state.history}
          onPick={(id) => {
            setSwitching(false);
            select(id);
          }}
          onResume={(host, ref) => {
            setSwitching(false);
            resume(host, ref);
          }}
          onClose={() => setSwitching(false)}
        />
      )}

      {capture !== null && <CaptureDialog text={capture} onClose={() => setCapture(null)} />}

      {panel === 'files' && current && state && (
        <FilesDialog
          fs={client.fs}
          start={abs(current.cwd)}
          cwd={abs(current.cwd)}
          agent={current.agent}
          onInsert={(text) => {
            termRef.current?.send(text);
            termRef.current?.focus();
          }}
          onClose={() => setPanel(null)}
        />
      )}

      {panel === 'changes' && current && <ChangesDialog client={client} windowId={current.id} onClose={() => setPanel(null)} />}

      {panel === 'notify' && <NotifyDialog onClose={() => setPanel(null)} onChange={(on) => (pushActive.current = on)} />}

      {panel === 'worktrees' && <WorktreesDialog client={client} onClose={() => setPanel(null)} onShell={shellIn} />}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
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
              .catch(() => alert('Clipboard needs HTTPS; select the text instead.'))
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
