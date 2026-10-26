#!/usr/bin/env node
// A disposable ah host with something to look at, for walking the app's screens (UI tours,
// screenshots, hand testing in the simulator). Isolated like scripts/it-host.mjs: its own
// home, state and tmux server, loopback only, and scripted agents (scripts/demo/agent.mjs)
// instead of real ones. Seeds two git projects (branches, a worktree, uncommitted work, a
// dev server for Preview) and sessions in every state: waiting on you, idle with a full
// conversation, a worktree, shells, and an ended one in History. Agents run under ah's own
// Claude Code preset, so launch choices (model, effort, permissions) are the real ones.
//
// Stack review has three stacked pull requests in orbit-api, behind a stand-in `gh`
// (scripts/demo/gh.mjs) and a bare repository as their GitHub, and a scripted model
// (scripts/demo/model.mjs) answers briefings, the reviewer thread and side chat.
//
//   AH_SOURCE=../ah node scripts/demo/host.mjs [--dir <state dir>]
//
// Prints one JSON line {port, localToken, dir} once the sessions are up, then runs until
// stdin closes or SIGTERM. `node scripts/demo/code.mjs <dir>` prints a setup code.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startModel } from './model.mjs';

const source = resolve(process.env.AH_SOURCE ?? new URL('../../../ah', import.meta.url).pathname);
const { startAh, cleanup } = await import(pathToFileURL(join(source, 'test/helpers.ts')).href);
const here = new URL('.', import.meta.url).pathname;
const dirArg = process.argv.indexOf('--dir');
const dir = dirArg > 0 ? resolve(process.argv[dirArg + 1]) : mkdtempSync(join(tmpdir(), 'ah-native-demo-'));
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
mkdirSync(join(dir, 'cache', 'ah', 'uploads'), { recursive: true });
const ah = await startAh({ idleAfter: 2, files: { roots: [join(dir, 'files'), join(dir, 'cache', 'ah', 'uploads')] } }, dir);

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

if (fresh) {
  await open('claude', 'orbit-web', 'Welcome flow', 'orbit');
  await wait(400);
  await open('claude', 'orbit-infra', 'Rotate API keys', 'orbit');
  await wait(400);
  await open('claude', 'orbit-api', 'Users latency', 'orbit', { model: 'opus', effort: 'high' });
  await wait(400);
  await open('claude', 'orbit-api', 'Payments review', 'orbit', { worktree: true, mode: 'plan' });
  await wait(400);
  await open('shell', 'orbit-web', 'Dev server', 'tools');
  ah.tmux('send-keys', '-t', 'tools', `cd ${join(files, 'orbit-web')} && python3 -m http.server 5173 --bind 127.0.0.1`, 'Enter');
  await wait(400);
  await open('shell', 'orbit-api', 'Shell', 'tools');
  ah.tmux('send-keys', '-t', 'tools', 'git log --oneline --graph --all && git status -sb', 'Enter');
  // A worktree whose session ended, with work left in it: Worktrees' cleanup has something to do.
  const spike = await open('shell', 'orbit-web', 'Dark mode spike', 'tools', { worktree: true });
  await wait(600);
  const state = await call('GET', '/api/state');
  const spikeCwd = state.windows.find((w) => w.uid === spike.uid)?.cwd;
  if (spikeCwd) put(spikeCwd, 'src/theme.ts', "export const dark = { background: '#0b0b10', text: '#e6e6f0' };\n");
  await call('POST', `/api/sessions/${spike.uid}/terminate`);
  // One that ends, so History has something.
  const ended = await open('shell', 'orbit-web', 'Release notes 1.42', 'tools');
  await wait(1200);
  await call('POST', `/api/sessions/${ended.uid}/terminate`);
  // The cache stack, under review.
  await call('POST', '/api/review/stacks', { root: join(files, 'orbit-api'), prs: [101, 102, 103] }).catch((err) => process.stderr.write(`review stack: ${err.message}\n`));
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
