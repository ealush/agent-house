// Black-box harness: runs the real server as a child process with throwaway state,
// its own config, and its own tmux server (TMUX_TMPDIR), so tests can never touch
// the developer's real sessions, and every test sees exactly what a client would.
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';

const MAIN = fileURLToPath(new URL('../server/main.ts', import.meta.url));
export const TAILNET_DNS = 'box.test.ts.net';
export const OWNER = 'owner@example.com';

export type Ah = {
  port: number;
  dir: string;
  env: NodeJS.ProcessEnv;
  proc: ChildProcess;
  log: () => string;
  localToken: () => string;
  tmux: (...args: string[]) => string;
  restart: () => Promise<Ah>;
  stop: (signal?: NodeJS.Signals) => Promise<void>;
};

/** Starts ah with isolated state. `config` is written to its config.json. */
export async function startAh(config: Record<string, unknown> = {}, dir = mkdtempSync(join(tmpdir(), 'ah-it-'))): Promise<Ah> {
  const files = join(dir, 'files');
  mkdirSync(join(dir, 'config', 'ah'), { recursive: true });
  mkdirSync(files, { recursive: true });
  mkdirSync(join(dir, 'home'), { recursive: true });
  mkdirSync(join(dir, 'tmux'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'config', 'ah', 'config.json'), JSON.stringify({ defaultSession: 'it', projectRoots: [files], files: { roots: [files] }, ...config }));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(dir, 'home'),
    GROK_HOME: join(dir, 'grok'),
    XDG_DATA_HOME: join(dir, 'data'),
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_STATE_HOME: join(dir, 'state'),
    XDG_CACHE_HOME: join(dir, 'cache'),
    TMUX_TMPDIR: join(dir, 'tmux'),
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    CODEX_HOME: join(dir, 'codex'),
    AH_TAILNET_DNS: TAILNET_DNS,
    AH_TAILNET_OWNER: OWNER,
    // Never touch the developer's real `tailscale serve` config from a test.
    AH_PREVIEW_PUBLISH: '0',
    // Nor run the developer's real agent CLIs to read their versions.
    AH_HARNESS_CHECK: process.env.AH_HARNESS_CHECK ?? '0',
    TMUX: '',
  };
  delete env.TMUX;
  delete env.AH_PORT;
  delete env.AH_HOST;

  // Start the private tmux server ourselves, without the developer's tmux.conf, so
  // tests behave the same on every machine (and an old tmux doesn't choke on new options).
  try {
    execFileSync('tmux', ['-f', '/dev/null', 'new-session', '-d', '-s', '_harness'], { env, stdio: 'ignore' });
  } catch {
    // already running (restart of the same dir)
  }

  const proc = spawn(process.execPath, [MAIN, '--port', '0'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ah didn't start:\n${out}`)), 15_000);
    const check = () => {
      const m = out.match(/ah listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    proc.stdout!.on('data', check);
    proc.on('exit', (code) => reject(new Error(`ah exited (${code}):\n${out}`)));
  });

  const ah: Ah = {
    port,
    dir,
    env,
    proc,
    log: () => out,
    localToken: () => readFileSync(join(dir, 'state', 'ah', 'local-token'), 'utf8').trim(),
    tmux: (...args) => execFileSync('tmux', args, { env, encoding: 'utf8' }),
    restart: async () => {
      await ah.stop();
      return startAh(config, dir);
    },
    stop: (signal = 'SIGTERM') =>
      new Promise((resolve) => {
        if (proc.exitCode !== null || proc.signalCode) return resolve();
        proc.once('exit', () => resolve());
        proc.kill(signal);
      }),
  };
  return ah;
}

/** Kills the test's private tmux server and the daemon, then removes its state. */
export async function cleanup(ah: Ah) {
  await ah.stop();
  try {
    execFileSync('tmux', ['kill-server'], { env: ah.env, stdio: 'ignore' });
  } catch {}
  // Each run leaves ~200 MB of caches behind otherwise, and /tmp is a tmpfs.
  rmSync(ah.dir, { recursive: true, force: true });
}

export type Res = { status: number; headers: Record<string, string | string[] | undefined>; body: string; json: () => any };

/** Raw HTTP so tests can forge any header (fetch won't let you set Host). */
export function http(
  ah: { port: number },
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown; raw?: Buffer | string; cookie?: string; token?: string; host?: string; origin?: string | null; csrf?: boolean } = {},
): Promise<Res> {
  const origin = opts.origin === undefined ? `http://localhost:${ah.port}` : opts.origin;
  const headers: Record<string, string> = {
    host: opts.host ?? `localhost:${ah.port}`,
    ...(origin ? { origin } : {}),
    ...(method !== 'GET' && opts.csrf !== false ? { 'x-ah': '1' } : {}),
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...opts.headers,
  };
  const payload = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (payload !== undefined && opts.body !== undefined) headers['content-type'] = 'application/json';
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: ah.port, method, path, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json: () => JSON.parse(body) }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Signs in a "browser" via a master password set through the host token; returns its cookie. */
export async function signIn(ah: Ah, label = 'test device'): Promise<string> {
  const pw = 'correct horse battery staple';
  await http(ah, 'POST', '/api/auth/password', { token: ah.localToken(), body: { password: pw } });
  const res = await http(ah, 'POST', '/api/auth/password/login', { body: { password: pw, label } });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${res.body}`);
  const set = res.headers['set-cookie'];
  return String(Array.isArray(set) ? set[0] : set).split(';')[0];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns truthy, or fails with the last value. */
export async function until<T>(fn: () => Promise<T> | T, ms = 8000, what = 'condition'): Promise<T> {
  const end = Date.now() + ms;
  let last: T;
  do {
    last = await fn();
    if (last) return last;
    await sleep(100);
  } while (Date.now() < end);
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last!)})`);
}
