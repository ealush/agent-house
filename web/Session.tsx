import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons.tsx';
import { deviceName, shellQuote, type HostApi, type SendResult, type Win } from './api.ts';
import { look } from './agents.ts';
import { Terminal, type TerminalHandle } from './Terminal.tsx';
import { KeyBar, applyModifiers } from './KeyBar.tsx';
import { ComposerBar } from './Composer.tsx';
import { ChangesPanel } from './Git.tsx';
import { FilesPanel } from './Files.tsx';

type Panel = 'diff' | 'files';

type Props = {
  w: Win;
  client: HostApi;
  narrow: boolean;
  touch: boolean;
  multiHost: boolean;
  /** Host home dir, to turn "~/x" into an absolute path. */
  home: string;
  /** Bumped when the user chose "Reply" somewhere, to focus the composer. */
  replyKey: number;
  onBack: () => void;
  onAnswer: (w: Win, answer: 'approve' | 'deny') => void;
  onSent: (r: SendResult) => void;
  onKilled: () => void;
  refresh: () => void;
};

const STATUS_PILL = { waiting: 'Needs you', busy: 'Working', attention: 'Done', idle: 'Idle' };
const KIND_LABEL = { command: 'Wants to run a command', tool: 'Wants to use a tool', question: 'Asked a question', screen: 'Waiting for you' };

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

