// A message to an agent session whose agent is gone (it crashed, was quit, or its command
// failed) with its shell left behind: never typed into that shell, where it would run as a
// command. It waits in the queue for an agent in the window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, transcriptOf, windows } from './fake-agents.ts';

test("a message to a session whose agent has exited waits for an agent, and isn't typed into its shell", async () => {
  const ah = await startBed();
  try {
    const s = await launch(ah, 'codex', ah.project);
    await say(ah, s.uid, 'hello');
    // The agent dies; its window, a bare shell now, stays (recovery is off by default).
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'CRASH' } });
    const gone = await until(async () => {
      const w = (await windows(ah)).find((w) => w.uid === s.uid);
      return w && !w.agent && w.status !== 'busy' && w;
    }, 15000, 'the agent gone, the window still there');
    assert.equal(gone.id, s.id, 'the same window');

    const sent = await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'rm -rf would have run here' } });
    assert.equal(sent.status, 200, sent.body);
    assert.equal(sent.json().outcome, 'queued', sent.body);
    // Past the queue's start-up grace and a few passes: still queued, nothing in the shell.
    await new Promise((r) => setTimeout(r, 8000));
    const screen = ah.tmux('capture-pane', '-p', '-J', '-t', s.id);
    assert.doesNotMatch(screen, /rm -rf would have run here|command not found/, screen);
    const queue = (await http(ah, 'GET', `/api/sessions/${s.uid}/queue`)).json();
    assert.equal(queue.length, 1);
    // Send Now doesn't type it there either: it stays first in the queue.
    const now = await http(ah, 'POST', `/api/sessions/${s.uid}/queue/${queue[0].id}/send-now`);
    assert.equal(now.status, 409, now.body);
    assert.equal(now.json().code, 'agent_gone');
    assert.doesNotMatch(ah.tmux('capture-pane', '-p', '-J', '-t', s.id), /rm -rf would have run here|command not found/);
    assert.equal((await http(ah, 'GET', `/api/sessions/${s.uid}/queue`)).json().length, 1);

    // An agent back in the window (resumed by hand in the terminal) gets it.
    ah.tmux('send-keys', '-t', s.id, `${ah.bin}/codex resume ${s.harnessId}`, 'Enter');
    await until(async () => (await transcriptOf(ah, s.uid))?.includes('Got: rm -rf would have run here'), 20000, 'delivered to the agent');
    assert.equal((await http(ah, 'GET', `/api/sessions/${s.uid}/queue`)).json().length, 0);
  } finally {
    await cleanup(ah);
  }
});

// The 409 agent_gone says "Offer Resume": resume answered "already running" for a window whose
// agent had exited (the window was there), and nothing came back.
test('resume on a session whose agent has exited starts it again in its window, on its conversation, and what waited goes in', async () => {
  const ah = await startBed();
  try {
    const s = await launch(ah, 'codex', ah.project);
    await say(ah, s.uid, 'hello');
    await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'CRASH' } });
    await until(async () => (await windows(ah)).some((w) => w.uid === s.uid && !w.agent && w.status !== 'busy'), 15000, 'the agent gone');
    const sent = (await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'waited for it' } })).json();
    assert.equal(sent.outcome, 'queued');
    assert.equal(sent.resumed, false, "a send doesn't start it by itself");
    await new Promise((r) => setTimeout(r, 3000));
    assert.equal((await windows(ah)).find((w) => w.uid === s.uid)?.agent, null, 'still gone until Resume');
    const r = await http(ah, 'POST', `/api/sessions/${s.uid}/resume`);
    assert.equal(r.status, 201, r.body);
    assert.equal(r.json().resumed, true, r.body);
    assert.equal(r.json().id, s.id, 'in its own window');
    const back = await until(async () => (await windows(ah)).find((w) => w.uid === s.uid && w.agent === 'codex'), 20000, 'the agent back');
    assert.equal(back.harnessId, s.harnessId, 'on its conversation');
    await until(async () => (await transcriptOf(ah, s.uid))?.includes('Got: waited for it'), 20000, 'what waited went in');
    assert.equal((await http(ah, 'GET', `/api/sessions/${s.uid}/queue`)).json().length, 0);
    // A session whose agent runs: nothing to start.
    const again = await http(ah, 'POST', `/api/sessions/${s.uid}/resume`);
    assert.equal(again.json().resumed, false, again.body);
  } finally {
    await cleanup(ah);
  }
});

