#!/usr/bin/env node
// The conformance suite: ah against the agents' real CLIs, so a new version that changes a screen,
// a flag or a transcript fails here rather than in your hands. It starts a disposable ah from this
// checkout (its own state, its own tmux socket, your agents' own sign-ins: HOME is yours), runs the
// capability rounds (capabilities.mjs) and the scenarios from ah's bug-fix history (history.mjs)
// against it, writes a report, and takes the host and its tmux down again. Real agents answer, so
// a run spends a little of their quota.
//
//   node conformance/run.mjs [--agents claude,codex] [--suites capabilities,history] [--only a,b]
//                            [--report DIR] [--reason TEXT]
//
// The report (report.json, report.md and each suite's output) goes to DIR, by default
// $XDG_STATE_HOME/ah/conformance/<time>. Exit status 1 when a check failed for a reason other than
// the agent's provider (a rate limit, a request too large).
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, createWriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MAIN = join(here, '..', 'server', 'main.ts');
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith('--') ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const AGENTS = (args.agents ?? 'claude,codex,gemini,grok,muse').split(',');
const SUITES = (args.suites ?? 'capabilities,history').split(',');
const STATE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'conformance');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const REPORT = args.report ?? join(STATE, stamp);
mkdirSync(REPORT, { recursive: true });

// The sessions work in a repository of their own, kept between runs (an agent trusts it once).
const WORK = join(STATE, 'work');
if (!existsSync(join(WORK, '.git'))) {
  mkdirSync(join(WORK, 'src'), { recursive: true });
  writeFileSync(join(WORK, 'README.md'), '# conformance\n\nA project ah\'s conformance suite runs agents in.\n');
  writeFileSync(join(WORK, 'src', 'app.ts'), 'export const answer = 41;\n');
  const git = (...a) => execFileSync('git', ['-C', WORK, '-c', 'user.name=ah', '-c', 'user.email=ah@localhost', ...a], { stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'Start');
}

// The host: its state under the cache (not /tmp, which is small), a short path for tmux's socket.
const HOST = mkdtempSync(join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ah-conf-'));
const port = await new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const BASE = `http://127.0.0.1:${port}`;
mkdirSync(join(HOST, 'config', 'ah'), { recursive: true });
mkdirSync(join(HOST, 't'), { recursive: true, mode: 0o700 });
writeFileSync(
  join(HOST, 'config', 'ah', 'config.json'),
  JSON.stringify({ port, auth: { mode: 'off' }, defaultSession: 'conformance', projectRoots: [WORK], files: { roots: [WORK] }, spaces: { root: join(HOST, 'spaces') }, checkouts: { autoIsolate: false, gcEnabled: false }, idleAfter: 4, conformance: { onUpdate: false } }, null, 2),
);
const SOCKET = join(HOST, 't', `tmux-${process.getuid()}`, 'default');
// Your environment (the agents' keys and sign-ins), without this session's ah and tmux.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(AH_|TMUX$|TMUX_PANE$|__MISE_|MISE_SHELL$)/.test(k)));
// And the PATH your ah's own sessions have (its tmux server's): the agents found the way they are
// for real. A shell's own PATH can put a wrapper first (a `claude` script that runs mise), and one
// that fails here would read as the agent failing. Only read from that server, never changed.
try {
  const tmuxEnv = Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'TMUX_TMPDIR'));
  const line = execFileSync('tmux', ['show-environment', '-g', 'PATH'], { env: tmuxEnv, encoding: 'utf8' }).trim();
  if (line.startsWith('PATH=')) env.PATH = line.slice(5);
} catch {}
// The agents' panes get the tmux server's environment: yours as it is (your shell's own setup,
// mise's trusted config, the agents' sign-ins), on the host's own socket.
env.TMUX_TMPDIR = join(HOST, 't');
execFileSync('tmux', ['-S', SOCKET, '-f', '/dev/null', 'new-session', '-d', '-s', '_conformance'], { env, stdio: 'ignore' });
// The host alone keeps its state apart from your ah's.
const hostEnv = { ...env, XDG_CONFIG_HOME: join(HOST, 'config'), XDG_STATE_HOME: join(HOST, 'state'), XDG_CACHE_HOME: join(HOST, 'cache') };
// ah gives its sessions its XDG_STATE_HOME (for the ah CLI in them), so other tools there read
// state from the host's folder: everything in yours but ah's is linked into it (mise's record of
// the configs you trust, or every shell in a session stops to ask).
const realState = process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
mkdirSync(join(HOST, 'state'), { recursive: true });
for (const name of existsSync(realState) ? readdirSync(realState) : []) if (name !== 'ah') symlinkSync(join(realState, name), join(HOST, 'state', name));

