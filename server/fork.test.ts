import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTranscript, FORKERS, encodeClaudeProjectDir, forkUnavailableReason } from './fork.ts';
import { parseClaude, parseCodex } from './discovery.ts';
import { ensureMigrated } from './db.ts';
import { Registry } from './registry.ts';

// Fixture provenance (version-sensitive adapters): these samples pin the
// transcript shapes the forkers in `./fork.ts` understand. Upstream layout
// changes break forking without touching ah, so refreshing a fixture for a new
// harness version must keep the identity fields the forkers rewrite — pinned
// by the contract test below — and update the shape stamp + capture date here.
const CLAUDE_SHAPE = 'claude-code jsonl, captured ~late 2026: per-line sessionId/cwd, bucket dir by encoded cwd';
const CODEX_SHAPE = 'codex rollout jsonl, captured ~late 2026: session_meta payload.id/cwd, rollout-<stamp>-<id>.jsonl under sessions/YYYY/MM/DD';

const CLAUDE_SRC = [
  '{"type":"mode","sessionId":"abc"}',
  '{"type":"user","isSidechain":false,"cwd":"/home/u/code/proj","sessionId":"abc","message":{"role":"user","content":"fix the flaky login test"}}',
  '{"type":"assistant","cwd":"/home/u/code/proj","sessionId":"abc","message":{"model":"claude-opus-5-5","content":[]}}',
  '{"type":"ai-title","aiTitle":"Fix flaky login test","sessionId":"abc"}',
  '',
].join('\n');

const CODEX_SRC = [
  '{"timestamp":"2026-10-04T19:05:48.010Z","type":"session_meta","payload":{"id":"0199-codex","cwd":"/home/u/code/proj","base_instructions":{"text":"You are Codex"}}}',
  '{"timestamp":"2026-10-04T19:05:48.526Z","type":"turn_context","payload":{"cwd":"/home/u/code/proj","model":"gpt-6.1-sol"}}',
  '{"timestamp":"2026-10-04T19:05:48.600Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"review PR 12"}]}}',
  '',
].join('\n');

test(`fork fixtures carry the identity fields the forkers rewrite (${CLAUDE_SHAPE}; ${CODEX_SHAPE})`, () => {
  const claudeLines = CLAUDE_SRC.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(claudeLines.some((d) => typeof d?.sessionId === 'string'), 'claude fixture needs per-line sessionId');
  assert.ok(claudeLines.some((d) => typeof d?.cwd === 'string'), 'claude fixture needs per-line cwd');
  const codexLines = CODEX_SRC.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const meta = codexLines.find((d) => d?.type === 'session_meta');
  assert.ok(meta && typeof meta.payload?.id === 'string', 'codex fixture needs session_meta payload.id');
  assert.ok(codexLines.some((d) => typeof d?.payload?.cwd === 'string'), 'codex fixture needs payload.cwd');
});

test('claude project buckets are the cwd with non-alphanumerics dashed', () => {
  assert.equal(encodeClaudeProjectDir('/home/u/code/my proj'), '-home-u-code-my-proj');
  assert.equal(encodeClaudeProjectDir('/tmp/a.b_c'), '-tmp-a-b-c');
});

test('claude fork copy is re-ided and re-homed to the worktree bucket', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fork-unit-'));
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  const src = join(dir, 'abc.jsonl');
  await writeFile(src, CLAUDE_SRC);
  const target = '/home/u/code/.worktrees/proj/risky-1a2b';
  const { harnessId, file } = await copyTranscript('claude', src, target);
  assert.notEqual(harnessId, 'abc');
  assert.equal(file, join(dir, 'claude', 'projects', encodeClaudeProjectDir(target), `${harnessId}.jsonl`));
  const parsed = await parseClaude(file, 999);
  assert.equal(parsed?.harnessId, harnessId);
  assert.equal(parsed?.cwd, target);
  assert.equal(parsed?.title, 'Fix flaky login test');
  // The parent transcript is untouched.
  assert.equal(await readFile(src, 'utf8'), CLAUDE_SRC);
});

