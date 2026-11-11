import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ModelPicker, EffortPicker, Popover } from './ModelPicker.tsx';
import { Icon } from './icons.tsx';
import { Sheet } from './sheet.tsx';
import { useCommand } from './shortcuts.tsx';
import type { Launch } from './useLaunch.ts';

/** The same session settings, composed for a pointer or a finger. */
export function ComposerOptions({ launch, compact, active }: { launch: Launch; compact: boolean; active: boolean }) {
  const { preset, models, model, modelLabel, effort, mode, levels, choose, chooseMode, openSettings } = launch;
  const [section, setSection] = useState<'settings' | 'model' | 'effort' | 'permissions' | null>(null);
  // Where the chip is, so an iPad's or a desktop's settings open as a popover over it (styles.css).
  const [anchor, setAnchor] = useState<React.CSSProperties | undefined>(undefined);
  const hasModel = !!preset && !!(models.length || preset.modelArgs || preset.settingsCommands?.model);
  const hasEffort = !!preset && !!(levels.length || preset.settingsCommands?.effort);
  const hasModes = (preset?.modes?.length ?? 0) > 1;
  useCommand('pick-model', () => setSection('model'), compact && active && hasModel);
  useCommand('pick-effort', () => setSection('effort'), compact && active && hasEffort);
  // Moving between its pages, the sheet keeps the height it has reached, as an iOS sheet does:
  // a shorter page no longer drops its top edge, a taller one raises it once.
  const tallest = useRef(0);
  useLayoutEffect(() => {
    const d = document.querySelector<HTMLElement>('dialog.composer-options');
    if (!section || !d) {
      tallest.current = 0;
      return;
    }
    d.style.minHeight = '';
    tallest.current = Math.max(tallest.current, d.getBoundingClientRect().height);
    // Never past the sheet's own cap (76dvh, or what a keyboard leaves): min-height would win.
    d.style.minHeight = `min(${tallest.current}px, 76dvh, var(--keyboard-vh, 100dvh))`;
  }, [section]);
  if (!preset || !(hasModel || hasEffort || hasModes)) return null;

  const close = () => setSection(null);
  const effortLabel = effort ? effort.charAt(0).toUpperCase() + effort.slice(1) : 'Default';
  // The mode's own name: Claude Code's default is "Ask before changes", not "Default".
  const modeLabel = mode?.name ?? 'Default';
  const modelsView = (done: () => void) => (
    <ModelPicker preset={preset} value={{ model: model?.id, effort }}
      disabled={!preset.switchModel && !preset.modelArgs}
      onPick={(p) => void choose({ model: p.model ?? 'default' }, done)}
      footer={!models.length && preset.settingsCommands?.model
        ? <button type="button" className="picker-native" onClick={() => openSettings('model', done)}>Choose model in terminal…</button>
        : <span>{preset.switchModel ? 'Changes this session' : 'Restarts this session with it'}</span>} />
  );
  const effortsView = (done: () => void) => (
    <EffortPicker levels={levels} value={effort} disabled={!preset.switchEffort && !preset.effort}
      onPick={(level) => void choose({ effort: level ?? 'default' }, done)}
      footer={!levels.length && preset.settingsCommands?.effort
        ? <button type="button" className="picker-native" onClick={() => openSettings('effort', done)}>Choose effort in terminal…</button>
        : <span>{preset.switchEffort ? 'Changes this session' : 'Restarts this session with it'}</span>} />
  );
  const modesView = (done: () => void) => (
    <div className="picker" aria-label="Permissions">
      <div className="picker-title">Permissions</div>
      {preset.modes!.map((m) => (
        <div key={m.id} className={`picker-row ${m.id === mode?.id ? 'on' : ''}`}>
          <button type="button" className="picker-name" title={m.description} onClick={() => void chooseMode(m.id, done)}>
            <span>{m.dangerous ? '⚠ ' : ''}{m.name}{m.description ? <span className="hint"> — {m.description}</span> : null}</span>
            {m.id === mode?.id && <span className="check">✓</span>}
          </button>
        </div>
      ))}
      <div className="picker-foot"><span>{preset.modeCycle ? 'Changes this session' : 'Restarts this session with it'}</span></div>
    </div>
  );

  if (!compact) return (
    <div className="composer-settings">
      {hasModel && <Popover className="tool-chip" title="Model version" label={<ChipLabel name="Model" value={modelLabel ?? 'Default'} />} command="pick-model" active={active}>{modelsView}</Popover>}
      {hasEffort && <Popover className="tool-chip" title="Reasoning effort" label={<ChipLabel name="Effort" value={effortLabel} />} command="pick-effort" active={active}>{effortsView}</Popover>}
      {hasModes && <Popover className={`tool-chip ${mode?.dangerous ? 'danger' : ''}`} title="Permission level" label={<ChipLabel name="Permissions" value={`${mode?.dangerous ? '⚠ ' : ''}${modeLabel}`} />}>{modesView}</Popover>}
    </div>
  );

  const title = section === 'model' ? 'Model' : section === 'effort' ? 'Reasoning effort' : section === 'permissions' ? 'Permissions' : 'Session settings';
  return (
    <>
      <button type="button" className={`composer-model ${mode?.dangerous ? 'danger' : ''}`}
        aria-label={`Session settings: ${modelLabel ?? preset.name}, ${effortLabel.toLowerCase()} effort, ${modeLabel.toLowerCase()} permissions`}
        aria-haspopup="dialog" aria-expanded={section !== null} onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor({ '--anchor-left': `${Math.round(Math.max(12, Math.min(r.left, innerWidth - 372)))}px`, '--anchor-bottom': `${Math.round(innerHeight - r.top + 8)}px` } as React.CSSProperties);
          setSection('settings');
        }}>
        {mode?.dangerous && <Icon name="shield" size={16} />}
        <span>{hasModel ? modelLabel ?? preset.name : 'Settings'}</span>
        <Icon name="chevron-down" size={14} />
      </button>
      {section && createPortal(
        <Sheet label="Session settings" title={title} className="composer-options" style={anchor} onClose={close}
          onBack={section !== 'settings' ? () => setSection('settings') : undefined} backLabel="Session settings">
          <div className="composer-options-head">
            {section !== 'settings' && <button type="button" className="icon-btn" aria-label="Back to Session settings" onClick={() => setSection('settings')}><Icon name="back" /></button>}
            <h2>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close session settings" onClick={close}><Icon name="close" /></button>
          </div>
          <div className="composer-options-body">
            {section === 'settings' ? (
              <>
                <p className="hint">For this conversation</p>
                {hasModel && <Setting icon="model" label="Model" value={modelLabel ?? 'Default'} onClick={() => setSection('model')} />}
                {hasEffort && <Setting icon="effort" label="Reasoning effort" value={effortLabel} onClick={() => setSection('effort')} />}
                {hasModes && <Setting icon="shield" label="Permissions" value={`${mode?.dangerous ? '⚠ ' : ''}${modeLabel}`} onClick={() => setSection('permissions')} />}
              </>
            ) : section === 'model' ? modelsView(close) : section === 'effort' ? effortsView(close) : modesView(close)}
          </div>
        </Sheet>, document.body)}
    </>
  );
}

function Setting({ icon, label, value, onClick }: { icon: string; label: string; value: string; onClick: () => void }) {
  return <button type="button" className="composer-option-row" onClick={onClick}><Icon name={icon} size={20} /><span><strong>{label}</strong><span>{value}</span></span><Icon name="chevron-right" size={16} /></button>;
}

function ChipLabel({ name, value }: { name: string; value: string }) {
  return <><span className="chip-key">{name}</span> {value}</>;
}
