import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

test('native settings commands and queued effort changes reach the agent with validated choices', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));
  const ah = await startAh({
    auth: { mode: 'off' }, idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$',
      effort: { args: ['--effort', '{level}'], levels: ['low', 'high'] }, switchEffort: '/effort {level}',
      settingsCommands: { mode: '/permissions', effort: '/effort' } }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => {
      const w = await window();
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/settings`, { body: { setting: 'invalid' } })).status, 400);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/settings`, { body: { setting: 'model' } })).status, 400);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/switch`, { body: { effort: 'invalid' } })).status, 400);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/switch`, { body: { effort: 'high', model: 'other' } })).status, 400);
    const permissions = await http(ah, 'POST', `/api/sessions/${uid}/settings`, { body: { setting: 'mode' } });
    assert.equal(permissions.status, 200, permissions.body);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:/permissions'));
    const effort = await http(ah, 'POST', `/api/sessions/${uid}/switch`, { body: { effort: 'high' } });
    assert.equal(effort.status, 200, effort.body);
    assert.equal(effort.json().outcome, 'queued');
    assert.equal((await window()).launchEffort, null, 'queued choice has not changed the running settings yet');
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:/effort high'), 12000);
    await until(async () => (await window()).launchEffort === 'high');
  } finally {
    await cleanup(ah);
  }
});
