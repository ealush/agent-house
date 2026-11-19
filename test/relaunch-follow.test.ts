// After a relaunch the conversation runs under a new uid. Something still holding the
// old one — a notification's reply, a request in flight, a device that hadn't caught up
// — must reach the conversation where it runs now, not start a second agent on it.
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { cleanup, http, startAh, until } from './helpers.ts';
import { bedDir, fakePresets, launch, say, windows } from './fake-agents.ts';

test('a message to a relaunched session’s old uid goes to the conversation’s new window', async () => {
  // The resumed agent takes a few seconds to start (sleep 3), as a real CLI can: until
  // then the relaunched window is a shell, with no agent seen in it.
  const { dir, bin, project } = bedDir();
  writeFileSync(join(bin, 'slow-claude'), `#!/bin/sh\nsleep 3\nexec "${bin}/claude" "$@"\n`, { mode: 0o755 });
  const presets = fakePresets(bin).map((p) => (p.id === 'claude' ? { ...p, resumeId: `${bin}/slow-claude --resume {id}` } : p));
  const ah = Object.assign(await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets }, dir), { project });
  try {
    const w = await launch(ah, 'claude', ah.project, 'follow');
    await say(ah, w.uid, 'hello');
    const re = await http(ah, 'POST', `/api/sessions/${w.uid}/relaunch`, { body: {} });
    assert.equal(re.status, 200, re.body);
    const fresh = re.json();
    assert.notEqual(fresh.uid, w.uid);
    // At once, before the relaunched agent is even up: the moment a request in flight lands.
    const late = await http(ah, 'POST', `/api/sessions/${w.uid}/send`, { body: { text: 'still there?' } });
    assert.equal(late.status, 200, late.body);
    assert.equal(late.json().windowId, fresh.id, 'it goes to the conversation’s new window');
    assert.equal(late.json().resumed, false);
    await until(async () => (await windows(ah)).find((x) => x.uid === fresh.uid && x.agent === 'claude' && x.harnessId === w.harnessId), 15000, 'the relaunched agent up, on the same conversation');
    await new Promise((r) => setTimeout(r, 2000));
    const agents = (await windows(ah)).filter((x) => x.agent === 'claude');
    assert.equal(agents.length, 1, `one agent on the conversation, not ${agents.length}`);
  } finally {
    await cleanup(ah);
  }
});
