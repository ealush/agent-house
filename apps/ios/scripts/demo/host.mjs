#!/usr/bin/env node
// A disposable ah host with something to look at, for walking the app's screens (UI tours,
// screenshots, hand testing in the simulator). Isolated like scripts/it-host.mjs: its own
// home, state and tmux server, loopback only, and scripted agents (scripts/demo/agent.mjs)
// instead of real ones. Seeds two git projects (branches, a worktree, uncommitted work, a
// dev server for Preview) and sessions in every state: waiting on you, idle with a full
// conversation, a worktree, shells, and an ended one in History. Agents run under ah's own
// Claude Code preset, so launch choices (model, effort, permissions) are the real ones.
//
// DEMO_UNSENT=1 adds "Spec draft", whose agent loses every Enter: a message sent to it from the
// app shows as not sent once ah gives up on it (about half a minute).
//
// DEMO_CONDUCTOR=1 adds jobs (schedules, a chain, a paused one, a decision in the Inbox) and
// ninety days of usage with Codex's rate-limit windows.
//
// Stack review has three stacked pull requests in orbit-api, behind a stand-in `gh`
// (scripts/demo/gh.mjs) and a bare repository as their GitHub, and a scripted model
// (scripts/demo/model.mjs) answers briefings, the reviewer thread and side chat.
//
//   node scripts/demo/host.mjs [--dir <state dir>]
//
// Prints one JSON line {port, localToken, dir} once the sessions are up, then runs until
// stdin closes or SIGTERM. `node scripts/demo/code.mjs <dir>` prints a setup code.
import { serverRoot } from '../server-root.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startModel } from './model.mjs';
import { demoUploads } from './media.mjs';

const source = serverRoot();
const { startAh, cleanup } = await import(pathToFileURL(join(source, 'test/helpers.ts')).href);
const here = new URL('.', import.meta.url).pathname;
const dirArg = process.argv.indexOf('--dir');
// Its real path: on macOS /tmp is /private/tmp, which is the folder an agent starts in, and
// its transcript names that cwd; a session opened at /tmp/… would never find it (no GUI).
const given = dirArg > 0 ? resolve(process.argv[dirArg + 1]) : mkdtempSync(join(tmpdir(), 'ah-native-demo-'));
mkdirSync(given, { recursive: true });
const dir = realpathSync(given);
const fresh = !existsSync(join(dir, 'files'));
const files = join(dir, 'files');

// ah's own Claude Code preset (its models, efforts and permission modes) runs `claude`: here a
// script on the host's PATH that runs the scripted agent. A script keeps the name `claude` for
// the process ah matches, and the agent picks its scenario from the project it starts in.
const bin = join(dir, 'bin');
mkdirSync(bin, { recursive: true });
const agent = join(here, 'agent.mjs');
writeFileSync(join(bin, 'claude'), `#!/bin/bash\n# Not Claude Code: the demo's scripted stand-in (scripts/demo/agent.mjs).\n"${process.execPath}" "${agent}" "$@"\n`, { mode: 0o755 });
writeFileSync(join(bin, 'gh'), `#!/bin/sh\n# Not GitHub's gh: the demo's stand-in (scripts/demo/gh.mjs).\nexec "${process.execPath}" "${join(here, 'gh.mjs')}" "$@"\n`, { mode: 0o755 });
// With an ah that ships its own test stand-in (test/fixtures/fake-harness.js), `codex` is on
// the PATH too: it answers "Got: <first line>" and writes Codex's own transcript format, so a
// conversation can be carried from one agent to another in the demo. Not Codex.
const fakeHarness = join(source, 'test', 'fixtures', 'fake-harness.js');
if (existsSync(fakeHarness)) {
  writeFileSync(join(bin, 'codex'), readFileSync(fakeHarness), { mode: 0o755 });
}
const github = join(dir, 'github');
process.env.AH_GH_STATE = join(github, 'state.json');

// ---------- projects

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.invalid', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
const put = (root, path, text) => {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
};

