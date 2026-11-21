import { getOmarchyPalette, setThemeMode } from './theme.ts';
import { useTheme } from './useTheme.ts';
import { THEMES } from './settingsMenu.ts';
import { setWindowControls, useWindowControls, type WindowControlsMode } from './windowControls.ts';
import { setPictureLook, usePictureLook, type PictureLook } from './gui/pictureLook.ts';

const WINDOW: { id: WindowControlsMode; label: string }[] = [
  { id: 'auto', label: 'In a window' },
  { id: 'on', label: 'Always' },
  { id: 'off', label: 'Never' },
];

const PICTURES: { id: PictureLook; label: string }[] = [
  { id: 'stack', label: 'Stack' },
  { id: 'grid', label: 'Grid' },
];

/** Settings → Appearance: theme mode picker. Device-local, like layout. */
export function AppearancePanel() {
  const { mode } = useTheme();
  return (
    <div className="system-panels">
      <div className="sec-card">
        <h2>Theme</h2>
        <div className="seg" role="radiogroup" aria-label="Appearance">
          {THEMES.map((o) => (
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
      <PicturesInMessages />
      <WindowButtons />
    </div>
  );
}

/** How a message's pictures sit in the conversation (gui/pictureLook.ts). */
function PicturesInMessages() {
  const look = usePictureLook();
  return (
    <div className="sec-card">
      <h2>Pictures in messages</h2>
      <div className="seg" role="radiogroup" aria-label="Pictures in messages">
        {PICTURES.map((o) => (
          <button key={o.id} role="radio" aria-checked={look === o.id} className={look === o.id ? 'on' : ''} onClick={() => setPictureLook(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {look === 'stack'
          ? 'Several pictures in a message sit in a pile, the first on top. Tap it to see them all, and swipe through.'
          : 'Several pictures in a message sit side by side as tiles. Tap one to open it there, and swipe through.'}
      </p>
    </div>
  );
}

/** Room for iPadOS's window buttons (windowControls.ts): only on an iPad, or once changed. */
function WindowButtons() {
  const { mode, ipad, on } = useWindowControls();
  if (!ipad && mode === 'auto') return null;
  return (
    <div className="sec-card">
      <h2>Window buttons</h2>
      <div className="seg" role="radiogroup" aria-label="Room for window buttons">
        {WINDOW.map((o) => (
          <button key={o.id} role="radio" aria-checked={mode === o.id} className={mode === o.id ? 'on' : ''} onClick={() => setWindowControls(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="hint" style={{ margin: 0 }}>
        {`In a Stage Manager window iPadOS puts its window buttons over the top-left corner. ${
          mode === 'auto'
            ? `ah leaves a strip for them when it is a home-screen app in a window${on ? ', as it is now' : ''}.`
            : mode === 'on'
              ? 'ah always leaves a strip for them on this device.'
              : 'ah never leaves a strip for them on this device.'
        }`}
      </p>
    </div>
  );
}
