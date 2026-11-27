import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, until } from './helpers.ts';

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const FAKE_MUSE = fileURLToPath(new URL('./fixtures/fake-muse.js', import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

test('fork end to end: copied transcript, own worktree, lineage, honest refusals', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-fork-it-'));
  const repo = join(dir, 'files', 'proj');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first');

  // A Claude conversation whose home is the repo, plus one in a non-git folder.
  const id1 = '11111111-2222-3333-4444-555555555555';
  const bucket = join(dir, 'claude', 'projects', encode(repo));
  mkdirSync(bucket, { recursive: true });
  const srcFile = join(bucket, `${id1}.jsonl`);
  const srcText = [
    '{"type":"mode","sessionId":"' + id1 + '"}',
    `{"type":"user","isSidechain":false,"cwd":"${repo}","sessionId":"${id1}","message":{"role":"user","content":"fix the thing"}}`,
    `{"type":"ai-title","aiTitle":"Fix the thing","sessionId":"${id1}"}`,
    '',
  ].join('\n');
  writeFileSync(srcFile, srcText);
  const looseId = '22222222-3333-4444-5555-666666666666';
  const looseBucket = join(dir, 'claude', 'projects', encode(join(dir, 'files')));
  mkdirSync(looseBucket, { recursive: true });
  writeFileSync(
    join(looseBucket, `${looseId}.jsonl`),
    [
      `{"type":"user","isSidechain":false,"cwd":"${join(dir, 'files')}","sessionId":"${looseId}","message":{"role":"user","content":"loose notes session"}}`,
      '',
    ].join('\n'),
  );

  const ah = await startAh(
    {
      auth: { mode: 'off' },
      idleAfter: 1,
      presets: [
        { id: 'claude', name: 'Claude Code', command: 'cat', resume: 'cat', resumeId: 'cat', feed: 'claude', match: '^cat$' },
        { id: 'shell', name: 'Shell', command: '' },
      ],
    },
    dir,
  );
  try {
    // Bring the parent up from discovery, the way History resume does.
    const resumed = await http(ah, 'POST', `/api/sessions/claude:${id1}/resume`);
    assert.equal(resumed.status, 201, resumed.body);
    const parentUid = resumed.json().uid as string;
    const parentId = resumed.json().id as string;

    const info = await http(ah, 'GET', `/api/sessions/${parentUid}/fork-info`);
    assert.equal(info.status, 200, info.body);
    assert.equal(info.json().canFork, true, info.body);
    assert.equal(info.json().dirty, 0);
    assert.ok(info.json().head, 'base commit reported');

    // An uncommitted parent change is reported, and the fork still bases on the commit.
    writeFileSync(join(repo, 'dirty.txt'), 'uncommitted\n');
    const info2 = await http(ah, 'GET', `/api/sessions/${parentUid}/fork-info`);
    assert.ok(info2.json().dirty >= 1, info2.body);

    const worktreesBefore = git(repo, 'worktree', 'list', '--porcelain');
    const invalid = await http(ah, 'POST', `/api/sessions/${parentUid}/fork`, { body: { mode: 'invalid-mode' } });
    assert.equal(invalid.status, 400, invalid.body);
    assert.equal(git(repo, 'worktree', 'list', '--porcelain'), worktreesBefore, 'invalid launch selection leaves no worktree');

    // Resuming starts a real process; fork only after startup has become quiet.
    // A fast runner can otherwise reach this request while cat is still starting.
    await until(async () => {
      const state = (await http(ah, 'GET', '/api/state')).json();
      const parent = state.windows.find((w: any) => w.uid === parentUid);
      return parent && ['idle', 'attention'].includes(parent.status);
    }, 15000, 'resumed parent ready to fork');
    const forked = await http(ah, 'POST', `/api/sessions/${parentUid}/fork`, { body: { name: 'proj risky', prompt: 'try the risky approach' } });
    assert.equal(forked.status, 201, forked.body);
    const out = forked.json();
    assert.match(out.branch, /^ah\/proj-risky-/);
    assert.notEqual(out.harnessId, id1);
    assert.ok(existsSync(join(out.worktree, 'a.txt')), 'worktree checked out');
    assert.equal(git(out.worktree, 'branch', '--show-current').trim(), out.branch);
    assert.ok(!existsSync(join(out.worktree, 'dirty.txt')), 'fork starts from the last commit, not the dirty tree');

    // The copied transcript lives in the worktree's bucket, re-ided and re-homed.
    const copyFile = join(dir, 'claude', 'projects', encode(out.worktree), `${out.harnessId}.jsonl`);
    assert.ok(existsSync(copyFile), copyFile);
    const copy = readFileSync(copyFile, 'utf8');
    assert.ok(copy.includes(`"sessionId":"${out.harnessId}"`), copy);
    assert.ok(copy.includes(`"cwd":"${out.worktree}"`), copy);
    assert.ok(!copy.includes(id1), 'no line still points at the parent conversation');
    assert.equal(readFileSync(srcFile, 'utf8'), srcText, 'parent transcript untouched');

    // Lineage shows on both windows.
    const state = await until(async () => {
      const s = (await http(ah, 'GET', '/api/state')).json();
      const p = s.windows.find((w: any) => w.uid === parentUid);
      const f = s.windows.find((w: any) => w.uid === out.uid);
      return p?.fork?.forks === 1 && f?.fork ? s : null;
    }, 10000, 'fork lineage in state');
    const forkWin = state.windows.find((w: any) => w.uid === out.uid);
    assert.equal(forkWin.fork.parentUid, parentUid);
    assert.equal(forkWin.fork.parentTitle, 'Fix the thing');
    assert.equal(forkWin.cwd, out.worktree);

    // The prompt is delivered to the fork (queued while it starts, then typed in).
    assert.ok(['queued', 'delivered'].includes(out.prompt), 'first prompt uses the normal send path');
    await until(() => ah.tmux('capture-pane', '-p', '-t', out.id).includes('try the risky approach'), 15000, 'prompt delivered to fork');

    // Worktree isolation: a file written in the fork does not dirty the parent checkout.
    const before = git(repo, 'status', '--porcelain').split('\n').filter(Boolean).length;
    writeFileSync(join(out.worktree, 'fork-only.txt'), 'fork\n');
    assert.equal(git(repo, 'status', '--porcelain').split('\n').filter(Boolean).length, before);

    // Shell sessions refuse honestly and create nothing.
    const shell = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: repo } });
    assert.equal(shell.status, 201, shell.body);
    const beforeState = await until(async () => {
      const state = (await http(ah, 'GET', '/api/state')).json();
      return state.windows.some((w: any) => w.uid === shell.json().uid) ? state : null;
    }, 10000, 'shell present in state');
    const countBefore = beforeState.windows.length;
    const shellFork = await http(ah, 'POST', `/api/sessions/${shell.json().uid}/fork`, { body: {} });
    assert.equal(shellFork.status, 422, shellFork.body);
    assert.match(shellFork.json().error, /shell sessions have no conversation/);
    assert.equal((await http(ah, 'GET', '/api/state')).json().windows.length, countBefore);

    // A conversation outside a git repo refuses too.
    const loose = await http(ah, 'POST', `/api/sessions/claude:${looseId}/resume`);
    assert.equal(loose.status, 201, loose.body);
    const looseFork = await http(ah, 'POST', `/api/sessions/${loose.json().uid}/fork`, { body: {} });
    assert.equal(looseFork.status, 422, looseFork.body);
    assert.match(looseFork.json().error, /git repository/);

    // The parent is still alive and untouched at the end of all this.
    const parentNow = (await http(ah, 'GET', '/api/state')).json().windows.find((w: any) => w.uid === parentUid);
    assert.ok(parentNow, 'parent still running');
    assert.equal(parentNow.id, parentId);
  } finally {
    await cleanup(ah);
  }
});

