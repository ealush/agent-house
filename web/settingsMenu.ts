// Settings in the command palette. What a click does in settings runs right
// from the palette: the theme, reload, restart, rebuild, clear uploads.
// Anything that needs more than a click (typing a variable, signing in a
// device, a permission prompt) opens its settings page instead.
// The Settings page itself loads lazily, so this module keeps clear of it.
import { useEffect, useState } from 'react';
import { api } from './api.ts';
import { askConfirm, showError } from './ask.tsx';
import type { IconName } from './icons.tsx';
import type { PaletteNode } from './palette.ts';
import { getMode, setThemeMode, type ThemeMode } from './theme.ts';

export const SECTIONS = [
  { id: 'security', label: 'Security', icon: 'shield', detail: 'Devices, passkeys and sign-in' },
  { id: 'appearance', label: 'Appearance', icon: 'view', detail: 'Theme on this device' },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'keyboard', detail: 'Rebind keys on this device' },
  { id: 'notifications', label: 'Notifications', icon: 'bell', detail: 'Push alerts on this device' },
  { id: 'agents', label: 'Agents', icon: 'model', detail: 'Which agents New session offers, kept current with their CLIs' },
  { id: 'subscriptions', label: 'Subscriptions', icon: 'chat', detail: 'Chat providers for side chats' },
  { id: 'environment', label: 'Environment', icon: 'terminal', detail: 'Variables every session starts with' },
  { id: 'search', label: 'Search', icon: 'search', detail: 'Content search and its index' },
  { id: 'system', label: 'System', icon: 'gear', detail: 'Agent hooks, desktop app, server, uploads' },
] as const satisfies ReadonlyArray<{ id: string; label: string; icon: IconName; detail: string }>;

export type Section = (typeof SECTIONS)[number]['id'];

export const sectionHash = (id: Section) => (id === 'security' ? 'settings' : `settings/${id}`);

