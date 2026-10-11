import { getOmarchyPalette, setThemeMode, type ThemeMode } from './theme.ts';
import { useTheme } from './useTheme.ts';

const OPTIONS: { id: ThemeMode; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follow the OS' },
  { id: 'dark', label: 'Dark', hint: 'Always dark' },
  { id: 'light', label: 'Light', hint: 'Always light' },
  { id: 'omarchy', label: 'Omarchy', hint: "Wear the host's Omarchy theme, and change with it" },
];

/** Settings → Appearance: theme mode picker. Device-local, like layout. */
export function AppearancePanel() {
  const { mode } = useTheme();
  return (
    <div className="sec-card">
      <h2>Theme</h2>
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
        {mode === 'omarchy'
          ? getOmarchyPalette()
            ? `Wearing the host's Omarchy theme (${getOmarchyPalette()!.name || 'current'}) on this device; it changes when you switch themes there.`
            : "Following the host's Omarchy theme. None found yet: is the host running Omarchy?"
          : mode === 'system'
          ? 'Following your OS setting on this device.'
          : mode === 'dark'
            ? 'Dark on this device, whatever the OS says.'
            : 'Light on this device, whatever the OS says.'}
      </p>
    </div>
  );
}
