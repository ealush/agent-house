import '../test/scratch.ts';
// The scheduler's pure parts: cron in time zones across DST, and the run policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCron, nextRun, wallClock, checkZone, CronError } from './jobs/cron.ts';

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

test('cron: fields, lists, ranges, steps, names and aliases', () => {
  const c = parseCron('*/15 9-17 * * mon-fri');
  assert.deepEqual([...c.minute], [0, 15, 30, 45]);
  assert.deepEqual([...c.dow].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual([...parseCron('@daily').hour], [0]);
  assert.deepEqual([...parseCron('0 0 * * 7').dow], [0], '7 is Sunday too');
  assert.deepEqual([...parseCron('0 0 1 jan,jul *').month], [1, 7]);
  for (const bad of ['* * * *', '60 * * * *', '0 0 32 * *', '*/0 * * * *', '5-2 * * * *']) assert.throws(() => parseCron(bad), CronError, bad);
  assert.throws(() => checkZone('Mars/Olympus'), CronError);
});

test('cron: every morning at 9 in a time zone, and day-of-month OR day-of-week', () => {
  const c = parseCron('0 9 * * *');
  assert.equal(iso(nextRun(c, 'Asia/Jerusalem', at('2026-11-14T08:00:00Z'))), '2026-11-15T07:00:00.000Z');
  assert.equal(iso(nextRun(c, 'UTC', at('2026-11-14T08:59:00Z'))), '2026-11-14T09:00:00.000Z');
  // 1st of the month or a Monday: 2026-12-01 is a Tuesday, the Monday before is the 30th.
  assert.equal(iso(nextRun(parseCron('0 0 1 * mon'), 'UTC', at('2026-11-28T12:00:00Z'))), '2026-11-30T00:00:00.000Z');
});

test('cron across DST: a skipped wall time is skipped, a repeated one runs once, hourly runs every real hour', () => {
  const ny = 'America/New_York';
  // 2027-03-14: 02:00 → 03:00. "30 2" doesn't exist that day.
  assert.equal(iso(nextRun(parseCron('30 2 * * *'), ny, at('2027-03-13T12:00:00Z'))), '2027-03-15T06:30:00.000Z');
  // "0 9" stays 9am local on both sides of the change (UTC moves by an hour).
  assert.equal(wallClock(nextRun(parseCron('0 9 * * *'), ny, at('2027-03-13T15:00:00Z'))!, ny).hour, 9);
  assert.equal(iso(nextRun(parseCron('0 9 * * *'), ny, at('2027-03-13T15:00:00Z'))), '2027-03-14T13:00:00.000Z');
  // 2026-11-01: 02:00 → 01:00. "30 1" happens twice; it runs at the first.
  const first = nextRun(parseCron('30 1 * * *'), ny, at('2026-11-01T04:00:00Z'))!;
  assert.equal(iso(first), '2026-11-01T05:30:00.000Z');
  assert.equal(iso(nextRun(parseCron('30 1 * * *'), ny, first)), '2026-11-02T06:30:00.000Z', 'not again an hour later');
  const h1 = nextRun(parseCron('@hourly'), ny, at('2026-11-01T05:30:00Z'))!;
  assert.equal(iso(h1), '2026-11-01T06:00:00.000Z', 'the repeated 1 o’clock hour is a real hour');
});

// ---------- the scheduler on a real database, with stand-in sessions and a clock we move

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { ensureMigrated, getDb } from './db.ts';
import { Scheduler, type SchedulerDeps } from './jobs/scheduler.ts';
import type { WindowView } from './sessions.ts';

type FakeSession = { uid: string; status: WindowView['status']; queue: string[]; transcript: Array<{ role: 'user' | 'assistant'; text: string; at: number }>; ended?: boolean; box?: string };

async function bed(limits = { maxConcurrent: 3, maxLaunchesPerHour: 20, maxRetriesPerMinute: 10 }) {
  const dir = mkdtempSync(join(tmpdir(), 'ah-jobs-'));
  const path = join(dir, 'ah.db');
  await ensureMigrated(path);
  const db = getDb(path);
  const sessions = new Map<string, FakeSession>();
  const sent: Array<{ uid: string; text: string; id: string }> = [];
  const launched: string[] = [];
  const alerts: string[] = [];
  let next = 0;
  /** What an agent does with a message: it arrives, and it answers (unless told otherwise). */
  let behave: (s: FakeSession, text: string) => void = (s, text) => {
    s.transcript.push({ role: 'user', text, at: Date.now() }, { role: 'assistant', text: `Got: ${text.split('\n')[0]}`, at: Date.now() });
  };
  const deps: SchedulerDeps = {
    launch: async (o) => {
      launched.push(o.uid);
      const s: FakeSession = { uid: o.uid, status: 'idle', queue: [], transcript: [] };
      sessions.set(o.uid, s);
      sent.push({ uid: o.uid, text: o.prompt, id: o.id });
      behave(s, o.prompt);
    },
    send: async (target, text, id) => {
      const s = sessions.get(target)!;
      sent.push({ uid: target, text, id });
      behave(s, text);
      return { outcome: 'delivered', uid: target };
    },
    resolveTarget: async (ref) => (sessions.has(ref) ? ref : null),
    checkLaunch: async (_p, sel) => ({ dangerous: sel.mode === 'yolo' }),
    record: (uid) => (sessions.has(uid) ? ({ id: uid, lifecycle: sessions.get(uid)!.ended ? 'ended' : 'live', endedAt: sessions.get(uid)!.ended ? Math.floor(Date.now() / 1000) : undefined } as never) : undefined),
    freshUid: () => `u${++next}`,
    queueIds: (uid) => sessions.get(uid)?.queue ?? [],
    readTranscript: async (uid, from) => {
      const s = sessions.get(uid);
      if (!s) return null;
      const all = s.transcript.slice(Math.min(from, s.transcript.length));
      return { size: s.transcript.length, user: all.filter((e) => e.role === 'user').map((e) => e.text), replies: all.filter((e) => e.role === 'assistant').map((e) => ({ text: e.text, at: e.at })) };
    },
    inputBox: async (uid) => sessions.get(uid)?.box ?? '',
    alert: (p) => alerts.push(p.title),
    changed: () => {},
    limits: () => limits,
  };
  const windows = (): WindowView[] => [...sessions.values()].filter((s) => !s.ended).map((s) => ({ uid: s.uid, status: s.status, activity: 0 }) as WindowView);
  const sched = new Scheduler(db, deps);
  /** Passes until nothing changes (a run's steps settle over a few passes). */
  const settle = async (s = sched) => {
    for (let i = 0; i < 8; i++) {
      await s.tick(windows());
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return { db, sched, deps, sessions, sent, launched, alerts, settle, windows, setBehave: (f: typeof behave) => (behave = f) };
}

const launchAction = { kind: 'launch', preset: 'claude', cwd: '/w', prompt: 'Run the nightly report' };

test('scheduler: a one-time job launches once, finishes when the agent answers, and is done', async () => {
  const b = await bed();
  const job = await b.sched.create({ name: 'Report', action: launchAction, trigger: { kind: 'at', at: Math.floor(Date.now() / 1000) - 1 }, createdBy: 't' });
  await b.settle();
  const out = await b.sched.get(job.id);
  assert.equal(out.state, 'done');
  assert.equal(out.runs.length, 1);
  assert.equal(out.runs[0].state, 'succeeded');
  assert.equal(out.runs[0].outcome.reply, 'Got: Run the nightly report');
  assert.ok(out.runs[0].delivery.observedAt && out.runs[0].delivery.finishedAt);
  assert.equal(b.launched.length, 1);
  await b.settle();
  assert.equal(b.launched.length, 1, 'never twice');
});

test('scheduler: a recurring schedule runs per slot, catches up once after downtime, and stops at maxRuns', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T06:00:00Z') });
  const b = await bed();
  const job = await b.sched.create({ name: 'Morning', action: launchAction, trigger: { kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Jerusalem' }, policy: { maxRuns: 2 }, createdBy: 't' });
  assert.equal(job.nextRunAt, Date.parse('2026-11-16T07:00:00Z') / 1000);
  t.mock.timers.setTime(Date.parse('2026-11-16T07:00:30Z'));
  await b.settle();
  assert.equal((await b.sched.get(job.id)).runs.length, 1);
  // Three days down: the missed mornings run once, not three times.
  t.mock.timers.setTime(Date.parse('2026-11-19T12:00:00Z'));
  await b.settle();
  const out = await b.sched.get(job.id);
  assert.equal(out.runs.length, 2);
  assert.equal(out.nextRunAt, null, 'maxRuns reached');
  assert.equal(out.state, 'done');
  mock.timers.reset();
});

test('scheduler: duplicate triggers and a second worker on the same database never double a run', async () => {
  const b = await bed();
  const job = await b.sched.create({ name: 'Once', action: launchAction, trigger: { kind: 'at', at: Math.floor(Date.now() / 1000) - 1 }, createdBy: 't' });
  const other = new Scheduler(b.db, b.deps);
  await Promise.all([b.sched.tick(b.windows()), other.tick(b.windows()), b.sched.tick(b.windows()), other.tick(b.windows())]);
  await b.settle();
  await b.settle(other);
  assert.equal((await b.sched.get(job.id)).runs.length, 1);
  assert.equal(b.launched.length, 1);
});

test('scheduler: dependents run after success, are skipped after failure, and retries are bounded', async () => {
  const b = await bed();
  b.setBehave((s, text) => {
    if (text.includes('FAIL')) s.ended = true; // the agent dies on it
    else s.transcript.push({ role: 'user', text, at: Date.now() }, { role: 'assistant', text: `Got: ${text}`, at: Date.now() });
  });
  const impl = await b.sched.create({ name: 'Implement', action: { ...launchAction, prompt: 'Build it' }, trigger: { kind: 'manual' }, createdBy: 't' });
  const review = await b.sched.create({ name: 'Review', action: { kind: 'launch', preset: 'claude', cwd: '/w', prompt: 'Review what {{trigger.session}} did' }, trigger: { kind: 'after', job: impl.id, on: 'success' }, createdBy: 't' });
  await b.sched.runNow(impl.id);
  await b.settle();
  const r = await b.sched.get(review.id);
  assert.equal(r.runs.length, 1);
  assert.equal(r.runs[0].state, 'succeeded');
  assert.match(b.sent.at(-1)!.text, /^Review what u1 did$/, 'templated with the upstream session, as data');

  const flaky = await b.sched.create({ name: 'Flaky', action: { ...launchAction, prompt: 'FAIL please' }, trigger: { kind: 'manual' }, policy: { retries: 2, backoffSeconds: 0 }, createdBy: 't' });
  const after = await b.sched.create({ name: 'After flaky', action: launchAction, trigger: { kind: 'after', job: flaky.id, on: 'success' }, createdBy: 't' });
  await b.sched.runNow(flaky.id);
  for (let i = 0; i < 4; i++) await b.settle();
  const f = await b.sched.get(flaky.id);
  assert.deepEqual(f.runs.map((x) => [x.attempt, x.state]).reverse(), [[1, 'failed'], [2, 'failed'], [3, 'failed']], 'one try and two retries, no more');
  assert.equal(f.state, 'scheduled', 'a manual job can be run again');
  const skipped = (await b.sched.get(after.id)).runs;
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].state, 'skipped');
  assert.match(skipped[0].outcome.skippedBecause!, /failed/);
});

test('scheduler: limits hold runs back instead of dropping them; cancel stops what is pending', async () => {
  const b = await bed({ maxConcurrent: 1, maxLaunchesPerHour: 2, maxRetriesPerMinute: 10 });
  b.setBehave((s, text) => s.transcript.push({ role: 'user', text, at: Date.now() })); // takes it, never answers
  const jobs = [];
  for (let i = 0; i < 4; i++) jobs.push(await b.sched.create({ name: `J${i}`, action: { ...launchAction, prompt: `job ${i}` }, trigger: { kind: 'manual' }, createdBy: 't' }));
  for (const j of jobs) await b.sched.runNow(j.id);
  await b.settle();
  assert.equal(b.launched.length, 1, 'one at a time');
  await b.sched.cancel(jobs[3].id);
  assert.equal((await b.sched.get(jobs[3].id)).runs[0].state, 'cancelled');
  for (const s of b.sessions.values()) s.transcript.push({ role: 'assistant', text: 'done', at: Date.now() });
  await b.settle();
  assert.equal(b.launched.length, 2, 'the next one, within the hourly launch cap');
  for (const s of b.sessions.values()) s.transcript.push({ role: 'assistant', text: 'done', at: Date.now() });
  await b.settle();
  assert.equal(b.launched.length, 2, 'the cap holds the third back');
  assert.equal((await b.sched.get(jobs[2].id)).runs[0].state, 'eligible', 'held, not dropped');
});

test('scheduler: a decision waits for you; approving runs its follow-up, declining stops', async () => {
  const b = await bed();
  b.sessions.set('impl', { uid: 'impl', status: 'idle', queue: [], transcript: [] });
  const ask = await b.sched.create({ name: 'Findings', action: { kind: 'decide', title: 'Send the review to the implementer?', body: 'Reviewer said: X is wrong', then: { kind: 'send', target: 'impl', text: 'Address these: X is wrong' } }, trigger: { kind: 'manual' }, createdBy: 't' });
  const run = await b.sched.runNow(ask.id);
  await b.settle();
  assert.equal((await b.sched.run(run.id)).state, 'waiting');
  assert.equal((await b.sched.get(ask.id)).state, 'waiting');
  assert.equal(b.sched.state().waiting[0].title, 'Send the review to the implementer?');
  assert.ok(b.alerts.some((a) => a.startsWith('Decide:')), 'your devices are told');
  await b.sched.decide(run.id, { approve: true });
  await b.settle();
  assert.equal((await b.sched.run(run.id)).state, 'succeeded');
  assert.equal(b.sent.at(-1)!.text, 'Address these: X is wrong');
  const no = await b.sched.runNow(ask.id);
  await b.settle();
  await b.sched.decide(no.id, { approve: false, note: 'not now' });
  assert.equal((await b.sched.run(no.id)).state, 'cancelled');
  assert.equal(b.sent.filter((x) => x.uid === 'impl').length, 1, 'declined: nothing sent');
  await assert.rejects(b.sched.create({ name: 'x', action: { ...launchAction, mode: 'yolo' }, trigger: { kind: 'manual' }, createdBy: 't' }), /allowDangerous/);
});

test('scheduler: after a crash the evidence decides: relaunch what never started, keep watching what arrived, ask about the rest', async () => {
  const b = await bed();
  const mk = async (name: string, action: object) => b.sched.create({ name, action, trigger: { kind: 'manual' }, createdBy: 't' });
  b.sessions.set('x', { uid: 'x', status: 'busy', queue: [], transcript: [] });
  b.sessions.set('y', { uid: 'y', status: 'idle', queue: [], transcript: [] });
  // Four runs a dead process held, at different points.
  const never = await mk('never launched', launchAction);
  const queued = await mk('queued', { kind: 'send', target: 'x', text: 'queued text' });
  const lost = await mk('maybe typed', { kind: 'send', target: 'y', text: 'lost text' });
  const fresh = await mk('not started', launchAction);
  const hold = async (job: string, data: Record<string, unknown>) => {
    const r = await b.sched.runNow(job);
    await b.db.jobRun.update({ where: { id: r.id }, data: { state: 'running', owner: 'dead', ...data } });
    return r.id;
  };
  const r1 = await hold(never.id, { sessionUid: 'u77', deliveryJson: JSON.stringify({ dispatchingAt: 1, mark: 0 }) });
  const r2 = await hold(queued.id, { sessionUid: 'x', deliveryJson: JSON.stringify({ dispatchingAt: 1, mark: 0, text: 'queued text' }) });
  b.sessions.get('x')!.queue.push(r2);
  const r3 = await hold(lost.id, { sessionUid: 'y', deliveryJson: JSON.stringify({ dispatchingAt: 1, mark: 0, text: 'lost text' }) });
  const r4 = await hold(fresh.id, {});
  const restarted = new Scheduler(b.db, b.deps);
  const out = await restarted.reconcile(b.windows());
  assert.deepEqual(out, { resumed: 1, requeued: 2, uncertain: 1 });
  assert.equal((await restarted.run(r1)).state, 'eligible', 'its session never existed: launch it');
  assert.equal((await restarted.run(r2)).state, 'running', 'in the queue: on its way');
  assert.equal((await restarted.run(r3)).state, 'uncertain', 'maybe typed: never re-sent on a guess');
  assert.equal((await restarted.run(r4)).state, 'eligible');
  assert.equal(b.sent.length, 0, 'reconciling sent nothing');
  await restarted.resolveUncertain(r3, { resend: true });
  for (let i = 0; i < 8; i++) await restarted.tick(b.windows());
  assert.equal(b.sent.filter((s) => s.text === 'lost text').length, 1, 'sent again once, at your word');
});

test('scheduler: work for an agent at a stated limit waits for the reset (no other provider), then goes', async () => {
  const b = await bed();
  let until: number | null = Math.floor(Date.now() / 1000) + 3600;
  b.deps.capacity = async (h) => (h === 'claude' && until ? { until, why: 'session limit' } : null);
  const job = await b.sched.create({ name: 'Held', action: launchAction, trigger: { kind: 'manual' }, createdBy: 't' });
  const run = await b.sched.runNow(job.id);
  await b.settle();
  assert.equal(b.launched.length, 0, 'not launched into a known limit');
  const held = await b.sched.run(run.id);
  assert.equal(held.state, 'eligible');
  assert.match(held.error!, /waiting for claude's limit to reset/);
  until = null;
  await b.settle();
  assert.equal(b.launched.length, 1, 'goes once the limit is gone');
  assert.equal((await b.sched.run(run.id)).error, null);
});

test('scheduler: every interval heartbeats fire periodically, catch up once, skip when busy or ended', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T06:00:00Z') });
  const b = await bed();
  b.sessions.set('cos', { uid: 'cos', status: 'idle', queue: [], transcript: [] });
  await assert.rejects(() => b.sched.create({ name: 'Too fast', action: { kind: 'send', target: 'cos', text: 'ping' }, trigger: { kind: 'every', seconds: 5 }, createdBy: 't' }), /between 10/);
  const job = await b.sched.create({
    name: 'Heartbeat',
    action: { kind: 'send', target: 'cos', text: 'Heartbeat check' },
    trigger: { kind: 'every', seconds: 60 },
    policy: { skipIfBusy: true, ifLive: true, maxRuns: 4 },
    createdBy: 't',
  });
  assert.equal(job.nextRunAt, Date.parse('2026-11-16T06:01:00Z') / 1000);

  // First beat while idle: sends.
  t.mock.timers.setTime(Date.parse('2026-11-16T06:01:05Z'));
  await b.settle();
  assert.equal(b.sent.length, 1);

  // Second beat while busy: skipped cleanly, job stays scheduled.
  b.sessions.get('cos')!.status = 'busy';
  t.mock.timers.setTime(Date.parse('2026-11-16T06:02:10Z'));
  await b.settle();
  assert.equal(b.sent.length, 1, 'skipped while busy');
  assert.equal((await b.sched.get(job.id)).runs[0].state, 'skipped');
  assert.equal((await b.sched.get(job.id)).state, 'scheduled');

  // Third beat while ended: skipped cleanly, never resurrects.
  b.sessions.get('cos')!.ended = true;
  t.mock.timers.setTime(Date.parse('2026-11-16T06:10:00Z'));
  await b.settle();
  assert.equal(b.sent.length, 1, 'skipped while ended (and missed beats coalesce to one)');
  assert.equal((await b.sched.get(job.id)).runs[0].outcome.skippedBecause, 'target session is not running');

  // Fourth beat back idle: hits maxRuns and marks job done.
  b.sessions.get('cos')!.ended = false;
  b.sessions.get('cos')!.status = 'idle';
  t.mock.timers.setTime(Date.parse('2026-11-16T06:11:05Z'));
  await b.settle();
  assert.equal(b.sent.length, 2);
  assert.equal((await b.sched.get(job.id)).state, 'done');
  mock.timers.reset();
});

test('scheduler: fleet session trigger watches any waiting session, excludes target, fills templates and repeats', async () => {
  const b = await bed();
  b.sessions.set('cos', { uid: 'cos', status: 'idle', queue: [], transcript: [] });
  b.sessions.set('w1', { uid: 'w1', status: 'idle', queue: [], transcript: [] });
  let w1Ask: WindowView['ask'] = null;
  let w1AskId: string | null = null;
  const customWindows = (): WindowView[] =>
    [...b.sessions.values()]
      .filter((s) => !s.ended)
      .map((s) => ({
        uid: s.uid,
        title: s.uid === 'w1' ? 'Worker One' : 'Chief',
        name: s.uid,
        agent: s.uid === 'w1' ? 'codex' : 'claude',
        status: s.status,
        activity: 0,
        ask: s.uid === 'w1' ? w1Ask : null,
        askId: s.uid === 'w1' ? w1AskId : null,
        answerable: s.uid === 'w1' && !!w1Ask,
      }) as WindowView);

  const settleCustom = async () => {
    for (let i = 0; i < 6; i++) {
      await b.sched.tick(customWindows());
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const watch = await b.sched.create({
    name: 'Fleet prompts',
    action: { kind: 'send', target: 'cos', text: 'Event={{trigger.event}} Session={{trigger.session}} Title={{trigger.title}} Agent={{trigger.agent}} Ask={{trigger.ask}}' },
    trigger: { kind: 'session', uid: '*', on: 'waiting', repeat: true },
    createdBy: 't',
  });

  // Target itself going waiting must NOT trigger itself.
  b.sessions.get('cos')!.status = 'waiting';
  await settleCustom();
  assert.equal(b.sent.length, 0);
  b.sessions.get('cos')!.status = 'idle';

  // Worker enters waiting with prompt 1: wakes Chief once.
  b.sessions.get('w1')!.status = 'waiting';
  w1Ask = { kind: 'command', text: 'rm -rf dist' };
  w1AskId = 'ask-aaa';
  await settleCustom();
  await settleCustom();
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].uid, 'cos');
  assert.equal(b.sent[0].text, 'Event=waiting Session=w1 Title=Worker One Agent=codex Ask=rm -rf dist');
  assert.equal((await b.sched.get(watch.id)).state, 'scheduled', 'repeating watch stays scheduled');

  // New distinct prompt on worker wakes Chief again.
  w1Ask = { kind: 'command', text: 'git push --force' };
  w1AskId = 'ask-bbb';
  await settleCustom();
  assert.equal(b.sent.length, 2);
  assert.match(b.sent[1].text, /git push --force/);
});

test('scheduler: non-transcript harnesses settle cleanly without hanging on readTranscript', async () => {
  const b = await bed();
  b.sessions.set('shell1', { uid: 'shell1', status: 'idle', queue: [], transcript: [] });
  b.deps.hasTranscript = () => false;
  b.deps.readTranscript = async () => null;
  b.setBehave(() => {}); // No transcript written at all.

  const job = await b.sched.create({
    name: 'Shell wake',
    action: { kind: 'send', target: 'shell1', text: 'echo hello' },
    trigger: { kind: 'manual' },
    policy: { until: 'delivered' },
    createdBy: 't',
  });
  const run = await b.sched.runNow(job.id);
  await b.settle();
  assert.equal((await b.sched.run(run.id)).state, 'succeeded');
});

test('scheduler: stalled trigger fires when a busy session makes no screen progress past afterSeconds', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T08:00:00Z') });
  try {
    const b = await bed();
    b.sessions.set('cos', { uid: 'cos', status: 'idle', queue: [], transcript: [] });
    b.sessions.set('w1', { uid: 'w1', status: 'busy', queue: [], transcript: [] });
    let busySince = Math.floor(Date.now() / 1000);
    let contentAt = busySince;

    const customWindows = (): WindowView[] =>
      [...b.sessions.values()].map((s) => ({
        uid: s.uid,
        title: s.uid === 'w1' ? 'Worker One' : 'Chief',
        name: s.uid,
        agent: 'claude',
        status: s.status,
        activity: contentAt,
        busySince: s.uid === 'w1' && s.status === 'busy' ? busySince : null,
        contentAt: s.uid === 'w1' ? contentAt : Math.floor(Date.now() / 1000),
      }) as WindowView);

    const settleCustom = async () => {
      for (let i = 0; i < 5; i++) {
        await b.sched.tick(customWindows());
        await new Promise((r) => setTimeout(r, 5));
      }
    };

    const job = await b.sched.create({
      name: 'Stall watchdog',
      action: { kind: 'send', target: 'cos', text: 'Stalled {{trigger.session}} for {{trigger.stalledSeconds}}s ({{trigger.event}})' },
      trigger: { kind: 'session', uid: '*', on: 'stalled', afterSeconds: 120, repeat: true },
      createdBy: 't',
    });

    // At +90s: not stalled yet.
    t.mock.timers.setTime(Date.parse('2026-11-16T08:01:30Z'));
    await settleCustom();
    assert.equal(b.sent.length, 0);

    // At +130s with no screen progress: fires once.
    t.mock.timers.setTime(Date.parse('2026-11-16T08:02:10Z'));
    await settleCustom();
    await settleCustom();
    assert.equal(b.sent.length, 1);
    assert.match(b.sent[0].text, /^Stalled w1 for 130s \(stalled\)$/);
    assert.equal((await b.sched.get(job.id)).state, 'scheduled');

    // Screen advances → resets stall; later stalls again → fires a second time.
    contentAt = Math.floor(Date.now() / 1000);
    t.mock.timers.setTime(Date.parse('2026-11-16T08:04:30Z'));
    await settleCustom();
    assert.equal(b.sent.length, 2);
  } finally {
    t.mock.timers.reset();
  }
});

test('scheduler: overlap trigger fires when active checkouts edit the same file(s)', async () => {
  const b = await bed();
  b.sessions.set('cos', { uid: 'cos', status: 'idle', queue: [], transcript: [] });
  let currentOverlaps: Array<{ repoRoot: string; repoName: string; key: string; sessions: string[]; files: string[] }> = [];
  b.deps.overlaps = async () => currentOverlaps;

  const job = await b.sched.create({
    name: 'Overlap watch',
    action: { kind: 'send', target: 'cos', text: 'Overlap in {{trigger.repo}} between {{trigger.sessions}} on {{trigger.files}}' },
    trigger: { kind: 'overlap', repo: 'agent-house', repeat: true },
    createdBy: 't',
  });

  // Different repo doesn't trigger.
  currentOverlaps = [{ repoRoot: '/code/other', repoName: 'other', key: 'ck1:ck2', sessions: ['w1', 'w2'], files: ['a.ts'] }];
  await b.settle();
  assert.equal(b.sent.length, 0);

  // Matching repo triggers once for this file set.
  currentOverlaps = [{ repoRoot: '/code/agent-house', repoName: 'agent-house', key: 'ck3:ck4', sessions: ['w1', 'w2'], files: ['server/core.ts', 'bin/cli.js'] }];
  await b.settle();
  await b.settle();
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].text, 'Overlap in agent-house between w1, w2 on server/core.ts, bin/cli.js');
  assert.equal((await b.sched.get(job.id)).state, 'scheduled');

  // Adding another overlapping file fires again.
  currentOverlaps = [{ repoRoot: '/code/agent-house', repoName: 'agent-house', key: 'ck3:ck4', sessions: ['w1', 'w2'], files: ['server/core.ts', 'bin/cli.js', 'server/main.ts'] }];
  await b.settle();
  assert.equal(b.sent.length, 2);
});

