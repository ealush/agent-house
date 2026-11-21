import '../test/scratch.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated, getDb } from './db.ts';
import { SideChatStore } from './sidechat.ts';
import { ReviewService, readTextFile, replyMark, threadTitle, type SessionLite } from './review/service.ts';
import { imageSource } from './review/gh.ts';
import { runReviewTool } from './review/reviewer.ts';

// A stand-in `gh`: PR state lives in a JSON file, and merge/edit/ready
// change it the way GitHub would. Every call is logged.
const GH = `#!/usr/bin/env node
const fs = require('fs');
const file = process.env.AH_GH_STATE;
const st = JSON.parse(fs.readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
fs.appendFileSync(file + '.log', a.join(' ') + '\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(st));
const out = (v) => process.stdout.write(JSON.stringify(v));
const pr = (n) => st.prs.find((p) => p.number === Number(n));
// GitHub's stacks: { number, base?, prs: [bottom…top] } in st.stacks.
const stackOf = (n) => (st.stacks || []).find((s) => s.prs.includes(Number(n)));
const stackView = (s) => ({ number: s.number, base: { ref: s.base || 'main' }, open: s.prs.some((n) => pr(n).state === 'OPEN'), pull_requests: s.prs.map((n) => { const p = pr(n); return { number: n, state: p.state === 'OPEN' ? 'open' : 'closed', draft: p.isDraft, merged_at: p.state === 'MERGED' ? '2026-10-17T10:00:00Z' : null, head: { ref: p.headRefName, sha: p.headRefOid } }; }) });
// GitHub lands a stack up to a PR, points the next one at the base and moves the base there.
const land = (n) => {
  const s = stackOf(n); const upto = s.prs.indexOf(Number(n));
  for (const x of s.prs.slice(0, upto + 1)) if (pr(x).state === 'OPEN') pr(x).state = 'MERGED';
  const next = s.prs.slice(upto + 1).find((x) => pr(x).state === 'OPEN');
  if (next) pr(next).baseRefName = s.base || 'main';
  require('child_process').execFileSync('git', ['--git-dir', st.remote, 'update-ref', 'refs/heads/' + (s.base || 'main'), pr(n).headRefOid]);
};
const CRLF = String.fromCharCode(13, 10);
const http = (code, body) => { process.stdout.write('HTTP/2.0 ' + code + ' X' + CRLF + 'Content-Type: application/json' + CRLF + CRLF + JSON.stringify(body)); process.exit(code >= 400 ? 1 : 0); };
if (a[0] === 'repo' && a[1] === 'view') out({ nameWithOwner: 'me/proj', defaultBranchRef: { name: 'main' }, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
else if (a[0] === 'pr' && a[1] === 'list') out(st.prs.filter((p) => a[3] === 'all' || p.state === 'OPEN'));
else if (a[0] === 'pr' && a[1] === 'view') { const p = pr(a[2]); if (!p) { console.error('no pull requests found'); process.exit(1); } out(p); }
else if (a[0] === 'pr' && a[1] === 'merge') {
  const p = pr(a[2]); const i = a.indexOf('--match-head-commit');
  if (stackOf(p.number)) { console.error('X Pull request #' + p.number + ' is in a stack: merge it with the merge-async API'); process.exit(1); }
  if (p.headRefOid !== a[i + 1]) { console.error('X Head branch was modified. Review and try the merge again.'); process.exit(1); }
  p.state = 'MERGED';
  // The base moves the way GitHub moves it: a merge commit, or one squashed commit.
  if (st.remote) {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const git = (...x) => require('child_process').execFileSync('git', ['--git-dir', st.remote, ...x], { env }).toString().trim();
    const base = git('rev-parse', 'refs/heads/' + p.baseRefName);
    const c = git('commit-tree', p.headRefOid + '^{tree}', '-p', base, ...(a.includes('--squash') ? [] : ['-p', p.headRefOid]), '-m', 'merge #' + p.number);
    git('update-ref', 'refs/heads/' + p.baseRefName, c);
  }
  save();
}
else if (a[0] === 'pr' && a[1] === 'edit') { pr(a[2]).baseRefName = a[a.indexOf('--base') + 1]; save(); }
else if (a[0] === 'pr' && a[1] === 'ready') { pr(a[2]).isDraft = false; save(); }
else if (a[0] === 'pr' && a[1] === 'close') { pr(a[2]).state = 'CLOSED'; save(); }
else if (a[0] === 'stack' && a[1] === '--version') { if (st.noGhStack) process.exit(1); process.stdout.write('gh stack version 0.2.1'); }
else if (a[0] === 'api' && a[1] === '--include') {
  const rest = a.slice(2);
  const method = rest[0] === '--method' ? rest[1] : 'GET';
  const url = rest[rest[0] === '--method' ? 2 : 0];
  const f = {};
  rest.forEach((x, i) => { if (x === '-f') { const [k, ...v] = rest[i + 1].split('='); f[k] = v.join('='); } });
  const parts = url.split('?')[0].split('/');
  if (parts[3] === 'stacks' && method === 'POST') {
    if (st.stacksOff) http(404, { message: 'Not Found' });
    const prs = rest.flatMap((x, i) => (rest[i - 1] === '-F' && x.startsWith('pull_requests[]=') ? [Number(x.split('=')[1])] : []));
    const onto = parts[4] ? (st.stacks || []).find((s) => s.number === Number(parts[4])) : null;
    const chain = [...(onto ? onto.prs.slice(-1) : []), ...prs];
    for (let i = 1; i < chain.length; i++) if (pr(chain[i]).baseRefName !== pr(chain[i - 1]).headRefName) http(422, { message: 'Validation Failed', errors: [{ message: '#' + chain[i] + ' does not build on #' + chain[i - 1] }] });
    if (onto) { onto.prs.push(...prs); save(); http(200, stackView(onto)); }
    const s = { number: 40 + (st.stacks || []).length, prs }; st.stacks = [...(st.stacks || []), s]; save(); http(201, stackView(s));
  }
  if (parts[3] === 'stacks') { if (st.stacksOff) http(404, { message: 'Not Found' }); http(200, (st.stacks || []).map(stackView)); }
  if (parts[3] === 'pulls' && parts[5] === 'merge-async' && method === 'PUT') {
    const p = pr(parts[4]);
    if (f.sha !== p.headRefOid) http(400, { status: 'failed', details: { message: 'Head branch was modified. Review and try the merge again.' } });
    st.pending = { uuid: 'req-' + p.number + '-0001', n: p.number, method: f.merge_method }; save();
    http(202, { status: 'pending', details: { message: 'Merge request enqueued.', uuid: st.pending.uuid, merge_method: f.merge_method, expected_head_sha: f.sha } });
  }
  if (parts[3] === 'pulls' && parts[5] === 'merge-async' && parts[6]) {
    if (!st.pending || st.pending.uuid !== parts[6]) http(404, { message: 'Not Found' });
    if (st.slow) http(200, { status: 'pending', details: { message: 'Merge request is in progress.', uuid: st.pending.uuid } });
    const n = st.pending.n; st.pending = null;
    if (st.mergeMode === 'enqueue') { const s = stackOf(n); st.queued = s.prs.slice(0, s.prs.indexOf(n) + 1).filter((x) => pr(x).state === 'OPEN'); save(); http(200, { status: 'enqueued', details: { message: 'Pull request was added to the merge queue.' } }); }
    if (st.mergeMode === 'fail') { save(); http(200, { status: 'failed', details: { message: 'Merge conflict: the pull request could not be merged.' } }); }
    land(n); save(); http(200, { status: 'merged', details: { message: 'Pull request was merged.', sha: pr(n).headRefOid } });
  }
  http(404, { message: 'Not Found' });
}
else if (a[0] === 'api' && a.includes('Accept: application/vnd.github.raw')) {
  // Files in the repo for images in markdown: only docs/shot.png on feat/ui exists.
  if (a[a.length - 1] !== 'repos/o/r/contents/docs/shot.png?ref=feat%2Fui') { console.error('gh: Not Found (HTTP 404)'); process.exit(1); }
  process.stdout.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
}
else if (a[0] === 'api' && a[1] === 'graphql') {
  const q = a.find((x) => x.startsWith('query=')) || '';
  if (q.includes('isInMergeQueue')) out({ data: { repository: { pullRequest: { isInMergeQueue: (st.queued || []).includes(Number(a.find((x) => x.startsWith('n=')).slice(2))) } } } });
  else if (q.includes('reviewThreads')) out({ data: { repository: { pullRequest: { reviewThreads: { nodes: st.threads || [] } } } } });
  else { fs.appendFileSync(file + '.log', 'MUTATION ' + q + '\\n'); out({ data: {} }); }
}
else { console.error('unknown gh call: ' + a.join(' ')); process.exit(1); }
`;

async function world() {
  const parent = await mkdtemp(join(tmpdir(), 'ah-review-svc-'));
  const remote = join(parent, 'remote.git');
  const work = join(parent, 'work');
  const local = join(parent, 'local');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['clone', '-q', remote, work], { stdio: 'pipe' });
  const g = (...a: string[]) => execFileSync('git', ['-C', work, ...a], { stdio: 'pipe' }).toString().trim();
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('checkout', '-q', '-b', 'main');
  await writeFile(join(work, 'a.ts'), 'export const a = 1;\n');
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
  const publish = (branch: string, n: number) => {
    g('push', '-q', '-f', 'origin', `${branch}:refs/heads/${branch}`);
    g('push', '-q', '-f', 'origin', `${branch}:refs/pull/${n}/head`);
    return g('rev-parse', branch);
  };
  const bin = join(parent, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  await writeFile(join(bin, 'gh'), GH);
  await chmod(join(bin, 'gh'), 0o755);
  const stateFile = join(parent, 'gh.json');
  return { parent, remote, work, local, g, commit, publish, bin, stateFile };
}

