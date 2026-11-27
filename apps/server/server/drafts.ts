// Unsent composer text, per session, kept on the host: start a message on the
// phone and finish it at the desk, or reload without losing it. Drafts change
// at typing speed, so they live in memory with a debounced owner-only file,
// not in the session registry (which rewrites every record per flush).
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { MESSAGE_MAX } from './http.ts';

/**
 * A chip the draft's box held over its words (a quoted reply, a reused prompt, a long paste),
 * in order: the text begins with what each sends, so a client that draws chips can put them
 * back, and one that doesn't still has the whole message (`draftParts`).
 */
export type DraftPart = { kind: 'quote' | 'reuse' | 'paste'; body: string; source?: string };
export type Draft = { text: string; at: number; device: string; client: string; parts?: DraftPart[] };

const PART_KINDS = new Set(['quote', 'reuse', 'paste']);
const PARTS_MAX = 20;

/** A PUT's `parts`, kept only as far as they make sense: none at all is no `parts`. */
export function draftParts(raw: unknown): DraftPart[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts: DraftPart[] = [];
  for (const part of raw.slice(0, PARTS_MAX)) {
    if (!part || typeof part !== 'object') continue;
    const { kind, body, source } = part as Record<string, unknown>;
    if (typeof kind !== 'string' || !PART_KINDS.has(kind) || typeof body !== 'string' || !body.trim()) continue;
    parts.push({ kind: kind as DraftPart['kind'], body: body.slice(0, MESSAGE_MAX), ...(typeof source === 'string' && source.trim() ? { source: source.slice(0, 80) } : {}) });
  }
  return parts.length ? parts : undefined;
}

const FILE = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'ah', 'drafts.json');
/** A draft nobody touched for this long is dropped at start. */
const KEEP_MS = 14 * 86400_000;

export class Drafts {
  private map = new Map<string, Draft>();
  private timer: NodeJS.Timeout | null = null;
  private file: string;

  constructor(file = FILE) {
    this.file = file;
    try {
      if (existsSync(file)) {
        const rows = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Draft>;
        const cutoff = Date.now() - KEEP_MS;
        for (const [uid, d] of Object.entries(rows)) if (d && typeof d.text === 'string' && d.at > cutoff) this.map.set(uid, d);
      }
    } catch {}
  }

  get(uid: string): Draft | null {
    return this.map.get(uid) ?? null;
  }

  /** Blank text clears the draft. Saved without `parts` (a client with no chips), it has none. */
  set(uid: string, text: string, device: string, client: string, parts?: DraftPart[]): Draft | null {
    if (!text.trim()) this.map.delete(uid);
    else this.map.set(uid, { text: text.slice(0, MESSAGE_MAX), at: Date.now(), device: device.replace(/[^\w .-]/g, '').slice(0, 24) || 'browser', client: client.slice(0, 40), ...(parts ? { parts } : {}) });
    this.schedule();
    return this.get(uid);
  }

  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, 2000);
    this.timer.unref?.();
  }

  /** Written at once on shutdown; otherwise two seconds after the last change. */
  async save() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 });
    } catch (err) {
      console.error(`writing ${this.file} failed:`, err);
    }
  }
}
