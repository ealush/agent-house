// A stand-in GitHub for Review's tests: a `gh` on PATH whose pull requests live in a JSON
// file, and a git world (a bare remote, a working clone to push from, a local clone to
// review in). The service tests and the page's tests share it.
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A stand-in `gh`: PR state lives in a JSON file, and merge/edit/ready
// change it the way GitHub would. Every call is logged.
export const GH = `#!/usr/bin/env node
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
else if (a[0] === 'pr' && a[1] === 'create') {
  const flag = (name) => { const i = a.indexOf(name); return i >= 0 ? a[i + 1] : ''; };
  const head = flag('--head'), base = flag('--base');
  if (st.prs.some((p) => p.headRefName === head && p.state === 'OPEN')) { console.error('a pull request for branch "' + head + '" already exists'); process.exit(1); }
  const number = Math.max(0, ...st.prs.map((p) => p.number)) + 1;
  let sha = '';
  try { sha = require('child_process').execFileSync('git', ['rev-parse', head], { cwd: process.cwd() }).toString().trim(); } catch {}
  const url = 'https://github.com/me/proj/pull/' + number;
  st.prs.push({ number, title: flag('--title'), url, body: flag('--body'), state: 'OPEN', isDraft: false, headRefName: head, baseRefName: base, headRefOid: sha, baseRefOid: '', isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', author: { login: 'me' }, statusCheckRollup: [], additions: 1, deletions: 0, updatedAt: '', mergedAt: '' });
  save();
  process.stdout.write(url + '\\n');
}
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

export async function world(dir = tmpdir()) {
  const parent = await mkdtemp(join(dir, 'ah-review-svc-'));
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

export type Pr = Record<string, unknown> & { number: number; headRefName: string; baseRefName: string; headRefOid: string; state: string };
export const pr = (number: number, head: string, base: string, sha: string, extra: Record<string, unknown> = {}): Pr => ({
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

export async function withGh<T>(w: { bin: string; stateFile: string }, fn: () => Promise<T>): Promise<T> {
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
