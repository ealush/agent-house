import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { livePath, pendingInput } from './tmux.ts';

const dialogs = fileURLToPath(new URL('./fixtures/question-dialog', import.meta.url));

const rule = '─'.repeat(60);
const claude = (box: string[], below = ['  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents']) =>
  [' ▐▛███▛█   Claude Code v2.1.288', '❯ Reply with just the word PONG', '● PONG', '', rule, ...box, rule, ...below].join('\n');

test("pendingInput reads what's typed but not sent in Claude Code's input box", () => {
  // The owner's report (2026-11-22): a message that's a numbered list, handed back to the box
  // by a Stop, was read as a picker; ah typed the steered message after it and both went in.
  assert.equal(pendingInput(claude(['❯ 1. Yes, rebuild it', '  2. I am considering another feature'])), '1. Yes, rebuild it 2. I am considering another feature');
  assert.equal(pendingInput(claude(['❯ 1. Think about the primes below 50.', '  2. Then reply with the count.'], ['  ⏵⏵ auto mode on (shift+tab to cycle)'])), '1. Think about the primes below 50. 2. Then reply with the count.');
  assert.equal(pendingInput(claude(['❯ '])), '');
  assert.equal(pendingInput(claude(['❯'])), '');
  assert.equal(pendingInput(claude(['❯ Try "edit core.ts to..."'])), '', 'the hint is not input');
  assert.equal(pendingInput(claude(['❯ fix the bug'])), 'fix the bug');
  assert.equal(pendingInput(claude(['❯ Reply with just the word PONG.[Pasted text #1 +89 lines]'])), 'Reply with just the word PONG.[Pasted text #1 +89 lines]');
  assert.equal(pendingInput(claude(['❯ first line', '  second line'])), 'first line second line');
  assert.equal(pendingInput(claude(['❯ fix it'], ['  /model   Set the AI model', '  /mcp     Manage MCP servers'])), 'fix it', 'an open menu below the box');
});

