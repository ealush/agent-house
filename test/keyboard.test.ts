import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyModifiers } from '../web/keyboard.ts';

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
