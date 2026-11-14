// Keeping agents going through temporary failures (docs/spec/13-conductor.md, CND-5).
//
// What it acts on is evidence, never a hunch: the agent's own error lines in its
// transcript (classified in classify.ts), its usage-limit notice on screen (with the
// reset time it prints), and a session found gone while it was working (a crash, a
// host restart) that you didn't end. Each becomes a durable Recovery row and events.
//
// What it does, only when automatic recovery is on for the session (off by default):
// at the time the provider named (else after a backoff with jitter), it sends the
// agent one continuation, through the normal send path, which resumes an ended
// session first (the same conversation, the same launch choices: it never changes
// model, provider or permissions). Before sending it checks the agent hasn't moved on
// (a newer turn in the transcript), isn't working, has nothing queued, and that the
// last attempt's message isn't still waiting. Attempts are bounded; credentials
// failures never retry. You can retry now, pause, cancel, or switch it off per session.
//
// waiting_capacity → scheduled → resuming → resolved
// recoverable (auto off) · needs_user (credentials) · failed (attempts spent) · stopped (you)
import type { PrismaClient, Recovery as Row } from '@prisma/client';
import type { SessionRecord } from '../registry.ts';
import type { WindowView } from '../sessions.ts';
import { conversationKey } from '../registry.ts';
import { classify, progressed, transcriptErrors, type Finding } from './classify.ts';

export type RecoveryConfig = { auto: boolean; maxAttempts: number; backoffSeconds: number; maxBackoffSeconds: number; jitterSeconds: number; prompt: string; maxActionsPerMinute: number };

export const DEFAULT_RECOVERY: RecoveryConfig = { auto: false, maxAttempts: 5, backoffSeconds: 60, maxBackoffSeconds: 3600, jitterSeconds: 30, prompt: 'Continue where you left off.', maxActionsPerMinute: 3 };

export type RecoveryDeps = {
  config: () => RecoveryConfig;
  record: (uid: string) => SessionRecord | undefined;
  /** The session's transcript file and its reader, when it has one. */
  transcript: (uid: string) => Promise<{ file: string; adapter: string } | null>;
  /** Complete lines written after byte `from` (bounded), and the file's length now. */
  readLines: (file: string, from: number) => Promise<{ size: number; lines: string[] }>;
  /** Whether the file was written within the last `seconds`. */
  fresh: (file: string, seconds: number) => Promise<boolean>;
  /** Types or queues `text` (resuming an ended session first); `id` names the queue item. */
  send: (uid: string, text: string, id: string) => Promise<{ outcome: string }>;
  /** Resumes an ended session without a message (its queued work goes in once it's up). */
  resume: (uid: string) => Promise<void>;
  /**
   * The agent died but its window lives on at a shell prompt: types the agent's own resume
   * command there (the same conversation and launch choices). False when the pane isn't
   * at a shell prompt, so nothing is typed.
   */
  restartInPlace: (uid: string) => Promise<boolean>;
  queueIds: (uid: string) => string[];
  alert: (p: { title: string; body: string; tag: string; url: string }) => void;
  changed: () => void;
};

export type RecoveryView = {
  state: string;
  reason: string;
  evidence: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number | null;
  resetsAt: number | null;
  auto: boolean;
  updatedAt: number;
};

export class RecoveryError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const now = () => Math.floor(Date.now() / 1000);
const ACTIVE = ['waiting_capacity', 'recoverable', 'scheduled', 'resuming'];
const parse = <T>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

export class RecoveryEngine {
  private db: PrismaClient;
  private deps: RecoveryDeps;
  /** Rows as last read, by key: the state stream reads these, not the database. */
  private rows = new Map<string, Row>();
  /** Where each transcript was read up to (in memory: a restart reads from its end). */
  private offsets = new Map<string, number>();
  private loaded: Promise<void> | null = null;
  private passing: Promise<void> | null = null;
  private actions: number[] = [];
  /** Each session's agent and status at the last pass: an agent that vanished mid-turn crashed. */
  private seen = new Map<string, { agent: string | null; status: string }>();
  /** Limits already recovered from, by key: their notice can linger on screen; it isn't news. */
  private settled = new Map<string, { resetsAt: number | null; evidence: string }>();

