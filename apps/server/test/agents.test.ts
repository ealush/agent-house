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

test("pi's bridge switches from Settings, over config.json, for new sessions, and stays switched", async () => {
  const ah = await startAh({ auth: { mode: 'off' } });
  try {
    const pi = async () => (await http(ah, 'GET', '/api/state')).json().presets.find((p: any) => p.id === 'pi') as { command: string; modes?: Array<{ id: string }> };
    const listed = async () => (await http(ah, 'GET', '/api/harnesses')).json().agents.find((a: any) => a.id === 'pi');
    assert.equal((await listed()).bridge, false, 'off unless switched');
    assert.equal((await listed()).bridge !== undefined, true);
    assert.equal((await http(ah, 'GET', '/api/harnesses')).json().agents.find((a: any) => a.id === 'claude').bridge, undefined, 'pi alone has one');
    assert.equal((await pi()).command, 'pi');

    const on = await http(ah, 'POST', '/api/harnesses/pi', { body: { bridge: true } });
    assert.equal(on.status, 200, on.body);
    assert.equal(on.json().agents.find((a: any) => a.id === 'pi').bridge, true);
    // Settings shows its command as you'd type it, not with the extension it loads.
    assert.equal(on.json().agents.find((a: any) => a.id === 'pi').command, 'pi');
    assert.match((await pi()).command, /^pi -e \S+\/bin\/pi-extension\.ts$/);
    assert.deepEqual((await pi()).modes?.map((m) => m.id), ['default', 'yolo']);

    assert.equal((await http(ah, 'POST', '/api/harnesses/claude', { body: { bridge: true } })).status, 400);
    assert.equal((await http(ah, 'POST', '/api/harnesses/pi', { body: { bridge: 'yes' } })).status, 400);
    assert.equal((await http(ah, 'POST', '/api/harnesses/pi', { body: {} })).status, 400);

    // Kept across a restart, over what config.json says.
    const again = await ah.restart();
    assert.equal((await http(again, 'GET', '/api/harnesses')).json().agents.find((a: any) => a.id === 'pi').bridge, true);
    assert.equal((await http(again, 'POST', '/api/harnesses/pi', { body: { bridge: false } })).status, 200);
    assert.equal((await http(again, 'GET', '/api/state')).json().presets.find((p: any) => p.id === 'pi').command, 'pi');
  } finally {
    await cleanup(ah);
  }
});
