// Send Now pressed just as the queue moves on: the follow-up ahead of the urgent one went in a
// moment before, and the stop for the urgent one ends its turn before a word of answer. Codex
// keeps such a message in its conversation and ends the turn, so ah, seeing it there, used to
// count it done: it was never answered. It goes in again after the urgent one, as the queue
// showed them. (The conformance suite's restart scenario, 2026-11-28: ah restarted under a Send
// Now, the client asked again, and the new ah's queue had just typed the one ahead of it.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/transcript-agent.js', import.meta.url));

test('a follow-up whose turn a Send Now stops before its answer goes in again after the urgent one', { timeout: 90_000 }, async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'claude', name: 'Fixture', command: `exec ${process.execPath} ${fixture}`, match: '^node$', feed: 'claude' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid)?.harnessId, 15000, 'transcript adopted');
    const received = () => ah.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', id).match(/RECEIVED:.*/g) ?? [];
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'SLOW long' } })).json().outcome, 'delivered');
    await until(() => received().includes('RECEIVED:SLOW long'), 10000, 'the long turn started');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'SLOW ahead' } })).json().outcome, 'queued');
    const urgent = (await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'urgent' } })).json();
    assert.equal(urgent.outcome, 'queued');
    // Stopped, the agent is free, and the queue types the one ahead...
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/interrupt`, {})).status, 200);
    await until(() => received().includes('RECEIVED:SLOW ahead'), 15000, 'the queue moved on');
    // ...as Send Now comes for the urgent one: its stop ends that turn before any answer.
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${urgent.queueId}/send-now`, {});
    assert.equal(now.status, 200, now.body);
    await until(() => received().length >= 4, 30000, 'the one ahead went in again');
    assert.deepEqual(received(), ['RECEIVED:SLOW long', 'RECEIVED:SLOW ahead', 'RECEIVED:urgent', 'RECEIVED:SLOW ahead']);
    await until(() => ah.tmux('capture-pane', '-p', '-J', '-S', '-200', '-t', id).includes('DONE'), 15000, 'and was answered');
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0);
  } finally {
    await cleanup(ah);
  }
});
