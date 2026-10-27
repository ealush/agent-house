import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatSteps, checkAnswers, claudeQuestionSteps, cursorKeys, dialogSteps, parsePicker, parseQuestionDialog, parseScreenOptions, pickerAtStart, readQuestions, type Question } from './choices.ts';

// Screens captured from Claude Code 2.1.288 and Codex.
const CLAUDE_PERMISSION = `
 Bash command
   rm -rf build
   Remove the build folder
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for rm commands in /tmp/x
   3. No, and tell Claude what to do differently (esc)
`.split('\n');

const CODEX_APPROVAL = `
  Would you like to run the following command?
  $ pnpm test
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for this command (a)
  3. No, and tell Codex what to do differently (esc)
`.split('\n');

const CLAUDE_QUESTIONS = `
←  ☐ Color  ☐ Toppings  ✔ Submit  →
Pick a color
❯ 1. Red
     Choose red
  2. Green
     Choose green
  3. Blue
     Choose blue
  4. Type something.
────────────────────────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

const Q2: Question[] = [
  { question: 'Pick a color', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
  { question: 'Pick toppings', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Basil' }] },
];

test('reads a permission prompt as numbered options', () => {
  assert.deepEqual(parseScreenOptions(CLAUDE_PERMISSION), [
    { key: '1', label: 'Yes' },
    { key: '2', label: "Yes, and don't ask again for rm commands in /tmp/x" },
    { key: '3', label: 'No, and tell Claude what to do differently (esc)' },
  ]);
});

test('a picker carries the lines above it as context', () => {
  assert.equal(parsePicker(CLAUDE_PERMISSION)?.context, 'Bash command\n  rm -rf build\n  Remove the build folder\nDo you want to proceed?');
  const review = ['──────────', 'Review your answers', ' ● Which database?', '   → SQLite', 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel'];
  assert.equal(parsePicker(review)?.context, 'Review your answers\n ● Which database?\n   → SQLite\nReady to submit your answers?');
});

test('a shown hotkey is typed instead of the digit', () => {
  assert.deepEqual(
    parseScreenOptions(CODEX_APPROVAL).map((o) => o.key),
    ['y', 'a', '3'],
  );
});

test('a numbered list in prose is not a picker', () => {
  assert.deepEqual(parseScreenOptions(['Steps:', '1. Build it', '2. Test it', '3. Ship it']), []);
  assert.deepEqual(parseScreenOptions(['❯ 2. Out of order', '  3. Rows']), []);
});

test('a fresh dialog: one key per single choice, toggles then → for multi, 1 to submit', () => {
  const steps = claudeQuestionSteps(Q2, [{ picked: [1] }, { picked: [2, 0] }]);
  assert.deepEqual(steps, [{ keys: ['2'] }, { keys: ['1'] }, { keys: ['3'] }, { keys: ['Right'] }, { keys: ['1'] }]);
});

test('one single-choice question submits on its digit', () => {
  assert.deepEqual(claudeQuestionSteps([Q2[0]], [{ picked: [2] }]), [{ keys: ['3'] }]);
});

test('typed answers go to the "Type something" row', () => {
  assert.deepEqual(claudeQuestionSteps([Q2[0]], [{ picked: [], text: 'Mango' }]), [{ keys: ['4'] }, { text: 'Mango' }, { keys: ['Enter'] }]);
  assert.deepEqual(claudeQuestionSteps([Q2[1]], [{ picked: [1], text: 'Fox' }]), [
    { keys: ['2'] },
    { keys: ['Down', 'Down', 'Down'] },
    { text: 'Fox' },
    { keys: ['Tab'] },
    { keys: ['Enter'] },
    { keys: ['1'] },
  ]);
});

test('answers must fit the questions', () => {
  assert.throws(() => checkAnswers(Q2, [{ picked: [0] }]), /every question/);
  assert.throws(() => checkAnswers([Q2[0]], [{ picked: [0, 1] }]), /pick one/);
  assert.throws(() => checkAnswers([Q2[0]], [{ picked: [0], text: 'and this' }]), /pick one/);
  assert.throws(() => checkAnswers([Q2[0]], [{ picked: [7] }]), /unknown option/);
  assert.throws(() => checkAnswers([Q2[1]], [{ picked: [] }]), /at least one/);
  assert.throws(() => checkAnswers([Q2[0]], [{ picked: [], text: 'two\nlines' }]), /one line/);
});

test('keys go only into a fresh dialog showing the first question', () => {
  assert.equal(pickerAtStart(CLAUDE_QUESTIONS, Q2), true);
  assert.equal(pickerAtStart(CLAUDE_QUESTIONS.replace('☐ Color', '☒ Color'), Q2), false);
  assert.equal(pickerAtStart(CLAUDE_QUESTIONS.replace('❯ 1. Red', '  1. Red').replace('  2. Green', '❯ 2. Green'), Q2), false);
  assert.equal(pickerAtStart(CLAUDE_QUESTIONS, [{ ...Q2[0], question: 'Something else' }]), false);
  assert.equal(pickerAtStart('❯ 1. Yes\n  2. No', Q2), false);
});

test('reads AskUserQuestion input', () => {
  assert.equal(readQuestions({}), null);
  assert.deepEqual(readQuestions({ questions: [{ question: 'Q', options: [{ label: 'A', description: 'a' }, { nope: 1 }] }] }), [
    { question: 'Q', header: undefined, multiSelect: false, options: [{ label: 'A', description: 'a' }] },
  ]);
});

const DIALOG_MULTI = `
←  ☒ Database  ☐ Extras  ✔ Submit  →
Which extras?
  1. [✔] Auth
         Authentication and user management
