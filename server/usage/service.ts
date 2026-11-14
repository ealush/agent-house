// Usage, quotas and cost visibility (docs/spec/13-conductor.md, CND-6).
//
// Every number says where it came from:
//  - tokens: `local_telemetry`, read from the harness's own transcript on this host;
//  - rate-limit windows: `provider_telemetry` (what Codex records the provider told it),
//    `screen` (a limit notice), or `transcript` (an error line), with when it was seen;
//  - cost: an `estimate` at list price (or your configured price), never a bill, with
//    your billing for that provider (`api`, `subscription` or `unknown`) beside it;
//  - anything ah can't see is `unknown`, not zero.
// ah never calls a provider's private endpoints for this, and decides nothing about
// money: the scheduler only waits on limits a provider stated.
import type { PrismaClient } from '@prisma/client';
import { conversationKey } from '../registry.ts';
import { parseUsageLine, readFrom, type ParseState } from './ingest.ts';
import { estimate, LIST_PRICES_AS_OF, priceOf, providerOf, type Price } from './prices.ts';

export type UsageConfig = {
  retentionDays: number;
  /** Your prices per model id (USD per million tokens), over the built-in list prices. */
  prices: Record<string, Partial<Price>>;
  /** How each provider bills you: `api` (per token), `subscription` (a plan), or `unknown`. */
  billing: Record<string, 'api' | 'subscription' | 'unknown'>;
};

export const DEFAULT_USAGE: UsageConfig = { retentionDays: 400, prices: {}, billing: {} };

export type UsageDeps = {
  host: () => string;
  transcripts: () => Promise<Array<{ harness: string; harnessId: string; file: string; updatedAt: number }>>;
  uidOf: (harness: string, harnessId: string) => string | null;
  config: () => UsageConfig;
  /** Limits ah knows from recovery (server/recovery) and screens: harness, until when, why. */
  liveLimits: () => Array<{ harness: string; uid: string; resetsAt: number | null; source: 'screen' | 'transcript'; text: string }>;
};

/** Harnesses whose transcripts record usage. */
const METERED = new Set(['claude', 'codex']);
const PASS_TOTAL = 64 * 1024 * 1024;

export type Group = 'day' | 'model' | 'provider' | 'harness' | 'session';

const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const now = () => Math.floor(Date.now() / 1000);

export class UsageService {
  private db: PrismaClient;
  private deps: UsageDeps;
  private ingesting: Promise<{ files: number; bytes: number; events: number }> | null = null;
  private timers: NodeJS.Timeout[] = [];
  /** File sizes as last seen: an unchanged file isn't opened. */
  private sizes = new Map<string, number>();

  constructor(db: PrismaClient, deps: UsageDeps) {
    this.db = db;
    this.deps = deps;
  }

  start(everyMs = 60_000) {
    const run = () => void this.ingest().catch((err) => console.warn('usage pass failed:', err));
    setTimeout(run, 5000).unref();
    this.timers.push(setInterval(run, everyMs));
    this.timers[0].unref?.();
    const prune = () => void this.prune().catch(() => {});
    setTimeout(prune, 30_000).unref();
    const t = setInterval(prune, 6 * 3600_000);
    t.unref?.();
    this.timers.push(t);
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
  }

  /**
   * A transcript ah just made as a copy of another (a fork, a native continuation, a
   * move from another host): its history's usage was counted where it happened, so
   * only what's written after now counts here.
   */
  async copied(file: string): Promise<void> {
    const r = await readFrom(file, Number.MAX_SAFE_INTEGER).catch(() => null);
    if (!r) return;
    await this.db.usageCursor.upsert({ where: { file }, create: { file, offset: r.size, ino: r.ino, updatedAt: now() }, update: { offset: r.size, ino: r.ino, stateJson: '{}', updatedAt: now() } });
    this.sizes.set(file, r.size);
  }

  /** One pass over what changed. Shared by concurrent callers. */
  ingest(): Promise<{ files: number; bytes: number; events: number }> {
    this.ingesting ??= this.pass().finally(() => (this.ingesting = null));
    return this.ingesting;
  }

