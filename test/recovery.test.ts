// Recovery, black box (Workflow D), on stand-in agents: a rate limit waited out and
// continued once; a crash resumed in the same conversation; a sign-in failure left
// to you; your controls; and an agent cut off by a host restart picked up again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, transcriptOf, windows } from './fake-agents.ts';

const CONT = 'Continue where you left off.';
const logOf = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');
const count = (file: string, text: string) => logOf(file).split('\n').filter((l) => l.includes(JSON.stringify(text))).length;
const fast = { auto: true, backoffSeconds: 1, jitterSeconds: 0, maxAttempts: 3 };

test('a rate limit is waited out to the reset the agent named, then continued exactly once', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ah-log-')), 'prompts.log');
  const ah = await startBed({ recovery: fast }, { FAKE_HARNESS_LOG: log });
  try {
    const s = await launch(ah, 'claude', ah.project, 'Long task');
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'RATELIMIT 6' } });
    const rec = await until(async () => (await windows(ah)).find((w) => w.uid === s.uid)?.recovery, 15000, 'recovery seen');
    assert.equal(rec.reason, 'rate_limit');
    assert.equal(rec.state, 'scheduled');
    assert.ok(rec.resetsAt && rec.nextAttemptAt >= rec.resetsAt, 'not before the reset');
    assert.equal(count(log, CONT), 0, 'nothing sent before the reset');
    await until(async () => count(log, CONT) === 1, 20000, 'continued after the reset').catch(async (err) => {
      throw new Error(`${err.message}\n${JSON.stringify((await http(ah, 'GET', `/api/sessions/${s.uid}/recovery`)).json(), null, 1)}\nnow=${Math.floor(Date.now() / 1000)}\n${logOf(log)}`);
    });
    await until(async () => !(await windows(ah)).find((w) => w.uid === s.uid)?.recovery, 15000, 'resolved');
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal(count(log, CONT), 1, 'exactly once');
    const detail = (await http(ah, 'GET', `/api/sessions/${s.uid}/recovery`)).json();
    assert.deepEqual(detail.events.map((e: any) => e.state).reverse(), ['scheduled', 'resuming', 'resolved']);
    assert.match(detail.events.at(-1).detail, /provider said capacity is back/);
  } finally {
    await cleanup(ah);
  }
});

test('a crash mid-turn is resumed in the same conversation; a sign-in failure is left to you', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ah-log-')), 'prompts.log');
  const ah = await startBed({ recovery: fast }, { FAKE_HARNESS_LOG: log });
  try {
    const s = await launch(ah, 'claude', ah.project, 'Crashy');
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'CRASH 3000' } });
    await until(async () => (await windows(ah)).find((w) => w.uid === s.uid)?.status === 'busy', 8000, 'working');
    // It dies; ah sees it gone while working, resumes the same conversation and continues once.
    await until(async () => count(log, CONT) === 1, 25000, 'continued after the crash');
    const back = await until(async () => (await windows(ah)).find((w) => w.uid === s.uid && w.harnessId), 10000, 'running again');
    assert.equal(back.harnessId, s.harnessId, 'the same conversation');
    await until(async () => !(await windows(ah)).find((w) => w.uid === s.uid)?.recovery, 15000, 'resolved');

    // Credentials: never retried, the session says it needs you.
    await say(ah, s.uid, 'hello again');
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'AUTHFAIL' } });
    const r = await until(async () => (await windows(ah)).find((w) => w.uid === s.uid)?.recovery, 15000, 'credentials seen');
    assert.equal(r.state, 'needs_user');
    assert.equal(r.reason, 'credentials');
    await new Promise((res) => setTimeout(res, 3000));
    assert.equal(count(log, CONT), 1, 'nothing sent for a sign-in failure');

    // A session you end is not a crash.
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'SLOW 20000' } });
    await until(async () => (await windows(ah)).find((w) => w.uid === s.uid)?.status === 'busy', 8000, 'working again');
    await http(ah, 'POST', `/api/sessions/${s.uid}/terminate`);
    await new Promise((res) => setTimeout(res, 4000));
    assert.equal(count(log, CONT), 1, 'ended by you: left ended');
  } finally {
    await cleanup(ah);
  }
});

