// Update from GitHub (server/update.ts), against real repositories: a bare "GitHub", a clone
// that publishes to it, and the host's checkout. Only a clean main moves, only forward, only
// to a main that serves what the client needs, and a failed build puts it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyUpdate, checkUpdate, hostVersion, missingFeatures, parseRequires, UpdateError } from '../server/update.ts';

const API = 28;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim();
}

/** Commit a versions.json announcing `features` (and `api`) from `dir`, and push it to GitHub's main. */
function publish(dir: string, features: Record<string, number>, message: string, api = API): string {
  mkdirSync(join(dir, 'packages/protocol'), { recursive: true });
  writeFileSync(join(dir, 'packages/protocol/versions.json'), JSON.stringify({ api, features }, null, 2));
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', message);
  git(dir, 'push', '--quiet', 'origin', 'main');
  return git(dir, 'rev-parse', 'HEAD');
}

function world() {
  const base = mkdtempSync(join(tmpdir(), 'ah-update-'));
  const github = join(base, 'github.git');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', github]);
  const dev = join(base, 'dev');
  execFileSync('git', ['clone', '--quiet', github, dev]);
  git(dev, 'checkout', '--quiet', '-b', 'main');
  const first = publish(dev, { capabilities: 1 }, 'first');
  const host = join(base, 'host');
  execFileSync('git', ['clone', '--quiet', github, host]);
  return { base, github, dev, host, first };
}

function recorder(fail?: (n: number) => boolean) {
  const runs: string[] = [];
  const build = async (repo: string) => {
    runs.push(git(repo, 'rev-parse', 'HEAD'));
    if (fail?.(runs.length)) throw Object.assign(new Error('Command failed: pnpm build'), { stderr: 'build-broke' });
  };
  return { runs, build };
}

test('the host says its commit, branch, whether it is clean, and the app releases it contains', async () => {
  const w = world();
  git(w.dev, 'tag', 'ios/v1.9');
  git(w.dev, 'tag', 'ios/v1.10');
  git(w.dev, 'tag', 'ios/v1.0');
  git(w.dev, 'push', '--quiet', 'origin', '--tags');
  const later = publish(w.dev, { capabilities: 1, notes: 1 }, 'later');
  git(w.dev, 'tag', 'ios/v2.0');
  git(w.dev, 'push', '--quiet', 'origin', '--tags');
  git(w.host, 'fetch', '--quiet', '--tags');
  const v = await hostVersion(w.host);
  assert.equal(v.commit, w.first);
  assert.equal(v.branch, 'main');
  assert.equal(v.subject, 'first');
  assert.equal(v.clean, true);
  assert.ok(!Number.isNaN(Date.parse(v.committedAt)));
  // ios/v2.0 is on a commit the host doesn't have yet.
  assert.deepEqual(v.appReleases, ['1.0', '1.9', '1.10']);
  git(w.host, 'merge', '--quiet', '--ff-only', later);
  assert.deepEqual((await hostVersion(w.host)).appReleases, ['1.0', '1.9', '1.10', '2.0']);
  writeFileSync(join(w.host, 'packages/protocol/versions.json'), '{}');
  assert.equal((await hostVersion(w.host)).clean, false);
});

test('a check fetches GitHub and says how far behind, and what the newest main lacks', async () => {
  const w = world();
  const second = publish(w.dev, { capabilities: 1, notes: 2 }, 'notes 2');
  const check = await checkUpdate(w.host, { notes: 2 }, API);
  assert.equal(check.current.commit, w.first);
  assert.equal(check.target.commit, second);
  assert.equal(check.target.subject, 'notes 2');
  assert.equal(check.behind, 1);
  assert.deepEqual(check.missing, []);
  assert.equal(check.blocked, undefined);
  // Moves nothing.
  assert.equal(git(w.host, 'rev-parse', 'HEAD'), w.first);

  const ahead = await checkUpdate(w.host, { notes: 3, spaces: 1 }, API);
  assert.deepEqual(ahead.missing, ['notes 3', 'spaces 1']);
});

test('an update fast-forwards to GitHub, builds what it moved to, and says so', async () => {
  const w = world();
  const second = publish(w.dev, { capabilities: 1, notes: 2 }, 'notes 2');
  const { runs, build } = recorder();
  const result = await applyUpdate(w.host, { notes: 2 }, API, build);
  assert.deepEqual(result, { updated: true, from: w.first, to: second });
  assert.equal(git(w.host, 'rev-parse', 'HEAD'), second);
  assert.deepEqual(runs, [second]);
});