function seed() {
  const web = join(files, 'orbit-web');
  mkdirSync(web, { recursive: true });
  git(web, 'init', '-q', '-b', 'main');
  put(web, 'README.md', '# Orbit\n\nThe Orbit web app: workspaces, invites and repository sync.\n\n```sh\nnpm install\nnpm run dev\n```\n');
  put(web, 'package.json', JSON.stringify({ name: 'orbit-web', version: '1.43.0', scripts: { dev: 'vite', test: 'vitest' } }, null, 2) + '\n');
  put(web, 'index.html', '<!doctype html>\n<html><head><meta name="viewport" content="width=device-width"><title>Orbit</title>\n<style>body{font:17px -apple-system,system-ui;margin:0;display:grid;place-items:center;min-height:100vh;background:linear-gradient(160deg,#fdf2f8,#eef2ff)}main{background:#fff;padding:40px 48px;border-radius:24px;box-shadow:0 20px 60px #6366f122;max-width:420px}.eyebrow{color:#e11d74;font-weight:600;font-size:13px;letter-spacing:.06em;text-transform:uppercase}button{font:inherit;border:0;border-radius:999px;background:#111827;color:#fff;padding:12px 22px;margin-top:12px}</style></head>\n<body><main><p class="eyebrow">Step 1 of 3</p><h1>Name your workspace</h1><p>It\'s what your teammates will see when you invite them.</p><button>Continue</button></main></body></html>\n');
  put(web, 'src/router.ts', "import { Dashboard } from './pages/Dashboard';\nimport { Settings } from './pages/Settings';\n\nexport const routes = {\n  '/': Dashboard,\n  '/settings': Settings,\n};\n");
  put(web, 'src/pages/Dashboard.ts', "export function Dashboard(workspace: string) {\n  return `<h1>${workspace}</h1><p>No activity yet.</p>`;\n}\n");
  put(web, 'src/pages/Settings.ts', "export function Settings() {\n  return '<h1>Settings</h1>';\n}\n");
  put(web, 'src/onboarding.ts', "export const steps = [\n  { title: 'Name your workspace', body: 'It\\'s what teammates see.' },\n  { title: 'Invite a teammate', body: 'Work is better together.' },\n  { title: 'Connect a repository', body: 'GitHub or GitLab.' },\n];\n\nexport const loadStep = (ws: string) => Number(localStorage.getItem(`step:${ws}`) ?? 0);\nexport const saveStep = (ws: string, n: number) => localStorage.setItem(`step:${ws}`, String(n));\n");
  git(web, 'add', '-A');
  git(web, 'commit', '-qm', 'Start Orbit web');
  put(web, 'src/pages/Settings.ts', "export function Settings() {\n  return '<h1>Settings</h1><p>Members, billing and integrations.</p>';\n}\n");
  git(web, 'commit', '-qam', 'Describe the settings page');
  git(web, 'branch', 'release/1.43');
  // Uncommitted work for the Diff panel (the onboarding agent adds more as it runs).
  put(web, 'README.md', '# Orbit\n\nThe Orbit web app: workspaces, invites and repository sync.\n\n```sh\nnpm install\nnpm run dev   # http://localhost:5173\n```\n\nNew workspaces start on a three-step welcome.\n');

  const api = join(files, 'orbit-api');
  mkdirSync(api, { recursive: true });
  git(api, 'init', '-q', '-b', 'main');
  put(api, 'package.json', JSON.stringify({ name: 'orbit-api', version: '2.8.1', scripts: { bench: 'node bench.js' } }, null, 2) + '\n');
  put(api, 'src/routes/users.ts', "import { db } from '../db';\n\nexport async function listUsers() {\n  const users = await db.users.all();\n  for (const u of users) u.teams = await db.teams.forUser(u.id);\n  return users;\n}\n");
  put(api, 'src/payments/ledger.ts', "export class Ledger {\n  record(entry: { amount: number; kind: 'charge' | 'refund' }) {\n    return entry;\n  }\n}\n");
  git(api, 'add', '-A');
  git(api, 'commit', '-qm', 'Users and payments');
  git(api, 'checkout', '-qb', 'payments-refactor');
  put(api, 'src/payments/ledger.ts', "export class Ledger {\n  private entries: { amount: number; kind: 'charge' | 'refund' }[] = [];\n  record(entry: { amount: number; kind: 'charge' | 'refund' }) {\n    this.entries.push(entry);\n    return entry;\n  }\n}\n");
  git(api, 'commit', '-qam', 'Extract Ledger from Payments');
  git(api, 'commit', '-q', '--allow-empty', '-m', 'Move refunds behind the ledger');
  git(api, 'checkout', '-q', 'main');
  seedPullRequests(api);

  const infra = join(files, 'orbit-infra');
  mkdirSync(infra, { recursive: true });
  git(infra, 'init', '-q', '-b', 'main');
  put(infra, 'keys/rotate.sh', '#!/bin/sh\n# Rotates the API signing keys and revokes the old ones.\nset -e\n./bin/keys new --kind signing\n./bin/keys revoke --older-than 90d\n');
  put(infra, 'README.md', '# Orbit infra\n\nTerraform, key rotation and deploy scripts.\n');
  git(infra, 'add', '-A');
  git(infra, 'commit', '-qm', 'Infra scripts');
}
/**
 * Three stacked pull requests on orbit-api (cache the users query, then invalidate it, then
 * measure it), pushed to a bare repository that plays GitHub for `gh` and `git fetch`.
 */
