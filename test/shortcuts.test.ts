import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMANDS,
  bindingError,
  chordFromEvent,
  commandActive,
  eventKey,
  chordParts,
  formatChord,
  handleShortcutKey,
  hintChord,
  matchShortcut,
  readOverrides,
  registerCommand,
  resolveChords,
  searchCommands,
  shortcutContext,
  fieldState,
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
  assert.equal(press('g', { ctrlKey: true, shiftKey: true, code: 'KeyG' }, 'field'), 'toggle-view');
  assert.equal(press('g', { code: 'KeyG' }, 'field'), null);
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

test('the command palette is Ctrl+Shift+P, and the side panel moves to Ctrl+Shift+J', () => {
  assert.equal(press('p', { ctrlKey: true, shiftKey: true, code: 'KeyP' }), 'command-palette');
  assert.equal(press('P', { metaKey: true, shiftKey: true, code: 'KeyP' }), 'command-palette');
  assert.equal(press('p', { ctrlKey: true, shiftKey: true, code: 'KeyP' }, 'field'), 'command-palette');
  assert.equal(press('p', { ctrlKey: true, shiftKey: true, code: 'KeyP' }, 'dialog'), null);
  assert.equal(press('p', { ctrlKey: true, shiftKey: true, code: 'KeyP' }, 'ask'), null);
  assert.equal(press('j', { ctrlKey: true, shiftKey: true, code: 'KeyJ' }), 'toggle-panel');
  assert.equal(whenLabel('command-palette'), 'Not in a dialog');
});

test('the command palette lists registered actions and ranks a typed query', () => {
  const stopInbox = registerCommand('go-inbox', () => {});
  const stopPanel = registerCommand('toggle-panel', () => {});
  const stopPalette = registerCommand('command-palette', () => {});
  try {
    assert.equal(commandActive('go-inbox'), true);
    assert.equal(commandActive('new-session'), false);
    const open = searchCommands('', { active: commandActive }).map((c) => c.id);
    assert.ok(open.includes('go-inbox'));
    assert.ok(open.includes('toggle-panel'));
    assert.ok(open.indexOf('go-inbox') < open.indexOf('toggle-panel'));
    assert.equal(open.includes('command-palette'), false);
    assert.equal(open.includes('new-session'), false);
    assert.equal(searchCommands('inbox', { active: commandActive })[0]?.id, 'go-inbox');
    const panel = searchCommands('panel', { mac: false, active: () => true }).map((c) => c.id);
    assert.equal(panel[0], 'toggle-panel');
    assert.equal(panel.includes('switcher'), false);
    assert.equal(searchCommands('ctrl+shift+j', { mac: false, active: commandActive })[0]?.id, 'toggle-panel');
    assert.equal(searchCommands('ctrl+alt+x', { mac: false, overrides: { 'go-inbox': [{ key: 'x', ctrl: true, alt: true }] }, active: () => true })[0]?.id, 'go-inbox');
    const all = searchCommands('', { active: () => true }).map((c) => c.id);
    assert.equal(all.includes('command-palette'), false);
    assert.ok(all.indexOf('switcher') < all.indexOf('go-inbox'));
    assert.ok(all.includes('terminate'));
    assert.equal(searchCommands('no-such-command', { active: () => true }).length, 0);
    const pane = searchCommands('pane', { active: () => true }).map((c) => c.id);
    assert.ok(pane.indexOf('focus-pane-left') < pane.indexOf('split-right'));
    assert.ok(pane.includes('split-below'));
    assert.ok(searchCommands('right', { active: () => true }).some((c) => c.id === 'split-right'));
  } finally {
    stopInbox();
    stopPanel();
    stopPalette();
  }
});

test('the shortcut table describes when a chord is allowed to fire', () => {
  assert.equal(whenLabel('switcher'), 'Anywhere except a confirm');
  assert.equal(whenLabel('cycle-next'), 'Not in a dialog');
  assert.equal(whenLabel('show-shortcuts'), 'Not in a dialog');
  assert.equal(whenLabel('new-session'), 'Not in a dialog');
  assert.equal(whenLabel('focus-pane-left'), 'Not in a dialog; while typing, only from the start of the text');
  assert.equal(whenLabel('close-pane'), 'Not in a dialog; while typing, only in an empty box');
  assert.equal(press('?', { ctrlKey: true, shiftKey: true, code: 'Slash' }), 'show-shortcuts');
});