test('pendingInput is null without an input box: shells, dialogs, other TUIs', () => {
  assert.equal(pendingInput('ah main ❯ ls\nREADME.md\nah main ❯ '), null);
  assert.equal(pendingInput([rule, ' Bash command', '   rm -rf dist', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', rule].join('\n')), null);
  assert.equal(pendingInput([rule, '❯ 1. Red', '  2. Green', rule, '', 'Enter to select · ↑/↓ to navigate · Esc to cancel'].join('\n')), null, "a picker's cursor");
  for (const f of readdirSync(dialogs)) assert.equal(pendingInput(readFileSync(join(dialogs, f), 'utf8')), null, `Claude Code's question dialog (${f})`);
  assert.equal(pendingInput(['› Write tests for @filename', '', '  ⏎ send   ⌃J newline'].join('\n')), null);
  assert.equal(pendingInput(''), null);
});

test('a TMUX_TMPDIR that is gone is refused, never resolved to the default tmux server', async () => {
  const { tmux, cleanEnv } = await import('./tmux.ts');
  const before = process.env.TMUX_TMPDIR;
  process.env.TMUX_TMPDIR = '/nonexistent/ah-tmux-dir-gone';
  try {
    assert.throws(() => cleanEnv(), /TMUX_TMPDIR .* is gone/);
    // A read, so that even a broken guard couldn't hurt the server it would reach.
    await assert.rejects(tmux('list-sessions'), /TMUX_TMPDIR .* is gone/);
  } finally {
    if (before === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = before;
  }
});

test("a pane in a deleted folder is still in that folder, not in one called '… (deleted)'", () => {
  assert.equal(livePath('/home/u/code/ah-native (deleted)'), '/home/u/code/ah-native');
  assert.equal(livePath('/home/u/code/ah-native'), '/home/u/code/ah-native');
  assert.equal(livePath('/home/u/notes (deleted) draft'), '/home/u/notes (deleted) draft', 'only the suffix /proc adds');
});

test("a tmux server whose socket was deleted is asked to make it again, never started a second time", { timeout: 30_000 }, async () => {
  // A /tmp cleaner deleting the socket of a server that runs on: ah read it as gone and started
  // another, and the sessions still running in the first were brought back beside them.
  const { tmux, serverState, bringServerBack } = await import('./tmux.ts');
  const { mkdtempSync, rmSync, unlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const before = process.env.TMUX_TMPDIR;
  const dir = mkdtempSync(join(tmpdir(), 'ah-sock-'));
  process.env.TMUX_TMPDIR = dir;
  const pids = new Set<number>();
  try {
    await tmux('new-session', '-d', '-s', 'kept');
    assert.equal(await serverState(), 'up');
    const pid = Number((await tmux('display-message', '-p', '#{pid}')).trim());
    pids.add(pid);
    unlinkSync(join(dir, `tmux-${process.getuid!()}`, 'default'));
    // Known by the socket it holds, deleted or not: the same server, asked of another socket, isn't.
    const { serverIdentity } = await import('./tmux.ts');
    assert.equal(serverIdentity(pid), 'yes');
    assert.equal(serverIdentity(pid, ['/tmp/some-other/default']), 'no');
    assert.equal(serverIdentity(process.pid), 'no', 'not a tmux');
    assert.equal(serverIdentity(2 ** 22 + 12345), 'no', 'gone');
    assert.equal(await serverState(), 'down', 'no socket reads as no server');
    assert.equal(await bringServerBack(), 'reconnected');
    const now = Number((await tmux('display-message', '-p', '#{pid}')).trim());
    pids.add(now);
    assert.equal(now, pid, 'the same server, not a new one');
    assert.match(await tmux('list-sessions', '-F', '#{session_name}'), /^kept$/m, 'with its sessions');
  } finally {
    await tmux('kill-server').catch(() => {});
    for (const p of pids) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {}
    }
    if (before === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = before;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bringing a server back: what systemd and the cgroup say decides restart, reconnect or nothing', async () => {
  const { bringBackWith, stateOfError } = await import('./tmux.ts');
  const run = async (o: { states: Array<'up' | 'down' | 'unknown'>; last?: number; servers?: number[]; unknown?: number[]; unit?: string | null; procs?: string | null }) => {
    const did: string[] = [];
    const states = [...o.states];
    const out = await bringBackWith({
      state: async () => states.shift() ?? 'down',
      lastServer: () => o.last ?? 0,
      isServer: (pid) => ((o.servers ?? []).includes(pid) ? 'yes' : (o.unknown ?? []).includes(pid) ? 'unknown' : 'no'),
      wake: (pid) => void did.push(`wake ${pid}`),
      unit: async () => o.unit ?? null,
      procs: async () => (o.procs === undefined ? '' : o.procs),
      restartUnit: async (u) => void did.push(`restart ${u}`),
      ensure: async () => void did.push('ensure'),
      sleep: async () => {},
    });
    return { out, did };
  };
  // Up: only made to idle empty.
  assert.deepEqual(await run({ states: ['up'] }), { out: 'up', did: ['ensure'] });
  // Wedged or slow: never restarted, never started over.
  assert.deepEqual(await run({ states: ['unknown'], unit: 'ah-tmux.service', procs: '' }), { out: 'failed', did: [] });
  // Gone, its unit's cgroup empty: the unit starts it.
  assert.deepEqual(await run({ states: ['down', 'up'], unit: 'ah-tmux.service', procs: '' }), { out: 'unit', did: ['restart ah-tmux.service', 'ensure'] });
  // Gone, but its cgroup still runs a tmux server (the socket was deleted): woken, not restarted.
  assert.deepEqual(await run({ states: ['down', 'up'], unit: 'ah-tmux.service', procs: '41\n42', servers: [42] }), { out: 'reconnected', did: ['wake 42', 'ensure'] });
  // …and if it doesn't make its socket again, nothing else is started beside it.
  assert.deepEqual((await run({ states: ['down'], unit: 'ah-tmux.service', procs: '42', servers: [42] })).out, 'failed');
  assert.ok(!(await run({ states: ['down'], unit: 'ah-tmux.service', procs: '42', servers: [42] })).did.includes('ensure'));
  // Gone, the cgroup still holds something else (an agent's leftover): not restarted (that would
  // stop it), started by ah.
  assert.deepEqual(await run({ states: ['down', 'up'], unit: 'ah-tmux.service', procs: '41' }), { out: 'started', did: ['ensure'] });
  // The cgroup can't be read (v1): not restarted either.
  assert.deepEqual(await run({ states: ['down', 'up'], unit: 'ah-tmux.service', procs: null }), { out: 'started', did: ['ensure'] });
  // No unit (a dev host): the server ah last saw, still running, is woken; none, one is started.
  assert.deepEqual(await run({ states: ['down', 'up'], last: 7, servers: [7] }), { out: 'reconnected', did: ['wake 7', 'ensure'] });
  assert.deepEqual(await run({ states: ['down', 'up'], last: 7 }), { out: 'started', did: ['ensure'] });
  // A tmux that may be it and can't be told (no /proc): neither signalled nor replaced.
  assert.deepEqual(await run({ states: ['down'], last: 7, unknown: [7] }), { out: 'failed', did: [] });
  // What tmux's errors say: only "nothing there" is down.
  assert.equal(stateOfError({ stderr: 'no server running on /tmp/tmux-1000/default' }), 'down');
  assert.equal(stateOfError({ stderr: 'error connecting to /tmp/tmux-1000/default (No such file or directory)' }), 'down');
  assert.equal(stateOfError({ stderr: 'error connecting to /tmp/tmux-1000/default (Connection refused)' }), 'down');
  assert.equal(stateOfError({ stderr: 'error connecting to /tmp/tmux-1000/default (Permission denied)' }), 'unknown');
  assert.equal(stateOfError({ stderr: 'no current target' }), 'unknown');
  assert.equal(stateOfError(new Error('timed out')), 'unknown');
});
