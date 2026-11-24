// The CLI drives sessions the way the web does (spec CLI): agents driving agents need to
// answer, stop, terminate, rename and pin, and to name a session by its title.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, cleanup, http, signIn, until, type Ah } from './helpers.ts';

const CLI = fileURLToPath(new URL('../bin/ah.js', import.meta.url));
const HOOK = fileURLToPath(new URL('../bin/ah-hook.js', import.meta.url));
let ah: Ah;
let cookie: string;
const bin = join(process.env.TMPDIR ?? '/tmp', `ah-cli-bin-${process.pid}`);

// A stand-in agent named `claude`, so ah detects it, drawing Claude's permission prompt.
// When `<bin>/danger-mode` exists, it asks for a destructive command so guardrails can be tested.
const FAKE_CLAUDE = `#!/bin/bash
if [ -f "${bin}/danger-mode" ]; then
  printf ' Bash command\\n\\n   git push --force origin main\\n   Force push main\\n\\n Do you want to proceed?\\n ❯ 1. Yes\\n   2. No\\n'
else
  printf ' Bash command\\n\\n   rm -rf build\\n   Remove the build folder\\n\\n Do you want to proceed?\\n ❯ 1. Yes\\n   2. No\\n'
fi
IFS= read -rsn1 key
printf '\\033[2J\\033[Hanswered %s\\n' "$key"
sleep 600
`;

before(async () => {
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE);
  chmodSync(join(bin, 'claude'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    ah = await startAh();
  } finally {
    process.env.PATH = path;
  }
  cookie = await signIn(ah);
});
after(async () => {
  await cleanup(ah);
  rmSync(bin, { recursive: true, force: true });
});

function ahCli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return ahCliEnv({}, ...args);
}

function ahCliEnv(extraEnv: Record<string, string>, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...ah.env, AH_PORT: String(ah.port), ...extraEnv } }, (e, out, err) =>
      resolve({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out, err }),
    );
  });
}

const windows = async () => (await http(ah, 'GET', '/api/state', { cookie })).json().windows as Array<{ uid: string; id: string; title: string; name: string; pinned: boolean; status: string }>;

/** Reads the real per-session AH_SESSION_TOKEN (and AH_SPACE* vars) injected into a live session's process environment. */
async function sessionEnv(uid: string): Promise<Record<string, string>> {
  const win = (await windows()).find((w) => w.uid === uid);
  assert.ok(win, `live window for ${uid}`);
  const pid = ah.tmux('display-message', '-p', '-t', win.id, '#{pane_pid}').trim();
  const raw = readFileSync(`/proc/${pid}/environ`, 'utf8');
  const vars = Object.fromEntries(
    raw
      .split('\0')
      .filter((e) => e.includes('='))
      .map((e) => {
        const i = e.indexOf('=');
        return [e.slice(0, i), e.slice(i + 1)];
      }),
  );
  assert.ok(vars.AH_SESSION_TOKEN, `AH_SESSION_TOKEN injected into ${uid}`);
  return {
    AH_SESSION_UID: uid,
    AH_SESSION_TOKEN: vars.AH_SESSION_TOKEN,
    ...(vars.AH_PORT ? { AH_PORT: vars.AH_PORT } : {}),
    ...(vars.AH_ROLE ? { AH_ROLE: vars.AH_ROLE } : {}),
    ...(vars.AH_MANAGED_BY ? { AH_MANAGED_BY: vars.AH_MANAGED_BY } : {}),
    ...(vars.AH_SPACE ? { AH_SPACE: vars.AH_SPACE } : {}),
    ...(vars.AH_SPACE_DIR ? { AH_SPACE_DIR: vars.AH_SPACE_DIR } : {}),
    ...(vars.AH_SPACE_MEMORY_DIR ? { AH_SPACE_MEMORY_DIR: vars.AH_SPACE_MEMORY_DIR } : {}),
    ...(vars.AH_SPACE_ARTIFACTS_DIR ? { AH_SPACE_ARTIFACTS_DIR: vars.AH_SPACE_ARTIFACTS_DIR } : {}),
    ...(vars.AH_SPACE_CONTEXT_FILE ? { AH_SPACE_CONTEXT_FILE: vars.AH_SPACE_CONTEXT_FILE } : {}),
  };
}

test('rename, pin and terminate a session by title', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'shell', cwd: `${ah.dir}/files`, label: 'cli target' } });
  const { uid } = created.json();
  await until(async () => (await windows()).some((w) => w.uid === uid), 8000, 'in state');

  let r = await ahCli('rename', 'cli target', 'renamed', 'by', 'cli');
  assert.equal(r.code, 0, r.err);
  await until(async () => (await windows()).find((w) => w.uid === uid)?.title === 'renamed by cli', 8000, 'renamed');

  r = await ahCli('pin', 'renamed by');
  assert.equal(r.code, 0, r.err);
  await until(async () => (await windows()).find((w) => w.uid === uid)?.pinned === true, 8000, 'pinned');
  r = await ahCli('pin', uid, '--off');
  assert.equal(r.code, 0, r.err);
  await until(async () => (await windows()).find((w) => w.uid === uid)?.pinned === false, 8000, 'unpinned');

  r = await ahCli('list');
  assert.match(r.out, /renamed by cli/);
  assert.match(r.out, /○ idle|◌ working|◆ new output/);

  r = await ahCli('answer', uid, 'yes');
  assert.notEqual(r.code, 0);
  assert.match(r.err, /isn't waiting/);

  r = await ahCli('stop', uid);
  assert.equal(r.code, 0, r.err);

  r = await ahCli('terminate', uid);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ah resume/);
  await until(async () => !(await windows()).some((w) => w.uid === uid), 8000, 'gone');
});

