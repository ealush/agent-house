// After a relaunch the conversation runs under a new uid. Something still holding the
// old one — a notification's reply, a request in flight, a device that hadn't caught up
// — must reach the conversation where it runs now, not start a second agent on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, windows } from './fake-agents.ts';

test('a message to a relaunched session’s old uid goes to the conversation’s new window', async () => {
  const ah = await startBed();
  try {
    const w = await launch(ah, 'claude', ah.project, 'follow');
    await say(ah, w.uid, 'hello');
    const re = await http(ah, 'POST', `/api/sessions/${w.uid}/relaunch`, { body: {} });
    assert.equal(re.status, 200, re.body);
    const fresh = re.json();
    assert.notEqual(fresh.uid, w.uid);
    await until(async () => (await windows(ah)).find((x) => x.uid === fresh.uid && x.agent === 'claude' && x.harnessId === w.harnessId), 15000, 'the relaunched agent up, on the same conversation');
    await until(async () => !(await windows(ah)).some((x) => x.uid === w.uid), 15000, 'the old window gone');

    const late = await http(ah, 'POST', `/api/sessions/${w.uid}/send`, { body: { text: 'still there?' } });
    assert.equal(late.status, 200, late.body);
    assert.equal(late.json().windowId, fresh.id, 'typed into the conversation’s window');
    assert.equal(late.json().resumed, false);
    await new Promise((r) => setTimeout(r, 1500));
    const agents = (await windows(ah)).filter((x) => x.agent === 'claude');
    assert.equal(agents.length, 1, `one agent on the conversation, not ${agents.length}`);
  } finally {
    await cleanup(ah);
  }
});