test('codex fork copy rewrites the rollout id and cwd, keeping its date directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fork-unit-'));
  process.env.CODEX_HOME = join(dir, 'codex');
  const day = join(dir, 'codex', 'sessions', '2026', '10', '04');
  await mkdir(day, { recursive: true });
  const src = join(day, 'rollout-2026-10-04T19-05-48-0199-codex.jsonl');
  await writeFile(src, CODEX_SRC);
  const target = '/home/u/code/.worktrees/proj/risky-1a2b';
  const { harnessId, file } = await copyTranscript('codex', src, target);
  assert.notEqual(harnessId, '0199-codex');
  assert.ok(file.startsWith(day), file);
  assert.ok(file.endsWith(`-${harnessId}.jsonl`), file);
  const parsed = await parseCodex(file, 999);
  assert.equal(parsed?.harnessId, harnessId);
  assert.equal(parsed?.cwd, target);
  assert.equal(await readFile(src, 'utf8'), CODEX_SRC);
});

test('a failed copy leaves nothing behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fork-unit-'));
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  await assert.rejects(() => copyTranscript('claude', join(dir, 'missing.jsonl'), '/home/u/code/x'));
  const bucket = join(dir, 'claude', 'projects', encodeClaudeProjectDir('/home/u/code/x'));
  assert.ok(!existsSync(bucket) || (await readdir(bucket)).length === 0);
});

test('unavailable reasons are specific per harness', () => {
  assert.match(forkUnavailableReason('shell', undefined)!, /shell sessions have no conversation/);
  assert.match(forkUnavailableReason('claude', undefined)!, /no conversation id/);
  assert.match(forkUnavailableReason('grok', 'g1')!, /can't be forked yet/);
  assert.equal(forkUnavailableReason('claude', 'c1'), null);
  assert.equal(forkUnavailableReason('codex', 'x1'), null);
});

test('registry lineage: forksOf and forkParent read ah.fork meta', async () => {
  const path = join(tmpdir(), `ah-fork-reg-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  await ensureMigrated(path);
  const reg = new Registry(path);
  await reg.ready();
  const meta = (parentUid: string, rootUid: string, forkSeq: number) => ({ 'ah.fork': { parentUid, rootUid, rootTitle: 'root title', forkedAt: 100 + forkSeq, forkSeq } });
  reg.starting('root1', { harness: 'claude', cwd: '/tmp', title: 'root title', tmux: { session: 's', windowId: '@1' } });
  reg.starting('fork1', { harness: 'claude', cwd: '/tmp/w1', title: 'f1', tmux: { session: 's', windowId: '@2' }, meta: meta('root1', 'root1', 1) });
  reg.starting('fork2', { harness: 'claude', cwd: '/tmp/w2', title: 'f2', tmux: { session: 's', windowId: '@3' }, meta: meta('root1', 'root1', 2) });
  reg.starting('fork1a', { harness: 'claude', cwd: '/tmp/w3', title: 'f1a', tmux: { session: 's', windowId: '@4' }, meta: meta('fork1', 'root1', 1) });
  assert.deepEqual(reg.forksOf('root1').map((r) => r.id), ['fork1', 'fork2']);
  assert.deepEqual(reg.forksOf('fork1').map((r) => r.id), ['fork1a']);
  assert.equal(reg.forkParent('fork1a')?.id, 'fork1');
  assert.equal(reg.forkParent('root1'), undefined);
  assert.deepEqual(reg.forksOf('nope'), []);
});


test('fork copy never removes an existing conversation on an id collision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ah-fork-collision-'));
  process.env.CLAUDE_CONFIG_DIR = join(dir, 'claude');
  const target = '/tmp/fork-collision-target';
  const bucket = join(dir, 'claude', 'projects', encodeClaudeProjectDir(target));
  await mkdir(bucket, { recursive: true });
  const existing = join(bucket, 'existing.jsonl');
  await writeFile(existing, 'original conversation');
  const source = join(dir, 'source.jsonl');
  await writeFile(source, CLAUDE_SRC);
  await assert.rejects(FORKERS.claude(source, 'existing', target), { code: 'EEXIST' });
  assert.equal(await readFile(existing, 'utf8'), 'original conversation');
});
