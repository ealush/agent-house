import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingError,
  chordFromEvent,
  eventKey,
  formatChord,
  handleShortcutKey,
  hintChord,
  matchShortcut,
  readOverrides,
  registerCommand,
  resolveChords,
  shortcutContext,
  whenLabel,
  type Chord,
} from '../web/shortcuts.ts';

const none = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

function press(key: string, mod: Partial<typeof none> & { code?: string } = {}, scope: 'app' | 'terminal' | 'field' | 'dialog' | 'ask' = 'app', overrides = {}) {
  const code = mod.code ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key);
  return matchShortcut({ key, code, ...none, ...mod }, scope, overrides);
}

test('switcher is ⌘K and Ctrl+Shift+K, and session cycling is Alt+Up/Down', () => {
  assert.equal(press('k', { metaKey: true, code: 'KeyK' }), 'switcher');
  assert.equal(press('K', { ctrlKey: true, shiftKey: true, code: 'KeyK' }), 'switcher');
  assert.equal(press('ArrowUp', { altKey: true, code: 'ArrowUp' }), 'cycle-prev');
  assert.equal(press('ArrowDown', { altKey: true, code: 'ArrowDown' }), 'cycle-next');
  assert.equal(press('ArrowUp', { altKey: true, shiftKey: true, code: 'ArrowUp' }), null);
  assert.equal(press('k', { code: 'KeyK' }), null, 'a plain letter is never a shortcut');
});

test('digits and punctuation keep their unshifted name when Shift is held', () => {
  assert.equal(eventKey({ key: '!', code: 'Digit1' }), '1');
  assert.equal(eventKey({ key: '|', code: 'Backslash' }), '\\');
  assert.equal(eventKey({ key: '_', code: 'Minus' }), '-');
  assert.equal(press('!', { ctrlKey: true, shiftKey: true, code: 'Digit1' }), 'go-inbox');
  assert.equal(press('|', { ctrlKey: true, shiftKey: true, code: 'Backslash' }), 'split-right');
  assert.equal(press('_', { ctrlKey: true, shiftKey: true, code: 'Minus' }), 'split-below');
});

test('scope: typing keeps letters, dialogs keep only the switcher, ask dialogs keep everything', () => {
  assert.equal(press('ArrowDown', { altKey: true, code: 'ArrowDown' }, 'field'), 'cycle-next');
  assert.equal(press('g', { ctrlKey: true, shiftKey: true, code: 'KeyG' }, 'field'), null);
  assert.equal(press('k', { metaKey: true, code: 'KeyK' }, 'field'), 'switcher');
  assert.equal(press('Enter', { ctrlKey: true, shiftKey: true, code: 'Enter' }, 'dialog'), null);
  assert.equal(press('k', { ctrlKey: true, shiftKey: true, code: 'KeyK' }, 'dialog'), 'switcher');
  assert.equal(press('k', { metaKey: true, code: 'KeyK' }, 'ask'), null);
  assert.equal(press('g', { ctrlKey: true, shiftKey: true, code: 'KeyG' }, 'terminal'), 'toggle-view');
});

test('context follows the open dialog, then the terminal, then a text field', () => {
  const root = { querySelector: (sel: string) => (sel === 'dialog.ask[open]' ? null : sel === 'dialog[open]' ? ({}) : null) };
  assert.equal(shortcutContext(null, root), 'dialog');
  const ask = { querySelector: (sel: string) => (sel === 'dialog.ask[open]' ? ({}) : null) };
  assert.equal(shortcutContext(null, ask), 'ask');
  const term = { closest: (sel: string) => (sel === '.xterm' ? ({}) : null) };
  assert.equal(shortcutContext(term as unknown as EventTarget, { querySelector: () => null }), 'terminal');
  const field = { closest: (sel: string) => (sel.startsWith('input') ? ({}) : null) };
  assert.equal(shortcutContext(field as unknown as EventTarget, { querySelector: () => null }), 'field');
});

test('overrides replace defaults, and null unbinds', () => {
  const custom: Chord = { key: 'j', ctrl: true, shift: true };
  const overrides = { 'cycle-next': [custom], 'toggle-sidebar': null };
  assert.equal(press('j', { ctrlKey: true, shiftKey: true, code: 'KeyJ' }, 'app', overrides), 'cycle-next');
  assert.equal(press('ArrowDown', { altKey: true, code: 'ArrowDown' }, 'app', overrides), null);
  assert.equal(press('e', { ctrlKey: true, shiftKey: true, code: 'KeyE' }, 'app', overrides), null);
  assert.deepEqual(resolveChords('toggle-sidebar', overrides), []);
  assert.equal(hintChord('switcher', false)?.key, 'k');
  assert.equal(hintChord('switcher', false)?.meta, undefined);
  assert.equal(hintChord('switcher', true)?.meta, true);
});

