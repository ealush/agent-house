// The conversation's outline: one tick per message you sent, on the feed's left
// edge. The bright tick is the turn in view; a tick takes you to its message.
// Past MAX ticks the rail becomes a window that slides with the scroll, its
// edges fading where more messages lie beyond.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { calm } from '../motion.ts';

const PITCH = 12; // px per tick: matches .gui-rail-tick's height
const MAX = 15;

export type RailItem = { key: string; text: string };

export function MessageRail({ items, scroller, onJump }: { items: RailItem[]; scroller: RefObject<HTMLDivElement | null>; onJump: () => void }) {
  const [active, setActive] = useState(items.length - 1);
  const [focused, setFocused] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // The tick you clicked stays lit while its message is on screen, even when the
  // feed can't scroll it to the top (it's near the end).
  const chosen = useRef<number | null>(null);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const msgs = el.querySelectorAll<HTMLElement>('.msg.user');
      if (!msgs.length) return;
      const box = el.getBoundingClientRect();
      const pick = chosen.current !== null ? msgs[chosen.current]?.getBoundingClientRect() : undefined;
      if (pick && pick.bottom > box.top && pick.top < box.bottom) return setActive(chosen.current!);
      // The turn you're reading is the last one that starts above a third of the way down;
      // at the end it's the newest, however low it sits.
      let i = 0;
      if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) i = msgs.length - 1;
      else {
        const line = box.top + el.clientHeight / 3;
        for (let j = 0; j < msgs.length && msgs[j].getBoundingClientRect().top <= line; j++) i = j;
      }
      setActive(i);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    // Your own scrolling lets go of a clicked tick.
    const release = () => {
      chosen.current = null;
    };
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) el.addEventListener(type, release, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener('scroll', onScroll);
      for (const type of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) el.removeEventListener(type, release);
    };
  }, [scroller, items.length]);

  const jump = (i: number) => {
    const el = scroller.current;
    const msg = el?.querySelectorAll<HTMLElement>('.msg.user')[i];
    if (!el || !msg) return;
    onJump();
    chosen.current = i;
    setActive(i);
    const top = el.scrollTop + msg.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
    el.scrollTo({ top, behavior: calm() ? 'auto' : 'smooth' });
  };

  const n = items.length;
  const lit = Math.min(active, n - 1);
  // The window follows the keyboard while you're on the rail, the scroll otherwise.
  const lead = focused ?? lit;
  const first = n > MAX ? Math.max(0, Math.min(n - MAX, lead - Math.floor(MAX / 2))) : 0;
  const tip = hover ?? focused;

  return (
    <nav className="gui-rail" aria-label="Your messages" data-rove>
      <div className={`gui-rail-window${first > 0 ? ' more-above' : ''}${first + MAX < n ? ' more-below' : ''}`} style={{ height: Math.min(n, MAX) * PITCH }}>
        <div className="gui-rail-ticks" style={{ transform: `translateY(${-first * PITCH}px)` }}>
          {items.map((it, i) => (
            <button
              key={it.key}
              className="gui-rail-tick"
              tabIndex={i === lit ? 0 : -1}
              aria-current={i === lit ? 'true' : undefined}
              aria-label={`Message ${i + 1} of ${n}: ${it.text.slice(0, 120)}`}
              onClick={() => jump(i)}
              // A click leaves focus where it was (the composer, usually); only the keyboard moves onto the rail.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setFocused(i)}
              onBlur={() => setFocused(null)}
            />
          ))}
        </div>
      </div>
      {tip !== null && items[tip] && (
        <div className="gui-rail-tip" style={{ top: (tip - first) * PITCH + PITCH / 2 }} aria-hidden>
          {items[tip].text.replace(/\s+/g, ' ').trim() || 'Attachment'}
        </div>
      )}
    </nav>
  );
}