test('with recovery off: it says what happened and waits; retry now, pause and cancel are yours', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ah-log-')), 'prompts.log');
  const ah = await startBed({ recovery: { auto: false, jitterSeconds: 0 } }, { FAKE_HARNESS_LOG: log });
  try {
    const s = await launch(ah, 'claude', ah.project, 'Manual');
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'RATELIMIT 2' } });
    const r = await until(async () => (await windows(ah)).find((w) => w.uid === s.uid)?.recovery, 15000, 'seen');
    assert.equal(r.state, 'waiting_capacity');
    assert.equal(r.auto, false);
    await new Promise((res) => setTimeout(res, 4000));
    assert.equal(count(log, CONT), 0, 'off: nothing sent on its own');
    assert.equal((await http(ah, 'POST', `/api/sessions/${s.uid}/recovery`, { body: { action: 'pause' } })).json().recovery.state, 'stopped');
    assert.equal((await http(ah, 'POST', `/api/sessions/${s.uid}/recovery`, { body: { action: 'resume' } })).json().recovery.state, 'waiting_capacity');
    const retried = await http(ah, 'POST', `/api/sessions/${s.uid}/recovery`, { body: { action: 'retry' } });
    assert.equal(retried.status, 200, retried.body);
    await until(async () => count(log, CONT) === 1, 15000, 'retried at your word');
    await until(async () => !(await windows(ah)).find((w) => w.uid === s.uid)?.recovery, 15000, 'resolved');
    // Switched on for this session only.
    assert.equal((await http(ah, 'POST', `/api/sessions/${s.uid}/recovery`, { body: { auto: true } })).json().auto, true);
    const nothing = await http(ah, 'POST', `/api/sessions/${s.uid}/recovery`, { body: { action: 'retry' } });
    assert.equal(nothing.status, 409, nothing.body);
    assert.equal(nothing.json().code, 'resolved', 'nothing to recover now');
    await new Promise((res) => setTimeout(res, 3000));
    assert.equal(count(log, CONT), 1, 'the notice still on screen is not a new limit');
  } finally {
    await cleanup(ah);
  }
});

test('an agent cut off by a host restart is picked up again in the same conversation', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'ah-log-')), 'prompts.log');
  const ah = await startBed({ recovery: fast }, { FAKE_HARNESS_LOG: log });
  try {
    const s = await launch(ah, 'claude', ah.project, 'Reboot me');
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'SLOW 60000' } });
    await until(async () => (await windows(ah)).find((w) => w.uid === s.uid)?.status === 'busy', 8000, 'working');
    await new Promise((res) => setTimeout(res, 2000));
    // The "reboot": ah stops, its tmux server (by its own socket) dies with every window.
    await ah.stop();
    ah.tmux('kill-server');
    const ah2 = await ah.restart();
    // (The restarted bed's tmux doesn't carry the prompt log: its transcript says.) Cut off
    // by the restart, it's restored (server/interruptions): told what happened, not just "continue".
    const NOTE = 'Got: [ah] This session was interrupted';
    await until(async () => (await transcriptOf(ah2, s.uid))?.includes(NOTE), 30000, 'continued after the restart');
    const back = await until(async () => (await windows(ah2)).find((w) => w.uid === s.uid && w.harnessId), 15000, 'running again');
    assert.equal(back.harnessId, s.harnessId);
    await until(async () => !(await windows(ah2)).find((w) => w.uid === s.uid)?.recovery, 15000, 'resolved');
    const text = (await transcriptOf(ah2, s.uid))!;
    assert.equal(text.split(NOTE).length - 1, 1, 'once');
    assert.ok(!text.includes(`Got: ${CONT}`), 'the note instead of the generic continuation');
  } finally {
    await cleanup(ah);
  }
});