test('already on the newest main: nothing moves and nothing builds', async () => {
  const w = world();
  const { runs, build } = recorder();
  const result = await applyUpdate(w.host, { capabilities: 1 }, API, build);
  assert.deepEqual(result, { updated: false, from: w.first, to: w.first });
  assert.deepEqual(runs, []);
});

test('a main that would not serve the app is refused, and the checkout stays', async () => {
  const w = world();
  publish(w.dev, { capabilities: 1 }, 'still no notes');
  const { runs, build } = recorder();
  await assert.rejects(applyUpdate(w.host, { notes: 1 }, API, build), (err: UpdateError) => err.status === 409 && err.code === 'no_matching_server' && /notes 1/.test(err.message));
  assert.equal(git(w.host, 'rev-parse', 'HEAD'), w.first);
  assert.deepEqual(runs, []);
});

test('a main whose API differs from what installed apps accept is refused', async () => {
  const w = world();
  publish(w.dev, { capabilities: 1 }, 'api 29', 29);
  const { build } = recorder();
  await assert.rejects(applyUpdate(w.host, {}, API, build), (err: UpdateError) => err.code === 'no_matching_server' && /api 28/.test(err.message));
  assert.equal(git(w.host, 'rev-parse', 'HEAD'), w.first);
});

test('local changes, another branch, or commits GitHub lacks are the owner’s: refused, nothing moves', async () => {
  const w = world();
  publish(w.dev, { capabilities: 1, notes: 1 }, 'second');
  const { runs, build } = recorder();

  writeFileSync(join(w.host, 'packages/protocol/versions.json'), '{"edited": true}');
  await assert.rejects(applyUpdate(w.host, {}, API, build), (err: UpdateError) => err.code === 'local_changes');
  git(w.host, 'checkout', '--quiet', '--', '.');

  git(w.host, 'checkout', '--quiet', '-b', 'mine');
  await assert.rejects(applyUpdate(w.host, {}, API, build), (err: UpdateError) => err.code === 'not_main' && /branch mine/.test(err.message));
  git(w.host, 'checkout', '--quiet', 'main');

  writeFileSync(join(w.host, 'local.txt'), 'mine');
  git(w.host, 'add', 'local.txt');
  git(w.host, 'commit', '--quiet', '-m', 'local only');
  const local = git(w.host, 'rev-parse', 'HEAD');
  await assert.rejects(applyUpdate(w.host, {}, API, build), (err: UpdateError) => err.code === 'diverged' && /1 commit /.test(err.message));
  assert.equal(git(w.host, 'rev-parse', 'HEAD'), local);
  assert.deepEqual(runs, []);
});

test('a failed build puts the checkout back and builds what it ran before', async () => {
  const w = world();
  publish(w.dev, { capabilities: 1, notes: 1 }, 'broken build');
  const { runs, build } = recorder((n) => n === 1);
  await assert.rejects(applyUpdate(w.host, {}, API, build), /pnpm build/);
  assert.equal(git(w.host, 'rev-parse', 'HEAD'), w.first);
  assert.equal(git(w.host, 'status', '--porcelain'), '');
  assert.equal(runs.length, 2);
  assert.equal(runs[1], w.first);
});

test('GitHub out of reach is said as such', async () => {
  const w = world();
  git(w.host, 'remote', 'set-url', 'origin', join(w.base, 'gone.git'));
  await assert.rejects(checkUpdate(w.host, {}, API), (err: UpdateError) => err.status === 502 && err.code === 'fetch_failed');
});

test('requires is feature names to whole versions; missing features are listed by name', () => {
  assert.deepEqual(parseRequires(undefined), {});
  assert.deepEqual(parseRequires({ notes: 2, spaces: 3 }), { notes: 2, spaces: 3 });
  for (const bad of [[], 'notes', { notes: 0 }, { notes: 1.5 }, { 'no-dash': 1 }, { notes: '2' }]) {
    assert.throws(() => parseRequires(bad), (err: UpdateError) => err.status === 400, JSON.stringify(bad));
  }
  assert.deepEqual(missingFeatures({ notes: 2, spaces: 1, jobs: 1 }, { features: { notes: 1, jobs: 2 } }), ['notes 2', 'spaces 1']);
  assert.deepEqual(missingFeatures({ notes: 1 }, {}), ['notes 1']);
});
