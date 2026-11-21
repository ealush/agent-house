// Usage, black box: stand-in Claude Code and Codex sessions write their real usage
// records; the host counts them once, groups them, estimates what it can, says what
// it can't, and reports the provider's rate-limit windows with their source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, http } from './helpers.ts';
import { launch, say, startBed } from './fake-agents.ts';

test('tokens per model and conversation, list-price estimates, unknown left unknown, limits with their source, export', async () => {
  const ah = await startBed({ usage: { billing: { anthropic: 'subscription' } } }, { AH_USAGE: '0' });
  try {
    assert.equal((await http(ah, 'GET', '/api/hello')).json().features.usage, 1);
    const c = await launch(ah, 'claude', ah.project, 'Metered');
    await say(ah, c.uid, 'first');
    await say(ah, c.uid, 'second');
    const x = await launch(ah, 'codex', ah.project, 'Codex metered');
    await say(ah, x.uid, 'one turn');
    await http(ah, 'POST', '/api/usage/refresh');
    await http(ah, 'POST', '/api/usage/refresh'); // again: nothing new, nothing added
    const rep = (await http(ah, 'GET', '/api/usage?by=model')).json();
    const opus = rep.rows.find((r: any) => r.key === 'claude-opus-5-5');
    // Each reply: 1200 in, 60 out, 800 cache reads, 100 cache writes; written as two lines, counted once.
    assert.deepEqual([opus.messages, opus.tokens.input, opus.tokens.output, opus.tokens.cacheRead], [2, 2400, 120, 1600]);
    assert.equal(opus.tokens.source, 'local_telemetry');
    assert.equal(opus.cost.basis, 'list_price');
    assert.equal(opus.cost.billing, 'subscription');
    const gpt = rep.rows.find((r: any) => r.key === 'gpt-5.5-codex');
    assert.equal(gpt.cost.estimateUsd, null, 'no OpenAI price built in: no number, not zero');
    assert.equal(gpt.tokens.cacheRead, 1500);
    assert.match(rep.notes.cost, /not a bill/);
    const lim = (await http(ah, 'GET', '/api/usage/limits')).json();
    const primary = lim.windows.find((w: any) => w.harness === 'codex' && w.window === 'primary');
    assert.equal(primary.usedPercent, 12.5);
    assert.equal(primary.source, 'provider_telemetry');
    const session = (await http(ah, 'GET', `/api/sessions/${c.uid}/usage`)).json();
    assert.equal(session.models[0].messages, 2);
    const csv = await http(ah, 'GET', '/api/usage/export?format=csv');
    assert.match(String(csv.headers['content-type']), /text\/csv/);
    assert.match(csv.body, /claude-opus-5-5/);
    const bad = await http(ah, 'GET', '/api/usage?by=everything');
    assert.equal(bad.status, 400);
  } finally {
    await cleanup(ah);
  }
});
