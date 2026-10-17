import { look } from './agents.ts';
import type { Subscription } from './api.ts';
import { Icon } from './icons.tsx';
import { AgentLogo } from './logos.tsx';
import { Popover } from './ModelPicker.tsx';
import { logoFor } from './providers.ts';

/** A subscription's mark: its provider's logo, else a globe. */
export function SubscriptionMark({ s, size = 13 }: { s: Pick<Subscription, 'baseUrl' | 'model'>; size?: number }) {
  const logo = logoFor(s.baseUrl, s.model);
  return (
    <span className="chip sm" style={{ '--agent': logo ? look(logo).color : 'var(--accent)' } as React.CSSProperties}>
      {logo ? <AgentLogo id={logo} size={size} /> : <Icon name="globe" size={size} />}
    </span>
  );
}

/**
 * The one way to choose a subscription wherever one answers (side chat, a
 * Review thread, Send to, Review's briefings): a chip naming the one in use,
 * opening the list, with the active one marked and a way to Settings.
 */
export function SubscriptionPicker({
  subs,
  value,
  onPick,
  title = 'Subscription',
  note,
  up = true,
  disabled = false,
}: {
  subs: Subscription[];
  /** The subscription in use; the active one when unset. */
  value?: string | null;
  onPick: (id: string) => void;
  title?: string;
  /** What a pick changes, under the list. */
  note?: string;
  up?: boolean;
  disabled?: boolean;
}) {
  const current = subs.find((s) => s.id === value) ?? subs.find((s) => s.isDefault) ?? subs[0];
  if (!current) return null;
  return (
    <div className="sub-picker">
      <Popover
        up={up}
        title={`${title}: ${current.name} · ${current.model}`}
        className={`tool-chip sub-chip ${disabled ? 'static' : ''}`}
        label={
          <>
            <SubscriptionMark s={current} size={12} />
            <span className="grow">{current.name}</span>
            <span className="dim">{current.model}</span>
            <Icon name="chevron-down" size={12} />
          </>
        }
      >
        {(close) => (
          <div className="picker" aria-label={title}>
            <div className="picker-title">{title}</div>
            {subs.map((s) => (
              <button
                type="button"
                key={s.id}
                className="picker-name agent-option sub-option"
                disabled={disabled}
                onClick={() => {
                  if (s.id !== current.id) onPick(s.id);
                  close();
                }}
              >
                <SubscriptionMark s={s} />
                <span className="stack">
                  <span>
                    {s.name}
                    {s.isDefault && <span className="dim"> · active</span>}
                  </span>
                  <span className="sub">{s.model}</span>
                </span>
                {s.id === current.id && <span className="check">✓</span>}
              </button>
            ))}
            <div className="picker-foot">
              {note && <span>{note}</span>}
              <a href="#settings/subscriptions" onClick={close}>
                {subs.length > 1 ? 'Subscriptions' : 'Add another'}
              </a>
            </div>
          </div>
        )}
      </Popover>
    </div>
  );
}
