import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Revival, crashLooping, reviveConfig, toRevive, DEFAULT_REVIVE, type ReviveConfig } from './revive.ts';
import type { InterruptedSession } from './interruptions.ts';

const session = (uid: string, o: Partial<InterruptedSession> = {}): InterruptedSession => ({
  uid, title: uid, harness: 'claude', cwd: '/p', queued: 0,
  cause: 'tmux_server', at: 100, lastSeenAt: 99, incident: 'tmux_server-100', lastStatus: 'idle', midTurn: false, ...o,
});

function bed(o: { list: InterruptedSession[]; config?: Partial<ReviveConfig>; tmux?: () => Promise<boolean>; fails?: string[]; unsaved?: string[] }) {
  let list = [...o.list];
  const restored: string[] = [];
  const failed: Array<[string, string]> = [];
  const alerts: string[] = [];
  const slept: number[] = [];
  let t = 1000;
  const r = new Revival({
    config: () => ({ ...DEFAULT_REVIVE, ...o.config }),
    // The list sorts as Interruptions.list does: mid-turn first.
    list: () => [...list].sort((a, b) => Number(b.midTurn) - Number(a.midTurn)),
    restore: async (uid) => {
      if (o.fails?.includes(uid)) throw new Error('its window could not be made');
      restored.push(uid);
      list = list.filter((s) => s.uid !== uid);
      return { uid, windowId: '@1', resumed: true, noted: false, midTurn: false };
    },
    tmux: o.tmux ?? (async () => true),
    hasConversation: async (uid) => !o.unsaved?.includes(uid),
    failed: (uid, error) => {
      failed.push([uid, error]);
      list = list.map((s) => (s.uid === uid ? { ...s, failed: { at: t, error } } : s));
    },
    alert: (p) => void alerts.push(p.title),
    changed: () => {},
    now: () => t,
    sleep: async (ms) => void slept.push(ms),
  });
  return { r, restored, failed, alerts, slept, tick: (s: number) => (t += s) };
}

test('revive: what a tmux stop cut off comes back, mid-turn first, paced, failures kept and not retried', async () => {
  const b = bed({ list: [session('idle1'), session('busy', { midTurn: true, lastStatus: 'busy' }), session('idle2'), session('broken')], fails: ['broken'] });
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 4 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['busy', 'idle1', 'idle2'], 'mid-turn first');
  assert.deepEqual(b.failed, [['broken', 'its window could not be made']]);
  assert.deepEqual(b.slept, [2000, 2000, 2000], 'one after another, paced');
  // Noticed again: the failed one isn't tried again by itself.
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 1 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['busy', 'idle1', 'idle2']);
});

test("revive: only its incidents, only tmux stops and host restarts; a closed window is yours", async () => {
  const b = bed({ list: [session('old', { incident: 'tmux_server-1' }), session('win', { cause: 'window', incident: 'window-100' }), session('boot', { cause: 'host_restart', incident: 'host_restart-100' })] });
  b.r.noticed({ id: 'window-100', cause: 'window', count: 1 });
  b.r.noticed({ id: 'host_restart-100', cause: 'host_restart', count: 1 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['boot'], "not an old incident's, not a closed window");
  assert.equal(b.r.reviving('window'), false);
  assert.equal(b.r.reviving('host_restart'), true);
});

test('revive: off in config, nothing comes back by itself', async () => {
  const b = bed({ list: [session('a')], config: { autoRestore: false } });
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 1 });
  await b.r.settled();
  assert.deepEqual(b.restored, []);
  assert.equal(b.r.reviving('tmux_server'), false);
});

