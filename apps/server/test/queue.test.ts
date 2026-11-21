import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, until, sleep } from './helpers.ts';

const fixture = fileURLToPath(new URL('./fixtures/agent.js', import.meta.url));

test('an exec-replaced agent is detected and concurrent follow-ups queue separately', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    // "Idle" means quiet for idleAfter seconds; keep it short so slow CI machines fit the budget.
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => {
      const w = await window();
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'root agent detected');
    const sent = await Promise.all(['alpha', 'beta', 'gamma'].map((text) => http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text } })));
    for (const r of sent) assert.equal(r.status, 200, r.body);
    assert.equal(sent.filter((r) => r.json().outcome === 'delivered').length, 1);
    const queued = (await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json();
    assert.equal(queued.length, 2);
    assert.equal(new Set(queued.map((q: any) => q.text)).size, 2);
    // Individual cancellation must leave the other follow-up queued.
    assert.equal((await http(ah, 'DELETE', `/api/sessions/${uid}/queue/${queued[1].id}`)).status, 200);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes(`FINISHED:${queued[0].text}`), 10000, 'remaining follow-up delivered');
    const screen = ah.tmux('capture-pane', '-p', '-t', id);
    assert.ok(!screen.includes(`RECEIVED:${queued[1].text}`), 'cancelled message never sent');
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0);
  } finally {
    await cleanup(ah);
  }
});

test('replies to a waiting session deliver immediately instead of queueing', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => {
      const w = await window();
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'root agent detected');
    // A first follow-up, so the reply below also falls inside the submit grace period.
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'first' } })).json().outcome, 'delivered');
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('FINISHED:first'), 10000, 'first turn finished');
    // The agent asks a question: hook state waiting with the question payload.
    // Nothing clears it afterwards (the fixture's turn timer already fired), so
    // the waiting status below is stable, not a timing accident.
    const at = String(Math.floor(Date.now() / 1000));
    ah.tmux(
      'set-option', '-w', '-t', id, '@ah-state', 'waiting',
      ';', 'set-option', '-w', '-t', id, '@ah-state-at', at,
      ';', 'set-option', '-w', '-t', id, '@ah-ask', JSON.stringify({ kind: 'question', text: 'Which fix?' }),
    );
    await until(async () => {
      const w = await window();
      return w?.status === 'waiting' && w?.ask?.kind === 'question' && w?.ask?.text === 'Which fix?';
    }, 10000, 'question surfaces as waiting with its text');
    // A waiting agent is blocked on your input: the reply is the answer, so it
    // must be typed now rather than queued behind the turn that asked.
    const reply = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'the first one' } });
    assert.equal(reply.status, 200, reply.body);
    assert.equal(reply.json().outcome, 'delivered', 'reply to a waiting session is delivered, not queued');
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:the first one'), 10000, 'reply typed into the waiting agent');
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0);
  } finally {
    await cleanup(ah);
  }
});

test('send-now interrupts the live turn and delivers one queued message', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    await until(async () => {
      const w = (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'root agent detected');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'routine' } })).json().outcome, 'delivered');
    const queuedSend = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'urgent' } });
    assert.equal(queuedSend.json().outcome, 'queued', 'urgent would otherwise wait');
    const queued = (await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json();
    assert.equal(queued.length, 1);
    // Unknown ids and unknown sessions fail instead of typing anywhere.
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/queue/nope/send-now`, {})).status, 404);
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${queued[0].id}/send-now`, {});
    assert.equal(now.status, 200, now.body);
    assert.equal(now.json().outcome, 'delivered');
    assert.equal(now.json().queued, 0);
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:urgent'), 10000, 'urgent delivered immediately');
    assert.ok(ah.tmux('capture-pane', '-p', '-t', id).includes('INTERRUPTED'), 'live turn was interrupted');
  } finally {
    await cleanup(ah);
  }
});

test('send-now steers a hooked agent whose interrupt sends no Stop hook (Claude Code)', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture} --claude-interrupt --turn=60000`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => {
      const w = await window();
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'root agent detected');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'routine' } })).json().outcome, 'delivered');
    // Well past the submit grace: busy only because the hook still says "working".
    await sleep(3000);
    assert.equal((await window()).status, 'busy');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'urgent' } })).json().outcome, 'queued');
    const queued = (await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json();
    const started = Date.now();
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${queued[0].id}/send-now`, {});
    assert.equal(now.status, 200, now.body);
    assert.equal(now.json().outcome, 'delivered');
    assert.ok(Date.now() - started < 3000, `steering took ${Date.now() - started}ms`);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:urgent'), 10000, 'urgent delivered');
    assert.ok(ah.tmux('capture-pane', '-p', '-t', id).includes('INTERRUPTED'), 'live turn was interrupted');
  } finally {
    await cleanup(ah);
  }
});

test('Stop clears "working" on a hooked agent whose interrupt sends no Stop hook', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture} --claude-interrupt --turn=60000`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { uid } = created.json();
    const window = async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === uid);
    await until(async () => {
      const w = await window();
      return w?.agent === 'test-agent' && ['idle', 'attention'].includes(w.status);
    }, 15000, 'root agent detected');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'routine' } })).json().outcome, 'delivered');
    await sleep(3000);
    assert.equal((await window()).status, 'busy');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/interrupt`, {})).status, 200);
    await until(async () => ['idle', 'attention'].includes((await window()).status), 5000, 'not working after Stop');
  } finally {
    await cleanup(ah);
  }
});

