import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until, sleep } from './helpers.ts';

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

test('a message sent while the question dialog is up waits in the queue instead of choosing a row', async () => {
  const { ah, uid, log, window } = await dialogSession('question', { kind: 'choice', text: 'Pick a color', questions: QUESTIONS });
  try {
    await until(async () => (await window())?.ask?.questions, 10000, 'question surfaces');
    // The dialog drops a paste and takes Enter as its highlighted row: typed, this would
    // answer "Red" for you and lose the words.
    const r = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'Something I noticed' } });
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json().outcome, 'queued');
    assert.equal(r.json().held, 'picker');
    await sleep(500);
    assert.equal(keys(log), '', 'nothing typed into the dialog');
    assert.equal((await window())?.status, 'waiting', 'still asking');
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
    // The picker is still on screen (the agent hasn't redrawn): a second tap types nothing.
    const again = await http(ah, 'POST', `/api/sessions/${uid}/choose`, { body: { key: '2' } });
    assert.equal(again.status, 409, again.body);
    assert.equal(again.json().code, 'already_answered');
    await sleep(300);
    assert.equal(keys(log), '2', 'typed once');
  } finally {
    await cleanup(ah);
  }
});

test('approve from a notification goes through only while the same prompt is showing', async () => {
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
      return w?.status === 'waiting' && w.answerable && w.askId ? w : null;
    }, 15000, 'an answerable prompt with its id');
    assert.match(w.askId, /^[0-9a-f]{16}$/);
    // An alert about an older prompt: refused, nothing typed.
    const stale = await http(ah, 'POST', `/api/sessions/${uid}/answer`, { body: { answer: 'approve', prompt: '0123456789abcdef' } });
    assert.equal(stale.status, 409, stale.body);
    assert.match(stale.json().error, /asking something else/);
    assert.equal(keys(log), '');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/answer`, { body: { answer: 'approve', prompt: 7 } })).status, 400, 'a prompt id is a string');
    // The one it shows: approved.
    const ok = await http(ah, 'POST', `/api/sessions/${uid}/answer`, { body: { answer: 'approve', prompt: w.askId } });
    assert.equal(ok.status, 200, ok.body);
    await until(() => keys(log) === '\r', 5000, 'Enter typed');
    // The prompt is still on screen (the agent hasn't redrawn): a second tap, from this
    // device or another, with or without the prompt's id, types nothing.
    for (const body of [{ answer: 'approve', prompt: w.askId }, { answer: 'approve' }, { answer: 'deny' }]) {
      const again = await http(ah, 'POST', `/api/sessions/${uid}/answer`, { body });
      assert.equal(again.status, 409, again.body);
      assert.equal(again.json().code, 'already_answered');
    }
    await sleep(300);
    assert.equal(keys(log), '\r', 'typed once');
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

test('a named message that picked a row, asked again, picks nothing more', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const log = `${dir}/keys.log`;
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-claude', name: 'Test', command: `exec ${process.execPath} ${fixture} permission ${log}`, match: '^node$', waitingPatterns: ['Do you want to proceed'], approveKeys: ['Enter'], denyKeys: ['Escape'] }],
  }, dir);
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-claude', cwd: `${ah.dir}/files` } });
    const { uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => (await window())?.ask?.options?.length, 15000, 'the picker');
    const first = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: '2', id: 'pick-1' } });
    assert.equal(first.json().outcome, 'delivered', first.body);
    await until(() => keys(log) === '2', 5000, 'row picked');
    // The answer was lost; asked again with the same id, long after the hold.
    await sleep(4500);
    const again = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: '2', id: 'pick-1' } });
    assert.equal(again.status, 200, again.body);
    assert.equal(again.json().outcome, 'delivered');
    await sleep(500);
    assert.equal(keys(log), '2', 'picked once');
  } finally {
    await cleanup(ah);
  }
});

test('two devices answering the same question: the first is typed, the second is told it was answered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const log = `${dir}/keys.log`;
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-claude', name: 'Test', command: `exec ${process.execPath} ${fixture} plain ${log}`, match: '^node$', waitingPatterns: ['all done here'] }],
  }, dir);
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-claude', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => (await window())?.status === 'waiting', 15000, 'waiting on its question');
    const [a, b] = await Promise.all([
      http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'blue' } }),
      http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'green' } }),
    ]);
    const [won, lost] = a.status === 200 ? [a, b] : [b, a];
    assert.equal(won.json().outcome, 'delivered', won.body);
    assert.equal(lost.status, 409, lost.body);
    assert.equal(lost.json().code, 'already_answered');
    await sleep(500);
    const typed = keys(log);
    assert.ok(typed.includes('blue') !== typed.includes('green'), `one answer typed, not both: ${JSON.stringify(typed)}`);
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0, 'and nothing waits to land later as a turn');
  } finally {
    await cleanup(ah);
  }
});
