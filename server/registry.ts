// Durable record of every agent session, kept beside tmux rather than in it.
// tmux forgets everything when its server dies (reboot, crash); this file is
// what lets a dead session be resumed with the harness's native resume command.
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type SessionRecord = {
  uid: string;
  host: string;
  tmuxSession: string;
  windowId: string;
  name: string;
  cwd: string;
  /** Preset id of the agent (claude, codex, …). */
  harness: string;
  /** The harness's own session/thread id, reported by hooks. Enables exact resume. */
  harnessId?: string;
  model?: string;
  status: string;
  createdAt: number;
  lastAliveAt: number;
  endedAt?: number;
};

const FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'sessions.json');
const KEEP_ENDED_SECONDS = 30 * 24 * 3600;

export class Registry {
  private records = new Map<string, SessionRecord>();
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor() {
    if (existsSync(FILE)) {
      try {
        for (const r of JSON.parse(readFileSync(FILE, 'utf8')) as SessionRecord[]) this.records.set(r.uid, r);
      } catch (err) {
        console.error(`ignoring unreadable registry ${FILE}:`, err);
      }
    }
  }

  static newId(): string {
    return randomUUID().slice(0, 8);
  }

  get(uid: string): SessionRecord | undefined {
    return this.records.get(uid);
  }

  upsert(uid: string, fields: Omit<SessionRecord, 'uid' | 'host' | 'createdAt' | 'lastAliveAt'> & { createdAt?: number }) {
    const now = Math.floor(Date.now() / 1000);
    const prev = this.records.get(uid);
    const next = {
      ...fields,
      ...prev,
      ...stripEmpty(fields),
      uid,
      host: hostname(),
      createdAt: prev?.createdAt ?? fields.createdAt ?? now,
      lastAliveAt: now,
      endedAt: undefined,
    } as SessionRecord;
    // lastAliveAt changes every poll; only persist it when something else changed or it's stale.
    const meaningful = !prev || prev.endedAt || keyFields(prev) !== keyFields(next) || now - prev.lastAliveAt > 60;
    this.records.set(uid, meaningful ? next : { ...next, lastAliveAt: prev.lastAliveAt });
    if (meaningful) this.dirty = true;
  }

  /** Marks every live record not in `alive` as ended. */
  reconcile(alive: Set<string>) {
    const now = Math.floor(Date.now() / 1000);
    for (const r of this.records.values()) {
      if (!r.endedAt && r.host === hostname() && !alive.has(r.uid)) {
        r.endedAt = now;
        r.status = 'ended';
        this.dirty = true;
      }
      if (r.endedAt && now - r.endedAt > KEEP_ENDED_SECONDS) {
        this.records.delete(r.uid);
        this.dirty = true;
      }
    }
    this.flush();
  }

  remove(uid: string) {
    if (this.records.delete(uid)) {
      this.dirty = true;
      this.flush();
    }
  }

  ended(): SessionRecord[] {
    return [...this.records.values()].filter((r) => r.endedAt).sort((a, b) => b.endedAt! - a.endedAt!);
  }

  private flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = JSON.stringify([...this.records.values()], null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
      const tmp = `${FILE}.tmp`;
      await writeFile(tmp, data, { mode: 0o600 });
      await rename(tmp, FILE);
    }).catch((err) => console.error('registry write failed:', err));
  }
}

function keyFields(r: SessionRecord): string {
  // status is deliberately excluded: it flips every few seconds and isn't worth a disk write.
  return JSON.stringify([r.tmuxSession, r.windowId, r.name, r.cwd, r.harness, r.harnessId, r.model]);
}

function stripEmpty<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v !== undefined)) as Partial<T>;
}
