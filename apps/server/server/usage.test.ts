import '../test/scratch.ts';
// Usage: what's counted (once), from where, what it would cost at list price, and
// what stays unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsageLine, readFrom, type ParseState } from './usage/ingest.ts';
import { estimate, priceOf } from './usage/prices.ts';
import { ensureMigrated, getDb } from './db.ts';
import { UsageService, DEFAULT_USAGE } from './usage/service.ts';

const claude = (id: string, model = 'claude-opus-5-5', ts = '2026-11-14T10:00:00Z') => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model, content: [], usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 } } });
const codexTurn = (model: string) => JSON.stringify({ type: 'turn_context', payload: { model } });
const codexCount = (ts = '2026-11-14T10:00:00Z', used = 12.5) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 3000, cached_input_tokens: 2000, output_tokens: 400, reasoning_output_tokens: 100 } }, rate_limits: { primary: { used_percent: used, window_minutes: 300, resets_in_seconds: 3600 } } } });

test('parse: a Claude message counts once however many lines it spans; Codex splits cached input and carries its model', () => {
  const st: ParseState = {};
  assert.equal(parseUsageLine('claude', claude('msg_a'), st).usage?.inputTokens, 1000);
  assert.equal(parseUsageLine('claude', claude('msg_a'), st).usage, null, 'the same message on its next line');
  assert.equal(parseUsageLine('claude', claude('msg_b'), st).usage?.cacheReadTokens, 5000);
  assert.equal(parseUsageLine('claude', JSON.stringify({ type: 'assistant', message: { id: 'x', model: '<synthetic>', usage: { input_tokens: 1 } } }), st).usage, null, 'synthetic lines are not usage');
  const cx: ParseState = {};
  parseUsageLine('codex', codexTurn('gpt-5.5-codex'), cx);
  const ev = parseUsageLine('codex', codexCount(), cx, Date.parse('2026-11-14T10:00:00Z'));
  assert.deepEqual([ev.usage?.model, ev.usage?.inputTokens, ev.usage?.cacheReadTokens, ev.usage?.outputTokens, ev.usage?.reasoningTokens], ['gpt-5.5-codex', 1000, 2000, 400, 100]);
  assert.equal(ev.limits[0].window, 'primary');
  assert.equal(ev.limits[0].resetsAt, Math.floor(Date.parse('2026-11-14T10:00:00Z') / 1000) + 3600);
  assert.equal(parseUsageLine('gemini', claude('z'), {}).usage, null, 'agents that record no usage: unknown, not zero');
});

test('prices: list price with its basis, your price over it, and no price for what isn’t known', () => {
  const t = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
  const opus = priceOf('claude-opus-5-5');
  assert.equal(opus?.basis, 'list_price');
  assert.equal(estimate(t, opus), 4 + 20 + 0.2 + 5);
  assert.equal(priceOf('claude-opus-4-8-20260101')?.price.input, 5, 'a dated id names its model');
  assert.equal(priceOf('gpt-5.5-codex'), null, 'no built-in OpenAI prices');
  assert.equal(priceOf('gpt-5.5-codex', { 'gpt-5.5-codex': { input: 1, output: 8 } })?.basis, 'configured');
});

test('readFrom: only whole lines, a cut line read again next time', async () => {
  const f = join(mkdtempSync(join(tmpdir(), 'ah-usage-')), 't.jsonl');
  writeFileSync(f, 'one\ntwo\nthr');
  const r = await readFrom(f, 0);
  assert.deepEqual(r!.lines, ['one', 'two']);
  appendFileSync(f, 'ee\n');
  const r2 = await readFrom(f, r!.next);
  assert.deepEqual(r2!.lines, ['three']);
});

test('the service: incremental, never double, copies skipped, rewrites recounted, limits and export honest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-usage-'));
  const dbPath = join(dir, 'ah.db');
  await ensureMigrated(dbPath);
  const db = getDb(dbPath);
  const claudeFile = join(dir, 'c1.jsonl');
  const codexFile = join(dir, 'x1.jsonl');
  const copyFile = join(dir, 'c2.jsonl');
  writeFileSync(claudeFile, [claude('m1'), claude('m1'), claude('m2')].join('\n') + '\n');
  writeFileSync(codexFile, [codexTurn('gpt-5.5-codex'), codexCount(), codexCount(new Date().toISOString(), 100)].join('\n') + '\n');
  writeFileSync(copyFile, [claude('m1'), claude('m2')].join('\n') + '\n');
  const files = [
    { harness: 'claude', harnessId: 'c1', file: claudeFile, updatedAt: Math.floor(Date.now() / 1000) },
    { harness: 'codex', harnessId: 'x1', file: codexFile, updatedAt: Math.floor(Date.now() / 1000) },
    { harness: 'claude', harnessId: 'c2', file: copyFile, updatedAt: Math.floor(Date.now() / 1000) },
  ];
  const svc = new UsageService(db, { host: () => 'h', transcripts: async () => files, uidOf: () => null, config: () => ({ ...DEFAULT_USAGE, billing: { anthropic: 'subscription' } }), liveLimits: () => [] });
  await svc.copied(copyFile); // a fork: its history was counted where it happened
  await svc.ingest();
  await svc.ingest(); // nothing new: nothing added
  const byModel = await svc.report({ from: '2026-11-01', to: '2026-11-30', by: 'model' });
  const opus = byModel.rows.find((r) => r.key === 'claude-opus-5-5')!;
  assert.deepEqual([opus.tokens.input, opus.messages, opus.sessions], [2000, 2, 1], 'two messages, once each, one conversation (the copy added nothing)');
  assert.equal(opus.cost.basis, 'list_price');
  assert.equal(opus.cost.billing, 'subscription', 'your billing, said beside the estimate');
  assert.equal(opus.cost.estimateUsd, Math.round(((2000 * 4 + 400 * 20 + 10000 * 0.2 + 600 * 5) / 1e6) * 100) / 100);
  const gpt = byModel.rows.find((r) => r.key === 'gpt-5.5-codex')!;
  assert.equal(gpt.cost.estimateUsd, null, 'no price: no number');
  assert.equal(gpt.cost.unpricedTokens, 2 * (1000 + 2000 + 400));
  appendFileSync(copyFile, claude('m3') + '\n'); // new work in the fork counts
  await svc.ingest();
  assert.equal((await svc.report({ from: '2026-11-01', to: '2026-11-30', by: 'session' })).rows.find((r) => r.key === 'claude:c2')!.messages, 1);
  writeFileSync(claudeFile, claude('m9') + '\n'); // rewritten: counted again from scratch, not added
  await svc.ingest();
  assert.equal((await svc.report({ from: '2026-11-01', to: '2026-11-30', by: 'session' })).rows.find((r) => r.key === 'claude:c1')!.messages, 1);
  const lim = await svc.limits();
  assert.equal(lim.windows[0].source, 'provider_telemetry');
  assert.equal(lim.windows[0].usedPercent, 100);
  assert.deepEqual((await svc.knownLimit('codex'))?.why, 'primary window at 100%');
  assert.equal(await svc.knownLimit('claude'), null);
  const csv = await svc.export('csv');
  assert.match(csv.split('\n')[0], /^day,host,conversation/);
  assert.ok(csv.includes('local_telemetry'));
});
