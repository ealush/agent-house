import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryItem, Win } from '../web/api.ts';
import { recentFor } from '../web/recent.ts';

const item = (ref: string, at: number, over: Partial<HistoryItem> = {}): HistoryItem => ({
  ref, host: 'box', kind: 'ended', harness: 'claude', harnessId: null, title: ref, cwd: '~/code/demo', project: 'demo', model: null, at, pinned: false, worktree: null, fork: null, ...over,
});
const win = { uid: 'blank', host: 'box', project: 'demo' } as Win;

test('a blank session offers its project’s newest past sessions on its host, pinned or not', () => {
  const history = [
    item('pinned-old', 1, { pinned: true }),
    item('new', 50),
    item('other-project', 99, { project: 'other' }),
    item('other-host', 98, { host: 'peer' }),
    item('a-shell', 97, { harness: 'shell' }),
    item('blank', 96),
    item('mid', 40),
    item('saved', 30, { kind: 'saved', ref: 'claude:abc' }),
    item('old', 20),
  ];
  assert.deepEqual(recentFor(history, win).map((h) => h.ref), ['new', 'mid', 'claude:abc', 'old']);
  assert.deepEqual(recentFor(history, win, 2).map((h) => h.ref), ['new', 'mid']);
});
