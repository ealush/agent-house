#!/usr/bin/env node
// Not GitHub's `gh`: the demo host's stand-in, on its PATH, so stack review has pull requests
// to work with and never reaches GitHub. Pull requests live in a JSON file ($AH_GH_STATE) and
// their branches in a bare repository on this machine (the projects' `origin`); merging,
// retargeting and marking ready change both the way GitHub would. Modeled on the stand-in in
// ah's own review tests (server/review.test.ts).
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.env.AH_GH_STATE;
const st = JSON.parse(readFileSync(file, 'utf8'));
const a = process.argv.slice(2);
appendFileSync(file + '.log', a.join(' ') + '\n');
const save = () => writeFileSync(file, JSON.stringify(st, null, 2));
const out = (v) => process.stdout.write(JSON.stringify(v));
const fail = (message) => {
  process.stderr.write(message + '\n');
  process.exit(1);
};
const pr = (n) => st.prs.find((p) => p.number === Number(n));
const stackOf = (n) => (st.stacks ?? []).find((s) => s.prs.includes(Number(n)));
const remoteGit = (...args) =>
  execFileSync('git', ['--git-dir', st.remote, ...args], {
    env: { ...process.env, GIT_AUTHOR_NAME: 'GitHub', GIT_AUTHOR_EMAIL: 'noreply@example.invalid', GIT_COMMITTER_NAME: 'GitHub', GIT_COMMITTER_EMAIL: 'noreply@example.invalid' },
  })
    .toString()
    .trim();
const stackView = (s) => ({
  number: s.number,
  base: { ref: s.base ?? 'main' },
  open: s.prs.some((n) => pr(n).state === 'OPEN'),
  pull_requests: s.prs.map((n) => {
    const p = pr(n);
    return { number: n, state: p.state === 'OPEN' ? 'open' : 'closed', draft: p.isDraft, merged_at: p.mergedAt || null, head: { ref: p.headRefName, sha: p.headRefOid } };
  }),
});
const merged = (p) => {
  p.state = 'MERGED';
  p.mergedAt = new Date().toISOString();
};
// GitHub lands a stack up to a pull request: everything below merges, the next one retargets.
const land = (n) => {
  const s = stackOf(n);
  const upto = s.prs.indexOf(Number(n));
  for (const x of s.prs.slice(0, upto + 1)) if (pr(x).state === 'OPEN') merged(pr(x));
  const next = s.prs.slice(upto + 1).find((x) => pr(x).state === 'OPEN');
  if (next) pr(next).baseRefName = s.base ?? 'main';
  remoteGit('update-ref', `refs/heads/${s.base ?? 'main'}`, pr(n).headRefOid);
};
const CRLF = '\r\n';
const http = (code, body) => {
  process.stdout.write(`HTTP/2.0 ${code} X${CRLF}Content-Type: application/json${CRLF}${CRLF}${JSON.stringify(body)}`);
  process.exit(code >= 400 ? 1 : 0);
};

