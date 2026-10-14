// Settings → Agents through the API: agents added by hand join the presets New
// session offers (detected by their command), hidden ones drop out of it, and
// asking for unknown agents or bad input is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAh, cleanup, http } from './helpers.ts';

test('agents can be added, hidden and removed, and New session follows', async () => {
  const ah = await startAh({ auth: { mode: 'off' } });
  try {
    const presets = async () => (await http(ah, 'GET', '/api/state')).json().presets as Array<{ id: string; command: string; available: boolean; hidden?: boolean }>;
    const list = async () => (await http(ah, 'GET', '/api/harnesses')).json();
    assert.ok((await list()).agents.some((a: any) => a.id === 'claude'));

    const added = await http(ah, 'POST', '/api/harnesses/custom', { body: { name: 'Stand-in', command: 'standin --quiet' } });
    assert.equal(added.status, 200);
    const mine = added.json().agents.find((a: any) => a.name === 'Stand-in');
    assert.equal(mine.id, 'custom-stand-in');
    assert.equal(mine.custom, true);
    assert.ok((await presets()).some((p) => p.id === 'custom-stand-in' && p.command === 'standin --quiet'));

    assert.equal((await http(ah, 'POST', '/api/harnesses/claude', { body: { hidden: true } })).status, 200);
    assert.equal((await presets()).find((p) => p.id === 'claude')!.hidden, true);
    assert.equal((await http(ah, 'POST', '/api/harnesses/claude', { body: { hidden: false } })).status, 200);
    assert.equal((await presets()).find((p) => p.id === 'claude')!.hidden, undefined);

    assert.equal((await http(ah, 'POST', '/api/harnesses/custom', { body: { name: 'Bad', command: 'one\ntwo' } })).status, 400);
    assert.equal((await http(ah, 'POST', '/api/harnesses/nope', { body: { hidden: true } })).status, 404);
    assert.equal((await http(ah, 'POST', '/api/harnesses/claude', { body: { hidden: 'yes' } })).status, 400);

    assert.equal((await http(ah, 'DELETE', '/api/harnesses/custom/custom-stand-in')).status, 200);
    assert.ok(!(await presets()).some((p) => p.id === 'custom-stand-in'));
    assert.equal((await http(ah, 'DELETE', '/api/harnesses/custom/custom-stand-in')).status, 404);
  } finally {
    await cleanup(ah);
  }
});
