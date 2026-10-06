import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));

test('per-turn snapshots: turns are captured, restore rolls files back and is itself undoable', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    // A git project for the agent to work in.
    const proj = join(ah.dir, 'files', 'proj');
    mkdirSync(proj, { recursive: true });
    const g = (...a: string[]) => execFileSync('git', ['-C', proj, ...a], { stdio: 'pipe' });
    execFileSync('git', ['init', '-q', '-b', 'main', proj]);
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    writeFileSync(join(proj, 'a.txt'), 'v1\n');
    g('add', '.');
    g('commit', '-qm', 'init');

    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: proj } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => {
      const w = await window();
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'agent detected');

    const snaps = async () => (await http(ah, 'GET', `/api/sessions/${uid}/snapshots`)).json();
    const send = async (text: string) => {
      const r = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text } });
      assert.equal(r.status, 200, r.body);
      await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes(`FINISHED:${text}`), 10000, `turn ${text} finished`);
    };

    // Turn 1 runs against v1. Between turns the "agent work" lands on disk.
    await send('first');
    writeFileSync(join(proj, 'a.txt'), 'v2\n');
    writeFileSync(join(proj, 'b.txt'), 'bee\n');
    await send('second');

    const list = await snaps();
    assert.equal(list.available, true);
    assert.equal(list.enabled, true);
    assert.deepEqual(list.snapshots.map((s: any) => s.turn), [2, 1]);
    assert.deepEqual(list.snapshots.map((s: any) => s.promptExcerpt), ['second', 'first']);
    assert.equal(list.snapshots[0].filesChanged, 2, 'turn 2 snapshot sees turn 1 edits vs turn 1 snapshot');

    // Damage after turn 2: rewrite, delete, create.
    writeFileSync(join(proj, 'a.txt'), 'v3\n');
    rmSync(join(proj, 'b.txt'));
    writeFileSync(join(proj, 'c.txt'), 'cee\n');

    const restored = await http(ah, 'POST', `/api/sessions/${uid}/snapshots/2/restore`, { body: {} });
    assert.equal(restored.status, 200, restored.body);
    assert.equal(restored.json().safety.kind, 'safety');
    assert.equal(readFileSync(join(proj, 'a.txt'), 'utf8'), 'v2\n');
    assert.equal(readFileSync(join(proj, 'b.txt'), 'utf8'), 'bee\n');
    assert.equal(existsSync(join(proj, 'c.txt')), false, 'files created after the snapshot are removed');

    // Restoring the safety snapshot undoes the restore.
    const safetyTurn = restored.json().safety.turn;
    const undone = await http(ah, 'POST', `/api/sessions/${uid}/snapshots/${safetyTurn}/restore`, { body: {} });
    assert.equal(undone.status, 200, undone.body);
    assert.equal(readFileSync(join(proj, 'a.txt'), 'utf8'), 'v3\n');
    assert.equal(existsSync(join(proj, 'b.txt')), false);
    assert.equal(readFileSync(join(proj, 'c.txt'), 'utf8'), 'cee\n');

    // Unknown turns and sessions fail cleanly.
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/snapshots/99/restore`, { body: {} })).status, 404);
    assert.equal((await http(ah, 'GET', '/api/sessions/nope99/snapshots')).status, 404);

    // The toggle stops new captures (the restore notices above are turns too,
    // so compare counts rather than absolutes).
    const before = (await snaps()).snapshots.length;
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/snapshots/toggle`, { body: { enabled: false } })).status, 200);
    assert.equal((await snaps()).enabled, false);
    await send('third');
    assert.equal((await snaps()).snapshots.length, before, 'no new snapshot while disabled');
    const whileDisabled = await http(ah, 'POST', `/api/sessions/${uid}/snapshots/2/restore`, { body: {} });
    assert.equal(whileDisabled.status, 200, whileDisabled.body);
    assert.equal(whileDisabled.json().safety.kind, 'safety', 'disabled automatic capture still protects restores');
    await http(ah, 'POST', `/api/sessions/${uid}/snapshots/toggle`, { body: { enabled: true } });
  } finally {
    await cleanup(ah);
  }
});
