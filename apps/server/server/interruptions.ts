// Sessions that crashed (docs/spec/13-conductor.md, CND-8). A session you didn't end
// and the agent didn't leave is *interrupted* when:
// - its tmux server went away (stopped, killed, or replaced by a new one): every
//   session in it, working or not, since they were all still open;
// - the host restarted under it (found when ah next starts);
// - its window closed while the agent was working or waiting.
// A window that closes while its agent is idle is someone closing it: an end, as before.
// What ended it, when, and whether it was mid-turn stay on the session (registry meta
// `ah.interrupted`) until it runs again, by any path, or you dismiss it.
//
// Restoring is one step for one or all: mid-turn ones first, each resumed in its own
// conversation with its own launch choices, its queued prompts kept in order. A mid-turn
// one is told first (a queued note, ahead of your prompts) that it was interrupted, when,
// and the last step its transcript recorded, so it checks before it carries on.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { uptime } from 'node:os';
import { dirname } from 'node:path';
import { ADAPTERS, type Adapter } from './feed/feed.ts';
import type { Entry } from './feed/schema.ts';
import type { QueueItem } from './queue.ts';
import type { SessionRecord } from './registry.ts';
import type { ServerSeen } from './tmux.ts';
import { DomainError } from './errors.ts';

export type InterruptCause = 'tmux_server' | 'host_restart' | 'window';

export type Interrupted = {
  cause: InterruptCause;
  /** When ah noticed (epoch seconds). */
  at: number;
  /** When ah last saw it running: it went down between this and `at`. */
  lastSeenAt: number;
  /** Sessions interrupted together (one server, one restart) share it. */
  incident: string;
  /** Its status just before: `busy` or `waiting` is mid-turn. */
  lastStatus: string;
  midTurn: boolean;
  /** Brought back by ah on its own and it didn't come back (server/revive.ts): when, and why. Absent otherwise. */
  failed?: { at: number; error: string };
};

/** One interrupted session, as the API and the state list it. */
export type InterruptedSession = Interrupted & { uid: string; title: string; harness: string; cwd: string; queued: number };

export type Incident = { id: string; cause: InterruptCause; at: number; count: number; midTurn: number };

/** The state's `interruptions` (always present on hosts with the feature). */
export type InterruptionsState = { count: number; midTurn: number; incidents: Incident[] };

export const INTERRUPTED = 'ah.interrupted';

export class InterruptionError extends DomainError {
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
  }
}

/** What ah knew about its tmux server when it last ticked (persisted: an ah restart compares). */
export type Runtime = { pid: number; at: number };

const now = () => Math.floor(Date.now() / 1000);
const mid = (status: string) => status === 'busy' || status === 'waiting';

export function interruptedOf(r: Pick<SessionRecord, 'meta'>): Interrupted | null {
  const i = r.meta[INTERRUPTED] as Partial<Interrupted> | undefined;
  return i && typeof i.cause === 'string' && typeof i.at === 'number' && typeof i.incident === 'string' ? (i as Interrupted) : null;
}

/**
 * Why a running session is gone, or null when it simply ended. At ah's start, a session
 * found gone went down while ah was away: a host that booted since ah last ticked
 * restarted under it; a tmux server with another pid replaced the one it ran in.
 */
export function causeOf(o: { startup: boolean; last: Runtime | null; server: ServerSeen; bootAt: number; lastStatus: string; lastActivityAt: number }): InterruptCause | null {
  if (o.startup) {
    if (o.bootAt > (o.last?.at ?? o.lastActivityAt)) return 'host_restart';
    if (o.last?.pid && o.last.pid !== o.server.pid) return 'tmux_server';
  } else if (o.server.gone || (o.last?.pid && o.server.pid && o.server.pid !== o.last.pid)) return 'tmux_server';
  return mid(o.lastStatus) ? 'window' : null;
}

const WHY: Record<InterruptCause, string> = {
  tmux_server: 'the tmux server it ran in stopped',
  host_restart: 'the host restarted',
  window: 'its window was closed',
};

const ALERT: Record<InterruptCause, string> = { tmux_server: 'The tmux server stopped', host_restart: 'The host restarted', window: 'Its window was closed' };

/** One line for a Lock Screen or a notification: what cut it off. */
export const shortWhy = (i: Pick<Interrupted, 'cause'>) => `${ALERT[i.cause]}. Restore it in ah.`;

/** "Sat Nov 14 2026 15:38:05 GMT+0200": unambiguous for the agent, in the host's zone. */
const when = (t: number) => new Date(t * 1000).toString().replace(/ \(.*\)$/, '');

