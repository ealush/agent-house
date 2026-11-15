import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Win } from '../web/api.ts';
import { idleShell, runInShell, runPlace, runsLanguage, shellCommand } from '../web/runInShell.ts';

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

test('the shell is one at its prompt in the session’s folder on its host, the one used last', () => {
  const agent = win('agent', { agent: 'claude', command: 'claude' });
  const rows = [
    agent,
    win('s1', { activity: 10 }),
    win('s2', { command: '-zsh', activity: 20 }),
    win('s3', { command: 'node', activity: 30 }),
    win('s4', { cwd: '/p/other', activity: 40 }),
    win('s5', { host: 'laptop', key: 'laptop/s5', activity: 50 }),
    win('a2', { agent: 'codex', command: 'codex', activity: 60 }),
  ];
  assert.equal(idleShell(agent, rows)?.uid, 's2');
  assert.equal(idleShell(agent, rows.filter((r) => !['s1', 's2'].includes(r.uid))), undefined);
});

test('the place reads project and branch', () => {
  assert.equal(runPlace(win('a')), 'ah · main');
  assert.equal(runPlace(win('a', { branch: null })), 'ah');
  assert.equal(runPlace(win('a', { project: '', branch: null })), 'its folder');
});

function host() {
  const calls: string[] = [];
  return {
    calls,
    create: async (body: { preset: string; cwd: string; session: string }) => {
      calls.push(`create ${body.preset} ${body.cwd} ${body.session}`);
      return { id: '@9', uid: 'new1' };
    },
    send: async (uid: string, text: string, enter: boolean) => {
      calls.push(`send ${uid} ${JSON.stringify(text)} ${enter}`);
      return { outcome: 'delivered', windowId: '@9', resumed: false, queued: 0 } as never;
    },
  };
}

test('it types into the waiting shell with Enter, and says which to show', async () => {
  const h = host();
  const agent = win('agent', { agent: 'claude', command: 'claude' });
  const key = await runInShell(h as never, agent, [agent, win('s1')], '! npm test');
  assert.equal(key, 's1');
  assert.deepEqual(h.calls, ['send s1 "npm test" true']);
});

test('with none waiting it starts a shell in the session’s folder; a peer’s keeps its host', async () => {
  const h = host();
  const agent = win('agent', { agent: 'claude', command: 'claude', host: 'laptop', key: 'laptop/agent', cwd: '/w/tree' });
  const key = await runInShell(h as never, agent, [agent, win('busy', { host: 'laptop', command: 'vim', cwd: '/w/tree' })], 'ls');
  assert.equal(key, 'laptop/new1');
  assert.deepEqual(h.calls, ['create shell /w/tree main', 'send new1 "ls" true']);
});

test('nothing to type runs nothing', async () => {
  const h = host();
  assert.equal(await runInShell(h as never, win('agent', { agent: 'claude' }), [], '  \n'), null);
  assert.deepEqual(h.calls, []);
});
