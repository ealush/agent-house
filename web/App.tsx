import { useCallback, useEffect, useRef, useState } from 'react';
import { api, subscribe, upload, shellQuote, type SendResult, type State, type Win } from './api.ts';
import { look } from './agents.ts';
import { Sidebar, STATUS_TEXT, type GroupBy } from './Sidebar.tsx';
import { Terminal, type TerminalHandle } from './Terminal.tsx';
import { NewDialog } from './NewDialog.tsx';
import { KeyBar, applyModifiers } from './KeyBar.tsx';
import { Composer } from './Composer.tsx';
import { Switcher } from './Switcher.tsx';

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

const selectedFromHash = () => (location.hash.startsWith('#@') ? decodeURIComponent(location.hash.slice(1)) : null);

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedFromHash);
  const [groupBy, setGroupBy] = stored<GroupBy>('ah.groupBy', 'status');
  const [toast, setToast] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [capture, setCapture] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [switching, setSwitching] = useState(false);
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

  const apply = useCallback((s: State) => {
    setState(s);
    announce(s.windows);
  }, []);

  /** Immediate refetch after our own actions; the event stream catches everything else. */
  const refresh = useCallback(async () => {
    try {
      apply(await api.state());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [apply]);

  function flash(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 3500);
  }

  function announce(windows: Win[]) {
    const prev = prevStatus.current;
    for (const w of windows) {
      const was = prev.get(w.uid);
      const alerting = w.status === 'attention' || w.status === 'waiting';
      if (was && was !== w.status && alerting && 'Notification' in window && Notification.permission === 'granted') {
        if (document.hidden || w.id !== selectedRef.current) {
          const n = new Notification(w.status === 'waiting' ? `${w.name} needs you` : `${w.name} finished`, { body: `${w.project} · ${w.agent ?? w.command}`, tag: w.id, icon: '/icon-512.png' });
          n.onclick = () => {
            window.focus();
            select(w.id);
            n.close();
          };
        }
      }
    }
    prevStatus.current = new Map(windows.map((w) => [w.uid, w.status]));
    const waiting = windows.filter((w) => w.status === 'waiting').length;
    document.title = waiting ? `(${waiting}) ah` : 'ah';
  }

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const stop = subscribe(apply, setError);
    const onHash = () => setSelected(selectedFromHash());
    window.addEventListener('hashchange', onHash);
    return () => {
      stop();
      window.removeEventListener('hashchange', onHash);
    };
  }, [apply]);

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
      const paths = await Promise.all([...files].map(upload));
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

  const current = state?.windows.find((w) => w.id === selected) ?? null;
  // Forget a selection whose window no longer exists (killed elsewhere).
  useEffect(() => {
    if (state && selected && !current) select(null);
  }, [state, selected, current]);

  async function rename() {
    if (!current) return;
    const name = prompt('Rename window', current.name)?.trim();
    if (!name || name === current.name) return;
    await api.rename(current.id, name).catch((e) => alert(e.message));
    refresh();
  }

  async function kill() {
    if (!current) return;
    if (!confirm(`Kill "${current.name}"? Everything running in it will be terminated.`)) return;
    await api.kill(current.id).catch((e) => alert(e.message));
    select(null);
    setShowList(true);
    refresh();
  }

  async function openCapture() {
    if (!current) return;
    try {
      setCapture(await api.capture(current.id));
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function resume(ref: string) {
    try {
      const out = await api.resume(ref);
      await refresh();
      select(out.id);
      if (out.resumed) flash('Resuming…');
    } catch (e) {
      alert((e as Error).message);
    }
  }

  function sent(r: SendResult) {
    if (r.outcome === 'delivered') return flash('Sent');
    flash(r.resumed ? 'Resuming the session; your message goes in once it is ready' : `Queued (${r.queued}) — sent when the agent is free`);
    refresh();
  }

  async function togglePin() {
    if (!current) return;
    await api.pin(current.uid, !current.pinned).catch((e) => alert(e.message));
    refresh();
  }

  async function clearQueue() {
    if (!current || !confirm(`Drop ${current.queued} queued message${current.queued > 1 ? 's' : ''}?`)) return;
    await api.clearQueue(current.uid).catch((e) => alert(e.message));
    refresh();
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
          onForget={async (ref) => {
            await api.forget(ref).catch((e) => alert(e.message));
            refresh();
          }}
          onNew={() => setCreating(true)}
          notify={notify}
          onEnableNotify={enableNotify}
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
                    {current.model ? ` · ${current.model}` : ''} · {current.session}:{current.index}
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
              <Terminal ref={termRef} windowId={current.id} transformInput={transform} onGone={refresh} />
              {dragging && <div className="drop-hint">Drop to upload to {state?.hostname} and insert the path</div>}
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
          state={state}
          initialCwd={current?.projectPath ?? '~'}
          onClose={() => setCreating(false)}
          onCreated={async (id) => {
            setCreating(false);
            await refresh();
            select(id);
          }}
        />
      )}

      {composing && current && (
        <Composer target={current.uid} name={current.name} onSent={sent} onClose={() => setComposing(false)} />
      )}

      {switching && state && (
        <Switcher
          windows={state.windows}
          history={state.history}
          onPick={(id) => {
            setSwitching(false);
            select(id);
          }}
          onResume={(ref) => {
            setSwitching(false);
            resume(ref);
          }}
          onClose={() => setSwitching(false)}
        />
      )}

      {capture !== null && <CaptureDialog text={capture} onClose={() => setCapture(null)} />}

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
