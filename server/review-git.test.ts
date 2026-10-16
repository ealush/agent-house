import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diff, diffStat, fetchStack, patchId, pin, prRef, branchRef, remoteFor, resolve, showAt, sinceReview, unpinStack, mergeBase } from './review/git.ts';
import { defaultOrder, descendants, forest, planRoles, subtree, validOrder } from './review/stack.ts';
import { mergePr, rollup, listPrs, GhError } from './review/gh.ts';

// A "GitHub" (bare repo with refs/pull/<n>/head) and a local clone of it.
async function world() {
  const parent = await mkdtemp(join(tmpdir(), 'ah-review-'));
  const remote = join(parent, 'remote.git');
  const work = join(parent, 'work');
  const local = join(parent, 'local');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'pipe' });
  const g = (...a: string[]) => execFileSync('git', ['-C', work, ...a], { stdio: 'pipe' }).toString().trim();
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('checkout', '-q', '-b', 'main');
  await writeFile(join(work, 'a.txt'), 'one\ntwo\nthree\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  g('push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remote, local], { stdio: 'pipe' });
  const commit = async (file: string, text: string, msg: string) => {
    await writeFile(join(work, file), text);
    g('add', '.');
    g('commit', '-qm', msg);
    return g('rev-parse', 'HEAD');
  };
  // Publish a branch and its PR ref, as GitHub would.
  const publish = (branch: string, n: number) => {
    g('push', '-q', '-f', 'origin', `${branch}:refs/heads/${branch}`);
    g('push', '-q', '-f', 'origin', `${branch}:refs/pull/${n}/head`);
  };
  return { remote, work, local, g, commit, publish };
}

test('fetchStack pins PR heads and branches without touching the checkout; patch-id survives a rebase', async () => {
  const w = await world();
  w.g('checkout', '-q', '-b', 'f1');
  const f1 = await w.commit('b.txt', 'b\n', 'f1');
  w.publish('f1', 1);
  w.g('checkout', '-q', '-b', 'f2');
  const f2 = await w.commit('c.txt', 'c\n', 'f2');
  w.publish('f2', 2);

  const localHead = execFileSync('git', ['-C', w.local, 'rev-parse', 'HEAD']).toString().trim();
  assert.equal(await remoteFor(w.local, 'someone/else'), 'origin');
  const r = await fetchStack(w.local, 'origin', 's1', [1, 2], ['main', 'f1', 'gone']);
  assert.deepEqual(r.failed, [branchRef('s1', 'gone')], 'a deleted branch fails alone');
  assert.equal(await resolve(w.local, prRef('s1', 2)), f2);
  assert.equal(await resolve(w.local, branchRef('s1', 'f1')), f1);
  assert.equal(execFileSync('git', ['-C', w.local, 'rev-parse', 'HEAD']).toString().trim(), localHead, 'the checkout did not move');
  assert.equal(execFileSync('git', ['-C', w.local, 'status', '--porcelain']).toString(), '');

  const base2 = (await mergeBase(w.local, f1, f2))!;
  assert.equal(base2, f1);
  const d = await diff(w.local, base2, f2);
  assert.match(d.patch, /^diff --git a\/c\.txt b\/c\.txt/m);
  assert.doesNotMatch(d.patch, /b\.txt/, "the layer's own patch only");
  assert.deepEqual(await diffStat(w.local, base2, f2), { files: 1, additions: 1, deletions: 0, paths: ['c.txt'] });
  const id = await patchId(w.local, base2, f2);
  assert.match(id, /^[0-9a-f]{40}$/);
  assert.equal(await patchId(w.local, f2, f2), 'empty');

  // Fix F1, then restack F2 on it: new SHAs, same F2 patch.
  await pin(w.local, 's1', 7, f2);
  w.g('checkout', '-q', 'f1');
  const f1b = await w.commit('b.txt', 'b fixed\n', 'f1 fix');
  w.publish('f1', 1);
  w.g('checkout', '-q', 'f2');
  w.g('rebase', '-q', 'f1');
  const f2b = w.g('rev-parse', 'HEAD');
  w.publish('f2', 2);
  await fetchStack(w.local, 'origin', 's1', [1, 2], ['f1']);
  assert.equal(await resolve(w.local, prRef('s1', 2)), f2b);
  assert.notEqual(f2b, f2);
  assert.equal(await patchId(w.local, f1b, f2b), id, 'rebased, same patch');
  assert.equal(await resolve(w.local, f2), f2, 'the pinned old revision is still here after the force-push');

  const since = await sinceReview(w.local, { base: base2, head: f2 }, { base: f1b, head: f2b });
  assert.equal(since.kind, 'range');
  assert.match(since.text, /=/, 'range-diff pairs the unchanged commit');

  // Same base, one more commit: a plain diff of the heads.
  const f2c = await w.commit('c.txt', 'c\nmore\n', 'f2 more');
  w.publish('f2', 2);
  await fetchStack(w.local, 'origin', 's1', [2], []);
  const plain = await sinceReview(w.local, { base: f1b, head: f2b }, { base: f1b, head: f2c });
  assert.equal(plain.kind, 'patch');
  assert.match(plain.text, /\+more/);

  assert.equal(await showAt(w.local, f2b, 'c.txt', 1000), 'c\n');
  assert.match(await showAt(w.local, f2b, 'nope.txt', 1000), /does not exist/);
  assert.match(await showAt(w.local, f2b, '../etc/passwd', 1000), /repo-relative/);

  await unpinStack(w.local, 's1');
  assert.equal(execFileSync('git', ['-C', w.local, 'for-each-ref', 'refs/ah-review/']).toString(), '');
});