type Pr = Record<string, unknown> & { number: number; headRefName: string; baseRefName: string; headRefOid: string; state: string };
const pr = (number: number, head: string, base: string, sha: string, extra: Record<string, unknown> = {}): Pr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/me/proj/pull/${number}`,
  body: `Body of ${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefName: head,
  baseRefName: base,
  headRefOid: sha,
  baseRefOid: '',
  isCrossRepository: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  author: { login: 'me' },
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...extra,
});

async function withGh<T>(w: { bin: string; stateFile: string }, fn: () => Promise<T>): Promise<T> {
  const saved = { PATH: process.env.PATH, AH_GH_STATE: process.env.AH_GH_STATE };
  process.env.PATH = `${w.bin}:${saved.PATH}`;
  process.env.AH_GH_STATE = w.stateFile;
  try {
    return await fn();
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.AH_GH_STATE === undefined) delete process.env.AH_GH_STATE;
    else process.env.AH_GH_STATE = saved.AH_GH_STATE;
  }
}

async function withFetch(reply: (body: { messages: { role: string; content: string }[]; tools?: unknown[] }) => unknown, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: reply(body) }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

async function setup() {
  const w = await world();
  // main ← #1 base ← #2 feat ← #3 docs, and #4 fix on #1.
  w.g('checkout', '-q', '-b', 'base');
  await w.commit('b.ts', 'export const b = 1;\n', 'base');
  const h1 = w.publish('base', 1);
  w.g('checkout', '-q', '-b', 'feat');
  await w.commit('c.ts', 'export const c = () => 1;\n', 'feat');
  const h2 = w.publish('feat', 2);
  w.g('checkout', '-q', '-b', 'docs');
  await w.commit('README.md', '# c\n', 'docs');
  const h3 = w.publish('docs', 3);
  w.g('checkout', '-q', 'base');
  w.g('checkout', '-q', '-b', 'fix');
  await w.commit('d.ts', 'export const d = 1;\n', 'fix');
  const h4 = w.publish('fix', 4);
  const state = { prs: [pr(1, 'base', 'main', h1), pr(2, 'feat', 'base', h2), pr(3, 'docs', 'feat', h3), pr(4, 'fix', 'base', h4), pr(9, 'other', 'main', h1)], threads: [] as unknown[], remote: w.remote };
  await writeFile(w.stateFile, JSON.stringify(state));
  const dbPath = join(w.parent, 'ah.db');
  await ensureMigrated(dbPath);
  const chat = new SideChatStore(dbPath);
  const sessions: SessionLite[] = [
    { uid: 'u-agent', key: 'claude:conv-1', title: 'Feature work', agent: 'claude', status: 'idle', cwd: w.local, branch: 'feat', live: true },
    { uid: 'u-shell', key: 'u-shell', title: 'zsh', agent: null, status: 'idle', cwd: w.local, branch: 'main', live: true },
  ];
  const sent: { uid: string; text: string; id: string }[] = [];
  const failSend = { on: false, partly: false };
  const alerts: string[] = [];
  const launched: { preset: string; root: string; label: string; fromRef: string }[] = [];
  const transcripts = new Map<string, { prompts: { at: number; text: string }[]; entries: { role: string; at: number; text: string }[] }>();
  const svc = new ReviewService(getDb(dbPath), chat, {
    sessions: async () => sessions,
    send: async (uid, text, id) => {
      if (failSend.on) throw new Error('the session went away');
      if (failSend.partly) throw Object.assign(new Error('Enter failed'), { typed: true });
      sent.push({ uid, text, id });
      return { outcome: 'queued', queueId: 'q1' };
    },
    alert: (p) => alerts.push(p.title),
    changed: () => {},
    readPlan: readTextFile,
    transcript: async (uid) => transcripts.get(uid) ?? null,
    launch: async (p) => {
      launched.push(p);
      const sess: SessionLite = { uid: `u-new${launched.length}`, key: `u-new${launched.length}`, title: p.label, agent: p.preset, status: 'idle', cwd: w.local, branch: `ah/fix-${launched.length}`, live: true };
      sessions.push(sess);
      return sess;
    },
  });
  const setState = async (fn: (s: typeof state) => void) => {
    const cur = JSON.parse(await readFile(w.stateFile, 'utf8'));
    fn(cur);
    await writeFile(w.stateFile, JSON.stringify(cur));
  };
  return { w, svc, db: getDb(dbPath), chat, sessions, sent, failSend, alerts, transcripts, launched, setState, heads: { h1, h2, h3, h4 } };
}

test('review: stack from a PR tree, fix loop through the owner, re-review, merge and next', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    const cands = await t.svc.candidates(t.w.local);
    assert.equal(cands.repo, 'me/proj');
    assert.deepEqual(cands.trees.map((x) => x.pr.number), [9, 1]);

    let v = await t.svc.create(t.w.local, { pr: 1 }, 'Feature');
    await t.svc.sync(v.id);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.layers.map((l) => l.pr), [1, 4, 2, 3], 'the fix before the longer chain');
    assert.equal(v.owner?.uid, 'u-agent', 'the one agent on a stack branch owns it');
    assert.equal(v.trunk, 'main');
    for (const l of v.layers) assert.ok(l.current, `#${l.pr} fetched`);
    const feat = v.layers.find((l) => l.pr === 2)!;
    assert.equal(feat.current!.files, 1, "#2's own patch, not #1's");
    assert.equal(feat.status, 'unreviewed');
    assert.equal(execFileSync('git', ['-C', t.w.local, 'status', '--porcelain']).toString(), '', 'no checkout touched');

    const d = await t.svc.layerDiff(v.id, 2, 'this');
    assert.match(d.text, /c\.ts/);
    assert.doesNotMatch(d.text, /b\.ts/);
    assert.match((await t.svc.layerDiff(v.id, 2, 'cumulative')).text, /b\.ts/);

    // A finding, sent to the owner with the restack of the layer above.
    const f = await t.svc.addFinding(v.id, { ownerPr: 2, title: 'Return 2', body: 'c should return 2.', severity: 'blocking', path: 'c.ts', lineStart: 1 });
    const text = await t.svc.dispatchText(v.id, 2, [f.id]);
    assert.match(text, /\[blocking\] Return 2\. c\.ts:1/);
    assert.match(text, /restack the layers above it.*docs \(#3, [0-9a-f]{8}\) on feat/);
    assert.match(text, /\(ah review [\w-]+\/2\)/);
    // A send that fails leaves nothing behind: no dispatch, the finding still open.
    t.failSend.on = true;
    await assert.rejects(t.svc.dispatch(v.id, 2, { findingIds: [f.id], text }), /went away/);
    t.failSend.on = false;
    assert.equal(await t.db.reviewDispatch.count({ where: { stackId: v.id } }), 0);
    assert.equal((await t.svc.findings(v.id)).find((x) => x.id === f.id)?.state, 'open');
    // A send that typed part of it and then failed: the agent has it, so the record stays.
    t.failSend.partly = true;
    await assert.rejects(t.svc.dispatch(v.id, 2, { findingIds: [], text: 'partial' }), /Enter failed/);
    t.failSend.partly = false;
    assert.equal(await t.db.reviewDispatch.count({ where: { stackId: v.id } }), 1);
    await t.db.reviewDispatch.deleteMany({ where: { stackId: v.id } });
    await t.svc.dispatch(v.id, 2, { findingIds: [f.id], text });
    assert.deepEqual(t.sent.map((s) => s.uid), ['u-agent']);
    // Recorded before it went out, and sent under the record's name (a retry is recognized).
    const row = await t.db.reviewDispatch.findFirst({ where: { stackId: v.id } });
    assert.equal(t.sent[0].id, `rd-${row!.id}`);
    assert.equal(row!.queueId, 'q1');
    v = await t.svc.view(v.id);
    assert.equal(v.layers.find((l) => l.pr === 2)!.status, 'fixing');
    assert.equal(t.svc.state().fixing[0]?.uid, 'u-agent', 'the session shows what it is fixing');

    // The agent works, fixes #2, restacks #3, pushes, and goes idle.
    t.sessions[0].status = 'busy';
    await (t.svc as unknown as { watch(): Promise<void> }).watch();
    t.w.g('checkout', '-q', 'feat');
    await t.w.commit('c.ts', 'export const c = () => 2;\n', 'return 2');
    const h2b = t.w.publish('feat', 2);
    t.w.g('checkout', '-q', 'docs');
    t.w.g('rebase', '-q', 'feat');
    const h3b = t.w.publish('docs', 3);
    await t.setState((s) => {
      s.prs.find((p) => p.number === 2)!.headRefOid = h2b;
      s.prs.find((p) => p.number === 3)!.headRefOid = h3b;
    });
    t.sessions[0].status = 'attention';
    await withFetch(
      () => ({ content: JSON.stringify({ items: [{ id: f.id, verdict: 'addressed', evidence: 'c.ts:1 returns 2' }], unrequested: [], summary: 'Fixed.' }) }),
      async () => {
        await t.chat.put({ name: 'm', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' });
        await (t.svc as unknown as { watch(): Promise<void> }).watch();
        // The re-check runs in the background off the sync.
        for (let i = 0; i < 50 && !(await t.svc.view(v.id)).layers.find((l) => l.pr === 2)!.current?.verdict; i++) await new Promise((r) => setTimeout(r, 20));
      },
    );
    v = await t.svc.view(v.id);
    const l2 = v.layers.find((l) => l.pr === 2)!;
    assert.equal(l2.dispatch?.state, 'done');
    assert.equal(l2.status, 'rereview');
    assert.equal(l2.current!.verdict?.items[0].verdict, 'addressed');
    assert.ok(t.svc.state().alerts.some((a) => a.kind === 'rereview' && a.pr === 2), 'the Inbox hears about it');
    const since = await t.svc.layerDiff(v.id, 2, 'since');
    assert.equal(since.kind, 'patch');
    assert.match(since.text, /\+export const c = \(\) => 2;/);
    // #3 was rebased but its own patch didn't change.
    const l3 = v.layers.find((l) => l.pr === 3)!;
    assert.equal(l3.status, 'unreviewed');

    v = await t.svc.acceptVerdict(v.id, 2);
    assert.equal((await t.svc.findings(v.id, 2)).find((x) => x.id === f.id)!.state, 'addressed');

    // Merge in order: #1 first. Merging #2 now is refused.
    await assert.rejects(t.svc.merge(v.id, 2), /Reviewed revision is current|Next in merge order/);
    v = await t.svc.approve(v.id, 1);
    const gates = v.layers.find((l) => l.pr === 1)!.gates;
    assert.ok(gates.every((g) => g.ok), JSON.stringify(gates));
    assert.ok(t.svc.state().alerts.some((a) => a.kind === 'ready' && a.pr === 1));
    const r = await t.svc.merge(v.id, 1);
    assert.deepEqual(r.retargeted.sort(), [2, 4], 'the layers on #1 now target main');
    assert.deepEqual(r.restack, [], 'a merge commit keeps their patches');
    assert.equal(r.next, 4);
    const log = await readFile(`${t.w.stateFile}.log`, 'utf8');
    assert.match(log, new RegExp(`pr merge 1 --merge --match-head-commit ${t.heads.h1}`));

    // A push after the review blocks the merge at GitHub.
    v = await t.svc.approve(v.id, 4);
    await t.setState((s) => {
      s.prs.find((p) => p.number === 4)!.headRefOid = 'f'.repeat(40);
    });
    await assert.rejects(t.svc.merge(v.id, 4), /Reviewed revision is current|Head branch was modified/);
  });
});

