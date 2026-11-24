// What you picked on an agent's prompt through ah ("Yes, and always allow in this
// conversation for commands that start with 'gh'"), by the transcript it went into.
// An agent records that it asked and that the tool ran, not which row you chose: ah
// typed that row, so ah remembers it, and the agent's feed reads it back in place
// (server/feed/adapters/agy.ts). A row picked in the terminal itself isn't here.
//
// Kept beside ah's other state, so a restart doesn't forget it: the last 100 per
// transcript, for 30 days.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type Picked = { at: number; label: string };

const KEEP = 100;
const DAYS = 30;

export class PickedStore {
  private byFile: Map<string, Picked[]> | null = null;
  private readonly file: string | null;

  constructor(file: string | null = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'picked.json')) {
    this.file = file;
  }

  /** Row `label` was picked at `at` (ms) on a prompt in `transcript`. */
  remember(transcript: string, label: string, at = Date.now()): void {
    const all = this.load();
    const list = [...(all.get(transcript) ?? []), { at, label: label.slice(0, 500) }].slice(-KEEP);
    all.set(transcript, list);
    const since = at - DAYS * 86_400_000;
    for (const [k, v] of all) {
      const kept = v.filter((p) => p.at >= since);
      if (kept.length) all.set(k, kept);
      else all.delete(k);
    }
    this.save(all);
  }

  /** What was picked in `transcript`, oldest first. */
  for(transcript: string): Picked[] {
    return this.load().get(transcript) ?? [];
  }

  private load(): Map<string, Picked[]> {
    if (this.byFile) return this.byFile;
    this.byFile = new Map();
    if (!this.file) return this.byFile;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) {
        if (!Array.isArray(v)) continue;
        const list = v.filter((p): p is Picked => typeof p?.at === 'number' && typeof p?.label === 'string');
        if (list.length) this.byFile.set(k, list);
      }
    } catch {}
    return this.byFile;
  }

  private save(all: Map<string, Picked[]>): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(Object.fromEntries(all)), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error('picked: could not save:', (err as Error).message);
    }
  }
}

/** The host's store; tests make their own. */
export const picked = new PickedStore();
