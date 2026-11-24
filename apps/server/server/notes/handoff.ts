// Handing a note to an agent session (docs/spec/15-scratchpads.md, SCR-6): its text goes
// through the same send as a typed message (core.send: typed in when the agent is idle,
// queued while it works, resumed first when it has ended), never straight into tmux.
//
// The device names each hand-off (`id`) and a retry names it again. The row is written
// before anything is sent, so a retry after a lost answer, or after this process died
// mid-send, is answered from what happened rather than sent twice: delivered or queued
// as it was; still in the target's queue (the queue item's id is the hand-off's); or, when
// that can't be known, `uncertain`, which is sent again only when the device asks.
//
// A send that fails is `failed` (safe to send again) only when nothing reached the target.
// One that may have typed some of the text, or queued it where a restart could lose it, is
// `uncertain`: sending it again could deliver it twice.
import { createHash } from 'node:crypto';
import type { PrismaClient, NoteHandoff } from '@prisma/client';
import { NoteError, noteId } from './store.ts';

export type HandoffOutcome = 'delivered' | 'queued' | 'uncertain';

export type HandoffView = {
  id: string;
  noteId: string;
  revision: number;
  target: string;
  outcome: HandoffOutcome | 'failed';
  queueId: string | null;
  resumed: boolean;
  error: string | null;
  /** True when this answer is for an earlier request with the same id: nothing was sent now. */
  replay: boolean;
  at: number;
};

export type HandoffDeps = {
  send: (target: string, text: string, id: string, actorUid?: string | null) => Promise<{ outcome: 'delivered' | 'queued'; resumed: boolean; queueId?: string }>;
  /** The session a ref names now (a uid, or `harness:harnessId` for an ended one). */
  resolve: (ref: string) => Promise<string | null>;
  queueIds: (uid: string) => string[];
};

/**
 * Thrown by `send` when the text may have reached the target even though the send didn't
 * finish (typed, or queued but not yet kept on disk). The hand-off is then `uncertain`.
 */
export class MaybeArrived extends Error {}

/** Whether a send's error leaves the text possibly delivered (a paste that typed some of it). */
export function mayHaveArrived(err: unknown): boolean {
  return err instanceof MaybeArrived || (!!err && typeof err === 'object' && (err as { typed?: unknown }).typed === true);
}

export const MAX_HANDOFF_TEXT = 32 * 1024;
const ID = /^[\w-]{8,40}$/;

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

export class Handoffs {
  private db: PrismaClient;
  private deps: HandoffDeps;
  private locks = new Map<string, Promise<unknown>>();

  constructor(db: PrismaClient, deps: HandoffDeps) {
    this.db = db;
    this.deps = deps;
  }

  async get(id: string): Promise<HandoffView> {
    const row = await this.db.noteHandoff.findUnique({ where: { id } });
    if (!row) throw new NoteError(404, 'handoff_not_found', 'no such hand-off');
    return view(row, true);
  }

  /** One request per hand-off id at a time: a concurrent retry waits, then reads what the first did. */
  hand(o: { id: string; noteId: string; revision: number; target: string; text: string; resend?: boolean; actorUid?: string | null }): Promise<HandoffView> {
    const prior = this.locks.get(o.id) ?? Promise.resolve();
    const task = prior.catch(() => {}).then(() => this.handOnce(o));
    this.locks.set(o.id, task);
    return task.finally(() => {
      if (this.locks.get(o.id) === task) this.locks.delete(o.id);
    });
  }

  private async handOnce(o: { id: string; noteId: string; revision: number; target: string; text: string; resend?: boolean; actorUid?: string | null }): Promise<HandoffView> {
    if (!ID.test(o.id)) throw new NoteError(400, 'invalid_handoff_id', 'id: 8-40 letters, digits, - or _');
    const nid = noteId(o.noteId);
    if (!o.text.trim()) throw new NoteError(400, 'empty_note', 'the note is empty');
    if (o.text.length > MAX_HANDOFF_TEXT) throw new NoteError(413, 'handoff_too_long', `a message is at most ${MAX_HANDOFF_TEXT} characters; attach the note as a file instead`);
    const textSha = sha(o.text);
    const row = await this.db.noteHandoff.findUnique({ where: { id: o.id } });
    if (row) {
      if (row.target !== o.target || row.textSha !== textSha) throw new NoteError(409, 'handoff_mismatch', 'that hand-off id was used for another message');
      if (row.state === 'delivered' || row.state === 'queued') return view(row, true);
      if (row.state === 'sending') {
        // Nothing in this process is sending it (requests for one id run one at a time):
        // a process died mid-send. Still waiting in the queue means it was queued;
        // otherwise nobody can say.
        const uid = await this.deps.resolve(row.target).catch(() => null);
        if (uid && this.deps.queueIds(uid).includes(row.id)) return view(await this.settle(row.id, { state: 'queued', queueId: row.id }), true);
        const marked = await this.settle(row.id, { state: 'uncertain' });
        if (!o.resend) return view(marked, true);
      }
      if (row.state === 'uncertain' && !o.resend) return view(row, true);
      // failed (nothing typed), or uncertain and asked again: send now under the same id.
    } else {
      const at = Math.floor(Date.now() / 1000);
      await this.db.noteHandoff.create({ data: { id: o.id, noteId: nid, revision: o.revision, target: o.target, textSha, state: 'sending', createdAt: at, updatedAt: at } });
    }
    return this.deliver(o.id, o.target, o.text, o.actorUid);
  }

  private async deliver(id: string, target: string, text: string, actorUid?: string | null): Promise<HandoffView> {
    await this.settle(id, { state: 'sending', error: null });
    let out: Awaited<ReturnType<HandoffDeps['send']>>;
    try {
      out = await this.deps.send(target, text, id, actorUid);
    } catch (err) {
      const error = ((err as Error)?.message ?? String(err)).slice(0, 500);
      if (mayHaveArrived(err)) return view(await this.settle(id, { state: 'uncertain', error }), false);
      await this.settle(id, { state: 'failed', error });
      throw err;
    }
    // Sent: if this can't be written down, the row stays `sending`, which a retry reads as
    // queued (still in the queue) or uncertain, never as failed and safe to send again.
    return view(await this.settle(id, { state: out.outcome, queueId: out.queueId ?? null, resumed: out.resumed }), false);
  }

  private settle(id: string, data: Partial<Pick<NoteHandoff, 'state' | 'queueId' | 'resumed' | 'error'>>): Promise<NoteHandoff> {
    return this.db.noteHandoff.update({ where: { id }, data: { ...data, updatedAt: Math.floor(Date.now() / 1000) } });
  }
}

function view(row: NoteHandoff, replay: boolean): HandoffView {
  return {
    id: row.id,
    noteId: row.noteId,
    revision: row.revision,
    target: row.target,
    outcome: row.state === 'sending' ? 'uncertain' : (row.state as HandoffView['outcome']),
    queueId: row.queueId,
    resumed: row.resumed,
    error: row.error,
    replay,
    at: row.updatedAt,
  };
}
