import { useEffect, useState } from 'react';
import { NotifySettings } from './NotifyDialog.tsx';
import { Security } from './Security.tsx';
import { SubscriptionsPanel } from './Subscriptions.tsx';
import { RecipesPanel } from './Recipes.tsx';

// Settings with a side panel: Security, Notifications, Subscriptions, Recipes.
import { SearchSettingsPanel } from './SearchSettings.tsx';
// Settings with a side panel: Security, Notifications, Subscriptions, Search.
// Sections are hash-addressable (#settings/subscriptions) so anything in the
// app can link straight at one.
const SECTIONS = [
  { id: 'security', label: 'Security' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'subscriptions', label: 'Subscriptions' },
  { id: 'recipes', label: 'Recipes' },
  { id: 'search', label: 'Search' },
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
          <p>Devices and sign-in, notifications for this device, and chat subscriptions for side chat.</p>
        </div>
      </header>

      <div className="settings-body">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item ${section === s.id ? 'on' : ''}`} aria-current={section === s.id ? 'page' : undefined} onClick={() => go(s.id)}>
              <span className="grow">{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="settings-content">
          {section === 'security' && <Security onLocked={onLocked} />}
          {section === 'notifications' && (
            <div className="sec-card">
              <NotifySettings onChange={onNotifyChange} />
            </div>
          )}
          {section === 'subscriptions' && <SubscriptionsPanel />}
          {section === 'recipes' && <RecipesPanel />}
          {section === 'search' && <SearchSettingsPanel />}
        </div>
      </div>
    </div>
  );
}
