import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startAh, cleanup, http, signIn, until } from './helpers.ts';

test('attached shells are isolated, persistent, hidden, and refuse input while busy', { timeout: 60_000 }, async () => {
  let ah = await startAh();
  let viewer: WebSocket | undefined;
  try {
    const cookie = await signIn(ah);
    const create = async () => {
      const r = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files` } });
      assert.equal(r.status, 201, r.body);
      return r.json().uid as string;
    };
    const uid = await create();
    const other = await create();
    const route = `/api/sessions/${uid}/terminal`;
    assert.equal((await http(ah, 'POST', route, { body: {} })).status, 401);
    assert.equal((await http(ah, 'POST', '/api/sessions/missing/terminal', { cookie, body: {} })).status, 404);
    assert.equal((await http(ah, 'GET', route, { cookie })).json().terminal, null);
    const opens = await Promise.all(Array.from({ length: 3 }, () => http(ah, 'POST', route, { cookie, body: {} })));
    for (const r of opens) assert.equal(r.status, 200, r.body);
    const terminal = opens[0].json().terminal;
    assert.ok(opens.every((r) => r.json().terminal.id === terminal.id));
    assert.equal(terminal.cwd, `${ah.dir}/files`);
    const capture = () => ah.tmux('capture-pane', '-p', '-S', '-200', '-t', terminal.id);
    const run = await http(ah, 'POST', route, { cookie, body: { command: `node -e "require('http').createServer((q,r)=>r.end('attached')).listen(0,'127.0.0.1',function(){console.log('attached-output');console.log('PORT='+this.address().port)})"` } });
    assert.equal(run.status, 200, run.body);
    await until(() => capture().includes('\nattached-output'), 5000, 'command output');
    await until(async () => (await http(ah, 'GET', route, { cookie })).json().terminal.busy, 5000, 'busy foreground process');
    const port = Number(await until(() => /PORT=(\d+)/.exec(capture())?.[1], 5000, 'attached server port'));
    await until(async () => (await http(ah, 'GET', `/api/sessions/${uid}/preview`, { cookie })).json().ports.includes(port), 5000, 'attached server discovered by Preview');
    const refused = await http(ah, 'POST', route, { cookie, body: { command: 'echo do-not-run' } });
    assert.equal(refused.status, 409, refused.body);
    assert.equal(refused.json().code, 'terminal_busy');
    assert.ok(!capture().includes('do-not-run'));
    assert.equal((await http(ah, 'GET', `/api/sessions/${other}/terminal`, { cookie })).json().terminal, null);
    let state = (await http(ah, 'GET', '/api/state', { cookie })).json();
    assert.ok(state.windows.find((w: { uid: string }) => w.uid === uid).terminal.busy);
    assert.ok(!state.windows.some((w: { id: string }) => w.id === terminal.id));
    assert.ok(!state.history.some((h: { title: string }) => h.title === 'terminal'));
    ah = await ah.restart();
    assert.equal((await http(ah, 'POST', route, { cookie, body: {} })).json().terminal.id, terminal.id);
    ah.tmux('send-keys', '-t', terminal.id, 'C-c');
    await until(async () => !(await http(ah, 'GET', route, { cookie })).json().terminal.busy, 5000, 'idle again');
    viewer = new WebSocket(`ws://127.0.0.1:${ah.port}/ws/${encodeURIComponent(terminal.id)}?cols=80&rows=24`, {
      headers: { host: `localhost:${ah.port}`, origin: `http://localhost:${ah.port}`, cookie },
    });
    await once(viewer, 'message'); // the grouped tmux viewer is attached and drawing
    const detached = once(viewer, 'close');
    // Closing the terminal stops it, but leaves its owner alone; reopening gets a fresh shell.
    assert.equal((await http(ah, 'DELETE', route, { cookie })).status, 200);
    await detached;
    assert.equal((await http(ah, 'GET', route, { cookie })).json().terminal, null);
    const fresh = (await http(ah, 'POST', route, { cookie, body: {} })).json().terminal;
    assert.notEqual(fresh.id, terminal.id);
    assert.equal((await http(ah, 'POST', `/api/sessions/${uid}/terminate`, { cookie })).status, 200);
    assert.equal((await http(ah, 'GET', route, { cookie })).json().terminal, null);
    state = (await http(ah, 'GET', '/api/state', { cookie })).json();
    assert.ok(state.windows.some((w: { uid: string }) => w.uid === other));
  } finally { viewer?.terminate(); await cleanup(ah); }
});