❯ 2. [ ] Search
         Full-text search
  3. [ ] Billing
  4. [ ] Type something
     Submit
────────────────────
  5. Chat about this
Enter to select · Tab/Arrow keys to navigate · Esc to cancel`.split('\n');

test('reads the question a dialog shows, with ticks and cursor', () => {
  const q = parseQuestionDialog(DIALOG_MULTI)!;
  assert.deepEqual(q, {
    question: 'Which extras?',
    multiSelect: true,
    options: [
      { label: 'Auth', checked: true, description: 'Authentication and user management' },
      { label: 'Search', checked: false, description: 'Full-text search' },
      { label: 'Billing', checked: false },
    ],
    cursor: 2,
    total: 2,
    answered: 1,
  });
  // Typed text replaces "Type something": not a state to answer from outside.
  assert.equal(parseQuestionDialog(DIALOG_MULTI.map((l) => l.replace('Type something', 'Fox'))), null);
  assert.equal(parseQuestionDialog(['❯ 1. Yes', '  2. No']), null);
});

test('steps for the question on screen toggle only what differs and move from the cursor', () => {
  const q = parseQuestionDialog(DIALOG_MULTI)!;
  // Auth is already ticked: keep it, add Billing.
  assert.deepEqual(dialogSteps(q, { picked: [0, 2] }), [{ keys: ['3'] }, { keys: ['Right'] }]);
  // Untick Auth, type an answer: two rows down from Search to "Type something".
  assert.deepEqual(dialogSteps(q, { picked: [], text: 'Cache' }), [{ keys: ['1'] }, { keys: ['Down', 'Down'] }, { text: 'Cache' }, { keys: ['Tab'] }, { keys: ['Enter'] }]);
  const single = parseQuestionDialog(CLAUDE_QUESTIONS.split('\n'))!;
  assert.deepEqual(dialogSteps(single, { picked: [1] }), [{ keys: ['2'] }]);
});

const TRUST = `
 Accessing workspace:
 /tmp/proj/demo
 Quick safety check: Is this a project you created or one you trust?
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel`.split('\n');

test('a picker without numbers is read from its cursor row', () => {
  const p = parsePicker(TRUST)!;
  assert.deepEqual(p.options, [
    { key: 'nav:0', label: 'No, exit' },
    { key: 'nav:1', label: 'Yes, I trust this folder' },
  ]);
  assert.equal(p.cursor, 0);
  assert.match(p.context, /Is this a project you created or one you trust\?/);
  assert.deepEqual(cursorKeys(0, 1), ['Down', 'Enter']);
  assert.deepEqual(cursorKeys(2, 0), ['Up', 'Up', 'Enter']);
  assert.deepEqual(cursorKeys(1, 1), ['Enter']);
  // Prose with an arrow is not a picker without the footer.
  assert.equal(parsePicker(['❯ not a menu', '  just text']), null);
});

test('a wrapped option label is read whole', () => {
  const lines = [' Do you want to create notes.md?', ' ❯ 1. Yes', '   2. Yes, and switch to accept edits (auto-approve file edits and common file', '      commands) for this session (shift+tab)', '   3. No'];
  assert.deepEqual(parsePicker(lines)?.options.map((o) => o.label), ['Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)', 'No']);
});

test('each question is answered only once the dialog is on it, and the submit only on the review', async () => {
  const { dialogAt, claudeQuestionGroups } = await import('./choices.ts');
  const q2 = ['←  ☒ Color  ☐ Toppings  ✔ Submit  →', 'Pick toppings', '❯ 1. [ ] Cheese', '  2. [ ] Olives', '  3. [ ] Basil', '  4. [ ] Type something', '     Submit', '────', '  5. Chat about this', 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel'].join('\n');
  assert.equal(dialogAt(CLAUDE_QUESTIONS, Q2, 0), true);
  assert.equal(dialogAt(q2, Q2, 1), true);
  assert.equal(dialogAt(q2.replace('Pick toppings', 'Pick a planet'), Q2, 1), false, 'another question took over');
  assert.equal(dialogAt(q2.replace('[ ] Cheese', '[✔] Cheese'), Q2, 1), false, 'something was already ticked');
  assert.equal(dialogAt(q2.replace('☒ Color', '☐ Color'), Q2, 1), false, 'the first answer did not land');
  assert.equal(dialogAt('Ready to submit your answers?\n❯ 1. Submit answers\n  2. Cancel', Q2, 2), true);
  assert.equal(dialogAt(q2, Q2, 2), false, 'no submit before the review');
  assert.deepEqual(claudeQuestionGroups(Q2, [{ picked: [1] }, { picked: [0] }]), [[{ keys: ['2'] }], [{ keys: ['1'] }, { keys: ['Right'] }], [{ keys: ['1'] }]]);
});

test("an option the window wrapped inside a path rejoins without a space", () => {
  const screen = [
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. Yes, and always allow access to /tmp/claude-1000/-home-me-code-ah/e566',
    '      4374-cf7c-4a39-b47e/code/demo from this project',
    '   3. No',
  ];
  const labels = parsePicker(screen)?.options.map((o) => o.label);
  assert.deepEqual(labels, ['Yes', 'Yes, and always allow access to /tmp/claude-1000/-home-me-code-ah/e5664374-cf7c-4a39-b47e/code/demo from this project', 'No']);
});

// A question whose options carry previews, captured from Claude Code 2.1.300: the cursor
// option's preview in a box beside the options, notes, no free-text row.
const DIALOG_PREVIEW = `
←  ☐ Layout  ☐ Extras  ✔ Submit  →
Which layout?
❯ 1. Stacked                      ┌──────────────────────────────────────────┐
  2. Inline                       │ +----------------+                       │
                                  │ | Header         |                       │
                                  │ +----------------+                       │
                                  │ | Content        |                       │
                                  │ +----------------+                       │
                                  └──────────────────────────────────────────┘
                                  Notes: press n to add notes
