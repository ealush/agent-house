// pi with ah's bridge asks before commands and edits only through the bridge. Without a
// private folder for its socket it used to start anyway, the extension loaded with nowhere to
// listen, and pi ran every command it wanted without asking (Codex's review of the stack).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http } from './helpers.ts';

test("a bridged pi with no private folder for its socket isn't started", async () => {
  const runtime = mkdtempSync(join(tmpdir(), 'ah-run-'));
  const saved = process.env.XDG_RUNTIME_DIR;
  process.env.XDG_RUNTIME_DIR = runtime;
  chmodSync(runtime, 0o755);
  const ah = await startAh({ auth: { mode: 'off' }, experimental: { piBridge: true } });
  try {
    const refused = await http(ah, 'POST', '/api/windows', { body: { preset: 'pi', cwd: `${ah.dir}/files` } });
    assert.equal(refused.status, 503, refused.body);
    assert.equal(refused.json().code, 'bridge_unavailable');
    assert.equal((await http(ah, 'GET', '/api/state')).json().windows.filter((w: any) => w.name === 'pi').length, 0, 'no window left behind');
    // Made private, it starts.
    chmodSync(runtime, 0o700);
    const started = await http(ah, 'POST', '/api/windows', { body: { preset: 'pi', cwd: `${ah.dir}/files` } });
    assert.equal(started.status, 201, started.body);
  } finally {
    await cleanup(ah);
    if (saved === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = saved;
  }
});
