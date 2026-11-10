import { useEffect, useLayoutEffect } from 'react';
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
import { AgentsPanel } from './AgentsSettings.tsx';
import { ShortcutsPanel } from './shortcuts.tsx';
import { Glide } from './Glide.tsx';
import { Icon } from './icons.tsx';
import { openSection, placeSettingsScroll, SECTIONS, sectionHash, useSectionPart, type Section } from './settingsMenu.ts';
import { getMode } from './theme.ts';

/**
 * `phone`: iOS Settings' shape. Bare #settings is the list of sections, grouped and
 * tiled; a section is a page of its own, named in the sheet's bar with Back to the
 * list (App.tsx). On a desktop bare #settings is Security, beside the section list.
 */
export function Settings({ onLocked, onNotifyChange, phone = false }: { onLocked: () => void; onNotifyChange: (active: boolean) => void; phone?: boolean }) {
  const part = useSectionPart();
  const section: Section = part ?? 'security';

  // In a narrow desktop window the sections are one row that scrolls: the one you're on stays in view.
  useEffect(() => {
    document.querySelector('.settings-nav .nav-item.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [section]);

  const go = (id: Section) => {
    location.hash = sectionHash(id);
  };
  useLayoutEffect(() => {
    if (phone) placeSettingsScroll(part);
  }, [phone, part]);

  if (phone && !part) return <SettingsList />;

  return (
    <div className={`page settings ${phone ? 'settings-page' : ''}`} data-title="Settings">
      {!phone && <header className="page-head">
        <div className="grow">
          <h1 className="page-title">Settings<span className="period">.</span></h1>
          <p className="tagline">This host's agents, sessions and server; this device's theme, keys and notifications.</p>
        </div>
      </header>}

      <div className="settings-body">
        {!phone && <nav className="settings-nav" aria-label="Settings sections" data-rove>
          <Glide match=".nav-item.on" className="side-glide" />
          {SECTIONS.map((s) => (
            <button key={s.id} className={`nav-item ${section === s.id ? 'on' : ''}`} aria-current={section === s.id ? 'page' : undefined} title={s.detail} onClick={() => go(s.id)}>
              <Icon name={s.icon} />
              <span className="grow">{s.label}</span>
            </button>
          ))}
        </nav>}

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
          {section === 'agents' && <AgentsPanel />}
          {section === 'subscriptions' && <SubscriptionsPanel />}
          {section === 'environment' && <EnvironmentPanel />}
          {section === 'search' && <SearchSettingsPanel />}
          {section === 'system' && <SystemPanel />}
        </div>
      </div>
    </div>
  );
}

// iOS Settings' groups: what this device keeps, then what the host does for every device.
const GROUPS: { name: string; ids: Section[] }[] = [
  { name: 'This device', ids: ['appearance', 'shortcuts', 'notifications'] },
  { name: 'This host', ids: ['security', 'agents', 'subscriptions', 'environment', 'search', 'system'] },
];
/** Each section's tile, as iOS Settings colors its icons. */
const TILE: Record<Section, string> = {
  appearance: 'var(--brand)',
  shortcuts: 'var(--muted)',
  notifications: 'var(--danger)',
  security: 'var(--run)',
  agents: 'var(--limited)',
  subscriptions: 'var(--done)',
  environment: 'var(--muted)',
  search: 'var(--muted)',
  system: 'var(--muted)',
};

function SettingsList() {
  const theme = getMode();
  return (
    <div className="page settings settings-list" data-title="Settings">
      <header className="page-head">
        <div className="grow">
          <h1 className="page-title">Settings<span className="period">.</span></h1>
          <p className="tagline">This host's agents, sessions and server; this device's theme, keys and notifications.</p>
        </div>
      </header>
      {GROUPS.map((g) => (
        <section key={g.name} className="ios-group">
          <h2 className="ios-group-name">{g.name}</h2>
          <ul className="ios-list">
            {g.ids.map((id) => {
              const s = SECTIONS.find((x) => x.id === id)!;
              return (
                <li key={id}>
                  <button className="ios-row" onClick={() => openSection(id)}>
                    <span className="ios-tile" style={{ background: TILE[id] }}>
                      <Icon name={s.icon} size={17} />
                    </span>
                    <span className="ios-label">{s.label}</span>
                    {id === 'appearance' && <span className="ios-value">{theme[0].toUpperCase() + theme.slice(1)}</span>}
                    <span className="ios-chevron" aria-hidden>
                      <Icon name="back" size={16} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
