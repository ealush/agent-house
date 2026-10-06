import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, until } from './helpers.ts';

const encode = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
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
    const countBefore = (await http(ah, 'GET', '/api/state')).json().windows.length;
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
