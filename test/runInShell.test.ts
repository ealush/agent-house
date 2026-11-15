import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Win } from '../web/api.ts';
import { runInShell, runPlace, runsLanguage, shellCommand } from '../web/runInShell.ts';

const win = (uid: string, o: Partial<Win> = {}): Win => ({ uid, key: uid, host: 'desk', agent: null, command: 'zsh', cwd: '/p/ah', projectPath: '/p/ah', project: 'ah', branch: 'main', session: 'main', activity: 0, ...o }) as Win;

test('code in no language or a shell’s runs, other code does not', () => {
  for (const l of [undefined, null, '', 'bash', 'Shell', 'console']) assert.equal(runsLanguage(l), true, String(l));
  for (const l of ['ts', 'swift', 'json']) assert.equal(runsLanguage(l), false, l);
});

test('a snippet loses the prompt marks but not its command', () => {
  assert.equal(shellCommand('  npm test\n'), 'npm test');
  // Claude Code's `!`: in a shell it negates, and `&&` would skip what follows.
  assert.equal(shellCommand('! cd ~/code/ah && git pull'), 'cd ~/code/ah && git pull');
  assert.equal(shellCommand('$ cd ah\n$ pnpm build'), 'cd ah\npnpm build');
  // Output under a prompted line keeps the lot: which lines to run isn't for us to guess.
  assert.equal(shellCommand('$ ls\nREADME.md'), '$ ls\nREADME.md');
  assert.equal(shellCommand('git log | grep !fix'), 'git log | grep !fix');
  assert.equal(shellCommand('!!'), '!!');
  assert.equal(shellCommand(' \n '), '');
});

test('the place reads project and branch', () => {
  assert.equal(runPlace(win('a')), 'ah · main');
  assert.equal(runPlace(win('a', { branch: null })), 'ah');
  assert.equal(runPlace(win('a', { project: '', branch: null })), 'its folder');
});

function host() {
  const calls: Array<{ uid: string; command?: string }> = [];
  return {
    calls,
    openTerminal: async (uid: string, command?: string) => {
      calls.push({ uid, command });
      return { terminal: { id: '@9', cwd: '/p/ah', command: 'zsh', busy: false } };
    },
  };
}

test('a snippet targets its owning session’s attachment, with prompts removed', async () => {
  const h = host();
  const terminal = await runInShell(h, win('agent', { agent: 'claude' }), '! npm test');
  assert.equal(terminal?.id, '@9');
  assert.deepEqual(h.calls, [{ uid: 'agent', command: 'npm test' }]);
});

test('peer routing stays with the supplied host client and uses the owner uid', async () => {
  const h = host();
  await runInShell(h, win('agent', { host: 'laptop', key: 'laptop/agent' }), 'ls');
  assert.deepEqual(h.calls, [{ uid: 'agent', command: 'ls' }]);
});

test('nothing to type runs nothing', async () => {
  const h = host();
  assert.equal(await runInShell(h, win('agent'), '  \n'), null);
  assert.deepEqual(h.calls, []);
});

test('busy-terminal failures reach the caller without creating an unrelated shell', async () => {
  const client = { openTerminal: async () => { throw new Error('terminal busy'); } };
  await assert.rejects(runInShell(client, win('agent'), 'ls'), /terminal busy/);
});
