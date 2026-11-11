import { useEffect, useRef, useState, type ReactNode } from 'react';
import { age, look } from './agents.ts';
import type { Win } from './api.ts';
import { Icon } from './icons.tsx';
import { AgentLogo } from './logos.tsx';

/**
 * Handoff, like Apple's: the session you were just using on another device,
 * one tap away here. Shown at the top of the sidebar (desktop) or the inbox
 * (phone) until you open it, dismiss it, or use this device.
 */
export function HandoffOffer({ w, device, at, onOpen, onDismiss }: { w: Win; device: string; at: number; onOpen: () => void; onDismiss: () => void }) {
  const ago = age(at / 1000);
  return (
    <div className="handoff" role="status">
      <button className="handoff-open" onClick={onOpen} title={`Open ${w.title}`}>
        <span className="chip sm" style={{ '--agent': look(w.agent).color } as React.CSSProperties}>
          <AgentLogo id={w.agent} size={13} />
        </span>
        <span className="handoff-text">
          <span className="handoff-from">
            Continue from {device}
            {ago && ago !== 'now' ? ` · ${ago}` : ''}
          </span>
          <span className="handoff-title">{w.title}</span>
        </span>
      </button>
      <button className="icon-btn small" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

/**
 * Where the offer sits (the sidebar's top, the inbox's): it opens its room as it arrives and
 * closes it as it goes, so the list beside it moves instead of jumping the card's height
 * under the pointer. Leaving, it keeps the card it had (inert) until the room has closed.
 */
export function Reveal({ children }: { children: ReactNode }) {
  const last = useRef<ReactNode>(null);
  const [, gone] = useState(0);
  if (children) last.current = children;
  const present = !!children;
  useEffect(() => {
    if (present || !last.current) return;
    const t = window.setTimeout(() => {
      last.current = null;
      gone((n) => n + 1);
    }, 260);
    return () => window.clearTimeout(t);
  }, [present]);
  const body = children || last.current;
  if (!body) return null;
  return (
    <div className={`reveal${present ? '' : ' out'}`} inert={!present || undefined}>
      <div className="reveal-in">{body}</div>
    </div>
  );
}