  private async pass(): Promise<{ files: number; bytes: number; events: number }> {
    let budget = PASS_TOTAL;
    let files = 0;
    let bytes = 0;
    let events = 0;
    const cutoff = Date.now() - this.deps.config().retentionDays * 86_400_000;
    for (const t of await this.deps.transcripts()) {
      if (budget <= 0) break;
      if (!METERED.has(t.harness) || t.updatedAt * 1000 < cutoff) continue;
      const cursor = await this.db.usageCursor.findUnique({ where: { file: t.file } });
      let offset = cursor?.offset ?? 0;
      const known = this.sizes.get(t.file);
      const convKey = conversationKey(t.harness, t.harnessId, '');
      let r = await readFrom(t.file, offset, Math.min(budget, 32 * 1024 * 1024));
      if (!r) continue;
      if (known === r.size && offset >= r.size) continue;
      let state: ParseState = JSON.parse(cursor?.stateJson ?? '{}');
      // Rewritten or replaced: what was counted from it no longer holds; count it again.
      if (cursor && ((cursor.ino && r.ino !== cursor.ino) || r.size < offset)) {
        await this.db.usageDaily.deleteMany({ where: { convKey } });
        offset = 0;
        state = {};
        r = await readFrom(t.file, 0, Math.min(budget, 32 * 1024 * 1024));
        if (!r) continue;
      }
      this.sizes.set(t.file, r.size);
      if (!r.lines.length && r.next === offset) continue;
      files++;
      bytes += r.next - offset;
      budget -= r.next - offset;
      const sums = new Map<string, { day: string; model: string; i: number; o: number; cr: number; cw: number; re: number; m: number }>();
      const limits: Array<{ window: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | null; at: number }> = [];
      for (const line of r.lines) {
        const ev = parseUsageLine(t.harness, line, state);
        limits.push(...ev.limits);
        if (!ev.usage) continue;
        events++;
        const k = `${ev.usage.day}|${convKey}|${ev.usage.model}`;
        const s = sums.get(k) ?? { day: ev.usage.day, model: ev.usage.model, i: 0, o: 0, cr: 0, cw: 0, re: 0, m: 0 };
        s.i += ev.usage.inputTokens;
        s.o += ev.usage.outputTokens;
        s.cr += ev.usage.cacheReadTokens;
        s.cw += ev.usage.cacheWriteTokens;
        s.re += ev.usage.reasoningTokens;
        s.m++;
        sums.set(k, s);
      }
      const uid = this.deps.uidOf(t.harness, t.harnessId);
      // The counts and the cursor move together: a crash between them can't count a line twice.
      await this.db.$transaction([
        ...[...sums].map(([id, s]) =>
          this.db.usageDaily.upsert({
            where: { id },
            create: { id, day: s.day, host: this.deps.host(), convKey, uid, harness: t.harness, provider: providerOf(s.model, t.harness), model: s.model, inputTokens: s.i, outputTokens: s.o, cacheReadTokens: s.cr, cacheWriteTokens: s.cw, reasoningTokens: s.re, messages: s.m, updatedAt: now() },
            update: { inputTokens: { increment: s.i }, outputTokens: { increment: s.o }, cacheReadTokens: { increment: s.cr }, cacheWriteTokens: { increment: s.cw }, reasoningTokens: { increment: s.re }, messages: { increment: s.m }, ...(uid ? { uid } : {}), updatedAt: now() },
          }),
        ),
        this.db.usageCursor.upsert({ where: { file: t.file }, create: { file: t.file, offset: r.next, ino: r.ino, stateJson: JSON.stringify(state), updatedAt: now() }, update: { offset: r.next, ino: r.ino, stateJson: JSON.stringify(state), updatedAt: now() } }),
      ]);
      await this.recordLimits(t.harness, limits);
    }
    return { files, bytes, events };
  }

  /** Keeps a window's sample when it changed (not every turn's identical copy). */
  private async recordLimits(harness: string, limits: Array<{ window: string; usedPercent: number | null; windowMinutes: number | null; resetsAt: number | null; at: number }>) {
    const latest = new Map<string, (typeof limits)[number]>();
    for (const l of limits) latest.set(l.window, l);
    for (const l of latest.values()) {
      const prev = await this.db.rateLimitSample.findFirst({ where: { harness, window: l.window }, orderBy: { observedAt: 'desc' } });
      if (prev && prev.observedAt >= l.at) continue;
      if (prev && prev.usedPercent === l.usedPercent && Math.abs((prev.resetsAt ?? 0) - (l.resetsAt ?? 0)) < 120) continue;
      await this.db.rateLimitSample.create({ data: { harness, provider: providerOf('', harness), window: l.window, usedPercent: l.usedPercent, windowMinutes: l.windowMinutes, resetsAt: l.resetsAt, source: 'provider_telemetry', observedAt: l.at } });
    }
  }