let host = null;
const log = createWriteStream(join(REPORT, 'ah.log'), { flags: 'a' });
async function startHost() {
  host = spawn(process.execPath, [MAIN, '--port', String(port)], { env: hostEnv, cwd: homedir(), stdio: ['ignore', 'pipe', 'pipe'] });
  host.stdout.pipe(log, { end: false });
  host.stderr.pipe(log, { end: false });
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000) {
    if (await fetch(`${BASE}/api/state`).then((r) => r.ok, () => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the host didn't start; ${join(REPORT, 'ah.log')} says why`);
}
async function stopHost() {
  if (!host || host.exitCode !== null) return;
  const gone = new Promise((r) => host.once('exit', r));
  host.kill('SIGTERM');
  await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
}

// A restart the scenarios can ask for (ah restarting under a Send Now, sessions living on).
const RESTART = join(HOST, 'restart.mjs');
const control = createServer();
await new Promise((r) => control.listen(join(HOST, 'control.sock'), r));
control.on('connection', (c) => c.on('data', async () => {
  await stopHost();
  await startHost();
  c.end('up\n');
}));
writeFileSync(RESTART, `#!/usr/bin/env node\nimport { connect } from 'node:net';\nconst c = connect(${JSON.stringify(join(HOST, 'control.sock'))}, () => c.write('restart\\n'));\nc.on('data', () => process.exit(0));\n`, { mode: 0o755 });

const report = { at: new Date().toISOString(), reason: args.reason ?? null, agents: AGENTS, versions: {}, suites: {} };
let failed = 0;
try {
  await startHost();
  // What each CLI is, as ah reads it: the versions this run vouches for.
  const harnesses = await fetch(`${BASE}/api/harnesses/check`, { method: 'POST', headers: { 'x-ah': '1', origin: BASE } }).then((r) => r.json()).catch(() => null);
  for (const a of harnesses?.agents ?? []) if (AGENTS.includes(a.id)) report.versions[a.id] = a.version ?? null;

  for (const suite of SUITES) {
    const results = join(REPORT, `${suite}.json`);
    const out = createWriteStream(join(REPORT, `${suite}.out`));
    const extra = suite === 'capabilities' ? ['--cross', '1'] : [];
    const child = spawn(process.execPath, [join(here, `${suite}.mjs`), '--agents', AGENTS.join(','), ...(args.only ? ['--only', args.only] : []), ...extra], {
      env: { ...env, CONFORMANCE_BASE: BASE, CONFORMANCE_WORK: WORK, CONFORMANCE_TMUX: SOCKET, CONFORMANCE_RESTART: RESTART, CONFORMANCE_LOG: join(REPORT, `${suite}.jsonl`), CONFORMANCE_RESULTS: results },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => (process.stdout.write(d), out.write(d)));
    child.stderr.on('data', (d) => (process.stderr.write(d), out.write(d)));
    await new Promise((r) => child.on('exit', r));
    const list = existsSync(results) ? JSON.parse(readFileSync(results, 'utf8')) : [{ ok: false, error: `${suite} ended without results (exit ${child.exitCode})` }];
    report.suites[suite] = list;
    // The provider's own answers (a rate limit, a request too large) aren't ah's to fix.
    failed += list.filter((r) => !r.ok && !r.provider && !/\b(429|413)\b|rate limit/i.test(r.error ?? '')).length;
  }
} catch (err) {
  report.error = err.message;
  failed++;
} finally {
  await stopHost();
  control.close();
  try {
    execFileSync('tmux', ['-S', SOCKET, 'kill-server'], { stdio: 'ignore' });
  } catch {}
  rmSync(HOST, { recursive: true, force: true });
}

const all = Object.values(report.suites).flat();
report.passed = all.filter((r) => r.ok).length;
report.total = all.length;
report.failed = failed;
writeFileSync(join(REPORT, 'report.json'), JSON.stringify(report, null, 2));
const lines = [
  `# Conformance ${report.at}`,
  '',
  report.reason ? `Why: ${report.reason}` : 'Run by hand.',
  '',
  `Versions: ${Object.entries(report.versions).map(([a, v]) => `${a} ${v ?? '?'}`).join(', ') || 'unknown'}`,
  '',
  `${report.passed}/${report.total} passed; ${failed} failed for a reason of ah's to look at.`,
  ...(report.error ? ['', `The run stopped: ${report.error}`] : []),
  '',
  ...all.filter((r) => !r.ok).map((r) => `- FAIL ${r.agent ?? ''} ${r.name ?? r.s ?? ''}: ${r.error ?? ''}`),
];
writeFileSync(join(REPORT, 'report.md'), lines.join('\n') + '\n');
console.log(`\n${lines.join('\n')}\nReport: ${REPORT}`);
process.exit(failed ? 1 : 0);