test('review: the whole stack merges in order, marking it reviewed if you say so, and refuses what a gate holds back', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    let v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.layers.map((l) => l.pr), [1, 4, 2, 3]);
    const f = await t.svc.addFinding(v.id, { ownerPr: 2, title: 'Return 2', severity: 'blocking' });
    await assert.rejects(t.svc.mergeStack(v.id, { markReviewed: true }), /#2: 1 blocking/, 'a blocking finding holds the whole stack back');
    await assert.rejects(t.svc.mergeStack(v.id, { upTo: 4 }), /#1: not marked reviewed/, 'without the review mark, nothing goes');
    // Up to #4: the layers above it stay open, findings and all.
    let out = await t.svc.mergeStack(v.id, { markReviewed: true, upTo: 4 });
    assert.deepEqual(out.stopped, null);
    assert.deepEqual(out.merged, [1, 4]);
    assert.equal(out.stopped, null);
    assert.equal(out.next, 2);
    await t.svc.updateFinding(v.id, f.id, { state: 'wontfix', note: 'Not this stack' });
    out = await t.svc.mergeStack(v.id, { markReviewed: true });
    assert.deepEqual(out.merged, [2, 3]);
    assert.equal(out.next, null);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.layers.map((l) => l.state), ['merged', 'merged', 'merged', 'merged']);
    const log = await readFile(`${t.w.stateFile}.log`, 'utf8');
    assert.deepEqual([...log.matchAll(/pr merge (\d+) --merge --match-head-commit/g)].map((m) => Number(m[1])), [1, 4, 2, 3], 'one merge each, bottom up, at the heads it marked reviewed');
    assert.match(log, /pr edit 3 --base main/, 'each layer is pointed at the trunk before its turn');
    await assert.rejects(t.svc.mergeStack(v.id), /nothing left to merge/);
  });
});

test('review: squashing a chain stops after the first layer, which leaves the next to restack', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    const v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id);
    const out = await t.svc.mergeStack(v.id, { method: 'squash', markReviewed: true });
    assert.deepEqual(out.merged, [1]);
    assert.deepEqual(out.restack.sort(), [2, 4]);
    assert.deepEqual(out.stopped, { pr: 4, why: 'it needs a restack onto main first' });
    assert.equal((await t.svc.view(v.id)).mergeMethod, 'squash', 'the method you picked is the stack\'s now');
    assert.match(await readFile(`${t.w.stateFile}.log`, 'utf8'), /pr merge 1 --squash/);
  });
});

test('review: a stack on GitHub merges a run of its layers in one step, and a layer outside it on its own', async () => {
  const t = await setup();
  await t.setState((s) => {
    (s as Record<string, unknown>).remote = t.w.remote;
    (s as Record<string, unknown>).stacks = [{ number: 7, prs: [1, 2, 3] }];
  });
  await withGh(t.w, async () => {
    const v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id, true);
    const out = await t.svc.mergeStack(v.id, { markReviewed: true });
    assert.deepEqual(out.merged, [1, 4, 2, 3]);
    assert.equal(out.stopped, null);
    const log = await readFile(`${t.w.stateFile}.log`, 'utf8');
    assert.deepEqual([...log.matchAll(/pulls\/(\d+)\/merge-async -f/g)].map((m) => Number(m[1])), [1, 3], "#1 alone (#4 comes next), then #2 and #3 in one stack merge of #3");
    assert.match(log, /pr merge 4 --merge/);
  });
});

test('review: the agent can be asked to merge the stack, told how each layer lands, and it is done when the layers have', async () => {
  const t = await setup();
  await t.setState((s) => {
    (s as Record<string, unknown>).stacks = [{ number: 7, prs: [1, 2, 3] }];
  });
  await withGh(t.w, async () => {
    const v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id, true);
    let text = await t.svc.mergeText(v.id, 'squash');
    assert.match(text, /^Please merge the stack "PR 1" \(me\/proj\) into main, bottom up, with squash merges\./);
    assert.match(text, /\n1\. #1 "PR 1": base at [0-9a-f]{12}, in GitHub stack #7\n2\. #4 "PR 4": fix at [0-9a-f]{12}\n/);
    assert.match(text, /\n- #1: gh stack merge 1 --squash --yes lands it with the rest of GitHub stack #7 under 1/);
    assert.match(text, /\n- #4: point it at main \(gh pr edit 4 --base main\), rebase its own commits onto origin\/main \(git rebase --onto origin\/main [0-9a-f]{12} fix\), run the tests, push with --force-with-lease and wait for its checks, then gh pr merge 4 --squash --match-head-commit <its new head>\./);
    assert.match(text, /\n- #2, #3: gh stack merge 3 --squash --yes/);
    await t.svc.addFinding(v.id, { ownerPr: 2, title: 'Return 2', severity: 'blocking' });
    text = await t.svc.mergeText(v.id, 'merge');
    assert.match(text, /\n- #4: point it at main \(gh pr edit 4 --base main\), then gh pr merge 4 --merge --match-head-commit [0-9a-f]{40}\./);
    assert.match(text, /\n- Stop before #2: 1 blocking\. Tell me what's left instead of merging past it\./);
    assert.doesNotMatch(text, /gh stack merge 3/);

    // Sent to the agent for the layers up to #4. A merge pushes nothing: it's done when #4 has landed.
    await t.svc.dispatch(v.id, 4, { findingIds: [], text, targetUid: 'u-agent', kind: 'merge' });
    const watch = () => (t.svc as unknown as { watch(): Promise<void> }).watch();
    t.sessions[0].status = 'busy';
    await watch();
    t.sessions[0].status = 'idle';
    await t.setState((s) => {
      for (const p of s.prs) if (p.number === 1 || p.number === 4) p.state = 'MERGED';
    });
    await watch();
    const after = await t.svc.view(v.id);
    assert.deepEqual(after.layers.map((l) => [l.pr, l.state]), [[1, 'merged'], [4, 'merged'], [2, 'open'], [3, 'open']]);
    assert.equal((await t.db.reviewDispatch.findFirst({ where: { stackId: v.id, pr: 4 } }))?.state, 'done');
    assert.ok(!t.svc.state().alerts.some((a) => a.kind === 'nopush'), 'no "finished without pushing" for a merge that landed');
  });
});

test('review: the reviewer reads pinned revisions through tools and proposes findings you keep or dismiss', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    await t.chat.put({ name: 'm', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' });
    const v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id);
    // The agent is mid-edit on another branch: the reviewer must not see it.
    await writeFile(join(t.w.local, 'c.ts'), 'WORKING TREE\n');
    let calls = 0;
    let toolResult = '';
    await withFetch(
      (body) => {
        calls++;
        if (calls === 1) {
          assert.ok(body.tools?.length, 'review tools offered');
          assert.match(body.messages[0].content, /You are reviewing #2/);
          return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'c.ts', pr: 2 }) } }] };
        }
        toolResult = body.messages.find((m) => m.role === 'tool')!.content;
        return {
          content: JSON.stringify({
            content: '### Looks fine\nOne thing.',
            followups: [{ title: 'Fix it', kind: 'session', text: 'Please fix c.ts' }],
            findings: [{ title: 'Name the return', body: 'why', severity: 'nit', path: 'c.ts', line_start: 1, owner_pr: 1 }, { title: 'Bad owner', owner_pr: 777 }],
          }),
        };
      },
      async () => {
        const r = await t.svc.ask(v.id, 2, 'Is this right?');
        assert.equal(r.message.text, '### Looks fine\nOne thing.');
        assert.equal(r.followups[0].kind, 'session');
        assert.equal(r.findings.length, 2);
        assert.equal(r.findings[0].state, 'proposed');
        assert.equal(r.findings[0].ownerPr, 1, 'owned by the layer that should change');
        assert.equal(r.findings[1].ownerPr, 2, 'an unknown layer falls back to the one discussed');
      },
    );
    assert.match(toolResult, /export const c = \(\) => 1;/, 'read at the PR head, not the working tree');
    const thread = await t.svc.thread(v.id);
    assert.deepEqual(thread.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(thread.findings.length, 2);
    assert.equal(thread.subscriptionId, await t.chat.defaultId(), 'nothing picked here: the active subscription answers');
    const other = (await t.chat.put({ name: 'n', baseUrl: 'https://y.test/v1', model: 'n', apiKey: 'k' })).id;
    await withFetch(
      () => ({ content: JSON.stringify({ content: 'ok', followups: [], findings: [] }) }),
      () => t.svc.ask(v.id, 2, 'Again?', other).then(() => {}),
    );
    assert.equal((await t.svc.thread(v.id)).subscriptionId, other, "a pick sticks to the stack's conversation");
    // Proposals don't count until kept.
    let view = await t.svc.view(v.id);
    assert.equal(view.layers.find((l) => l.pr === 1)!.open, 0);
    await t.svc.updateFinding(v.id, thread.findings[0].id, { state: 'open' });
    view = await t.svc.view(v.id);
    assert.equal(view.layers.find((l) => l.pr === 1)!.open, 1);
  });
});

