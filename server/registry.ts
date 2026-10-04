// Durable record of every session this host has run, kept beside tmux rather
// than in it. tmux forgets everything when its server dies (reboot, crash);
// this file is what lets a session be found and resumed from any device later.
import { readFileSync, existsSync, renameSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** "Saved" (history only) is not a registry state: those come from transcript discovery. */
export type Lifecycle = 'starting' | 'live' | 'ended' | 'unavailable';

export type SessionRecord = {
  id: string;
  host: string;
  /** Preset id (claude, codex, shell, …). */
  harness: string;
  /** The harness's own conversation id (from hooks or discovery). Enables exact resume. */
  harnessId?: string;
  cwd: string;
  model?: string;
  title: string;
  status: string;
  lifecycle: Lifecycle;
  /** Orthogonal to lifecycle: a resume was requested and hasn't come up yet. */
  pendingResume?: boolean;
  createdAt: number;
  lastActivityAt: number;
  endedAt?: number;
  exitCode: number | null;
  tmux?: { session: string; windowId: string };
  /** Free-form extras. Our own keys are namespaced `ah.*` so other producers can coexist. */
  meta: Record<string, unknown>;
};

type Tmux = { session: string; windowId: string };

const FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'sessions.json');
const KEEP_ENDED_SECONDS = 30 * 24 * 3600;
const now = () => Math.floor(Date.now() / 1000);

export class Registry {
  private records = new Map<string, SessionRecord>();
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  constructor() {
    if (!existsSync(FILE)) return;
    try {
      for (const raw of JSON.parse(readFileSync(FILE, 'utf8'))) {
        const r = migrate(raw);
        this.records.set(r.id, r);
      }
    } catch (err) {
      // Keep the evidence instead of overwriting it on the next save; tmux still has the live sessions.
      const aside = `${FILE}.corrupt-${Date.now()}`;
      try {
        renameSync(FILE, aside);
      } catch {}
      console.error(`registry ${FILE} was unreadable (${(err as Error).message}); moved it to ${aside} and starting fresh`);
      this.records.clear();
    }
  }

  static newId(): string {
    return randomUUID().slice(0, 8);
  }

  get(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  all(): SessionRecord[] {
    return [...this.records.values()];
  }

  /** Creates or refreshes the record of a running window. */
  live(id: string, f: { harness: string; harnessId?: string; cwd: string; model?: string; title: string; status: string; tmux: Tmux; activity: number; createdAt?: number }) {
    const prev = this.records.get(id);
    const next: SessionRecord = {
      id,
      host: hostname(),
      harness: f.harness,
      harnessId: f.harnessId || prev?.harnessId,
      cwd: f.cwd,
      model: f.model || prev?.model,
      title: f.title,
      status: f.status,
      lifecycle: 'live',
      pendingResume: false,
      createdAt: prev?.createdAt ?? f.createdAt ?? now(),
      lastActivityAt: Math.max(f.activity, prev?.lastActivityAt ?? 0),
      exitCode: null,
      tmux: f.tmux,
      meta: prev?.meta ?? {},
    };
    this.records.set(id, next);
    // status/activity change constantly: persist them only alongside a real change, or once a minute.
    if (!prev || prev.lifecycle !== 'live' || key(prev) !== key(next) || next.lastActivityAt - prev.lastActivityAt > 60) {
      this.dirty = true;
    }
  }

  starting(id: string, f: { harness: string; harnessId?: string; cwd: string; title: string; tmux: Tmux; pendingResume?: boolean; meta?: Record<string, unknown> }) {
    const prev = this.records.get(id);
    this.records.set(id, {
      id,
      host: hostname(),
      harness: f.harness,
      harnessId: f.harnessId ?? prev?.harnessId,
      cwd: f.cwd,
      model: prev?.model,
      title: f.title,
      status: 'busy',
      lifecycle: 'starting',
      pendingResume: f.pendingResume ?? false,
      createdAt: prev?.createdAt ?? now(),
      lastActivityAt: now(),
      exitCode: null,
      tmux: f.tmux,
      meta: { ...prev?.meta, ...f.meta },
    });
    this.dirty = true;
    this.flush();
  }

  /** Records a conversation id learned from discovery rather than hooks. */
  adopt(id: string, harnessId: string, model?: string) {
    const r = this.records.get(id);
    if (!r || r.harnessId) return;
    r.harnessId = harnessId;
    r.model ??= model;
    this.dirty = true;
    this.flush();
  }

  setMeta(id: string, key: string, value: unknown) {
    const r = this.records.get(id);
    if (!r) return;
    if (value === undefined) delete r.meta[key];
    else r.meta[key] = value;
    this.dirty = true;
    this.flush();
  }

  /** Marks running records that are no longer in tmux as ended. Starting ones get a grace period. */
  reconcile(alive: Set<string>) {
    const t = now();
    for (const r of this.records.values()) {
      const running = r.lifecycle === 'live' || r.lifecycle === 'starting';
      const grace = r.lifecycle === 'starting' && t - r.lastActivityAt < 10;
      if (running && r.host === hostname() && !alive.has(r.id) && !grace) {
        r.lifecycle = 'ended';
        r.status = 'ended';
        r.endedAt = t;
        r.pendingResume = false;
        this.dirty = true;
      }
      if (r.endedAt && t - r.endedAt > KEEP_ENDED_SECONDS && !r.meta['ah.pinned']) {
        this.records.delete(r.id);
        this.dirty = true;
      }
    }
    this.flush();
  }

  remove(id: string) {
    if (this.records.delete(id)) {
      this.dirty = true;
      this.flush();
    }
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    const data = JSON.stringify([...this.records.values()], null, 2);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dirname(FILE), { recursive: true, mode: 0o700 });
        const tmp = `${FILE}.tmp`;
        await writeFile(tmp, data, { mode: 0o600 });
        await rename(tmp, FILE);
      })
      .catch((err) => console.error('registry write failed:', err));
  }
}

function key(r: SessionRecord): string {
  return JSON.stringify([r.harness, r.harnessId, r.cwd, r.model, r.title, r.tmux]);
}

// v1 records (uid/name/tmuxSession/windowId/lastAliveAt) → v2.
function migrate(r: Record<string, any>): SessionRecord {
  if (r.id && r.lifecycle) return { meta: {}, exitCode: null, ...r } as SessionRecord;
  return {
    id: r.uid,
    host: r.host,
    harness: r.harness,
    harnessId: r.harnessId,
    cwd: r.cwd,
    model: r.model,
    title: r.name ?? '',
    status: r.status ?? 'idle',
    lifecycle: r.endedAt ? 'ended' : 'live',
    createdAt: r.createdAt,
    lastActivityAt: r.lastAliveAt ?? r.createdAt,
    endedAt: r.endedAt,
    exitCode: null,
    tmux: r.tmuxSession ? { session: r.tmuxSession, windowId: r.windowId } : undefined,
    meta: {},
  };
}