  async prune(): Promise<{ days: number; samples: number }> {
    const keep = daysAgo(this.deps.config().retentionDays);
    const a = await this.db.usageDaily.deleteMany({ where: { day: { lt: keep } } });
    const b = await this.db.rateLimitSample.deleteMany({ where: { observedAt: { lt: now() - 30 * 86_400 } } });
    return { days: a.count, samples: b.count };
  }

  private cost(provider: string, model: string, t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) {
    const cfg = this.deps.config();
    const p = priceOf(model, cfg.prices);
    const usd = estimate(t, p);
    return { estimateUsd: usd === null ? null : Math.round(usd * 10_000) / 10_000, basis: p?.basis ?? null, billing: cfg.billing[provider] ?? 'unknown' };
  }

  /**
   * Totals for a period, grouped. Each row: tokens (local telemetry), sessions, an
   * estimate with its basis, and how that provider bills you.
   */
  async report(o: { from?: string; to?: string; by?: Group } = {}) {
    const from = o.from ?? daysAgo(29);
    const to = o.to ?? today();
    const by: Group = o.by ?? 'model';
    const rows = await this.db.usageDaily.findMany({ where: { day: { gte: from, lte: to } } });
    type Acc = { key: string; provider: string; harness: string; model: string | null; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number; messages: number; sessions: Set<string>; estimateUsd: number | null; unpriced: number; bases: Set<string>; uid: string | null };
    const acc = new Map<string, Acc>();
    for (const r of rows) {
      const key = by === 'day' ? r.day : by === 'model' ? r.model : by === 'provider' ? r.provider : by === 'harness' ? r.harness : r.convKey;
      const a = acc.get(key) ?? { key, provider: r.provider, harness: r.harness, model: by === 'model' ? r.model : null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, messages: 0, sessions: new Set<string>(), estimateUsd: 0, unpriced: 0, bases: new Set<string>(), uid: r.uid };
      a.inputTokens += r.inputTokens;
      a.outputTokens += r.outputTokens;
      a.cacheReadTokens += r.cacheReadTokens;
      a.cacheWriteTokens += r.cacheWriteTokens;
      a.reasoningTokens += r.reasoningTokens;
      a.messages += r.messages;
      a.sessions.add(r.convKey);
      const c = this.cost(r.provider, r.model, r);
      if (c.estimateUsd === null) a.unpriced += r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
      else {
        a.estimateUsd = (a.estimateUsd ?? 0) + c.estimateUsd;
        a.bases.add(c.basis!);
      }
      acc.set(key, a);
    }
    const out = [...acc.values()].map((a) => ({
      key: a.key,
      provider: by === 'day' ? null : a.provider,
      harness: by === 'day' || by === 'provider' ? null : a.harness,
      model: a.model,
      uid: by === 'session' ? a.uid : null,
      tokens: { input: a.inputTokens, output: a.outputTokens, cacheRead: a.cacheReadTokens, cacheWrite: a.cacheWriteTokens, reasoning: a.reasoningTokens, source: 'local_telemetry' as const },
      messages: a.messages,
      sessions: a.sessions.size,
      cost: {
        estimateUsd: a.bases.size ? Math.round((a.estimateUsd ?? 0) * 100) / 100 : null,
        basis: a.bases.size ? ([...a.bases].join('+') as string) : null,
        /** Tokens with no price to apply (left out of the estimate, not counted as free). */
        unpricedTokens: a.unpriced,
        billing: by === 'day' || by === 'session' ? null : (this.deps.config().billing[a.provider] ?? 'unknown'),
      },
    }));
    out.sort((x, y) => (by === 'day' ? x.key.localeCompare(y.key) : y.tokens.input + y.tokens.output + y.tokens.cacheRead - (x.tokens.input + x.tokens.output + x.tokens.cacheRead)));
    return { from, to, by, rows: out, notes: this.notes() };
  }

  private notes() {
    return {
      tokens: "Read from each agent's own transcript on this host (Claude Code and Codex record usage there; other agents don't, and their usage is unknown).",
      cost: `An estimate at API list prices (Anthropic's, as of ${LIST_PRICES_AS_OF}) or your configured prices: not a bill. A subscription plan doesn't bill per token.`,
      listPricesAsOf: LIST_PRICES_AS_OF,
    };
  }

