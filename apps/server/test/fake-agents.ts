// Shared bed for the conductor tests: an ah whose Claude Code and Codex are the
// stand-in in test/fixtures/fake-harness.js (real transcript formats, real resume
// by id), so whole journeys run without an AI CLI or a provider.
import { copyFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAh, http, until, type Ah } from './helpers.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-harness.js', import.meta.url));

export function fakePresets(bin: string) {
  return [
    { id: 'shell', name: 'Shell', command: '' },
    { id: 'claude', name: 'Claude Code', command: `${bin}/claude`, resume: `${bin}/claude --continue`, resumeId: `${bin}/claude --resume {id}`, match: '^claude$', feed: 'claude', interruptKeys: ['Escape'] },
    {
      id: 'codex', name: 'Codex', command: `${bin}/codex`, resume: `${bin}/codex resume --last`, resumeId: `${bin}/codex resume {id}`, fork: `${bin}/codex fork {id} -c 'tui.resume_cwd="current"'`, match: '^codex$', feed: 'codex', interruptKeys: ['Escape'],
      models: [{ id: 'gpt-x', name: 'GPT X', args: ['--model', 'gpt-x'] }],
      effort: { args: ['-c', 'model_reasoning_effort={level}'], levels: ['low', 'medium', 'high'] },
    },
  ];
}

/** Makes the bed's directory with the stand-in CLIs and a git project; returns both. */
export function bedDir(): { dir: string; bin: string; project: string } {
  const dir = mkdtempSync(join(tmpdir(), 'ah-it-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const name of ['claude', 'codex']) {
    copyFileSync(FIXTURE, join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  const project = join(dir, 'files', 'proj');
  mkdirSync(project, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', ['-C', project, ...a], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  git('init', '-q', '-b', 'main');
  execFileSync('sh', ['-c', `echo hi > ${project}/README.md`]);
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  return { dir, bin, project };
}

export async function startBed(extra: Record<string, unknown> = {}, env: Record<string, string> = {}): Promise<Ah & { bin: string; project: string }> {
  const { dir, bin, project } = bedDir();
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) [saved[k], process.env[k]] = [process.env[k], v];
  try {
    const ah = await startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: fakePresets(bin), ...extra }, dir);
    return Object.assign(ah, { bin, project });
  } finally {
    for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  }
}

export const windows = async (ah: Ah) => (await http(ah, 'GET', '/api/state')).json().windows as any[];

/** Starts an agent session and waits until it has its conversation id. */
export async function launch(ah: Ah, preset: string, cwd: string, label?: string) {
  const res = await http(ah, 'POST', '/api/windows', { body: { preset, cwd, ...(label ? { label } : {}) } });
  // A 500 says only "internal error" to the client; why is in the host's log.
  if (res.status !== 201) throw new Error(`launch ${preset}: ${res.status} ${res.body}${res.status === 500 ? `\nthe host's log ends:\n${ah.log().slice(-3000)}` : ''}`);
  const { uid } = res.json();
  return until(async () => (await windows(ah)).find((w) => w.uid === uid && w.harnessId && w.agent === preset), 15000, `${preset} up`);
}

/** Sends and waits for the stand-in's scripted answer to land in its transcript. */
export async function say(ah: Ah, uid: string, text: string) {
  const sent = Date.now();
  const res = await http(ah, 'POST', `/api/sessions/${uid}/send`, { body: { text } });
  if (res.status !== 200) throw new Error(`send: ${res.status} ${res.body}`);
  const first = text.split('\n')[0].slice(0, 30);
  await until(async () => (await transcriptOf(ah, uid))?.includes(`Got: ${first}`), 15000, `reply to "${first}"`);
  // Past the submit grace too: a just-sent session reads as working for 5 s, and the
  // state the API answers with can predate the send, so idle only counts after it.
  await until(async () => Date.now() - sent > 5500 && ['idle', 'attention'].includes((await windows(ah)).find((w) => w.uid === uid)?.status), 15000, 'idle after the reply');
}

/** A session's transcript as text (Claude's or Codex's own file), or null. */
export async function transcriptOf(ah: Ah, uid: string): Promise<string | null> {
  const w = (await windows(ah)).find((x) => x.uid === uid);
  const id = w?.harnessId;
  if (!id) return null;
  const file = transcriptFile(ah, id);
  return file ? readFileSync(file, 'utf8') : null;
}

export function transcriptFile(ah: { dir: string }, id: string): string | null {
  const walk = (d: string): string[] => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])) : []);
  return [...walk(join(ah.dir, 'claude', 'projects')), ...walk(join(ah.dir, 'codex', 'sessions'))].find((f) => f.endsWith(`${id}.jsonl`)) ?? null;
}

// ---------- two hosts (migration)

export const REMOTE = 'https://github.com/example/proj.git';
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

export async function withHost<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.AH_HOSTNAME;
  process.env.AH_HOSTNAME = name;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.AH_HOSTNAME;
    else process.env.AH_HOSTNAME = prev;
  }
}

export type Pair = { a: Ah; b: Ah; aBed: ReturnType<typeof bedDir>; bBed: ReturnType<typeof bedDir>; bCheckout: string; token: string };

/** B first (A probes its peers at start), then A trusting B with B's token. */
export async function hostPair(o: { bPresets?: (bin: string) => unknown[]; bConfig?: Record<string, unknown> } = {}): Promise<Pair> {
  const aBed = bedDir();
  const bBed = bedDir();
  git(aBed.project, 'remote', 'add', 'origin', REMOTE);
  // B's checkout of the same repository, somewhere else entirely.
  const bCheckout = join(bBed.dir, 'files', 'work', 'proj');
  mkdirSync(join(bBed.dir, 'files', 'work'), { recursive: true });
  execFileSync('git', ['clone', '-q', aBed.project, bCheckout]);
  git(bCheckout, 'remote', 'set-url', 'origin', REMOTE);
  const b = await withHost('mac-b', () => startAh({ auth: { mode: 'passkey' }, idleAfter: 1, presets: (o.bPresets ?? fakePresets)(bBed.bin), ...o.bConfig }, bBed.dir));
  const token = (await http(b, 'POST', '/api/auth/tokens', { token: b.localToken(), body: { name: 'omarchy-a' } })).json().token;
  const a = await withHost('omarchy-a', () => startAh({ auth: { mode: 'off' }, idleAfter: 1, presets: fakePresets(aBed.bin), peers: [{ name: 'mac-b', url: `http://127.0.0.1:${b.port}`, token }] }, aBed.dir));
  await until(async () => (await http(a, 'GET', '/api/state')).json().hosts.some((h: any) => h.name === 'mac-b' && h.online), 10000, 'a sees b');
  return { a, b, aBed, bBed, bCheckout, token };
}

