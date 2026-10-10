import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../bin/ah-hook.js', import.meta.url));

// A private tmux server on its own socket (TMUX unset), never the developer's.
test('the Claude hook records each step of a turn, and clears the ask when it ends', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-hook-'));
  const sock = join(dir, 's');
  const env = { ...process.env };
  delete env.TMUX;
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', sock, ...args], { env, encoding: 'utf8' });
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'hooktest');
    const pane = tmux('display-message', '-p', '-t', 'hooktest', '#{pane_id}').trim();
    const pid = tmux('display-message', '-p', '#{pid}').trim();
    const hook = (payload: object) => {
      const r = spawnSync(process.execPath, [HOOK, 'claude'], { input: JSON.stringify({ session_id: 'c1', ...payload }), env: { ...env, TMUX: `${sock},${pid},0`, TMUX_PANE: pane }, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    };
    const opt = (name: string) => tmux('show-options', '-w', '-v', '-q', '-t', pane, name).trim();

    hook({ hook_event_name: 'UserPromptSubmit' });
    assert.equal(opt('@ah-state'), 'working');
    hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    hook({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
    assert.equal(opt('@ah-state'), 'waiting');
    assert.match(opt('@ah-ask'), /rm -rf build/);
    hook({ hook_event_name: 'PostToolUse', tool_name: 'Bash' });
    assert.equal(opt('@ah-state'), 'working', 'answering moves on');
    assert.equal(opt('@ah-ask'), '', 'and clears the ask');
    hook({ hook_event_name: 'Stop' });
    assert.equal(opt('@ah-state'), 'done');
    assert.equal(opt('@ah-harness-id'), 'c1');
  } finally {
    try {
      tmux('kill-server');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
