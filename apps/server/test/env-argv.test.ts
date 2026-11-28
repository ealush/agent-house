// Settings → Environment's values (API keys) and each session's token went to tmux as
// `-e KEY=value` on its command line: every user of the machine could read them in `ps`, and a
// tmux server started by such a command kept it as its own for its whole life (found on the
// host running ah: its server's command line held two API keys and a session token).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, until } from './helpers.ts';

const SECRET = 'sk-test-0123456789-NEVER-ON-A-COMMAND-LINE';

test('environment values never on a tmux command line, nor on the server it starts', async () => {
  // A tmux that writes down every command line it's run with, then runs the real one.
  const bin = mkdtempSync(join(tmpdir(), 'ah-tmuxlog-'));
  const log = join(bin, 'argv.log');
  const real = execFileSync('sh', ['-c', 'command -v tmux'], { encoding: 'utf8' }).trim();
  writeFileSync(join(bin, 'tmux'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'tmux'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  // No server of the bed's own: the first window ah makes starts it.
  const ah = await startAh({ auth: { mode: 'off' } }, undefined, { tmux: false });
  process.env.PATH = path;
  try {
    assert.equal((await http(ah, 'POST', '/api/env', { body: { name: 'IMAGE_API_KEY', value: SECRET, secret: true } })).status, 200);
    const made = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files`, session: 'fresh' } });
    assert.equal(made.status, 201, made.body);
    const { id } = made.json();
    // The window has it.
    ah.tmux('send-keys', '-t', id, 'echo "got:$IMAGE_API_KEY"', 'Enter');
    await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', id).includes(`got:${SECRET}`), 10000, 'the value in the window');
    // ...and a second window in that session.
    const second = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: `${ah.dir}/files`, session: 'fresh' } });
    assert.equal(second.status, 201, second.body);
    // No tmux command line carried it, nor carries the server's.
    assert.doesNotMatch(readFileSync(log, 'utf8'), new RegExp(SECRET));
    const pid = ah.tmux('display-message', '-p', '#{pid}').trim();
    assert.doesNotMatch(readFileSync(`/proc/${pid}/cmdline`, 'utf8'), new RegExp(SECRET));
    // Nor did the session's own token.
    const token = readFileSync(log, 'utf8').match(/AH_SESSION_TOKEN=\S+/);
    assert.equal(token, null, String(token));
  } finally {
    await cleanup(ah);
  }
});