  constructor(db: PrismaClient, deps: RecoveryDeps) {
    this.db = db;
    this.deps = deps;
  }

  private load(): Promise<void> {
    return (this.loaded ??= this.db.recovery.findMany({ where: { state: { notIn: ['resolved'] } } }).then((rows) => {
      for (const r of rows) this.rows.set(r.key, r);
    }));
  }

  /** Whether automatic recovery is on for a session: its own switch, else the host's. */
  auto(uid: string): boolean {
    const v = this.deps.record(uid)?.meta['ah.recovery.auto'];
    return typeof v === 'boolean' ? v : this.deps.config().auto;
  }

  view(key: string): RecoveryView | null {
    const r = this.rows.get(key);
    if (!r || r.state === 'resolved') return null;
    return { state: r.state, reason: r.reason, evidence: r.evidence, attempts: r.attempts, maxAttempts: r.maxAttempts, nextAttemptAt: r.nextAttemptAt, resetsAt: r.resetsAt, auto: this.auto(r.uid), updatedAt: r.updatedAt };
  }

  viewOf(w: { uid: string; agent?: string | null; harness?: string; harnessId: string | null }): RecoveryView | null {
    return this.view(conversationKey(w.agent ?? w.harness ?? '', w.harnessId ?? undefined, w.uid));
  }

  private async event(key: string, state: string, detail: string) {
    await this.db.recoveryEvent.create({ data: { key, at: now(), state, detail: detail.slice(0, 1000) } });
  }

  private async save(key: string, data: Partial<Row> & { uid: string }): Promise<Row> {
    const row = await this.db.recovery.upsert({ where: { key }, create: { key, state: 'recoverable', reason: 'unknown', createdAt: now(), updatedAt: now(), ...data }, update: { ...data, updatedAt: now() } });
    this.rows.set(key, row);
    this.deps.changed();
    return row;
  }

  /** When the next attempt goes: the provider's word first, else backoff with jitter. */
  private nextAt(f: Pick<Finding, 'reason' | 'resetsAt' | 'retryAfter'>, attempts: number): number {
    const c = this.deps.config();
    const jitter = Math.round(Math.random() * c.jitterSeconds);
    if (f.resetsAt) return Math.max(now(), f.resetsAt) + jitter;
    if (f.retryAfter) return now() + f.retryAfter + jitter;
    return now() + Math.min(c.maxBackoffSeconds, c.backoffSeconds * 2 ** attempts) + jitter;
  }

