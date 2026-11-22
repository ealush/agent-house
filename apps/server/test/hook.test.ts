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
    assert.match(opt('@ah-detail'), /rm -rf build/, 'a finished turn still says what it did last');
    hook({ hook_event_name: 'UserPromptSubmit' });
    assert.equal(opt('@ah-detail'), '', "a new turn isn't described by the last one's command");
    hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__github__create_issue', tool_input: {} });
    assert.match(opt('@ah-detail'), /github: create issue/, 'tool names read as words');
    hook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which layout?', options: [{ label: 'Stacked' }] }] } });
    assert.equal(opt('@ah-state'), 'waiting');
    assert.match(opt('@ah-detail'), /Asking: Which layout\?/);
    hook({ hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion' });
    assert.equal(opt('@ah-state'), 'working');
    assert.equal(opt('@ah-detail'), '', 'an answered question no longer reads "Asking" while it works on');
  } finally {
    try {
      tmux('kill-server');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Claude hook keeps a question option\'s preview for the form', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-hook-'));
  const sock = join(dir, 's');
  const env = { ...process.env };
  delete env.TMUX;
  const tmux = (...args: string[]) => execFileSync('tmux', ['-S', sock, ...args], { env, encoding: 'utf8' });
  try {
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'hooktest');
    const pane = tmux('display-message', '-p', '-t', 'hooktest', '#{pane_id}').trim();
    const pid = tmux('display-message', '-p', '#{pid}').trim();
    const input = { questions: [{ question: 'Which layout?', header: 'Layout', multiSelect: false, options: [{ label: 'Stacked', description: 'One above the other', preview: '+----+\n| A  |\n+----+' }, { label: 'Inline' }] }] };
    const r = spawnSync(process.execPath, [HOOK, 'claude'], { input: JSON.stringify({ session_id: 'c1', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: input }), env: { ...env, TMUX: `${sock},${pid},0`, TMUX_PANE: pane }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const ask = JSON.parse(tmux('show-options', '-w', '-v', '-q', '-t', pane, '@ah-ask').trim());
    assert.equal(ask.kind, 'choice');
    assert.equal(ask.questions[0].options[0].preview, '+----+\n| A  |\n+----+');
    assert.equal(ask.questions[0].options[1].preview, undefined);
  } finally {
    try {
      tmux('kill-server');
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