test('answer a waiting agent by option number', async () => {
  const created = await http(ah, 'POST', '/api/windows', { cookie, body: { preset: 'claude', cwd: `${ah.dir}/files`, label: 'asks' } });
  assert.equal(created.status, 201, created.body);
  const { uid, id } = created.json();
  await until(async () => (await windows()).find((w) => w.uid === uid)?.status === 'waiting', 15000, 'waiting');
  const r = await ahCli('answer', uid, '1');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /answered: Yes/);
  await until(() => ah.tmux('capture-pane', '-p', '-t', id).includes('answered 1'), 8000, 'key typed');
});

test('chief-of-staff CLI wiring: write, read, show, whoami, harnesses, mode, interrupt, forward, decide, heartbeat & wake', async () => {
  // 1. Launch via CLI with --json; verify AH_SESSION_UID is injected and `whoami` / `self` work.
  const created = await ahCli('new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'orchestrator', '--json');
  assert.equal(created.code, 0, created.err);
  const cos = JSON.parse(created.out) as { uid: string; id: string };
  assert.ok(cos.uid);
  await until(async () => (await windows()).some((w) => w.uid === cos.uid), 8000, 'cos in state');

  // Spoofing AH_SESSION_UID without its per-session AH_SESSION_TOKEN is refused.
  const spoofed = await ahCliEnv({ AH_SESSION_UID: cos.uid }, 'whoami', '--json');
  assert.notEqual(spoofed.code, 0, 'spoofed AH_SESSION_UID without token must be rejected');
  assert.match(spoofed.err, /X-AH-Session-Token/i);

  const cosEnv = await sessionEnv(cos.uid);
  const who = await ahCliEnv(cosEnv, 'whoami', '--json');
  assert.equal(who.code, 0, who.err);
  assert.equal(JSON.parse(who.out).uid, cos.uid);

  // 2. Write to session with idempotency id, then read back via --screen and --json.
  const w1 = await ahCliEnv(cosEnv, 'write', 'self', 'echo AH_UID_IS:$AH_SESSION_UID', '--id', 'msg-cos-1', '--json');
  assert.equal(w1.code, 0, w1.err);
  assert.equal(JSON.parse(w1.out).outcome, 'delivered');
  await until(async () => {
    const rd = await ahCli('read', cos.uid, '--screen', '--json');
    return rd.code === 0 && JSON.parse(rd.out).text.includes(`AH_UID_IS:${cos.uid}`);
  }, 8000, 'AH_SESSION_UID echoed in shell');

  // Re-sending the same id is idempotent.
  const w2 = await ahCli('send', cos.uid, 'echo SHOULD_NOT_REPEAT', '--id', 'msg-cos-1', '--json');
  assert.equal(w2.code, 0, w2.err);
  assert.equal(JSON.parse(w2.out).outcome, 'delivered');

  // 3. Inspect single session (`show`), list with filters (`--exclude-self`), and list harnesses.
  const shown = await ahCli('show', cos.uid, '--json');
  assert.equal(shown.code, 0, shown.err);
  const shownJson = JSON.parse(shown.out);
  assert.equal(shownJson.window.uid, cos.uid);
  assert.equal(shownJson.preset.id, 'shell');

  const harnesses = await ahCli('harnesses', '--json');
  assert.equal(harnesses.code, 0, harnesses.err);
  const claudeHarness = (JSON.parse(harnesses.out) as Array<{ id: string; modes: Array<{ id: string; level: string | null }> }>).find((h) => h.id === 'claude');
  assert.ok(claudeHarness);
  assert.ok(claudeHarness.modes.some((m) => m.id === 'dangerous' && m.level === 'bypass'));

  // 4. Spawn a waiting agent, test `list --waiting`, `show`, `mode` inspection, `forward`, `decide`, `answer --prompt`.
  const workerRes = await ahCli('new', 'claude', '--cwd', `${ah.dir}/files`, '--name', 'worker-prompt', '--json');
  assert.equal(workerRes.code, 0, workerRes.err);
  const worker = JSON.parse(workerRes.out) as { uid: string; id: string };
  await until(async () => (await windows()).find((w) => w.uid === worker.uid)?.status === 'waiting', 15000, 'worker waiting');

  const waitingList = await ahCliEnv(cosEnv, 'list', '--waiting', '--exclude-self', '--json');
  assert.equal(waitingList.code, 0, waitingList.err);
  const waitingArr = JSON.parse(waitingList.out) as Array<{ uid: string; askId: string | null }>;
  assert.ok(waitingArr.some((w) => w.uid === worker.uid));

  const workerShow = await ahCli('show', worker.uid, '--json');
  assert.equal(workerShow.code, 0, workerShow.err);
  const askId = JSON.parse(workerShow.out).window.askId as string;
  assert.ok(askId, 'waiting worker has askId');

  // Mode inspection on worker reports canonical levels.
  const modeInfo = await ahCli('mode', worker.uid, '--json');
  assert.equal(modeInfo.code, 0, modeInfo.err);
  assert.equal(JSON.parse(modeInfo.out).mode, 'default');
  assert.equal(JSON.parse(modeInfo.out).level, 'ask');

  // Forward prompt directly to user devices.
  const fwd = await ahCli('forward', worker.uid, '--note', 'Please confirm deleting build/', '--json');
  assert.equal(fwd.code, 0, fwd.err);
  const fwdJson = JSON.parse(fwd.out);
  assert.equal(fwdJson.forwarded, true);
  assert.equal(fwdJson.askId, askId);
  assert.match(fwdJson.body, /Please confirm deleting build\//);

  // Forward as a durable Inbox decision, then decide it via CLI.
  const dec = await ahCli('decide', '--title', 'Approve deploy?', '--body', 'Tests are green', '--json');
  assert.equal(dec.code, 0, dec.err);
  const decJson = JSON.parse(dec.out) as { jobId: string; runId: string };
  await until(async () => (await http(ah, 'GET', `/api/jobs/runs/${decJson.runId}`, { cookie })).json().state === 'waiting', 8000, 'decision waiting');
  const decided = await ahCli('job', 'decide', decJson.runId, 'yes', '--note', 'ship it', '--json');
  assert.equal(decided.code, 0, decided.err);
  assert.equal(JSON.parse(decided.out).outcome.decision, 'approved');

  // Stale prompt guard rejects a mismatched askId, then accepts the matching one.
  const stale = await ahCli('answer', worker.uid, 'yes', '--prompt', 'wrong-ask-id');
  assert.notEqual(stale.code, 0);
  const okAns = await ahCli('answer', worker.uid, 'yes', '--prompt', askId, '--json');
  assert.equal(okAns.code, 0, okAns.err);
  assert.equal(JSON.parse(okAns.out).answer, 'approve');

  // 5. Heartbeat & fleet wake scheduling + management.
  const hb = await ahCli('heartbeat', cos.uid, '--every', '30s', '--text', 'Check fleet', '--json');
  assert.equal(hb.code, 0, hb.err);
  const hbJob = JSON.parse(hb.out);
  assert.equal(hbJob.trigger.kind, 'every');
  assert.equal(hbJob.trigger.seconds, 30);
  assert.equal(hbJob.policy.skipIfBusy, true);
  assert.equal(hbJob.policy.ifLive, true);

  const hbList = await ahCli('heartbeat', 'list', '--target', cos.uid, '--json');
  assert.equal(hbList.code, 0, hbList.err);
  assert.ok((JSON.parse(hbList.out) as Array<{ id: string }>).some((j) => j.id === hbJob.id));

  const hbStop = await ahCli('heartbeat', 'stop', hbJob.id, '--json');
  assert.equal(hbStop.code, 0, hbStop.err);
  assert.equal(JSON.parse(hbStop.out).state, 'cancelled');

  const wake = await ahCli('wake', cos.uid, '--when-waiting', '*', '--repeat', '--json');
  assert.equal(wake.code, 0, wake.err);
  const wakeJob = JSON.parse(wake.out);
  assert.equal(wakeJob.trigger.kind, 'session');
  assert.equal(wakeJob.trigger.uid, '*');
  assert.equal(wakeJob.trigger.on, 'waiting');
  assert.equal(wakeJob.trigger.repeat, true);
  await ahCli('job', 'cancel', wakeJob.id);

  // 6. Interrupt & terminate cleanup.
  const intr = await ahCli('interrupt', cos.uid, '--json');
  assert.equal(intr.code, 0, intr.err);
  assert.equal(JSON.parse(intr.out).ok, true);
  await ahCli('terminate', worker.uid, '--json');
  await ahCli('terminate', cos.uid, '--json');
});

test('fleet coordination CLI: supervise, guardrails, audit, mail, tasks, verify, terminal, notes, spaces, hosts & stall/overlap wakes', async () => {
  // Spawn Chief, a supervised worker with a dangerous prompt, and an unrelated peer session.
  const cos = JSON.parse((await ahCli('new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'chief-2', '--role', 'chief', '--json')).out) as { uid: string };
  const rogue = JSON.parse((await ahCli('new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'rogue-1', '--json')).out) as { uid: string };
  await until(async () => {
    const ws = await windows();
    return ws.some((w) => w.uid === cos.uid) && ws.some((w) => w.uid === rogue.uid);
  }, 8000, 'chief and rogue in state');

  writeFileSync(join(bin, 'danger-mode'), '1');
  let worker: { uid: string };
  try {
    const wr = await ahCli(
      'new', 'claude', '--cwd', `${ah.dir}/files`, '--name', 'danger-worker',
      '--role', 'worker', '--managed-by', cos.uid, '--mute-alerts', '--escalate-after', '90s', '--tag', 'release',
      '--json',
    );
    assert.equal(wr.code, 0, wr.err);
    worker = JSON.parse(wr.out) as { uid: string };
    await until(async () => (await windows()).find((w) => w.uid === worker.uid)?.status === 'waiting', 15000, 'danger worker waiting');
  } finally {
    rmSync(join(bin, 'danger-mode'), { force: true });
  }

  // 1. Supervision filtering and updating (`supervise`, `list --role/--managed-by/--tag`).
  const filtered = await ahCli('list', '--role', 'worker', '--managed-by', cos.uid, '--tag', 'release', '--json');
  assert.equal(filtered.code, 0, filtered.err);
  const filteredArr = JSON.parse(filtered.out) as Array<{ uid: string; supervision?: { role?: string; managedBy?: string; tags?: string[] } }>;
  assert.deepEqual(filteredArr.map((w) => w.uid), [worker.uid]);
  assert.equal(filteredArr[0].supervision?.managedBy, cos.uid);

  const supUpdate = await ahCli('supervise', worker.uid, '--tag', 'release', '--tag', 'critical', '--json');
  assert.equal(supUpdate.code, 0, supUpdate.err);
  assert.deepEqual(JSON.parse(supUpdate.out).supervision.tags, ['release', 'critical']);

  // 2. External guardrails & cross-session control boundaries (with authenticated AH_SESSION_UID + AH_SESSION_TOKEN).
  const cosEnv = await sessionEnv(cos.uid);
  const rogueEnv = await sessionEnv(rogue.uid);
  const workerEnv = await sessionEnv(worker.uid);

  // Worker cannot answer its own prompt.
  const selfAns = await ahCliEnv(workerEnv, 'answer', worker.uid, 'yes');
  assert.notEqual(selfAns.code, 0);
  assert.match(selfAns.err, /cannot answer its own prompt/i);

  // Unrelated session cannot answer a worker supervised by Chief.
  const rogueAns = await ahCliEnv(rogueEnv, 'answer', worker.uid, 'yes');
  assert.notEqual(rogueAns.code, 0);
  assert.match(rogueAns.err, /supervised by/i);

  // Chief cannot silently auto-approve a destructive command (`git push --force`), either by yes or option 1.
  const guardYes = await ahCliEnv(cosEnv, 'answer', worker.uid, 'yes');
  assert.notEqual(guardYes.code, 0);
  assert.match(guardYes.err, /guardrail.*force_push/i);

  const guardOpt1 = await ahCliEnv(cosEnv, 'answer', worker.uid, '1');
  assert.notEqual(guardOpt1.code, 0);
  assert.match(guardOpt1.err, /guardrail.*force_push/i);

  // Chief CAN deny it (`no`).
  const chiefDeny = await ahCliEnv(cosEnv, 'answer', worker.uid, 'no', '--json');
  assert.equal(chiefDeny.code, 0, chiefDeny.err);
  assert.equal(JSON.parse(chiefDeny.out).answer, 'deny');

  // 3. Audit trail records actorUid attribution.
  const auditRes = await ahCli('audit', '--session', worker.uid, '--json');
  assert.equal(auditRes.code, 0, auditRes.err);
  const auditEntries = JSON.parse(auditRes.out) as Array<{ event: string; actorUid?: string }>;
  assert.ok(auditEntries.some((e) => e.event === 'session.deny' && e.actorUid === cos.uid), 'audit log records actorUid');

  // 4. Async mailbox: send, inbox, show, ack, delete.
  const mSent = await ahCliEnv(cosEnv, 'mail', 'send', worker.uid, 'Check auth tests', '--subject', 'Task 1', '--kind', 'directive', '--json');
  assert.equal(mSent.code, 0, mSent.err);
  const mailObj = JSON.parse(mSent.out) as { id: string; fromUid: string; toUid: string };
  assert.equal(mailObj.fromUid, cos.uid);
  assert.equal(mailObj.toUid, worker.uid);

  const inbox = await ahCliEnv(workerEnv, 'mail', 'inbox', '--json');
  assert.equal(inbox.code, 0, inbox.err);
  assert.ok((JSON.parse(inbox.out) as Array<{ id: string }>).some((m) => m.id === mailObj.id));

  const mAck = await ahCli('mail', 'ack', mailObj.id, '--json');
  assert.equal(mAck.code, 0, mAck.err);
  assert.ok(JSON.parse(mAck.out).ackedAt);

  const inboxAfter = await ahCliEnv(workerEnv, 'mail', 'inbox', '--json');
  assert.equal((JSON.parse(inboxAfter.out) as Array<{ id: string }>).length, 0);

  const mDel = await ahCli('mail', 'delete', mailObj.id, '--json');
  assert.equal(mDel.code, 0, mDel.err);

  // 5. Durable fleet tasks + sidecar `verify --task` + `terminal`.
  const tkAdd = await ahCliEnv(cosEnv, 'task', 'add', 'Verify CLI', '--assign', cos.uid, '--priority', '1', '--verify', 'echo VERIFY_PASS', '--json');
  assert.equal(tkAdd.code, 0, tkAdd.err);
  const tk = JSON.parse(tkAdd.out) as { id: string; ownerUid: string; assignedUid: string };
  assert.equal(tk.ownerUid, cos.uid);
  assert.equal(tk.assignedUid, cos.uid);

  const tkList = await ahCli('tasks', '--assigned', cos.uid, '--json');
  assert.equal(tkList.code, 0, tkList.err);
  assert.ok((JSON.parse(tkList.out) as Array<{ id: string }>).some((t) => t.id === tk.id));

  const ver = await ahCli('verify', cos.uid, 'echo VERIFY_PASS', '--task', tk.id, '--timeout', '15', '--json');
  assert.equal(ver.code, 0, ver.err);
  const verJson = JSON.parse(ver.out) as { ok: boolean; exitCode: number; output: string };
  assert.equal(verJson.ok, true);
  assert.equal(verJson.exitCode, 0);
  assert.match(verJson.output, /VERIFY_PASS/);

  const tkShow = await ahCli('task', 'show', tk.id, '--json');
  assert.equal(tkShow.code, 0, tkShow.err);
  assert.equal(JSON.parse(tkShow.out).lastVerify?.ok, true);

  const tkUpd = await ahCli('task', 'update', tk.id, '--status', 'done', '--result', 'Verified', '--json');
  assert.equal(tkUpd.code, 0, tkUpd.err);
  assert.equal(JSON.parse(tkUpd.out).status, 'done');

  const termClose = await ahCli('terminal', cos.uid, '--close', '--json');
  assert.equal(termClose.code, 0, termClose.err);

  const tkDel = await ahCli('task', 'delete', tk.id, '--json');
  assert.equal(tkDel.code, 0, tkDel.err);

  // 6. Parity commands: notes, spaces, hosts, and stall/overlap wakes.
  const nNew = await ahCli('note', 'new', '--title', 'Fleet plan', 'Step 1: ship', '--json');
  assert.equal(nNew.code, 0, nNew.err);
  const noteObj = JSON.parse(nNew.out) as { id: string };
  const nList = await ahCli('notes', '--json');
  assert.equal(nList.code, 0, nList.err);
  assert.ok((JSON.parse(nList.out) as Array<{ id: string }>).some((n) => n.id === noteObj.id));
  await ahCli('note', 'delete', noteObj.id, '--json');

  const sp = await ahCli('spaces', '--json');
  assert.equal(sp.code, 0, sp.err);
  assert.ok(Array.isArray(JSON.parse(sp.out).spaces));

  const hosts = await ahCli('hosts', '--json');
  assert.equal(hosts.code, 0, hosts.err);
  assert.ok(Array.isArray(JSON.parse(hosts.out)));

  const stallWake = await ahCli('wake', cos.uid, '--when-stalled', '*', '--after', '2m', '--repeat', '--json');
  assert.equal(stallWake.code, 0, stallWake.err);
  const stallJob = JSON.parse(stallWake.out);
  assert.equal(stallJob.trigger.on, 'stalled');
  assert.equal(stallJob.trigger.afterSeconds, 120);
  await ahCli('job', 'cancel', stallJob.id);

  const overlapWake = await ahCli('wake', cos.uid, '--when-overlap', '--repeat', '--json');
  assert.equal(overlapWake.code, 0, overlapWake.err);
  const overlapJob = JSON.parse(overlapWake.out);
  assert.equal(overlapJob.trigger.kind, 'overlap');
  await ahCli('job', 'cancel', overlapJob.id);

  await ahCli('terminate', worker.uid, '--json');
  await ahCli('terminate', rogue.uid, '--json');
  await ahCli('terminate', cos.uid, '--json');
});

test('unidirectional hierarchy (CoS > session): children cannot control parent or siblings, only communicate up or broadcast to siblings', async () => {
  const cos = JSON.parse((await ahCli('new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'uni-chief', '--role', 'chief', '--json')).out) as { uid: string };
  await until(async () => (await windows()).some((w) => w.uid === cos.uid), 8000, 'uni-chief in state');
  const cosEnv = await sessionEnv(cos.uid);

  const w1 = JSON.parse((await ahCliEnv(cosEnv, 'new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'uni-w1', '--role', 'worker', '--managed-by', cos.uid, '--json')).out) as { uid: string };
  const w2 = JSON.parse((await ahCliEnv(cosEnv, 'new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'uni-w2', '--role', 'worker', '--managed-by', cos.uid, '--json')).out) as { uid: string };
  await until(async () => {
    const ws = await windows();
    return ws.some((w) => w.uid === w1.uid) && ws.some((w) => w.uid === w2.uid);
  }, 8000, 'workers in state');
  const w1Env = await sessionEnv(w1.uid);
  const w2Env = await sessionEnv(w2.uid);

  // 1. Child CANNOT control parent (interrupt, terminate, rename, terminal, supervise, raw send, schedule job).
  for (const args of [
    ['interrupt', cos.uid],
    ['terminate', cos.uid],
    ['rename', cos.uid, 'hijacked'],
    ['terminal', cos.uid, 'echo pwned'],
    ['supervise', cos.uid, '--managed-by', w1.uid],
    ['supervise', w1.uid, '--managed-by', 'none'],
    ['send', cos.uid, 'raw', '--no-enter'],
    ['heartbeat', cos.uid, '--every', '60s'],
  ]) {
    const r = await ahCliEnv(w1Env, ...args);
    assert.notEqual(r.code, 0, `worker must be refused: ah ${args.join(' ')}`);
  }

  // 2. Child CANNOT cancel CoS's heartbeat job or approve a human decision.
  const cosHb = JSON.parse((await ahCliEnv(cosEnv, 'heartbeat', cos.uid, '--every', '60s', '--json')).out) as { id: string };
  const cancelAttempt = await ahCliEnv(w1Env, 'job', 'cancel', cosHb.id);
  assert.notEqual(cancelAttempt.code, 0, 'worker cannot cancel CoS heartbeat');
  await ahCliEnv(cosEnv, 'job', 'cancel', cosHb.id);

  // 3. Child CANNOT control or directly message/drive a sibling.
  for (const args of [
    ['interrupt', w2.uid],
    ['terminate', w2.uid],
    ['send', w2.uid, 'echo direct-lateral'],
    ['mail', 'send', w2.uid, 'direct lateral mail'],
  ]) {
    const r = await ahCliEnv(w1Env, ...args);
    assert.notEqual(r.code, 0, `sibling lateral action must be refused: ah ${args.join(' ')}`);
  }

  // 4. Child CANNOT send a `directive` mail upward to parent, nor spoof fromUid.
  const badMail = await ahCliEnv(w1Env, 'mail', 'send', cos.uid, 'Obey me', '--kind', 'directive');
  assert.notEqual(badMail.code, 0);

  // 5. Child CAN communicate UP to parent (non-directive mail AND safe live send) and BROADCAST to siblings.
  const upReport = await ahCliEnv(w1Env, 'mail', 'send', cos.uid, 'Unit tests green', '--kind', 'report', '--subject', 'Status', '--json');
  assert.equal(upReport.code, 0, upReport.err);
  const upReportObj = JSON.parse(upReport.out) as { id: string; fromUid: string; toUid: string };
  assert.equal(upReportObj.fromUid, w1.uid);
  assert.equal(upReportObj.toUid, cos.uid);

  const upSend = await ahCliEnv(w1Env, 'send', cos.uid, 'echo UPWARD_OK', '--json');
  assert.equal(upSend.code, 0, upSend.err);
  assert.equal(JSON.parse(upSend.out).outcome, 'delivered');

  const bcast = await ahCliEnv(w1Env, 'mail', 'broadcast', 'Schema v2 merged', '--subject', 'Heads up', '--json');
  assert.equal(bcast.code, 0, bcast.err);
  const bcastObj = JSON.parse(bcast.out) as { id: string; toUid: string };
  assert.equal(bcastObj.toUid, `siblings:${cos.uid}`);

  // Sibling w2 sees the broadcast in its inbox; sender w1 does not echo its own broadcast.
  const w2Inbox = JSON.parse((await ahCliEnv(w2Env, 'mail', 'inbox', '--json')).out) as Array<{ id: string }>;
  assert.ok(w2Inbox.some((m) => m.id === bcastObj.id), 'sibling receives broadcast');
  const w1Inbox = JSON.parse((await ahCliEnv(w1Env, 'mail', 'inbox', '--json')).out) as Array<{ id: string }>;
  assert.ok(!w1Inbox.some((m) => m.id === bcastObj.id), 'sender does not see own broadcast');

  // 6. Transitive hierarchy: if w1 spawns a grandchild without --managed-by, it inherits managedBy=w1 and STILL cannot control CoS.
  const gc = JSON.parse((await ahCliEnv(w1Env, 'new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'uni-gc', '--json')).out) as { uid: string };
  await until(async () => (await windows()).some((w) => w.uid === gc.uid), 8000, 'grandchild in state');
  const gcEnv = await sessionEnv(gc.uid);
  const gcShow = JSON.parse((await ahCli('show', gc.uid, '--json')).out);
  assert.equal(gcShow.window.supervision?.managedBy, w1.uid);
  const gcVsCos = await ahCliEnv(gcEnv, 'terminate', cos.uid);
  assert.notEqual(gcVsCos.code, 0, 'grandchild cannot terminate root CoS');

  // 7. CoS CAN terminate its descendants (downward, including transitive grandchild).
  assert.equal((await ahCliEnv(cosEnv, 'terminate', gc.uid, '--json')).code, 0);
  assert.equal((await ahCliEnv(cosEnv, 'terminate', w1.uid, '--json')).code, 0);
  assert.equal((await ahCliEnv(cosEnv, 'terminate', w2.uid, '--json')).code, 0);
  await ahCli('terminate', cos.uid, '--json');
});

test('Space Chief of Staff & Space-scoped notes: ah space new, ah space chief --adopt, Space isolation, ah space move/promote, ah note new --space', async () => {
  // 1. Create a plain Space and an existing unmanaged session inside it.
  const spMade = await ahCli('space', 'new', 'LaunchOps', '--json');
  assert.equal(spMade.code, 0, spMade.err);
  const spInfo = JSON.parse(spMade.out).space as { name: string; path: string };
  assert.equal(spInfo.name, 'LaunchOps');

  const spList = JSON.parse((await ahCli('spaces', '--json')).out) as { spaces: Array<{ name: string; path: string }> };
  assert.ok(spList.spaces.some((s) => s.name === 'LaunchOps'));

  const spaceAbs = join(ah.dir, 'home', 'spaces', 'LaunchOps');
  const existing = JSON.parse((await ahCli('new', 'shell', '--cwd', spaceAbs, '--name', 'ops-worker', '--json')).out) as { uid: string };
  const outside = JSON.parse((await ahCli('new', 'shell', '--cwd', `${ah.dir}/files`, '--name', 'other-space-worker', '--json')).out) as { uid: string };
  await until(async () => {
    const ws = await windows();
    return ws.some((w) => w.uid === existing.uid) && ws.some((w) => w.uid === outside.uid);
  }, 8000, 'space workers live');

  // Refuses launching a plain shell as Chief of Staff.
  const badChief = await ahCli('space', 'chief', 'LaunchOps', '--agent', 'shell');
  assert.notEqual(badChief.code, 0, 'must refuse launching a plain shell as Chief');
  assert.match(badChief.err, /refusing to launch a plain shell/i);

  // 2. Launch a Space Chief of Staff with --adopt (automatically picks the available agent preset `claude`).
  const chiefRes = await ahCli('space', 'chief', 'LaunchOps', '--adopt', '--json');
  assert.equal(chiefRes.code, 0, chiefRes.err);
  const chief = JSON.parse(chiefRes.out) as { uid: string; space: string; adopted: string[] };
  assert.equal(chief.space, 'LaunchOps');
  assert.deepEqual(chief.adopted, [existing.uid]);

  await until(async () => (await windows()).some((w) => w.uid === chief.uid), 8000, 'chief live');
  const chiefEnv = await sessionEnv(chief.uid);
  const chiefShow = JSON.parse((await ahCli('show', chief.uid, '--json')).out);
  assert.equal(chiefShow.window.supervision?.role, 'chief');
  assert.equal(chiefShow.window.supervision?.space, 'LaunchOps');

  // 3. Space-scoped Chief cannot control a session in a different Space, CAN control sessions in LaunchOps.
  const crossSpace = await ahCliEnv(chiefEnv, 'interrupt', outside.uid);
  assert.notEqual(crossSpace.code, 0, 'Space-scoped chief cannot control session in another Space');
  const inSpace = await ahCliEnv(chiefEnv, 'interrupt', existing.uid, '--json');
  assert.equal(inSpace.code, 0, inSpace.err);

  // 4. Explicit virtual Space membership (`ah space move`), knowledge promotion (`ah space promote`),
  //    Space artifacts (`ah space artifacts add` / list), live Space context (`ah space context`),
  //    and harness-native SessionStart context injection (`ah-hook.js`).
  assert.equal(chiefEnv.AH_SPACE, 'LaunchOps');
  assert.ok(chiefEnv.AH_SPACE_DIR?.endsWith('/LaunchOps'), 'AH_SPACE_DIR injected into session');
  assert.ok(chiefEnv.AH_SPACE_ARTIFACTS_DIR?.endsWith('/LaunchOps/artifacts'), 'AH_SPACE_ARTIFACTS_DIR injected');
  assert.ok(chiefEnv.AH_SPACE_CONTEXT_FILE?.endsWith('/.ah-space-context.md'), 'AH_SPACE_CONTEXT_FILE injected');

  const moved = await ahCli('space', 'move', outside.uid, 'LaunchOps', '--json');
  assert.equal(moved.code, 0, moved.err);
  assert.equal(JSON.parse(moved.out).space, 'LaunchOps');
  const promoted = await ahCli('space', 'promote', 'LaunchOps', '--title', 'Launch Rule', 'Always verify before deploy.', '--json');
  assert.equal(promoted.code, 0, promoted.err);
  assert.equal(JSON.parse(promoted.out).file.name, 'launch-rule.md');

  // Publish an artifact via CLI and verify both `ah space artifacts` and zero-arg `ah space context` ($AH_SPACE).
  const srcArt = join(ah.dir, 'files', 'release-brief.md');
  writeFileSync(srcArt, '# Release Brief\n\nReady for Friday.\n');
  const artAdd = await ahCliEnv(chiefEnv, 'space', 'artifacts', 'add', srcArt, '--json');
  assert.equal(artAdd.code, 0, artAdd.err);
  assert.equal(JSON.parse(artAdd.out).name, 'release-brief.md');

  const artList = await ahCliEnv(chiefEnv, 'space', 'artifacts', '--json');
  assert.equal(artList.code, 0, artList.err);
  assert.ok((JSON.parse(artList.out).artifacts as Array<{ name: string }>).some((a) => a.name === 'release-brief.md'));

  const ctxCmd = await ahCliEnv(chiefEnv, 'space', 'context');
  assert.equal(ctxCmd.code, 0, ctxCmd.err);
  assert.match(ctxCmd.out, /# Agent House Space: LaunchOps/);
  assert.match(ctxCmd.out, /launch-rule\.md/);
  assert.match(ctxCmd.out, /release-brief\.md/);

  // Verify Claude Code SessionStart hook injects BOTH the Chief role playbook and live Space context via additionalContext.
  assert.equal(chiefEnv.AH_ROLE, 'chief');
  assert.equal(chiefEnv.AH_PORT, String(ah.port));
  const hookOut = await new Promise<string>((resolve) => {
    const child = execFile(
      process.execPath,
      [HOOK, 'claude'],
      {
        env: {
          ...ah.env,
          TMUX_PANE: '%999',
          AH_ROLE: chiefEnv.AH_ROLE!,
          AH_SPACE: chiefEnv.AH_SPACE!,
          AH_SPACE_CONTEXT_FILE: chiefEnv.AH_SPACE_CONTEXT_FILE!,
        },
      },
      (_e, out) => resolve(out),
    );
    child.stdin?.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'sess-ctx-1' }));
  });
  const hookJson = JSON.parse(hookOut.trim()) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } };
  assert.equal(hookJson.hookSpecificOutput?.hookEventName, 'SessionStart');
  assert.match(hookJson.hookSpecificOutput?.additionalContext ?? '', /Chief of Staff Playbook/);
  assert.match(hookJson.hookSpecificOutput?.additionalContext ?? '', /mcp__ah__\*/);
  assert.match(hookJson.hookSpecificOutput?.additionalContext ?? '', /LaunchOps/);
  assert.match(hookJson.hookSpecificOutput?.additionalContext ?? '', /release-brief\.md/);

  // 4b. Verify built-in `ah mcp` stdio server live against this disposable host:
  //     Chief gets management tools + Space context, worker gets worker-safe tools only.
  const runMcp = (extraEnv: Record<string, string>, requests: Array<Record<string, unknown>>) =>
    new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [CLI, 'mcp'],
        { env: { ...ah.env, ...extraEnv } },
        (err, out, stderr) => {
          if (err) return reject(new Error(`ah mcp failed: ${stderr || err.message}`));
          const lines = out.trim().split('\n').filter(Boolean);
          resolve(lines.map((l) => JSON.parse(l) as Record<string, unknown>));
        },
      );
      child.stdin?.end(requests.map((r) => JSON.stringify(r)).join('\n') + '\n');
    });

  const chiefMcp = await runMcp(chiefEnv, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'space_context', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'space_sessions', arguments: {} } },
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'note_create', arguments: { title: 'MCP Created Note', body: 'Hello from ah mcp' } } },
    { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'task_create', arguments: { title: 'MCP Task', assignedUid: existing.uid, priority: 'high' } } },
    { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'task_list', arguments: { assignedTo: existing.uid } } },
    { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'session_send', arguments: { target: existing.uid, text: 'echo MCP_SEND_OK' } } },
    { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'session_interrupt', arguments: { target: existing.uid } } },
  ]);
  const chiefById = new Map(chiefMcp.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
  const chiefTools = ((chiefById.get(2)!.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
  assert.ok(chiefTools.includes('session_spawn'), 'Chief MCP exposes session_spawn');
  assert.ok(chiefTools.includes('space_context'), 'Chief MCP exposes space_context');
  assert.match((chiefById.get(3)!.result as { content: Array<{ text: string }> }).content[0].text, /# Agent House Space: LaunchOps/);
  assert.match((chiefById.get(4)!.result as { content: Array<{ text: string }> }).content[0].text, new RegExp(existing.uid));
  // Real-host verification of previously-broken MCP routes (PUT /api/notes/:id, /api/fleet/tasks?assigned=, /api/sessions/:uid/send & interrupt).
  assert.equal((chiefById.get(5)!.result as { isError?: boolean }).isError, undefined, 'MCP note_create succeeds against real host');
  const mcpNote = JSON.parse((chiefById.get(5)!.result as { content: Array<{ text: string }> }).content[0].text) as { id: string; title: string };
  assert.equal(mcpNote.title, 'MCP Created Note');
  assert.equal((chiefById.get(6)!.result as { isError?: boolean }).isError, undefined, 'MCP task_create succeeds with priority string');
  const mcpTask = JSON.parse((chiefById.get(6)!.result as { content: Array<{ text: string }> }).content[0].text) as { id: string; priority: number };
  assert.equal(mcpTask.priority, 1);
  assert.equal((chiefById.get(7)!.result as { isError?: boolean }).isError, undefined, 'MCP task_list assigned filter succeeds');
  assert.match((chiefById.get(7)!.result as { content: Array<{ text: string }> }).content[0].text, new RegExp(mcpTask.id));
  assert.equal((chiefById.get(8)!.result as { isError?: boolean }).isError, undefined, 'MCP session_send hits real /api/sessions/:uid/send');
  assert.equal((chiefById.get(9)!.result as { isError?: boolean }).isError, undefined, 'MCP session_interrupt hits real /api/sessions/:uid/interrupt');
  await ahCli('note', 'delete', mcpNote.id, '--json');

  // Verify live role sync in `ah mcp`: existing session was launched WITHOUT AH_ROLE=worker and later adopted by Chief;
  // `ah mcp` resolves live supervision from server, emits tools/list_changed, hides Chief tools, and refuses chief calls.
  const workerEnv = await sessionEnv(existing.uid);
  const workerMcp = await runMcp(workerEnv, [
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'session_answer', arguments: { target: chief.uid, choice: 'yes' } } },
  ]);
  const workerById = new Map(workerMcp.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
  const workerTools = ((workerById.get(1)!.result as { tools: Array<{ name: string }> }).tools).map((t) => t.name);
  assert.ok(workerTools.includes('space_context'), 'Adopted worker MCP exposes space_context');
  assert.ok(workerTools.includes('mail_report_up'), 'Adopted worker MCP exposes mail_report_up');
  assert.ok(!workerTools.includes('session_spawn'), 'Adopted worker MCP dynamically hides session_spawn');
  assert.ok(!workerTools.includes('space_promote_knowledge'), 'Adopted worker MCP hides space_promote_knowledge');
  assert.equal((workerById.get(2)!.result as { isError?: boolean }).isError, true, 'Adopted worker MCP refuses chief-only tool');

  // 4c. Verify Space Chief was auto-subscribed to Space-scoped waiting & finished events,
  //     and that terminating the Chief automatically cancels its event subscriptions.
  const jobsBefore = JSON.parse((await ahCli('jobs', '--json')).out) as { jobs: Array<{ id: string; state: string; createdBy: string; trigger: { space?: string; on?: string } }> };
  const chiefSubs = jobsBefore.jobs.filter((j) => j.createdBy === `system:chief:${chief.uid}` && j.state === 'scheduled');
  assert.equal(chiefSubs.length, 2, 'Chief auto-subscribed to waiting + idle Space wakes');
  assert.ok(chiefSubs.every((j) => j.trigger.space === 'LaunchOps'), 'Chief auto-subscriptions scoped to LaunchOps');
  assert.deepEqual(chiefSubs.map((j) => j.trigger.on).sort(), ['idle', 'waiting']);

  // 5. Space-scoped notes: created under LaunchOps and filtered via `ah notes --space LaunchOps`.
  const nIn = JSON.parse((await ahCli('note', 'new', '--space', 'LaunchOps', '--title', 'Launch checklist', 'Ship it', '--json')).out) as { id: string; project: { path: string } | null };
  assert.ok(nIn.project?.path.endsWith('/LaunchOps'), 'note filed under Space folder');
  const nOut = JSON.parse((await ahCli('note', 'new', '--title', 'Unfiled note', 'General', '--json')).out) as { id: string };

  const spaceNotes = JSON.parse((await ahCli('notes', '--space', 'LaunchOps', '--json')).out) as Array<{ id: string }>;
  assert.deepEqual(spaceNotes.map((n) => n.id), [nIn.id]);

  // Cleanup & verify Chief auto-subscriptions cancel automatically on Chief termination.
  await ahCli('note', 'delete', nIn.id, '--json');
  await ahCli('note', 'delete', nOut.id, '--json');
  await ahCli('terminate', existing.uid, '--json');
  await ahCli('terminate', chief.uid, '--json');
  await ahCli('terminate', outside.uid, '--json');
  await until(async () => {
    const after = JSON.parse((await ahCli('jobs', '--json')).out) as { jobs: Array<{ state: string; createdBy: string }> };
    const subs = after.jobs.filter((j) => j.createdBy === `system:chief:${chief.uid}`);
    return subs.length === 2 && subs.every((j) => j.state === 'cancelled');
  }, 8000, 'Chief auto-subscriptions cancelled when Chief ended');
});
