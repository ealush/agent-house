// Sessions come back by themselves (server/revive.ts, CND-8), black box on stand-in agents in
// the bed's own tmux: the server dies under idle and working sessions and every one returns
// in its own conversation (the same harnessId) with nobody calling the API; the ones that
// shouldn't (ended by you, a shell) don't. Then the same at ah's start, after ah and its tmux
// server both went down (a host restart, as ah sees it). Every tmux call goes to the bed's
// server by its socket (ah.tmux), never the developer's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, http, until } from './helpers.ts';
import { launch, say, startBed, transcriptFile, windows } from './fake-agents.ts';

const NOTE = 'Got: [ah] This session was interrupted';
const textOf = (ah: { dir: string }, harnessId: string) => {
  const f = transcriptFile(ah, harnessId);
  return f ? readFileSync(f, 'utf8') : '';
};
const exitEmpty = (ah: { tmux: (...a: string[]) => string }) => ah.tmux('show-options', '-s', '-v', 'exit-empty').trim();
/** Kills the bed's tmux server: tmux may report the server exiting under its own client. */
const kill = (ah: { tmux: (...a: string[]) => string }) => {
  try {
    ah.tmux('kill-server');
  } catch {}
};

test('the tmux server dies: it comes back, and every session with it, idle or mid-turn, by itself', { timeout: 180_000 }, async () => {
  const ah = await startBed({ interruptions: { paceSeconds: 0.2 } });
  try {
    const idle = [await launch(ah, 'claude', ah.project, 'Idle one'), await launch(ah, 'codex', ah.project, 'Idle two'), await launch(ah, 'claude', ah.project, 'Idle three')];
    const busy = [await launch(ah, 'claude', ah.project, 'Busy one'), await launch(ah, 'codex', ah.project, 'Busy two')];
    const yours = await launch(ah, 'claude', ah.project, 'Ended by you');
    const shell = (await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: ah.project } })).json().uid as string;
    for (const s of idle) await say(ah, s.uid, `hello ${s.uid}`);
    for (const s of busy) await http(ah, 'POST', `/api/sessions/${s.uid}/send`, { body: { text: 'SLOW 90000' } });
    await until(async () => (await windows(ah)).filter((w) => busy.some((b) => b.uid === w.uid) && w.status === 'busy').length === busy.length, 10_000, 'both working');
    assert.equal((await http(ah, 'POST', `/api/sessions/${yours.uid}/terminate`)).status, 200);
    await until(async () => !(await windows(ah)).some((w) => w.uid === yours.uid), 8000, 'ended by you');
    const ids = new Map([...idle, ...busy].map((s) => [s.uid, s.harnessId as string]));
    const before = (await http(ah, 'GET', '/api/state')).json();
    const pidBefore = ah.tmux('display-message', '-p', '#{pid}').trim();

    // The crash. From here on the test only watches: no restore, no send, no resume.
    ah.tmux('kill-server');

    // A new server, set up as ah's are: it idles empty.
    await until(() => {
      try {
        return ah.tmux('display-message', '-p', '#{pid}').trim() !== pidBefore;
      } catch {
        return false;
      }
    }, 20_000, 'a new tmux server');
    assert.equal(exitEmpty(ah), 'off');

    // Every interrupted session back in its own conversation, by itself (ah says so for each;
    // the state right after the kill can still show the old windows).
    await until(() => [...ids.keys()].every((uid) => new RegExp(`revive: ${uid} back in`).test(ah.log())), 60_000, 'all five brought back');
    const back = await until(async () => {
      const ws = await windows(ah);
      const live = [...ids].map(([uid, hid]) => ws.find((w) => w.uid === uid && w.harnessId === hid && w.agent));
      return live.every(Boolean) ? live : null;
    }, 60_000, 'all five back');
    assert.equal(back.length, 5);
    // The mid-turn ones were told where they stopped; the idle ones were sent nothing.
    for (const s of busy) await until(() => textOf(ah, ids.get(s.uid)!).includes(NOTE), 20_000, `${s.uid} told`);
    for (const s of idle) assert.ok(!textOf(ah, ids.get(s.uid)!).includes(NOTE), `${s.uid}: no message, no turn`);
    const order = [...ah.log().matchAll(/revive: (\w+) back in/g)].map((m) => m[1]);
    assert.deepEqual(new Set(order.slice(0, 2)), new Set(busy.map((s) => s.uid)), 'mid-turn first');

    // Not the one you ended, not the shell.
    const ws = await windows(ah);
    assert.ok(!ws.some((w) => w.uid === yours.uid), 'ended by you stays ended');
    assert.ok(!ws.some((w) => w.uid === shell), 'a shell has no conversation to come back to');
    const st = (await http(ah, 'GET', '/api/state')).json();
    assert.equal(st.interruptions.count, 0, 'nothing left to restore');
    assert.match(ah.log(), /interruptions: 5 session\(s\) interrupted \(tmux_server\), 2 mid-turn/);
    // Every session that came back keeps its launch: the same preset, and its harness id.
    for (const w of back) assert.equal(before.windows.find((x: any) => x.uid === w.uid)?.agent, w.agent);
    // No API call did it: the audit log has no restore.
    assert.doesNotMatch(ah.log(), /"event":"interruptions\.restore"/);
  } finally {
    await cleanup(ah);
  }
});