function seedPullRequests(api) {
  const remote = join(github, 'orbit-api.git');
  mkdirSync(remote, { recursive: true });
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  git(api, 'remote', 'add', 'origin', remote);
  const users = (body) => `import { db } from '../db';\n\n${body}`;
  const layers = [
    {
      number: 101,
      branch: 'cache/users-query',
      title: 'Cache the users query for 30 seconds',
      body: 'The users list ran one teams query per user. This keeps the whole list for 30 s.\n\n- p95 412 ms → 38 ms on the bench\n- Stale for at most 30 s; #102 drops it on writes',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      files: {
        'src/routes/users.ts': users("const TTL_MS = 30_000;\nlet cached: { at: number; users: unknown[] } | null = null;\n\nexport async function listUsers() {\n  if (cached && Date.now() - cached.at < TTL_MS) return cached.users;\n  const users = await db.users.all();\n  for (const u of users) u.teams = await db.teams.forUser(u.id);\n  cached = { at: Date.now(), users };\n  return users;\n}\n"),
        'test/users.test.ts': "import { listUsers } from '../src/routes/users';\n\ntest('a second call within 30 s reads the cache', async () => {\n  const first = await listUsers();\n  expect(await listUsers()).toBe(first);\n});\n",
      },
    },
    {
      number: 102,
      branch: 'cache/invalidate',
      title: 'Drop the users cache when teams change',
      body: 'Adding someone to a team now forgets the cached users list, so the next read is fresh.',
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      files: {
        'src/routes/users.ts': users("const TTL_MS = 30_000;\nlet cached: { at: number; users: unknown[] } | null = null;\n\nexport async function listUsers() {\n  if (cached && Date.now() - cached.at < TTL_MS) return cached.users;\n  const users = await db.users.all();\n  for (const u of users) u.teams = await db.teams.forUser(u.id);\n  cached = { at: Date.now(), users };\n  return users;\n}\n\n/** The next listUsers reads the database again. */\nexport function forgetUsers() {\n  cached = null;\n}\n"),
        'src/routes/teams.ts': "import { db } from '../db';\nimport { forgetUsers } from './users';\n\nexport async function addMember(team: string, user: string) {\n  await db.teams.add(team, user);\n  forgetUsers();\n}\n",
      },
    },
    {
      number: 103,
      branch: 'cache/metrics',
      title: 'Count users-cache hits and misses',
      body: 'Exposes the hit rate on /metrics so the 30 s TTL can be tuned from data.',
      draft: true,
      checks: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' }],
      files: {
        'src/routes/users.ts': users("const TTL_MS = 30_000;\nlet cached: { at: number; users: unknown[] } | null = null;\nexport const usersCache = { hits: 0, misses: 0 };\n\nexport async function listUsers() {\n  if (cached && Date.now() - cached.at < TTL_MS) {\n    usersCache.hits++;\n    return cached.users;\n  }\n  usersCache.misses++;\n  const users = await db.users.all();\n  for (const u of users) u.teams = await db.teams.forUser(u.id);\n  cached = { at: Date.now(), users };\n  return users;\n}\n\n/** The next listUsers reads the database again. */\nexport function forgetUsers() {\n  cached = null;\n}\n"),
        'src/routes/metrics.ts': "import { usersCache } from './users';\n\nexport function metrics() {\n  const total = usersCache.hits + usersCache.misses;\n  return { usersCacheHitRate: total ? usersCache.hits / total : 0 };\n}\n",
      },
    },
  ];
  const prs = [];
  let base = 'main';
  for (const layer of layers) {
    git(api, 'checkout', '-q', '-b', layer.branch, base);
    for (const [path, text] of Object.entries(layer.files)) put(api, path, text);
    git(api, 'add', '-A');
    git(api, 'commit', '-qm', layer.title);
    const head = git(api, 'rev-parse', 'HEAD').trim();
    const [additions, deletions] = git(api, 'diff', '--numstat', `${base}..${layer.branch}`)
      .trim()
      .split('\n')
      .reduce(([a, d], row) => [a + Number(row.split('\t')[0]), d + Number(row.split('\t')[1])], [0, 0]);
    prs.push({
      number: layer.number,
      title: layer.title,
      url: `https://github.com/orbit/orbit-api/pull/${layer.number}`,
      body: layer.body,
      state: 'OPEN',
      isDraft: !!layer.draft,
      headRefName: layer.branch,
      baseRefName: base,
      headRefOid: head,
      baseRefOid: git(api, 'rev-parse', base).trim(),
      isCrossRepository: false,
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'CLEAN',
      author: { login: 'orbit-dev' },
      statusCheckRollup: layer.checks,
      additions,
      deletions,
      updatedAt: new Date().toISOString(),
      mergedAt: '',
    });
    base = layer.branch;
  }
  git(api, 'checkout', '-q', 'main');
  git(api, 'push', '-q', 'origin', 'main', ...layers.map((l) => l.branch), ...prs.map((p) => `${p.headRefOid}:refs/pull/${p.number}/head`));
  writeFileSync(process.env.AH_GH_STATE, JSON.stringify({ repo: 'orbit/orbit-api', remote, prs, stacks: [{ number: 12, prs: prs.map((p) => p.number) }] }, null, 2));
}

