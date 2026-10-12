import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanScreen, unwrap } from '../web/screenText.ts';

const trust = [
  ' Accessing workspace:',
  ' /tmp/claude-1000/-home-me-code-ah/e5664374-cf7c-4a39-b47e-659dd52da3b6/scr',
  ' atchpad/code/demo',
  ' Quick safety check: Is this a project you created or one you trust? (Like your',
  ' own code, a well-known open source project, or work from your team). If not,',
  " take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
];

test("a TUI's wrapping is undone: paths rejoin whole, sentences with a space", () => {
  assert.deepEqual(unwrap(trust), [
    'Accessing workspace:',
    '/tmp/claude-1000/-home-me-code-ah/e5664374-cf7c-4a39-b47e-659dd52da3b6/scratchpad/code/demo',
    "Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.",
    "Claude Code'll be able to read, edit, and execute files here.",
    'Security guide',
  ]);
});

test('lines the agent meant stay apart: short ones, capitals, indentation, commands', () => {
  const prompt = ['Bash command', '', '  npm test -- --watch=false --reporter=dot --coverage --runInBand --silent', '  run the tests', '', 'Do you want to proceed?'];
  assert.deepEqual(unwrap(prompt), ['Bash command', '', 'npm test -- --watch=false --reporter=dot --coverage --runInBand --silent', 'run the tests', '', 'Do you want to proceed?']);
});

test('rules are dropped before unwrapping', () => {
  assert.equal(cleanScreen('────────\nAllow this?\n────────'), 'Allow this?');
});
