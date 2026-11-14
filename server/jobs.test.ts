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
