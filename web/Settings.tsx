import { useEffect, useState } from 'react';
import { NotifySettings } from './NotifyDialog.tsx';
import { Security } from './Security.tsx';
import { SubscriptionsPanel } from './Subscriptions.tsx';
import { EnvironmentPanel } from './Environment.tsx';

// Settings with a side panel: Security, Appearance, Shortcuts, Notifications,
// Subscriptions, Environment, Search, System. Sections are hash-addressable
// (#settings/subscriptions) so anything in the app can link straight at one.
import { SearchSettingsPanel } from './SearchSettings.tsx';
import { AppearancePanel } from './Appearance.tsx';
import { SystemPanel } from './System.tsx';
import { ShortcutsPanel } from './shortcuts.tsx';
import { Glide } from './Glide.tsx';
import { SECTIONS, sectionHash, type Section } from './settingsMenu.ts';

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
    location.hash = sectionHash(id);
  };

  return (
    <div className="page settings" data-title="Settings">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">Settings<span className="period">.</span></h1>
          <p className="tagline">Devices and sign-in, shortcuts on this device, notifications, chat subscriptions, and what your sessions start with.</p>
        </div>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections" data-rove>
          <Glide match=".nav-item.on" className="side-glide" />
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
          {section === 'environment' && <EnvironmentPanel />}
          {section === 'search' && <SearchSettingsPanel />}
          {section === 'system' && <SystemPanel />}
        </div>
      </div>
    </div>
  );
}
