import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ModelChoice, Preset } from './api.ts';
import type { CommandId } from './shortcuts.ts';
import { shortcutTitle, useCommand } from './shortcuts.tsx';
import { focusFirst } from './rove.ts';

/** Resolves an agent's preset (with its live model catalog) on a given host. */
export const PresetsContext = createContext<(host: string, id: string | null) => Preset | undefined>(() => undefined);
export const usePreset = (host: string, id: string | null) => useContext(PresetsContext)(host, id);
/** Every preset a host offers (to start or continue a conversation in another agent). */
export const HostPresetsContext = createContext<(host: string) => Preset[]>(() => []);

export type Pick = { model?: string; effort?: string };

/** Effort levels a model accepts: its own list, else the preset's. */
export function effortsFor(preset: Preset, model: ModelChoice | undefined): string[] {
  return model?.efforts ?? preset.effort?.levels ?? [];
}

/** The model actually in effect: the chosen one, else the harness default. */
export function effectiveModel(preset: Preset, id: string | undefined | null): ModelChoice | undefined {
  const models = preset.models ?? [];
  return models.find((m) => m.id === id) ?? (id && id !== 'default' ? { id, name: id, args: [] } : models.find((m) => m.isDefault));
}

const EFFORT_HINT: Record<string, string> = {
  none: 'No extra reasoning',
  minimal: 'Fastest, least reasoning',
  low: 'Fast responses with lighter reasoning',
  medium: 'Balanced speed and depth',
  high: 'Deeper reasoning for harder problems',
  xhigh: 'Extended reasoning for long, agentic work',
  max: 'Maximum reasoning',
  ultra: 'Everything it has',
};

const SHOWN = 5;

/** Model aliases, discovered versions, and an explicit model id. */
export function ModelPicker({ preset, value, onPick, footer, disabled = false }: { preset: Preset; value: Pick; onPick: (p: Pick) => void; footer?: React.ReactNode; disabled?: boolean }) {
  const models = preset.models ?? [];
  const current = effectiveModel(preset, value.model);
  const [all, setAll] = useState(() => models.findIndex((m) => m.id === current?.id) >= SHOWN);
  const [custom, setCustom] = useState('');
  const shown = all ? models : models.slice(0, SHOWN);

  function choose(id?: string) {
    const next = effectiveModel(preset, id);
    onPick({ model: id, effort: effortsFor(preset, next).includes(value.effort ?? '') ? value.effort : undefined });
  }

  return (
    <div className="picker" aria-label="Model">
      <div className="picker-title">Model</div>
      <button type="button" className="picker-name" disabled={disabled} onClick={() => choose()}>
        Default{preset.defaultModel ? ` · ${effectiveModel(preset, preset.defaultModel)?.name}` : ''}
        {!value.model && <span className="check">✓</span>}
      </button>
      {shown.map((m) => (
        <div key={m.id} className={`picker-row ${m.id === current?.id ? 'on' : ''}`}>
          <button type="button" className="picker-name" disabled={disabled} onClick={() => choose(m.id)} title={m.description}>
            {/* The Default row above already names the default; no "(default)" twice. */}
            <span>{m.name}</span>
            {value.model === m.id && <span className="check">✓</span>}
          </button>
        </div>
      ))}
      {models.length > SHOWN && (
        <button type="button" className="picker-more" onClick={() => setAll(!all)}>
          {all ? 'Fewer models' : 'More models'} <span aria-hidden>{all ? '▴' : '▾'}</span>
        </button>
      )}
      {preset.modelArgs && !disabled && (
        <div className="picker-custom">
          <label className="field">
            <span>Other model version</span>
            <input aria-label="Model ID" value={custom} onChange={(e) => setCustom(e.target.value)}
              placeholder="Exact model ID" maxLength={80} autoCapitalize="off" autoCorrect="off" spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (/^[A-Za-z0-9][\w.:/@-]{0,79}$/.test(custom.trim())) choose(custom.trim()); }
              }} />
          </label>
          <button type="button" className="btn ghost" disabled={!/^[A-Za-z0-9][\w.:/@-]{0,79}$/.test(custom.trim())} onClick={() => choose(custom.trim())}>Use model</button>
        </div>
      )}
      {footer && <div className="picker-foot">{footer}</div>}
    </div>
  );
}

export function EffortPicker({ levels, value, onPick, disabled = false, footer }: { levels: string[]; value?: string; onPick: (level?: string) => void; disabled?: boolean; footer?: React.ReactNode }) {
  return (
    <div className="picker" aria-label="Reasoning effort">
      <div className="picker-title">Reasoning effort</div>
      {[undefined, ...levels].map((level) => (
        <button type="button" key={level ?? 'default'} className="picker-name" disabled={disabled}
          title={level ? EFFORT_HINT[level] : 'Use the agent’s default effort'}
          onClick={() => onPick(level)}>
          <span className="picker-label">
            {level ? level.charAt(0).toUpperCase() + level.slice(1) : 'Default'}
            {/* A phone shows no title tooltip: its sheet shows what each level means. */}
            <span className="picker-hint">{level ? EFFORT_HINT[level] : 'The agent’s own default'}</span>
          </span>
          {level === value && <span className="check">✓</span>}
        </button>
      ))}
      {footer && <div className="picker-foot">{footer}</div>}
    </div>
  );
}

/** A button that opens a popover; closes on outside click or Escape. */
export function Popover({ label, className, children, up = true, align = 'left', title, command, active = false, tabIndex }: { label: React.ReactNode; className?: string; children: (close: () => void) => React.ReactNode; up?: boolean; align?: 'left' | 'right'; title?: string; command?: CommandId; active?: boolean; tabIndex?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useCommand(command ?? 'pick-model', () => setOpen((v) => !v), !!command && active);
  useEffect(() => {
    if (!open) return;
    // Opens on the current choice, as a native menu does; arrows move from there.
    const before = document.activeElement as HTMLElement | null;
    const current = body.current?.querySelector<HTMLElement>('.check')?.closest<HTMLElement>('button');
    if (current) current.focus();
    else focusFirst(body.current);
    const away = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // Claimed: whatever holds the picker (a screen, a composer) doesn't also close.
      e.preventDefault();
      setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
      // Closed by a choice or Escape: the keyboard goes back where it was (the composer,
      // when the picker came from a shortcut there), or to the button that opened it.
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected && !body.current?.contains(a) && a !== button.current) return;
      const back = before && before.isConnected && !body.current?.contains(before) ? before : button.current;
      requestAnimationFrame(() => back?.focus({ preventScroll: true }));
    };
  }, [open]);
  return (
    <div className="popover-wrap" ref={ref}>
      <button ref={button} type="button" className={className} tabIndex={tabIndex} aria-expanded={open} title={command ? shortcutTitle(title ?? '', command) : title} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div ref={body} data-rove className={`popover ${up ? 'up' : 'down'} ${align === 'right' ? 'right' : ''}`}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
