// Moving a stopped session between hosts, black box (Workflow B): two ah daemons on
// one machine, "omarchy-a" and "mac-b", each with its own state, tmux and stand-in
// agents; the destination has sign-in on and trusts the source by a token it issued.
// The project lives at a different path on each (as on Linux and a Mac); the
// destination finds its checkout by the repository's origin.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, http, until, type Ah } from './helpers.ts';
import { fakePresets, hostPair, launch, say, transcriptFile, windows, withHost, REMOTE, type Pair } from './fake-agents.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
const beds: Ah[] = [];
after(async () => {
  for (const ah of beds) await cleanup(ah).catch(() => {});
});
const pair = async (o: Parameters<typeof hostPair>[0] = {}) => {
  const p = await hostPair(o);
  beds.push(p.b, p.a);
  return p;
};


const asB = (p: Pair) => ({ token: p.b.localToken() });

test('a stopped Claude session moves from omarchy to the Mac and resumes there; the original stays', async () => {
  const p = await pair();
  const { a, b } = p;
  const s = await launch(a, 'claude', p.aBed.project, 'Ship the parser');
  await say(a, s.uid, 'Rewrite the parser with a state machine');
  await say(a, s.uid, 'Keep the old API working');

  // Running sessions stay put.
  const running = await http(a, 'POST', '/api/migrations', { body: { ref: s.uid, to: 'mac-b' } });
  assert.equal(running.status, 409, running.body);
  assert.equal(running.json().code, 'source_running');

  assert.equal((await http(a, 'POST', `/api/sessions/${s.uid}/terminate`)).status, 200);
  await until(async () => !(await windows(a)).some((w) => w.uid === s.uid), 8000, 'ended');
  const srcFile = transcriptFile(a, s.harnessId)!;
  const before = sha(readFileSync(srcFile, 'utf8'));

  // The destination's verdict first: where it goes and why, nothing moved.
  const preview = (await http(a, 'POST', '/api/migrations/preview', { body: { ref: s.uid, to: 'mac-b' } })).json();
  assert.equal(preview.preflight.ok, true, JSON.stringify(preview.preflight));
  assert.equal(preview.preflight.destCwd, p.bCheckout);
  assert.equal(preview.preflight.resolvedBy, 'git_remote');
  assert.equal(preview.manifest.project.remote, REMOTE);
  assert.ok(!JSON.stringify(preview.manifest).includes(p.token), 'no credential travels');
  assert.equal((await http(b, 'GET', '/api/migrations', asB(p))).json().migrations.length, 0, 'preview leaves nothing on the destination');

  const key = 'test:move-parser-1';
  const start = await http(a, 'POST', '/api/migrations', { body: { ref: s.uid, to: 'mac-b', idempotencyKey: key } });
  assert.equal(start.status, 201, start.body);
  const id = start.json().migration.id;
  const done = await until(async () => {
    const m = (await http(a, 'GET', `/api/migrations/${id}`)).json();
    if (m.state === 'failed') throw new Error(m.error);
    return m.state === 'completed' && m;
  }, 20000, 'migration completed');
  assert.ok(Object.values(done.progress).every((f: any) => f.sent));
  const again = await http(a, 'POST', '/api/migrations', { body: { ref: s.uid, to: 'mac-b', idempotencyKey: key } });
  assert.equal(again.status, 200);
  assert.equal(again.json().migration.id, id);

  // On the Mac: in History, from omarchy, homed in its own checkout, resumable.
  const hist = (await http(b, 'GET', '/api/state', asB(p))).json().history.find((h: any) => h.ref === done.destUid);
  assert.equal(hist.continued.kind, 'migration');
  assert.equal(hist.continued.fromHost, 'omarchy-a');
  const destFile = transcriptFile(b, s.harnessId)!;
  assert.ok(destFile.includes(p.bCheckout.replace(/[^a-zA-Z0-9]/g, '-')), destFile);
  const destText = readFileSync(destFile, 'utf8');
  assert.ok(destText.includes(`"cwd":"${p.bCheckout}"`) && !destText.includes(`"cwd":"${p.aBed.project}"`), 'rehomed to the Mac checkout');
  const resumed = await http(b, 'POST', `/api/sessions/${done.destUid}/resume`, asB(p));
  assert.equal(resumed.status, 201, resumed.body);
  const live = await until(async () => (await http(b, 'GET', '/api/state', asB(p))).json().windows.find((w: any) => w.uid === done.destUid && w.harnessId === s.harnessId), 15000, 'resumed on b');
  await http(b, 'POST', `/api/sessions/${live.uid}/send`, { ...asB(p), body: { text: 'Carry on from the Mac' } });
  await until(() => readFileSync(destFile, 'utf8').includes('Got: Carry on from the Mac'), 15000, 'b took a turn');
  assert.match(readFileSync(destFile, 'utf8'), /Keep the old API working/, 'the conversation came along');

  // The original: untouched, still in A's History, marked as moved.
  assert.equal(sha(readFileSync(srcFile, 'utf8')), before);
  const aHist = (await http(a, 'GET', '/api/state')).json().history.find((h: any) => h.ref === s.uid);
  assert.equal(aHist.moved.host, 'mac-b');
  const tree = (await http(b, 'GET', `/api/portable/conversations/${done.destUid}/lineage`, asB(p))).json();
  assert.ok(tree.nodes.length >= 1);

  // A second move of the same conversation finds it there and overwrites nothing.
  const twice = await http(a, 'POST', '/api/migrations', { body: { ref: s.uid, to: 'mac-b' } });
  assert.equal(twice.status, 409, twice.body);
  assert.equal(twice.json().code, 'conflict');
});