test('a stored blob drops unknown ids and bare keys', () => {
  const parsed = readOverrides(JSON.stringify({ switcher: [{ key: 'p', ctrl: true }], 'nope': [{ key: 'a', ctrl: true }], 'new-session': [{ key: 'x' }], 'go-inbox': null }));
  assert.deepEqual(parsed.switcher, [{ key: 'p', ctrl: true }]);
  assert.equal(parsed['new-session']?.length, 0);
  assert.equal(parsed['go-inbox'], null);
  assert.equal('nope' in parsed, false);
});

test('a chord cannot be bare, and cannot duplicate another command', () => {
  assert.match(bindingError('new-session', { key: 'n' }, {}) ?? '', /Ctrl, Alt, or Super/);
  assert.match(bindingError('new-session', { key: 'k', ctrl: true, shift: true }, {}) ?? '', /Search or jump/);
  assert.equal(bindingError('switcher', { key: 'k', meta: true }, {}), null);
});

test('the shortcut table describes when a chord is allowed to fire', () => {
  assert.equal(whenLabel('switcher'), 'Anywhere except a confirm');
  assert.equal(whenLabel('cycle-next'), 'Not in a dialog');
  assert.equal(whenLabel('show-shortcuts'), 'Not in a dialog');
  assert.equal(whenLabel('new-session'), 'Not while typing or in a dialog');
  assert.equal(press('?', { ctrlKey: true, shiftKey: true, code: 'Slash' }), 'show-shortcuts');
});

test('split movement is directional, and terminate and exit split start unbound', () => {
  assert.equal(press('ArrowLeft', { ctrlKey: true, shiftKey: true, code: 'ArrowLeft' }), 'focus-pane-left');
  assert.equal(press('ArrowRight', { ctrlKey: true, shiftKey: true, code: 'ArrowRight' }), 'focus-pane-right');
  assert.equal(press('ArrowUp', { ctrlKey: true, shiftKey: true, code: 'ArrowUp' }), 'focus-pane-up');
  assert.equal(press('ArrowDown', { ctrlKey: true, shiftKey: true, code: 'ArrowDown' }), 'focus-pane-down');
  assert.equal(press('ArrowRight', { ctrlKey: true, shiftKey: true, code: 'ArrowRight' }, 'field'), null);
  assert.equal(press('ArrowUp', { altKey: true, code: 'ArrowUp' }), 'cycle-prev');
  assert.deepEqual(resolveChords('terminate'), []);
  assert.deepEqual(resolveChords('exit-split'), []);
  assert.equal(hintChord('terminate', false), null);
});

test('formatChord speaks Mac symbols and Linux words', () => {
  assert.equal(formatChord({ key: 'k', meta: true }, true), '⌘K');
  assert.equal(formatChord({ key: 'k', ctrl: true, shift: true }, false), 'Ctrl+Shift+K');
  assert.equal(formatChord({ key: 'ArrowUp', alt: true }, false), 'Alt+↑');
  assert.equal(formatChord({ key: 'Enter', ctrl: true, alt: true }, true), '⌃⌥Enter');
});

test('the listener runs the newest handler and lets an unbound chord through', () => {
  let n = 0;
  const stop = registerCommand('go-settings', () => n++);
  const event = (key: string, code: string, mod: Partial<typeof none> = {}) => {
    let prevented = false;
    const e = {
      key,
      code,
      ...none,
      ...mod,
      repeat: false,
      isComposing: false,
      target: null,
      preventDefault() { prevented = true; },
      stopPropagation() {},
    };
    handleShortcutKey(e as unknown as KeyboardEvent);
    return prevented;
  };
  assert.equal(event('3', 'Digit3', { ctrlKey: true, shiftKey: true, key: '3' }), true);
  assert.equal(n, 1);
  stop();
  assert.equal(event('3', 'Digit3', { ctrlKey: true, shiftKey: true }), false);
  assert.equal(chordFromEvent({ key: 'Control', code: 'ControlLeft', ...none, ctrlKey: true }), null);
});
