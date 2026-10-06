import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));

test('an exec-replaced agent is detected and concurrent follow-ups queue separately', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    // "Idle" means quiet for idleAfter seconds; keep it short so slow CI machines fit the budget.
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => {
      const w = await window();
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'root agent detected');
    const sent = await Promise.all(['alpha', 'beta', 'gamma'].map((text) => http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text } })));
    for (const r of sent) assert.equal(r.status, 200, r.body);
    assert.equal(sent.filter((r) => r.json().outcome === 'delivered').length, 1);
    const queued = (await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json();
    assert.equal(queued.length, 2);
    assert.equal(new Set(queued.map((q: any) => q.text)).size, 2);
    // Individual cancellation must leave the other follow-up queued.
    assert.equal((await http(ah, 'DELETE', `/api/sessions/${uid}/queue/${queued[1].id}`)).status, 200);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes(`FINISHED:${queued[0].text}`), 10000, 'remaining follow-up delivered');
    const screen = ah.tmux('capture-pane', '-p', '-t', id);
    assert.ok(!screen.includes(`RECEIVED:${queued[1].text}`), 'cancelled message never sent');
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0);
  } finally {
    await cleanup(ah);
  }
});

test('send-now interrupts the live turn and delivers one queued message', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    await until(async () => {
      const w = (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'root agent detected');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'routine' } })).json().outcome, 'delivered');
    const queuedSend = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'urgent' } });
    assert.equal(queuedSend.json().outcome, 'queued', 'urgent would otherwise wait');
    const queued = (await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json();
    assert.equal(queued.length, 1);
    // Unknown ids and unknown sessions fail instead of typing anywhere.
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/queue/nope/send-now`, {})).status, 404);
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${queued[0].id}/send-now`, {});
    assert.equal(now.status, 200, now.body);
    assert.equal(now.json().outcome, 'delivered');
    assert.equal(now.json().queued, 0);
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0);
    // The interrupt key lands in the fixture's input buffer ahead of the paste,
    // so match loosely; what matters is the urgent text arrives as a turn now.
    await until(() => /RECEIVED:.*urgent/.test(ah.tmux('capture-pane', '-p', '-t', id)), 10000, 'urgent delivered immediately');
  } finally {
    await cleanup(ah);
  }
});