if (fresh) seed();

// No presets of our own: ah's defaults (Shell, Claude Code, Codex…), with `claude` found first.
process.env.PATH = `${bin}:${process.env.PATH}`;
// Sessions start login shells, and on macOS /etc/zprofile's path_helper puts the system's
// paths (Homebrew's, with a real `claude` in it) back in front: the demo home's own profiles
// put the stand-ins first again, so a session never starts the real agent.
mkdirSync(join(dir, 'home'), { recursive: true });
for (const profile of ['.zprofile', '.zshrc', '.bash_profile', '.bashrc'])
  writeFileSync(join(dir, 'home', profile), `# The demo host's stand-ins (claude, gh) before anything else on the PATH.\nexport PATH="${bin}:$PATH"\n`);
// Settings → System must never reach this machine's own ah: its restart would run
// `systemctl --user restart ah`, and a rebuild would build and restart that too. The demo
// host isn't a unit, so restarting it does nothing, and a rebuild only takes a moment.
// Omarchy's web-app installer would add a launcher to this machine's real desktop: these
// stand-ins write it into the demo's own XDG_DATA_HOME instead.
for (const [name, script] of [
  ['omarchy-webapp-install', 'mkdir -p "$XDG_DATA_HOME/applications" && printf "[Desktop Entry]\\nName=%s\\nExec=xdg-open %s\\n" "$1" "$2" > "$XDG_DATA_HOME/applications/$1.desktop"'],
  ['omarchy-webapp-remove', 'rm -f "$XDG_DATA_HOME/applications/$1.desktop"'],
]) writeFileSync(join(bin, name), `#!/bin/sh\n# Not Omarchy's ${name}: the demo host's own data folder only.\n${script}\n`, { mode: 0o755 });
process.env.AH_RESTART_CMD = 'true';
process.env.AH_REBUILD_CMD = 'sleep 2';
// ah's own default lets the file browser read its uploads (\`~/.cache/ah/uploads\`); the demo
// keeps its cache in its own folder, so it names that one, and sent images draw.
// The scripted agent's /design calls ah's Claude Code hook, as Claude Code does.
process.env.AH_DEMO_HOOK = join(source, 'bin', 'ah-hook.js');
mkdirSync(join(dir, 'cache', 'ah', 'uploads'), { recursive: true });
// Attachments for the scripted agent's /media turn, in that upload folder (made once).
process.env.AH_DEMO_UPLOADS = join(dir, 'cache', 'ah', 'uploads');
demoUploads(process.env.AH_DEMO_UPLOADS);
// AH_DEMO_APNS=1: an APNs key of its own and a loopback stand-in for Apple's gateway that takes
// every push (alerts, Live Activity updates) and writes it to <dir>/apns.jsonl, to watch what
// the host sends the app without a real key. Nothing reaches Apple.
let apns;
if (process.env.AH_DEMO_APNS === '1') {
  const { generateKeyPairSync } = await import('node:crypto');
  const { createServer } = await import('node:http2');
  const { appendFileSync } = await import('node:fs');
  const keyFile = join(dir, 'AuthKey_DEMO.p8');
  writeFileSync(keyFile, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const gateway = createServer();
  gateway.on('stream', (stream, headers) => {
    let body = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => (body += d));
    stream.on('end', () => {
      const pick = (k) => headers[k];
      appendFileSync(join(dir, 'apns.jsonl'), JSON.stringify({ at: Date.now(), path: pick(':path'), type: pick('apns-push-type'), topic: pick('apns-topic'), priority: pick('apns-priority'), body: JSON.parse(body) }) + '\n');
      stream.respond({ ':status': 200 });
      stream.end();
    });
  });
  await new Promise((r) => gateway.listen(0, '127.0.0.1', r));
  process.env.AH_APNS_ORIGIN = `http://127.0.0.1:${gateway.address().port}`;
  apns = { teamId: 'DEMOTEAM01', keyId: 'DEMOKEY001', keyFile, topic: 'dev.ealush.ah.native' };
}
const ah = await startAh({ idleAfter: 2, files: { roots: [join(dir, 'files'), join(dir, 'cache', 'ah', 'uploads')] }, ...(apns ? { apns } : {}) }, dir);

