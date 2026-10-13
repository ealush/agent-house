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

test('permission modes switch live by cycling the key the footer answers to, and effort resets to the default', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));
  const ah = await startAh({
    auth: { mode: 'off' }, idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture} --modes`, match: '^node$',
      effort: { args: ['--effort', '{level}'], levels: ['low', 'high'] }, switchEffort: '/effort {level}', resetEffort: '/effort auto',
      modes: [{ id: 'default', name: 'Ask' }, { id: 'accept-edits', name: 'Accept edits' }, { id: 'plan', name: 'Plan' }, { id: 'dangerous', name: 'Skip', dangerous: true }],
      modeCycle: { key: 'BTab', detect: { default: 'manual mode on', 'accept-edits': 'accept edits on', plan: 'plan mode on', dangerous: 'bypass permissions on' } } }],
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
    const footer = () => ah.tmux('capture-pane', '-p', '-t', id).trim().split('\n').at(-1);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/mode`, { body: { mode: 'nope' } })).status, 400);

    const plan = await http(ah, 'POST', `/api/sessions/${uid}/mode`, { body: { mode: 'plan' } });
    assert.equal(plan.status, 200, plan.body);
    assert.deepEqual(plan.json(), { switched: true });
    assert.match(footer(), /plan mode on/, 'two presses, then it stopped');
    await until(async () => (await window()).launchMode === 'plan');

    // Not in this session's cycle: once round, back where it was, and the caller relaunches.
    const skip = await http(ah, 'POST', `/api/sessions/${uid}/mode`, { body: { mode: 'dangerous' } });
    assert.deepEqual(skip.json(), { switched: false });
    assert.match(footer(), /plan mode on/);

    // A mode changed in the terminal shows up from the footer.
    ah.tmux('send-keys', '-t', id, 'BTab');
    await until(async () => (await window()).launchMode === null, 8000);

    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/switch`, { body: { effort: 'high' } })).status, 200);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:/effort high'), 12000);
    await until(async () => (await window()).launchEffort === 'high');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/switch`, { body: { effort: 'default' } })).status, 200);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:/effort auto'), 12000);
    await until(async () => (await window()).launchEffort === null);
  } finally {
    await cleanup(ah);
  }
});
