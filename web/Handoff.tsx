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
