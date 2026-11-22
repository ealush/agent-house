import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAh, cleanup, http, until } from './helpers.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('checkouts end-to-end: automatic isolation, exclusive ownership, overlap, merge-tree check, GC and resume recreation', async () => {
  const ah = await startAh({
    auth: { mode: 'off' },
    idleAfter: 1,
    presets: [
      { id: 'fake-agent', name: 'Fake Agent', command: 'cat', resume: 'cat', resumeId: 'cat', match: '^cat$' },
      { id: 'shell', name: 'Shell', command: '' },
    ],
  });
  try {
    const repo = join(ah.dir, 'files', 'demo-repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    writeFileSync(join(repo, 'app.ts'), 'export const v = 1;\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-qm', 'init');

    // /api/dir reports git + hasHead for the repo
    const dirInfo = await http(ah, 'GET', `/api/dir?path=${encodeURIComponent(repo)}`);
    assert.equal(dirInfo.status, 200);
    assert.equal(dirInfo.json().git, true);
    assert.equal(dirInfo.json().hasHead, true);

    // 1. Launching two coding agents in the repo without specifying `worktree` auto-isolates both
    const a1 = await http(ah, 'POST', '/api/windows', { body: { preset: 'fake-agent', cwd: repo, label: 'Auth' } });
    assert.equal(a1.status, 201, a1.body);
    const out1 = a1.json();
    assert.ok(out1.checkoutId && out1.worktree && out1.branch, a1.body);

    const a2 = await http(ah, 'POST', '/api/windows', { body: { preset: 'fake-agent', cwd: repo, label: 'Voice' } });
    assert.equal(a2.status, 201, a2.body);
    const out2 = a2.json();
    assert.ok(out2.checkoutId && out2.worktree && out2.worktree !== out1.worktree, a2.body);

    // Wait for both sessions to appear in state
    await until(async () => {
      const s = (await http(ah, 'GET', '/api/state')).json();
      return s.windows.some((w: { uid: string }) => w.uid === out1.uid) && s.windows.some((w: { uid: string }) => w.uid === out2.uid);
    }, 10000, 'both isolated sessions live');

    // 2. The main checkout is shared (worktree: false): a second writer there is let in, and listed.
    const m1 = await http(ah, 'POST', '/api/windows', { body: { preset: 'fake-agent', cwd: repo, label: 'Main1', worktree: false } });
    assert.equal(m1.status, 201, m1.body);
    await until(async () => (await http(ah, 'GET', '/api/state')).json().windows.some((w: { uid: string }) => w.uid === m1.json().uid), 10000, 'main session live');
    const m2 = await http(ah, 'POST', '/api/windows', { body: { preset: 'fake-agent', cwd: repo, label: 'Main2', worktree: false } });
    assert.equal(m2.status, 201, m2.body);

    // A worktree has one writer: a new launch into a1's is refused with who owns it.
    const intruder = await http(ah, 'POST', '/api/windows', { body: { preset: 'fake-agent', cwd: out1.worktree, label: 'Intruder', worktree: false } });
    assert.equal(intruder.status, 409, intruder.body);
    assert.equal(intruder.json().code, 'checkout_owned');

    // A plain shell observer in an owned worktree is allowed
    const sh = await http(ah, 'POST', '/api/windows', { body: { preset: 'shell', cwd: out1.worktree, label: 'Inspect' } });
    assert.equal(sh.status, 201, sh.body);

    // 3. Pairwise overlap detection + non-destructive merge-tree compatibility check
    writeFileSync(join(out1.worktree, 'app.ts'), 'export const v = 2;\n');
    git(out1.worktree, 'add', 'app.ts');
    git(out1.worktree, 'commit', '-qm', 'auth change');

    writeFileSync(join(out2.worktree, 'app.ts'), 'export const v = 3;\n');
    git(out2.worktree, 'add', 'app.ts');
    git(out2.worktree, 'commit', '-qm', 'voice change');

    const list = await http(ah, 'GET', `/api/checkouts?repo=${encodeURIComponent(repo)}`);
    assert.equal(list.status, 200, list.body);
    const overview = list.json();
    assert.equal(overview.repositories.length, 1);
    assert.equal(overview.repositories[0].overlapCount, 1);
    const c1 = overview.checkouts.find((c: { id: string }) => c.id === out1.checkoutId);
    assert.ok(c1.ports && c1.ports.start >= 41000);
    assert.equal(c1.overlaps.length, 1);
    assert.deepEqual(c1.overlaps[0].files, ['app.ts']);

    // Check clean merge against trunk first
    const cleanCheck = await http(ah, 'POST', `/api/checkouts/${out1.checkoutId}/check`, { body: {} });
    assert.equal(cleanCheck.status, 200, cleanCheck.body);
    assert.equal(cleanCheck.json().integration.clean, true);

    // Pin toggle works
    const pinned = await http(ah, 'POST', `/api/checkouts/${out1.checkoutId}/pin`, { body: { pinned: true } });
    assert.equal(pinned.status, 200, pinned.body);
    assert.equal(pinned.json().pinned, true);
    const unpinned = await http(ah, 'POST', `/api/checkouts/${out1.checkoutId}/pin`, { body: { pinned: false } });
    assert.equal(unpinned.status, 200);
    assert.equal(unpinned.json().pinned, false);

    // 4. End session a1, remove its worktree checkout (preserving branch), then resume recreates it!
    const term = await http(ah, 'POST', `/api/sessions/${out1.uid}/terminate`);
    assert.equal(term.status, 200, `terminate failed: ${term.body}`);
    await until(async () => !(await http(ah, 'GET', '/api/state')).json().windows.some((w: { uid: string }) => w.uid === out1.uid), 10000, 'a1 ended');

    const shTerm = await http(ah, 'POST', `/api/sessions/${sh.json().uid}/terminate`);
    assert.equal(shTerm.status, 200, shTerm.body);
    await until(async () => !(await http(ah, 'GET', '/api/state')).json().windows.some((w: { uid: string }) => w.uid === sh.json().uid), 10000, 'shell ended');
    const removed = await http(ah, 'DELETE', `/api/checkouts/${out1.checkoutId}`);
    assert.equal(removed.status, 200, `remove failed: ${removed.body}`);
    assert.equal(existsSync(out1.worktree), false, 'worktree removed on disk');

    // Resuming a1 recreates its worktree at the exact original path instead of falling back to ~
    const resumed = await http(ah, 'POST', `/api/sessions/${out1.uid}/resume`);
    assert.equal(resumed.status, 201, resumed.body);
    assert.equal(existsSync(out1.worktree), true, 'resume recreated the worktree');
    assert.equal(existsSync(join(out1.worktree, 'app.ts')), true);

    // Dry-run GC endpoint works
    const gcDry = await http(ah, 'POST', '/api/checkouts/gc', { body: { dryRun: true } });
    assert.equal(gcDry.status, 200, gcDry.body);
    assert.equal(gcDry.json().dryRun, true);
  } finally {
    await cleanup(ah);
  }
});
