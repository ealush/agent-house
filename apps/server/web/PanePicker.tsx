import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Win } from './api.ts';
import { look } from './agents.ts';
import { AgentLogo } from './logos.tsx';
import { Icon } from './icons.tsx';
import { score } from './Switcher.tsx';
import { sessionLine } from './sessionLine.tsx';

// What goes in a new or replaced pane, chosen inside the pane itself (not a
// modal): your other sessions, a new shell, or a new session with options.
// Sessions already on screen are left out, so one tmux window is never shown
// twice (two viewers fight over its size). Type to filter, ↑↓ to move, Enter
// to choose, Esc to cancel.

type Row = { kind: 'win'; w: Win } | { kind: 'shell' } | { kind: 'new' };

export function PanePicker({
  windows,
  onScreen,
  replacing,
  focus,
  onChoose,
  onNewShell,
  onNewSession,
  onCancel,
}: {
  /** Live sessions in sidebar order. */
  windows: Win[];
  /** Keys already in a pane. */
  onScreen: string[];
  /** The session being replaced (Esc puts it back), or null for a new split. */
  replacing: Win | null;
  /** This pane has the keyboard: the filter takes focus. */
  focus: boolean;
  onChoose: (key: string) => void;
  onNewShell: () => void;
  onNewSession: () => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  // Take the first keystroke before painting; waiting for compositing frames can
  // lose it on a busy glass surface. Reclaim after the neighbouring terminal mounts.
  useLayoutEffect(() => {
    if (!focus) return;
    input.current?.focus({ preventScroll: true });
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => input.current?.focus({ preventScroll: true }));
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focus]);

  const others = windows.filter((w) => !onScreen.includes(w.key) || w.key === replacing?.key).filter((w) => w.key !== replacing?.key);
  const matched = q.trim()
    ? others
        .map((w) => ({ w, s: Math.max(score(q, w.title), score(q, `${w.project} ${look(w.agent).name}`) * 0.6) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .map((x) => x.w)
    : others;
  const rows: Row[] = [{ kind: 'shell' }, { kind: 'new' }, ...matched.map((w) => ({ kind: 'win' as const, w }))];
  const at = Math.min(i, rows.length - 1);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const choose = (r: Row | undefined) => {
    if (!r) return;
    if (r.kind === 'win') onChoose(r.w.key);
    else if (r.kind === 'shell') onNewShell();
    else onNewSession();
  };

  return (
    <div className="pane-picker">
      <header className="pane-picker-head">
        <div>
          <h3>{replacing ? 'Replace this pane' : 'Open in this pane'}</h3>
          <p className="hint">{replacing ? `Esc keeps ${replacing.title}.` : 'Esc closes this pane.'}</p>
        </div>
        <button className="btn ghost small" onClick={onCancel}>
          {replacing ? 'Keep it' : 'Close pane'}
        </button>
      </header>
      <input
        ref={input}
        className="pane-picker-filter"
        value={q}
        placeholder="Filter sessions…"
        enterKeyHint="go"
        aria-label="Filter sessions"
        aria-controls="pane-picker-list"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(e) => {
          setQ(e.target.value);
          setI(e.target.value.trim() ? 2 : 0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setI(Math.min(rows.length - 1, at + 1));
          else if (e.key === 'ArrowUp') setI(Math.max(0, at - 1));
          else if (e.key === 'Home') setI(0);
          else if (e.key === 'End') setI(rows.length - 1);
          else if (e.key === 'Enter') choose(rows[at]);
          else if (e.key === 'Escape') {
            if (q) setQ('');
            else onCancel();
          } else return;
          e.preventDefault();
          e.stopPropagation();
        }}
      />
      <ul ref={list} id="pane-picker-list" className="pane-picker-list" role="listbox">
        {rows.map((r, idx) => {
          const on = idx === at;
          const common = { role: 'option' as const, 'aria-selected': on, className: `pane-picker-row ${on ? 'on' : ''}`, onMouseMove: () => idx !== at && setI(idx), onClick: () => choose(r) };
          if (r.kind === 'shell')
            return (
              <li key="shell" {...common}>
                <span className="chip sm">
                  <Icon name="terminal" size={14} />
                </span>
                <span className="pane-picker-text">
                  <span className="name">New shell</span>
                  <span className="hint">In the same Space, right here</span>
                </span>
              </li>
            );
          if (r.kind === 'new')
            return (
              <li key="new" {...common}>
                <span className="chip sm">
                  <Icon name="plus" size={14} />
                </span>
                <span className="pane-picker-text">
                  <span className="name">New session…</span>
                  <span className="hint">Choose the agent, model and Space</span>
                </span>
              </li>
            );
          const { color } = look(r.w.agent);
          return (
            <li key={r.w.key} {...common} style={{ '--agent': color } as React.CSSProperties}>
              <span className="chip sm">
                <AgentLogo id={r.w.agent} size={14} />
              </span>
              <span className="pane-picker-text">
                <span className="name">{r.w.title}</span>
                <span className="hint">{sessionLine(r.w, { project: true })}</span>
              </span>
              <span className={`dot ${r.w.status}`} />
            </li>
          );
        })}
        {q.trim() && matched.length === 0 && <li className="pane-picker-empty hint">No other session matches “{q}”.</li>}
      </ul>
    </div>
  );
}
