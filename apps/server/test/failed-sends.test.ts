// A send or Send Now that didn't go through left no trace (only the ones that did were in the
// audit log): "did not stop" on the phone couldn't be looked up afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAh, cleanup, http, until } from './helpers.ts';

test('a send and a Send Now that fail are in the audit log, with why, and without the message', async () => {
  const ah = await startAh({ auth: { mode: 'off' } });
  try {
    const gone = await http(ah, 'POST', '/api/sessions/nosuch01/send', { body: { text: 'a private thought' } });
    assert.equal(gone.status, 404, gone.body);
    const made = (await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files` } })).json();
    const now = await http(ah, 'POST', `/api/sessions/${made.uid}/queue/nosuchitem/send-now`);
    assert.equal(now.status, 404, now.body);
    const lines = () => ah.log().split('\n').filter((l) => l.includes('[audit]'));
    await until(() => lines().some((l) => l.includes('"session.send-now.failed"')), 5000, 'logged');
    const sendFailed = lines().find((l) => l.includes('"session.send.failed"'))!;
    assert.match(sendFailed, /"ref":"nosuch01".*"status":404/);
    const nowFailed = lines().find((l) => l.includes('"session.send-now.failed"'))!;
    assert.match(nowFailed, new RegExp(`"uid":"${made.uid}".*"item":"nosuchitem".*"status":404.*"code":"queue_item_gone"`));
    assert.doesNotMatch(lines().join('\n'), /a private thought/, 'never the message');
  } finally {
    await cleanup(ah);
  }
});