type P = { number: number; headRefName: string; baseRefName: string };
// The Vest schema-relationships stack as GitHub listed it on 16 October 2026.
const vest: P[] = [
  { number: 1363, headRefName: 'fix/focused-complete-output', baseRefName: 'feat/relationships-baseline' },
  { number: 1360, headRefName: 'test/relationships-packed-consumers', baseRefName: 'docs/relationships-guide' },
  { number: 1359, headRefName: 'docs/relationships-guide', baseRefName: 'test/relationships-tanstack' },
  { number: 1358, headRefName: 'test/relationships-tanstack', baseRefName: 'feat/relationships-suite' },
  { number: 1357, headRefName: 'fix/schema-issues-message', baseRefName: 'feat/relationships-baseline' },
  { number: 1356, headRefName: 'fix/schema-only-validity', baseRefName: 'feat/relationships-baseline' },
  { number: 1355, headRefName: 'feat/relationships-suite', baseRefName: 'feat/relationships-planner' },
  { number: 1354, headRefName: 'feat/relationships-planner', baseRefName: 'feat/relationships-declaration' },
  { number: 1353, headRefName: 'feat/relationships-declaration', baseRefName: 'feat/relationships-baseline' },
  { number: 1352, headRefName: 'chore/bundle-baseline-refresh', baseRefName: 'latest' },
  { number: 1351, headRefName: 'feat/relationships-baseline', baseRefName: 'latest' },
];

test('stack: the Vest tree, its merge order, and descendants', () => {
  const roots = forest(vest);
  assert.deepEqual(roots.map((r) => r.pr.number), [1352, 1351], 'two roots on the trunk, newest first');
  const h0 = subtree(vest, 1351)!;
  assert.deepEqual(h0.children.map((c) => c.pr.number), [1353, 1356, 1357, 1363]);
  const order = defaultOrder(h0);
  assert.deepEqual(order, [1351, 1356, 1357, 1363, 1353, 1354, 1355, 1358, 1359, 1360], 'independent fixes before the long chain');
  const layers = vest.filter((p) => order.includes(p.number));
  assert.ok(validOrder(layers, order));
  assert.ok(!validOrder(layers, [1354, ...order.filter((n) => n !== 1354)]), 'F2 cannot come before F1');
  assert.ok(!validOrder(layers, order.slice(1)), 'every layer once');
  assert.deepEqual(descendants(layers, 1354, order), [1355, 1358, 1359, 1360]);
  assert.deepEqual(descendants(layers, 1356, order), []);
  assert.equal(subtree(vest, 9999), null);
  // A branch based on itself doesn't loop.
  assert.equal(forest([{ number: 1, headRefName: 'x', baseRefName: 'x' }]).length, 1);
});

test('stack: plan owner table gives role labels', () => {
  const plan = [
    '| Owner | PR | Responsibility | Base |',
    '| --- | --- | --- | --- |',
    '| H0 | #1351 | Fundamentals bundle baseline | latest |',
    '| Redundant H0 | #1352 | Same baseline proposal; do not merge both | latest |',
    '| F2 | [#1354](https://github.com/ealush/vest/pull/1354) | Pure planning | F1 |',
    'Prose mentioning #1353 is not a table.',
  ].join('\n');
  const roles = planRoles(plan);
  assert.equal(roles.get(1351), 'H0');
  assert.equal(roles.get(1352), 'Redundant H0');
  assert.equal(roles.get(1354), 'F2');
  assert.equal(roles.has(1353), false);
});

test('gh: check rollup counts runs and statuses', () => {
  const c = rollup([
    { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'bench', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'StatusContext', context: 'CodeRabbit', state: 'SUCCESS' },
    { __typename: 'StatusContext', context: 'Vercel', state: 'PENDING' },
  ]);
  assert.deepEqual(c, { pass: 2, fail: 1, pending: 2, failing: ['lint'] });
});

test('gh: merge passes --match-head-commit and never deletes the branch; errors read as gh said them', async () => {
  const bin = await mkdtemp(join(tmpdir(), 'ah-gh-'));
  const argsFile = join(bin, 'args');
  await writeFile(
    join(bin, 'gh'),
    `#!/bin/sh\necho "$@" >> "${argsFile}"\nif [ "$1" = "pr" ] && [ "$2" = "list" ]; then echo '[{"number":5,"title":"T","state":"OPEN","headRefName":"h","baseRefName":"main","headRefOid":"${'a'.repeat(40)}","statusCheckRollup":[],"author":{"login":"me"}}]'; exit 0; fi\nif [ "$AH_GH_FAIL" = "1" ]; then echo "X Head branch was modified. Review and try the merge again." >&2; exit 1; fi\n`,
  );
  await chmod(join(bin, 'gh'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  try {
    const sha = 'b'.repeat(40);
    await mergePr(bin, 5, 'merge', sha);
    const args = await readFile(argsFile, 'utf8');
    assert.match(args, new RegExp(`pr merge 5 --merge --match-head-commit ${sha}`));
    assert.doesNotMatch(args, /delete-branch/);
    await assert.rejects(mergePr(bin, 5, 'merge', 'short'), /full head commit/);
    process.env.AH_GH_FAIL = '1';
    await assert.rejects(mergePr(bin, 5, 'squash', sha), (e: Error) => e instanceof GhError && e.message === 'Head branch was modified. Review and try the merge again.');
    delete process.env.AH_GH_FAIL;
    const prs = await listPrs(bin);
    assert.equal(prs[0].number, 5);
    assert.equal(prs[0].author, 'me');
    assert.deepEqual(prs[0].checks, { pass: 0, fail: 0, pending: 0, failing: [] });
  } finally {
    process.env.PATH = saved;
    delete process.env.AH_GH_FAIL;
  }
});