test('an agent added by hand that ah never sees running is typed into as before', async () => {
  // `env cat` stands in for an agent CLI ah can't see (no `match`, and the process isn't named
  // after its command): its window never shows an agent, and holding messages for one would
  // hold them forever.
  const ah = await startBed({ presets: [{ id: 'custom-cat', name: 'Cat', command: 'env cat' }] });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'custom-cat', cwd: ah.project } });
    assert.equal(created.status, 201, created.body);
    const { uid, id } = created.json();
    await until(async () => (await windows(ah)).some((w) => w.uid === uid && ['idle', 'attention'].includes(w.status)), 15000, 'up');
    await new Promise((r) => setTimeout(r, 5500));
    assert.equal((await windows(ah)).find((w) => w.uid === uid)?.agent, null, 'never seen');
    const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'hello cat' } });
    assert.equal(sent.json().outcome, 'delivered', sent.body);
    await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', id).includes('hello cat'), 10000, 'typed into it');
  } finally {
    await cleanup(ah);
  }
});

// Codex's and Neon's reviews of the stack: an agent added in Settings without a `match` is
// still seen running (by its command's name), and was typed into after it exited.
test('an agent added by hand that ah saw running, once it exits, gets nothing typed into its shell', async () => {
  const ah = await startBed({ presets: [{ id: 'custom-cat', name: 'Cat', command: 'cat' }] });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'custom-cat', cwd: ah.project } });
    const { uid, id } = created.json();
    await until(async () => (await windows(ah)).some((w) => w.uid === uid && w.agent === 'custom-cat'), 15000, 'seen running');
    // Past the first prompt's wait for an agent to start.
    await new Promise((r) => setTimeout(r, 5500));
    ah.tmux('send-keys', '-t', id, 'C-d');
    await until(async () => (await windows(ah)).some((w) => w.uid === uid && !w.agent), 15000, 'exited');
    const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'echo TYPED-INTO-THE-SHELL' } });
    assert.equal(sent.json().outcome, 'queued', sent.body);
    await new Promise((r) => setTimeout(r, 4000));
    assert.doesNotMatch(ah.tmux('capture-pane', '-p', '-J', '-t', id), /TYPED-INTO-THE-SHELL/);
    // And after ah restarts, which never saw it running this time (Codex's review of the fixes).
    const after = await ah.restart();
    const again = await http(after, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'echo AFTER-THE-RESTART' } });
    assert.equal(again.json().outcome, 'queued', again.body);
    await new Promise((r) => setTimeout(r, 4000));
    assert.doesNotMatch(after.tmux('capture-pane', '-p', '-J', '-t', id), /AFTER-THE-RESTART|TYPED-INTO-THE-SHELL/);
  } finally {
    await cleanup(ah);
  }
});

// Codex's review of the stack: Send Now checked the agent before stopping it, then typed. An
// agent whose interrupt quits it (`yes` here, stopped with Ctrl-C) left its shell, and the
// urgent message ran there as a command.
test("Send Now on an agent its Stop quits: nothing typed into the shell, the message stays queued", async () => {
  const ah = await startBed({ presets: [{ id: 'custom-yes', name: 'Yes', command: 'yes working', match: '^yes$', interruptKeys: ['C-c'] }] });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'custom-yes', cwd: ah.project } });
    const { uid, id } = created.json();
    await until(async () => (await windows(ah)).some((w) => w.uid === uid && w.agent === 'custom-yes' && w.status === 'busy'), 15000, 'working');
    const queued = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'echo TYPED-INTO-THE-SHELL' } });
    assert.equal(queued.json().outcome, 'queued', queued.body);
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${queued.json().queueId}/send-now`);
    assert.equal(now.status, 409, now.body);
    assert.equal(now.json().code, 'agent_gone');
    await new Promise((r) => setTimeout(r, 2000));
    assert.doesNotMatch(ah.tmux('capture-pane', '-p', '-J', '-t', id), /^TYPED-INTO-THE-SHELL$/m);
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 1, 'still queued');
  } finally {
    await cleanup(ah);
  }
});

// Neon's review: a plain shell where you ran an agent and quit it was held like the agent's
// session ever after (the agent's hooks had named the window theirs).
test('a shell that ran an agent is still a shell: typed into once the agent quits', async () => {
  const ah = await startBed();
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: ah.project } });
    assert.equal(created.status, 201, created.body);
    const { uid, id } = created.json();
    ah.tmux('send-keys', '-t', id, `${ah.bin}/codex`, 'Enter');
    await until(async () => (await windows(ah)).some((w) => w.uid === uid && w.agent === 'codex'), 15000, 'codex running in the shell');
    await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'CRASH' } });
    await until(async () => (await windows(ah)).some((w) => w.uid === uid && !w.agent && w.status !== 'busy'), 15000, 'codex gone');
    await new Promise((r) => setTimeout(r, 2000));
    const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'echo SHELL-STILL-WORKS' } });
    assert.equal(sent.json().outcome, 'delivered', sent.body);
    await until(() => /^SHELL-STILL-WORKS$/m.test(ah.tmux('capture-pane', '-p', '-J', '-t', id)), 10000, 'run in the shell');
  } finally {
    await cleanup(ah);
  }
});