  /** Something went wrong in a session: record it, and plan what to do about it. */
  async note(uid: string, key: string, f: Finding, source: 'transcript' | 'screen' | 'lifecycle', mark: number): Promise<void> {
    await this.load();
    if (f.reason === 'unknown') return;
    const done = this.settled.get(key);
    if (source === 'screen' && done && (f.text === done.evidence || (f.resetsAt && done.resetsAt && f.resetsAt <= done.resetsAt + 120))) return;
    const prev = this.rows.get(key);
    // The same thing seen again (a notice still on screen, one error line): nothing new.
    if (prev && prev.reason === f.reason && ACTIVE.concat(['needs_user', 'stopped', 'failed']).includes(prev.state) && (prev.state !== 'resuming' || source === 'screen')) {
      // A newer reset time, unless it's the screen's minute-rounded one over the transcript's exact one.
      const better = f.resetsAt && f.resetsAt !== prev.resetsAt && !(source === 'screen' && prev.source === 'transcript');
      if (better && prev.state !== 'stopped') await this.save(key, { uid, resetsAt: f.resetsAt, source, ...(prev.state === 'scheduled' ? { nextAttemptAt: this.nextAt(f, prev.attempts) } : {}) });
      return;
    }
    const evidence = f.text.replace(/\s+/g, ' ').trim().slice(0, 400);
    if (f.reason === 'credentials') {
      await this.save(key, { uid, state: 'needs_user', reason: f.reason, evidence, source, nextAttemptAt: null, markJson: JSON.stringify({ failure: mark }) });
      await this.event(key, 'needs_user', `${evidence} — sign the agent in again; ah won't retry this on its own.`);
      this.deps.alert({ title: 'An agent needs you to sign it in', body: evidence.slice(0, 180), tag: `recovery-${key}`, url: `/#${uid}` });
      return;
    }
    const attempts = prev && prev.state === 'resuming' ? prev.attempts : 0;
    const auto = this.auto(uid);
    const max = this.deps.config().maxAttempts;
    if (auto && attempts >= max) {
      await this.save(key, { uid, state: 'failed', reason: f.reason, evidence, source, nextAttemptAt: null });
      await this.event(key, 'failed', `${evidence} — ${attempts} attempts made; stopped.`);
      this.deps.alert({ title: 'An agent kept failing', body: evidence.slice(0, 180), tag: `recovery-${key}`, url: `/#${uid}` });
      return;
    }
    const at = auto ? this.nextAt(f, attempts) : null;
    const state = auto ? 'scheduled' : f.reason === 'rate_limit' ? 'waiting_capacity' : 'recoverable';
    await this.save(key, { uid, state, reason: f.reason, evidence, source, attempts, maxAttempts: max, nextAttemptAt: at, resetsAt: f.resetsAt ?? null, markJson: JSON.stringify({ failure: mark }) });
    const why = f.resetsAt ? `the provider said capacity is back at ${new Date(f.resetsAt * 1000).toISOString()}` : f.retryAfter ? `the provider said to wait ${f.retryAfter}s` : `backing off (attempt ${attempts + 1} of ${max})`;
    await this.event(key, state, auto ? `${evidence} — next attempt at ${new Date(at! * 1000).toISOString()}: ${why}.` : `${evidence} — automatic recovery is off for this session${f.resetsAt ? `; it can go on after ${new Date(f.resetsAt * 1000).toISOString()}` : ''}.`);
  }

  /** A session found gone: if it was working and you didn't end it, it crashed (or the host restarted). */
  sessionEnded(r: SessionRecord, lastStatus: string) {
    if (!r.harnessId || r.harness === 'shell' || r.meta['ah.endedBy'] === 'you') return;
    if (lastStatus !== 'busy' && lastStatus !== 'waiting') return;
    const key = conversationKey(r.harness, r.harnessId, r.id);
    void this.note(r.id, key, { reason: 'process_exit', retryable: true, text: "The agent's process ended while it was working (a crash, or the host restarted)." }, 'lifecycle', -1).catch((err) => console.error('recovery:', err));
  }

  /** Each tick: read what's new in agents' transcripts and screens; act on what's due. */
  tick(windows: WindowView[]): Promise<void> {
    this.passing ??= this.pass(windows)
      .catch((err) => console.error('recovery pass failed:', err))
      .finally(() => (this.passing = null));
    return this.passing;
  }

