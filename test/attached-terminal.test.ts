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
