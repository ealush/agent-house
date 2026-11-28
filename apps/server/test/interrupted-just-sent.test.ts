// A window closed a moment after a message went in, before the agent's screen showed it
// working: ah showed it working (a send holds the session busy until the agent's next sign),
// so it was cut off mid-turn, and is an interruption to restore. The session's last status
// was read before that hold, so the close looked like one of an idle session and was
// forgotten. (The app's integration test, 2026-11-28: it closes the window the moment the
// host shows "working", and failed whenever that was the hold.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/transcript-agent.js', import.meta.url));

test('a window closed while a message just sent holds the session working is cut off mid-turn', { timeout: 60_000 }, async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    interruptions: { autoRestore: false },
    presets: [{ id: 'claude', name: 'Fixture', command: `exec ${process.execPath} ${fixture}`, match: '^node$', feed: 'claude' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const view = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => (await view())?.harnessId && ['idle', 'attention'].includes((await view()).status), 15000, 'adopted, idle');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'HUSH think it over' } })).json().outcome, 'delivered');
    await until(async () => (await view())?.status === 'busy', 4000, 'shown working');
    ah.tmux('kill-window', '-t', id);
    const item = await until(async () => (await http(ah, 'GET', '/api/state')).json().history.find((h: any) => h.ref === uid && h.interrupted), 10000, 'interrupted');
    assert.equal(item.interrupted.cause, 'window');
    assert.equal(item.interrupted.midTurn, true);
  } finally {
    await cleanup(ah);
  }
});
