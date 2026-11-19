// Reads what the harnesses keep about subagents, cheaply and safely enough to run on
// every pass for every live session:
// - nothing is read twice: a file's facts are kept by its size and mtime, a parent
//   transcript is read on from where the last read ended;
// - nothing is read whole: a child's start and end are read in bounded slices;
// - no path comes from a client or from what a harness wrote: a Claude child's file is
//   `<root transcript>/../<session>/subagents/agent-<id>.jsonl` with a validated id, a
//   Codex child's is the rollout discovery found, and symlinks are never followed.
import { lstat, open, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import type { Transcript } from '../discovery.ts';
import { outcomesOf, parseMeta, firstPrompt, tailFacts, type ClaudeMeta } from './claude.ts';
import { codexTail } from './codex.ts';
import { isAgentId, isSessionId, type ClaudeOutcome, type CodexTurn, type TailFacts } from './model.ts';

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 64 * 1024;
const CHUNK = 4 * 1024 * 1024;
/** A folder with more children than this is read up to it (newest first). */
export const MAX_CHILDREN = 500;

const CHILD = /^agent-([A-Za-z0-9_-]{1,48})\.jsonl$/;

type Sig = string;
const sigOf = (s: { size: number; mtimeMs: number }) => `${s.size}:${s.mtimeMs}`;

/** A regular file (not a link, not a folder), with its signature. */
async function plain(file: string) {
  const s = await lstat(file).catch(() => null);
  return s?.isFile() ? s : null;
}

async function readSlice(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

/** Whole lines from the first `HEAD_BYTES`. */
async function headLines(file: string, size: number): Promise<string[]> {
  const text = await readSlice(file, 0, Math.min(size, HEAD_BYTES));
  const lines = text.split('\n');
  if (size > HEAD_BYTES) lines.pop(); // cut mid-line
  return lines.filter((l) => l.trim());
}

/** Whole lines from the last `TAIL_BYTES`. */
async function tailLines(file: string, size: number): Promise<string[]> {
  const start = Math.max(0, size - TAIL_BYTES);
  const lines = (await readSlice(file, start, size - start)).split('\n');
  if (start > 0) lines.shift();
  return lines.filter((l) => l.trim());
}

/** A parent transcript read on from where it was left: the outcomes it recorded, by call and by agent. */
class OutcomeReader {
  offset = 0;
  rest = '';
  ino = 0;
  byCall = new Map<string, ClaudeOutcome[]>();
  byAgent = new Map<string, ClaudeOutcome[]>();

  async update(file: string, calls: ReadonlySet<string>) {
    const s = await plain(file);
    if (!s) return;
    if ((this.ino && s.ino !== this.ino) || s.size < this.offset) {
      // Rewritten: read again from the start.
      this.offset = 0;
      this.rest = '';
      this.byCall.clear();
      this.byAgent.clear();
    }
    this.ino = s.ino;
    while (this.offset < s.size) {
      const length = Math.min(CHUNK, s.size - this.offset);
      const fh = await open(file, 'r');
      let chunk: Buffer;
      try {
        chunk = Buffer.alloc(length);
        const { bytesRead } = await fh.read(chunk, 0, length, this.offset);
        chunk = chunk.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
      if (!chunk.length) break;
      this.offset += chunk.length;
      // Split at the last newline in bytes, so a character across chunks stays whole.
      const nl = chunk.lastIndexOf(0x0a);
      const whole = this.rest + chunk.subarray(0, nl + 1).toString('utf8');
      this.rest = nl + 1 < chunk.length ? chunk.subarray(nl + 1).toString('utf8') : '';
      if (nl < 0) {
        this.rest = whole + this.rest;
        continue;
      }
      for (const text of whole.split('\n')) {
        if (!text) continue;
        for (const o of outcomesOf(text, calls)) {
          const map = o.toolUseId ? this.byCall : this.byAgent;
          const key = (o.toolUseId ?? o.agentId)!;
          const list = map.get(key) ?? [];
          list.push(o.outcome);
          map.set(key, list.slice(-4)); // a continued child can be told several times; the newest matter
        }
      }
    }
  }
}

export type ClaudeChild = {
  agentId: string;
  file: string;
  meta: ClaudeMeta;
  prompt: string | null;
  tail: TailFacts | null;
  birthAt: number;
  outcomes: ClaudeOutcome[];
};

export type CodexChild = { transcript: Transcript; last: CodexTurn | null; tail: TailFacts | null; prompt: string | null };

/**
 * The folder is where it's named, under the root transcript's own folder: a session folder
 * that is a link elsewhere is never read through.
 */
async function within(dir: string, rootFile: string): Promise<boolean> {
  const [real, base] = await Promise.all([realpath(dir).catch(() => null), realpath(dirname(rootFile)).catch(() => null)]);
  return !!real && !!base && real === join(base, basename(dirname(dir)), basename(dir)) && real.startsWith(base + sep);
}

/** The subagents folder of a Claude root transcript, or null when the name isn't a session's. */
export function claudeFolder(rootFile: string): string | null {
  const name = basename(rootFile);
  if (!name.endsWith('.jsonl') || !isSessionId(name.slice(0, -6))) return null;
  return join(dirname(rootFile), name.slice(0, -6), 'subagents');
}

/** A Claude child's transcript, under a root transcript discovery found. */
export function claudeChildFile(rootFile: string, agentId: string): string | null {
  const dir = claudeFolder(rootFile);
  return dir && isAgentId(agentId) ? join(dir, `agent-${agentId}.jsonl`) : null;
}

export class SubagentStore {
  private files = new Map<string, { sig: Sig; meta?: ClaudeMeta | null; prompt?: string | null; tail?: TailFacts | null; last?: CodexTurn | null }>();
  private readers = new Map<string, OutcomeReader>();

  /** A Claude root's children, each with what's known of it. Null: it has no subagents folder. */
  async claude(rootFile: string): Promise<ClaudeChild[] | null> {
    this.bound();
    const dir = claudeFolder(rootFile);
    if (!dir) return null;
    const d = await lstat(dir).catch(() => null);
    if (!d?.isDirectory() || !(await within(dir, rootFile))) return null;
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => CHILD.test(n));
    const found: (ClaudeChild & { size: number; bornMs: number })[] = [];
    for (const name of names) {
      const agentId = CHILD.exec(name)![1];
      const file = join(dir, name);
      const s = await plain(file);
      if (!s) continue;
      const known = this.files.get(file);
      const sig = sigOf(s);
      let meta = known?.meta;
      let prompt = known?.prompt;
      let tail = known?.tail;
      if (known?.sig !== sig || meta === undefined) {
        // The sidecar is written once, at spawn; read again only while it's missing.
        if (!meta) {
          const sm = await plain(join(dir, `agent-${agentId}.meta.json`));
          meta = sm && sm.size < 64 * 1024 ? parseMeta(await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf8').catch(() => '')) : null;
        }
        if (!prompt) prompt = firstPrompt(await headLines(file, s.size).catch(() => []));
        tail = tailFacts(await tailLines(file, s.size).catch(() => []));
        this.files.set(file, { sig, meta, prompt, tail });
      }
      found.push({
        agentId,
        file,
        meta: meta ?? { agentType: null, description: null, toolUseId: null, parentAgentId: null, depth: 1, background: false },
        prompt: prompt ?? null,
        tail: tail ?? null,
        birthAt: Math.floor((s.birthtimeMs || s.ctimeMs) / 1000),
        outcomes: [],
        size: s.size,
        bornMs: s.birthtimeMs || s.ctimeMs,
      });
    }
    // The newest when there are too many; then in the order they were born, to the millisecond.
    found.sort((a, b) => b.bornMs - a.bornMs);
    const kids = found.slice(0, MAX_CHILDREN).sort((a, b) => a.bornMs - b.bornMs);
    // Each parent transcript (the root's, or a child's that spawned children) read on for outcomes.
    const byParent = new Map<string, ClaudeChild[]>();
    for (const k of kids) {
      const parent = k.meta.parentAgentId && kids.some((x) => x.agentId === k.meta.parentAgentId) ? join(dir, `agent-${k.meta.parentAgentId}.jsonl`) : rootFile;
      (byParent.get(parent) ?? byParent.set(parent, []).get(parent)!).push(k);
    }
    for (const [file, list] of byParent) {
      const reader = this.readers.get(file) ?? new OutcomeReader();
      this.readers.set(file, reader);
      await reader.update(file, new Set(list.map((k) => k.meta.toolUseId).filter((x): x is string => !!x))).catch(() => {});
      for (const k of list) {
        k.outcomes = [...(k.meta.toolUseId ? (reader.byCall.get(k.meta.toolUseId) ?? []) : []), ...(reader.byAgent.get(k.agentId) ?? [])];
      }
    }
    return kids.map(({ size: _size, bornMs: _born, ...k }) => k);
  }

  /** What the end of a Codex child's rollout says, by its size and mtime. */
  async codex(t: Transcript): Promise<CodexChild | null> {
    this.bound();
    const s = await plain(t.file);
    if (!s) return null;
    const known = this.files.get(t.file);
    const sig = sigOf(s);
    if (known?.sig === sig) return { transcript: t, last: known.last ?? null, tail: known.tail ?? null, prompt: known.prompt ?? null };
    const { last, tail } = codexTail(await tailLines(t.file, s.size).catch(() => []));
    // A v2 thread's first prompt is its parent's (copied history): its nickname says more.
    const prompt = t.spawned?.historyStart ? null : t.title;
    this.files.set(t.file, { sig, last, tail, prompt });
    return { transcript: t, last, tail, prompt };
  }

  /** Whether a child's transcript is there, as a regular file, in a folder that isn't a link elsewhere. */
  async exists(file: string, rootFile: string): Promise<boolean> {
    return !!(await plain(file)) && (await within(dirname(file), rootFile));
  }

  /** Bounded: past a few thousand files (or hundreds of parents) everything is read afresh, once. */
  private bound() {
    if (this.files.size > 4000) this.files.clear();
    if (this.readers.size > 400) this.readers.clear();
  }
}
