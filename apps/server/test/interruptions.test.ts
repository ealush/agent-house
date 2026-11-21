// Interrupted sessions, black box, on stand-in agents: the tmux server dies under four
// sessions (two mid-turn, one of them with a prompt you queued, one finished, one you
// ended). ah says which were cut off, and restores them in one step, mid-turn ones first,
// each told where it stopped before your queued prompt goes in. Then the same after ah
// restarts on a new tmux server, and a window closed mid-turn. Every tmux call here goes
// to the bed's own server by its socket (ah.tmux), never the developer's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, transcriptFile, windows } from './fake-agents.ts';

const NOTE = 'Got: [ah] This session was interrupted';
const textOf = (ah: { dir: string }, harnessId: string) => {
  const f = transcriptFile(ah, harnessId);
  return f ? readFileSync(f, 'utf8') : '';
};
const CLI = fileURLToPath(new URL('../bin/ah.js', import.meta.url));
const ahCli = (ah: { env: NodeJS.ProcessEnv; port: number }, ...args: string[]) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) =>
    execFile(process.execPath, [CLI, ...args], { env: { ...ah.env, AH_PORT: String(ah.port) } }, (e, out, err) => resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err })),
  );
const state = async (ah: any) => (await http(ah, 'GET', '/api/state')).json();

test('a tmux server that dies under its sessions: told which were cut off, restored in one step', async () => {
  const ah = await startBed();
  try {
    const a = await launch(ah, 'claude', ah.project, 'Mid-turn');
    const b = await launch(ah, 'claude', ah.project, 'Finished');
    const c = await launch(ah, 'claude', ah.project, 'Mid-turn with a queued prompt');
    const d = await launch(ah, 'claude', ah.project, 'Ended by you');
    await say(ah, b.uid, 'all done');
    await say(ah, c.uid, 'first step');
    for (const s of [a, c]) await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'SLOW 90000' } });
    await until(async () => (await windows(ah)).filter((w) => [a.uid, c.uid].includes(w.uid) && w.status === 'busy').length === 2, 10000, 'both working');
    const queued = await http(ah, 'POST', `/api/sessions/${c.uid}/send`, { body: { text: 'and then the queued one' } });
    assert.equal(queued.json().outcome, 'queued');
    assert.equal((await http(ah, 'POST', `/api/sessions/${d.uid}/terminate`)).status, 200);
    await until(async () => !(await windows(ah)).some((w) => w.uid === d.uid), 8000, 'ended by you');

    // The crash: the bed's tmux server, every window with it.
    ah.tmux('kill-server');
    const list = await until(async () => {
      const l = (await http(ah, 'GET', '/api/interruptions')).json();
      return l.count === 3 ? l : null;
    }, 10000, 'three interrupted');
    assert.deepEqual(new Set(list.interruptions.map((s: any) => s.uid)), new Set([a.uid, b.uid, c.uid]), 'not the one you ended');
    assert.ok(list.interruptions.every((s: any) => s.cause === 'tmux_server'));
    assert.deepEqual(list.interruptions.map((s: any) => s.midTurn), [true, true, false], 'mid-turn ones first');
    assert.equal(list.incidents.length, 1);
    assert.deepEqual([list.incidents[0].count, list.incidents[0].midTurn], [3, 2]);
    assert.equal(list.interruptions.find((s: any) => s.uid === c.uid).queued, 1);
    const st = await state(ah);
    assert.equal(st.features.interruptions, 1);
    assert.equal(st.interruptions.count, 3);
    assert.equal(st.history.find((h: any) => h.ref === a.uid).interrupted.cause, 'tmux_server');
    assert.equal(st.history.find((h: any) => h.ref === d.uid).interrupted, null, 'ended by you: plain history');
    assert.match(ah.log(), /interruptions: 3 session\(s\) interrupted \(tmux_server\), 2 mid-turn/);

    // Everything, without saying so, is refused; then all of them in one step.
    assert.equal((await http(ah, 'POST', '/api/interruptions/restore', { body: {} })).json().code, 'invalid_target');
    const res = await http(ah, 'POST', '/api/interruptions/restore', { body: { all: true } });
    assert.equal(res.status, 200, res.body);
    const out = res.json();
    assert.deepEqual(out.failed, []);
    assert.deepEqual(out.restored.map((r: any) => r.noted), [true, true, false]);
    assert.equal(out.restored[2].uid, b.uid);

    // Each back in its own conversation; the mid-turn ones told first, the queued prompt after.
    const back = await until(async () => {
      const ws = (await windows(ah)).filter((w) => [a.uid, b.uid, c.uid].includes(w.uid) && w.harnessId);
      return ws.length === 3 ? ws : null;
    }, 20000, 'all three running');
    for (const s of [a, b, c]) assert.equal(back.find((w) => w.uid === s.uid)!.harnessId, s.harnessId, 'the same conversation');
    await until(() => textOf(ah, a.harnessId).includes(NOTE), 30000, 'a told where it stopped');
    await until(() => textOf(ah, c.harnessId).includes('Got: and then the queued one'), 45000, 'c: its queued prompt went in');
    const ct = textOf(ah, c.harnessId);
    assert.ok(ct.indexOf(NOTE) > 0 && ct.indexOf(NOTE) < ct.indexOf('Got: and then the queued one'), 'the note before your prompt');
    assert.ok(ct.includes('The last step recorded: you wrote \\"Got: first step\\"'), 'and where it stopped');
    assert.equal(textOf(ah, b.harnessId).includes(NOTE), false, 'nothing typed into the one that had finished');
    assert.equal((await http(ah, 'GET', '/api/interruptions')).json().count, 0);
    assert.deepEqual((await http(ah, 'POST', '/api/interruptions/restore', { body: { all: true } })).json(), { restored: [], failed: [] }, 'again: nothing to do');
  } finally {
    await cleanup(ah);
  }
});

