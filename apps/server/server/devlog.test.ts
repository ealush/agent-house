import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DevLog, attachmentsIn, clientInfo, dayOf, expired, messageDetail, redactedPath, slug, TEXT_KEEP } from './devlog.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'ah-devlog-'));
const lines = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a day folder is named by the local calendar day', () => {
  assert.equal(dayOf(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});

test('the last three days are kept, across a month and a year', () => {
  const days = ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', 'notes', '2026-1-1'];
  assert.deepEqual(expired(days, new Date(2026, 0, 2, 9)), ['2025-12-30']);
  assert.deepEqual(expired(days, new Date(2026, 0, 3)), ['2025-12-30', '2025-12-31']);
  assert.deepEqual(expired(['2026-03-01'], new Date(2026, 2, 3)), []);
  assert.deepEqual(expired(['2026-02-28'], new Date(2026, 2, 3)), ['2026-02-28']);
});

test('secrets in a query are never written', () => {
  assert.equal(redactedPath('/api/x', new URLSearchParams('q=hello&token=abc&setupCode=1&apiKey=k')), '/api/x?q=hello&token=…&setupCode=…&apiKey=…');
  assert.equal(redactedPath('/api/state', new URLSearchParams('')), '/api/state');
});

test('a bundle names its sender in a few safe characters', () => {
  assert.equal(slug("Evyatar's iPhone/../x"), 'Evyatar-s-iPhone-..-x');
  assert.equal(slug('..'), 'device');
  assert.deepEqual(clientInfo({ app: 'ios', device: 'iPad', version: 1, extra: 'x' }), { app: 'ios', device: 'iPad', version: '', build: '', os: '' });
  assert.equal(clientInfo(null).app, 'client');
});

test('attachments are counted by their size, never read', async () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, 'shot.png'), Buffer.alloc(1234));
    mkdirSync(join(dir, 'a.dir'));
    const text = `look ${join(dir, 'shot.png')} and ${join(dir, 'gone.jpg')} and ${join(dir, 'a.dir')} and not/relative.txt`;
    assert.deepEqual(await attachmentsIn(text), [
      { ext: 'png', bytes: 1234 },
      { ext: 'jpg', bytes: null },
    ]);
    const detail = await messageDetail(text);
    assert.equal(detail.attachmentBytes, 1234);
    assert.equal(detail.text, text);
    const long = await messageDetail('x'.repeat(TEXT_KEEP + 10));
    assert.equal(long.chars, TEXT_KEEP + 10);
    assert.equal((long.text as string).length, TEXT_KEEP + 1);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('nothing is written until the log is set up and turned on, and the choice is kept', async () => {
  const dir = scratch();
  try {
    const log = new DevLog();
    log.event('request', { path: '/api/state' });
    log.set(true);
    assert.equal(existsSync(join(dir, 'logging.json')), false, 'not set up: no file anywhere');
    log.init(dir);
    log.event('request', { path: '/api/state' });
    await log.settled();
    assert.equal(existsSync(join(dir, 'logs')), false, 'off by default');
    log.set(true);
    log.event('request', { path: '/api/state' });
    await log.settled();
    const today = join(dir, 'logs', dayOf(new Date()), 'server.jsonl');
    assert.deepEqual(lines(today).map((l) => [l.kind, l.path]), [['logging', undefined], ['request', '/api/state']]);
    const again = new DevLog();
    again.init(dir);
    assert.equal(again.enabled, true);
    again.set(false);
    again.event('request', { path: '/api/after' });
    await again.settled();
    assert.equal(lines(today).at(-1).kind, 'logging');
    assert.equal(lines(today).at(-1).on, false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('each day writes to its own folder, and folders past the last three go', async () => {
  const dir = scratch();
  try {
    let now = new Date(2026, 10, 20, 23, 59, 59);
    const log = new DevLog(() => now);
    mkdirSync(join(dir, 'logs', '2026-11-17'), { recursive: true });
    mkdirSync(join(dir, 'logs', '2026-11-18'), { recursive: true });
    mkdirSync(join(dir, 'logs', 'keep-me'), { recursive: true });
    log.init(dir);
    log.set(true);
    log.event('one');
    now = new Date(2026, 10, 21, 0, 0, 1);
    log.event('two');
    await log.settled();
    await log.prune();
    assert.deepEqual(lines(join(dir, 'logs', '2026-11-20', 'server.jsonl')).map((l) => l.kind), ['logging', 'one']);
    assert.deepEqual(lines(join(dir, 'logs', '2026-11-21', 'server.jsonl')).map((l) => l.kind), ['two']);
    assert.equal(existsSync(join(dir, 'logs', '2026-11-18')), false);
    assert.equal(existsSync(join(dir, 'logs', '2026-11-19')), false);
    assert.equal(existsSync(join(dir, 'logs', 'keep-me')), true, 'only day folders are ever deleted');
    const status = await log.status();
    assert.deepEqual(status.days.map((d) => d.day), ['2026-11-21', '2026-11-20']);
    assert.equal(status.keepDays, 3);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a run says how the one before it ended', async () => {
  const dir = scratch();
  try {
    const first = new DevLog();
    first.init(dir);
    first.set(true);
    first.started({ port: 1 });
    await first.settled();
    const second = new DevLog();
    second.init(dir);
    second.started({ port: 2 });
    second.stopping('SIGTERM');
    const third = new DevLog();
    third.init(dir);
    third.started({ port: 3 });
    await third.settled();
    const starts = lines(join(dir, 'logs', dayOf(new Date()), 'server.jsonl')).filter((l) => l.kind === 'start');
    assert.equal(starts[0].previous, null);
    assert.match(starts[1].previous.ended, /without shutting down/);
    assert.equal(starts[2].previous.ended, 'cleanly');
    assert.equal(starts[2].previous.signal, 'SIGTERM');
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("a device's bundle is kept in today's folder even with the host's log off", async () => {
  const dir = scratch();
  try {
    const log = new DevLog(() => new Date(2026, 10, 22, 9, 5, 7));
    log.init(dir);
    const info = clientInfo({ app: 'ios', device: 'iPhone 17', version: '1.4', build: '72' });
    const a = await log.saveClient(info, [{ at: 'x', kind: 'request', path: '/api/state' }], 'send got lost', 'owner@example.com');
    const b = await log.saveClient(info, [], '', 'local');
    assert.equal(a, join(dir, 'logs', '2026-11-22', 'client-090507-ios-iPhone-17.jsonl'));
    assert.equal(b, join(dir, 'logs', '2026-11-22', 'client-090507-ios-iPhone-17-2.jsonl'));
    const [header, entry] = lines(a);
    assert.equal(header.kind, 'bundle');
    assert.equal(header.note, 'send got lost');
    assert.equal(header.entries, 1);
    assert.equal(header.device, 'iPhone 17');
    assert.equal(entry.path, '/api/state');
    assert.equal(existsSync(join(dir, 'logs', '2026-11-22', 'server.jsonl')), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