  private async pass(windows: WindowView[]) {
    await this.load();
    for (const w of windows) {
      // An agent gone from its window while it was working, its shell left behind: it crashed.
      const before = this.seen.get(w.uid);
      this.seen.set(w.uid, { agent: w.agent, status: w.status });
      const rec = this.deps.record(w.uid);
      if (before?.agent && !w.agent && (before.status === 'busy' || before.status === 'waiting') && rec?.harnessId && rec.harness === before.agent && rec.meta['ah.endedBy'] !== 'you') {
        await this.note(w.uid, conversationKey(rec.harness, rec.harnessId, w.uid), { reason: 'process_exit', retryable: true, text: "The agent's process ended while it was working; its window is still there." }, 'lifecycle', -1);
      }
      if (!w.agent || !w.harnessId) continue;
      const key = conversationKey(w.agent, w.harnessId, w.uid);
      const t = await this.deps.transcript(w.uid).catch(() => null);
      if (t) {
        const from = this.offsets.get(key);
        if (from === undefined) {
          // First look (a new session, or after a restart): what the transcript ends on now is
          // current evidence when it's an error with nothing after it, and recent (6 h).
          const end = (await this.deps.readLines(t.file, Number.MAX_SAFE_INTEGER).catch(() => null))?.size ?? 0;
          const tail = await this.deps.readLines(t.file, Math.max(0, end - 256 * 1024)).catch(() => null);
          this.offsets.set(key, tail?.size ?? end);
          const errors = tail ? transcriptErrors(t.adapter, tail.lines) : [];
          if (tail && errors.length && (await this.deps.fresh(t.file, 6 * 3600))) {
            const lastError = tail.lines.map((l) => transcriptErrors(t.adapter, [l]).length > 0).lastIndexOf(true);
            if (!progressed(t.adapter, tail.lines.slice(lastError + 1))) await this.note(w.uid, key, classify(errors[errors.length - 1]), 'transcript', tail.size);
          }
        } else {
          const got = await this.deps.readLines(t.file, from).catch(() => null);
          if (got && got.size !== from) {
            this.offsets.set(key, got.size);
            const row = this.rows.get(key);
            // The agent wrote real work since the failure: whoever moved it on, it's going again.
            if (row && ACTIVE.includes(row.state) && progressed(t.adapter, got.lines) && !transcriptErrors(t.adapter, got.lines).length) {
              await this.resolve(key, row.state === 'resuming' ? 'the agent is working again after the continuation' : 'the agent went on by itself (or you moved it on)');
            }
            for (const text of transcriptErrors(t.adapter, got.lines)) await this.note(w.uid, key, classify(text), 'transcript', got.size);
          }
        }
      }
      // The usage-limit notice on screen, with the reset it prints.
      if (w.limit && w.limitResetsAt) await this.note(w.uid, key, { reason: 'rate_limit', retryable: true, resetsAt: w.limitResetsAt, text: w.limit }, 'screen', this.offsets.get(key) ?? 0);
    }
    await this.due(windows);
  }

  private budget(): boolean {
    const t = now();
    this.actions = this.actions.filter((a) => t - a < 60);
    return this.actions.length < this.deps.config().maxActionsPerMinute;
  }

  private async due(windows: WindowView[]) {
    const t = now();
    for (const row of [...this.rows.values()]) {
      const phase = parse<{ phase?: string; at?: number; id?: string }>(row.lastAttemptJson, {});
      if (row.state === 'resuming' && phase.phase === 'restarting') {
        // The agent was restarted in its window: once it's up and settled, the continuation goes in.
        const w = windows.find((x) => x.uid === row.uid);
        const rec = this.deps.record(row.uid);
        if (w?.agent && w.agent === rec?.harness && (w.status === 'idle' || w.status === 'attention') && t - (phase.at ?? t) >= 3) {
          const out = await this.deps.send(row.uid, this.deps.config().prompt, phase.id!).catch((err) => ({ outcome: `failed: ${(err as Error).message}` }));
          await this.save(row.key, { uid: row.uid, lastAttemptJson: JSON.stringify({ ...phase, phase: 'sent', at: t }) });
          await this.event(row.key, 'resuming', `the agent is back up; sent "${this.deps.config().prompt}" (${out.outcome})`);
        } else if (t - (phase.at ?? t) > 90) {
          await this.note(row.uid, row.key, { reason: 'process_exit', retryable: true, text: `${row.evidence} (it didn't come back up after the restart)` }, 'lifecycle', -1);
        }
        continue;
      }
      if (row.state === 'resuming') {
        // A continuation that didn't move the agent within ten minutes counts as a failed attempt.
        const last = parse<{ at?: number }>(row.lastAttemptJson, {});
        if (last.at && t - last.at > 600) await this.note(row.uid, row.key, { reason: row.reason as Finding['reason'], retryable: true, text: `${row.evidence} (no progress after the last attempt)` }, 'lifecycle', -1);
        continue;
      }
      if (row.state !== 'scheduled' || !row.nextAttemptAt || row.nextAttemptAt > t) continue;
      if (!this.auto(row.uid)) {
        await this.save(row.key, { uid: row.uid, state: row.reason === 'rate_limit' ? 'waiting_capacity' : 'recoverable', nextAttemptAt: null });
        continue;
      }
      if (!this.budget()) break;
      await this.attempt(row, windows, 'scheduled');
    }
  }