test('review: a stack has one conversation that follows you between layers, with what you attach spelled out', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    await t.chat.put({ name: 'm', baseUrl: 'https://x.test/v1', model: 'm', apiKey: 'k' });
    const v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id);
    // A question from the time each layer had its own thread.
    await t.db.chatMessage.create({ data: { uid: `review:${v.id}:2`, role: 'user', text: 'Old question', at: 1 } });
    await t.db.chatMessage.create({ data: { uid: `review:${v.id}:2`, role: 'assistant', text: 'Old answer', at: 1 } });
    const f = await t.svc.addFinding(v.id, { ownerPr: 2, title: 'Return a name', body: 'Callers need it.', severity: 'blocking', path: 'c.ts', lineStart: 1 });
    const seen: { role: string; content: string }[][] = [];
    await withFetch(
      (body) => {
        seen.push(body.messages);
        return { content: JSON.stringify({ content: 'ok', followups: [], findings: [] }) };
      },
      async () => {
        const r = await t.svc.ask(v.id, 2, 'Is this the right fix?', undefined, [
          { kind: 'finding', id: f.id },
          { kind: 'lines', pr: 2, path: 'c.ts', start: 1, end: 1, text: '+export const c = () => 1;' },
          { kind: 'file', pr: 2, path: 'c.ts' },
        ]);
        assert.equal(r.asked.pr, 2);
        assert.deepEqual(r.asked.context.map((c) => c.label), ['Return a name', 'c.ts:1', 'c.ts']);
        await t.svc.ask(v.id, 1, 'And under it?');
        await t.svc.ask(v.id, null, 'The whole thing?');
      },
    );
    const first = seen[0].at(-1)!.content;
    assert.match(first, /^Is this the right fix\?\n\nAttached:/);
    assert.match(first, new RegExp(`Finding F${f.id} \\[blocking, open, from you\\] owned by #2: Return a name \\(c\\.ts:1\\)\nCallers need it\\.`));
    assert.match(first, /Lines c\.ts:1 of #2, as the diff shows them:\n```diff\n\+export const c = \(\) => 1;\n```/);
    assert.match(first, /The file c\.ts, as #2 changes it:\n```diff\ndiff --git a\/c\.ts b\/c\.ts/, "the file's change, read at the layer's revisions");
    assert.match(seen[0][0].content, /You are reviewing #2/);
    // The next question, on another layer, sees the conversation so far and where each turn was.
    const history = seen[1].filter((m) => m.role === 'user').map((m) => m.content);
    assert.deepEqual(history.slice(0, 2), ['[On #2] Old question', `[On #2 · attached finding F${f.id}, c.ts:1, c.ts] Is this the right fix?`]);
    assert.match(seen[1][0].content, /You are reviewing #1/);
    assert.match(seen[2][0].content, /discussing the stack as a whole/);
    const thread = await t.svc.thread(v.id);
    assert.deepEqual(
      thread.messages.map((m) => [m.role, m.pr]),
      [['user', 2], ['assistant', 2], ['user', 2], ['assistant', 2], ['user', 1], ['assistant', 1], ['user', null], ['assistant', null]],
    );
    assert.equal(thread.messages[2].context.length, 3);
    await t.svc.clearThread(v.id);
    assert.equal((await t.svc.thread(v.id)).messages.length, 0, 'clearing takes the old per-layer rows too');
  });
});

test('review: GitHub threads become findings once; resolving replies and resolves', async () => {
  const t = await setup();
  await t.setState((s) => {
    s.threads = [
      { id: 'PRRT_1', isResolved: false, isOutdated: false, path: 'c.ts', line: 1, startLine: null, comments: { nodes: [{ author: { login: 'chatgpt-codex-connector' }, body: '**P1 Badge** Return value is wrong', url: 'https://gh/x', createdAt: '' }] } },
      { id: 'PRRT_2', isResolved: true, isOutdated: false, path: null, line: null, startLine: null, comments: { nodes: [{ author: { login: 'me' }, body: 'nit: naming', url: '', createdAt: '' }] } },
    ];
  });
  await withGh(t.w, async () => {
    const v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id);
    assert.deepEqual(await t.svc.importThreads(v.id, 2), { added: 2 });
    assert.deepEqual(await t.svc.importThreads(v.id, 2), { added: 0 }, 'once each');
    const fs = await t.svc.findings(v.id, 2);
    const bot = fs.find((f) => f.source === 'bot:chatgpt-codex-connector')!;
    assert.equal(bot.severity, 'blocking');
    assert.equal(bot.state, 'open');
    assert.equal(bot.title, 'Return value is wrong');
    assert.doesNotMatch(bot.body, /Badge/);
    assert.equal(fs.find((f) => f.source === 'gh:me')!.state, 'addressed');
    const done = await t.svc.resolveThread(v.id, bot.id, 'Fixed in abc.');
    assert.equal(done.state, 'addressed');
    const log = await readFile(`${t.w.stateFile}.log`, 'utf8');
    assert.match(log, /MUTATION .*addPullRequestReviewThreadReply/);
    assert.match(log, /MUTATION .*resolveReviewThread/);
  });
});

test('review: bot thread titles lose their badges and markup', () => {
  const codex = threadTitle('**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Keep schema-only validity after rebuilds**\n\nAfter a passing run, resetField() flips valid.');
  assert.deepEqual([codex.title, codex.level], ['Keep schema-only validity after rebuilds', 'should']);
  const plain = threadTitle('nit: rename this. It reads oddly.');
  assert.deepEqual([plain.title, plain.level], ['nit: rename this.', null]);
});