const call = async (method, path, body) => {
  const res = await fetch(`http://localhost:${ah.port}${path}`, {
    method,
    headers: { Authorization: `Bearer ${ah.localToken()}`, 'X-AH': '1', Origin: `http://localhost:${ah.port}`, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
// The scripted model, on a new port each start: point the demo's subscription at it.
const model = await startModel();
{
  const name = 'Demo model (scripted)';
  const existing = (await call('GET', '/api/subscriptions')).find((s) => s.name === name);
  const saved = await call('POST', '/api/subscriptions', { ...(existing ? { id: existing.id } : {}), name, baseUrl: `http://127.0.0.1:${model.port}/v1`, model: 'demo-briefer', apiKey: 'demo' });
  if (!existing) await call('POST', '/api/subscriptions/default', { id: saved.id });
}
const open = (preset, cwd, label, session, extra = {}) => call('POST', '/api/windows', { preset, cwd: join(files, cwd), session, label, ...extra });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// A new session's window, once the host's state has it (its refresh can take a moment).
const running = async (uid) => {
  for (let i = 0; i < 40; i++) {
    const win = (await call('GET', '/api/state')).windows.find((w) => w.uid === uid);
    if (win) return win;
    await wait(250);
  }
  return null;
};

if (fresh) {
  await open('claude', 'orbit-web', 'Welcome flow', 'orbit');
  await wait(400);
  await open('claude', 'orbit-infra', 'Rotate API keys', 'orbit');
  await wait(400);
  await open('claude', 'orbit-api', 'Users latency', 'orbit', { model: 'opus', effort: 'high' });
  await wait(400);
  await open('claude', 'orbit-api', 'Payments review', 'orbit', { worktree: true, mode: 'plan' });
  await wait(400);
  // DEMO_SUBAGENTS=<seconds>: a session that hands a refactor to subagents as the demo starts.
  if (process.env.DEMO_SUBAGENTS) {
    // A folder of its own (a worktree): the stand-in agent sends no hooks, and two agents in one
    // folder could be paired with each other's transcripts.
    const refactor = await open('claude', 'orbit-api', 'Server refactor', 'orbit', { worktree: true });
    const win = await running(refactor.uid);
    await wait(1500);
    // Typed into its window: the demo's own token can't send.
    if (win) ah.tmux('send-keys', '-t', win.id, `/delegate ${Number(process.env.DEMO_SUBAGENTS) || 60}`, 'Enter');
    await wait(400);
  }
  if (process.env.DEMO_UNSENT) {
    const docs = join(files, 'orbit-docs');
    mkdirSync(docs, { recursive: true });
    git(docs, 'init', '-q', '-b', 'main');
    put(docs, 'README.md', '# Orbit docs\n');
    writeFileSync(join(docs, '.demo-deaf'), '');
    await open('claude', 'orbit-docs', 'Spec draft', 'orbit');
    await wait(400);
  }
  await open('shell', 'orbit-web', 'Dev server', 'tools');
  ah.tmux('send-keys', '-t', 'tools', `cd ${join(files, 'orbit-web')} && python3 -m http.server 5173 --bind 127.0.0.1`, 'Enter');
  await wait(400);
  await open('shell', 'orbit-api', 'Shell', 'tools');
  ah.tmux('send-keys', '-t', 'tools', 'git log --oneline --graph --all && git status -sb', 'Enter');
  // A worktree whose session ended, with work left in it: Worktrees' cleanup has something to do.
  const spike = await open('shell', 'orbit-web', 'Dark mode spike', 'tools', { worktree: true });
  const spikeCwd = (await running(spike.uid))?.cwd;
  if (spikeCwd) put(spikeCwd, 'src/theme.ts', "export const dark = { background: '#0b0b10', text: '#e6e6f0' };\n");
  await call('POST', `/api/sessions/${spike.uid}/terminate`);
  // One that ends, so History has something.
  const ended = await open('shell', 'orbit-web', 'Release notes 1.42', 'tools');
  await wait(1200);
  await running(ended.uid);
  await call('POST', `/api/sessions/${ended.uid}/terminate`);
  // The cache stack, under review.
  await call('POST', '/api/review/stacks', { root: join(files, 'orbit-api'), prs: [101, 102, 103] }).catch((err) => process.stderr.write(`review stack: ${err.message}\n`));
  // DEMO_CONDUCTOR=1: what the host runs on its own (server/jobs): schedules, a chain, a paused
  // job, and a decision waiting in the Inbox; and what its agents used (server/usage). Off by
  // default, so other tours' Inbox is as it was.
  if (process.env.DEMO_CONDUCTOR) await seedConductor().catch((err) => process.stderr.write(`conductor: ${err.message}\n`));
  // DEMO_COMMITS=1: Users latency carries on with the cache stack after it started (a fix on
  // #102, #103 restacked onto it with one more, and a branch of its own with no PR yet), so its
  // Commits chip has them. Off by default: other tours' orbit-api stays on main.
  if (process.env.DEMO_COMMITS) {
    await wait(1200);
    seedSessionCommits();
  }
}

function seedSessionCommits() {
  const main = join(files, 'orbit-api');
  // Committed in a worktree of its own: the checkout keeps its work in progress.
  const api = join(dir, 'commits-seed');
  git(main, 'worktree', 'add', '-q', api, 'cache/invalidate');
  put(api, 'src/routes/teams.ts', "import { db } from '../db';\nimport { forgetUsers } from './users';\n\nexport async function addMember(team: string, user: string) {\n  await db.teams.add(team, user);\n  forgetUsers();\n}\n\nexport async function removeMember(team: string, user: string) {\n  await db.teams.remove(team, user);\n  forgetUsers();\n}\n");
  git(api, 'commit', '-qam', 'Forget the users cache when someone leaves a team');
  git(api, 'rebase', '-q', 'cache/invalidate', 'cache/metrics');
  put(api, 'src/routes/metrics.ts', "import { usersCache } from './users';\n\nexport function metrics() {\n  const total = usersCache.hits + usersCache.misses;\n  return { usersCacheHitRate: total ? usersCache.hits / total : 0, usersCacheLookups: total };\n}\n");
  git(api, 'commit', '-qam', 'Report how many lookups the hit rate is over');
  git(api, 'checkout', '-q', '-b', 'cache/warmup');
  put(api, 'src/boot.ts', "import { listUsers } from './routes/users';\n\n/** The first request after a deploy reads the cache, not the database. */\nexport async function warmUp() {\n  await listUsers();\n}\n");
  git(api, 'add', '-A');
  git(api, 'commit', '-qm', 'Warm the users cache at boot');
  // Pushed, as the agent would: the PRs' heads move with their branches.
  const state = JSON.parse(readFileSync(process.env.AH_GH_STATE, 'utf8'));
  const moved = state.prs.filter((p) => p.number === 102 || p.number === 103);
  for (const p of moved) p.headRefOid = git(api, 'rev-parse', p.headRefName).trim();
  git(api, 'push', '-q', '-f', 'origin', ...moved.map((p) => p.headRefName), ...moved.map((p) => `${p.headRefOid}:refs/pull/${p.number}/head`));
  writeFileSync(process.env.AH_GH_STATE, JSON.stringify(state, null, 2));
  git(main, 'worktree', 'remove', '--force', api);
  // The session is on the branch it made, its work in progress with it where it still applies.
  git(main, 'stash', '-q');
  git(main, 'checkout', '-q', 'cache/warmup');
  try {
    git(main, 'stash', 'pop', '-q');
  } catch {
    git(main, 'reset', '-q', '--hard');
    git(main, 'stash', 'drop', '-q');
  }
  writeFileSync(join(main, '.git', 'gh-stack'), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: 'main' }, branches: ['cache/users-query', 'cache/invalidate', 'cache/metrics', 'cache/warmup'].map((branch) => ({ branch })) }] }));
}