test("a new session's first prompt waits for the agent to start, then goes in", async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${fixture}`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    // Sent the moment the window exists, as the new-session dialog does: the agent
    // isn't running yet, and typing now would leave the prompt unsubmitted.
    const first = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'kickoff' } });
    assert.equal(first.status, 200, first.body);
    assert.equal(first.json().outcome, 'queued');
    assert.equal(first.json().starting, true);
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('FINISHED:kickoff'), 15000, 'first prompt submitted once the agent is up');
    assert.equal((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json().length, 0);
  } finally {
    await cleanup(ah);
  }
});

test('a prompt left in the input box by a lost Enter is submitted with another', async () => {
  const boxed = fileURLToPath(new URL('./fixtures/boxed-agent.js', import.meta.url));
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${boxed}`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    // Past the launch hold, so it is typed in now rather than queued.
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('Try "something"'), 10000, 'the agent draws its input box');
    await sleep(5500);
    const sent = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'first line\nsecond line' } });
    assert.equal(sent.status, 200, sent.body);
    assert.equal(sent.json().outcome, 'delivered');
    // The fixture took the first Enter as a newline; ah saw the prompt still waiting and pressed Enter again.
    const screen = ah.tmux('capture-pane', '-p', '-t', id);
    assert.match(screen, /RECEIVED:first line second line/, screen);
    assert.match(screen, /❯ Try "something"/, 'the input box is empty again');
  } finally {
    await cleanup(ah);
  }
});

test('a prompt Stop hands back to the input box is cleared before the next message goes in', async () => {
  const boxed = fileURLToPath(new URL('./fixtures/boxed-agent.js', import.meta.url));
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${boxed} --restore`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('Try "something"'), 10000, 'the agent draws its input box');
    await sleep(5500);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'testing the queue' } })).json().outcome, 'delivered');
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'one' } })).json().outcome, 'queued');
    // Stopped before it answered: the agent puts "testing the queue" back in its box.
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/interrupt`, {})).status, 200);
    const received = () => ah.tmux('capture-pane', '-p', '-t', id).match(/RECEIVED:.*/g) ?? [];
    await until(() => received().length > 1, 15000, 'the queued message went in');
    assert.deepEqual(received(), ['RECEIVED:testing the queue', 'RECEIVED:one'], 'on its own, not after the prompt handed back');
    const screen = ah.tmux('capture-pane', '-p', '-t', id);
    assert.match(screen, /❯ Try "something"/, 'nothing left in the box');
  } finally {
    await cleanup(ah);
  }
});

test('send-now clears a prompt its stop hands back before the urgent message goes in', async () => {
  const boxed = fileURLToPath(new URL('./fixtures/boxed-agent.js', import.meta.url));
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'test-agent', name: 'Test agent', command: `exec ${process.execPath} ${boxed} --restore`, match: '^node$' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'test-agent', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('Try "something"'), 10000, 'the agent draws its input box');
    await sleep(5500);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'testing the queue' } })).json().outcome, 'delivered');
    const queued = (await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'urgent' } })).json();
    assert.equal(queued.outcome, 'queued');
    const now = await http(ah, 'POST', `/api/sessions/${uid}/queue/${queued.queueId}/send-now`, {});
    assert.equal(now.status, 200, now.body);
    const received = () => ah.tmux('capture-pane', '-p', '-t', id).match(/RECEIVED:.*/g) ?? [];
    await until(() => received().length > 1, 10000, 'the urgent message went in');
    assert.deepEqual(received(), ['RECEIVED:testing the queue', 'RECEIVED:urgent'], 'on its own, not after the prompt handed back');
  } finally {
    await cleanup(ah);
  }
});

// The owner's report (2026-11-19): a queued follow-up left the queue, and sat typed in
// Claude Code's box, unsent. Here the agent takes no Enter for that paste at all.
test('a queued follow-up whose Enter never takes is taken back out of the box and sent again', { timeout: 90_000 }, async () => {
  const boxed = fileURLToPath(new URL('./fixtures/boxed-agent.js', import.meta.url));
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [{ id: 'claude', name: 'Fixture', command: `exec ${process.execPath} ${boxed} --transcript --turn=3000 --deaf=2`, match: '^node$', feed: 'claude' }],
  });
  try {
    const created = await http(ah, 'POST', '/api/windows', { body: { preset: 'claude', cwd: `${ah.dir}/files` } });
    assert.equal(created.status, 201, created.body);
    const { id, uid } = created.json();
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('Try "something"'), 10000, 'the agent draws its input box');
    await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.find((w: { uid: string }) => w.uid === uid)?.harnessId, 15000, 'its transcript adopted');
    await sleep(5500);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'start the work' } })).json().outcome, 'delivered');
    const queued = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text: 'why does the session keep restarting?' } });
    assert.equal(queued.json().outcome, 'queued', queued.body);
    // Delivered at idle, its Enters lost; once the agent settles ah empties the box and
    // types it again, and that one goes in.
    await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('RECEIVED:why does the session keep restarting?'), 60000, 'the follow-up reaches the agent');
    const screen = ah.tmux('capture-pane', '-p', '-t', id);
    assert.equal(screen.split('RECEIVED:why does the session keep restarting?').length, 2, 'once');
    await until(() => /❯ Try "something"/.test(ah.tmux('capture-pane', '-p', '-t', id)), 10000, 'the box is empty again');
    assert.deepEqual((await http(ah, 'GET', `/api/sessions/${uid}/queue`)).json(), [], 'and it left the queue');
  } finally {
    await cleanup(ah);
  }
});
