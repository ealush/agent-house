import { useEffect, useRef, useState } from 'react';
import { askConfirm, showError } from './ask.tsx';
import type { AttachedTerminal, HostApi, Win } from './api.ts';
import { Icon } from './icons.tsx';
import { TerminalSurface } from './TerminalSurface.tsx';
import type { SurfaceHandle } from './surface.ts';

/** A companion shell shown inside its owner's panel, never a workspace/session tile. */
export function AttachedTerminalPanel({ w, client, refresh, showKeys, focusOnOpen }: { w: Win; client: HostApi; refresh: () => void; showKeys: boolean; focusOnOpen: boolean }) {
  const surface = useRef<SurfaceHandle>(null);
  const [terminal, setTerminal] = useState<AttachedTerminal | null>(w.terminal ?? null);
  const [error, setError] = useState('');
  const [opening, setOpening] = useState(false);
  const mounted = useRef(false);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setTerminal(w.terminal ?? null); }, [w.terminal]);

  async function open() {
    const request = ++generation.current;
    setOpening(true);
    setError('');
    try {
      const result = await client.openTerminal(w.uid);
      if (mounted.current && generation.current === request) setTerminal(result.terminal);
      refresh();
    } catch (e) {
      if (mounted.current && generation.current === request) setError(e instanceof Error ? e.message : 'Could not open the terminal.');
    } finally { if (mounted.current && generation.current === request) setOpening(false); }
  }
  useEffect(() => { void open(); return () => { generation.current++; }; }, [client, w.uid]);
  useEffect(() => {
    if (!terminal || !focusOnOpen) return;
    const frame = requestAnimationFrame(() => surface.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [terminal?.id, focusOnOpen]);

  async function stop() {
    if (!(await askConfirm({ title: 'Stop attached terminal?', body: 'The shell and anything running in it will be stopped.', confirm: 'Stop terminal', danger: true }))) return;
    try { await client.closeTerminal(w.uid); setTerminal(null); refresh(); }
    catch (e) { showError(e, 'Could not stop the terminal'); }
  }

  const shell: Win | null = terminal ? {
    ...w, id: terminal.id, key: `${w.key}:terminal:${terminal.id}`, agent: null, feed: null,
    command: terminal.command, cwd: terminal.cwd, status: terminal.busy ? 'busy' : 'idle', ask: null, answerable: false,
  } : null;
  return (
    <div className="attached-terminal" aria-label="Attached terminal">
      <div className="attached-terminal-bar">
        <span className={`terminal-indicator${terminal?.busy ? ' busy' : ''}`} aria-label={terminal?.busy ? 'Terminal active' : 'Terminal idle'}><Icon name="terminal" size={14} /></span>
        <span className="grow mono">{terminal?.cwd ?? w.cwd}</span>
        {terminal && <button className="icon-btn small" onClick={() => void stop()} title="Stop attached terminal" aria-label="Stop attached terminal"><Icon name="close" size={14} /></button>}
      </div>
      {shell ? <TerminalSurface ref={surface} w={shell} client={client} hidden={false} showKeys={showKeys} onUseTerminal={() => {}} onAnswer={() => {}} onReply={() => {}} refresh={() => { setTerminal(null); refresh(); }} /> : (
        <div className="panel-msg">
          {error && <p role="alert">{error}</p>}
          <button className="btn" disabled={opening} onClick={() => void open()}>{opening ? 'Opening terminal…' : 'Open terminal'}</button>
        </div>
      )}
    </div>
  );
}
