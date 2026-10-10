import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/picker.js', import.meta.url));
const keys = (log: string) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l.slice(4))).join('') : '');

const QUESTIONS = [
  { question: 'Pick a color', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
  { question: 'Pick toppings', header: 'Toppings', multiSelect: true, options: [{ label: 'Cheese' }, { label: 'Olives' }, { label: 'Basil' }] },
];

/** ah with one test-claude window running the picker fixture in `mode`, its hook state set to `ask`. */
async function dialogSession(mode: string, ask?: object) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const log = `${dir}/keys.log`;
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-claude', name: 'Test', command: `exec ${process.execPath} ${fixture} ${mode} ${log}`, match: '^node$', questions: 'claude' }],
  }, dir);
  const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-claude', cwd: `${ah.dir}/files` } });
  assert.equal(created.status, 201, created.body);
  const { id, uid } = created.json();
  const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
  await until(async () => (await window())?.agent === 'test-claude', 15000, 'agent detected');
  if (ask)
    ah.tmux(
      'set-option', '-w', '-t', id, '@ah-harness', 'test-claude',
      ';', 'set-option', '-w', '-t', id, '@ah-state', 'waiting',
      ';', 'set-option', '-w', '-t', id, '@ah-state-at', String(Math.floor(Date.now() / 1000)),
      ';', 'set-option', '-w', '-t', id, '@ah-ask', JSON.stringify(ask),
    );
  return { ah, id, uid, log, window };
}

test('answers a question dialog from outside the terminal, one question at a time', async () => {
  const { ah, id, uid, log, window } = await dialogSession('question', { kind: 'choice', text: 'Pick a color', questions: QUESTIONS });
  try {
    const w = await until(async () => {
      const w = await window();
      return w?.status === 'waiting' && w.ask?.kind === 'choice' && w.ask.questions ? w : null;
    }, 10000, 'question surfaces as waiting');
    assert.equal(w.answerable, false, 'approve/deny never applies to a question');

    const bad = await http(ah, 'POST', `/api/sessions/${uid}/questions`, { body: { answers: [{ picked: [0, 1] }, { picked: [0] }] } });
    assert.equal(bad.status, 400, 'two picks for a single choice');
    assert.equal(keys(log), '', 'nothing typed for a rejected answer');

    const ok = await http(ah, 'POST', `/api/sessions/${uid}/questions`, { body: { answers: [{ picked: [1] }, { picked: [2, 0], text: 'Fox' }] } });
    assert.equal(ok.status, 200, ok.body);
    // Green, Cheese, Basil, down to "Type something", Fox, Tab to Submit, Enter, then submit the review.
    assert.match(keys(log), /^213(\x1b\[B|\x1bOB){3}Fox\t\r1$/);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('SUBMITTED'), 5000, 'the dialog took every answer');
  } finally {
    await cleanup(ah);
  }
});

test('input from elsewhere mid-way stops the answer instead of misplacing it', async () => {
  const { ah, uid, log, window } = await dialogSession('hijacked', { kind: 'choice', text: 'Pick a color', questions: QUESTIONS });
  try {
    await until(async () => (await window())?.ask?.questions, 10000, 'question surfaces');
    const r = await http(ah, 'POST', `/api/sessions/${uid}/questions`, { body: { answers: [{ picked: [1] }, { picked: [0] }] } });
    assert.equal(r.status, 409, r.body);
    assert.match(r.json().error, /stopped after 1 of 2/);
    assert.equal(keys(log), '2', 'only the first question was answered; nothing went into the other one');
  } finally {
    await cleanup(ah);
  }
});

test('stale hook questions give way to the question on screen', async () => {
  const { ah, uid, log, window } = await dialogSession('question', { kind: 'choice', text: 'Other', questions: [{ ...QUESTIONS[0], question: 'Pick a planet' }] });
  try {
    const step = await until(async () => {
      const w = await window();
      return w?.ask?.kind === 'choice' && !w.ask.questions && w.ask.dialog ? w : null;
    }, 10000, 'screen question instead of stale hook questions');
    assert.equal(step.ask.dialog.question, 'Pick a color');
    assert.equal(step.ask.dialog.total, 2);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/questions`, { body: { answers: [{ picked: [0] }] } })).status, 409);
    const wrong = await http(ah, 'POST', `/api/sessions/${uid}/questions`, { body: { current: { question: 'Pick a planet', answer: { picked: [0] } } } });
    assert.equal(wrong.status, 409, wrong.body);
    assert.equal(keys(log), '');
    const one = await http(ah, 'POST', `/api/sessions/${uid}/questions`, { body: { current: { question: 'Pick a color', answer: { picked: [2] } } } });
    assert.equal(one.status, 200, one.body);
    await until(() => keys(log) === '3', 5000, 'one digit for the question on screen');
  } finally {
    await cleanup(ah);
  }
});

test('picks a row of a permission prompt by its digit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const log = `${dir}/keys.log`;
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-claude', name: 'Test', command: `exec ${process.execPath} ${fixture} permission ${log}`, match: '^node$', waitingPatterns: ['Do you want to proceed'], approveKeys: ['Enter'], denyKeys: ['Escape'] }],
  }, dir);
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-claude', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    const w = await until(async () => {
      const w = await window();
      return w?.status === 'waiting' && w.ask?.options?.length ? w : null;
    }, 15000, 'permission prompt with options');
    assert.deepEqual(w.ask.options.map((o: any) => o.label), ['Yes', "Yes, and don't ask again for rm commands", 'No, and tell Claude what to do differently (esc)']);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/choose`, { body: { key: '7' } })).status, 409);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/choose`, { body: { key: '2' } })).status, 200);
    await until(() => keys(log) === '2', 5000, 'digit typed');
  } finally {
    await cleanup(ah);
  }
});

test('a hook stuck on "waiting" over a screen with no prompt does not hold "needs you"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-claude', name: 'Test', command: `exec ${process.execPath} ${fixture} plain ${dir}/keys.log`, match: '^node$' }],
  }, dir);
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-claude', cwd: `${ah.dir}/files` } });
    const { id, uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => (await window())?.agent === 'test-claude', 15000, 'agent detected');
    ah.tmux(
      'set-option', '-w', '-t', id, '@ah-harness', 'test-claude',
      ';', 'set-option', '-w', '-t', id, '@ah-state', 'waiting',
      ';', 'set-option', '-w', '-t', id, '@ah-state-at', String(Math.floor(Date.now() / 1000)),
      ';', 'set-option', '-w', '-t', id, '@ah-ask', JSON.stringify({ kind: 'tool', text: 'Editing notes.md' }),
    );
    await until(async () => {
      const w = await window();
      return w && w.status !== 'waiting' && w.statusSource === 'hook';
    }, 10000, 'stale waiting dropped once the screen is quiet with no picker');
  } finally {
    await cleanup(ah);
  }
});
