// A message to an agent session whose agent is gone (it crashed, was quit, or its command
// failed) with its shell left behind: never typed into that shell, where it would run as a
// command. It waits in the queue for an agent in the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, transcriptOf, windows } from './fake-agents.ts';

test("a message to a session whose agent has exited waits for an agent, and isn't typed into its shell", async () => {
  const ah = await startBed();
  try {
    const s = await launch(ah, 'codex', ah.project);
    await say(ah, s.uid, 'hello');
    // The agent dies; its window, a bare shell now, stays (recovery is off by default).
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'CRASH' } });
    const gone = await until(async () => {
      const w = (await windows(ah)).find((w) => w.uid === s.uid);
      return w && !w.agent && w.status !== 'busy' && w;
    }, 15000, 'the agent gone, the window still there');
    assert.equal(gone.id, s.id, 'the same window');

    const sent = await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'rm -rf would have run here' } });
    assert.equal(sent.status, 200, sent.body);
    assert.equal(sent.json().outcome, 'queued', sent.body);
    // Past the queue's start-up grace and a few passes: still queued, nothing in the shell.
    await new Promise((r) => setTimeout(r, 8000));
    const screen = ah.tmux('capture-pane', '-p', '-J', '-t', s.id);
    assert.doesNotMatch(screen, /rm -rf would have run here|command not found/, screen);
    assert.equal((await http(ah, 'GET', `/api/sessions/${s.uid}/queue`)).json().length, 1);

    // An agent back in the window (resumed by hand in the terminal) gets it.
    ah.tmux('send-keys', '-t', s.id, `${ah.bin}/codex resume ${s.harnessId}`, 'Enter');
    await until(async () => (await transcriptOf(ah, s.uid))?.includes('Got: rm -rf would have run here'), 20000, 'delivered to the agent');
    assert.equal((await http(ah, 'GET', `/api/sessions/${s.uid}/queue`)).json().length, 0);
  } finally {
    await cleanup(ah);
  }
});