test('tmux dying again and again: ah stops bringing sessions back, says so once, and leaves them to you', { timeout: 180_000 }, async () => {
  const ah = await startBed({ interruptions: { paceSeconds: 0.2, maxCrashes: 2, crashWindowMinutes: 10 } });
  try {
    const a = await launch(ah, 'claude', ah.project, 'Survivor');
    await say(ah, a.uid, 'hello');
    const hid = a.harnessId as string;
    kill(ah);
    // Back by itself (ah says so: the state right after the kill can still show the old window).
    await until(() => new RegExp(`revive: ${a.uid} back in`).test(ah.log()), 60_000, 'back after the first');
    await until(async () => (await windows(ah)).some((w) => w.uid === a.uid && w.harnessId === hid && w.agent && ['idle', 'attention'].includes(w.status)), 30_000, 'up again');
    kill(ah);
    // The second death in the window: the server comes back, the session doesn't.
    await until(() => /revive: tmux stopped 2 times in 10 minutes/.test(ah.log()), 30_000, 'halted');
    const list = await until(async () => {
      const l = (await http(ah, 'GET', '/api/interruptions')).json();
      return l.count === 1 ? l : null;
    }, 20_000, 'left to you');
    assert.equal(list.interruptions[0].uid, a.uid);
    await new Promise((r) => setTimeout(r, 3000));
    assert.ok(!(await windows(ah)).some((w) => w.uid === a.uid && w.agent), 'not brought back');
    await until(() => {
      try {
        return exitEmpty(ah) === 'off';
      } catch {
        return false;
      }
    }, 20_000, 'the server back regardless, idling empty');
    // You still can.
    const r = await http(ah, 'POST', `/api/sessions/${a.uid}/restore`, { body: {} });
    assert.ok([200, 201].includes(r.status), r.body);
  } finally {
    await cleanup(ah);
  }
});