test('revive: tmux dying again and again stops it, says so once, and a quiet spell lets it go on', async () => {
  const b = bed({ list: [], config: { maxCrashes: 3, crashWindowMinutes: 10 } });
  for (let i = 0; i < 3; i++) {
    b.r.noticed({ id: `tmux_server-${i}`, cause: 'tmux_server', count: 0 });
    b.tick(60);
  }
  assert.equal(b.r.reviving('tmux_server'), false, 'halted');
  b.r.noticed({ id: 'tmux_server-x', cause: 'tmux_server', count: 0 });
  assert.deepEqual(b.alerts, ['tmux keeps stopping'], 'told once');
  b.tick(3600);
  b.r.noticed({ id: 'tmux_server-later', cause: 'tmux_server', count: 0 });
  assert.equal(b.r.reviving('tmux_server'), true, 'steady again');
});

test('revive: no tmux server to come back into, nothing is restored', async () => {
  const b = bed({ list: [session('a')], tmux: async () => false });
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 1 });
  await b.r.settled();
  assert.deepEqual(b.restored, []);
  assert.equal(b.slept.length, 10, 'waited for one, a while, then left it to you');
});

test('revive: config and the pure parts', () => {
  assert.deepEqual(reviveConfig(undefined), DEFAULT_REVIVE);
  assert.equal(reviveConfig({ autoRestore: false }).autoRestore, false);
  assert.equal(reviveConfig({ paceSeconds: -1 } as any).paceSeconds, DEFAULT_REVIVE.paceSeconds);
  assert.equal(crashLooping([1, 2], 3, { maxCrashes: 3, crashWindowMinutes: 1 }), false);
  assert.equal(crashLooping([1, 2, 3], 3, { maxCrashes: 3, crashWindowMinutes: 1 }), true);
  assert.equal(crashLooping([1, 2, 3], 1000, { maxCrashes: 3, crashWindowMinutes: 1 }), false, 'outside the window');
  assert.equal(crashLooping([1, 2, 3], 3, { maxCrashes: 0, crashWindowMinutes: 1 }), false, '0: never halts');
  assert.deepEqual(toRevive([session('a'), session('b', { failed: { at: 1, error: 'x' } })], new Set(['tmux_server-100'])).map((s) => s.uid), ['a']);
});

test("revive: a session that never got a message has nothing to resume: not brought back, said why", async () => {
  const b = bed({ list: [session('fresh'), session('used')], unsaved: ['fresh'] });
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 2 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['used']);
  assert.match(b.failed[0][1], /no saved conversation/);
});

test('revive: tmux dying again mid-batch halts what was still to come; one cut off again gets its turn', async () => {
  // Halted during the pause before the second: it isn't restored after all.
  const b = bed({ list: [session('a'), session('b')], config: { maxCrashes: 2 } });
  const sleep0 = b.r['deps'].sleep!;
  b.r['deps'].sleep = async (ms: number) => {
    b.r.noticed({ id: 'tmux_server-200', cause: 'tmux_server', count: 0 });
    return sleep0(ms);
  };
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 2 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['a'], 'b waits for you');

  // Restored, then cut off again (below the limit): back again, in its new incident.
  let list = [session('a'), session('b')];
  const restored: string[] = [];
  let paused = 0;
  const r = new Revival({
    config: () => ({ ...DEFAULT_REVIVE }),
    list: () => list,
    restore: async (uid, incident) => {
      restored.push(`${uid}@${incident}`);
      list = list.filter((s) => !(s.uid === uid && s.incident === incident));
      return { uid, windowId: '@1', resumed: true, noted: false, midTurn: false };
    },
    hasConversation: async () => true,
    tmux: async () => true,
    failed: () => {},
    alert: () => {},
    changed: () => {},
    sleep: async () => {
      // During the pause after a's restore, a is cut off again.
      if (paused++ === 0) {
        list = [...list, session('a', { incident: 'tmux_server-300' })];
        r.noticed({ id: 'tmux_server-300', cause: 'tmux_server', count: 1 });
      }
    },
  });
  r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 2 });
  await r.settled();
  assert.deepEqual(restored, ['a@tmux_server-100', 'b@tmux_server-100', 'a@tmux_server-300']);
});
