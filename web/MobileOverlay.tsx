import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** A mobile overlay reserves its measured height in the content that scrolls
 * underneath it. The wrapper never filters: each visible plate samples the feed. */
export function MobileOverlay({ enabled, edge, floating, children }: { enabled: boolean; edge: 'top' | 'bottom'; floating: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!enabled || !el || !host) return;
    const property = edge === 'top' ? '--mobile-header-height' : '--mobile-composer-height';
    const previous = host.style.getPropertyValue(property);
    let height = -1;
    const measure = () => {
      const next = Math.ceil(el.getBoundingClientRect().height);
      if (next === height) return;
      height = next;
      host.style.setProperty(property, `${height}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      if (previous) host.style.setProperty(property, previous);
      else host.style.removeProperty(property);
    };
  }, [enabled, edge]);

  if (!enabled) return <>{children}</>;
  return <div ref={ref} className={`mobile-${edge === 'top' ? 'session-chrome' : 'composer-dock'}${floating ? ' floating' : ''}`}>{children}</div>;
}