if (a[0] === 'repo' && a[1] === 'view') out({ nameWithOwner: st.repo, defaultBranchRef: { name: 'main' }, mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: false });
else if (a[0] === 'pr' && a[1] === 'list') out(st.prs.filter((p) => a[3] === 'all' || p.state === 'OPEN'));
else if (a[0] === 'pr' && a[1] === 'view') {
  const p = pr(a[2]);
  if (!p) fail('no pull requests found');
  out(p);
} else if (a[0] === 'pr' && a[1] === 'merge') {
  const p = pr(a[2]);
  const i = a.indexOf('--match-head-commit');
  if (stackOf(p.number)) fail(`X Pull request #${p.number} is in a stack: merge it with the merge-async API`);
  if (p.headRefOid !== a[i + 1]) fail('X Head branch was modified. Review and try the merge again.');
  const base = remoteGit('rev-parse', `refs/heads/${p.baseRefName}`);
  const commit = remoteGit('commit-tree', `${p.headRefOid}^{tree}`, '-p', base, ...(a.includes('--squash') ? [] : ['-p', p.headRefOid]), '-m', `Merge #${p.number}: ${p.title}`);
  remoteGit('update-ref', `refs/heads/${p.baseRefName}`, commit);
  merged(p);
  save();
} else if (a[0] === 'pr' && a[1] === 'edit') {
  pr(a[2]).baseRefName = a[a.indexOf('--base') + 1];
  save();
} else if (a[0] === 'pr' && a[1] === 'ready') {
  pr(a[2]).isDraft = false;
  save();
} else if (a[0] === 'stack' && a[1] === '--version') process.stdout.write('gh stack version 0.2.1 (demo stand-in)');
else if (a[0] === 'api' && a[1] === '--include') {
  const rest = a.slice(2);
  const method = rest[0] === '--method' ? rest[1] : 'GET';
  const url = rest[rest[0] === '--method' ? 2 : 0];
  const f = {};
  rest.forEach((x, i) => {
    if (x === '-f') {
      const [k, ...v] = rest[i + 1].split('=');
      f[k] = v.join('=');
    }
  });
  const parts = url.split('?')[0].split('/');
  if (parts[3] === 'stacks' && method === 'POST') {
    const prs = rest.flatMap((x, i) => (rest[i - 1] === '-F' && x.startsWith('pull_requests[]=') ? [Number(x.split('=')[1])] : []));
    const onto = parts[4] ? (st.stacks ?? []).find((s) => s.number === Number(parts[4])) : null;
    const chain = [...(onto ? onto.prs.slice(-1) : []), ...prs];
    for (let i = 1; i < chain.length; i++) {
      if (pr(chain[i]).baseRefName !== pr(chain[i - 1]).headRefName) http(422, { message: 'Validation Failed', errors: [{ message: `#${chain[i]} does not build on #${chain[i - 1]}` }] });
    }
    if (onto) {
      onto.prs.push(...prs);
      save();
      http(200, stackView(onto));
    }
    const s = { number: 40 + (st.stacks ?? []).length, prs };
    st.stacks = [...(st.stacks ?? []), s];
    save();
    http(201, stackView(s));
  }
  if (parts[3] === 'stacks') http(200, (st.stacks ?? []).map(stackView));
  if (parts[3] === 'pulls' && parts[5] === 'merge-async' && method === 'PUT') {
    const p = pr(parts[4]);
    if (f.sha !== p.headRefOid) http(400, { status: 'failed', details: { message: 'Head branch was modified. Review and try the merge again.' } });
    st.pending = { uuid: `req-${p.number}-${Date.now()}`, n: p.number, method: f.merge_method };
    save();
    http(202, { status: 'pending', details: { message: 'Merge request enqueued.', uuid: st.pending.uuid, merge_method: f.merge_method, expected_head_sha: f.sha } });
  }
  if (parts[3] === 'pulls' && parts[5] === 'merge-async' && parts[6]) {
    if (!st.pending || st.pending.uuid !== parts[6]) http(404, { message: 'Not Found' });
    const n = st.pending.n;
    st.pending = null;
    land(n);
    save();
    http(200, { status: 'merged', details: { message: 'Pull request was merged.', sha: pr(n).headRefOid } });
  }
  http(404, { message: 'Not Found' });
} else if (a[0] === 'api' && a.includes('Accept: application/vnd.github.raw')) fail('gh: Not Found (HTTP 404)');
else if (a[0] === 'api' && a[1] === 'graphql') {
  const q = a.find((x) => x.startsWith('query=')) ?? '';
  if (q.includes('isInMergeQueue')) out({ data: { repository: { pullRequest: { isInMergeQueue: false } } } });
  else if (q.includes('reviewThreads')) {
    const n = Number(a.find((x) => x.startsWith('n='))?.slice(2));
    out({ data: { repository: { pullRequest: { reviewThreads: { nodes: (st.threads ?? {})[n] ?? [] } } } } });
  } else out({ data: {} });
} else fail(`gh (demo stand-in): ${a.join(' ')} isn't something the demo host knows`);