export function Session({ w, client, narrow, touch, multiHost, home, replyKey, onBack, onAnswer, onSent, onKilled, refresh }: Props) {
  const term = useRef<TerminalHandle>(null);
  const [tab, setTab] = useState<'terminal' | Panel>('terminal');
  const [panel, setPanel] = stored<Panel | ''>('ah.panel', '');
  const [keysPref, setKeysPref] = stored<'auto' | 'on' | 'off'>('ah.keys', 'auto');
  const [menu, setMenu] = useState(false);
  const [capture, setCapture] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [ctrl, setCtrl] = useState(false);
  const [alt, setAlt] = useState(false);
  const [focus, setFocus] = useState(0);
  const { color, glyph, name: agentName } = look(w.agent);

  useEffect(() => setTab('terminal'), [w.key]);
  useEffect(() => {
    if (replyKey) {
      setTab('terminal');
      setFocus((n) => n + 1);
    }
  }, [replyKey]);

  const abs = (p: string) => (p.startsWith('~') ? home + p.slice(1) : p);
  const showKeys = (keysPref === 'on' || (keysPref === 'auto' && touch)) && tab === 'terminal';
  const elsewhere = others(w.devices);
  const transform = useCallback(
    (d: string) => {
      if (!ctrl && !alt) return d;
      setCtrl(false);
      setAlt(false);
      return applyModifiers(d, ctrl, alt);
    },
    [ctrl, alt],
  );

  // Pasted or dropped files are uploaded to the host and their paths typed in.
  async function sendFiles(files: FileList) {
    try {
      const paths = await Promise.all([...files].map((f) => client.upload(f)));
      term.current?.send(paths.map(shellQuote).join(' ') + ' ');
      term.current?.focus();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setMenu(false);
    try {
      await fn();
    } catch (e) {
      alert((e as Error).message);
    }
    refresh();
  }

  const rename = () =>
    act(async () => {
      const name = prompt('Rename session', w.name)?.trim();
      if (name && name !== w.name) await client.rename(w.id, name);
    });

  const kill = () =>
    act(async () => {
      if (!confirm(`Kill "${w.title}"? Everything running in it will be terminated.`)) return;
      await client.kill(w.id);
      onKilled();
    });

  const comment = async (text: string) => onSent(await client.send(w.uid, text, true));

  const diffTab = w.branch ? 'Diff' : null;
  const panelView = (p: Panel) =>
    p === 'diff' ? (
      <ChangesPanel client={client} windowId={w.id} onComment={w.agent ? comment : undefined} />
    ) : (
      <FilesPanel
        fs={client.fs}
        start={abs(w.cwd)}
        cwd={abs(w.cwd)}
        agent={w.agent}
        onInsert={(text) => {
          setTab('terminal');
          term.current?.send(text);
          term.current?.focus();
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
            {glyph}
          </span>
        )}
        <div className="session-title">
          {!narrow && (
            <span className="eyebrow">
              {w.project}
              {w.agent ? ` · ${agentName}` : ''}
              {w.model ? ` · ${w.model}` : ''}
            </span>
          )}
          <button className="name" onClick={rename} title="Rename">
            {w.title}
          </button>
          {narrow && (
            <span className="eyebrow">
              {[w.agent ? agentName : w.cwd, multiHost ? w.host : null, elsewhere ? `also open on ${elsewhere}` : null].filter(Boolean).join(' · ')}
            </span>
          )}
        </div>
        {narrow ? (
          <span className={`pill ${w.status}`}>{w.status === 'busy' && !w.agent ? 'Live' : STATUS_PILL[w.status]}</span>
        ) : (
          <div className="session-pills">
            <span className={`pill ${w.status}`}>
              {w.status === 'waiting' && <span className="dot waiting" />} {STATUS_PILL[w.status]}
            </span>
            {multiHost && <span className="pill mono">{w.host}</span>}
            {w.branch && (
              <span className="pill mono">
                <Icon name="branch" size={12} /> {w.branch}
              </span>
            )}
            {w.queued > 0 && (
              <button className="pill waiting" onClick={() => act(() => client.clearQueue(w.uid))} title="Drop queued messages">
                ⇥ {w.queued} queued ×
              </button>
            )}
            {elsewhere && <span className="devices">On {elsewhere}</span>}
          </div>
        )}
        {!narrow && (
          <>
            {diffTab && (
              <button className={`btn ghost small ${panel === 'diff' ? 'on' : ''}`} onClick={() => setPanel(panel === 'diff' ? '' : 'diff')}>
                <Icon name="diff" size={15} /> Diff
              </button>
            )}
            <button className={`btn ghost small ${panel === 'files' ? 'on' : ''}`} onClick={() => setPanel(panel === 'files' ? '' : 'files')}>
              <Icon name="files" size={15} /> Files
            </button>
          </>
        )}
        <div className="menu-wrap">
          <button className="icon-btn" onClick={() => setMenu(!menu)} aria-label="More" aria-expanded={menu}>
            <Icon name="more" />
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              <button onClick={rename}>Rename</button>
              <button onClick={() => act(() => client.pin(w.uid, !w.pinned))}>{w.pinned ? 'Unpin' : 'Pin to top'}</button>
              <button
                onClick={() =>
                  act(async () => {
                    setCapture(await client.capture(w.id));
                  })
                }
              >
                Scrollback as text
              </button>
              <button
                onClick={() => {
                  setKeysPref(showKeys ? 'off' : 'on');
                  setMenu(false);
                }}
              >
                {showKeys ? 'Hide' : 'Show'} on-screen keys
              </button>
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
                Kill session
              </button>
            </div>
          )}
        </div>
      </header>

      {narrow && (
        <div className="seg-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'terminal'} className={tab === 'terminal' ? 'on' : ''} onClick={() => setTab('terminal')}>
            Terminal
          </button>
          {diffTab && (
            <button role="tab" aria-selected={tab === 'diff'} className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}>
              Diff
            </button>
          )}
          <button role="tab" aria-selected={tab === 'files'} className={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
            Files
          </button>
        </div>
      )}

      <div className="session-body">
        <div
          className="session-main"
          onPasteCapture={(e) => {
            if (tab === 'terminal' && e.clipboardData.files.length && !(e.target as HTMLElement).closest('.composer-bar')) {
              e.preventDefault();
              e.stopPropagation();
              sendFiles(e.clipboardData.files);
            }
          }}
          onDragOver={(e) => {
            if (tab === 'terminal' && e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              setDragging(true);
            }
          }}
          onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
          onDrop={(e) => {
            setDragging(false);
            if (tab === 'terminal' && e.dataTransfer.files.length) {
              e.preventDefault();
              sendFiles(e.dataTransfer.files);
            }
          }}
        >
          <Terminal
            ref={term}
            key={w.key}
            hidden={tab !== 'terminal'}
            windowId={w.id}
            wsUrl={client.wsUrl}
            transformInput={transform}
            onGone={refresh}
          />
          {tab !== 'terminal' && <div className="session-main" style={{ minHeight: 0 }}>{panelView(tab)}</div>}
          {dragging && <div className="drop-hint">Drop to upload to {w.host} and insert the path</div>}

          {w.status === 'waiting' && w.ask && tab === 'terminal' && (
            <div className="ask-banner">
              <span className="card-kind">{KIND_LABEL[w.ask.kind]}</span>
              {w.ask.text && <pre className={`ask-box ${w.ask.kind === 'command' || w.ask.kind === 'screen' ? 'code' : ''}`}>{w.ask.text}</pre>}
              <div className="actions">
                {w.answerable ? (
                  <>
                    <button className="btn primary" onClick={() => onAnswer(w, 'approve')}>
                      Approve
                    </button>
                    <button className="btn" onClick={() => onAnswer(w, 'deny')}>
                      Deny
                    </button>
                  </>
                ) : (
                  <button className="btn primary" onClick={() => setFocus((n) => n + 1)}>
                    Reply
                  </button>
                )}
              </div>
            </div>
          )}

          {showKeys && (
            <KeyBar ctrl={ctrl} alt={alt} setCtrl={setCtrl} setAlt={setAlt} send={(d) => term.current?.send(d)} onKeyboard={() => term.current?.focus()} />
          )}
          <ComposerBar client={client} target={w.uid} agent={w.agent} onSent={onSent} focusKey={focus} />
        </div>

        {!narrow && panel && (panel === 'files' || diffTab) && (
          <aside className="side-panel">
            <div className="tabs">
              {diffTab && (
                <button className={`tab ${panel === 'diff' ? 'on' : ''}`} onClick={() => setPanel('diff')}>
                  Diff
                </button>
              )}
              <button className={`tab ${panel === 'files' ? 'on' : ''}`} onClick={() => setPanel('files')}>
                Files
              </button>
              <span className="spacer" />
              <button className="icon-btn small" onClick={() => setPanel('')} aria-label="Close panel">
                <Icon name="close" size={14} />
              </button>
            </div>
            {panelView(panel)}
          </aside>
        )}
      </div>

      {capture !== null && <CaptureDialog text={capture} onClose={() => setCapture(null)} />}
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
