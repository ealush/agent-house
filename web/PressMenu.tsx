import { createContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Win } from './api.ts';
import { contextMenu } from './contextMenu.ts';
import { haptic } from './haptic.ts';
import { Icon, type IconName } from './icons.tsx';
import { commandLabel, runCommandSoon } from './shortcuts.ts';
import { confirmTerminate } from './Sidebar.tsx';
import type { SwipeAction } from './Swipe.tsx';

export type PressItem = { label: string; icon?: IconName; danger?: boolean; run: () => void };

const TOUCH = typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches;

/**
 * A list row's menu the way iOS opens one: hold a finger on the row and it lifts out of
 * the list over the blurred page, its actions in a menu under it (over it near the
 * bottom); a tap anywhere else puts it back. The lift opens nothing (contextMenu.ts).
 * Touch screens only; a pointer has the row's own ··· and hover.
 *
 *   const { bind, menu } = usePressMenu();
 *   <button {...bind(() => items)}>…</button> … {menu}
 */
export function usePressMenu(): { bind: (items: () => PressItem[]) => Partial<ReturnType<typeof contextMenu>>; menu: ReactNode } {
  const [at, setAt] = useState<{ el: HTMLElement; items: PressItem[] } | null>(null);
  const bind = (items: () => PressItem[]) => {
    if (!TOUCH) return {};
    let el: HTMLElement | null = null;
    const press = contextMenu(() => {
      if (!el) return;
      haptic();
      setAt({ el, items: items() });
    });
    return {
      ...press,
      onPointerDown: (e: React.PointerEvent) => {
        el = e.currentTarget as HTMLElement;
        press.onPointerDown(e);
      },
      onContextMenu: (e: React.MouseEvent) => {
        el = e.currentTarget as HTMLElement;
        press.onContextMenu(e);
      },
    };
  };
  // In the app, not the body: the lifted copy keeps the phone's row layout (.narrow .row).
  const menu = at && createPortal(<PressMenu anchor={at.el} items={at.items} onClose={() => setAt(null)} />, at.el.closest('.app') ?? document.body);
  return { bind, menu };
}

/** The screen's insets, as CSS resolves them (env() can't be read from script). */
function insets(): { top: number; bottom: number } {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;top:var(--safe-top);bottom:var(--safe-bottom, 0px);left:0;width:0';
  document.body.append(probe);
  const s = getComputedStyle(probe);
  const out = { top: parseFloat(s.top) || 0, bottom: parseFloat(s.bottom) || 0 };
  probe.remove();
  return out;
}

const GAP = 10;
const EDGE = 12;

