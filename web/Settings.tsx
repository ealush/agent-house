import { useEffect, useState } from 'react';
import { NotifySettings } from './NotifyDialog.tsx';
import { Security } from './Security.tsx';
import { SubscriptionsPanel } from './Subscriptions.tsx';

// Settings with a side panel: Security, Appearance, Shortcuts, Notifications,
// Subscriptions, Search, System. Sections are hash-addressable
// (#settings/subscriptions) so anything in the app can link straight at one.
import { SearchSettingsPanel } from './SearchSettings.tsx';
import { AppearancePanel } from './Appearance.tsx';
import { SystemPanel } from './System.tsx';
import { ShortcutsPanel } from './shortcuts.tsx';
const SECTIONS = [
  { id: 'security', label: 'Security' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'search', label: 'Search' },
  { id: 'system', label: 'System' },
] as const;

type Section = (typeof SECTIONS)[number]['id'];

function sectionFromHash(): Section {
  const h = location.hash.slice(1);
  const part = h.startsWith('settings/') ? h.slice('settings/'.length) : '';
  return SECTIONS.some((s) => s.id === part) ? (part as Section) : 'security';
}

export function Settings({ onLocked, onNotifyChange }: { onLocked: () => void; onNotifyChange: (active: boolean) => void }) {
  const [section, setSection] = useState<Section>(sectionFromHash);

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (id: Section) => {
    location.hash = id === 'security' ? 'settings' : `settings/${id}`;
  };

  return (
    <div className="page settings">
      <header className="page-head">
        <div className="grow">
          <h1>Settings</h1>
          <p>Devices and sign-in, shortcuts on this device, notifications, and chat subscriptions for side chat.</p>
        </div>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections" data-rove>
          {SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item ${section === s.id ? 'on' : ''}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
              <span className="grow">{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'security' && <Security onLocked={onLocked} />}
          {section === 'appearance' && <AppearancePanel />}
          {section === 'shortcuts' && <ShortcutsPanel />}
          {section === 'notifications' && (
            <div className="sec-card">
              <h2>On this device</h2>
              <NotifySettings onChange={onNotifyChange} />
            </div>
          )}
          {section === 'subscriptions' && <SubscriptionsPanel />}
          {section === 'search' && <SearchSettingsPanel />}
          {section === 'system' && <SystemPanel />}
        </div>
      </div>
    </div>
  );
}