────────────────────
  Chat about this
Enter to select · ↑/↓ to navigate · n to add notes · Tab to switch questions · Esc to cancel`;

const PREVIEWED: Question[] = [
  { question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Stacked', preview: '+--+\n|  |' }, { label: 'Inline', preview: '+-+-+' }] },
  { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Dark mode' }, { label: 'Animations' }, { label: 'Tooltips' }] },
];

test('keeps an option\'s preview', () => {
  assert.deepEqual(readQuestions({ questions: [{ question: 'Q', options: [{ label: 'A', preview: 'box' }, { label: 'B', preview: '  ' }] }] })?.[0].options, [
    { label: 'A', description: undefined, preview: 'box' },
    { label: 'B', description: undefined },
  ]);
});

test('a preview question is answered by arrows and Enter, with notes by n', () => {
  assert.deepEqual(claudeQuestionSteps(PREVIEWED, [{ picked: [1], notes: 'make it compact' }, { picked: [0, 2] }]), [
    { keys: ['Down'] }, { keys: ['n'] }, { text: 'make it compact' }, { keys: ['Enter'] },
    { keys: ['1'] }, { keys: ['3'] }, { keys: ['Right'] },
    { keys: ['1'] },
  ]);
  assert.deepEqual(claudeQuestionSteps(PREVIEWED.slice(0, 1), [{ picked: [0] }]), [{ keys: ['Enter'] }], 'one question: Enter submits it');
  assert.throws(() => checkAnswers(PREVIEWED.slice(0, 1), [{ picked: [], text: 'other' }]), /takes a pick/);
  assert.throws(() => checkAnswers(PREVIEWED.slice(1), [{ picked: [0], notes: 'x' }]), /notes go with/);
  assert.throws(() => checkAnswers(PREVIEWED.slice(0, 1), [{ picked: [0], notes: 'two\nlines' }]), /one line/);
});

test('reads a preview dialog off the screen', () => {
  const lines = DIALOG_PREVIEW.split('\n');
  const d = parseQuestionDialog(lines);
  assert.ok(d);
  assert.deepEqual(d.options.map((o) => o.label), ['Stacked', 'Inline'], 'the box is not part of the labels');
  assert.equal(d.previews, true);
  assert.equal(d.cursor, 1);
  assert.equal(d.options[0].preview?.split('\n')[1].trim(), '| Header         |');
  assert.equal(d.options[1].preview, undefined, 'only the cursor\'s preview is drawn');
  assert.deepEqual(dialogSteps(d, { picked: [1], notes: 'compact' }), [{ keys: ['Down'] }, { keys: ['n'] }, { text: 'compact' }, { keys: ['Enter'] }]);
  assert.ok(pickerAtStart(DIALOG_PREVIEW, PREVIEWED));
});

test('"Chat about this" is past the options, the free-text row and Submit', () => {
  const two = [{ label: 'Small' }, { label: 'Large' }];
  const three = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
  assert.deepEqual(chatSteps({ options: two, multiSelect: false }), [{ keys: ['Down', 'Down', 'Down'] }, { keys: ['Enter'] }]);
  assert.deepEqual(chatSteps({ options: three, multiSelect: true }), [{ keys: ['Down', 'Down', 'Down', 'Down', 'Down'] }, { keys: ['Enter'] }]);
  assert.deepEqual(chatSteps({ options: two, multiSelect: false, previews: true }), [{ keys: ['Down', 'Down'] }, { keys: ['Enter'] }]);
  assert.deepEqual(chatSteps({ options: two, multiSelect: false, previews: true }, 2), [{ keys: ['Down'] }, { keys: ['Enter'] }]);
});