  /** One attempt: checked, then one continuation (or a plain resume when work is queued). */
  private async attempt(row: Row, windows: WindowView[], why: 'scheduled' | 'you') {
    const w = windows.find((x) => x.uid === row.uid);
    if (w && (w.status === 'busy' || w.status === 'waiting')) return this.resolve(row.key, 'it is already working again');
    const last = parse<{ id?: string }>(row.lastAttemptJson, {});
    if (last.id && this.deps.queueIds(row.uid).includes(last.id)) return; // the last one is still on its way
    const t = await this.deps.transcript(row.uid).catch(() => null);
    const failure = parse<{ failure?: number }>(row.markJson, {}).failure ?? -1;
    if (t && failure >= 0) {
      const since = await this.deps.readLines(t.file, failure).catch(() => null);
      if (since && progressed(t.adapter, since.lines) && !transcriptErrors(t.adapter, since.lines).length) return this.resolve(row.key, 'the conversation moved on since the failure; nothing to send');
    }
    const attempts = row.attempts + 1;
    const id = `rc${attempts}-${row.key.replace(/[^\w]/g, '').slice(-12)}`;
    this.actions.push(now());
    const size = t ? ((await this.deps.readLines(t.file, Number.MAX_SAFE_INTEGER).catch(() => null))?.size ?? 0) : 0;
    await this.save(row.key, { uid: row.uid, state: 'resuming', attempts, nextAttemptAt: null, lastAttemptJson: JSON.stringify({ id, at: now(), mark: size, why }) });
    try {
      if (row.reason === 'process_exit' && w && !w.agent) {
        // Its window is alive, its agent isn't: restart the agent where it was, then continue.
        if (!(await this.deps.restartInPlace(row.uid))) {
          await this.save(row.key, { uid: row.uid, state: 'needs_user', nextAttemptAt: null });
          await this.event(row.key, 'needs_user', "its window isn't at a shell prompt, so ah won't type into it; restart the agent there yourself");
          return;
        }
        await this.save(row.key, { uid: row.uid, lastAttemptJson: JSON.stringify({ id, at: now(), mark: size, why, phase: 'restarting' }) });
        await this.event(row.key, 'resuming', `attempt ${attempts}${why === 'you' ? ' (you asked)' : ''}: restarted the agent in its window, resuming the same conversation`);
      } else if (this.deps.queueIds(row.uid).length) {
        await this.deps.resume(row.uid);
        await this.event(row.key, 'resuming', `attempt ${attempts}: resumed; its queued messages go in once it's up`);
      } else {
        const out = await this.deps.send(row.uid, this.deps.config().prompt, id);
        await this.event(row.key, 'resuming', `attempt ${attempts}${why === 'you' ? ' (you asked)' : ''}: sent "${this.deps.config().prompt}" (${out.outcome})`);
      }
    } catch (err) {
      await this.event(row.key, 'resuming', `attempt ${attempts} failed: ${(err as Error).message}`);
      const f: Finding = { reason: row.reason as Finding['reason'], retryable: true, text: row.evidence };
      const auto = this.auto(row.uid);
      await this.save(row.key, { uid: row.uid, state: attempts >= row.maxAttempts ? 'failed' : auto ? 'scheduled' : 'recoverable', nextAttemptAt: attempts < row.maxAttempts && auto ? this.nextAt(f, attempts) : null });
    }
  }

  private async resolve(key: string, why: string) {
    const row = this.rows.get(key);
    if (!row) return;
    if (row.reason === 'rate_limit') this.settled.set(key, { resetsAt: row.resetsAt, evidence: row.evidence });
    await this.save(key, { uid: row.uid, state: 'resolved', nextAttemptAt: null });
    await this.event(key, 'resolved', why);
    this.rows.delete(key);
  }

  // ---------- your controls

  private async rowOf(uid: string): Promise<Row> {
    await this.load();
    const rec = this.deps.record(uid);
    const key = rec ? conversationKey(rec.harness, rec.harnessId, uid) : uid;
    const row = this.rows.get(key) ?? (await this.db.recovery.findUnique({ where: { key } }));
    if (!row) throw new RecoveryError(404, 'not_found', 'nothing to recover in this session');
    return row;
  }

