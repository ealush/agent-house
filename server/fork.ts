// Session forking (F36): the transcript half. A fork is a copy of the parent
// conversation under a new id, written in the harness's own on-disk layout, so
// the harness resumes it as if the conversation had always existed twice.
//
// The line-based harnesses key transcripts by working directory AND embed the
// cwd and the conversation id inside the transcript itself (Claude: each JSONL
// line carries `cwd` and `sessionId`, and the file lives in a bucket named by
// the encoded cwd; Codex: the rollout's session_meta carries `id` and `cwd`;
// Muse: the directory name is the session id, every line carries it as
// `stream.id`, and a metadata record carries the workspace root).
// So a copy must be re-homed to the fork's worktree directory and re-ided line
// by line, or the harness would either not find it from the new cwd or would
// keep writing to the parent's conversation.
//
// Version-sensitive adapters: these on-disk layouts are private-ish and
// upstream changes can break forking without touching ah. The pinned shapes
// live as fixtures in `server/fork.test.ts` (see the provenance stamps there);
// a harness update means refreshing the fixture and re-checking the rewrite
// below, not just the copy.
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export class ForkError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function claudeProjectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
}

function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex');
}

function museDir(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'muse');
}

/** Claude Code names each project bucket by replacing every non-alphanumeric in the cwd with a dash. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Rewrites JSONL line by line; lines that don't parse are copied verbatim. */
function rewriteJsonl(text: string, rewrite: (d: Record<string, any>) => void): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line;
      let d: Record<string, any>;
      try {
        d = JSON.parse(line);
      } catch {
        return line;
      }
      if (!d || typeof d !== 'object' || Array.isArray(d)) return line;
      rewrite(d);
      return JSON.stringify(d);
    })
    .join('\n');
}

async function writeCopy(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try {
    // 'wx': never overwrite a conversation that already exists under the new id.
    await writeFile(file, text, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await rm(file, { force: true }).catch(() => {});
    throw err;
  }
}

/** Claude Code: <projects>/<encoded-cwd>/<session-id>.jsonl */
async function forkClaude(sourceFile: string, newId: string, targetCwd: string): Promise<{ file: string }> {
  const text = await readFile(sourceFile, 'utf8');
  const out = rewriteJsonl(text, (d) => {
    if ('sessionId' in d) d.sessionId = newId;
    if ('cwd' in d) d.cwd = targetCwd;
  });
  const file = join(claudeProjectsDir(), encodeClaudeProjectDir(targetCwd), `${newId}.jsonl`);
  await writeCopy(file, out);
  return { file };
}

/** Codex: <sessions>/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl, meta in the first line. */
async function forkCodex(sourceFile: string, newId: string, targetCwd: string): Promise<{ file: string }> {
  const text = await readFile(sourceFile, 'utf8');
  const out = rewriteJsonl(text, (d) => {
    const p = d?.payload;
    if (!p || typeof p !== 'object') return;
    if (d.type === 'session_meta') {
      if ('id' in p) p.id = newId;
      if ('session_id' in p) p.session_id = newId;
    }
    if ('cwd' in p) p.cwd = targetCwd;
  });
  const name = basename(sourceFile);
  const stamp = name.match(/^rollout-(.+)-[^-]+\.jsonl$/)?.[1];
  const file = join(dirname(sourceFile), stamp ? `rollout-${stamp}-${newId}.jsonl` : `rollout-${newId}.jsonl`);
  // The rollout must stay under the Codex home the discovery pass scans.
  if (!resolve(file).startsWith(resolve(codexHome(), 'sessions') + sep)) throw new ForkError(422, 'codex transcript is outside its session store; cannot fork it');
  await writeCopy(file, out);
  return { file };
}

/** Re-id one muse envelope in place: the stream id binds every line to its
 *  session, and the metadata record binds the session to its working
 *  directory. Frame lines embed envelope JSON inside children[].record_json
 *  strings, so those are rewritten recursively. Fields that are absent are
 *  never added. */
function reidMuse(d: Record<string, any>, newId: string, targetCwd: string): void {
  if (d.stream && typeof d.stream === 'object' && typeof d.stream.id === 'string') d.stream.id = newId;
  if (d.payload_type === 'runtime.session.metadata' && d.payload && typeof d.payload === 'object') {
    const rec = (d.payload as Record<string, any>).record;
    if (rec && typeof rec === 'object' && typeof rec.workspace_root === 'string') rec.workspace_root = targetCwd;
  }
  if (Array.isArray(d.children)) {
    for (const c of d.children) {
      if (!c || typeof c !== 'object' || typeof c.record_json !== 'string') continue;
      try {
        const inner = JSON.parse(c.record_json);
        if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
          reidMuse(inner, newId, targetCwd);
          c.record_json = JSON.stringify(inner);
        }
      } catch {
        // Not envelope JSON: copied verbatim.
      }
    }
  }
}

/** Muse: sessions/YYYY/MM/DD/<session-id>/session.jsonl, homed at the new id under today. */
async function forkMuse(sourceFile: string, newId: string, targetCwd: string): Promise<{ file: string }> {
  const text = await readFile(sourceFile, 'utf8');
  const out = rewriteJsonl(text, (d) => reidMuse(d, newId, targetCwd));
  const now = new Date();
  const day = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')];
  const file = join(museDir(), 'sessions', ...day, newId, 'session.jsonl');
  await writeCopy(file, out);
  return { file };
}

type Forker = (sourceFile: string, newId: string, targetCwd: string) => Promise<{ file: string }>;

/** Harnesses whose transcripts ah knows how to duplicate. Everything else is honestly unavailable. */
export const FORKERS: Record<string, Forker> = {
  claude: forkClaude,
  codex: forkCodex,
  muse: forkMuse,
};

/** Why this session can't be forked, or null when it can. Checked before anything is created. */
export function forkUnavailableReason(harness: string, harnessId: string | undefined): string | null {
  if (harness === 'shell') return 'shell sessions have no conversation to fork; start an agent session instead';
  if (!harnessId) return 'this session has no conversation id yet, so there is nothing to fork';
  if (!FORKERS[harness]) return `${harness} conversations can't be forked yet (only Claude Code, Codex and Muse can)`;
  return null;
}

/**
 * Copies the transcript at `sourceFile` to a fresh conversation id homed at
 * `targetCwd`. Returns the new id and where the copy landed. A failed copy
 * leaves nothing behind.
 */
export async function copyTranscript(harness: string, sourceFile: string, targetCwd: string): Promise<{ harnessId: string; file: string }> {
  const forker = FORKERS[harness];
  if (!forker) throw new ForkError(422, forkUnavailableReason(harness, undefined) ?? 'cannot fork');
  const harnessId = randomUUID();
  const { file } = await forker(sourceFile, harnessId, targetCwd);
  return { harnessId, file };
}

/** Deletes a copied transcript (fork rollback). Best effort: the caller is already failing. */
export async function removeCopiedTranscript(file: string): Promise<void> {
  await rm(file, { force: true }).catch(() => {});
}
