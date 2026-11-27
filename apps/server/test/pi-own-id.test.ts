// pi without ah's bridge has no hooks to say which conversation is its window's: two new pi
// windows in one folder were told apart by which transcript appeared first, and the first,
// still unused, took the second's conversation (Codex's review). ah now names the
// conversation at launch (pi --session-id), and each window owns its own from the start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const fakePi = fileURLToPath(new URL('./fixtures/fake-pi.js', import.meta.url));

test('two new pi windows in one folder: the conversation is the one prompted, not the one opened first', { timeout: 90_000 }, async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'pi', name: 'pi', command: `exec ${process.execPath} ${fakePi}`, match: '^node$', feed: 'pi', resumeId: `exec ${process.execPath} ${fakePi} --session {id}`, newId: ['--session-id', '{id}'] }],
  });
  try {
    const open = async () => {
      const r = await http(ah, 'POST', '/api/windows', { body: { preset: 'pi', cwd: `${ah.dir}/files` } });
      assert.equal(r.status, 201, r.body);
      return r.json() as { id: string; uid: string };
    };
    const a = await open();
    const b = await open();
    const view = async (uid: string) => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    const said = (w: { id: string }) => ah.tmux('capture-pane', '-p', '-J', '-t', w.id).match(/READY pi (\S+)/)?.[1];
    await until(async () => !!said(a) && !!said(b) && (await view(b.uid))?.agent === 'pi', 20_000, 'both up');
    const [aId, bId] = [said(a)!, said(b)!];
    assert.notEqual(aId, bId);
    // Only the second is used.
    // Delivered, or held a moment while the agent is still starting (a loaded machine): either way it arrives.
    assert.match((await http(ah, 'POST', `/api/sessions/${b.uid}/send`, { body: { text: 'hello from b' } })).json().outcome, /^(delivered|queued)$/);
    await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', b.id).includes('RECEIVED:hello from b'), 20_000, 'b prompted');
    // A few passes of adoption later, each window holds its own id: A never took B's.
    await until(async () => (await view(b.uid))?.harnessId === bId, 15_000, "b's conversation is b's");
    for (let i = 0; i < 3; i++) await http(ah, 'GET', '/api/state');
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await view(a.uid))?.harnessId, aId, "a keeps its own, unused, conversation");
    assert.equal((await view(b.uid))?.harnessId, bId);
  } finally {
    await cleanup(ah);
  }
});

// Codex's review of the fixes: "continue latest" (`pi --continue`) was given a new id too, and
// pi refuses the two together: it never started.
test('"continue latest" on pi names no new conversation', { timeout: 60_000 }, async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'pi', name: 'pi', command: `exec ${process.execPath} ${fakePi}`, resume: `exec ${process.execPath} ${fakePi} --continue`, match: '^node$', feed: 'pi', newId: ['--session-id', '{id}'] }],
  });
  try {
    const r = await http(ah, 'POST', '/api/windows', { body: { preset: 'pi', cwd: `${ah.dir}/files`, resume: true } });
    assert.equal(r.status, 201, r.body);
    const { id } = r.json();
    await until(() => /READY pi|cannot be combined/.test(ah.tmux('capture-pane', '-p', '-J', '-t', id)), 15_000, 'started or refused');
    const screen = ah.tmux('capture-pane', '-p', '-J', '-t', id);
    assert.doesNotMatch(screen, /cannot be combined/);
    assert.match(screen, /READY pi/);
  } finally {
    await cleanup(ah);
  }
});