/** The section a hash names (#settings/agents), or null for bare #settings (Security on a desktop, the list on a phone). */
export function sectionPart(hash = typeof location === 'undefined' ? '' : location.hash): Section | null {
  const h = hash.replace(/^#/, '');
  const part = h.startsWith('settings/') ? h.slice('settings/'.length) : '';
  return SECTIONS.some((s) => s.id === part) ? (part as Section) : null;
}

/** The section in the hash, kept current: the phone's Settings sheet titles itself by it. */
export function useSectionPart(): Section | null {
  const [part, setPart] = useState(() => sectionPart());
  useEffect(() => {
    const on = () => setPart(sectionPart());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return part;
}

// A phone's Settings is a list you go into, as iOS's: a section opened from the list
// pushes, so Back pops to the list; one linked straight at returns to the list in place.
// The list and its sections scroll in one sheet: a section starts at its top, and Back
// finds the list where you left it (Settings.tsx).
let fromList = false;
let listTop = 0;
const sheet = () => document.querySelector<HTMLElement>('dialog.settings-sheet');
export function openSection(id: Section) {
  fromList = true;
  listTop = sheet()?.scrollTop ?? 0;
  location.hash = `settings/${id}`;
}
/** Where the phone's Settings sheet scrolls to as it shows a section (its top) or the list (where it was). */
export function placeSettingsScroll(section: Section | null) {
  const el = sheet();
  if (el) el.scrollTop = section ? 0 : listTop;
}
export function backToList() {
  if (fromList) history.back();
  else location.replace('#settings');
  fromList = false;
}

export const THEMES: { id: ThemeMode; label: string; hint: string }[] = [
  { id: 'system', label: 'System', hint: 'Follow the OS' },
  { id: 'dark', label: 'Dark', hint: 'Always dark' },
  { id: 'light', label: 'Light', hint: 'Always light' },
  { id: 'omarchy', label: 'Omarchy', hint: "Wear the host's Omarchy theme, and change with it" },
];

/** Confirm, then bounce the daemon. True once the restart is under way. */
export async function restartServer(): Promise<boolean> {
  if (
    !(await askConfirm({
      title: 'Restart the ah server?',
      body: 'The page disconnects for a few seconds while the server restarts. Sessions keep running.',
      confirm: 'Restart',
      danger: true,
    }))
  )
    return false;
  try {
    await api.restart();
    return true;
  } catch (e) {
    showError(e, "Couldn't restart the server");
    return false;
  }
}

/** Confirm, then rebuild the UI and restart. `onBuilding` runs once confirmed, while the build runs. */
export async function rebuildServer(onBuilding?: () => void): Promise<boolean> {
  if (
    !(await askConfirm({
      title: 'Rebuild and restart?',
      body: 'The old build is deleted, the UI is built again from this checkout, and then the server restarts. This takes longer than a restart. Sessions keep running.',
      confirm: 'Rebuild and restart',
      danger: true,
    }))
  )
    return false;
  onBuilding?.();
  try {
    await api.rebuild();
    return true;
  } catch (e) {
    showError(e, "Couldn't rebuild the server");
    return false;
  }
}

/** Confirm, then empty the uploads folder. The note to show, or null if cancelled or failed. */
export async function clearUploads(): Promise<string | null> {
  if (
    !(await askConfirm({
      title: 'Clear the uploads folder?',
      body: 'Everything in ~/.cache/ah/uploads is deleted.',
      confirm: 'Clear uploads',
      danger: true,
    }))
  )
    return null;
  try {
    const { removed } = await api.clearUploads();
    return removed === 0 ? 'Uploads folder is already empty.' : removed === 1 ? 'Cleared 1 file from the uploads folder.' : `Cleared ${removed} files from the uploads folder.`;
  } catch (e) {
    showError(e, "Couldn't clear the uploads folder");
    return null;
  }
}

const toast = (msg: string) => window.dispatchEvent(new CustomEvent('ah:toast', { detail: msg }));

/** Palette → Settings: the one-click settings, then every settings page. */
export function settingsNodes(open: (id: Section) => void): PaletteNode[] {
  const mode = getMode();
  return [
    {
      key: 'theme',
      label: 'Theme',
      icon: 'view',
      detail: 'System, dark, light or Omarchy, on this device',
      terms: ['appearance', 'dark mode'],
      children: THEMES.map((t) => ({
        key: `theme:${t.id}`,
        label: t.label,
        icon: 'view' as const,
        detail: t.id === mode ? `${t.hint} · In use` : t.hint,
        run: () => setThemeMode(t.id),
      })),
    },
    { key: 'reload-page', label: 'Reload page', command: 'reload-page', detail: 'Load the app again on this device. Sessions keep running.' },
    {
      key: 'restart-server',
      label: 'Restart server',
      icon: 'reload',
      detail: 'Bounce the ah server on this host. Sessions keep running.',
      terms: ['daemon', 'restart ah'],
      run: () => void restartServer().then((ok) => ok && toast('Restarting… this page reconnects when the server is back')),
    },
    {
      key: 'rebuild-server',
      label: 'Rebuild and restart',
      icon: 'reload',
      detail: 'Build the UI again from this checkout, then restart the server',
      terms: ['build', 'update'],
      run: () => void rebuildServer(() => toast('Rebuilding… the server restarts when the build finishes')).then((ok) => ok && toast('Restarting… this page reconnects when the server is back')),
    },
    {
      key: 'clear-uploads',
      label: 'Clear uploads folder',
      icon: 'trash',
      detail: 'Delete pasted and dropped files on this host',
      run: () => void clearUploads().then((note) => note && toast(note)),
    },
    {
      key: 'pages',
      label: 'Open settings',
      icon: 'gear',
      detail: 'Hooks, environment, notifications and the rest',
      children: SECTIONS.map((s) => ({ key: `settings:${s.id}`, label: s.label, icon: s.icon, detail: s.detail, run: () => open(s.id) })),
    },
  ];
}
