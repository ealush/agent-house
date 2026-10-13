import { useEffect, useRef, useState } from 'react';
import { statusCounts } from './status.ts';
import type { HistoryItem, State, Win } from './api.ts';
import { Icon } from './icons.tsx';
import { age, look } from './agents.ts';
import { AgentLogo, shortModel } from './logos.tsx';
import { Rows } from './Inbox.tsx';
import { useSavedGroups } from './groupOrder.ts';
import { sidebarSections } from './sessionOrder.ts';
import { useFlip } from './useFlip.ts';
import { useDismiss } from './useDismiss.ts';
import { ActionSheet } from './sheet.tsx';
import { createPortal } from 'react-dom';

/** Ended and saved conversations from every host; one tap resumes on the host that has it. */
export function HistoryView({ state, onResume, onForget, onFork, touch = false, narrow = false }: { state: State; onResume: (h: HistoryItem) => void; onForget: (h: HistoryItem) => void; onFork?: (h: HistoryItem) => void; touch?: boolean; narrow?: boolean }) {
  const multiHost = state.hosts.length > 1;
  const [filter, setFilter] = useState('');
  // Touch: the row itself resumes (like any list on a phone), and Fork and
  // Hide wait behind ··· so the title keeps the width.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRow = useRef<HTMLSpanElement>(null);
  // A phone's menu is an action sheet, which closes itself (scrim, Cancel, a drag down).
  useDismiss(menuFor !== null && !narrow, menuRow, () => setMenuFor(null));
  // "/" filters, as in most lists a power user knows (GitHub, Gmail), unless you are typing.
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const slash = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"], .xterm, dialog')) return;
      e.preventDefault();
      filterRef.current?.focus();
    };
    window.addEventListener('keydown', slash);
    return () => window.removeEventListener('keydown', slash);
  }, []);
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length
    ? state.history.filter((h) => {
        const hay = [h.title, h.project, h.harness, h.model, h.host, h.cwd].join(' ').toLowerCase();
        return words.every((w) => hay.includes(w));
      })
    : state.history;
  return (
    <div className="page" data-title="History" data-rove="button.resume">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">History<span className="period">.</span></h1>
          <p className="tagline">Ended sessions and past conversations. Resuming continues the same conversation.</p>
        </div>
      </header>
      {state.history.length > 0 && (
        <label className="field history-filter">
          <input
            ref={filterRef}
            type="search"
            value={filter}
            placeholder={`Filter ${state.history.length} conversation${state.history.length === 1 ? '' : 's'} by title, project or agent`}
            aria-label="Filter history"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              // Down from the filter lands on the first match.
              if (e.key === 'ArrowDown' || (e.key === 'Enter' && shown.length)) {
                e.preventDefault();
                (e.currentTarget.closest('.page')?.querySelector('button.resume') as HTMLElement | null)?.[e.key === 'Enter' ? 'click' : 'focus']();
              } else if (e.key === 'Escape') {
                // Clears first; an empty filter lets go, back to the list.
                e.preventDefault();
                if (filter) setFilter('');
                else e.currentTarget.blur();
              }
            }}
          />
        </label>
      )}
      {state.history.length === 0 && <p className="empty-state">Nothing here yet.</p>}
      {state.history.length > 0 && shown.length === 0 && <p className="empty-state">No conversations match “{filter}”.</p>}
      <ul className="rows history-list">
        {shown.map((h) => {
          const { color, name } = look(h.harness);
          const modelLabel = shortModel(h.model);
          const key = `${h.host}:${h.ref}`;
          const canFork = !!onFork && (h.harness === 'claude' || h.harness === 'codex' || h.harness === 'muse');
          const open = menuFor === key;
          return (
            <li key={key} className={open ? 'open' : undefined}>
              <div
                className={`row quiet history-row ${touch ? 'tap' : ''}`}
                style={{ '--agent': color } as React.CSSProperties}
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
                    {[name, modelLabel, multiHost ? h.host : null, h.project, h.kind === 'ended' ? 'ended' : null, h.worktree ? '⎇ worktree' : null, h.fork ? `⑂ fork of ${h.fork.parentTitle}` : null].filter(Boolean).join(' · ')}
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
                            <button onClick={() => { setMenuFor(null); onResume(h); }}>Resume</button>
                            {canFork && <button onClick={() => { setMenuFor(null); onFork?.(h); }}>Fork…</button>}
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
                  <button className="btn small resume" onClick={() => onResume(h)}>
                    Resume
                  </button>
                  {canFork && (
                    <button className="btn small ghost" onClick={() => onFork(h)}>
                      Fork
                    </button>
                  )}
                  <button className="icon-btn small" title="Hide" onClick={() => onForget(h)}>
                    <Icon name="close" size={14} />
                  </button>
                </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Phone "Sessions" tab: the same blocks and row order as the sidebar. */
export function SessionsView({ state, onOpen, onNew }: { state: State; onOpen: (w: Win) => void; onNew: () => void }) {
  const multiHost = state.hosts.length > 1;
  const sections = sidebarSections(state.windows, multiHost, useSavedGroups(multiHost));
  const flip = useFlip<HTMLDivElement>(sections.map((s) => `${s.id}:${s.windows.map((w) => w.key).join(',')}`).join('|'));
  return (
    <div className="page" data-title="Sessions" ref={flip} data-rove="button.row">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">Sessions<span className="period">.</span></h1>
          <p className="tagline">{statusCounts(state.windows)}</p>
        </div>
        <button className="icon-btn round light" onClick={onNew} aria-label="New session">
          <Icon name="plus" size={22} />
        </button>
      </header>
      {sections.map((section, i) => (
        <section key={section.id}>
          <h2 className={`section-label ${i === 0 ? 'first' : ''}`} data-flip={`h:${section.id}`}>
            <span className="section-name" title={section.id}>{section.id}</span>
          </h2>
          <Rows windows={section.windows} multiHost={false} narrow onOpen={onOpen} inProject={!multiHost} />
        </section>
      ))}
    </div>
  );
}