test('split movement is directional, and terminate and exit split start unbound', () => {
  assert.equal(press('ArrowLeft', { ctrlKey: true, shiftKey: true, code: 'ArrowLeft' }), 'focus-pane-left');
  assert.equal(press('ArrowRight', { ctrlKey: true, shiftKey: true, code: 'ArrowRight' }), 'focus-pane-right');
  assert.equal(press('ArrowUp', { ctrlKey: true, shiftKey: true, code: 'ArrowUp' }), 'focus-pane-up');
  assert.equal(press('ArrowDown', { ctrlKey: true, shiftKey: true, code: 'ArrowDown' }), 'focus-pane-down');
  assert.equal(press('ArrowLeft', { ctrlKey: true, altKey: true, code: 'ArrowLeft' }), 'move-pane-left');
  assert.equal(press('ArrowRight', { ctrlKey: true, altKey: true, code: 'ArrowRight' }), 'move-pane-right');
  assert.equal(press('ArrowUp', { ctrlKey: true, altKey: true, code: 'ArrowUp' }), 'move-pane-up');
  assert.equal(press('ArrowDown', { ctrlKey: true, altKey: true, code: 'ArrowDown' }), 'move-pane-down');
  assert.equal(press('j', { ctrlKey: true, altKey: true, code: 'KeyJ' }), 'toggle-split');
  assert.equal(press('ArrowRight', { ctrlKey: true, shiftKey: true, code: 'ArrowRight' }, 'field'), null);
  assert.equal(press('ArrowLeft', { ctrlKey: true, altKey: true, code: 'ArrowLeft' }, 'field'), 'move-pane-left');
  assert.equal(press('ArrowUp', { ctrlKey: true, shiftKey: true, altKey: true, code: 'ArrowUp' }, 'field'), 'resize-up');
  assert.equal(press('\\', { ctrlKey: true, shiftKey: true, code: 'Backslash' }, 'field'), 'split-right');
  assert.equal(press('ArrowUp', { altKey: true, code: 'ArrowUp' }), 'cycle-prev');
  assert.deepEqual(resolveChords('terminate'), []);
  assert.deepEqual(resolveChords('exit-split'), []);
  assert.equal(hintChord('terminate', false), null);
});

test('in a text box, Ctrl+Shift+arrows select words until the caret reaches the edge', () => {
  const at = (value: string, start: number, end = start) => fieldState({ value, selectionStart: start, selectionEnd: end } as unknown as EventTarget);
  const go = (key: string, field: ReturnType<typeof fieldState>) => matchShortcut({ key, code: key, ...none, ctrlKey: true, shiftKey: true }, 'field', {}, field);
  assert.equal(go('ArrowLeft', at('hello', 3)), null);
  assert.equal(go('ArrowLeft', at('hello', 0)), 'focus-pane-left');
  assert.equal(go('ArrowUp', at('hello', 0)), 'focus-pane-up');
  assert.equal(go('ArrowRight', at('hello', 0)), null);
  assert.equal(go('ArrowRight', at('hello', 5)), 'focus-pane-right');
  assert.equal(go('ArrowDown', at('hello', 5)), 'focus-pane-down');
  assert.equal(go('ArrowRight', at('hello', 2, 5)), null, 'a selection still grows');
  assert.equal(go('ArrowRight', at('', 0)), 'focus-pane-right');
  assert.equal(go('Backspace', at('hello', 0)), null, 'Ctrl+Shift+Backspace still edits text');
  assert.equal(go('Backspace', at('', 0)), 'close-pane');
});

test('formatChord speaks Mac symbols and Linux words', () => {
  assert.equal(formatChord({ key: 'k', meta: true }, true), '⌘K');
  assert.equal(formatChord({ key: 'k', ctrl: true, shift: true }, false), 'Ctrl+Shift+K');
  assert.equal(formatChord({ key: 'ArrowUp', alt: true }, false), 'Alt+↑');
  assert.equal(formatChord({ key: 'Enter', ctrl: true, alt: true }, true), '⌃⌥Enter');
});

test('a chord drawn for the palette is one glyph per key', () => {
  assert.deepEqual(chordParts({ key: 'k', ctrl: true, shift: true }), ['⌃', '⇧', 'K']);
  assert.deepEqual(chordParts({ key: 'p', meta: true, shift: true }), ['⇧', '⌘', 'P']);
  assert.deepEqual(chordParts({ key: 'ArrowUp', alt: true }), ['⌥', '↑']);
  assert.deepEqual(chordParts({ key: 'Enter', ctrl: true, alt: true }), ['⌃', '⌥', 'Enter']);
  assert.deepEqual(chordParts({ key: 'Backspace', ctrl: true, shift: true }), ['⌃', '⇧', 'Backspace']);
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

test('no two commands share a default chord', () => {
  const seen = new Map<string, string>();
  for (const cmd of COMMANDS) {
    for (const c of cmd.chords) {
      const key = formatChord(c, false);
      assert.ok(!seen.has(key), `${key} is both ${seen.get(key)} and ${cmd.id}`);
      seen.set(key, cmd.id);
    }
  }
});

test('session actions fire from the composer, pane focus waits for the caret to reach an edge', () => {
  const e = (key: string, mods: { ctrl?: boolean; alt?: boolean; shift?: boolean }) => ({ key, code: /^\d$/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, metaKey: false, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift });
  assert.equal(matchShortcut(e('k', { ctrl: true, alt: true }), 'terminal'), 'toggle-keys');
  assert.equal(matchShortcut(e('k', { ctrl: true, alt: true }), 'field'), 'toggle-keys');
  assert.equal(matchShortcut(e('s', { ctrl: true, alt: true }), 'field'), 'send-now');
  assert.equal(matchShortcut(e('x', { ctrl: true, alt: true }), 'field'), 'interrupt');
  assert.equal(matchShortcut(e('4', { ctrl: true, alt: true }), 'field'), 'panel-queue');
  assert.equal(matchShortcut({ ...e('ArrowLeft', { ctrl: true, shift: true }), code: 'ArrowLeft' }, 'field'), null, 'mid-text it selects a word');
});
