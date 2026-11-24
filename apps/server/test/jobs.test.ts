// Scheduled and conditional work, black box (Workflow C), on stand-in agents: an
// implementation agent finishes, a review job starts on its own, the review's answer
// comes to you as a decision, and approving sends it back to the implementer, all
// without anything polling from a page. And a scheduled job survives a restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, http, until } from './helpers.ts';
import { startBed, transcriptOf, windows } from './fake-agents.ts';

const jobs = async (ah: { port: number }) => (await http(ah, 'GET', '/api/jobs')).json();

test('implement → review → your decision → findings back to the implementer', async () => {
  const ah = await startBed();
  try {
    assert.ok((await http(ah, 'GET', '/api/hello')).json().features.jobs >= 2);
    const create = async (body: object) => {
      const r = await http(ah, 'POST', '/api/jobs', { body });
      assert.equal(r.status, 201, r.body);
      return r.json();
    };
    const impl = await create({ name: 'Implement', action: { kind: 'launch', preset: 'claude', cwd: ah.project, prompt: 'Implement the parser' }, trigger: { kind: 'manual' } });
    const review = await create({ name: 'Review', action: { kind: 'launch', preset: 'codex', cwd: ah.project, prompt: 'Review what session {{trigger.session}} changed' }, trigger: { kind: 'after', job: impl.id, on: 'success' } });
    const decide = await create({
      name: 'Findings',
      action: { kind: 'decide', title: 'Send the review to the implementer?', body: '{{trigger.reply}}', then: { kind: 'send', target: `{{job:${impl.id}.session}}`, text: 'A reviewer said:\n{{trigger.reply}}\nAddress what holds up.' } },
      trigger: { kind: 'after', job: review.id, on: 'success' },
    });

    const run = await http(ah, 'POST', `/api/jobs/${impl.id}/run`);
    assert.equal(run.status, 200, run.body);
    // Nothing polls from here: the host carries it to the decision on its own.
    const waiting = await until(async () => (await http(ah, 'GET', '/api/state')).json().jobs?.waiting?.[0], 45000, 'the decision');
    assert.equal(waiting.title, 'Send the review to the implementer?');
    assert.match(waiting.body, /^Got: Review what session \w+ changed/);
    const implRun = (await http(ah, 'GET', `/api/jobs/${impl.id}`)).json().runs[0];
    assert.equal(implRun.state, 'succeeded');
    assert.match(implRun.outcome.reply, /Got: Implement the parser/);
    const reviewer = (await windows(ah)).find((w) => w.agent === 'codex');
    assert.match((await transcriptOf(ah, reviewer.uid))!, new RegExp(`Review what session ${implRun.sessionUid} changed`));

    const ok = await http(ah, 'POST', `/api/jobs/runs/${waiting.runId}/decide`, { body: { approve: true } });
    assert.equal(ok.status, 200, ok.body);
    await until(async () => (await transcriptOf(ah, implRun.sessionUid))?.includes('A reviewer said:'), 20000, 'findings at the implementer');
    const done = await until(async () => {
      const r = (await http(ah, 'GET', `/api/jobs/runs/${waiting.runId}`)).json();
      return r.state === 'succeeded' && r;
    }, 20000, 'decision run finished');
    assert.equal(done.outcome.decision, 'approved');
    assert.equal((await windows(ah)).filter((w) => w.agent).length, 2, 'two agents started, no more');
    const all = await jobs(ah);
    assert.deepEqual(all.jobs.map((j: any) => [j.name, j.lastRun?.state]).sort(), [['Findings', 'succeeded'], ['Implement', 'succeeded'], ['Review', 'succeeded']]);
  } finally {
    await cleanup(ah);
  }
});

test('a scheduled job survives a restart and runs exactly once; bad jobs are refused', async () => {
  let ah = await startBed();
  try {
    const bad = await http(ah, 'POST', '/api/jobs', { body: { name: 'x', action: { kind: 'launch', preset: 'claude', cwd: ah.project, prompt: 'p' }, trigger: { kind: 'cron', expr: '61 * * * *', tz: 'UTC' } } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json().code, 'invalid_trigger');
    const noTarget = await http(ah, 'POST', '/api/jobs', { body: { name: 'x', action: { kind: 'send', target: 'nobody', text: 'hi' }, trigger: { kind: 'manual' } } });
    assert.equal(noTarget.json().code, 'unknown_target');

    const at = Math.floor(Date.now() / 1000) + 4;
    const job = (await http(ah, 'POST', '/api/jobs', { body: { name: 'Later', action: { kind: 'launch', preset: 'claude', cwd: ah.project, prompt: 'Scheduled hello' }, trigger: { kind: 'at', at } } })).json();
    ah = Object.assign(await ah.restart(), { bin: ah.bin, project: ah.project });
    const out = await until(async () => {
      const j = (await http(ah, 'GET', `/api/jobs/${job.id}`)).json();
      return j.state === 'done' && j;
    }, 30000, 'ran after the restart');
    assert.equal(out.runs.length, 1);
    assert.equal(out.runs[0].state, 'succeeded');
    assert.ok(out.runs[0].scheduledFor >= at);
    assert.equal((await windows(ah)).filter((w) => w.agent === 'claude').length, 1, 'one session, launched once');

    const paused = (await http(ah, 'POST', '/api/jobs', { body: { name: 'Paused', action: { kind: 'launch', preset: 'claude', cwd: ah.project, prompt: 'never' }, trigger: { kind: 'at', at: Math.floor(Date.now() / 1000) + 2 } } })).json();
    assert.equal((await http(ah, 'POST', `/api/jobs/${paused.id}/pause`)).json().state, 'paused');
    await new Promise((r) => setTimeout(r, 4000));
    assert.equal((await http(ah, 'GET', `/api/jobs/${paused.id}`)).json().runs.length, 0, 'paused: it waits');
    assert.equal((await http(ah, 'POST', `/api/jobs/${paused.id}/cancel`)).json().state, 'cancelled');
  } finally {
    await cleanup(ah);
  }
});
