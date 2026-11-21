// Claude Code's question dialog (AskUserQuestion) as a phone's terminal shows it. The fixtures are
// real screens of Claude Code 2.1.300 asking the same question, captured at 49 columns (a phone)
// and at several heights, down to a pane the keyboard leaves 9 rows of: the options scroll, and
// the question, its tab and "Type something" go out of view. ah must still see the question, and
// answer it from the GUI, at every size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dialogAt, parseQuestionDialog, pickerAtStart, untouchedAt, type Question } from './choices.ts';
import { isQuestionDialog } from './sessions.ts';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/question-dialog/${name}`, import.meta.url), 'utf8');
const QUESTIONS: Question[] = JSON.parse(fixture('ask.json'));
const SIZES = ['120x40', '49x37', '49x20', '49x12', '49x9'];
const lines = (screen: string) => screen.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());

for (const size of SIZES) {
  test(`the question dialog at ${size} is a question, untouched, answerable from the GUI`, () => {
    const screen = fixture(`claude-2.1.300-${size}.txt`);
    assert.equal(isQuestionDialog(lines(screen)), true, 'seen as a question');
    assert.equal(pickerAtStart(screen, QUESTIONS), true, 'at its start');
    assert.equal(dialogAt(screen, QUESTIONS, 0), true, 'ready for the first answer');
  });
}

test("the question's text leaves out the gutter Claude draws beside it", () => {
  const d = parseQuestionDialog(lines(fixture('claude-2.1.300-49x37.txt')));
  assert.ok(d);
  assert.equal(d.question, QUESTIONS[0].question);
  assert.deepEqual(d.options.map((o) => o.label), QUESTIONS[0].options.map((o) => o.label));
});

test('a short pane with the cursor moved off the first row is not untouched', () => {
  const moved = fixture('claude-2.1.300-49x12.txt').replace('❯ 1.', '  1.').replace('↓ 2.', '❯ 2.');
  assert.equal(isQuestionDialog(lines(moved)), true, 'still the dialog');
  assert.equal(pickerAtStart(moved, QUESTIONS), false, 'but no longer at its start');
});

test('a short pane matching more than one question, or none, is not taken for either', () => {
  const screen = fixture('claude-2.1.300-49x9.txt');
  assert.equal(untouchedAt(screen, [QUESTIONS[0], { ...QUESTIONS[0], question: 'The same options again?' }]), -1);
  assert.equal(untouchedAt(screen, [{ ...QUESTIONS[0], options: [{ label: 'Something else' }, { label: 'Other' }] }]), -1);
  assert.equal(untouchedAt(screen.replace('1. Push branches only (Recommended)', '1. [✔] Push branches only (Recommended)'), QUESTIONS), -1, 'ticked');
});

test("a conversation quoting the dialog's rows above its prompt is not a question", () => {
  const quoted = [
    '● The dialog ends with these rows:',
    '  5. Chat about this',
    '  Enter to select · ↑/↓ to navigate · Esc to cancel',
    '',
    '─────────────────────────────────────────────────',
    '❯ ',
    '─────────────────────────────────────────────────',
    '  ⏵⏵ auto mode on',
  ];
  assert.equal(isQuestionDialog(quoted), false);
});
