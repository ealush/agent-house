// Settings → System → Update the host, through the routes: GET /api/system/version and
// POST /api/system/update move a disposable clone (AH_UPDATE_REPO) of a disposable "GitHub",
// build through AH_UPDATE_BUILD_CMD and restart through AH_RESTART_CMD, as system.test.ts
// stubs the rebuild's. The checkout running these tests is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

let ah: Ah;
let base: string;
let dev: string;
let host: string;
let first: string;
let restarted: string;
let builds: string;
let failFlag: string;

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], { encoding: 'utf8' }).trim();
}

function publish(features: Record<string, number>, message: string): string {
  mkdirSync(join(dev, 'packages/protocol'), { recursive: true });
  writeFileSync(join(dev, 'packages/protocol/versions.json'), JSON.stringify({ api: 28, features }));
  git(dev, 'add', '-A');
  git(dev, 'commit', '--quiet', '--allow-empty', '-m', message);
  git(dev, 'push', '--quiet', 'origin', 'main');
  return git(dev, 'rev-parse', 'HEAD');
}

before(async () => {
  base = mkdtempSync(join(tmpdir(), 'ah-system-update-'));
  const github = join(base, 'github.git');
  execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', github]);
  dev = join(base, 'dev');
  execFileSync('git', ['clone', '--quiet', github, dev]);
  git(dev, 'checkout', '--quiet', '-b', 'main');
  first = publish({ capabilities: 1 }, 'first');
  git(dev, 'tag', 'ios/v1.0');
  git(dev, 'push', '--quiet', 'origin', '--tags');
  host = join(base, 'host');
  execFileSync('git', ['clone', '--quiet', github, host]);
  restarted = join(base, 'restarted');
  builds = join(base, 'builds');
  failFlag = join(base, 'fail');
  process.env.AH_UPDATE_REPO = host;
  process.env.AH_RESTART_CMD = `touch ${restarted}`;
  process.env.AH_UPDATE_BUILD_CMD = `git rev-parse HEAD >> ${builds}; if [ -f ${failFlag} ]; then echo build-broke >&2; exit 1; fi`;
  ah = await startAh();
});
after(async () => {
  delete process.env.AH_UPDATE_REPO;
  delete process.env.AH_RESTART_CMD;
  delete process.env.AH_UPDATE_BUILD_CMD;
  await cleanup(ah);
  rmSync(base, { recursive: true, force: true });
});

const built = () => (existsSync(builds) ? readFileSync(builds, 'utf8').trim().split('\n') : []);

test('anonymous callers are refused: no version, nothing fetched, nothing moves', async () => {
  assert.equal((await http(ah, 'GET', '/api/system/version')).status, 401);
  const res = await http(ah, 'POST', '/api/system/update', { body: {} });
  assert.equal(res.status, 401);
  assert.equal(git(host, 'rev-parse', 'HEAD'), first);
});

test('the host announces serverUpdate', async () => {
  const hello = await http(ah, 'GET', '/api/hello');
  assert.equal(hello.json().features.serverUpdate, 1);
});

test('the version is the checkout’s commit, branch and app releases', async () => {
  const cookie = await signIn(ah);
  const res = await http(ah, 'GET', '/api/system/version', { cookie });
  assert.equal(res.status, 200);
  const v = res.json();
  assert.equal(v.api, 28);
  assert.equal(v.commit, first);
  assert.equal(v.branch, 'main');
  assert.equal(v.subject, 'first');
  assert.equal(v.clean, true);
  assert.deepEqual(v.appReleases, ['1.0']);
});

test('a check says what GitHub has and what it lacks, and moves nothing', async () => {
  const second = publish({ capabilities: 1, notes: 2 }, 'notes 2');
  const cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/system/update', { body: { check: true, requires: { notes: 2, spaces: 1 } }, cookie });
  assert.equal(res.status, 200);
  const check = res.json();
  assert.equal(check.target.commit, second);
  assert.equal(check.behind, 1);
  assert.deepEqual(check.missing, ['spaces 1']);
  assert.equal(git(host, 'rev-parse', 'HEAD'), first);
  assert.deepEqual(built(), []);
});

test('requires that are not whole versions are refused', async () => {
  const cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/system/update', { body: { requires: { notes: 'two' } }, cookie });
  assert.equal(res.status, 400);
});

test('an update GitHub can’t serve is refused with no_matching_server, and nothing restarts', async () => {
  const cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/system/update', { body: { requires: { spaces: 1 } }, cookie });
  assert.equal(res.status, 409);
  assert.equal(res.json().code, 'no_matching_server');
  assert.match(res.json().error, /spaces 1/);
  assert.equal(git(host, 'rev-parse', 'HEAD'), first);
  assert.ok(!existsSync(restarted));
});

test('a failed build answers with its log, and the checkout goes back to what runs', async () => {
  writeFileSync(failFlag, '1');
  try {
    const cookie = await signIn(ah);
    const res = await http(ah, 'POST', '/api/system/update', { body: { requires: { notes: 2 } }, cookie });
    assert.equal(res.status, 500);
    assert.equal(res.json().code, 'build_failed');
    assert.match(res.json().error, /build-broke/);
    assert.equal(git(host, 'rev-parse', 'HEAD'), first);
    // The new commit, then the old one again.
    assert.deepEqual(built().slice(-2), [git(dev, 'rev-parse', 'HEAD'), first]);
    assert.ok(!existsSync(restarted));
    assert.equal((await http(ah, 'GET', '/api/state', { cookie })).status, 200);
  } finally {
    unlinkSync(failFlag);
  }
});

test('an update moves to GitHub’s main, builds it, answers, then restarts', async () => {
  const target = git(dev, 'rev-parse', 'HEAD');
  const cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/system/update', { body: { requires: { notes: 2 } }, cookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json(), { ok: true, updated: true, from: first, to: target, restarting: true });
  assert.equal(git(host, 'rev-parse', 'HEAD'), target);
  assert.equal(built().at(-1), target);
  await until(() => existsSync(restarted), 8000, 'restart command');
});

test('already up to date: nothing builds and nothing restarts', async () => {
  unlinkSync(restarted);
  const before = built().length;
  const cookie = await signIn(ah);
  const res = await http(ah, 'POST', '/api/system/update', { body: { requires: { notes: 2 } }, cookie });
  assert.equal(res.status, 200);
  assert.equal(res.json().updated, false);
  assert.equal(res.json().restarting, false);
  assert.equal(built().length, before);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!existsSync(restarted));
});

test('the update is audited', async () => {
  const overview = await http(ah, 'GET', '/api/auth/overview', { token: ah.localToken() });
  assert.ok(overview.json().audit.some((a: { event: string }) => a.event === 'system.update'));
});
