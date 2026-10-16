import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureMigrated, getDb } from './db.ts';
import { SideChatStore } from './sidechat.ts';
import { ReviewService, readTextFile, threadTitle, type SessionLite } from './review/service.ts';

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
if (a[0] === 'repo' && a[1] === 'view') out({ nameWithOwner: 'me/proj', defaultBranchRef: { name: 'main' }, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
else if (a[0] === 'pr' && a[1] === 'list') out(st.prs.filter((p) => a[3] === 'all' || p.state === 'OPEN'));
else if (a[0] === 'pr' && a[1] === 'view') { const p = pr(a[2]); if (!p) { console.error('no pull requests found'); process.exit(1); } out(p); }
else if (a[0] === 'pr' && a[1] === 'merge') {
  const p = pr(a[2]); const i = a.indexOf('--match-head-commit');
  if (p.headRefOid !== a[i + 1]) { console.error('X Head branch was modified. Review and try the merge again.'); process.exit(1); }
  p.state = 'MERGED'; save();
}
else if (a[0] === 'pr' && a[1] === 'edit') { pr(a[2]).baseRefName = a[a.indexOf('--base') + 1]; save(); }
else if (a[0] === 'pr' && a[1] === 'ready') { pr(a[2]).isDraft = false; save(); }
else if (a[0] === 'api' && a[1] === 'graphql') {
  const q = a.find((x) => x.startsWith('query=')) || '';
  if (q.includes('reviewThreads')) out({ data: { repository: { pullRequest: { reviewThreads: { nodes: st.threads || [] } } } } });
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
  const state = { prs: [pr(1, 'base', 'main', h1), pr(2, 'feat', 'base', h2), pr(3, 'docs', 'feat', h3), pr(4, 'fix', 'base', h4), pr(9, 'other', 'main', h1)], threads: [] as unknown[] };
  await writeFile(w.stateFile, JSON.stringify(state));
  const dbPath = join(w.parent, 'ah.db');
  await ensureMigrated(dbPath);
  const chat = new SideChatStore(dbPath);
  const sessions: SessionLite[] = [
    { uid: 'u-agent', key: 'claude:conv-1', title: 'Feature work', agent: 'claude', status: 'idle', cwd: w.local, branch: 'feat', live: true },
    { uid: 'u-shell', key: 'u-shell', title: 'zsh', agent: null, status: 'idle', cwd: w.local, branch: 'main', live: true },
  ];
  const sent: { uid: string; text: string }[] = [];
  const alerts: string[] = [];
  const svc = new ReviewService(getDb(dbPath), chat, {
    sessions: async () => sessions,
    send: async (uid, text) => {
      sent.push({ uid, text });
      return { outcome: 'queued', queueId: 'q1' };
    },
    alert: (p) => alerts.push(p.title),
    changed: () => {},
    readPlan: readTextFile,
  });
  const setState = async (fn: (s: typeof state) => void) => {
    const cur = JSON.parse(await readFile(w.stateFile, 'utf8'));
    fn(cur);
    await writeFile(w.stateFile, JSON.stringify(cur));
  };
  return { w, svc, chat, sessions, sent, alerts, setState, heads: { h1, h2, h3, h4 } };
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
    await t.svc.dispatch(v.id, 2, { findingIds: [f.id], text });
    assert.deepEqual(t.sent.map((s) => s.uid), ['u-agent']);
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
    const thread = await t.svc.thread(v.id, 2);
    assert.deepEqual(thread.messages.map((m) => m.role), ['user', 'assistant']);
    assert.equal(thread.findings.length, 2);
    // Proposals don't count until kept.
    let view = await t.svc.view(v.id);
    assert.equal(view.layers.find((l) => l.pr === 1)!.open, 0);
    await t.svc.updateFinding(v.id, thread.findings[0].id, { state: 'open' });
    view = await t.svc.view(v.id);
    assert.equal(view.layers.find((l) => l.pr === 1)!.open, 1);
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