test('ah and its tmux both went down: at its start the sessions come back by themselves', { timeout: 180_000 }, async () => {
  const ah = await startBed({ interruptions: { paceSeconds: 0.2 } });
  let next: typeof ah | undefined;
  try {
    const a = await launch(ah, 'claude', ah.project, 'Idle');
    const b = await launch(ah, 'codex', ah.project, 'Busy');
    await say(ah, a.uid, 'hello');
    await http(ah, 'POST', `/api/sessions/${b.uid}/send`, { body: { text: 'SLOW 90000' } });
    await until(async () => (await windows(ah)).some((w) => w.uid === b.uid && w.status === 'busy'), 10_000, 'working');
    // ah stops, then the server goes too (as at a reboot), and ah starts again.
    await ah.stop();
    ah.tmux('kill-server');
    next = await ah.restart();
    const back = await until(async () => {
      const ws = await windows(next!);
      return [a, b].every((s) => ws.some((w) => w.uid === s.uid && w.harnessId === s.harnessId && w.agent)) ? ws : null;
    }, 60_000, 'both back at start');
    assert.ok(back);
    await until(() => textOf(next!, b.harnessId as string).includes(NOTE), 20_000, 'the busy one told');
    assert.ok(!textOf(next!, a.harnessId as string).includes(NOTE), 'the idle one sent nothing');
    assert.equal(next.tmux('show-options', '-s', '-v', 'exit-empty').trim(), 'off');
  } finally {
    await cleanup(ah);
  }
});

test('with autoRestore off, sessions a tmux stop cut off wait for you, as before', { timeout: 120_000 }, async () => {
  const ah = await startBed({ interruptions: { autoRestore: false } });
  try {
    const a = await launch(ah, 'claude', ah.project, 'Waits');
    await say(ah, a.uid, 'hello');
    ah.tmux('kill-server');
    await until(async () => (await http(ah, 'GET', '/api/interruptions')).json().count === 1, 20_000, 'interrupted');
    await new Promise((r) => setTimeout(r, 4000));
    assert.ok(!(await windows(ah)).some((w) => w.uid === a.uid && w.agent), 'not brought back');
    assert.match(ah.log(), /Restore it in ah|interrupted/);
  } finally {
    await cleanup(ah);
  }
});

// Codex's second review of the stack: two ways a second tmux server still started beside the
// live one whose socket was deleted (a /tmp cleaner): ah restarted meanwhile (it had seen no
// server yet, and didn't read the one the last ah saw), and a window made before ah noticed.
const socketOf = (ah: { dir: string }) => join(ah.dir, 'tmux', `tmux-${process.getuid!()}`, 'default');
const serverPid = (ah: { tmux: (...a: string[]) => string }) => Number(ah.tmux('display-message', '-p', '#{pid}').trim());

test("its socket deleted while ah was down: at ah's start the same server is asked back, not a second beside it", { timeout: 120_000 }, async () => {
  const ah = await startBed();
  const pids = new Set<number>();
  try {
    const a = await launch(ah, 'claude', ah.project, 'Kept');
    const pid = serverPid(ah);
    pids.add(pid);
    await until(() => existsSync(join(ah.dir, 'state', 'ah', 'tmux-server.json')), 10_000, 'the server remembered');
    await ah.stop();
    unlinkSync(socketOf(ah));
    const next = await ah.restart({ tmux: false });
    await until(() => existsSync(socketOf(ah)), 15_000, 'a socket again');
    const now = serverPid(next);
    pids.add(now);
    assert.equal(now, pid, 'the same server answers, not a new one');
    await until(async () => (await windows(next)).some((w) => w.uid === a.uid && w.agent === 'claude'), 15_000, 'its session found running');
  } finally {
    await cleanup(ah);
    for (const p of pids) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {}
    }
  }
});

test('a window made while the socket is gone goes to the server still running, not a new one', { timeout: 120_000 }, async () => {
  const ah = await startBed();
  const pids = new Set<number>();
  try {
    await launch(ah, 'claude', ah.project, 'Kept');
    const pid = serverPid(ah);
    pids.add(pid);
    unlinkSync(socketOf(ah));
    const made = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: ah.project } });
    assert.equal(made.status, 201, made.body);
    const now = serverPid(ah);
    pids.add(now);
    assert.equal(now, pid, 'the same server');
    assert.ok(ah.tmux('list-windows', '-a', '-F', '#{window_id}').split('\n').includes(made.json().id), 'the window in it');
  } finally {
    await cleanup(ah);
    for (const p of pids) {
      try {
        process.kill(p, 'SIGTERM');
      } catch {}
    }
  }
});