async function seedConductor() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const launch = (cwd, prompt, extra = {}) => ({ kind: 'launch', preset: 'claude', cwd: join(files, cwd), prompt, ...extra });
  const job = (name, action, trigger, policy) => call('POST', '/api/jobs', { name, action, trigger, ...(policy ? { policy } : {}) });
  const nightly = await job('Nightly tests', launch('orbit-api', 'Run the whole test suite. Fix what fails, and say what you changed.', { model: 'opus', effort: 'high' }), { kind: 'cron', expr: '30 2 * * *', tz }, { retries: 2, notify: true, timeoutSeconds: 3600 });
  const triage = await job('Morning triage', launch('orbit-web', 'Read the new issues since yesterday and sort them by how much they hurt users.'), { kind: 'cron', expr: '0 9 * * 1-5', tz });
  // Once now, so it has a run (and a session) to show.
  await call('POST', `/api/jobs/${triage.id}/run`);
  await job('Explain what failed', launch('orbit-api', 'The nightly run failed. Find the first failing test and explain why.'), { kind: 'after', job: nightly.id, on: 'failure' });
  const weekly = await job('Dependency bump', launch('orbit-web', 'Update dependencies one at a time; keep the ones whose tests pass.', { worktree: true }), { kind: 'cron', expr: '0 10 * * 1', tz });
  await call('POST', `/api/jobs/${weekly.id}/pause`);
  const deploy = await job(
    'Deploy staging',
    { kind: 'decide', title: 'Deploy orbit-web to staging?', body: 'Nightly tests passed on main: 212 tests, no failures. Release notes 1.42 are drafted. Going ahead starts an agent in orbit-infra that deploys and smoke-tests staging.', then: launch('orbit-infra', 'Deploy orbit-web to staging and smoke-test the sign-in flow.') },
    { kind: 'manual' },
  );
  await call('POST', `/api/jobs/${deploy.id}/run`);
  await seedUsage();
}