  /** One conversation's usage, per model. */
  async session(harness: string, harnessId: string) {
    const convKey = conversationKey(harness, harnessId, '');
    const rows = await this.db.usageDaily.findMany({ where: { convKey } });
    const byModel = new Map<string, { model: string; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number }>();
    for (const r of rows) {
      const m = byModel.get(r.model) ?? { model: r.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
      m.input += r.inputTokens;
      m.output += r.outputTokens;
      m.cacheRead += r.cacheReadTokens;
      m.cacheWrite += r.cacheWriteTokens;
      m.messages += r.messages;
      byModel.set(r.model, m);
    }
    const models = [...byModel.values()].map((m) => ({ ...m, cost: this.cost(providerOf(m.model, harness), m.model, { inputTokens: m.input, outputTokens: m.output, cacheReadTokens: m.cacheRead, cacheWriteTokens: m.cacheWrite }) }));
    return { metered: METERED.has(harness), models, notes: this.notes() };
  }

  /** Rate-limit windows and cooldowns ah knows now, each with its source. */
  async limits() {
    const since = now() - 86_400;
    const samples = await this.db.rateLimitSample.findMany({ where: { observedAt: { gte: since } }, orderBy: { observedAt: 'desc' } });
    const latest = new Map<string, (typeof samples)[number]>();
    for (const s of samples) if (!latest.has(`${s.harness}|${s.window}`)) latest.set(`${s.harness}|${s.window}`, s);
    const windows = [...latest.values()].map((s) => ({ harness: s.harness, provider: s.provider, window: s.window, usedPercent: s.usedPercent, windowMinutes: s.windowMinutes, resetsAt: s.resetsAt, source: s.source, observedAt: s.observedAt }));
    const cooldowns = this.deps.liveLimits().filter((l) => !l.resetsAt || l.resetsAt > now());
    return { windows, cooldowns };
  }

  /**
   * Whether an agent is at a limit a provider stated, and until when: what the
   * scheduler waits on before starting more work in it. A limit seen in any of its
   * sessions holds new work for that agent (they share an account). Never a guess
   * from partial quota data.
   */
  async knownLimit(harness: string): Promise<{ until: number; why: string } | null> {
    const t = now();
    let until = 0;
    let why = '';
    for (const l of this.deps.liveLimits()) {
      if (l.harness === harness && l.resetsAt && l.resetsAt > t && l.resetsAt > until) [until, why] = [l.resetsAt, l.text];
    }
    const lim = await this.limits().catch(() => null);
    for (const w of lim?.windows ?? []) {
      if (w.harness === harness && (w.usedPercent ?? 0) >= 100 && w.resetsAt && w.resetsAt > t && w.resetsAt > until) [until, why] = [w.resetsAt, `${w.window} window at ${w.usedPercent}%`];
    }
    return until ? { until, why } : null;
  }

  /** Daily rows, for keeping or charting elsewhere. */
  async export(format: 'csv' | 'json', o: { from?: string; to?: string } = {}) {
    const from = o.from ?? daysAgo(this.deps.config().retentionDays);
    const to = o.to ?? today();
    const rows = (await this.db.usageDaily.findMany({ where: { day: { gte: from, lte: to } }, orderBy: [{ day: 'asc' }, { convKey: 'asc' }] })).map((r) => ({
      day: r.day,
      host: r.host,
      conversation: r.convKey,
      session: r.uid ?? '',
      harness: r.harness,
      provider: r.provider,
      model: r.model,
      input_tokens: r.inputTokens,
      output_tokens: r.outputTokens,
      cache_read_tokens: r.cacheReadTokens,
      cache_write_tokens: r.cacheWriteTokens,
      reasoning_tokens: r.reasoningTokens,
      messages: r.messages,
      estimate_usd: this.cost(r.provider, r.model, r).estimateUsd,
      estimate_basis: this.cost(r.provider, r.model, r).basis ?? '',
      tokens_source: 'local_telemetry',
    }));
    if (format === 'json') return JSON.stringify({ from, to, notes: this.notes(), rows });
    const cols = Object.keys(rows[0] ?? { day: '' });
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      // Spreadsheet formula injection: a cell can't start with = + - @.
      const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
      return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    return [cols.join(','), ...rows.map((r) => cols.map((c) => cell((r as Record<string, unknown>)[c])).join(','))].join('\n') + '\n';
  }
}
