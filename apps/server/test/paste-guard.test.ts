// ah looked at the pane (its agent there) and then typed: an agent that exited in between left
// its shell to take the message, and the Enter ran it as a command. Each paste and Enter into an
// agent's window now goes in only while tmux itself sees the agent in front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/dies-on-paste.js', import.meta.url));

test('an agent that exits as the message arrives: nothing runs in its shell, the message stays queued', async () => {
  const ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: [{ id: 'brittle', name: 'Brittle', command: `${process.execPath} ${fixture}`, match: '^node$' }] });
  try {
    const { uid, id } = (await http(ah, 'POST', '/api/windows', { body: { preset: 'brittle', cwd: `${ah.dir}/files` } })).json();
    const view = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => (await view())?.agent === 'brittle', 15000, 'up');
    await new Promise((r) => setTimeout(r, 5500));
    const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'echo RAN-IN-THE-SHELL' } });
    assert.equal(sent.status, 200, sent.body);
    assert.equal(sent.json().outcome, 'queued', sent.body);
    await new Promise((r) => setTimeout(r, 2500));
    assert.doesNotMatch(ah.tmux('capture-pane', '-p', '-J', '-t', id), /^RAN-IN-THE-SHELL$/m, 'the shell ran it');
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 1, 'still owed');
  } finally {
    await cleanup(ah);
  }
});
