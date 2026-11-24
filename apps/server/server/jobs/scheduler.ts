// The scheduler: durable jobs that start agents, speak to sessions, and wait for your
// decisions, on a time, a cron schedule, another job finishing, or a session going
// idle or ending (docs/spec/13-conductor.md, CND-4).
//
// Exactly-once delivery to an agent can't be promised (a process can die between
// typing and recording that it typed), so runs are built to be at-most-once with
// evidence, and to say "uncertain" rather than guess:
//  - a run is created once per cause: its idempotency key (the schedule slot, the
//    upstream run, the session event) is unique, so a duplicate trigger or a second
//    worker creates nothing;
//  - a run is claimed by a conditional update (eligible → running): one executor;
//  - before acting it records what it is about to do (the session uid it will start,
//    the transcript length before it types), so after a crash the evidence decides:
//    the session exists or not, the message is in the queue (its id is the run's),
//    in the transcript, or neither;
//  - a message that may or may not have reached the agent is `uncertain`, never
//    re-sent on its own; you choose (retry or skip).
// Concurrency, launches per hour and retries are bounded; retries back off with jitter.
import { randomUUID } from 'node:crypto';
import type { PrismaClient, Job as JobRow, JobRun as RunRow } from '@prisma/client';
import type { SessionRecord } from '../registry.ts';
import type { WindowView } from '../sessions.ts';
import { checkZone, nextRun, parseCron, CronError } from './cron.ts';
import { DomainError } from '../errors.ts';

export type LaunchAction = { kind: 'launch'; preset: string; cwd: string; prompt: string; name?: string; model?: string; effort?: string; mode?: string; worktree?: boolean };
export type SendAction = { kind: 'send'; target: string; text: string };
export type DecideAction = { kind: 'decide'; title: string; body?: string; then?: LaunchAction | SendAction };
export type Action = LaunchAction | SendAction | DecideAction;

export type Trigger =
  | { kind: 'at'; at: number }
  | { kind: 'every'; seconds: number }
  | { kind: 'cron'; expr: string; tz: string }
  | { kind: 'after'; job: string; on: 'success' | 'failure' | 'any' }
  | { kind: 'session'; uid: string; on: 'idle' | 'ended' | 'waiting' | 'stalled'; space?: string; managedBy?: string; excludeRoles?: Array<'chief' | 'worker' | 'reviewer'>; afterSeconds?: number; repeat?: boolean; exclude?: string[] }
  | { kind: 'overlap'; repo?: string; repeat?: boolean }
  | { kind: 'manual' };

export type Policy = {
  /** Stop scheduling after this many runs. */
  maxRuns?: number;
  /** Retries of a failed run (not of an uncertain one), with exponential backoff and jitter. */
  retries?: number;
  backoffSeconds?: number;
  /** A run that hasn't finished by then fails. */
  timeoutSeconds?: number;
  /** `finished` (default): the agent took the message and its turn ended. `delivered`: it took it. */
  until?: 'delivered' | 'finished';
  /** Runs sharing a key never overlap. */
  concurrencyKey?: string;
  /** Tell your devices when a run finishes or fails (decisions always do). */
  notify?: boolean;
  /** A permission mode the agent marks dangerous (skip permissions), allowed explicitly. */
  allowDangerous?: boolean;
  /** Keep the agent going through temporary failures (server/recovery). */
  autoRecover?: boolean;
  /** Skip a send run cleanly when the target session is busy, waiting, or already has queued messages. */
  skipIfBusy?: boolean;
  /** Skip a send run cleanly when the target session is not currently running (never resurrects ended sessions). */
  ifLive?: boolean;
};

export class JobError extends DomainError {
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
  }
}

export type Limits = { maxConcurrent: number; maxLaunchesPerHour: number; maxRetriesPerMinute: number };
export const DEFAULT_LIMITS: Limits = { maxConcurrent: 3, maxLaunchesPerHour: 20, maxRetriesPerMinute: 10 };

export type OverlapFact = {
  repoRoot: string;
  repoName: string;
  key: string;
  sessions: string[];
  files: string[];
};

export type SchedulerDeps = {
  /** Starts an agent session under `uid` and queues `prompt` with queue id `id`. */
  launch: (o: { preset: string; cwd: string; name: string; uid: string; prompt: string; id: string; model?: string; effort?: string; mode?: string; worktree?: boolean; meta: Record<string, unknown>; createdBy?: string }) => Promise<void>;
  /** Types (or queues, or resumes then queues) `text` into `target`; `id` names the queue item. */
  send: (target: string, text: string, id: string, actorUid?: string | null) => Promise<{ outcome: string; uid: string }>;
  /** A session's uid for a target the person named (uid or harness:harnessId), if it exists. */
  resolveTarget: (ref: string) => Promise<string | null>;
  checkLaunch: (preset: string, o: { model?: string; effort?: string; mode?: string }) => Promise<{ dangerous: boolean }>;
  record: (uid: string) => SessionRecord | undefined;
  freshUid: () => string;
  queueIds: (uid: string) => string[];
  /** Messages and replies in the session's transcript after byte `from`. */
  readTranscript: (uid: string, from: number) => Promise<{ size: number; user: string[]; replies: Array<{ text: string; at: number }> } | null>;
  /** What sits unsent in the session's input box ('' empty, null unknown). */
  inputBox: (uid: string) => Promise<string | null>;
  alert: (p: { title: string; body: string; tag: string; url: string }) => void;
  changed: () => void;
  limits: () => Limits;
  /** A limit the agent's provider stated, and until when (server/usage): new work waits for it. */
  capacity?: (harness: string) => Promise<{ until: number; why: string } | null>;
  /** Which agent a session runs (for a send's capacity check). */
  harnessOf?: (uid: string) => string | null;
  /** All registry records, for fleet-wide (`uid: '*'`) `ended` triggers. */
  records?: () => SessionRecord[];
  /** Whether a session's harness has a transcript reader ah can confirm delivery from. */
  hasTranscript?: (uid: string) => boolean;
  /** Active file overlaps between concurrent checkouts, for `overlap` triggers. */
  overlaps?: () => Promise<OverlapFact[]>;
  /** Resolves a session's Space name, for Space-scoped `session` triggers (`uid: '*', space: '...'`). */
  spaceOf?: (uid: string) => string | null;
  /** Resolves a session's `managedBy` supervisor uid, for supervisor-scoped `session` triggers. */
  managedByOf?: (uid: string) => string | null;
  /** Resolves a session's supervision role, for `excludeRoles` on `session` triggers. */
  roleOf?: (uid: string) => 'chief' | 'worker' | 'reviewer' | null;
};