test('the last command and its output read back, however it ran', { timeout: 60_000 }, async () => {
  let ah = await startAh();
  let viewer: WebSocket | undefined;
  try {
    const cookie = await signIn(ah);
    const made = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files` } });
    const uid = made.json().uid as string;
    const route = `/api/sessions/${uid}/terminal`;
    const text = async () => (await http(ah, 'GET', `${route}/text`, { cookie })).json();
    const last = async () => (await text()).last;
    assert.deepEqual(await text(), { terminal: null, last: null, screen: null });
    const terminal = (await http(ah, 'POST', route, { cookie, body: {} })).json().terminal;
    const idle = () => until(async () => !(await http(ah, 'GET', route, { cookie })).json().terminal.busy, 5000, 'idle');
    const capture = () => ah.tmux('capture-pane', '-p', '-S', '-200', '-t', terminal.id);

    // A snippet run from a reply: two lines of output, then the next prompt (not output).
    assert.equal((await http(ah, 'POST', route, { cookie, body: { command: 'echo snippet-one; echo snippet-two' } })).status, 200);
    await until(() => capture().includes('\nsnippet-two'), 5000, 'snippet output');
    await idle();
    let read = (await last());
    assert.equal(read.command, 'echo snippet-one; echo snippet-two');
    assert.equal(read.output, 'snippet-one\nsnippet-two');
    assert.equal(read.running, false);
    assert.ok(read.line.endsWith('echo snippet-one; echo snippet-two'));
    const screen = (await text()).screen as string;
    assert.ok(screen.includes('\nsnippet-two\n'), screen);
    assert.ok(!screen.endsWith('\n'));

    // Typed in a viewer, Return on its own: the same.
    viewer = new WebSocket(`ws://127.0.0.1:${ah.port}/ws/${encodeURIComponent(terminal.id)}?cols=80&rows=24`, {
      headers: { host: `localhost:${ah.port}`, origin: `http://localhost:${ah.port}`, cookie },
    });
    await once(viewer, 'message');
    const type = (d: string) => viewer!.send(JSON.stringify({ t: 'i', d }));
    type("printf 'typed-a\\ntyped-b\\n'");
    await until(() => capture().includes("printf 'typed-a"), 5000, 'typed command echoed');
    type('\r');
    await until(() => capture().includes('\ntyped-b'), 5000, 'typed output');
    await idle();
    read = (await last());
    assert.equal(read.command, "printf 'typed-a\\ntyped-b\\n'");
    assert.equal(read.output, 'typed-a\ntyped-b');

    // The same command again: its last line is output, though the line above it ends alike.
    assert.equal((await http(ah, 'POST', route, { cookie, body: { command: "printf 'typed-a\\ntyped-b\\n'" } })).status, 200);
    await until(() => capture().split('\ntyped-b').length === 3, 5000, 'second run');
    await idle();
    assert.equal((await last()).output, 'typed-a\ntyped-b');

    // A bare Return at an empty prompt isn't a command: the one before still is.
    type('\r');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await last()).command, "printf 'typed-a\\ntyped-b\\n'");

    // A command that prints nothing is still the last one.
    type('true');
    await until(() => capture().trimEnd().endsWith('true'), 5000, 'true echoed');
    type('\r');
    await new Promise((r) => setTimeout(r, 300));
    read = (await last());
    assert.equal(read.command, 'true');
    assert.equal(read.output, '');

    // Typed without running: it waits at the prompt, and the last command is unchanged.
    assert.equal((await http(ah, 'POST', route, { cookie, body: { command: 'echo not-yet', run: false } })).status, 200);
    await until(() => capture().trimEnd().endsWith('echo not-yet'), 5000, 'typed, not run');
    assert.ok(!capture().includes('\nnot-yet'));
    assert.equal((await http(ah, 'POST', route, { cookie, body: { command: 'x', run: 'no' } })).status, 400);
    ah.tmux('send-keys', '-t', terminal.id, 'C-u');

    // Still running: what it printed so far.
    assert.equal((await http(ah, 'POST', route, { cookie, body: { command: 'echo started; sleep 30' } })).status, 200);
    await until(() => capture().includes('\nstarted'), 5000, 'running output');
    read = (await last());
    assert.equal(read.running, true);
    assert.equal(read.command, 'echo started; sleep 30');
    assert.equal(read.output, 'started');
    ah.tmux('send-keys', '-t', terminal.id, 'C-c');
    await idle();

    // ah restarted, its notes gone: the prompt's earlier line is found by its prompt.
    ah.tmux('send-keys', '-t', terminal.id, 'clear', 'Enter');
    await new Promise((r) => setTimeout(r, 300));
    viewer.terminate();
    viewer = undefined;
    ah = await ah.restart();
    ah.tmux('send-keys', '-t', terminal.id, 'echo after-restart', 'Enter');
    await until(() => capture().includes('\nafter-restart'), 5000, 'output after restart');
    await idle();
    read = (await last());
    assert.equal(read.command, 'echo after-restart');
    assert.equal(read.output, 'after-restart');

    // A command that moves to another folder (the prompt names it) and then restarts ah, as a
    // deploy does: what ah saw run is kept on disk, so it's still the last command.
    ah.tmux('send-keys', '-t', terminal.id, "mkdir -p moved && PS1='\\W $ '", 'Enter');
    await until(() => capture().trimEnd().endsWith('files $'), 5000, 'a prompt naming the folder');
    assert.equal((await http(ah, 'POST', route, { cookie, body: { command: 'cd moved && echo deployed' } })).status, 200);
    await until(() => capture().trimEnd().endsWith('moved $'), 5000, 'the new folder in the prompt');
    await idle();
    ah = await ah.restart();
    read = (await last());
    assert.equal(read.command, 'cd moved && echo deployed');
    assert.equal(read.output, 'deployed');
  } finally { viewer?.terminate(); await cleanup(ah); }
});

