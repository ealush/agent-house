import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { Glide } from './Glide.tsx';
import { Icon } from './icons.tsx';

// Every live session is in the Inbox (grouped by project when you want the sidebar's blocks);
// Search lists them with every past conversation, before you type.
const TABS = ['inbox', 'search'] as const;
export type Tab = (typeof TABS)[number];

// How far above or below the bar a sliding finger can stray and still pick a tab.
const SLOP = 48;

/** The tab a finger at (x, y) is over: the nearest one along the bar, or none once it leaves the bar. */
function tabAt(bar: DOMRect, tabs: { left: number; right: number }[], x: number, y: number): number | null {
  if (y < bar.top - SLOP || y > bar.bottom + SLOP) return null;
  let best = 0;
  let gap = Infinity;
  tabs.forEach((r, i) => {
    const d = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (d < gap) [best, gap] = [i, d];
  });
  return best;
}

/**
 * The phone's tab bar. Tap a tab, or press anywhere on the bar and slide: the thumb
 * follows the finger from tab to tab, and lifting it picks the tab under it, as on
 * iOS. Sliding well off the bar puts the thumb back and picks nothing.
 *
 * Beside it, apart, a round button opens the command palette: a phone has no
 * keyboard for its chord. iOS 26 sets its search tab apart the same way.
 */
export function TabBar({ shown, waiting, onPick, onCommands }: { shown: string; waiting: number; onPick: (tab: Tab) => void; onCommands: () => void }) {
  const nav = useRef<HTMLElement>(null);
  // The tab under the finger while it is down; the thumb shows it until the finger lifts.
  const [held, setHeld] = useState<Tab | null>(null);
  // A press already picked on lift: the click that follows it is the same press.
  const picked = useRef(false);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const under = (x: number, y: number): Tab | null => {
    const el = nav.current;
    if (!el) return null;
    const tabs = [...el.querySelectorAll<HTMLElement>(':scope > button')].map((b) => b.getBoundingClientRect());
    const i = tabAt(el.getBoundingClientRect(), tabs, x, y);
    return i === null ? null : TABS[i];
  };

  const press = (e: PointerEvent) => {
    if (e.button !== 0 || !e.isPrimary) return;
    picked.current = false;
    stop.current?.();
    const id = e.pointerId;
    setHeld(under(e.clientX, e.clientY));
    // On the window, so a mouse that leaves the bar is still followed (a finger always is).
    const move = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId === id) setHeld(under(ev.clientX, ev.clientY));
    };
    const lift = (ev: globalThis.PointerEvent) => {
      if (ev.pointerId !== id) return;
      end();
      setHeld(null);
      if (ev.type === 'pointercancel') return;
      picked.current = true;
      const tab = under(ev.clientX, ev.clientY);
      if (tab) onPick(tab);
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', lift);
      window.removeEventListener('pointercancel', lift);
      stop.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', lift);
    window.addEventListener('pointercancel', lift);
    stop.current = end;
  };

  // A keyboard (or assistive) click has no press before it: it picks here.
  const click = (e: MouseEvent, tab: Tab) => {
    if (picked.current && e.detail > 0) return;
    onPick(tab);
  };

  const on = held ?? shown;
  return (
    <div className="tabdock">
      <nav ref={nav} className={`tabbar ${held ? 'held' : ''}`} data-rove onPointerDown={press}>
        <Glide match=".on" className="thumb" />
        {TABS.map((p) => (
          <button key={p} className={on === p ? 'on' : ''} aria-current={shown === p ? 'page' : undefined} onClick={(e) => click(e, p)}>
            <span className="tab-icon">
              <Icon name={p} size={24} />
              {p === 'inbox' && waiting > 0 && <span className="badge">{waiting}</span>}
            </span>
            <span className="tab-label">{p[0].toUpperCase() + p.slice(1)}</span>
          </button>
        ))}
      </nav>
      <button type="button" className="tabdock-cmd" onClick={onCommands} aria-label="Commands">
        <Icon name="commands" size={24} />
      </button>
    </div>
  );
}
