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