test('review: a GitHub comment keeps its markdown, less the badge and the heading that became its title', () => {
  const codex = threadTitle("**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Take the schema's graph**\n\n`dependents()` reads a module-level `Map`:\n\n```suggestion\nexport function plan(changed: string[], graph: Relationship[]) {\n```\n\n<details><summary>Why</summary>\n\nShared state.\n\n</details><!-- codex -->");
  assert.equal(codex.title, "Take the schema's graph");
  assert.equal(codex.level, 'blocking');
  assert.ok(codex.markdown.startsWith('`dependents()` reads'), codex.markdown);
  assert.match(codex.markdown, /```suggestion\n/);
  assert.match(codex.markdown, /<details><summary>Why<\/summary>/);
  assert.doesNotMatch(codex.markdown, /Badge|<!--/);
  // CodeRabbit leads with a label; its bold line is the title.
  const rabbit = threadTitle("_⚠️ Potential issue_\n\n**`changed()` runs rules for missing fields.**\n\n| Field | Runs |\n| --- | --- |\n| `confirm` | yes |");
  assert.equal(rabbit.title, 'changed() runs rules for missing fields.');
  assert.match(rabbit.markdown, /^_⚠️ Potential issue_\n\n\| Field/);
  // A person's comment is all body; the title is its first sentence, as plain text.
  const person = threadTitle('Agreed. Keep the walk **one hop** for now.');
  assert.deepEqual([person.title, person.markdown], ['Agreed. Keep the walk one hop for now.', 'Agreed. Keep the walk **one hop** for now.']);
  assert.equal(replyMark('coderabbitai[bot]', '2026-10-15T11:00:00Z'), '<!-- ah:reply coderabbitai[bot] 2026-10-15T11:00:00Z -->');
  assert.doesNotMatch(replyMark('x --> <script>', 'now -->').slice(0, -4), />/, 'a login or time can\'t close the marker');
});

test('review: a GitHub image comes through gh, a ref with a slash included', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    const v = await t.svc.create(t.w.local, { pr: 1 });
    const img = await t.svc.image(v.id, 'https://github.com/o/r/blob/feat/ui/docs/shot.png?raw=true');
    assert.equal(img?.type, 'image/png');
    assert.equal(img?.body.length, 11);
    assert.equal(await t.svc.image(v.id, 'https://github.com/o/r/blob/feat/ui/docs/missing.png?raw=true'), null);
    assert.equal(await t.svc.image(v.id, 'https://img.shields.io/badge/P1-orange'), null, 'not GitHub: never fetched');
  });
});

test('review: images ah reads from GitHub, and the ones it leaves alone', () => {
  assert.deepEqual(imageSource('https://github.com/ealush/ah/blob/pr-screenshots/pr21/after.png?raw=true'), { kind: 'file', repo: 'ealush/ah', parts: ['pr-screenshots', 'pr21', 'after.png'] });
  assert.deepEqual(imageSource('https://github.com/o/r/raw/main/docs/a%20b.png'), { kind: 'file', repo: 'o/r', parts: ['main', 'docs', 'a b.png'] });
  assert.deepEqual(imageSource('https://raw.githubusercontent.com/o/r/refs/heads/feat/x/img.png'), { kind: 'file', repo: 'o/r', parts: ['feat', 'x', 'img.png'] });
  assert.deepEqual(imageSource('https://github.com/user-attachments/assets/0b5e-11aa'), { kind: 'upload', url: 'https://github.com/user-attachments/assets/0b5e-11aa' });
  assert.equal(imageSource('https://private-user-images.githubusercontent.com/1/2.png?jwt=x')?.kind, 'upload');
  for (const bad of ['https://img.shields.io/badge/P1-orange', 'http://github.com/o/r/blob/main/a.png', 'https://github.com.evil.test/o/r/blob/main/a.png', 'https://user:pw@github.com/o/r/blob/main/a.png', 'https://github.com/o/r/blob/main/..%2F..%2Fsecret', 'https://github.com/o/r/pulls', 'file:///etc/passwd', 'not a url'])
    assert.equal(imageSource(bad), null, bad);
});

test('review: plan labels, merge order rules, skipped layers', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    let v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id);
    v = await t.svc.view(v.id);
    const plan = join(t.w.parent, 'plan.md');
    await writeFile(plan, '# Schema relationships: current feature plan\n\n| Owner | PR |\n|---|---|\n| H0 | #1 |\n| F1 | #2 |\n');
    v = await t.svc.update(v.id, { planPath: plan });
    assert.equal(v.title, 'Schema relationships', "a stack named after its bottom PR takes the plan's title");
    assert.equal(v.layers.find((l) => l.pr === 1)!.role, 'H0');
    assert.equal(v.layers.find((l) => l.pr === 2)!.role, 'F1');
    assert.match((await t.svc.plan(v.id)).text!, /H0/);
    await assert.rejects(t.svc.update(v.id, { order: [2, 1, 3, 4] }), /each after the one it sits on/);
    v = await t.svc.update(v.id, { order: [1, 2, 3, 4] });
    assert.deepEqual(v.layers.map((l) => l.pr), [1, 2, 3, 4]);
    v = await t.svc.setLayer(v.id, 2, { skipped: true });
    assert.equal(v.layers.find((l) => l.pr === 2)!.status, 'skipped');
    await t.svc.remove(v.id);
    assert.equal(execFileSync('git', ['-C', t.w.local, 'for-each-ref', 'refs/ah-review/']).toString(), '', 'refs dropped with the stack');
  });
});

test('review: a stack you pick keeps your PRs in your order; PRs join only when you add them', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    // Built on #1's branch, #2 can't come before it.
    await assert.rejects(t.svc.create(t.w.local, { prs: [2, 1] }), /#2 is built on #1/);
    await assert.rejects(t.svc.create(t.w.local, { prs: [1, 1] }), /once/);
    await assert.rejects(t.svc.create(t.w.local, { prs: [] }), /at least one/);
    await assert.rejects(t.svc.create(t.w.local, { prs: [1, 77] }), /#77 is not an open pull request/);

    let v = await t.svc.create(t.w.local, { prs: [1, 4, 9] }, 'Picked');
    await t.svc.sync(v.id);
    v = await t.svc.view(v.id);
    assert.equal(v.source, 'manual');
    assert.equal(v.title, 'Picked');
    assert.equal(v.trunk, 'main');
    // #2 sits on #1's branch, but a picked stack doesn't take it in by itself.
    assert.deepEqual(v.layers.map((l) => l.pr), [1, 4, 9]);
    const summary = (await t.svc.list()).find((s) => s.id === v.id)!;
    assert.equal(summary.source, 'manual');
    assert.deepEqual(summary.spine.map((x) => x.pr), [1, 4, 9]);

    // Taken PRs are taken; the candidates say where.
    await assert.rejects(t.svc.create(t.w.local, { prs: [4] }), /already in a stack/);
    const cands = await t.svc.candidates(t.w.local);
    assert.deepEqual(cands.stacks, [{ id: v.id, title: 'Picked' }]);
    assert.equal(cands.trees.find((x) => x.pr.number === 9)!.pr.inStack, v.id);

    v = await t.svc.addLayers(v.id, [2]);
    assert.deepEqual(v.layers.map((l) => l.pr), [1, 4, 9, 2]);
    await assert.rejects(t.svc.addLayers(v.id, [2]), /already in this stack/);

    await t.svc.addFinding(v.id, { ownerPr: 4, title: 'Gone with its layer' });
    v = await t.svc.removeLayer(v.id, 4);
    assert.deepEqual(v.layers.map((l) => l.pr), [1, 9, 2]);
    assert.equal((await t.svc.findings(v.id)).length, 0);

    // A tree stack you trim becomes yours: new children stop joining.
    const tree = await t.svc.create(t.w.local, { pr: 3 });
    assert.equal(tree.source, 'tree');
  });
});

test('review: waiving a blocking finding takes a reason; every state change says who and at which head; merged layers leave follow-ups', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    let v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id);
    const block = await t.svc.addFinding(v.id, { ownerPr: 2, title: 'Blocks it', severity: 'blocking' });
    assert.equal(block.stateBy, 'you');
    await assert.rejects(t.svc.updateFinding(v.id, block.id, { state: 'wontfix' }), /say why/);
    const waived = await t.svc.updateFinding(v.id, block.id, { state: 'wontfix', note: 'Covered by the F3 refactor' });
    assert.equal(waived.state, 'wontfix');
    assert.equal(waived.note, 'Covered by the F3 refactor');
    const listed = (await t.svc.findings(v.id)).find((f) => f.id === block.id)!;
    assert.equal(listed.stateBy, 'you');
    assert.equal(listed.stateHead, t.heads.h2.slice(0, 7));
    // A non-blocking one needs no reason.
    const nit = await t.svc.addFinding(v.id, { ownerPr: 2, title: 'Nit', severity: 'nit' });
    assert.equal((await t.svc.updateFinding(v.id, nit.id, { state: 'wontfix' })).state, 'wontfix');

    // #1 merges with a finding still open on it: the next open layer gets it as a follow-up.
    const left = await t.svc.addFinding(v.id, { ownerPr: 1, title: 'Name the base type' });
    await t.setState((st) => {
      st.prs.find((p) => p.number === 1)!.state = 'MERGED';
    });
    await t.svc.sync(v.id);
    v = await t.svc.view(v.id);
    const next = v.layers.find((l) => l.pr === v.next)!;
    assert.equal(next.followups, 1);
    const text = await t.svc.dispatchText(v.id, next.pr, [left.id]);
    assert.match(text, /Found on #1, already merged: fix it in this layer/);
    await t.svc.dispatch(v.id, next.pr, { findingIds: [left.id], text, targetUid: 'u-agent' });
    const moved = (await t.svc.findings(v.id)).find((f) => f.id === left.id)!;
    assert.equal(moved.ownerPr, next.pr);
    assert.equal(moved.state, 'sent');
  });
});

test('review: a GitHub stack merges through GitHub, with the layers under it, and gh stack restacks it', async () => {
  const t = await setup();
  await t.setState((s) => {
    (s as Record<string, unknown>).remote = t.w.remote;
    (s as Record<string, unknown>).stacks = [{ number: 7, prs: [1, 2, 3] }];
  });
  await withGh(t.w, async () => {
    // A review that leaves out the bottom of GitHub's stack can't merge the layers above it.
    let v = await t.svc.create(t.w.local, { prs: [2, 3] });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.layers.map((l) => [l.pr, l.ghStack, l.ghPos]), [[2, 7, 2], [3, 7, 3]]);
    assert.equal(v.layers[0].gates.find((g) => g.key === 'below')?.detail, "#1 merges with it and isn't in this review");
    await t.svc.remove(v.id);

    v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.layers.map((l) => [l.pr, l.ghStack]), [[1, 7], [4, null], [2, 7], [3, 7]]);
    const g2 = v.layers.find((l) => l.pr === 2)!.gates;
    assert.equal(g2.find((g) => g.key === 'base')?.label, 'Lands in main', 'a stacked PR lands in the stack base, whatever it targets');
    assert.ok(g2.find((g) => g.key === 'base')!.ok);
    assert.equal(g2.find((g) => g.key === 'below')?.ok, false, '#1 is not reviewed yet');
    assert.equal(v.layers.find((l) => l.pr === 1)!.gates.find((g) => g.key === 'below'), undefined, 'the bottom merges alone');

    // Fixing #2: gh stack restacks #3 on it; #4, outside GitHub's stack, isn't above #2.
    let text = await t.svc.dispatchText(v.id, 2, []);
    assert.match(text, /gh stack rebase --upstack, then gh stack push, which restacks #3 on it/);
    assert.match(text, /GitHub stack #7; if this checkout doesn't track it, run gh stack checkout 2 first/);
    assert.doesNotMatch(text, /--force-with-lease/);
    // Fixing #1: #2 and #3 by gh stack, #4 by hand.
    text = await t.svc.dispatchText(v.id, 1, []);
    assert.match(text, /which restacks #2, #3 on it/);
    assert.match(text, /layers above it that are outside the GitHub stack.*fix \(#4, [0-9a-f]{8}\) on base/);

    // A push to #2 that leaves #3 behind: GitHub won't merge the stack until #3 is restacked.
    t.w.g('checkout', '-q', 'feat');
    await t.w.commit('c.ts', 'export const c = () => 3;\n', 'three');
    const h2b = t.w.publish('feat', 2);
    await t.setState((s) => {
      s.prs.find((p) => p.number === 2)!.headRefOid = h2b;
    });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    const l3 = v.layers.find((l) => l.pr === 3)!;
    assert.equal(l3.needs, 'restack');
    assert.equal(l3.gates.find((g) => g.key === 'mergeable')?.detail, 'Not on top of feat: needs a restack');
    assert.match(await t.svc.restackText(v.id, 3), /no longer sits on top of feat.*\n.*gh stack checkout 3 .*gh stack rebase and gh stack push/);
    t.w.g('checkout', '-q', 'docs');
    t.w.g('rebase', '-q', 'feat');
    const h3b = t.w.publish('docs', 3);
    await t.setState((s) => {
      s.prs.find((p) => p.number === 3)!.headRefOid = h3b;
    });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.equal(v.layers.find((l) => l.pr === 3)!.needs, '', 'restacked');

    // Merge #2 ahead of #4: GitHub lands #1 with it, one request, at #2's reviewed head.
    await t.svc.approve(v.id, 1);
    v = await t.svc.approve(v.id, 2);
    const l2 = v.layers.find((l) => l.pr === 2)!;
    assert.ok(l2.gates.find((g) => g.key === 'below')!.ok, JSON.stringify(l2.gates));
    assert.deepEqual(l2.gates.filter((g) => !g.ok).map((g) => g.key), ['order']);
    const r = await t.svc.merge(v.id, 2, { outOfOrder: true });
    assert.deepEqual(r.merged, [1, 2]);
    assert.equal(r.waiting, null);
    assert.deepEqual(r.retargeted, [4], 'ah retargets the layer outside the stack; GitHub moves #3');
    const log = await readFile(`${t.w.stateFile}.log`, 'utf8');
    assert.match(log, new RegExp(`api --include --method PUT repos/me/proj/pulls/2/merge-async -f merge_method=merge -f sha=${h2b}`));
    assert.doesNotMatch(log, /pr merge/);
    assert.doesNotMatch(log, /pr edit 3/);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.layers.map((l) => [l.pr, l.state]), [[1, 'merged'], [4, 'open'], [2, 'merged'], [3, 'open']]);
    const after3 = v.layers.find((l) => l.pr === 3)!;
    assert.equal(after3.baseRef, 'main');
    assert.equal(after3.needs, '');
    assert.equal(after3.current!.files, 1, "#3's own patch on the new main");

    // Through a merge queue: queued until the queue lets go of it.
    await t.setState((s) => {
      (s as Record<string, unknown>).mergeMode = 'enqueue';
    });
    await t.svc.approve(v.id, 4);
    v = await t.svc.approve(v.id, 3);
    const q = await t.svc.merge(v.id, 3, { outOfOrder: true });
    assert.equal(q.waiting, 'queue');
    v = await t.svc.view(v.id);
    assert.equal(v.layers.find((l) => l.pr === 3)!.needs, 'queued');
    assert.equal(v.layers.find((l) => l.pr === 3)!.gates.find((g) => g.key === 'mergeable')?.detail, 'In the merge queue');
    await t.svc.sync(v.id, true);
    assert.equal((await t.svc.view(v.id)).layers.find((l) => l.pr === 3)!.needs, 'queued', 'still in the queue');
    await t.setState((s) => {
      (s as Record<string, unknown>).queued = [];
    });
    await t.svc.sync(v.id, true);
    assert.equal((await t.svc.view(v.id)).layers.find((l) => l.pr === 3)!.needs, '', 'ejected from the queue');

    // GitHub's own refusal comes back as the error.
    await t.setState((s) => {
      (s as Record<string, unknown>).mergeMode = 'fail';
    });
    await assert.rejects(t.svc.merge(v.id, 3, { outOfOrder: true }), /Merge conflict: the pull request could not be merged/);
  });
});

test('review: without gh stack on the host, a GitHub stack is restacked by hand', async () => {
  const t = await setup();
  await t.setState((s) => {
    (s as Record<string, unknown>).stacks = [{ number: 7, prs: [1, 2, 3] }];
    (s as Record<string, unknown>).noGhStack = true;
  });
  await withGh(t.w, async () => {
    const v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id, true);
    const text = await t.svc.dispatchText(v.id, 2, []);
    assert.doesNotMatch(text, /gh stack/);
    assert.match(text, /restack the layers above it, in this order.*docs \(#3/);
    assert.match(await t.svc.restackText(v.id, 3), /git rebase --onto origin\/feat [0-9a-f]{12} docs/);
  });
});

test('review: a repo without GitHub stacks merges the classic way', async () => {
  const t = await setup();
  await t.setState((s) => {
    (s as Record<string, unknown>).stacksOff = true;
  });
  await withGh(t.w, async () => {
    let v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id, true);
    v = await t.svc.approve(v.id, 1);
    assert.ok(v.layers.every((l) => l.ghStack === null));
    const r = await t.svc.merge(v.id, 1);
    assert.deepEqual(r.merged, [1]);
    assert.deepEqual(r.retargeted.sort(), [2, 4]);
    assert.match(await readFile(`${t.w.stateFile}.log`, 'utf8'), /pr merge 1 --merge --match-head-commit/);
  });
});

test('review: a stack merge GitHub is still running is watched until it lands or fails', async () => {
  const t = await setup();
  await t.setState((s) => {
    Object.assign(s, { remote: t.w.remote, stacks: [{ number: 7, prs: [1, 2, 3] }], slow: true });
  });
  await withGh(t.w, async () => {
    const svc = t.svc as unknown as { mergeWait: number; watch(): Promise<void> };
    svc.mergeWait = 0;
    let v = await t.svc.create(t.w.local, { pr: 1 });
    await t.svc.sync(v.id, true);
    await t.svc.approve(v.id, 1);
    const r = await t.svc.merge(v.id, 1);
    assert.equal(r.waiting, 'github');
    v = await t.svc.view(v.id);
    assert.equal(v.layers.find((l) => l.pr === 1)!.needs, 'merging');
    assert.equal(v.layers.find((l) => l.pr === 1)!.gates.find((g) => g.key === 'mergeable')?.detail, 'GitHub is merging it');
    await t.svc.sync(v.id, true);
    assert.equal((await t.svc.view(v.id)).layers.find((l) => l.pr === 1)!.needs, 'merging', 'kept across syncs');
    await svc.watch();
    assert.equal((await t.svc.view(v.id)).layers.find((l) => l.pr === 1)!.needs, 'merging', 'still running');
    await t.setState((s) => {
      Object.assign(s, { slow: false });
    });
    await svc.watch();
    v = await t.svc.view(v.id);
    assert.equal(v.layers.find((l) => l.pr === 1)!.state, 'merged');

    // One that fails on GitHub comes back open, with a push saying why.
    await t.setState((s) => {
      Object.assign(s, { slow: true });
    });
    await t.svc.approve(v.id, 4);
    await t.svc.merge(v.id, 4).catch(() => {});
    v = await t.svc.approve(v.id, 2);
    assert.equal((await t.svc.merge(v.id, 2, { outOfOrder: true })).waiting, 'github');
    await t.setState((s) => {
      Object.assign(s, { slow: false, mergeMode: 'fail' });
    });
    await svc.watch();
    v = await t.svc.view(v.id);
    assert.equal(v.layers.find((l) => l.pr === 2)!.needs, '');
    assert.equal(v.layers.find((l) => l.pr === 2)!.state, 'open');
    assert.ok(t.alerts.some((a) => a === "#2 didn't merge"), t.alerts.join(' | '));
  });
});

test('review: a stack on GitHub is offered whole, and the review follows it', async () => {
  const t = await setup();
  await t.setState((s) => {
    Object.assign(s, { stacks: [{ number: 7, prs: [1, 2] }] });
  });
  await withGh(t.w, async () => {
    const c = await t.svc.candidates(t.w.local);
    assert.deepEqual(c.native, [{ number: 7, base: 'main', prs: [1, 2] }]);

    let v = await t.svc.create(t.w.local, { native: 7 });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.equal(v.source, 'native');
    assert.equal(v.ghStack, 7);
    assert.deepEqual(v.layers.map((l) => l.pr), [1, 2], "GitHub's stack only: #4 sits on #1 but isn't in it");
    await assert.rejects(t.svc.create(t.w.local, { native: 8 }), /has no stack #8 on GitHub/);

    // #3 is added to the stack on GitHub: it joins, above #2.
    await t.setState((s) => {
      Object.assign(s, { stacks: [{ number: 7, prs: [1, 2, 3] }] });
    });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.layers.map((l) => [l.pr, l.ghPos]), [[1, 1], [2, 2], [3, 3]]);
    assert.ok(v.layers.find((l) => l.pr === 3)!.current, 'fetched on the same sync');

    // Unstacked on GitHub: the review keeps its layers and stops following.
    await t.setState((s) => {
      Object.assign(s, { stacks: [] });
    });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.equal(v.source, 'manual');
    assert.equal(v.ghStack, null);
    assert.deepEqual(v.layers.map((l) => [l.pr, l.ghStack]), [[1, null], [2, null], [3, null]]);
  });
});

test('review: a chain in review becomes a stack on GitHub, or goes on top of one', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    // #1 ← #2 ← #3, picked: a chain, so it can be linked.
    let v = await t.svc.create(t.w.local, { prs: [1, 2, 3] });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.link, { ok: true, prs: [1, 2, 3], onto: null, why: null });
    v = await t.svc.link(v.id);
    assert.equal(v.source, 'native');
    assert.equal(v.ghStack, 40);
    assert.deepEqual(v.layers.map((l) => [l.pr, l.ghStack, l.ghPos]), [[1, 40, 1], [2, 40, 2], [3, 40, 3]]);
    assert.equal(v.link, null, 'nothing left to link');
    assert.match(await readFile(`${t.w.stateFile}.log`, 'utf8'), /api --include --method POST repos\/me\/proj\/stacks -F pull_requests\[\]=1 -F pull_requests\[\]=2 -F pull_requests\[\]=3/);
    await t.svc.remove(v.id);

    // #4 sits on #1, not on #3: not a chain.
    await t.setState((s) => {
      Object.assign(s, { stacks: [] });
    });
    v = await t.svc.create(t.w.local, { prs: [1, 2, 4] });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.equal(v.link?.ok, false);
    assert.equal(v.link?.why, "#4 isn't built on #2, the layer before it");
    await assert.rejects(t.svc.link(v.id), /#4 isn't built on #2/);
    await t.svc.remove(v.id);

    // #1 ← #2 are a stack on GitHub already: #3 goes on top.
    await t.setState((s) => {
      Object.assign(s, { stacks: [{ number: 7, prs: [1, 2] }] });
    });
    v = await t.svc.create(t.w.local, { prs: [1, 2, 3] });
    await t.svc.sync(v.id, true);
    v = await t.svc.view(v.id);
    assert.deepEqual(v.link, { ok: true, prs: [3], onto: 7, why: null });
    v = await t.svc.link(v.id);
    assert.deepEqual(v.layers.map((l) => [l.pr, l.ghStack]), [[1, 7], [2, 7], [3, 7]]);
    assert.match(await readFile(`${t.w.stateFile}.log`, 'utf8'), /--method POST repos\/me\/proj\/stacks\/7\/add -F pull_requests\[\]=3/);
  });
});

test('review: a stack remembers the session that made it, and the reviewer reads its conversation', async () => {
  const t = await setup();
  t.sessions.push({ uid: 'u-old', key: 'claude:conv-0', title: 'Relationships stack', agent: 'claude', status: 'ended', cwd: t.w.local, branch: null, live: false });
  t.transcripts.set('u-old', {
    prompts: [
      { at: Date.parse('2026-10-16T09:00:00Z'), text: 'Build schema relationships as a stack of small PRs.' },
      { at: Date.parse('2026-10-16T10:00:00Z'), text: 'Keep the planner pure; no module state.' },
    ],
    entries: [
      { role: 'user', at: 1, text: 'Build schema relationships as a stack of small PRs.' },
      { role: 'assistant', at: 2, text: 'I split it in four. The planner stays pure, so it takes the graph as an argument.' },
      { role: 'tool', at: 3, text: 'gh pr create --base base --head feat' },
    ],
  });
  await withGh(t.w, async () => {
    // Started from the session that built it: it made the stack and gets the fixes.
    let v = await t.svc.create(t.w.local, { pr: 1 }, undefined, 'u-old');
    assert.equal(v.origin?.uid, 'u-old');
    assert.equal(v.origin?.live, false);
    assert.equal(v.owner?.uid, 'u-old');
    const owners = await t.svc.ownerSuggestions(v.id);
    assert.equal(owners[0].uid, 'u-old', 'the maker comes first, ended or not');
    assert.ok(owners[0].origin);

    const env = await (t.svc as unknown as { env(s: unknown): Promise<Parameters<typeof runReviewTool>[0]> }).env(await (t.svc as unknown as { stack(id: string): Promise<unknown> }).stack(v.id));
    assert.equal(env.originTitle, 'Relationships stack');
    const asked = await runReviewTool(env, 'origin', {});
    assert.match(asked, /Session "Relationships stack" \(claude\)\.\nWhat the human asked it, oldest first:\n- 2026-10-16 09:00 Build schema relationships as a stack of small PRs\.\n- 2026-10-16 10:00 Keep the planner pure/);
    assert.match(await runReviewTool(env, 'origin', { query: 'PURE' }), /1 passage mentions "PURE"[\s\S]*\[assistant[^\]]*\] I split it in four\. The planner stays pure/);
    assert.match(await runReviewTool(env, 'origin', { query: 'memoize' }), /Nothing in its transcript mentions "memoize"/);
    await t.svc.remove(v.id);

    // Not started from a session: the one agent on a stack branch made it.
    v = await t.svc.create(t.w.local, { pr: 1 });
    assert.equal(v.origin?.uid, 'u-agent');
    v = await t.svc.update(v.id, { originUid: 'u-old' });
    assert.equal(v.origin?.uid, 'u-old', 'you can say which session it was');
    assert.equal(v.owner?.uid, 'u-agent', 'without moving the fixes');
    await assert.rejects(t.svc.create(t.w.local, { pr: 9 }, undefined, 'nope'), /session not found/);
  });
});

test("review: a session sees the stack it's building, from gh stack or its PRs, and starts its review", async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    // gh stack tracks four branches; the newest has no PR yet.
    await writeFile(join(t.w.local, '.git', 'gh-stack'), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: 'main' }, branches: [{ branch: 'base' }, { branch: 'feat' }, { branch: 'docs' }, { branch: 'more' }] }] }));
    let s = await t.svc.sessionStack('u-agent');
    assert.equal(s.source, 'gh-stack');
    assert.deepEqual(s.branches.map((b) => [b.branch, b.pr?.number ?? null, b.current]), [['base', 1, false], ['feat', 2, true], ['docs', 3, false], ['more', null, false]]);
    assert.equal(s.review, null);
    assert.deepEqual(s.start, { prs: [1, 2, 3] });

    // Started from the panel: the session made it.
    const v = await t.svc.create(t.w.local, s.start as { prs: number[] }, undefined, 'u-agent');
    assert.equal(v.origin?.uid, 'u-agent');
    await t.svc.approve(v.id, 1).catch(() => {});
    s = await t.svc.sessionStack('u-agent');
    assert.deepEqual(s.review, { id: v.id, title: 'PR 1' });
    assert.equal(s.start, null);
    assert.ok(s.branches[0].layer, 'each PR shows its status in review');
    await t.svc.remove(v.id);

    // Without gh stack: the chain of PRs the session's branch is in.
    await writeFile(join(t.w.local, '.git', 'gh-stack'), JSON.stringify({ schemaVersion: 1, stacks: [] }));
    s = await t.svc.sessionStack('u-agent');
    assert.equal(s.source, 'chain');
    assert.deepEqual(s.branches.map((b) => b.branch), ['base', 'feat', 'docs']);

    // A stack on GitHub: the review starts from it.
    await t.setState((st) => {
      Object.assign(st, { stacks: [{ number: 7, prs: [1, 2, 3] }] });
    });
    (t.svc as unknown as { native: Map<string, unknown> }).native.clear();
    s = await t.svc.sessionStack('u-agent');
    assert.equal(s.ghStack, 7);
    assert.deepEqual(s.start, { native: 7 });

    // Back on main, it still shows what it built.
    t.sessions[0].branch = 'main';
    s = await t.svc.sessionStack('u-agent');
    assert.deepEqual(s.branches.map((b) => [b.branch, b.current]), [['base', false], ['feat', false], ['docs', false]]);
    // A shell elsewhere has nothing.
    assert.deepEqual((await t.svc.sessionStack('u-shell')).branches, []);
  });
});

test('review: a session lists the commits it made, each on the branch (and so the layer) it is in', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    await writeFile(join(t.w.local, '.git', 'gh-stack'), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: 'main' }, branches: [{ branch: 'base' }, { branch: 'feat' }, { branch: 'docs' }] }] }));
    // The session's checkout has the stack only as remote-tracking branches.
    execFileSync('git', ['-C', t.w.local, 'fetch', '-q', 'origin']);
    t.sessions[0].startedAt = 0;
    let out = await t.svc.sessionCommits('u-agent');
    assert.deepEqual(out.commits.map((c) => [c.branch, c.subject]), [['docs', 'docs'], ['feat', 'feat'], ['base', 'base']], 'newest layer first, none of trunk');
    assert.equal(out.commits[1].sha, t.heads.h2);
    assert.deepEqual([out.commits[1].files, out.commits[1].additions, out.commits[1].deletions], [1, 1, 0]);
    assert.equal(out.stack.branches.find((b) => b.branch === 'feat')?.pr?.number, 2, 'with the stack, so a commit finds its PR');

    // Only what was committed since the session started; and its own branch, outside the stack.
    const g = (...a: string[]) => execFileSync('git', ['-C', t.w.local, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { stdio: 'pipe', env: { ...process.env, GIT_COMMITTER_DATE: '@2000000000 +0000' } }).toString().trim();
    g('checkout', '-q', '-b', 'wip', 'origin/docs');
    await writeFile(join(t.w.local, 'w.ts'), 'export const w = 1;\n');
    g('add', '.');
    g('commit', '-qm', 'wip: more docs');
    t.sessions[0].branch = 'wip';
    t.sessions[0].startedAt = 1999999999;
    out = await t.svc.sessionCommits('u-agent');
    assert.deepEqual(out.commits.map((c) => [c.branch, c.subject]), [['wip', 'wip: more docs']]);
    assert.equal(out.since, 1999999999);

    // Not a repo: nothing, and no error.
    t.sessions[0].cwd = t.w.parent;
    assert.deepEqual((await t.svc.sessionCommits('u-agent')).commits, []);
    await assert.rejects(t.svc.sessionCommits('nope'), /session not found/);
  });
});

test('review: fixes can go to a new agent session, in a worktree at the layer, told why the stack exists', async () => {
  const t = await setup();
  t.transcripts.set('u-agent', { prompts: [{ at: Date.parse('2026-10-16T09:00:00Z'), text: 'Stack the relationships work; keep the planner pure.' }], entries: [] });
  await withGh(t.w, async () => {
    let v = await t.svc.create(t.w.local, { pr: 1 }, undefined, 'u-agent');
    const f = await t.svc.addFinding(v.id, { ownerPr: 2, title: 'Return 2', severity: 'blocking', path: 'c.ts', lineStart: 1 });
    const text = await t.svc.dispatchText(v.id, 2, [f.id], '', true);
    assert.match(text, /^You're a new session, started to fix a pull request in me\/proj, in a fresh worktree at feat's head \([0-9a-f]{8}\)/);
    assert.match(text, /git push --force-with-lease origin HEAD:feat/);
    assert.match(text, /Background, from that conversation:\nSession "Feature work" \(claude\)\.\nWhat the human asked it, oldest first:\n- 2026-10-16 09:00 Stack the relationships work; keep the planner pure\./);
    assert.match(text, /1\. \[blocking\] Return 2\. c\.ts:1/);
    assert.doesNotMatch(await t.svc.dispatchText(v.id, 2, [f.id]), /new session/, 'not for a session that has the context');
    // Even in a GitHub stack, a new worktree restacks by hand: gh stack would check out branches another checkout holds.
    await t.setState((st) => {
      Object.assign(st, { stacks: [{ number: 7, prs: [1, 2, 3] }] });
    });
    await t.svc.sync(v.id, true);
    assert.match(await t.svc.dispatchText(v.id, 2, [f.id]), /gh stack rebase --upstack/);
    const freshText = await t.svc.dispatchText(v.id, 2, [f.id], '', true);
    assert.doesNotMatch(freshText, /gh stack/);
    assert.match(freshText, /restack the layers above it, in this order.*docs \(#3/);

    const out = await t.svc.dispatch(v.id, 2, { findingIds: [f.id], text, newSession: { preset: 'codex' } });
    assert.deepEqual(t.launched, [{ preset: 'codex', root: t.w.local, label: 'Fix #2', fromRef: t.heads.h2 }]);
    assert.equal(out.dispatch.targetUid, 'u-new1');
    assert.deepEqual(t.sent.map((x) => x.uid), ['u-new1'], 'through the normal send path, not a subscription');
    v = await t.svc.view(v.id);
    assert.equal(v.owner?.uid, 'u-agent', 'the stack keeps its owner');
    assert.equal(v.layers.find((l) => l.pr === 2)!.ownerUid, 'u-new1', "the layer's fixes go to the new session from now on");
    assert.equal(v.layers.find((l) => l.pr === 2)!.status, 'fixing');
  });
});

test('review: two stacks started at once for the same PR — one takes it, the other is told', async () => {
  const t = await setup();
  // Each check that #4 is free waits for the other to have checked too (or 2 s): the
  // moment two requests would both find it free and both take it.
  const svc = t.svc as unknown as { untaken: (root: string, prs: number[]) => Promise<void> };
  const check = svc.untaken.bind(t.svc);
  let checked = 0;
  let both!: () => void;
  const met = new Promise<void>((r) => (both = r));
  svc.untaken = async (root, prs) => {
    await check(root, prs);
    if (++checked === 2) both();
    await Promise.race([met, new Promise((r) => setTimeout(r, 2000))]);
  };
  await withGh(t.w, async () => {
    const out = await Promise.allSettled([t.svc.create(t.w.local, { prs: [4] }), t.svc.create(t.w.local, { prs: [4] })]);
    assert.deepEqual(out.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
    assert.match(String((out.find((o) => o.status === 'rejected') as PromiseRejectedResult).reason), /already in a stack under review/);
    assert.equal(await t.db.reviewLayer.count({ where: { pr: 4 } }), 1);
  });
});

test('review: single-PR session opens directly in Review, stays linked via ReviewState.sessions, and enriches StackSummary', async () => {
  const t = await setup();
  // PR #9 is a standalone open PR on branch "other" -> main.
  t.sessions[0].branch = 'other';
  await withGh(t.w, async () => {
    const ss = await t.svc.sessionStack('u-agent');
    assert.equal(ss.branches.length, 1);
    assert.equal(ss.branches[0].pr?.number, 9);
    assert.deepEqual(ss.start, { pr: 9 });

    const opened = await t.svc.openForSession('u-agent');
    assert.equal(opened.created, true);
    assert.equal(opened.pr, 9);
    assert.equal(opened.stack.origin?.uid, 'u-agent');
    assert.equal(opened.stack.owner?.uid, 'u-agent');

    // Second call opens the same review without creating a duplicate.
    const again = await t.svc.openForSession('u-agent');
    assert.equal(again.created, false);
    assert.equal(again.stack.id, opened.stack.id);

    await t.svc.sync(opened.stack.id, true);
    const link = t.svc.state().sessions.find((x) => x.uid === 'u-agent' && x.stackId === opened.stack.id);
    assert.ok(link);
    assert.equal(link.relation, 'branch');
    assert.equal(link.pr, 9);

    // Even after switching back to main, the session stays linked via owner/origin.
    t.sessions[0].branch = 'main';
    await t.svc.refreshState();
    const afterSwitch = t.svc.state().sessions.find((x) => x.uid === 'u-agent' && x.stackId === opened.stack.id);
    assert.ok(afterSwitch);
    assert.equal(afterSwitch.relation, 'owner');

    const summaries = await t.svc.list();
    const sum = summaries.find((x) => x.id === opened.stack.id)!;
    assert.equal(sum.origin?.uid, 'u-agent');
    assert.equal(sum.owner?.uid, 'u-agent');
    assert.equal(sum.openFindings, 0);
    assert.equal(sum.blockingFindings, 0);
    assert.equal(sum.readyToMerge, false);
  });
});

test('review: inline comment dispatches directly to originating session, deleteFinding removes it, approveHead merges exact head, and closeLayer rejects PR', async () => {
  const t = await setup();
  await withGh(t.w, async () => {
    const v = await t.svc.create(t.w.local, { prs: [4] }, undefined, 'u-agent');
    await t.svc.sync(v.id, true);

    // Direct inline comment logs a finding and dispatches straight to u-agent in one call.
    const res = await t.svc.dispatch(v.id, 4, {
      findingIds: [],
      comment: { title: 'Handle empty input', body: 'Return early when empty.', severity: 'blocking', path: 'd.ts', lineStart: 1 },
    });
    assert.ok(res.finding);
    assert.equal(res.dispatch.targetUid, 'u-agent');
    assert.equal(t.sent.length, 1);
    assert.match(t.sent[0].text, /Handle empty input/);

    // Deleting the finding unblocks the layer.
    await t.svc.deleteFinding(v.id, res.finding.id);
    assert.equal((await t.svc.findings(v.id)).length, 0);

    // Stale expectedHead is rejected even with approveHead.
    await assert.rejects(() => t.svc.merge(v.id, 4, { expectedHead: '0'.repeat(40), approveHead: true }), /new commit landed/);

    // Exact-head approveHead approves & merges #4 in one step.
    const currentHead = (await t.svc.view(v.id)).layers[0].current!.headSha;
    const merged = await t.svc.merge(v.id, 4, { expectedHead: currentHead, approveHead: true });
    assert.deepEqual(merged.merged, [4]);

    // Rejecting/closing a PR closes it on GitHub and optionally removes the stack if done.
    const v2 = await t.svc.create(t.w.local, { prs: [1] }, undefined, 'u-agent');
    await t.svc.sync(v2.id, true);
    const closed = await t.svc.closeLayer(v2.id, 1, { comment: 'Superseded by new approach', removeIfDone: true });
    assert.equal(closed.removed, true);
    assert.equal(closed.stack, null);
    const log = await readFile(`${t.w.stateFile}.log`, 'utf8');
    assert.match(log, /pr close 1 --comment Superseded by new approach/);
  });
});

