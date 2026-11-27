// Send Now on an agent ah reads from its screen (no hooks: Grok, Muse, agy). Its Stop shows
// only once the screen has been quiet `idleAfter` seconds; Send Now waited 6 s at most and
// answered "did not stop" for an agent that had stopped (found replaying the repo's bug
// history against real Grok and Muse). The stand-in is agy-like (`--tasks`: no hooks, a
// spinner while it works, Esc stops it); idleAfter is 6 s, past the old wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));

test("Send Now waits out a hookless agent's quiet spell instead of saying it didn't stop", { timeout: 120_000 }, async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 6,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture} --tasks --turn=120000`, match: '^node$', interruptKeys: ['Escape'] }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const view = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => ['idle', 'attention'].includes((await view())?.status) && (await view())?.agent === 'test-agent', 30_000, 'the agent up');
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'a long turn' } });
    await until(async () => (await view())?.status === 'busy', 20_000, 'working');
    assert.equal((await view()).statusSource === 'hook', false, 'read from its screen');
    const queued = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'the urgent one' } });
    assert.equal(queued.json().outcome, 'queued', queued.body);
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${queued.json().queueId}/send-now`);
    assert.equal(now.status, 200, now.body);
    await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', id).includes('RECEIVED:the urgent one'), 15_000, 'sent');
    assert.match(ah.tmux('capture-pane', '-p', '-J', '-t', id), /INTERRUPTED/);
  } finally {
    await cleanup(ah);
  }
});