test('after ah restarts on a new tmux server, and a window closed mid-turn; dismissing', async () => {
  const ah = await startBed();
  try {
    const a = await launch(ah, 'claude', ah.project, 'Idle at the restart');
    const b = await launch(ah, 'claude', ah.project, 'Closed mid-turn');
    await say(ah, a.uid, 'hello');
    await new Promise((r) => setTimeout(r, 2000));
    // ah stops; its tmux server dies while it's away; ah comes back on a new one.
    await ah.stop();
    ah.tmux('kill-server');
    const ah2 = await ah.restart();
    const l = await until(async () => {
      const x = (await http(ah2, 'GET', '/api/interruptions')).json();
      return x.count === 2 ? x : null;
    }, 15000, 'found interrupted at start');
    assert.ok(l.interruptions.every((s: any) => s.cause === 'tmux_server'), JSON.stringify(l));
    // Bring one back by itself, without the note.
    const one = await http(ah2, 'POST', `/api/sessions/${b.uid}/restore`, { body: { note: false } });
    assert.equal(one.status, 201, one.body);
    assert.equal(one.json().noted, false);
    await until(async () => (await windows(ah2)).find((w) => w.uid === b.uid && w.harnessId), 15000, 'b running');
    // Its window closed while it worked: interrupted again, this time by the window.
    await say(ah2, b.uid, 'warm up');
    await http(ah2, 'POST', `/api/sessions/${b.uid}/send`, { body: { text: 'SLOW 60000' } });
    const w = await until(async () => (await windows(ah2)).find((x) => x.uid === b.uid && x.status === 'busy'), 10000, 'working');
    ah2.tmux('kill-window', '-t', w.id);
    const again = await until(async () => (await http(ah2, 'GET', '/api/interruptions')).json().interruptions.find((s: any) => s.uid === b.uid), 10000, 'window interruption');
    assert.equal(again.cause, 'window');
    assert.equal(again.midTurn, true);
    // The CLI lists them; dismissing makes them plain history again, nothing to restore.
    const listed = await ahCli(ah2, 'restore');
    assert.equal(listed.code, 0, listed.err);
    assert.match(listed.out, /Closed mid-turn .*its window closed .*busy/);
    assert.match(listed.out, /Idle at the restart .*the tmux server stopped .*done/);
    const dismissed = await ahCli(ah2, 'restore', '--all', '--dismiss');
    assert.equal(dismissed.out.trim(), 'dismissed 2', dismissed.err);
    assert.equal((await http(ah2, 'GET', '/api/interruptions')).json().count, 0);
    const refused = await http(ah2, 'POST', `/api/sessions/${a.uid}/restore`, { body: {} });
    assert.equal(refused.status, 409);
    assert.equal(refused.json().code, 'not_interrupted');
  } finally {
    await cleanup(ah);
  }
});