  async get(uid: string) {
    await this.load();
    const rec = this.deps.record(uid);
    const key = rec ? conversationKey(rec.harness, rec.harnessId, uid) : uid;
    const row = this.rows.get(key) ?? (await this.db.recovery.findUnique({ where: { key } }));
    const events = await this.db.recoveryEvent.findMany({ where: { key }, orderBy: { id: 'desc' }, take: 50 });
    return { auto: this.auto(uid), recovery: row ? { ...this.view(key), state: row.state, key } : null, events: events.map((e) => ({ at: e.at, state: e.state, detail: e.detail })) };
  }

  /** The rows now, synchronously (usage's live limits). */
  listNow(): Array<{ uid: string; harness: string; reason: string; resetsAt: number | null; source: string; evidence: string }> {
    return [...this.rows.values()].filter((r) => r.state !== 'resolved').map((r) => ({ uid: r.uid, harness: r.key.includes(':') ? r.key.slice(0, r.key.indexOf(':')) : '', reason: r.reason, resetsAt: r.resetsAt, source: r.source, evidence: r.evidence }));
  }

  async list() {
    await this.load();
    return [...this.rows.values()].map((r) => ({ key: r.key, uid: r.uid, ...this.view(r.key)! }));
  }

  /** You switched automatic recovery for a session: what's waiting is planned again under the new setting. */
  async autoChanged(uid: string): Promise<void> {
    const row = await this.rowOf(uid).catch(() => null);
    if (!row || !['waiting_capacity', 'recoverable', 'scheduled'].includes(row.state)) return;
    const auto = this.auto(uid);
    const f: Finding = { reason: row.reason as Finding['reason'], retryable: true, text: row.evidence, ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}) };
    if (auto) await this.save(row.key, { uid, state: 'scheduled', nextAttemptAt: this.nextAt(f, row.attempts) });
    else await this.save(row.key, { uid, state: row.reason === 'rate_limit' ? 'waiting_capacity' : 'recoverable', nextAttemptAt: null });
    await this.event(row.key, auto ? 'scheduled' : row.state, auto ? `you switched automatic recovery on; next attempt at ${new Date(this.rows.get(row.key)!.nextAttemptAt! * 1000).toISOString()}` : 'you switched automatic recovery off; it waits for you');
  }

  /** retry now · pause · resume · cancel future attempts. */
  async control(uid: string, action: 'retry' | 'pause' | 'resume' | 'cancel', windows: WindowView[]) {
    const row = await this.rowOf(uid);
    if (action === 'retry') {
      if (row.state === 'resolved') throw new RecoveryError(409, 'resolved', 'it is going again already');
      await this.attempt(row, windows, 'you');
    } else if (action === 'pause') {
      if (!ACTIVE.includes(row.state)) throw new RecoveryError(409, 'not_active', `it is ${row.state}`);
      await this.save(row.key, { uid, state: 'stopped', nextAttemptAt: null });
      await this.event(row.key, 'stopped', 'you paused recovery');
    } else if (action === 'resume') {
      if (row.state !== 'stopped') throw new RecoveryError(409, 'not_paused', `it is ${row.state}`);
      const f: Finding = { reason: row.reason as Finding['reason'], retryable: true, text: row.evidence, ...(row.resetsAt ? { resetsAt: row.resetsAt } : {}) };
      const auto = this.auto(uid);
      await this.save(row.key, { uid, state: auto ? 'scheduled' : row.reason === 'rate_limit' ? 'waiting_capacity' : 'recoverable', nextAttemptAt: auto ? this.nextAt(f, row.attempts) : null });
      await this.event(row.key, 'resumed', 'you resumed recovery');
    } else {
      await this.save(row.key, { uid, state: 'resolved', nextAttemptAt: null });
      await this.event(row.key, 'resolved', 'you cancelled further attempts');
      this.rows.delete(row.key);
    }
    return this.get(uid);
  }
}