test('scheduler: Space-scoped session event trigger isolates Spaces and cancelByOwner cleans up ended Chiefs', async () => {
  const b = await bed();
  b.sessions.set('cos', { uid: 'cos', status: 'idle', queue: [], transcript: [] });
  b.sessions.set('w-in', { uid: 'w-in', status: 'idle', queue: [], transcript: [] });
  b.sessions.set('w-out', { uid: 'w-out', status: 'idle', queue: [], transcript: [] });

  const customWindows = (): WindowView[] =>
    [...b.sessions.values()].map((s) => ({
      uid: s.uid,
      title: s.uid,
      name: s.uid,
      agent: 'claude',
      status: s.status,
      space: s.uid === 'w-out' ? 'OtherSpace' : 'LaunchOps',
      project: s.uid === 'w-out' ? 'OtherSpace' : 'LaunchOps',
      activity: 1,
      ask: s.status === 'waiting' ? { kind: 'command', text: 'npm test' } : null,
      askId: s.status === 'waiting' ? `ask-${s.uid}` : null,
      answerable: s.status === 'waiting',
    }) as WindowView);

  const settleCustom = async () => {
    for (let i = 0; i < 6; i++) {
      await b.sched.tick(customWindows());
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const watch = await b.sched.create({
    name: 'Chief watch waiting (LaunchOps)',
    action: { kind: 'send', target: 'cos', text: 'Waiting {{trigger.session}}' },
    trigger: { kind: 'session', uid: '*', space: 'LaunchOps', on: 'waiting', repeat: true, exclude: ['cos'] },
    policy: { ifLive: true, until: 'delivered' },
    createdBy: 'system:chief:cos',
  });

  // Worker in OtherSpace going waiting must NOT wake LaunchOps Chief.
  b.sessions.get('w-out')!.status = 'waiting';
  await settleCustom();
  assert.equal(b.sent.length, 0);

  // Worker in LaunchOps going waiting DOES wake LaunchOps Chief.
  b.sessions.get('w-in')!.status = 'waiting';
  await settleCustom();
  assert.equal(b.sent.length, 1);
  assert.equal(b.sent[0].uid, 'cos');
  assert.equal(b.sent[0].text, 'Waiting w-in');

  // Cancelling by owner cleanly cancels Chief's auto-subscribed watch.
  const cancelled = await b.sched.cancelByOwner('system:chief:cos');
  assert.equal(cancelled, 1);
  assert.equal((await b.sched.get(watch.id)).state, 'cancelled');
});

test('scheduler: excludeRoles prevents two-Chief wake loops and skips waking a Chief waiting on a prompt', async () => {
  const b = await bed();
  b.sessions.set('cos-a', { uid: 'cos-a', status: 'idle', queue: [], transcript: [] });
  b.sessions.set('cos-b', { uid: 'cos-b', status: 'idle', queue: [], transcript: [] });
  b.sessions.set('w-a', { uid: 'w-a', status: 'idle', queue: [], transcript: [] });

  const customWindows = (): WindowView[] =>
    [...b.sessions.values()].map((s) => ({
      uid: s.uid,
      title: s.uid,
      name: s.uid,
      agent: 'claude',
      status: s.status,
      space: 'LaunchOps',
      project: 'LaunchOps',
      supervision:
        s.uid === 'w-a'
          ? { role: 'worker', managedBy: 'cos-a', space: 'LaunchOps' }
          : { role: 'chief', space: 'LaunchOps' },
      activity: 1,
      ask: s.status === 'waiting' ? { kind: 'command', text: 'npm test' } : null,
      askId: s.status === 'waiting' ? `ask-${s.uid}` : null,
      answerable: s.status === 'waiting',
    }) as WindowView);

  const settleCustom = async () => {
    for (let i = 0; i < 6; i++) {
      await b.sched.tick(customWindows());
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  await b.sched.create({
    name: 'Chief A waiting watch',
    action: { kind: 'send', target: 'cos-a', text: 'Waiting {{trigger.session}}' },
    trigger: { kind: 'session', uid: '*', space: 'LaunchOps', on: 'waiting', repeat: true, exclude: ['cos-a'], excludeRoles: ['chief'] },
    policy: { ifLive: true, skipIfBusy: true, until: 'delivered' },
    createdBy: 'system:chief:cos-a',
  });

  // Chief B going waiting must NOT wake Chief A (excludeRoles: ['chief']).
  b.sessions.get('cos-b')!.status = 'waiting';
  await settleCustom();
  assert.equal(b.sent.length, 0);
  b.sessions.get('cos-b')!.status = 'idle';

  // If Chief A itself is waiting on a prompt, worker waiting skips cleanly instead of typing into Chief A's prompt.
  b.sessions.get('cos-a')!.status = 'waiting';
  b.sessions.get('w-a')!.status = 'waiting';
  await settleCustom();
  assert.equal(b.sent.length, 0);
});
