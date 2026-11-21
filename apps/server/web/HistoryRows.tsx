import { useRef, useState } from 'react';
import { usePressMenu } from './PressMenu.tsx';
import { Swipe } from './Swipe.tsx';
import type { HistoryItem } from './api.ts';
import { Icon } from './icons.tsx';
import { age, look } from './agents.ts';
import { AgentLogo } from './logos.tsx';
import { useDismiss } from './useDismiss.ts';
import { ActionSheet } from './sheet.tsx';
import { createPortal } from 'react-dom';
import { historyLine } from './sessionLine.tsx';

/**
 * Ended and saved conversations from every host, as rows; one tap resumes on the host that
 * has it (Search lists them, web/SearchView.tsx). A row's Fork, Move and Hide are its
 * buttons on a desktop, behind ··· on a touch screen, under a held finger, and a swipe.
 */
export function HistoryRows({ items, multiHost, canMoveAnywhere, onResume, onForget, onFork, onMove, touch = false, narrow = false }: { items: HistoryItem[]; multiHost: boolean; /** Another host is online to move to. */ canMoveAnywhere: boolean; onResume: (h: HistoryItem) => void; onForget: (h: HistoryItem) => void; onFork?: (h: HistoryItem) => void; onMove?: (h: HistoryItem) => void; touch?: boolean; narrow?: boolean }) {
  // Touch: the row itself resumes (like any list on a phone), and Fork and
  // Hide wait behind ··· so the title keeps the width.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // A finger held on a row: Resume, Fork, Hide, as iOS lists open a menu (PressMenu.tsx).
  const press = usePressMenu();
  const menuRow = useRef<HTMLSpanElement>(null);
  // A phone's menu is an action sheet, which closes itself (scrim, Cancel, a drag down).
  useDismiss(menuFor !== null && !narrow, menuRow, () => setMenuFor(null));
  return (
    <ul className="rows history-list">
      {press.menu}
      {items.map((h) => {
        const { color } = look(h.harness);
        const key = `${h.host}:${h.ref}`;
        const canFork = !!onFork && (h.harness === 'claude' || h.harness === 'codex' || h.harness === 'muse');
        const canMove = !!onMove && canMoveAnywhere && h.kind === 'ended' && !h.moved && (h.harness === 'claude' || h.harness === 'codex' || h.harness === 'muse');
        const open = menuFor === key;
        return (
          <li key={key} className={open ? 'open' : undefined}>
            <Swipe
              actions={[
                ...(canFork ? [{ label: 'Fork', icon: 'fork' as const, run: () => onFork?.(h) }] : []),
                { label: 'Hide', icon: 'close', tone: 'danger', run: () => onForget(h) },
              ]}
            >
              <div
                className={`row quiet history-row ${touch ? 'tap' : ''}`}
                style={{ '--agent': color } as React.CSSProperties}
                {...press.bind(() => [
                  { label: h.interrupted ? 'Restore' : 'Resume', icon: 'reload', run: () => onResume(h) },
                  ...(canFork ? [{ label: 'Fork…', icon: 'fork' as const, run: () => onFork?.(h) }] : []),
                  ...(canMove ? [{ label: 'Move to another host…', icon: 'reload' as const, run: () => onMove?.(h) }] : []),
                  { label: 'Hide', icon: 'close', danger: true, run: () => onForget(h) },
                ])}
                onClick={
                  touch
                    ? (e) => {
                        if ((e.target as HTMLElement).closest('button, .menu')) return;
                        onResume(h);
                      }
                    : undefined
                }
                onKeyDown={(e) => {
                  // Up and down move between conversations (the Resume buttons).
                  // Left and right reach Fork and Hide on this row.
                  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
                  const buttons = [...e.currentTarget.querySelectorAll('button')];
                  const i = buttons.findIndex((b) => b === e.target || b.contains(e.target as Node));
                  const next = buttons[i + (e.key === 'ArrowRight' ? 1 : -1)];
                  if (i < 0 || !next) return;
                  e.preventDefault();
                  next.focus();
                }}
              >
                <span className="chip">
                  <AgentLogo id={h.harness} />
                </span>
                <span className="stack">
                  <span className="name" title={h.title}>
                    {h.title}
                  </span>
                  <span className="sub">
                    {historyLine(h, { project: true, host: multiHost })}
                  </span>
                </span>
                <span className="when">{age(h.at)}</span>
                {touch ? (
                  <span className="row-actions" ref={open ? menuRow : undefined}>
                    <button className="icon-btn small" aria-label={`More for ${h.title}`} aria-expanded={open} onClick={() => setMenuFor(open ? null : key)}>
                      <Icon name="more" size={16} />
                    </button>
                    {open &&
                      (() => {
                        const items = (
                          <>
                            <button onClick={() => { setMenuFor(null); onResume(h); }}>{h.interrupted ? 'Restore' : 'Resume'}</button>
                            {canFork && <button onClick={() => { setMenuFor(null); onFork?.(h); }}>Fork…</button>}
                            {canMove && <button onClick={() => { setMenuFor(null); onMove?.(h); }}>Move to another host…</button>}
                            <button className="danger" onClick={() => { setMenuFor(null); onForget(h); }}>Hide</button>
                          </>
                        );
                        // On a phone, the same action sheet as a session's menu.
                        return narrow ? (
                          createPortal(
                            <ActionSheet onClose={() => setMenuFor(null)}>
                              <div className="menu sheet" role="menu" aria-label={h.title} style={{ margin: 0 }}>
                                {items}
                              </div>
                            </ActionSheet>,
                            document.body,
                          )
                        ) : (
                          <div className="menu row-menu" role="menu">
                            {items}
                          </div>
                        );
                      })()}
                  </span>
                ) : (
                <span className="row-actions">
                  <button className="btn small resume" onClick={() => onResume(h)} title={h.interrupted ? 'Resume it in its conversation; if it was working, tell it where it stopped' : undefined}>
                    {h.interrupted ? 'Restore' : 'Resume'}
                  </button>
                  {canFork && (
                    <button className="btn small ghost" onClick={() => onFork(h)}>
                      Fork
                    </button>
                  )}
                  {canMove && (
                    <button className="btn small ghost" onClick={() => onMove?.(h)}>
                      Move
                    </button>
                  )}
                  <button className="icon-btn small" title="Hide" onClick={() => onForget(h)}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
                )}
              </div>
            </Swipe>
          </li>
        );
      })}
    </ul>
  );
}