const now = () => Math.floor(Date.now() / 1000);
const id = (prefix: string) => `${prefix}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
const parse = <T>(s: string | null | undefined, d: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : d;
  } catch {
    return d;
  }
};

/** What to look for in a transcript to know a message arrived: its longest line, as written. */
function needle(text: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  return lines.reduce((a, b) => (b.length > a.length ? b : a), '').slice(0, 60);
}

export type SessionEventOutcome = {
  kind: 'idle' | 'ended' | 'waiting' | 'stalled' | 'overlap';
  uid: string;
  title: string;
  agent: string | null;
  ask?: string | null;
  askId?: string | null;
  answerable?: boolean;
  reply?: string | null;
  stalledSeconds?: number;
  repo?: string;
  files?: string[];
  sessions?: string[];
};
export type Delivery = { mark?: number; dispatchingAt?: number; acceptedAt?: number; queuedAt?: number; typedAt?: number; observedAt?: number; finishedAt?: number; outcome?: string; launchedAt?: number };
export type JobView = { id: string; name: string; state: string; action: Action; trigger: Trigger; policy: Policy; nextRunAt: number | null; runCount: number; createdBy: string; createdAt: number; updatedAt: number; lastRun: RunView | null };
export type RunView = { id: string; jobId: string; seq: number; state: string; triggeredBy: string; scheduledFor: number; attempt: number; sessionUid: string | null; delivery: Delivery; outcome: { reply?: string; body?: string; decision?: string; note?: string; skippedBecause?: string; event?: SessionEventOutcome }; error: string | null; startedAt: number | null; endedAt: number | null; createdAt: number };

const runView = (r: RunRow): RunView => ({
  id: r.id,
  jobId: r.jobId,
  seq: r.seq,
  state: r.state,
  triggeredBy: r.triggeredBy,
  scheduledFor: r.scheduledFor,
  attempt: r.attempt,
  sessionUid: r.sessionUid,
  delivery: parse(r.deliveryJson, {}),
  outcome: parse(r.outcomeJson, {}),
  error: r.error,
  startedAt: r.startedAt,
  endedAt: r.endedAt,
  createdAt: r.createdAt,
});

/** Inbox, the state stream and the native app: what's next and what needs you. */
export type JobsState = {
  next: Array<{ id: string; name: string; at: number }>;
  running: Array<{ id: string; name: string; runId: string; sessionUid: string | null }>;
  waiting: Array<{ id: string; name: string; runId: string; title: string; body: string }>;
  uncertain: Array<{ id: string; name: string; runId: string }>;
};

export class Scheduler {
  private db: PrismaClient;
  private deps: SchedulerDeps;
  /** This process: runs it holds are its own; any other holder's were cut off (a restart). */
  readonly instance = randomUUID().slice(0, 8);
  private ticking: Promise<void> | null = null;
  private reconciled = false;
  private executing = new Set<string>();
  /** For fleet-wide (`uid: '*'`) `idle` triggers: `${jobId}:${uid}` → timestamp first seen working. */
  private fleetBusy = new Map<string, number>();
  /** Last waiting episode fired per `${jobId}:${uid}`, so one prompt never triggers twice. */
  private waitingSeen = new Map<string, string>();
  /** Last overlap signature seen per `${jobId}:${pairKey}` so the same overlap fires once. */
  private overlapSeen = new Map<string, string>();
  private summary: JobsState = { next: [], running: [], waiting: [], uncertain: [] };

  constructor(db: PrismaClient, deps: SchedulerDeps) {
    this.db = db;
    this.deps = deps;
  }

  state(): JobsState {
    return this.summary;
  }

  // ---------- definitions

  async validate(action: unknown, trigger: unknown, policy: unknown): Promise<{ action: Action; trigger: Trigger; policy: Policy }> {
    const a = action as Action;
    const t = trigger as Trigger;
    const p = (policy ?? {}) as Policy;
    const bad = (code: string, msg: string): never => {
      throw new JobError(400, code, msg);
    };
    const str = (v: unknown, name: string, max: number) => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : bad('invalid_action', `${name} is required (at most ${max} characters)`));
    const checkRun = async (x: LaunchAction | SendAction) => {
      if (x.kind === 'launch') {
        str(x.preset, 'preset', 48);
        str(x.cwd, 'cwd', 1024);
        str(x.prompt, 'prompt', 32 * 1024);
        if (!x.cwd.startsWith('/') && !x.cwd.startsWith('~')) bad('invalid_action', 'cwd must be an absolute path');
        let dangerous = false;
        try {
          dangerous = (await this.deps.checkLaunch(x.preset, { model: x.model, effort: x.effort, mode: x.mode })).dangerous;
        } catch (err) {
          bad('invalid_launch', (err as Error).message);
        }
        if (dangerous && !p.allowDangerous) bad('dangerous_mode', `mode "${x.mode}" lets the agent act without asking; a scheduled job needs policy.allowDangerous to use it`);
      } else if (x.kind === 'send') {
        str(x.target, 'target', 120);
        str(x.text, 'text', 32 * 1024);
        if (!x.target.includes('{{') && !(await this.deps.resolveTarget(x.target))) bad('unknown_target', `no session ${x.target}`);
      } else bad('invalid_action', 'action.kind must be launch, send or decide');
    };
    if (!a || typeof a !== 'object') bad('invalid_action', 'action is required');
    if (a.kind === 'decide') {
      str(a.title, 'title', 200);
      if (a.body !== undefined) str(a.body, 'body', 32 * 1024);
      if (a.then) await checkRun(a.then);
    } else await checkRun(a);
    if (!t || typeof t !== 'object') bad('invalid_trigger', 'trigger is required');
    switch (t.kind) {
      case 'at':
        if (!Number.isFinite(t.at) || t.at <= 0) bad('invalid_trigger', 'trigger.at is a time (epoch seconds)');
        break;
      case 'every':
        if (!Number.isInteger(t.seconds) || t.seconds < 10 || t.seconds > 30 * 86_400) {
          bad('invalid_trigger', 'trigger.seconds must be a whole number between 10 and 2592000');
        }
        break;
      case 'cron':
        try {
          parseCron(t.expr);
          checkZone(t.tz);
        } catch (err) {
          bad('invalid_trigger', (err as CronError).message);
        }
        break;
      case 'after':
        if (!(await this.db.job.findUnique({ where: { id: String(t.job) } }))) bad('invalid_trigger', `no job ${t.job}`);
        if (!['success', 'failure', 'any'].includes(t.on)) bad('invalid_trigger', 'trigger.on is success, failure or any');
        break;
      case 'session':
        if (t.uid !== '*' && !(await this.deps.resolveTarget(String(t.uid)))) bad('invalid_trigger', `no session ${t.uid}`);
        if (!['idle', 'ended', 'waiting', 'stalled'].includes(t.on)) bad('invalid_trigger', 'trigger.on is idle, ended, waiting or stalled');
        if (t.afterSeconds !== undefined && (!Number.isInteger(t.afterSeconds) || t.afterSeconds < 30 || t.afterSeconds > 86_400)) {
          bad('invalid_trigger', 'trigger.afterSeconds must be a whole number between 30 and 86400');
        }
        if (t.repeat !== undefined && typeof t.repeat !== 'boolean') bad('invalid_trigger', 'trigger.repeat must be true or false');
        if (t.exclude !== undefined && (!Array.isArray(t.exclude) || t.exclude.length > 50 || t.exclude.some((x) => typeof x !== 'string' || !x))) {
          bad('invalid_trigger', 'trigger.exclude must be a list of session ids');
        }
        if (t.space !== undefined && (typeof t.space !== 'string' || !t.space.trim() || t.space.length > 64 || t.space.includes('/') || t.space.includes('\\') || t.space.includes('..'))) {
          bad('invalid_trigger', 'trigger.space must be a valid Space name');
        }
        if (t.managedBy !== undefined && (typeof t.managedBy !== 'string' || !/^[\w-]{1,40}$/.test(t.managedBy))) {
          bad('invalid_trigger', 'trigger.managedBy must be a session uid');
        }
        if (t.excludeRoles !== undefined && (!Array.isArray(t.excludeRoles) || t.excludeRoles.some((r) => !['chief', 'worker', 'reviewer'].includes(r)))) {
          bad('invalid_trigger', 'trigger.excludeRoles must contain chief, worker, or reviewer');
        }
        break;
      case 'overlap':
        if (t.repo !== undefined && (typeof t.repo !== 'string' || !t.repo.trim() || t.repo.length > 1024)) bad('invalid_trigger', 'trigger.repo must be a path or repo name');
        if (t.repeat !== undefined && typeof t.repeat !== 'boolean') bad('invalid_trigger', 'trigger.repeat must be true or false');
        break;
      case 'manual':
        break;
      default:
        bad('invalid_trigger', 'trigger.kind is at, every, cron, after, session, overlap or manual');
    }
    for (const k of ['maxRuns', 'retries', 'backoffSeconds', 'timeoutSeconds'] as const) {
      if (p[k] !== undefined && (!Number.isInteger(p[k]) || p[k]! < 0)) bad('invalid_policy', `${k} must be a whole number`);
    }
    for (const k of ['skipIfBusy', 'ifLive'] as const) {
      if (p[k] !== undefined && typeof p[k] !== 'boolean') bad('invalid_policy', `${k} must be true or false`);
    }
    if ((p.retries ?? 0) > 10) bad('invalid_policy', 'at most 10 retries');
    return { action: a, trigger: t, policy: p };
  }

  private firstRunAt(t: Trigger): number | null {
    if (t.kind === 'at') return Math.floor(t.at);
    if (t.kind === 'every') return now() + Math.floor(t.seconds);
    if (t.kind === 'cron') return Math.floor((nextRun(parseCron(t.expr), t.tz, Date.now()) ?? 0) / 1000) || null;
    return null;
  }

  async create(o: { name: string; action: unknown; trigger: unknown; policy?: unknown; createdBy: string }): Promise<JobView> {
    const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 120) : 'Job';
    const v = await this.validate(o.action, o.trigger, o.policy);
    const row = await this.db.job.create({
      data: { id: id('jb'), name, actionJson: JSON.stringify(v.action), triggerJson: JSON.stringify(v.trigger), policyJson: JSON.stringify(v.policy), nextRunAt: this.firstRunAt(v.trigger), armedAt: now(), createdBy: o.createdBy, createdAt: now(), updatedAt: now() },
    });
    this.kick();
    return this.view(row);
  }

  async update(jobId: string, o: { name?: string; action?: unknown; trigger?: unknown; policy?: unknown }): Promise<JobView> {
    const row = await this.job(jobId);
    if (['done', 'cancelled'].includes(row.state)) throw new JobError(409, 'finished', `it is ${row.state}`);
    const v = await this.validate(o.action ?? JSON.parse(row.actionJson), o.trigger ?? JSON.parse(row.triggerJson), o.policy ?? JSON.parse(row.policyJson));
    const changedTrigger = o.trigger !== undefined;
    const next = await this.db.job.update({
      where: { id: jobId },
      data: { name: o.name?.trim().slice(0, 120) || row.name, actionJson: JSON.stringify(v.action), triggerJson: JSON.stringify(v.trigger), policyJson: JSON.stringify(v.policy), ...(changedTrigger ? { nextRunAt: this.firstRunAt(v.trigger), armedAt: now(), sawBusyAt: null } : {}), updatedAt: now() },
    });
    this.kick();
    return this.view(next);
  }

  async pause(jobId: string): Promise<JobView> {
    const row = await this.job(jobId);
    if (['done', 'cancelled', 'failed'].includes(row.state)) throw new JobError(409, 'finished', `it is ${row.state}`);
    return this.view(await this.db.job.update({ where: { id: jobId }, data: { state: 'paused', updatedAt: now() } }));
  }

  async resume(jobId: string): Promise<JobView> {
    const row = await this.job(jobId);
    if (row.state !== 'paused') throw new JobError(409, 'not_paused', `it is ${row.state}`);
    const t = parse<Trigger>(row.triggerJson, { kind: 'manual' });
    // A schedule resumes at its next slot from now: paused time isn't made up.
    const nextRunAt = t.kind === 'cron' || t.kind === 'every' ? this.firstRunAt(t) : row.nextRunAt;
    const out = this.view(await this.db.job.update({ where: { id: jobId }, data: { state: 'scheduled', nextRunAt, armedAt: t.kind === 'session' ? now() : row.armedAt, sawBusyAt: t.kind === 'session' ? null : row.sawBusyAt, updatedAt: now() } }));
    this.kick();
    return out;
  }

  /** Cancels the job and its pending runs. A run already speaking to an agent is left to finish (cancelled, not undone). */
  async cancel(jobId: string): Promise<JobView> {
    await this.job(jobId);
    await this.db.$transaction([
      this.db.jobRun.updateMany({ where: { jobId, state: { in: ['eligible', 'waiting', 'uncertain'] } }, data: { state: 'cancelled', endedAt: now(), updatedAt: now() } }),
      this.db.job.update({ where: { id: jobId }, data: { state: 'cancelled', nextRunAt: null, updatedAt: now() } }),
    ]);
    this.kick();
    return this.view(await this.job(jobId));
  }

  /** Run now, once, whatever the trigger. */
  async runNow(jobId: string): Promise<RunView> {
    const row = await this.job(jobId);
    if (['cancelled'].includes(row.state)) throw new JobError(409, 'finished', 'it is cancelled');
    const run = await this.createRun(row, `manual:${jobId}:${Date.now()}`, 'manual', now());
    this.kick();
    return runView(run!);
  }

  private async job(jobId: string): Promise<JobRow> {
    const row = await this.db.job.findUnique({ where: { id: jobId } });
    if (!row) throw new JobError(404, 'not_found', 'no such job');
    return row;
  }

  private async view(row: JobRow): Promise<JobView> {
    const last = await this.db.jobRun.findFirst({ where: { jobId: row.id }, orderBy: { seq: 'desc' } });
    return { id: row.id, name: row.name, state: row.state, action: parse(row.actionJson, {} as Action), trigger: parse(row.triggerJson, { kind: 'manual' }), policy: parse(row.policyJson, {}), nextRunAt: row.nextRunAt, runCount: row.runCount, createdBy: row.createdBy, createdAt: row.createdAt, updatedAt: row.updatedAt, lastRun: last ? runView(last) : null };
  }

  async get(jobId: string): Promise<JobView & { runs: RunView[] }> {
    const row = await this.job(jobId);
    const runs = await this.db.jobRun.findMany({ where: { jobId }, orderBy: { seq: 'desc' }, take: 100 });
    return { ...(await this.view(row)), runs: runs.map(runView) };
  }

  async list(): Promise<JobView[]> {
    const rows = await this.db.job.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async run(runId: string): Promise<RunView> {
    const r = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!r) throw new JobError(404, 'not_found', 'no such run');
    return runView(r);
  }

  // ---------- runs

  /**
   * One run per cause: `key` is unique, so the same slot, upstream run or session
   * event creates nothing a second time (a duplicate trigger, a second worker, a
   * restart in between). Returns null when it already existed.
   */
  private async createRun(job: JobRow, key: string, triggeredBy: string, scheduledFor: number, o: { attempt?: number; state?: string; outcome?: Record<string, unknown> } = {}, tries = 0): Promise<RunRow | null> {
    try {
      return await this.db.$transaction(async (tx) => {
        const fresh = await tx.job.findUniqueOrThrow({ where: { id: job.id } });
        const seq = (await tx.jobRun.count({ where: { jobId: job.id } })) + 1;
        const run = await tx.jobRun.create({ data: { id: id('jr'), jobId: job.id, seq, idempotencyKey: key, triggeredBy, scheduledFor, attempt: o.attempt ?? 1, state: o.state ?? 'eligible', outcomeJson: JSON.stringify(o.outcome ?? {}), createdAt: now(), updatedAt: now() } });
        await tx.job.update({ where: { id: job.id }, data: { runCount: fresh.runCount + (o.attempt && o.attempt > 1 ? 0 : 1), updatedAt: now() } });
        return run;
      });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
      // This cause already has its run; or two causes raced for the same number: try again.
      if (await this.db.jobRun.findUnique({ where: { idempotencyKey: key } })) return null;
      if (tries < 3) return this.createRun(job, key, triggeredBy, scheduledFor, o, tries + 1);
      throw err;
    }
  }

  /** Resolves {{trigger.reply|session|title|agent|event|ask|stalledSeconds|repo|files|sessions}}, {{job:<id>.reply|session}}: data, never commands. */
  private async fill(text: string, run: RunRow): Promise<string> {
    const upstream = run.triggeredBy.startsWith('after:') ? await this.db.jobRun.findUnique({ where: { id: run.triggeredBy.slice(6) } }) : null;
    const event = parse<{ event?: SessionEventOutcome }>(run.outcomeJson, {}).event ?? null;
    const lastOf = async (jobId: string) => this.db.jobRun.findFirst({ where: { jobId, state: 'succeeded' }, orderBy: { seq: 'desc' } });
    const parts: string[] = [];
    let rest = text;
    const pattern = /\{\{\s*(trigger|job:(jb-[0-9a-f]{8}))\.(reply|session|title|agent|event|ask|stalledSeconds|repo|files|sessions)\s*\}\}/;
    for (let m = rest.match(pattern); m; m = rest.match(pattern)) {
      parts.push(rest.slice(0, m.index));
      const field = m[3];
      if (m[1] === 'trigger' && event) {
        const val =
          field === 'session'
            ? event.uid
            : field === 'title'
              ? event.title
              : field === 'agent'
                ? (event.agent ?? 'shell')
                : field === 'event'
                  ? event.kind
                  : field === 'ask'
                    ? (event.ask ?? '')
                    : field === 'stalledSeconds'
                      ? String(event.stalledSeconds ?? 0)
                      : field === 'repo'
                        ? (event.repo ?? '')
                        : field === 'files'
                          ? (event.files ?? []).join(', ')
                          : field === 'sessions'
                            ? (event.sessions ?? []).join(', ')
                            : (event.reply ?? '');
        parts.push(val);
      } else {
        const src = m[1] === 'trigger' ? upstream : await lastOf(m[2]);
        if (!src) throw new JobError(409, 'missing_input', `${m[0]} has nothing to fill in yet`);
        const v = field === 'session' ? src.sessionUid : field === 'reply' ? parse<{ reply?: string }>(src.outcomeJson, {}).reply : null;
        if (!v) throw new JobError(409, 'missing_input', `${m[0]} has nothing to fill in`);
        parts.push(v);
      }
      rest = rest.slice(m.index! + m[0].length);
    }
    return parts.join('') + rest;
  }

  private async setRun(runId: string, data: Partial<RunRow>): Promise<RunRow> {
    return this.db.jobRun.update({ where: { id: runId }, data: { ...data, updatedAt: now() } });
  }

  private async setDelivery(run: RunRow, patch: Delivery): Promise<RunRow> {
    return this.setRun(run.id, { deliveryJson: JSON.stringify({ ...parse<Delivery>(run.deliveryJson, {}), ...patch }) });
  }

  /** Carries out a claimed run's action. Each step is recorded before the next. */
  private async execute(run: RunRow, job: JobRow, windows: WindowView[]): Promise<void> {
    const action = parse<Action>(job.actionJson, {} as Action);
    const policy = parse<Policy>(job.policyJson, {});
    try {
      if (action.kind === 'decide') {
        const body = action.body ? await this.fill(action.body, run) : '';
        await this.setRun(run.id, { state: 'waiting', outcomeJson: JSON.stringify({ ...parse(run.outcomeJson, {}), body: body.slice(0, 16_000) }) });
        await this.db.job.update({ where: { id: job.id }, data: { state: job.state === 'paused' ? 'paused' : 'waiting', updatedAt: now() } });
        this.deps.alert({ title: `Decide: ${action.title}`, body: (body || job.name).slice(0, 180), tag: `job-${job.id}`, url: '/#jobs' });
        return;
      }
      if (action.kind === 'send' && (policy.ifLive || policy.skipIfBusy)) {
        const target = await this.fill(action.target, run);
        const uid = await this.deps.resolveTarget(target);
        const w = uid ? windows.find((x) => x.uid === uid) : undefined;
        if (policy.ifLive && !w) {
          await this.skip(run, 'target session is not running');
          return;
        }
        // Never type an automated event wake into a session blocked on a permission/question prompt.
        if (policy.ifLive && w && w.status === 'waiting') {
          await this.skip(run, 'target session is waiting on a prompt');
          return;
        }
        if (policy.skipIfBusy && w && (w.status === 'busy' || w.status === 'waiting' || this.deps.queueIds(w.uid).length > 0)) {
          await this.skip(run, 'target session is busy');
          return;
        }
      }
      await this.act(run, job, action);
    } catch (err) {
      await this.fail(run.id, (err as Error).message, err instanceof JobError && err.code === 'missing_input' ? false : true);
    }
  }

  private async skip(run: RunRow, reason: string): Promise<void> {
    const ok = await this.db.jobRun.updateMany({
      where: { id: run.id, state: { in: ['running', 'eligible'] } },
      data: { state: 'skipped', endedAt: now(), outcomeJson: JSON.stringify({ ...parse(run.outcomeJson, {}), skippedBecause: reason }), updatedAt: now() },
    });
    if (ok.count) await this.finished(run.id, 'skipped');
  }

  private async act(run: RunRow, job: JobRow, action: LaunchAction | SendAction): Promise<void> {
    if (action.kind === 'launch') {
      const prompt = await this.fill(action.prompt, run);
      // The uid first: a restart finds out whether the launch happened by looking for it.
      const uid = run.sessionUid ?? this.deps.freshUid();
      run = await this.setRun(run.id, { sessionUid: uid, startedAt: run.startedAt ?? now() });
      run = await this.setDelivery(run, { dispatchingAt: now(), mark: 0 });
      await this.deps.launch({ preset: action.preset, cwd: action.cwd, name: action.name || job.name, uid, prompt, id: run.id, model: action.model, effort: action.effort, mode: action.mode, worktree: action.worktree, createdBy: job.createdBy, meta: { 'ah.job': { jobId: job.id, runId: run.id }, ...(parse<Policy>(job.policyJson, {}).autoRecover ? { 'ah.recovery.auto': true } : {}) } });
      await this.setDelivery(run, { launchedAt: now(), acceptedAt: now(), queuedAt: now(), outcome: 'queued' });
    } else {
      const target = await this.fill(action.target, run);
      const text = await this.fill(action.text, run);
      const uid = await this.deps.resolveTarget(target);
      if (!uid) throw new JobError(404, 'unknown_target', `no session ${target}`);
      const before = await this.deps.readTranscript(uid, Number.MAX_SAFE_INTEGER).catch(() => null);
      run = await this.setRun(run.id, { sessionUid: uid, startedAt: run.startedAt ?? now(), deliveryJson: JSON.stringify({ ...parse<Delivery>(run.deliveryJson, {}), dispatchingAt: now(), mark: before?.size ?? 0, text: needle(text) }) });
      const jobActor = job.createdBy.startsWith('session:') ? job.createdBy.slice('session:'.length) : null;
      const out = await this.deps.send(uid, text, run.id, jobActor);
      await this.setDelivery(run, { acceptedAt: now(), outcome: out.outcome, ...(out.outcome === 'delivered' ? { typedAt: now() } : { queuedAt: now() }) });
    }
  }

  /** A run's message: what it typed, for finding it in the transcript. */
  private async textOf(run: RunRow, job: JobRow): Promise<string | null> {
    const a = parse<Action>(job.actionJson, {} as Action);
    const d = parse<Delivery & { text?: string }>(run.deliveryJson, {});
    if (d.text) return d.text;
    const act = a.kind === 'decide' ? a.then : a;
    if (!act) return null;
    try {
      return needle(await this.fill(act.kind === 'launch' ? act.prompt : act.text, run));
    } catch {
      return null;
    }
  }

  /** Watches a dispatched run: arrived, answered, finished, or the session went away. */
  private async observe(run: RunRow, job: JobRow, windows: WindowView[]): Promise<void> {
    const uid = run.sessionUid;
    if (!uid) return;
    const policy = parse<Policy>(job.policyJson, {});
    const d = parse<Delivery>(run.deliveryJson, {});
    if (!d.acceptedAt) return;
    const since = (d.observedAt ?? d.acceptedAt) - 5;
    const w = windows.find((x) => x.uid === uid);
    const rec = this.deps.record(uid);
    const want = await this.textOf(run, job);
    const noTranscript = this.deps.hasTranscript ? !this.deps.hasTranscript(uid) : false;
    const t = noTranscript ? null : await this.deps.readTranscript(uid, d.mark ?? 0).catch(() => null);
    let i = -1;
    if (t && want) i = t.user.findIndex((u) => u.includes(want));
    const stillQueued = this.deps.queueIds(uid).includes(run.id);
    if (i >= 0 && !d.observedAt) run = await this.setDelivery(run, { observedAt: now() });
    const observed = i >= 0 || !!parse<Delivery>(run.deliveryJson, {}).observedAt || (noTranscript && !stillQueued);
    const reply = t && observed ? t.replies.filter((r) => r.at >= since * 1000).pop() : undefined;
    const settled = w && w.status !== 'busy' && w.status !== 'waiting' && !stillQueued;
    if (observed && (policy.until === 'delivered' || (settled && (reply || (noTranscript && (w.status === 'attention' || now() - (d.typedAt ?? d.acceptedAt) >= 3)))))) {
      return this.succeed(run, { ...(reply ? { reply: reply.text.slice(0, 16_000) } : {}) });
    }
    const timeout = policy.timeoutSeconds ?? 6 * 3600;
    if (run.startedAt && now() - run.startedAt > timeout) return this.fail(run.id, `it didn't finish within ${Math.round(timeout / 60)} minutes`, true);
    if (!w && rec && (rec.lifecycle === 'ended' || rec.lifecycle === 'unavailable')) {
      if (observed && reply) return this.succeed(run, { reply: reply.text.slice(0, 16_000) });
      return this.fail(run.id, observed ? 'the session ended before its turn finished' : 'the session ended before it took the message', true);
    }
  }

  private async succeed(run: RunRow, outcome: Record<string, unknown>): Promise<void> {
    const ok = await this.db.jobRun.updateMany({ where: { id: run.id, state: { in: ['running', 'waiting'] } }, data: { state: 'succeeded', endedAt: now(), outcomeJson: JSON.stringify({ ...parse(run.outcomeJson, {}), ...outcome }), deliveryJson: JSON.stringify({ ...parse<Delivery>(run.deliveryJson, {}), finishedAt: now() }), updatedAt: now() } });
    if (ok.count) await this.finished(run.id, 'succeeded');
  }

  private async fail(runId: string, error: string, retryable: boolean): Promise<void> {
    const ok = await this.db.jobRun.updateMany({ where: { id: runId, state: { in: ['running', 'eligible'] } }, data: { state: 'failed', error, endedAt: now(), updatedAt: now() } });
    if (!ok.count) return;
    const run = await this.db.jobRun.findUniqueOrThrow({ where: { id: runId } });
    const job = await this.db.job.findUniqueOrThrow({ where: { id: run.jobId } });
    const policy = parse<Policy>(job.policyJson, {});
    if (retryable && run.attempt <= (policy.retries ?? 0) && job.state !== 'cancelled' && job.state !== 'paused') {
      // Backoff doubles per attempt, with ±20% jitter so retries don't line up.
      const base = (policy.backoffSeconds ?? 60) * 2 ** (run.attempt - 1);
      const delay = Math.round(base * (0.8 + Math.random() * 0.4));
      await this.createRun(job, `retry:${run.id}`, `retry:${run.id}`, now() + delay, { attempt: run.attempt + 1 });
      return;
    }
    await this.finished(runId, 'failed');
  }

  /** A run reached an end: the job's next state, dependents, notifications. */
  private async finished(runId: string, how: 'succeeded' | 'failed' | 'cancelled' | 'skipped'): Promise<void> {
    const run = await this.db.jobRun.findUniqueOrThrow({ where: { id: runId } });
    const job = await this.db.job.findUniqueOrThrow({ where: { id: run.jobId } });
    const trigger = parse<Trigger>(job.triggerJson, { kind: 'manual' });
    const policy = parse<Policy>(job.policyJson, {});
    const more =
      ((trigger.kind === 'cron' || trigger.kind === 'every') && job.nextRunAt !== null) ||
      trigger.kind === 'after' ||
      trigger.kind === 'manual' ||
      ((trigger.kind === 'session' || trigger.kind === 'overlap') && !!trigger.repeat);
    const spent = policy.maxRuns !== undefined && job.runCount >= policy.maxRuns;
    let state = job.state;
    if (state === 'waiting') state = 'scheduled';
    if (!['paused', 'cancelled'].includes(state)) state = how === 'failed' && !more ? 'failed' : more && !spent ? 'scheduled' : 'done';
    await this.db.job.update({ where: { id: job.id }, data: { state, ...(spent ? { nextRunAt: null } : {}), updatedAt: now() } });
    if (how !== 'skipped') await this.cascade(run, how);
    if (how !== 'skipped' && (policy.notify || how === 'failed')) {
      const out = parse<{ reply?: string }>(run.outcomeJson, {});
      this.deps.alert({ title: `${job.name}: ${how === 'succeeded' ? 'done' : how}`, body: (how === 'failed' ? (run.error ?? '') : (out.reply ?? '')).slice(0, 180) || job.name, tag: `job-${job.id}`, url: '/#jobs' });
    }
    this.deps.changed();
  }

  /** Jobs waiting on this one: one run each per upstream run (unique key), or a skipped run saying why. */
  private async cascade(run: RunRow, how: string): Promise<void> {
    const dependents = (await this.db.job.findMany({ where: { state: { in: ['scheduled', 'waiting'] } } })).filter((j) => {
      const t = parse<Trigger>(j.triggerJson, { kind: 'manual' });
      return t.kind === 'after' && t.job === run.jobId;
    });
    for (const dep of dependents) {
      const t = parse<Trigger>(dep.triggerJson, { kind: 'manual' }) as Extract<Trigger, { kind: 'after' }>;
      const fire = t.on === 'any' || (t.on === 'success' && how === 'succeeded') || (t.on === 'failure' && how === 'failed');
      if (fire) await this.createRun(dep, `after:${run.id}:${dep.id}`, `after:${run.id}`, now());
      else await this.createRun(dep, `after:${run.id}:${dep.id}`, `after:${run.id}`, now(), { state: 'skipped', outcome: { skippedBecause: `the job it waits for ${how === 'cancelled' ? 'was cancelled' : how}` } });
    }
  }

  /** Your answer to a decision run: go ahead (and run its follow-up), or stop. */
  async decide(runId: string, o: { approve: boolean; note?: string }): Promise<RunView> {
    const run = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!run) throw new JobError(404, 'not_found', 'no such run');
    if (run.state !== 'waiting') throw new JobError(409, 'not_waiting', `it is ${run.state}`);
    const job = await this.job(run.jobId);
    const action = parse<Action>(job.actionJson, {} as Action);
    const outcome = { ...parse(run.outcomeJson, {}), decision: o.approve ? 'approved' : 'declined', ...(o.note ? { note: o.note.slice(0, 2000) } : {}) };
    if (!o.approve) {
      const ok = await this.db.jobRun.updateMany({ where: { id: runId, state: 'waiting' }, data: { state: 'cancelled', outcomeJson: JSON.stringify(outcome), endedAt: now(), updatedAt: now() } });
      if (ok.count) await this.finished(runId, 'cancelled');
      return this.run(runId);
    }
    if (action.kind !== 'decide' || !action.then) {
      await this.db.jobRun.update({ where: { id: runId }, data: { outcomeJson: JSON.stringify(outcome) } });
      await this.succeed(await this.db.jobRun.findUniqueOrThrow({ where: { id: runId } }), {});
      return this.run(runId);
    }
    // Approved with a follow-up: this run goes on to do it, and finishes when that does.
    const claimed = await this.db.jobRun.updateMany({ where: { id: runId, state: 'waiting' }, data: { state: 'running', owner: this.instance, outcomeJson: JSON.stringify(outcome), updatedAt: now() } });
    if (!claimed.count) throw new JobError(409, 'not_waiting', 'someone else decided first');
    if (job.state === 'waiting') await this.db.job.update({ where: { id: job.id }, data: { state: 'scheduled', updatedAt: now() } });
    try {
      await this.act(await this.db.jobRun.findUniqueOrThrow({ where: { id: runId } }), job, action.then);
    } catch (err) {
      await this.fail(runId, (err as Error).message, false);
    }
    this.kick();
    return this.run(runId);
  }

  /** An uncertain run: send again (you've checked it didn't arrive), or leave it. */
  async resolveUncertain(runId: string, o: { resend: boolean }): Promise<RunView> {
    const run = await this.db.jobRun.findUnique({ where: { id: runId } });
    if (!run) throw new JobError(404, 'not_found', 'no such run');
    if (run.state !== 'uncertain') throw new JobError(409, 'not_uncertain', `it is ${run.state}`);
    if (!o.resend) {
      await this.db.jobRun.updateMany({ where: { id: runId, state: 'uncertain' }, data: { state: 'cancelled', endedAt: now(), updatedAt: now() } });
      await this.finished(runId, 'cancelled');
      return this.run(runId);
    }
    const job = await this.job(run.jobId);
    await this.createRun(job, `resend:${run.id}`, `retry:${run.id}`, now(), { attempt: run.attempt + 1 });
    await this.db.jobRun.update({ where: { id: runId }, data: { state: 'failed', error: 'uncertain; sent again at your request', endedAt: now() } });
    this.kick();
    return this.run(runId);
  }

  // ---------- the loop

  /** Ask for a pass soon (something changed). */
  kick() {
    this.deps.changed();
  }

  /** One pass, from the core tick: due triggers, dependencies, starts within limits, watches. */
  tick(windows: WindowView[]): Promise<void> {
    this.ticking ??= this.pass(windows)
      .catch((err) => console.error('scheduler pass failed:', err))
      .finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async pass(windows: WindowView[]) {
    if (!this.reconciled) {
      this.reconciled = true;
      await this.reconcile(windows);
    }
    const t = now();
    // Time: one-time, interval (`every`) and cron jobs that are due. A schedule missed while ah was down
    // runs once for the latest slot it missed, not once per slot.
    for (const job of await this.db.job.findMany({ where: { state: 'scheduled', nextRunAt: { lte: t } } })) {
      const trig = parse<Trigger>(job.triggerJson, { kind: 'manual' });
      const policy = parse<Policy>(job.policyJson, {});
      const slot = job.nextRunAt!;
      let next: number | null = null;
      const capped = policy.maxRuns !== undefined && job.runCount + 1 >= policy.maxRuns;
      if (trig.kind === 'cron' && !capped) next = Math.floor((nextRun(parseCron(trig.expr), trig.tz, Math.max(slot, t) * 1000) ?? 0) / 1000) || null;
      else if (trig.kind === 'every' && !capped) next = t + Math.floor(trig.seconds);
      await this.createRun(job, `slot:${job.id}:${slot}`, 'schedule', slot);
      await this.db.job.update({ where: { id: job.id }, data: { nextRunAt: next, lastFiredAt: t, updatedAt: now() } });
    }
    // Sessions & checkout overlaps: idle, waiting, stalled, ended, or concurrent file overlap.
    let cachedOverlaps: OverlapFact[] | null = null;
    for (const job of await this.db.job.findMany({ where: { state: 'scheduled', nextRunAt: null } })) {
      const trig = parse<Trigger>(job.triggerJson, { kind: 'manual' });
      const policy = parse<Policy>(job.policyJson, {});
      if (policy.maxRuns !== undefined && job.runCount >= policy.maxRuns) continue;
      if (trig.kind === 'overlap') {
        if (!trig.repeat && job.lastFiredAt) continue;
        if (!this.deps.overlaps) continue;
        cachedOverlaps ??= await this.deps.overlaps().catch(() => []);
        for (const ov of cachedOverlaps) {
          if (trig.repo && ov.repoRoot !== trig.repo && ov.repoName !== trig.repo) continue;
          const sig = `${ov.key}:${[...ov.files].sort().join(',')}`;
          const mapKey = `${job.id}:${ov.key}`;
          if (this.overlapSeen.get(mapKey) === sig) continue;
          this.overlapSeen.set(mapKey, sig);
          const outcome = {
            event: {
              kind: 'overlap' as const,
              uid: ov.sessions[0] ?? '',
              title: ov.repoName,
              agent: null,
              repo: ov.repoName,
              files: ov.files,
              sessions: ov.sessions,
            },
          };
          await this.fireOnce(job, `overlap:${job.id}:${sig}`, `overlap:${ov.repoName}`, outcome);
          if (!trig.repeat) break;
        }
        continue;
      }
      if (trig.kind !== 'session') continue;
      if (!trig.repeat && job.lastFiredAt) continue;
      const action = parse<Action>(job.actionJson, {} as Action);
      const stallAfter = trig.afterSeconds ?? 300;
      const stalledFor = (w: WindowView): number | null => {
        if (w.status !== 'busy') return null;
        const busyAt = w.busySince ?? null;
        if (busyAt === null) return null;
        const lastProgress = Math.max(busyAt, w.contentAt ?? busyAt);
        const silent = t - lastProgress;
        return silent >= stallAfter ? silent : null;
      };
      const eventOf = (kind: SessionEventOutcome['kind'], w?: WindowView, rec?: SessionRecord, extra?: Partial<SessionEventOutcome>): Record<string, unknown> => ({
        event: {
          kind,
          uid: w?.uid ?? rec?.id ?? trig.uid,
          title: w?.title ?? w?.name ?? rec?.title ?? '',
          agent: w?.agent ?? rec?.harness ?? null,
          ...(w?.ask ? { ask: w.ask.text.slice(0, 2000) } : {}),
          ...(w?.askId ? { askId: w.askId } : {}),
          ...(w ? { answerable: w.answerable } : {}),
          ...(w?.reply ? { reply: w.reply.text.slice(0, 4000) } : {}),
          ...extra,
        },
      });
      if (trig.uid === '*') {
        const excluded = new Set(trig.exclude ?? []);
        if (action.kind === 'send' && !action.target.includes('{{')) excluded.add(action.target);
        const matchesScope = (uid: string, win?: WindowView): boolean => {
          if (trig.space) {
            const sp = win ? (win.space || win.project) : (this.deps.spaceOf?.(uid) ?? null);
            if (!sp || sp !== trig.space) return false;
          }
          if (trig.managedBy) {
            const mgr = win?.supervision?.managedBy ?? this.deps.managedByOf?.(uid) ?? null;
            if (mgr !== trig.managedBy) return false;
          }
          if (trig.excludeRoles?.length) {
            const role = win?.supervision?.role ?? this.deps.roleOf?.(uid) ?? null;
            if (role && trig.excludeRoles.includes(role)) return false;
          }
          return true;
        };
        if (trig.on === 'waiting') {
          for (const w of windows) {
            if (excluded.has(w.uid) || !matchesScope(w.uid, w)) continue;
            const wk = `${job.id}:${w.uid}`;
            if (w.status === 'waiting') {
              const ep = w.askId ?? String(w.activity || t);
              if (this.waitingSeen.get(wk) !== ep) {
                this.waitingSeen.set(wk, ep);
                await this.fireOnce(job, `session:${job.id}:${w.uid}:waiting:${ep}`, `session:${w.uid}`, eventOf('waiting', w));
                if (!trig.repeat) break;
              }
            } else {
              this.waitingSeen.delete(wk);
            }
          }
        } else if (trig.on === 'stalled') {
          for (const w of windows) {
            if (excluded.has(w.uid) || !matchesScope(w.uid, w)) continue;
            const silent = stalledFor(w);
            if (silent !== null) {
              const progressAt = Math.max(w.busySince ?? 0, w.contentAt ?? 0);
              const bucket = Math.floor(silent / stallAfter);
              const key = `session:${job.id}:${w.uid}:stalled:${progressAt}:${bucket}`;
              await this.fireOnce(job, key, `session:${w.uid}`, eventOf('stalled', w, undefined, { stalledSeconds: silent }));
              if (!trig.repeat) break;
            }
          }
        } else if (trig.on === 'idle') {
          for (const w of windows) {
            if (excluded.has(w.uid) || !matchesScope(w.uid, w)) continue;
            const bk = `${job.id}:${w.uid}`;
            if (w.status === 'busy' || w.status === 'waiting') {
              if (!this.fleetBusy.has(bk)) this.fleetBusy.set(bk, t);
            } else if (this.fleetBusy.has(bk) && (w.status === 'idle' || w.status === 'attention') && t - this.fleetBusy.get(bk)! >= 2) {
              const busyAt = this.fleetBusy.get(bk)!;
              this.fleetBusy.delete(bk);
              await this.fireOnce(job, `session:${job.id}:${w.uid}:idle:${busyAt}`, `session:${w.uid}`, eventOf('idle', w));
              if (!trig.repeat) break;
            }
          }
        } else if (trig.on === 'ended') {
          const live = new Set(windows.map((x) => x.uid));
          for (const rec of this.deps.records?.() ?? []) {
            if (excluded.has(rec.id) || live.has(rec.id) || !matchesScope(rec.id)) continue;
            if (rec.endedAt && rec.endedAt >= job.armedAt) {
              await this.fireOnce(job, `session:${job.id}:${rec.id}:ended:${rec.endedAt}`, `session:${rec.id}`, eventOf('ended', undefined, rec));
              if (!trig.repeat) break;
            }
          }
        }
        continue;
      }
      const w = windows.find((x) => x.uid === trig.uid);
      const rec = this.deps.record(trig.uid);
      if (trig.on === 'waiting') {
        const wk = `${job.id}:${trig.uid}`;
        if (w && w.status === 'waiting') {
          const ep = w.askId ?? String(w.activity || t);
          if (this.waitingSeen.get(wk) !== ep) {
            this.waitingSeen.set(wk, ep);
            const key = trig.repeat ? `session:${job.id}:${w.uid}:waiting:${ep}` : `session:${job.id}:${job.armedAt}`;
            await this.fireOnce(job, key, `session:${trig.uid}`, eventOf('waiting', w));
          }
        } else {
          this.waitingSeen.delete(wk);
        }
        continue;
      }
      if (trig.on === 'stalled') {
        const silent = w ? stalledFor(w) : null;
        if (w && silent !== null) {
          const progressAt = Math.max(w.busySince ?? 0, w.contentAt ?? 0);
          const bucket = Math.floor(silent / stallAfter);
          const key = trig.repeat ? `session:${job.id}:${w.uid}:stalled:${progressAt}:${bucket}` : `session:${job.id}:${job.armedAt}`;
          await this.fireOnce(job, key, `session:${trig.uid}`, eventOf('stalled', w, undefined, { stalledSeconds: silent }));
        }
        continue;
      }
      if (trig.on === 'ended') {
        if (!w && rec?.endedAt && rec.endedAt >= job.armedAt) {
          const key = trig.repeat ? `session:${job.id}:ended:${rec.endedAt}` : `session:${job.id}:${job.armedAt}`;
          await this.fireOnce(job, key, `session:${trig.uid}`, eventOf('ended', undefined, rec), trig.repeat ? { armedAt: rec.endedAt + 1 } : undefined);
        }
        continue;
      }
      // Seen at work since it was armed (kept, so a restart remembers), then settled: its turn
      // ended. Screen output alone (a redraw, a clock) is not work.
      if (w && (w.status === 'busy' || w.status === 'waiting') && !job.sawBusyAt) await this.db.job.update({ where: { id: job.id }, data: { sawBusyAt: t } });
      if (job.sawBusyAt && w && (w.status === 'idle' || w.status === 'attention') && t - job.sawBusyAt >= 2) {
        const key = trig.repeat ? `session:${job.id}:${job.sawBusyAt}` : `session:${job.id}:${job.armedAt}`;
        await this.fireOnce(job, key, `session:${trig.uid}`, eventOf('idle', w), trig.repeat ? { sawBusyAt: null, armedAt: t } : undefined);
      }
    }
    await this.start(windows);
    for (const run of await this.db.jobRun.findMany({ where: { state: 'running', owner: this.instance } })) {
      if (this.executing.has(run.id)) continue;
      const job = await this.db.job.findUnique({ where: { id: run.jobId } });
      if (job) await this.observe(run, job, windows).catch((err) => console.warn(`job run ${run.id}:`, err));
    }
    await this.refreshSummary();
  }

  private async fireOnce(job: JobRow, key: string, by: string, outcome: Record<string, unknown> = {}, jobPatch: Partial<JobRow> = {}) {
    const created = await this.createRun(job, key, by, now(), { outcome });
    if (created) await this.db.job.update({ where: { id: job.id }, data: { lastFiredAt: now(), ...jobPatch, updatedAt: now() } });
    return !!created;
  }

  /** Claims eligible runs within the limits, oldest first, and starts them. */
  private async start(windows: WindowView[]) {
    const limits = this.deps.limits();
    const t = now();
    const eligible = await this.db.jobRun.findMany({ where: { state: 'eligible', scheduledFor: { lte: t } }, orderBy: { scheduledFor: 'asc' }, take: 50 });
    if (!eligible.length) return;
    let running = await this.db.jobRun.count({ where: { state: 'running' } });
    const launchedRecently = await this.db.jobRun.count({ where: { startedAt: { gte: t - 3600 }, deliveryJson: { contains: '"launchedAt"' } } });
    const retriesLastMinute = await this.db.jobRun.count({ where: { attempt: { gt: 1 }, startedAt: { gte: t - 60 } } });
    let launches = launchedRecently;
    let retries = retriesLastMinute;
    for (const run of eligible) {
      const job = await this.db.job.findUnique({ where: { id: run.jobId } });
      if (!job || job.state === 'cancelled') continue;
      if (job.state === 'paused') continue;
      const action = parse<Action>(job.actionJson, {} as Action);
      const policy = parse<Policy>(job.policyJson, {});
      const isDecision = action.kind === 'decide';
      // Backpressure: past a limit a run simply waits its turn (still eligible).
      if (!isDecision && running >= limits.maxConcurrent) break;
      if (action.kind === 'launch' && launches >= limits.maxLaunchesPerHour) continue;
      // The agent is at a limit its provider stated: the run waits for the reset rather than
      // start work that can't go anywhere (never a switch to another provider).
      const agent = action.kind === 'launch' ? action.preset : action.kind === 'send' ? this.deps.harnessOf?.(action.target) : null;
      const held = agent ? await this.deps.capacity?.(agent).catch(() => null) : null;
      if (held) {
        if (!run.error?.startsWith('waiting for')) await this.setRun(run.id, { error: `waiting for ${agent}'s limit to reset at ${new Date(held.until * 1000).toISOString()} (${held.why})` });
        continue;
      }
      if (run.attempt > 1 && retries >= limits.maxRetriesPerMinute) continue;
      if (policy.concurrencyKey) {
        const busy = await this.db.jobRun.findMany({ where: { state: { in: ['running', 'waiting'] }, NOT: { id: run.id } } });
        const keys = await Promise.all(busy.map(async (b) => parse<Policy>((await this.db.job.findUnique({ where: { id: b.jobId } }))?.policyJson, {}).concurrencyKey));
        if (keys.includes(policy.concurrencyKey)) continue;
      }
      const claimed = await this.db.jobRun.updateMany({ where: { id: run.id, state: 'eligible' }, data: { state: 'running', owner: this.instance, leaseUntil: t + 300, startedAt: run.startedAt ?? t, error: null, updatedAt: t } });
      if (!claimed.count) continue;
      if (!isDecision) running++;
      if (action.kind === 'launch') launches++;
      if (run.attempt > 1) retries++;
      this.executing.add(run.id);
      const fresh = await this.db.jobRun.findUniqueOrThrow({ where: { id: run.id } });
      void this.execute(fresh, job, windows).finally(() => {
        this.executing.delete(run.id);
        this.kick();
      });
    }
  }

  /**
   * After a restart: runs another process held were cut off mid-way. The evidence
   * decides each one; nothing is launched or sent twice on a guess.
   */
  async reconcile(windows: WindowView[]): Promise<{ resumed: number; requeued: number; uncertain: number }> {
    let resumed = 0;
    let requeued = 0;
    let uncertain = 0;
    const orphans = await this.db.jobRun.findMany({ where: { state: 'running', NOT: { owner: this.instance } } });
    for (const run of orphans) {
      const job = await this.db.job.findUnique({ where: { id: run.jobId } });
      if (!job) continue;
      const action = parse<Action>(job.actionJson, {} as Action);
      const act = action.kind === 'decide' ? action.then : action;
      const d = parse<Delivery>(run.deliveryJson, {});
      const adopt = () => this.setRun(run.id, { owner: this.instance });
      if (!d.dispatchingAt || !act) {
        // Nothing was started for it: start it again.
        await this.setRun(run.id, { state: action.kind === 'decide' && !act ? 'waiting' : 'eligible', owner: null });
        requeued++;
        continue;
      }
      const uid = run.sessionUid;
      const rec = uid ? this.deps.record(uid) : undefined;
      if (act.kind === 'launch' && uid && !rec && !windows.some((w) => w.uid === uid)) {
        // Its session never came to exist: the launch didn't happen. Launch it (same uid).
        await this.setRun(run.id, { state: 'eligible', owner: null });
        requeued++;
        continue;
      }
      const want = await this.textOf(run, job);
      const queued = uid ? this.deps.queueIds(uid).includes(run.id) : false;
      const t = uid ? await this.deps.readTranscript(uid, d.mark ?? 0).catch(() => null) : null;
      const arrived = !!want && !!t?.user.some((u) => u.includes(want));
      if (queued || arrived || d.acceptedAt) {
        // In the queue or the transcript, or the send was answered: it's on its way; keep watching.
        await adopt();
        if (!d.acceptedAt) await this.setDelivery(run, { acceptedAt: now(), outcome: queued ? 'queued' : 'typed' });
        resumed++;
        continue;
      }
      const box = uid ? await this.deps.inputBox(uid).catch(() => null) : null;
      const live = !!uid && windows.some((w) => w.uid === uid);
      if (act.kind === 'launch' && live && box === '') {
        // The session started but its prompt is nowhere: not queued, not typed, not in the
        // transcript. Queue it again under the same id (a second copy can't be queued).
        await adopt();
        await this.deps.send(uid!, await this.fill(act.prompt, run), run.id).catch(() => {});
        await this.setDelivery(run, { acceptedAt: now(), outcome: 'queued' });
        resumed++;
        continue;
      }
      // A message that may have been typed without its arrival being recorded: you decide.
      await this.setRun(run.id, { state: 'uncertain', owner: null, error: 'ah stopped while delivering this; it may or may not have reached the agent (check the session, then send again or leave it)' });
      uncertain++;
    }
    // Dependents a crash cut off between an upstream run finishing and their run being made.
    const recent = await this.db.jobRun.findMany({ where: { state: { in: ['succeeded', 'failed', 'cancelled'] }, endedAt: { gte: now() - 86_400 } } });
    for (const r of recent) await this.cascade(r, r.state);
    return { resumed, requeued, uncertain };
  }

  private async refreshSummary() {
    const jobs = await this.db.job.findMany({ where: { state: { in: ['scheduled', 'waiting'] } }, orderBy: { nextRunAt: 'asc' }, take: 50 });
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const open = await this.db.jobRun.findMany({ where: { state: { in: ['running', 'waiting', 'uncertain'] } }, take: 100 });
    const nameOf = async (jobId: string) => byId.get(jobId)?.name ?? (await this.db.job.findUnique({ where: { id: jobId } }))?.name ?? jobId;
    const next = jobs.filter((j) => j.nextRunAt).slice(0, 10).map((j) => ({ id: j.id, name: j.name, at: j.nextRunAt! }));
    const running: JobsState['running'] = [];
    const waiting: JobsState['waiting'] = [];
    const uncertain: JobsState['uncertain'] = [];
    for (const r of open) {
      if (r.state === 'running') running.push({ id: r.jobId, name: await nameOf(r.jobId), runId: r.id, sessionUid: r.sessionUid });
      else if (r.state === 'uncertain') uncertain.push({ id: r.jobId, name: await nameOf(r.jobId), runId: r.id });
      else {
        const job = byId.get(r.jobId) ?? (await this.db.job.findUnique({ where: { id: r.jobId } }));
        const a = parse<Action>(job?.actionJson, {} as Action);
        waiting.push({ id: r.jobId, name: job?.name ?? r.jobId, runId: r.id, title: a.kind === 'decide' ? a.title : (job?.name ?? ''), body: (parse<{ body?: string }>(r.outcomeJson, {}).body ?? '').slice(0, 2000) });
      }
    }
    const summary = { next, running, waiting, uncertain };
    if (JSON.stringify(summary) !== JSON.stringify(this.summary)) {
      this.summary = summary;
      this.deps.changed();
    }
  }

  /** Cancels active jobs owned by `createdBy` (e.g. auto-subscribed Chief event wakes when that Chief ends). */
  async cancelByOwner(createdBy: string): Promise<number> {
    if (!createdBy) return 0;
    const active = await this.db.job.findMany({ where: { createdBy, state: { in: ['scheduled', 'waiting', 'paused'] } } });
    for (const j of active) await this.cancel(j.id).catch(() => {});
    return active.length;
  }

  /** Rebinds jobs owned by or targeting `oldUid` when a session/Chief is relaunched as `newUid`. */
  async rekey(oldUid: string, newUid: string): Promise<void> {
    if (!oldUid || !newUid || oldUid === newUid) return;
    await Promise.all([
      this.db.job.updateMany({ where: { createdBy: `session:${oldUid}` }, data: { createdBy: `session:${newUid}` } }),
      this.db.job.updateMany({ where: { createdBy: `system:chief:${oldUid}` }, data: { createdBy: `system:chief:${newUid}` } }),
    ]);
    const jobs = await this.db.job.findMany({ where: { state: { in: ['scheduled', 'waiting', 'paused'] } } });
    for (const j of jobs) {
      let dirty = false;
      const action = parse<Action>(j.actionJson, {} as Action);
      if (action.kind === 'send' && action.target === oldUid) {
        action.target = newUid;
        dirty = true;
      } else if (action.kind === 'decide' && action.then?.kind === 'send' && action.then.target === oldUid) {
        action.then.target = newUid;
        dirty = true;
      }
      const trigger = parse<Trigger>(j.triggerJson, {} as Trigger);
      if (trigger.kind === 'session') {
        if (trigger.uid === oldUid) {
          trigger.uid = newUid;
          dirty = true;
        }
        if (trigger.managedBy === oldUid) {
          trigger.managedBy = newUid;
          dirty = true;
        }
        if (trigger.exclude?.includes(oldUid)) {
          trigger.exclude = trigger.exclude.map((u) => (u === oldUid ? newUid : u));
          dirty = true;
        }
      }
      if (dirty) {
        await this.db.job.update({
          where: { id: j.id },
          data: { actionJson: JSON.stringify(action), triggerJson: JSON.stringify(trigger), updatedAt: now() },
        });
      }
    }
  }
}
