import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until } from './helpers.ts';

const SECRET = 'sk-env-test-6f2c';

test('session environment: new windows start with it, secrets stay out of responses and logs, older sessions are named', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'shell', name: 'Shell', command: '' }, { id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    // An agent started before the variable exists.
    const before = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(before.status, 201, before.body);
    await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.some((w: any) => w.uid === before.json().uid && w.agent === 'test-agent'), 15000);
    assert.deepEqual((await http(ah, 'GET', '/api/env')).json().stale, [], 'nothing to be stale against yet');

    assert.equal((await http(ah, 'POST', '/api/env', { body: { name: 'PATH', value: '/x', secret: false } })).status, 400);
    assert.equal((await http(ah, 'POST', '/api/env', { body: { name: 'IMAGE_API_KEY', value: SECRET } })).status, 400, 'secret flag is required');
    const saved = await http(ah, 'POST', '/api/env', { body: { name: 'IMAGE_API_KEY', value: SECRET, secret: true } });
    assert.equal(saved.status, 200, saved.body);
    assert.ok(!saved.body.includes(SECRET));
    await http(ah, 'POST', '/api/env', { body: { name: 'IMAGE_MODEL', value: "it's \"quoted\" $HOME", secret: false } });

    const listed = await http(ah, 'GET', '/api/env');
    assert.ok(!listed.body.includes(SECRET));
    assert.deepEqual(listed.json().vars, [
      { name: 'IMAGE_API_KEY', value: null, secret: true, hint: 'sk-e…c' },
      { name: 'IMAGE_MODEL', value: "it's \"quoted\" $HOME", secret: false, hint: null },
    ]);
    const stale = listed.json().stale;
    assert.deepEqual(stale.map((s: any) => [s.uid, s.restart]), [[before.json().uid, 'no conversation to resume yet']]);

    // A shell started now sees both, verbatim.
    const shell = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files` } });
    assert.equal(shell.status, 201, shell.body);
    const id = shell.json().id;
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).trim().length > 0, 8000, 'shell prompt');
    ah.tmux('send-keys', '-t', id, '-l', 'printf "<%s|%s>\\n" "$IMAGE_API_KEY" "$IMAGE_MODEL"');
    ah.tmux('send-keys', '-t', id, 'Enter');
    await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', id).includes(`<${SECRET}|it's "quoted" $HOME>`), 8000, 'variables in the shell');

    // Removing one: the next window goes without it, even in the same tmux session.
    assert.equal((await http(ah, 'DELETE', '/api/env/IMAGE_API_KEY')).status, 200);
    assert.equal((await http(ah, 'DELETE', '/api/env/IMAGE_API_KEY')).status, 404);
    const next = (await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files` } })).json().id;
    await until(() => ah.tmux('capture-pane', '-p', '-t', next).trim().length > 0, 8000, 'second shell prompt');
    ah.tmux('send-keys', '-t', next, '-l', 'printf "<%s|%s>\\n" "${IMAGE_API_KEY-unset}" "$IMAGE_MODEL"');
    ah.tmux('send-keys', '-t', next, 'Enter');
    await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', next).includes(`<unset|it's "quoted" $HOME>`), 8000, 'removed variable gone');

    // The activity log names variables, never their values.
    const state = join(ah.dir, 'state', 'ah');
    for (const f of readdirSync(state)) {
      if (f.startsWith('ah.db')) continue;
      assert.ok(!readFileSync(join(state, f), 'utf8').includes(SECRET), `${f} holds the secret`);
    }
  } finally {
    await cleanup(ah);
  }
});