test('what the destination lacks is said before anything moves; a bad hash, a rollback and a restart mid-move are safe', async () => {
  const p = await pair({ bPresets: (bin) => fakePresets(bin).filter((x) => x.id !== 'codex') });
  const { a, b } = p;

  // No Codex on the Mac: refused up front, nothing created on either side.
  const cx = await launch(a, 'codex', p.aBed.project, 'Codex work');
  await say(a, cx.uid, 'Index the repo');
  await http(a, 'POST', `/api/sessions/${cx.uid}/terminate`);
  await until(async () => !(await windows(a)).some((w) => w.uid === cx.uid), 8000, 'codex ended');
  const noCodex = await http(a, 'POST', '/api/migrations', { body: { ref: cx.uid, to: 'mac-b' } });
  assert.equal(noCodex.status, 409, noCodex.body);
  assert.equal(noCodex.json().code, 'missing_harness');

  // A project the Mac has no checkout of.
  const elsewhere = join(p.aBed.dir, 'files', 'other');
  mkdirSync(elsewhere, { recursive: true });
  git(elsewhere, 'init', '-q');
  git(elsewhere, 'remote', 'add', 'origin', 'https://github.com/example/unknown.git');
  const lone = await launch(a, 'claude', elsewhere, 'Lone');
  await say(a, lone.uid, 'Something here');
  await http(a, 'POST', `/api/sessions/${lone.uid}/terminate`);
  await until(async () => !(await windows(a)).some((w) => w.uid === lone.uid), 8000, 'lone ended');
  const missing = (await http(a, 'POST', '/api/migrations/preview', { body: { ref: lone.uid, to: 'mac-b' } })).json();
  assert.equal(missing.preflight.ok, false);
  assert.equal(missing.preflight.requirements[0].code, 'missing_project');
  // Naming the folder works, with what doesn't match said as a warning to confirm.
  const named = await http(a, 'POST', '/api/migrations', { body: { ref: lone.uid, to: 'mac-b', cwd: p.bCheckout } });
  assert.equal(named.status, 409);
  assert.equal(named.json().code, 'needs_confirmation');

  // A browser's sign-in can't use the host-to-host routes.
  const pw = 'correct horse battery staple';
  await http(b, 'POST', '/api/auth/password', { token: b.localToken(), body: { password: pw } });
  const login = await http(b, 'POST', '/api/auth/password/login', { body: { password: pw, label: 'phone' } });
  const cookie = String(login.headers['set-cookie']).split(';')[0];
  const asBrowser = await http(b, 'POST', '/api/migrations/incoming/preflight', { cookie, body: { manifest: {} } });
  assert.equal(asBrowser.status, 403);
  assert.equal(asBrowser.json().code, 'machine_only');
  const anonymous = await http(b, 'POST', '/api/migrations/incoming/preflight', { body: { manifest: {} } });
  assert.equal(anonymous.status, 401);

  // A file that arrives damaged is refused and not kept; the right one is; then a rollback.
  const s = await launch(a, 'claude', p.aBed.project, 'Hash check');
  await say(a, s.uid, 'Hello there');
  await http(a, 'POST', `/api/sessions/${s.uid}/terminate`);
  await until(async () => !(await windows(a)).some((w) => w.uid === s.uid), 8000, 'ended');
  const { manifest } = (await http(a, 'POST', '/api/migrations/preview', { body: { ref: s.uid, to: 'mac-b' } })).json();
  const asA = { token: p.token };
  assert.equal((await http(b, 'POST', '/api/migrations/incoming', { ...asA, body: { manifest } })).status, 200);
  const bad = await http(b, 'PUT', `/api/migrations/incoming/${manifest.id}/files/transcript`, { ...asA, raw: Buffer.from('x'.repeat(manifest.files.find((f: any) => f.name === 'transcript').bytes)), headers: { 'content-type': 'application/octet-stream' } });
  assert.equal(bad.status, 400, bad.body);
  assert.equal(bad.json().code, 'hash_mismatch');
  const early = await http(b, 'POST', `/api/migrations/incoming/${manifest.id}/commit`, asA);
  assert.equal(early.status, 409, 'nothing commits before every file is whole');
  for (const f of manifest.files) {
    const src = f.name === 'transcript' ? transcriptFile(a, s.harnessId)! : (await http(a, 'GET', `/api/portable/conversations/${s.uid}`)).json().path;
    const ok = await http(b, 'PUT', `/api/migrations/incoming/${manifest.id}/files/${f.name}`, { ...asA, raw: readFileSync(src), headers: { 'content-type': 'application/octet-stream', 'x-ah-sha256': f.sha256 } });
    assert.equal(ok.status, 200, ok.body);
  }
  const committed = (await http(b, 'POST', `/api/migrations/incoming/${manifest.id}/commit`, asA)).json();
  assert.ok(existsSync(committed.file));
  assert.equal((await http(b, 'POST', `/api/migrations/incoming/${manifest.id}/commit`, asA)).json().uid, committed.uid, 'commit is idempotent');
  const rolled = await http(b, 'DELETE', `/api/migrations/incoming/${manifest.id}`, asA);
  assert.equal(rolled.status, 200, rolled.body);
  assert.equal(existsSync(committed.file), false, 'rollback removes what the restore wrote');
  await until(async () => !(await http(b, 'GET', '/api/state', asB(p))).json().history.some((h: any) => h.ref === committed.uid), 8000, 'gone from history');

  // A restart of the source mid-move: it carries on and completes once.
  const res = await http(a, 'POST', '/api/migrations', { body: { ref: s.uid, to: 'mac-b' } });
  assert.equal(res.status, 201, res.body);
  const id = res.json().migration.id;
  const a2 = await withHost('omarchy-a', () => a.restart());
  await until(async () => (await http(a2, 'GET', '/api/state')).json().hosts.some((h: any) => h.name === 'mac-b' && h.online), 10000, 'a2 sees b');
  const m = await until(async () => {
    const x = (await http(a2, 'GET', `/api/migrations/${id}`)).json();
    if (x.state === 'failed') {
      await http(a2, 'POST', `/api/migrations/${id}/retry`);
      return false;
    }
    return x.state === 'completed' && x;
  }, 25000, 'completed after a restart');
  const onB = (await http(b, 'GET', '/api/state', asB(p))).json().history.filter((h: any) => h.harnessId === s.harnessId);
  assert.equal(onB.length, 1, 'exactly one copy on the destination');
  assert.equal(onB[0].ref, m.destUid);
});