test('a command that fills its row to the last column reads back apart from its output', { timeout: 60_000 }, async () => {
  const ah = await startAh();
  try {
    const cookie = await signIn(ah);
    const made = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files` } });
    const route = `/api/sessions/${made.json().uid as string}/terminal`;
    const terminal = (await http(ah, 'POST', route, { cookie, body: {} })).json().terminal;
    const capture = () => ah.tmux('capture-pane', '-p', '-S', '-200', '-t', terminal.id);
    const idle = () => until(async () => !(await http(ah, 'GET', route, { cookie })).json().terminal.busy, 5000, 'idle');
    ah.tmux('send-keys', '-t', terminal.id, "PS1='$ '", 'Enter');
    await until(() => capture().trimEnd().endsWith('\n$'), 5000, 'a two-character prompt');

    // Prompt and command end in the row's last column: tmux marks the row wrapped, and its
    // joined lines (`capture-pane -J`) carry the first line of output on the command's.
    const width = Number(ah.tmux('display-message', '-p', '-t', terminal.id, '#{pane_width}').trim());
    const printed = 'x'.repeat(width - '$ echo '.length);
    assert.equal((await http(ah, 'POST', route, { cookie, body: { command: `echo ${printed}` } })).status, 200);
    await until(() => capture().includes(`\n${printed}\n`), 5000, 'output');
    await idle();
    const read = (await http(ah, 'GET', `${route}/text`, { cookie })).json().last;
    assert.equal(read.command, `echo ${printed}`);
    assert.equal(read.output, printed);
  } finally { await cleanup(ah); }
});
