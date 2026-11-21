import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThemeMode, resolveTheme, toggleMode, TERMINAL_THEME } from '../web/theme.ts';

test('unknown stored values fall back to system', () => {
  assert.equal(parseThemeMode('dark'), 'dark');
  assert.equal(parseThemeMode('light'), 'light');
  assert.equal(parseThemeMode('system'), 'system');
  assert.equal(parseThemeMode(null), 'system');
  assert.equal(parseThemeMode(''), 'system');
  assert.equal(parseThemeMode('midnight'), 'system');
  assert.equal(parseThemeMode(42), 'system');
});

test('pinned modes win over the OS; system follows it', () => {
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
});

test('quick toggle pins the opposite of what is on screen', () => {
  assert.equal(toggleMode('system', 'dark'), 'light');
  assert.equal(toggleMode('system', 'light'), 'dark');
  assert.equal(toggleMode('dark', 'dark'), 'light');
  assert.equal(toggleMode('light', 'light'), 'dark');
});

test('the terminal keeps one full dark ANSI palette in every UI theme', () => {
  const names = [
    'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground',
    'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
    'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
  ];
  for (const name of names) {
    assert.match(TERMINAL_THEME[name], /^#[0-9a-f]{6}([0-9a-f]{2})?$/, `terminal.${name}`);
  }
  assert.notEqual(TERMINAL_THEME.background, '#ffffff', 'terminal never takes the light canvas');
});

test('an Omarchy palette maps onto the UI tokens and the terminal, the way Omarchy maps its terminals', async () => {
  const { omarchyVars, omarchyTerminal, resolveTheme, setOmarchyPalette } = await import('../web/theme.ts');
  const p = { name: 'tokyo-night', mode: 'dark' as const, colors: { background: '#1a1b26', foreground: '#a9b1d6', bright_foreground: '#c0caf5', accent: '#7aa2f7', muted: '#414868', red: '#f7768e' } };
  const v = omarchyVars(p);
  assert.equal(v['--bg'], '#1a1b26');
  assert.equal(v['--accent'], '#7aa2f7');
  assert.equal(v['--text'], '#c0caf5');
  assert.equal(v['--accent-bg'], 'rgba(122, 162, 247, 0.12)');
  const t = omarchyTerminal(p);
  assert.equal(t.black, '#1a1b26', 'black is the background, like alacritty.toml.tpl');
  assert.equal(t.brightBlack, '#414868', 'bright black is muted');
  assert.equal(t.white, '#a9b1d6');
  setOmarchyPalette({ ...p, mode: 'light' });
  assert.equal(resolveTheme('omarchy', true), 'light', "the theme's own mode wins over the OS");
  setOmarchyPalette(null);
});