/** The message a mid-turn session gets first when it's restored. */
export function noteFor(i: Interrupted, step: string | null): string {
  const at = i.at - i.lastSeenAt > 10 ? `between ${when(i.lastSeenAt)} and ${when(i.at)}` : `at ${when(i.at)}`;
  return (
    `[ah] This session was interrupted ${at}: ${WHY[i.cause]} while you were ${i.lastStatus === 'waiting' ? 'waiting for an answer' : 'working'}, and ah has restarted you in the same conversation.` +
    (step ? ` The last step recorded: ${step}.` : '') +
    ' Check the state of whatever you were in the middle of (files being edited, commands or servers that were running) before you carry on from where you stopped.' +
    (i.lastStatus === 'waiting' ? ' If you still need the answer, ask again.' : '')
  );
}

const ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'input'];
const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, ' ').replace(/[`"]/g, "'").trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};

/** The step an assistant entry records: a tool call with its main argument, else the start of its text. */
export function stepOf(e: Entry): string | null {
  const calls = e.parts.filter((p) => p.type === 'tool_call');
  const call = calls.at(-1);
  if (call && call.type === 'tool_call') {
    const key = ARG_KEYS.find((k) => typeof call.call.args[k] === 'string' && call.call.args[k]);
    return `you called ${oneLine(call.call.name, 40)}${key ? ` ("${oneLine(String(call.call.args[key]), 120)}")` : ''}`;
  }
  const text = e.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').trim();
  return text ? `you wrote "${oneLine(text, 160)}"` : null;
}

const TAIL = 256 * 1024;

/** The last step in a transcript's tail (line adapters only), or null. */
export async function lastStep(file: string, adapter: string): Promise<string | null> {
  const parse = ADAPTERS[adapter] as Adapter | undefined;
  const s = parse ? await stat(file).catch(() => null) : null;
  if (!parse || !s) return null;
  const from = Math.max(0, s.size - TAIL);
  const fh = await open(file, 'r');
  let text: string;
  try {
    const buf = Buffer.alloc(s.size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    text = buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let d: unknown;
    try {
      d = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const e = parse(d, i);
    if (e?.role !== 'assistant') continue;
    const step = stepOf(e);
    if (step) return step;
  }
  return null;
}

export type InterruptionDeps = {
  record: (uid: string) => SessionRecord | undefined;
  records: () => SessionRecord[];
  setMeta: (uid: string, key: string, value: unknown) => void;
  server: () => ServerSeen;
  /** When the host booted (epoch seconds). */
  bootAt?: () => number;
  /** Where ah keeps what it last knew of its tmux server. */
  file: string;
  queue: { items: (uid: string) => QueueItem[]; first: (uid: string, item: QueueItem) => void; clear: (uid: string, id: string) => void };
  resume: (uid: string) => Promise<{ uid: string; windowId: string; resumed: boolean }>;
  transcript: (uid: string) => Promise<{ file: string; adapter: string } | null>;
  /** Recovery (server/recovery) stops waiting on a session you brought back. */
  settle: (uid: string, why: string) => Promise<void>;
  alert: (p: { title: string; body: string; tag: string; url: string }) => void;
  changed: () => void;
  /** Each incident once it's told (server/revive.ts brings back what it can). */
  noticed?: (incident: { id: string; cause: InterruptCause; count: number; midTurn: number }) => void;
  /** Whether ah brings this cause's sessions back by itself: the alert says so instead of asking you. */
  reviving?: (cause: InterruptCause) => boolean;
};

export type Restored = { uid: string; windowId: string; resumed: boolean; noted: boolean; midTurn: boolean };

export class Interruptions {
  private deps: InterruptionDeps;
  private last: Runtime | null;
  private startup = true;
  /** Interrupted this tick, told about once the tick is over (one alert per incident). */
  private fresh: Array<{ uid: string; i: Interrupted }> = [];
  private group: { cause: InterruptCause; at: number; id: string } | null = null;
  private restoring = new Map<string, Promise<Restored>>();

  constructor(deps: InterruptionDeps) {
    this.deps = deps;
    try {
      const r = JSON.parse(readFileSync(deps.file, 'utf8')) as Runtime;
      this.last = typeof r.pid === 'number' && typeof r.at === 'number' ? r : null;
    } catch {
      this.last = null;
    }
  }

  private bootAt(): number {
    return this.deps.bootAt?.() ?? Math.floor(Date.now() / 1000 - uptime());
  }

  /** registry.onEnd, inside its sweep: was this end an interruption? Recorded on the record itself. */
  ended(r: SessionRecord, lastStatus: string) {
    if (r.harness === 'shell' || !r.harnessId || r.meta['ah.endedBy'] === 'you' || r.meta['ah.movedTo']) return;
    const cause = causeOf({ startup: this.startup, last: this.last, server: this.deps.server(), bootAt: this.bootAt(), lastStatus, lastActivityAt: r.lastActivityAt });
    if (!cause) return;
    const t = now();
    // One incident per cause per sweep: the same server, the same restart.
    if (!this.group || this.group.cause !== cause || t - this.group.at > 3) this.group = { cause, at: t, id: `${cause}-${t}` };
    const lastSeenAt = this.startup ? Math.max(this.last?.at ?? 0, Math.min(r.lastActivityAt, t)) || t : t;
    const i: Interrupted = { cause, at: t, lastSeenAt, incident: this.group.id, lastStatus, midTurn: mid(lastStatus) };
    r.meta[INTERRUPTED] = i; // the sweep persists the record
    this.fresh.push({ uid: r.id, i });
  }

  /** After each tick: remember the server, tell you about what was interrupted. */
  tick() {
    this.startup = false;
    const s = this.deps.server();
    const t = now();
    if (!s.gone && s.pid && (s.pid !== this.last?.pid || t - this.last.at >= 60)) {
      this.last = { pid: s.pid, at: t };
      try {
        mkdirSync(dirname(this.deps.file), { recursive: true });
        writeFileSync(this.deps.file + '.tmp', JSON.stringify(this.last));
        renameSync(this.deps.file + '.tmp', this.deps.file);
      } catch (err) {
        console.error('interruptions: could not save the tmux server state:', (err as Error).message);
      }
    }
    if (!this.fresh.length) return;
    const by = new Map<string, Interrupted[]>();
    for (const f of this.fresh) by.set(f.i.incident, [...(by.get(f.i.incident) ?? []), f.i]);
    this.fresh = [];
    // Told to the reviver first: whether it brings them back (or has just stopped, tmux dying
    // again and again) is what the alert says.
    for (const [id, list] of by) this.deps.noticed?.({ id, cause: list[0].cause, count: list.length, midTurn: list.filter((i) => i.midTurn).length });
    for (const [id, list] of by) {
      const n = list.length;
      const working = list.filter((i) => i.midTurn).length;
      const what = n === 1 ? 'A session was interrupted' : `${n} sessions were interrupted`;
      console.warn(`interruptions: ${n} session(s) interrupted (${list[0].cause}), ${working} mid-turn`);
      const cause = list[0].cause === 'window' ? (n === 1 ? 'Its window was closed' : 'Their windows were closed') : ALERT[list[0].cause];
      const next = this.deps.reviving?.(list[0].cause) ? `ah is bringing ${n === 1 ? 'it' : 'them'} back` : `Restore ${n === 1 ? 'it' : 'them'} in ah`;
      this.deps.alert({ title: what, body: `${cause}${working ? `; ${working} ${working === 1 ? 'was' : 'were'} working` : ''}. ${next}.`, tag: `interrupted-${id}`, url: '/#interrupted' });
    }
    this.deps.changed();
  }

  list(): InterruptedSession[] {
    const out: InterruptedSession[] = [];
    for (const r of this.deps.records()) {
      const i = r.lifecycle === 'ended' ? interruptedOf(r) : null;
      if (i) out.push({ ...i, uid: r.id, title: r.title, harness: r.harness, cwd: r.cwd, queued: this.deps.queue.items(r.id).filter((q) => !q.id.startsWith('interrupted-')).length });
    }
    // Mid-turn first, then the newest.
    return out.sort((a, b) => Number(b.midTurn) - Number(a.midTurn) || b.at - a.at);
  }

  state(): InterruptionsState {
    const list = this.list();
    const incidents = new Map<string, Incident>();
    for (const s of list) {
      const x = incidents.get(s.incident) ?? { id: s.incident, cause: s.cause, at: s.at, count: 0, midTurn: 0 };
      x.count++;
      if (s.midTurn) x.midTurn++;
      incidents.set(s.incident, x);
    }
    return { count: list.length, midTurn: list.filter((s) => s.midTurn).length, incidents: [...incidents.values()].sort((a, b) => b.at - a.at) };
  }

  pending(uid: string): boolean {
    const r = this.deps.record(uid);
    return !!r && r.lifecycle === 'ended' && !!interruptedOf(r);
  }

  /**
   * Brings one back: a mid-turn one gets the note first (unless `note` is false), then
   * resumes; its queued prompts follow. `id` names the note in the queue (recovery's
   * attempt id). Concurrent calls for one session share one restore.
   */
  restore(uid: string, o: { note?: boolean; id?: string; by?: 'you' | 'recovery' | 'ah'; incident?: string } = {}): Promise<Restored> {
    const pending = this.restoring.get(uid);
    if (pending) return pending;
    const task = this.restoreOnce(uid, o).finally(() => this.restoring.delete(uid));
    this.restoring.set(uid, task);
    return task;
  }

  private async restoreOnce(uid: string, o: { note?: boolean; id?: string; by?: 'you' | 'recovery' | 'ah'; incident?: string }): Promise<Restored> {
    const r = this.deps.record(uid);
    if (!r) throw new InterruptionError(404, 'not_found', 'no such session');
    const i = interruptedOf(r);
    if (r.lifecycle !== 'ended') {
      const out = await this.deps.resume(uid);
      return { ...out, noted: false, midTurn: false };
    }
    if (!i) throw new InterruptionError(409, 'not_interrupted', 'this session ended normally; resume it instead');
    // ah bringing back one incident's sessions: one cut off since by something else (a window
    // closed) isn't that incident's to bring back.
    if (o.incident && i.incident !== o.incident) throw new InterruptionError(409, 'not_interrupted', 'it was interrupted again since, by something else');
    let noted = false;
    if (i.midTurn && o.note !== false) {
      const id = o.id ?? `interrupted-${i.at}`;
      if (!this.deps.queue.items(uid).some((q) => q.id === id)) {
        const t = await this.deps.transcript(uid).catch(() => null);
        const step = t ? await lastStep(t.file, t.adapter).catch(() => null) : null;
        this.stillInterrupted(uid, i);
        this.deps.queue.first(uid, { id, text: noteFor(i, step), enter: true, at: now() });
      }
      noted = true;
    }
    // Dismissed (or brought back some other way) while its note was being written: it stays so.
    this.stillInterrupted(uid, i);
    const out = await this.deps.resume(uid);
    if (o.by !== 'recovery') await this.deps.settle(uid, 'restored after an interruption').catch(() => {});
    this.deps.changed();
    return { ...out, noted, midTurn: i.midTurn };
  }

  private stillInterrupted(uid: string, i: Interrupted) {
    const r = this.deps.record(uid);
    const now = r?.lifecycle === 'ended' ? interruptedOf(r) : null;
    if (now?.incident !== i.incident || now.at !== i.at) throw new InterruptionError(409, 'not_interrupted', "it isn't interrupted any more (dismissed, or brought back already)");
  }

  /**
   * ah brought it back and its agent didn't start (its window has gone): interrupted again, as
   * it was, with why, for you to restore or dismiss.
   */
  notStarted(uid: string, was: Interrupted, error: string) {
    if (!this.deps.record(uid)) return;
    this.deps.setMeta(uid, INTERRUPTED, { ...was, failed: { at: now(), error: error.slice(0, 300) } });
    this.deps.changed();
  }

  /** Restores the ones named (all when none are), mid-turn first, one after another. */
  async restoreAll(o: { uids?: string[]; incident?: string; note?: boolean } = {}): Promise<{ restored: Restored[]; failed: Array<{ uid: string; error: string; code: string }> }> {
    const want = o.uids ? new Set(o.uids) : null;
    const list = this.list().filter((s) => (!want || want.has(s.uid)) && (!o.incident || s.incident === o.incident));
    const restored: Restored[] = [];
    const failed: Array<{ uid: string; error: string; code: string }> = [];
    for (const s of list) {
      try {
        restored.push(await this.restore(s.uid, { note: o.note, by: 'you' }));
      } catch (err) {
        failed.push({ uid: s.uid, error: (err as Error).message, code: (err as { code?: string }).code ?? 'restore_failed' });
      }
    }
    return { restored, failed };
  }

  /** ah's own attempt to bring it back failed: kept on its interruption, for you to restore or dismiss. */
  failed(uid: string, error: string) {
    const r = this.deps.record(uid);
    const i = r ? interruptedOf(r) : null;
    if (!i) return;
    this.deps.setMeta(uid, INTERRUPTED, { ...i, failed: { at: now(), error: error.slice(0, 300) } });
    this.deps.changed();
  }

  /** Forgets interruptions (and their unsent notes): they're ended, as if you'd ended them. */
  dismiss(o: { uids?: string[]; incident?: string } = {}): number {
    const want = o.uids ? new Set(o.uids) : null;
    let n = 0;
    for (const s of this.list()) {
      if ((want && !want.has(s.uid)) || (o.incident && s.incident !== o.incident)) continue;
      for (const q of this.deps.queue.items(s.uid)) if (q.id === `interrupted-${s.at}`) this.deps.queue.clear(s.uid, q.id);
      this.deps.setMeta(s.uid, INTERRUPTED, undefined);
      n++;
    }
    if (n) this.deps.changed();
    return n;
  }
}
