// Codex 0.162 takes a digit on its trust prompt as a move, and Enter as the choice: ah typed
// "1" for "Trust and continue" (a session started trusting its folder, and a tap in the app)
// and the prompt stayed (found dogfooding the stack on ah, from the phone).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/move-picker.js', import.meta.url));
const preset = { id: 'mover', name: 'Mover', command: `exec ${process.execPath} ${fixture}`, match: '^node$', trust: { pattern: 'Trust this folder\\? Codex can', accept: '^Trust and continue' } };

test('an option whose key only moves the cursor is picked: a trust accepted at launch, and one chosen from the app', async () => {
  const ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [preset] });
  try {
    const screen = (id: string) => ah.tmux('capture-pane', '-p', '-J', '-t', id);
    // Started trusting its folder: ah accepts the prompt itself.
    const auto = (await http(ah, 'POST', '/api/windows', { body: { preset: 'mover', cwd: `${ah.dir}/files`, trust: true } })).json();
    await until(() => screen(auto.id).includes('TRUSTED'), 20000, 'trusted at launch');

    // Chosen from the app.
    const asked = (await http(ah, 'POST', '/api/windows', { body: { preset: 'mover', cwd: `${ah.dir}/files` } })).json();
    const view = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === asked.uid);
    await until(async () => (await view())?.ask?.gate?.kind === 'trust', 20000, 'asking');
    const chose = await http(ah, 'POST', `/api/sessions/${asked.uid}/choose`, { body: { key: '1' } });
    assert.equal(chose.status, 200, chose.body);
    await until(() => screen(asked.id).includes('TRUSTED'), 10000, 'trusted from the app');
  } finally {
    await cleanup(ah);
  }
});
