// A session's first message whose Enter the agent lost (Grok's start screen, on ah, kept it in
// its box): no conversation was ever written, and ah counted that as "can't tell", so it said
// delivered and nothing noticed. Found dogfooding the stack on ah.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, http, until } from './helpers.ts';
import { startBed, transcriptOf, windows } from './fake-agents.ts';

test("a first message the agent never took is noticed, Entered again, and lands", async () => {
  const ah = await startBed({}, { FAKE_HARNESS_EAT_ENTER: '1' });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: ah.project } });
    assert.equal(created.status, 201, created.body);
    const { uid } = created.json();
    await until(async () => (await windows(ah)).some((w) => w.uid === uid && w.agent === 'claude' && ['idle', 'attention'].includes(w.status)), 15000, 'up');
    await new Promise((r) => setTimeout(r, 5500));
    const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'the very first message' } });
    assert.equal(sent.json().outcome, 'delivered', sent.body);
    await until(async () => (await transcriptOf(ah, uid))?.includes('Got: the very first message'), 40000, 'taken in the end');
    const w = (await windows(ah)).find((w) => w.uid === uid);
    assert.equal(w.unsent, 0);
    assert.equal((await transcriptOf(ah, uid))!.split('the very first message').length - 1, 2, 'once: the message and its reply');
  } finally {
    await cleanup(ah);
  }
});
