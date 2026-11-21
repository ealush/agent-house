import { test } from 'node:test';
import assert from 'node:assert/strict';
import { livePath, pendingInput } from './tmux.ts';

const rule = '─'.repeat(60);
const claude = (box: string[], below = ['  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents']) =>
  [' ▐▛███▛█   Claude Code v2.1.288', '❯ Reply with just the word PONG', '● PONG', '', rule, ...box, rule, ...below].join('\n');

test("pendingInput reads what's typed but not sent in Claude Code's input box", () => {
  assert.equal(pendingInput(claude(['❯ '])), '');
  assert.equal(pendingInput(claude(['❯'])), '');
  assert.equal(pendingInput(claude(['❯ Try "edit core.ts to..."'])), '', 'the hint is not input');
  assert.equal(pendingInput(claude(['❯ fix the bug'])), 'fix the bug');
  assert.equal(pendingInput(claude(['❯ Reply with just the word PONG.[Pasted text #1 +89 lines]'])), 'Reply with just the word PONG.[Pasted text #1 +89 lines]');
  assert.equal(pendingInput(claude(['❯ first line', '  second line'])), 'first line second line');
  assert.equal(pendingInput(claude(['❯ fix it'], ['  /model   Set the AI model', '  /mcp     Manage MCP servers'])), 'fix it', 'an open menu below the box');
});

test('pendingInput is null without an input box: shells, dialogs, other TUIs', () => {
  assert.equal(pendingInput('ah main ❯ ls\nREADME.md\nah main ❯ '), null);
  assert.equal(pendingInput([rule, ' Bash command', '   rm -rf dist', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', rule].join('\n')), null);
  assert.equal(pendingInput([rule, '❯ 1. Red', '  2. Green', rule].join('\n')), null, "a picker's cursor");
  assert.equal(pendingInput(['› Write tests for @filename', '', '  ⏎ send   ⌃J newline'].join('\n')), null);
  assert.equal(pendingInput(''), null);
});

test('a TMUX_TMPDIR that is gone is refused, never resolved to the default tmux server', async () => {
  const { tmux, cleanEnv } = await import('./tmux.ts');
  const before = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = '/nonexistent/ah-tmux-dir-gone';
  try {
    assert.throws(() => cleanEnv(), /TMUX_TMPDIR .* is gone/);
    // A read, so that even a broken guard couldn't hurt the server it would reach.
    await assert.rejects(tmux('list-sessions'), /TMUX_TMPDIR .* is gone/);
  } finally {
    if (before === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = before;
  }
});

test("a pane in a deleted folder is still in that folder, not in one called '… (deleted)'", () => {
  assert.equal(livePath('/home/u/code/ah-native (deleted)'), '/home/u/code/ah-native');
  assert.equal(livePath('/home/u/code/ah-native'), '/home/u/code/ah-native');
  assert.equal(livePath('/home/u/notes (deleted) draft'), '/home/u/notes (deleted) draft', 'only the suffix /proc adds');
});