/**
 * Ninety days of token counts for the demo's Claude sessions and a Codex conversation, and the
 * rate-limit windows Codex reports (server/usage). The scripted agent records no usage in its
 * transcripts, so the rows go straight into the host's database, as its own ingest writes them.
 */
async function seedUsage() {
  const { DatabaseSync } = await import('node:sqlite');
  // The host writes too (a job's run, a session's record): wait for its lock rather than fail.
  const db = new DatabaseSync(join(dir, 'state', 'ah', 'ah.db'), { timeout: 15_000 });
  const state = await call('GET', '/api/state');
  const claude = state.windows.filter((w) => w.agent === 'claude' && w.harnessId);
  // A fixed sequence, so every demo shows the same numbers.
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    'INSERT OR REPLACE INTO UsageDaily (id, day, host, convKey, uid, harness, provider, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, messages, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const row = (day, convKey, uid, harness, provider, model, scale) => {
    const input = Math.round(scale * (8_000 + rand() * 40_000));
    insert.run(`${day}|${convKey}|${model}`, day, state.hostname, convKey, uid, harness, provider, model, input, Math.round(input * (0.2 + rand() * 0.3)), Math.round(input * (6 + rand() * 10)), Math.round(input * (0.4 + rand() * 0.6)), harness === 'codex' ? Math.round(input * 0.1) : 0, Math.round(4 + rand() * 30), now);
  };
  for (let back = 0; back < 90; back++) {
    const day = new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
    // Busier on weekdays, and busier lately.
    const weekday = ![0, 6].includes(new Date(Date.now() - back * 86_400_000).getUTCDay());
    const level = (weekday ? 1 : 0.25) * (back < 30 ? 1.4 : 0.8);
    claude.forEach((w, i) => {
      if (rand() < 0.35) return;
      row(day, `claude:${w.harnessId}`, w.uid, 'claude', 'anthropic', i % 3 === 0 ? 'claude-opus-5-5' : i % 3 === 1 ? 'claude-sonnet-5-5' : 'claude-haiku-5-5', level * (i === 4 ? 2.5 : 1));
    });
    if (rand() < 0.6) row(day, 'codex:demo-refactor', null, 'codex', 'openai', 'gpt-5.5-codex', level * 1.2);
  }
  const sample = db.prepare('INSERT INTO RateLimitSample (harness, provider, window, usedPercent, windowMinutes, resetsAt, source, observedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  sample.run('codex', 'openai', 'primary', 62, 300, now + 2 * 3600 + 900, 'provider_telemetry', now - 120);
  sample.run('codex', 'openai', 'secondary', 31, 10080, now + 4 * 86_400, 'provider_telemetry', now - 120);
  db.close();
}

const info = JSON.stringify({ port: ah.port, localToken: ah.localToken(), dir });
writeFileSync(join(dir, 'demo.json'), info + '\n');
// startAh's bootstrap tmux session isn't part of the demo: end it, and forget its record.
if (fresh) {
  try { ah.tmux('kill-session', '-t', '_harness'); } catch {}
  await wait(1500);
  const state = await call('GET', '/api/state');
  for (const item of state.history ?? []) {
    if (!item.cwd?.startsWith(files)) await call('DELETE', `/api/sessions/${encodeURIComponent(item.ref)}`).catch(() => {});
  }
}
process.stdout.write(info + '\n');

let written = 0;
setInterval(() => {
  const log = ah.log();
  if (log.length > written) {
    process.stderr.write(log.slice(written));
    written = log.length;
  }
}, 500).unref();

let done = false;
const stop = async () => {
  if (done) return;
  done = true;
  // Keep the state dir with --dir (so a restart keeps the app's enrollment); drop a temp one.
  model.close();
  if (dirArg > 0) await ah.stop();
  else await cleanup(ah).catch(() => {});
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