test("a Muse fork follows the conversation Muse makes of the copy, not the copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-fork-it-'));
  const repo = join(dir, 'files', 'proj');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first');
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  copyFileSync(FAKE_MUSE, join(bin, 'muse'));
  chmodSync(join(bin, 'muse'), 0o755);

  // A conversation Muse had in the repo, in its own store (the test host's XDG_DATA_HOME).
  const parentId = '01a2b3c4-0000-7000-8000-000000000001';
  const sessions = join(dir, 'data', 'muse', 'sessions');
  const parentDir = join(sessions, '2026', '11', '01', parentId);
  mkdirSync(parentDir, { recursive: true });
  const env = (seq: number, payload_type: string, payload: unknown) => JSON.stringify({ schema_version: 1, id: `e${seq}`, stream: { kind: 'session', id: parentId }, sequence: seq, recorded_at: 1795000000000000 + seq, payload_type, payload });
  writeFileSync(
    join(parentDir, 'session.jsonl'),
    [env(1, 'runtime.session.metadata', { record: { workspace_root: repo } }), env(2, 'runtime.session', { kind: 'run', event: { kind: 'started', prompt: 'Fix the login redirect' } }), env(3, 'runtime.session', { kind: 'run', event: { kind: 'assistant_message_committed', text: 'Fixed the redirect.' } }), ''].join('\n'),
  );
  writeFileSync(join(parentDir, 'session.peer-history.index'), '');

  const ah = await startAh(
    {
      auth: { mode: 'off' },
      idleAfter: 1,
      presets: [{ id: 'muse', name: 'Muse', command: `${bin}/muse`, resume: `${bin}/muse resume --last`, resumeId: `${bin}/muse resume {id}`, feed: 'muse', match: '^muse$' }],
    },
    dir,
  );
  try {
    const windows = async () => (await http(ah, 'GET', '/api/state')).json().windows as any[];
    const resumed = await http(ah, 'POST', `/api/sessions/muse:${parentId}/resume`);
    assert.equal(resumed.status, 201, resumed.body);
    const parentUid = resumed.json().uid as string;
    // Its own session: resumed under its id, not recovered into another.
    const parent = await until(async () => {
      const w = (await windows()).find((w) => w.uid === parentUid);
      return w?.agent === 'muse' && ['idle', 'attention'].includes(w.status) && w;
    }, 15000, 'the parent up');
    assert.equal(parent.harnessId, parentId);
    assert.match(ah.tmux('capture-pane', '-p', '-J', '-t', parent.id), /READY muse 01a2b3c4-0000-7000-8000-000000000001\s*$/m);

    const forked = await http(ah, 'POST', `/api/sessions/${parentUid}/fork`, { body: { name: 'proj again' } });
    assert.equal(forked.status, 201, forked.body);
    const out = forked.json();
    assert.equal(out.harnessId, '', "the fork's conversation is the one Muse makes: none to name yet");
    // Muse opened ah's copy as a conversation of its own, with a new id (its "recovery").
    const recovered = await until(() => ah.tmux('capture-pane', '-p', '-J', '-t', out.id).match(/READY muse (\S+) recovered (\S+)/), 15000, 'Muse up on the copy');
    const copyId = recovered[2];
    const newId = recovered[1];
    // The copy, in Muse's layout, homed in the worktree: what Muse was given to open.
    const copies = readdirSync(sessions, { recursive: true }).map(String).filter((f) => f.endsWith(`${copyId}/session.jsonl`));
    assert.equal(copies.length, 1, copies.join(', '));
    const copy = readFileSync(join(sessions, copies[0]), 'utf8');
    assert.ok(copy.includes(`"workspace_root":"${out.worktree}"`), copy.slice(0, 300));
    assert.ok(!copy.includes(parentId), 'the copy is under its own id');
    assert.notEqual(copyId, parentId);
    assert.notEqual(newId, copyId);
    assert.notEqual(newId, parentId);
    // The fork follows that one, never the copy it was given (which no session owns).
    const fork = await until(async () => {
      const w = (await windows()).find((w) => w.uid === out.uid);
      return w?.harnessId && w;
    }, 15000, 'the fork adopted a conversation');
    assert.equal(fork.harnessId, newId, `adopted Muse's own conversation, not the copy ${copyId}`);
    assert.equal((await windows()).find((w) => w.uid === parentUid)?.harnessId, parentId, 'the parent keeps its own');
    // Its chat is that conversation: the copied history, recovered, is in it.
    const feed = async (uid: string) => ((await http(ah, 'GET', `/api/sessions/${uid}/feed`)).json().entries ?? []) as any[];
    const texts = (entries: any[], role: string) => entries.filter((e) => e.role === role).flatMap((e) => e.parts.filter((p: any) => p.type === 'text').map((p: any) => p.text));
    assert.deepEqual(texts(await feed(out.uid), 'user'), ['Fix the login redirect']);

    // A message to the fork reaches the conversation Muse writes and is confirmed there.
    await until(async () => ['idle', 'attention'].includes((await windows()).find((w) => w.uid === out.uid)?.status), 15000, 'the fork idle');
    const sent = await http(ah, 'POST', `/api/sessions/${out.uid}/send`, { body: { text: 'try the risky approach' } });
    assert.equal(sent.status, 200, sent.body);
    await until(async () => texts(await feed(out.uid), 'assistant').includes('Got: try the risky approach'), 15000, 'the reply in the fork\'s conversation');
    assert.deepEqual(texts(await feed(out.uid), 'user'), ['Fix the login redirect', 'try the risky approach'], 'in its conversation, once');
    // Confirmed from that conversation: never typed again, never shown as not sent.
    await until(async () => {
      const w = (await windows()).find((w) => w.uid === out.uid);
      return w && !w.queued && ['idle', 'attention'].includes(w.status) && w;
    }, 20000, 'settled');
    await new Promise((r) => setTimeout(r, 1500));
    const after = (await windows()).find((w) => w.uid === out.uid);
    assert.equal(after.unsent, 0, 'not shown as not sent');
    assert.equal(after.queued, 0);
    assert.equal((await feed(out.uid)).filter((e) => e.role === 'user' && e.parts.some((p: any) => p.text === 'try the risky approach')).length, 1, 'typed once');
    assert.deepEqual(texts(await feed(parentUid), 'user'), ['Fix the login redirect'], "the parent's conversation is untouched");
  } finally {
    await cleanup(ah);
  }
});
