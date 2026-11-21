import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startAh, cleanup, http, until } from './helpers.ts';

// ah started without a UTF-8 locale (over ssh, or by launchd on a Mac: LANG unset).
// tmux then printed the field separator of every window line, and every non-ASCII
// letter, as "_": no window read, and /api/state answered 500.
test('windows read whole when ah runs without a UTF-8 locale', async () => {
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE };
  process.env.LANG = 'C';
  process.env.LC_ALL = 'C';
  delete process.env.LC_CTYPE;
  let ah;
  try {
    ah = await startAh({ auth: { mode: 'off' } });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'naïve ✓ café' } });
    assert.equal(created.status, 201, created.body);
    const w = await until(async () => {
      const state = await http(ah, 'GET', '/api/state');
      assert.equal(state.status, 200, state.body);
      return state.json().windows.find((x: any) => x.uid === created.json().uid);
    }, 10000, 'the window in the state');
    assert.equal(w.title, 'naïve ✓ café');
    assert.equal(w.id, created.json().id);
  } finally {
    await cleanup(ah);
  }
});