function PressMenu({ anchor, items, onClose }: { anchor: HTMLElement; items: PressItem[]; onClose: () => void }) {
  const lift = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  // The finger that opened it lifts onto the page: that lift's click isn't a tap to close.
  const armed = useRef(false);
  const close = (then?: () => void) => {
    if (closing) return;
    setClosing(true);
    window.setTimeout(() => {
      onClose();
      then?.();
    }, 160);
  };

  useLayoutEffect(() => {
    const box = lift.current;
    const menu = list.current;
    if (!box || !menu) return;
    const r = anchor.getBoundingClientRect();
    // The row itself, lifted: a copy where it was, and the original left out of the list.
    const copy = anchor.cloneNode(true) as HTMLElement;
    copy.setAttribute('aria-hidden', 'true');
    copy.tabIndex = -1;
    for (const n of [copy, ...copy.querySelectorAll<HTMLElement>('[id]')]) n.removeAttribute('id');
    Object.assign(copy.style, { width: `${r.width}px`, height: `${r.height}px`, margin: '0', pointerEvents: 'none' });
    box.replaceChildren(copy);
    anchor.style.visibility = 'hidden';

    const vh = window.visualViewport?.height ?? window.innerHeight;
    const vw = window.innerWidth;
    const { top: safeTop, bottom: safeBottom } = insets();
    const room = vh - safeTop - safeBottom - 2 * EDGE;
    const menuH = Math.min(menu.scrollHeight, Math.max(160, room - r.height - GAP));
    menu.style.maxHeight = `${menuH}px`;
    const below = r.bottom + GAP + menuH <= vh - safeBottom - EDGE;
    const above = r.top - GAP - menuH >= safeTop + EDGE;
    // Under the row; over it near the bottom; else the row moves up until both fit, as iOS does.
    let top = r.top;
    let menuTop: number;
    if (below || !above) {
      top = Math.min(r.top, vh - safeBottom - EDGE - menuH - GAP - r.height);
      top = Math.max(top, safeTop + EDGE);
      menuTop = top + r.height + GAP;
      menu.style.transformOrigin = 'top left';
    } else {
      menuTop = r.top - GAP - menuH;
      menu.style.transformOrigin = 'bottom left';
    }
    Object.assign(box.style, { top: `${top}px`, left: `${r.left}px`, width: `${r.width}px`, height: `${r.height}px` });
    box.style.setProperty('--from', `${r.top - top}px`);
    const w = Math.min(260, vw - 2 * EDGE);
    Object.assign(menu.style, { top: `${menuTop}px`, left: `${Math.min(Math.max(EDGE, r.left), vw - EDGE - w)}px`, width: `${w}px` });
    return () => {
      anchor.style.visibility = '';
    };
  }, [anchor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div
      className={`press-menu ${closing ? 'closing' : ''}`}
      onPointerDown={() => (armed.current = true)}
      onClick={(e) => {
        if (armed.current && !(e.target as HTMLElement).closest('.press-list')) close();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="press-lift" ref={lift} />
      <div className="press-list" ref={list} role="menu">
        {items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            onClick={(e) => {
              // Only a press made in the menu (or a key, detail 0) chooses. The finger that opened it
              // lifts where the menu may now be: the row moved up to fit, or the list re-sorted mid-hold.
              if (armed.current || e.detail === 0) close(it.run);
            }}
          >
            <span className="grow">{it.label}</span>
            {it.icon && <Icon name={it.icon} size={18} />}
          </button>
        ))}
      </div>
    </div>
  );
}

/** What a session row's held-finger menu can do without opening the session first. */
export type SessionActions = { open: (w: Win) => void; pin: (w: Win) => void; fork: (w: Win) => void; kill: (w: Win) => void };
export const SessionActionsContext = createContext<SessionActions | null>(null);

/** A session row's menu: the desktop sidebar row's choices, in its words (Sidebar.tsx). */
export function sessionItems(w: Win, a: SessionActions): PressItem[] {
  const thenRun = (id: Parameters<typeof runCommandSoon>[0]) => () => {
    a.open(w);
    runCommandSoon(id);
  };
  return [
    { label: 'Open', icon: 'terminal', run: () => a.open(w) },
    { label: commandLabel('rename'), icon: 'edit', run: thenRun('rename') },
    { label: w.pinned ? 'Unpin' : commandLabel('pin'), icon: 'pin', run: () => a.pin(w) },
    ...(w.agent
      ? [
          { label: commandLabel('send-to'), icon: 'send' as const, run: thenRun('send-to') },
          { label: commandLabel('fork'), icon: 'fork' as const, run: () => a.fork(w) },
        ]
      : []),
    {
      label: commandLabel('terminate'),
      icon: 'trash',
      danger: true,
      run: () =>
        void confirmTerminate(w).then((ok) => {
          if (ok) a.kill(w);
        }),
    },
  ];
}

/** A session row's swipe actions (Swipe.tsx): Pin, then Terminate outermost, so a full swipe asks to terminate. */
export function sessionSwipes(w: Win, a: SessionActions): SwipeAction[] {
  return [
    { label: w.pinned ? 'Unpin' : 'Pin', icon: 'pin', tone: 'accent', run: () => a.pin(w) },
    {
      label: 'Terminate',
      icon: 'trash',
      tone: 'danger',
      run: () =>
        void confirmTerminate(w).then((ok) => {
          if (ok) a.kill(w);
        }),
    },
  ];
}
