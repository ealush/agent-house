import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModifiers, cycleKey, terminalArrow } from '../web/keyboard.ts';

test('Shift changes letters, punctuation, Tab, and multiline Enter', () => {
  for (const [input, expected] of [['a', 'A'], ['1', '!'], ['/', '?'], ['-', '_'], ['\\', '|'], ['\t', '\x1b[Z'], ['\r', '\n']]) {
    assert.equal(applyModifiers(input, false, false, true), expected);
  }
  assert.equal(applyModifiers('already pasted text', false, false, true), 'already pasted text');
});

test('cursor keys encode combined modifiers, including application cursor mode', () => {
  assert.equal(applyModifiers('\x1b[A', false, false, true), '\x1b[1;2A');
  assert.equal(applyModifiers('\x1bOD', true, true, true), '\x1b[1;8D');
  assert.equal(applyModifiers('\x1b[1;2C', true, false), '\x1b[1;6C');
  assert.equal(applyModifiers('\x1b[A', false, false), '\x1b[A');
});

test('Ctrl and Alt continue to combine with character keys', () => {
  assert.equal(applyModifiers('c', true, false), '\x03');
  assert.equal(applyModifiers('c', true, true, true), '\x1b\x03');
  assert.equal(applyModifiers(' ', true, false), '\x00');
  assert.equal(applyModifiers('-', true, false, true), '\x1f');
});

test('sticky Alt with Left/Right moves by word, Up/Down stay modified cursors', () => {
  assert.equal(applyModifiers('\x1b[D', false, true), '\x1bb');
  assert.equal(applyModifiers('\x1b[C', false, true), '\x1bf');
  assert.equal(applyModifiers('\x1bOD', false, true), '\x1bb');
  assert.equal(applyModifiers('\x1b[A', false, true), '\x1b[1;3A');
  assert.equal(applyModifiers('\x1b[D', true, true), '\x1b[1;7D', 'Ctrl+Alt keeps the combined cursor');
  assert.equal(applyModifiers('\x1b[D', false, false), '\x1b[D');
});

test('terminal arrows: Cmd seeks line ends, Option seeks words, Option+Up/Down cycles', () => {
  const meta = { meta: true, alt: false, ctrl: false, shift: false };
  const alt = { meta: false, alt: true, ctrl: false, shift: false };
  const none = { meta: false, alt: false, ctrl: false, shift: false };
  assert.deepEqual(terminalArrow('ArrowLeft', meta), { send: '\x1b[H' });
  assert.deepEqual(terminalArrow('ArrowRight', meta), { send: '\x1b[F' });
  assert.deepEqual(terminalArrow('ArrowLeft', alt), { send: '\x1bb' });
  assert.deepEqual(terminalArrow('ArrowRight', alt), { send: '\x1bf' });
  assert.deepEqual(terminalArrow('ArrowUp', alt), { cycle: -1 });
  assert.deepEqual(terminalArrow('ArrowDown', alt), { cycle: 1 });
  assert.equal(terminalArrow('ArrowLeft', none), null);
  assert.equal(terminalArrow('ArrowUp', none), null);
  assert.equal(terminalArrow('a', meta), null);
  assert.equal(terminalArrow('ArrowLeft', { ...alt, shift: true }), null, 'Shift stays with xterm selection');
  assert.equal(terminalArrow('ArrowLeft', { ...alt, ctrl: true }), null, 'Ctrl combos pass through');
  assert.equal(terminalArrow('ArrowUp', { ...alt, meta: true }), null);
});

test('session cycling wraps and tolerates a missing anchor', () => {
  assert.equal(cycleKey([], 'a', 1), null);
  assert.equal(cycleKey(['a'], 'a', 1), 'a');
  assert.equal(cycleKey(['a', 'b', 'c'], 'b', 1), 'c');
  assert.equal(cycleKey(['a', 'b', 'c'], 'c', 1), 'a', 'wraps forward');
  assert.equal(cycleKey(['a', 'b', 'c'], 'a', -1), 'c', 'wraps backward');
  assert.equal(cycleKey(['a', 'b'], 'gone', 1), 'a');
  assert.equal(cycleKey(['a', 'b'], 'gone', -1), 'b');
  assert.equal(cycleKey(['a', 'b'], null, 1), 'a');
});
