import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStateDelta,
  diffFleet,
  formatAsk,
  formatDuration,
  formatFeedEntries,
  parseDuration,
  parseSseChunk,
  resolvePickerChoice,
  type FleetWindow,
  type SseFrame,
} from './cliHelpers.ts';

test('parseDuration and formatDuration handle single, compound and invalid spans', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('5m'), 300);
  assert.equal(parseDuration('2h'), 7200);
  assert.equal(parseDuration('1d'), 86400);
  assert.equal(parseDuration('1h30m'), 5400);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration('0s'), null);
  assert.equal(parseDuration('bogus'), null);
  assert.equal(parseDuration('5m2x'), null);
  assert.equal(formatDuration(30), '30s');
  assert.equal(formatDuration(300), '5m');
  assert.equal(formatDuration(7200), '2h');
  assert.equal(formatDuration(86400), '1d');
});

test('parseSseChunk buffers partial frames and parses JSON events', () => {
  const frames: SseFrame[] = [];
  let buf = '';
  buf = parseSseChunk(buf, ': ping\n\nevent: state\ndata: {"a":', (f) => frames.push(f));
  assert.equal(frames.length, 0);
  buf = parseSseChunk(buf, '1}\n\nevent: patch\ndata: {"a":2}\n\n', (f) => frames.push(f));
  assert.equal(buf, '');
  assert.deepEqual(frames, [
    { event: 'state', data: { a: 1 } },
    { event: 'patch', data: { a: 2 } },
  ]);
});

test('applyStateDelta merges windowsDelta order and changed items', () => {
  const initial = {
    api: 28,
    windows: [
      { uid: 'a', status: 'busy' },
      { uid: 'b', status: 'idle' },
    ],
  };
  const next = applyStateDelta(initial, {
    windowsDelta: { order: ['b', 'c'], changed: [{ uid: 'c', status: 'waiting' }] },
  });
  assert.deepEqual(next.windows, [
    { uid: 'b', status: 'idle' },
    { uid: 'c', status: 'waiting' },
  ]);
  assert.equal('windowsDelta' in next, false);
});

test('diffFleet emits started, ended, status, ask and reply events', () => {
  const prev: FleetWindow[] = [
    { uid: 'a', title: 'Alpha', name: 'a', agent: 'claude', status: 'busy', ask: null, askId: null, answerable: false, reply: null },
    { uid: 'b', title: 'Beta', name: 'b', agent: 'codex', status: 'idle', ask: null, askId: null, answerable: false, reply: null },
  ];
  const next: FleetWindow[] = [
    {
      uid: 'a',
      title: 'Alpha',
      name: 'a',
      agent: 'claude',
      status: 'waiting',
      ask: { kind: 'command', text: 'rm -rf dist' },
      askId: 'ask1',
      answerable: true,
      reply: { role: 'assistant', text: 'Need permission', at: 10 },
    },
    { uid: 'c', title: 'Gamma', name: 'c', agent: 'gemini', status: 'idle', ask: null, askId: null, answerable: false, reply: null },
  ];
  const evs = diffFleet(prev, next);
  assert.deepEqual(
    evs.map((e) => [e.event, e.uid]),
    [
      ['status', 'a'],
      ['ask', 'a'],
      ['reply', 'a'],
      ['started', 'c'],
      ['ended', 'b'],
    ],
  );
  const scoped = diffFleet(prev, next, new Set(['b']));
  assert.deepEqual(scoped.map((e) => [e.event, e.uid]), [['ended', 'b']]);
});

test('resolvePickerChoice supports exact keys, hotkeys and 1-based cursor nav options', () => {
  const navOpts = [
    { key: 'nav:0', label: 'Yes, run command' },
    { key: 'nav:1', label: 'No, cancel' },
  ];
  assert.equal(resolvePickerChoice(navOpts, '1')?.key, 'nav:0');
  assert.equal(resolvePickerChoice(navOpts, '2')?.key, 'nav:1');
  assert.equal(resolvePickerChoice(navOpts, 'nav:1')?.key, 'nav:1');
  assert.equal(resolvePickerChoice(navOpts, '3'), null);

  const hotkeyOpts = [
    { key: 'y', label: 'Yes' },
    { key: 'p', label: "Yes, don't ask again" },
  ];
  assert.equal(resolvePickerChoice(hotkeyOpts, 'p')?.key, 'p');
  assert.equal(resolvePickerChoice(hotkeyOpts, 'P')?.key, 'p');
});

test('formatAsk and formatFeedEntries render readable summaries', () => {
  const askLines = formatAsk(
    {
      kind: 'command',
      text: 'pnpm test',
      options: [{ key: 'nav:0', label: 'Allow once' }],
      gate: { kind: 'signin', code: 'ABCD-1234', links: ['https://example.com'] },
    },
    { askId: 'id42', answerable: true },
  );
  assert.ok(askLines.some((l) => l.includes('id=id42')));
  assert.ok(askLines.some((l) => l.includes('1. Allow once')));
  assert.ok(askLines.some((l) => l.includes('Code: ABCD-1234')));

  const feedText = formatFeedEntries([
    { role: 'user', at: 1700000000000, parts: [{ type: 'text', text: 'check status' }] },
    { role: 'assistant', at: 1700000001000, parts: [{ type: 'tool_call', call: { id: '1', name: 'Bash', args: { cmd: 'ls' } } }] },
  ]);
  assert.match(feedText, /USER/);
  assert.match(feedText, /check status/);
  assert.match(feedText, /\[tool: Bash\]/);
});
