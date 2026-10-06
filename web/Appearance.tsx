import { setThemeMode, type ThemeMode } from './theme.ts';
import { useTheme } from './useTheme.ts';

const OPTIONS: { id: ThemeMode; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follow the OS' },
  { id: 'dark', label: 'Dark', hint: 'Always dark' },
  { id: 'light', label: 'Light', hint: 'Always light' },
];

/** Settings → Appearance: theme mode picker. Device-local, like layout. */
export function AppearancePanel() {
  const { mode } = useTheme();
  return (
    <div className="sec-card">
      <div className="seg" role="radiogroup" aria-label="Appearance">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            role="radio"
            aria-checked={mode === o.id}
            className={mode === o.id ? 'on' : ''}
            title={o.hint}
            onClick={() => setThemeMode(o.id)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {mode === 'system'
          ? 'Following your OS setting on this device.'
          : mode === 'dark'
            ? 'Dark on this device, whatever the OS says.'
            : 'Light on this device, whatever the OS says.'}
      </p>
    </div>
  );
}
