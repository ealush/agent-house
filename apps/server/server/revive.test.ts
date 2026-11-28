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
  assert.equal(b.r.reviving('host_restart-100'), true, 'being brought back');
  assert.equal(b.r.reviving('window-100'), false);
  assert.equal(b.r.reviving('tmux_server-1'), false, "an old incident of a cause it revives isn't being brought back");
  await b.r.settled();
  assert.deepEqual(b.restored, ['boot'], "not an old incident's, not a closed window");
  assert.equal(b.r.reviving('host_restart-100'), false, 'done with it');
});

test('revive: off in config, nothing comes back by itself', async () => {
  const b = bed({ list: [session('a')], config: { autoRestore: false } });
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 1 });
  await b.r.settled();
  assert.deepEqual(b.restored, []);
  assert.equal(b.r.reviving('tmux_server-100'), false);
});

test('revive: tmux dying again and again stops it, says so once, and a quiet spell lets it go on', async () => {
  const b = bed({ list: [], config: { maxCrashes: 3, crashWindowMinutes: 10 } });
  for (let i = 0; i < 3; i++) {
    b.r.noticed({ id: `tmux_server-${i}`, cause: 'tmux_server', count: 0 });
    b.tick(60);
  }
  assert.equal(b.r.reviving('tmux_server-2'), false, 'halted');
  b.r.noticed({ id: 'tmux_server-x', cause: 'tmux_server', count: 0 });
  assert.deepEqual(b.alerts, ['tmux keeps stopping'], 'told once');
  b.tick(3600);
  b.r.noticed({ id: 'tmux_server-later', cause: 'tmux_server', count: 0 });
  assert.equal(b.r.reviving('tmux_server-later'), true, 'steady again');
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
  assert.equal(DEFAULT_REVIVE.keepHours, 12);
  assert.equal(reviveConfig({ keepHours: 0 }).keepHours, 0, '0: kept until you act');
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

test('revive: what a halt left behind stays yours: a later incident brings back only its own', async () => {
  const b = bed({ list: [session('a'), session('b')], config: { maxCrashes: 2 } });
  const sleep0 = b.r['deps'].sleep!;
  let once = true;
  b.r['deps'].sleep = async (ms: number) => {
    // Halted during the pause before b.
    if (once) b.r.noticed({ id: 'tmux_server-200', cause: 'tmux_server', count: 0 });
    once = false;
    return sleep0(ms);
  };
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 2 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['a']);
  // A quiet hour, then another stop that cuts off c: c comes back; b, which the halt left to you, doesn't.
  b.tick(3600);
  b.r['deps'].list = () => [session('b'), session('c', { incident: 'tmux_server-999' })];
  b.r.noticed({ id: 'tmux_server-999', cause: 'tmux_server', count: 1 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['a', 'c']);
});

test('revive: an ah restart in the middle of bringing sessions back picks up the rest', async () => {
  // Before the restart: one incident, a back, b still to come.
  let saved: any = null;
  const store = { load: () => saved, save: (s: any) => void (saved = JSON.parse(JSON.stringify(s))) };
  const first = new Revival({
    config: () => ({ ...DEFAULT_REVIVE }),
    list: () => [session('a'), session('b')],
    restore: async () => new Promise<never>(() => {}), // ah stops while a is being restored
    hasConversation: async () => true,
    tmux: async () => true,
    failed: () => {},
    alert: () => {},
    changed: () => {},
    store,
    sleep: async () => {},
  });
  first.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 2 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(saved.incidents, ['tmux_server-100'], 'what it is bringing back is kept');
  // The new ah: the interruptions are on the records, and the incident is picked up again.
  const restored: string[] = [];
  let list = [session('b')];
  const again = new Revival({
    config: () => ({ ...DEFAULT_REVIVE }),
    list: () => list,
    restore: async (uid) => {
      restored.push(uid);
      list = list.filter((s) => s.uid !== uid);
      return { uid, windowId: '@1', resumed: true, noted: false, midTurn: false };
    },
    hasConversation: async () => true,
    tmux: async () => true,
    failed: () => {},
    alert: () => {},
    changed: () => {},
    store,
    sleep: async () => {},
  });
  again.start();
  await again.settled();
  assert.deepEqual(restored, ['b']);
  assert.deepEqual(saved.incidents, [], 'done with it');
  // Halted before the restart: still halted after it, nothing comes back by itself.
  saved = { deaths: [], incidents: ['tmux_server-100'], halted: true, told: true };
  list = [session('b')];
  const halted = new Revival({ ...again['deps'], store });
  halted.start();
  await halted.settled();
  assert.deepEqual(restored, ['b']);
  assert.equal(halted.reviving('tmux_server-100'), false);
});

test("revive: an agent that doesn't start after its resume is typed is interrupted again, with why", async () => {
  const b = bed({ list: [session('gone'), session('ok')] });
  const notStarted: string[] = [];
  b.r['deps'].started = async (uid) => uid !== 'gone';
  b.r['deps'].notStarted = async (s, windowId, error) => void notStarted.push(`${s.uid} ${windowId} ${error}`);
  b.r.noticed({ id: 'tmux_server-100', cause: 'tmux_server', count: 2 });
  await b.r.settled();
  assert.deepEqual(b.restored, ['gone', 'ok']);
  assert.equal(notStarted.length, 1);
  assert.match(notStarted[0], /^gone @1 its agent didn't start/);
});

test("revive: no transcript proves no conversation only where ah could have found one", async () => {
  const { hasConversation } = await import('./revive.ts');
  const now = 100 * 86400;
  assert.equal(hasConversation({ feed: true, found: true, createdAt: now - 60, now }), true);
  assert.equal(hasConversation({ feed: true, found: false, createdAt: now - 60, now }), false, 'never sent a message');
  // Discovery reads 30 days back: an older session's transcript may just be older than that.
  assert.equal(hasConversation({ feed: true, found: false, createdAt: now - 40 * 86400, now }), true);
  // An agent whose transcripts ah doesn't read: can't tell, so it's resumed.
  assert.equal(hasConversation({ feed: false, found: false, createdAt: now - 60, now }), true);
});
