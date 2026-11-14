// Native transcript → portable document (server/portable/schema.ts).
//
// One streaming pass over the harness's own transcript: its feed adapter
// (server/feed/adapters, the same reading the GUI trusts) turns each line into
// messages, and a small per-harness reader takes what the GUI doesn't need from the
// raw line: the model, the harness's own compaction summaries, where it ran. The
// file is read in chunks and hashed as it goes; memory stays bounded by the
// document's own size cap, whatever the transcript's size.
//
// Nothing is invented: a line that doesn't parse is counted, a half-written last
// line is left out, reasoning is counted rather than copied, and every message
// keeps the line it came from.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { ADAPTERS, DOC_ADAPTERS, type Adapter, type DocAdapter } from '../feed/feed.ts';
import type { Entry, Part } from '../feed/schema.ts';
import { PORTABLE_FORMAT, PORTABLE_VERSION, type Limitation, type PortableArtifact, type PortableAttachment, type PortableConversation, type PortableMessage, type PortablePart, type PortableSummary } from './schema.ts';

export class PortableError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** ah's identity for a conversation: the same for `harness:harnessId` on every host. */
export function conversationId(harness: string, harnessId: string): string {
  return `pc-${createHash('sha256').update(`${harness}:${harnessId}`).digest('hex').slice(0, 16)}`;
}

/** The first line of every continuation ah types, so readers can tell it from the person. */
export const HANDOFF_MARK = /^\[ah continuation (lk-[0-9a-f]{8})\b/;

export const BOUNDS = {
  /** One text part (a reply, a prompt). */
  text: 32 * 1024,
  /** One tool result: what the model saw is in the source; the record keeps head and tail. */
  result: 2 * 1024,
  /** One tool call's arguments, as JSON. */
  args: 2 * 1024,
  /** The whole document's text; the oldest messages go first past it. */
  doc: 8 * 1024 * 1024,
  /** Images copied beside the document. */
  images: 40,
  image: 10 * 1024 * 1024,
};

const CHUNK = 4 * 1024 * 1024;

export type ExtractSource = {
  host: string;
  harness: string;
  adapter: string;
  harnessId: string;
  file: string;
  uid?: string;
  title?: string;
  cwd?: string;
  model?: string;
};

export type ExtractOptions = {
  /** Read only this many bytes of the transcript (a checkpoint taken earlier). */
  uptoBytes?: number;
  /** Where to copy images (owner-only); without it they're described, not kept. */
  attachDir?: string;
  /** Upload folders whose files a prompt may name (the attachments a person added). */
  uploadDirs?: string[];
  bounds?: Partial<typeof BOUNDS>;
};

/** What a raw line says besides its messages. */
type Meta = { model?: string; summary?: string; cwd?: string; branch?: string; head?: string; remote?: string; sidechain?: boolean };

/** Per-harness reading of the raw line, for what the feed adapters leave out. */
const META: Record<string, (d: any) => Meta | null> = {
  claude: (d) => {
    if (!d || typeof d !== 'object') return null;
    const out: Meta = {};
    if (d.isSidechain) out.sidechain = true;
    if (d.type === 'assistant' && typeof d.message?.model === 'string' && d.message.model !== '<synthetic>') out.model = d.message.model;
    if (d.isCompactSummary && typeof d.message?.content === 'string') out.summary = d.message.content;
    else if (d.isCompactSummary && Array.isArray(d.message?.content)) out.summary = d.message.content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
    if (typeof d.cwd === 'string') out.cwd = d.cwd;
    if (typeof d.gitBranch === 'string' && d.gitBranch) out.branch = d.gitBranch;
    return out;
  },
  codex: (d) => {
    if (!d || typeof d !== 'object') return null;
    const p = d.payload ?? {};
    const out: Meta = {};
    if (d.type === 'session_meta') {
      if (typeof p.cwd === 'string') out.cwd = p.cwd;
      if (typeof p.git?.branch === 'string') out.branch = p.git.branch;
      if (typeof p.git?.commit_hash === 'string') out.head = p.git.commit_hash;
    }
    if (d.type === 'turn_context' && typeof p.model === 'string') out.model = p.model;
    if (d.type === 'compacted' && typeof p.message === 'string' && p.message.trim()) out.summary = p.message;
    return out;
  },
  muse: (d) => {
    if (d?.payload_type === 'runtime.session.metadata' && typeof d.payload?.record?.workspace_root === 'string') return { cwd: d.payload.record.workspace_root };
    return null;
  },
};

/** Harnesses whose on-disk format ah reads from documentation it hasn't verified locally. */
const UNVERIFIED: Record<string, string> = {
  muse: "Muse's transcript format was documented from a third-party report, not checked against a local install; some event kinds may be missing.",
};

function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const tail = Math.floor(max / 4);
  return { text: `${text.slice(0, max - tail)}\n… ${text.length - max} characters left out …\n${text.slice(-tail)}`, truncated: true };
}

function clipArgsJson(args: Record<string, unknown>, max: number): { args: Record<string, unknown>; truncated: boolean } {
  const json = JSON.stringify(args) ?? '{}';
  if (json.length <= max) return { args, truncated: false };
  const out: Record<string, unknown> = {};
  let used = 0;
  for (const [k, v] of Object.entries(args)) {
    const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
    const room = Math.max(64, Math.floor((max - used) / 2));
    out[k] = s.length > room ? `${s.slice(0, room)}… (${s.length - room} more characters)` : v;
    used += Math.min(s.length, room) + k.length;
  }
  return { args: out, truncated: true };
}

/** Paths a tool call changed: Claude's Edit/Write family by argument, Codex's apply_patch by its headers. */
function changedPaths(name: string, args: Record<string, unknown>): string[] {
  const n = name.toLowerCase();
  if (['edit', 'write', 'multiedit', 'notebookedit', 'str_replace_based_edit_tool', 'write_file', 'edit_file', 'replace'].includes(n)) {
    const p = args.file_path ?? args.path ?? args.notebook_path ?? args.filePath;
    return typeof p === 'string' ? [p] : [];
  }
  if (n === 'apply_patch' || n === 'patch') {
    const text = typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : '';
    return [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
  }
  return [];
}

/** ah upload paths a prompt names (pasted screenshots, attached recordings). */
function namedUploads(text: string, dirs: string[]): string[] {
  if (!dirs.length) return [];
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[\s'"(])((?:\/|~\/)[^\s'"()]+)/g)) {
    const p = m[1];
    if (dirs.some((d) => p.startsWith(d + '/'))) out.push(p);
  }
  return out;
}

const IMAGE_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

/**
 * Reads a transcript into a portable document. Throws PortableError when the
 * harness has no reader (`unsupported_source`) or the file is gone (`source_missing`).
 */
export async function extract(src: ExtractSource, opts: ExtractOptions = {}): Promise<PortableConversation> {
  const bounds = { ...BOUNDS, ...opts.bounds };
  const lineAdapter: Adapter | undefined = ADAPTERS[src.adapter];
  const docAdapter: DocAdapter | undefined = DOC_ADAPTERS[src.adapter];
  if (!lineAdapter && !docAdapter) throw new PortableError(422, 'unsupported_source', `ah can't read ${src.harness} conversations yet`);
  const s = await stat(src.file).catch(() => null);
  if (!s?.isFile()) throw new PortableError(404, 'source_missing', 'the conversation\'s transcript is gone from this host');

  const meta = META[src.adapter];
  const messages: PortableMessage[] = [];
  const summaries: PortableSummary[] = [];
  const attachments: PortableAttachment[] = [];
  const artifacts = new Map<string, PortableArtifact>();
  const models = new Set<string>();
  const limitations: Limitation[] = [];
  let reasoning = 0;
  let unparsed = 0;
  let sidechain = 0;
  let toolCalls = 0;
  let truncatedResults = 0;
  let turn = 0;
  let docChars = 0;
  let droppedBefore: number | null = null;
  let model: string | undefined = src.model;
  const project = { root: null as string | null, branch: null as string | null, head: null as string | null, remote: null as string | null };
  let cwd = src.cwd ?? '';
  let images = 0;
  let imagesNotKept = 0;

  const relPath = (p: string) => (cwd && isAbsolute(p) && (p === cwd || p.startsWith(cwd + '/')) ? relative(cwd, p) || '.' : p);

  const take = async (entry: Entry, line: number) => {
    const parts: PortablePart[] = [];
    let handoff: PortableMessage['handoff'];
    for (const p of entry.parts as Part[]) {
      switch (p.type) {
        case 'text': {
          const c = clipText(p.text, bounds.text);
          if (entry.role === 'user' && !parts.length) {
            const h = p.text.match(HANDOFF_MARK);
            if (h) handoff = { linkId: h[1] };
          }
          parts.push({ type: 'text', text: c.text, ...(c.truncated ? { truncated: true } : {}) });
          if (entry.role === 'user') {
            for (const path of namedUploads(p.text, opts.uploadDirs ?? [])) {
              const st = existsSync(path) ? statSync(path) : null;
              attachments.push({ id: `att-${attachments.length + 1}`, kind: 'file', bytes: st?.size ?? 0, sha256: st ? await fileSha(path) : '', path, messageId: entry.id, name: path.slice(path.lastIndexOf('/') + 1) });
            }
          }
          break;
        }
        case 'reasoning':
          reasoning++;
          break;
        case 'media': {
          const m = p.src.match(/^data:(image\/[\w.+-]+);base64,(.*)$/s);
          if (!m) break;
          const data = Buffer.from(m[2], 'base64');
          const sha256 = createHash('sha256').update(data).digest('hex');
          const id = `att-${attachments.length + 1}`;
          let path: string | undefined;
          if (opts.attachDir && images < bounds.images && data.length <= bounds.image) {
            await mkdir(opts.attachDir, { recursive: true, mode: 0o700 });
            path = join(opts.attachDir, `${sha256.slice(0, 16)}${IMAGE_EXT[m[1]] ?? '.img'}`);
            if (!existsSync(path)) await writeFile(path, data, { mode: 0o600 });
            images++;
          } else imagesNotKept++;
          attachments.push({ id, kind: 'image', mediaType: m[1], bytes: data.length, sha256, ...(path ? { path } : {}), messageId: entry.id });
          parts.push({ type: 'attachment', ref: id });
          break;
        }
        case 'tool_call': {
          toolCalls++;
          const c = clipArgsJson(p.call.args, bounds.args);
          parts.push({ type: 'tool_call', id: p.call.id, name: p.call.name, args: c.args, ...(c.truncated ? { truncated: true } : {}) });
          for (const path of changedPaths(p.call.name, p.call.args)) {
            const key = relPath(path);
            const a = artifacts.get(key) ?? { path: key, tool: p.call.name, changes: 0, lastLine: line };
            a.changes++;
            a.lastLine = line;
            artifacts.set(key, a);
          }
          break;
        }
        case 'tool_result': {
          const c = clipText(p.result.text, bounds.result);
          if (c.truncated || p.result.truncated) truncatedResults++;
          parts.push({ type: 'tool_result', callId: p.result.callId, text: c.text, isError: p.result.isError, ...(c.truncated || p.result.truncated ? { truncated: true } : {}) });
          break;
        }
        case 'notice':
          parts.push({ type: 'notice', kind: p.kind, text: p.text });
          break;
        case 'widget':
          parts.push({ type: 'widget', widget: p.widget });
          break;
      }
    }
    if (!parts.length) return;
    // A turn is what follows one message the person typed (an ah continuation counts:
    // it is what the destination agent was asked).
    if (entry.role === 'user' && parts.some((p) => p.type === 'text')) turn++;
    const msg: PortableMessage = { id: entry.id, line, turn, role: entry.role, at: entry.at, ...(entry.role === 'assistant' && model ? { model } : {}), parts, ...(handoff ? { handoff } : {}) };
    messages.push(msg);
    docChars += JSON.stringify(msg).length;
    // Bounded: the oldest messages go first, but the conversation's opening (what was asked) stays.
    while (docChars > bounds.doc && messages.length > 2) {
      const [gone] = messages.splice(1, 1);
      docChars -= JSON.stringify(gone).length;
      droppedBefore = messages[1]?.line ?? gone.line;
    }
  };

  const hash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  let partial = false;
  // The same choice feedFor makes: a document loader when there's no line reader, or for Gemini's older .json.
  const useDoc = !!docAdapter && (!lineAdapter || (src.adapter === 'gemini' && src.file.endsWith('.json')));
  if (!useDoc && lineAdapter) {
    const limit = Math.min(s.size, opts.uptoBytes ?? s.size);
    const fh = await open(src.file, 'r');
    try {
      let rest = Buffer.alloc(0);
      let offset = 0;
      while (offset < limit) {
        const buf = Buffer.alloc(Math.min(CHUNK, limit - offset));
        const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        let data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let nl: number;
        while ((nl = data.indexOf(0x0a)) >= 0) {
          const raw = data.subarray(0, nl);
          hash.update(data.subarray(0, nl + 1));
          bytes += nl + 1;
          data = data.subarray(nl + 1);
          const seq = ++lines;
          const text = raw.toString('utf8');
          if (!text.trim()) continue;
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            unparsed++;
            continue;
          }
          const m = meta?.(json);
          if (m?.sidechain) {
            sidechain++;
            continue;
          }
          if (m?.model) {
            model = m.model;
            models.add(m.model);
          }
          if (m?.cwd && !cwd) cwd = m.cwd;
          if (m?.branch) project.branch = m.branch;
          if (m?.head) project.head = m.head;
          if (m?.summary) summaries.push({ line: seq, at: Date.now(), kind: 'compaction', text: clipText(m.summary, bounds.text).text });
          const entry = lineAdapter(json, seq);
          if (entry) await take(entry, seq);
        }
        rest = Buffer.from(data);
      }
      // A last line without its newline is still being written: it isn't part of the record.
      if (rest.length && rest.toString('utf8').trim()) partial = true;
    } finally {
      await fh.close();
    }
  } else {
    const entries = (await docAdapter!(src.file).catch(() => null)) ?? [];
    const whole = await readFile(src.file).catch(() => Buffer.alloc(0));
    hash.update(whole);
    bytes = whole.length;
    lines = entries.length;
    for (const e of entries) await take(e, e.seq);
  }
  if (src.model) models.add(src.model);

  if (reasoning) limitations.push({ code: 'reasoning_omitted', count: reasoning, message: `${reasoning} reasoning block${reasoning === 1 ? ' was' : 's were'} left out: a model's own scratchpad isn't part of what was said, and another agent can't rely on it.` });
  if (attachments.some((a) => a.kind === 'image')) limitations.push({ code: 'images_by_reference', count: attachments.filter((a) => a.kind === 'image').length, message: `Images are stored beside the record and referenced by file, not shown inline.${imagesNotKept ? ` ${imagesNotKept} were too many or too large to keep.` : ''}` });
  if (truncatedResults) limitations.push({ code: 'tool_output_truncated', count: truncatedResults, message: `${truncatedResults} tool output${truncatedResults === 1 ? ' is' : 's are'} shortened to head and tail; the source transcript has them whole.` });
  if (droppedBefore !== null) limitations.push({ code: 'older_messages_dropped', message: `The conversation is longer than a record holds: messages before line ${droppedBefore} (after the first) were left out.` });
  if (unparsed) limitations.push({ code: 'unparsed_lines', count: unparsed, message: `${unparsed} line${unparsed === 1 ? '' : 's'} of the transcript couldn't be read and ${unparsed === 1 ? 'was' : 'were'} skipped.` });
  if (partial) limitations.push({ code: 'partial_last_line', message: 'The transcript\'s last line was still being written; it was left out.' });
  if (sidechain) limitations.push({ code: 'subagents_omitted', count: sidechain, message: `${sidechain} subagent line${sidechain === 1 ? '' : 's'} (work the agent delegated) ${sidechain === 1 ? 'is' : 'are'} not part of the main conversation and ${sidechain === 1 ? 'was' : 'were'} left out.` });
  if (UNVERIFIED[src.adapter]) limitations.push({ code: 'format_unverified', message: UNVERIFIED[src.adapter] });
  limitations.push({ code: 'no_internal_state', message: "This is what the transcript shows. A model's internal state (its context window, caches, hidden reasoning) is not in it and does not transfer." });

  const at = (i: number) => messages[i]?.at || 0;
  return {
    format: PORTABLE_FORMAT,
    version: PORTABLE_VERSION,
    id: conversationId(src.harness, src.harnessId),
    title: src.title ?? '',
    cwd,
    project,
    models: [...models],
    createdAt: at(0) || Math.floor(s.birthtimeMs) || Math.floor(s.mtimeMs),
    updatedAt: at(messages.length - 1) || Math.floor(s.mtimeMs),
    extractedAt: Date.now(),
    source: { host: src.host, harness: src.harness, adapter: src.adapter, harnessId: src.harnessId, ...(src.uid ? { uid: src.uid } : {}), file: src.file, bytes, sha256: hash.digest('hex'), lines, mtime: Math.floor(s.mtimeMs) },
    messages,
    summaries,
    attachments,
    artifacts: [...artifacts.values()].sort((a, b) => b.lastLine - a.lastLine),
    lineage: [],
    limitations,
    stats: {
      messages: messages.length,
      turns: turn,
      toolCalls,
      reasoningOmitted: reasoning,
      unparsedLines: unparsed,
      droppedBefore,
    },
  };
}

async function fileSha(path: string): Promise<string> {
  const h = createHash('sha256');
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

/** Whether `needle` appears in `file` after byte `from` (reads at most 64 MB of it). */
export async function fileContains(file: string, needle: string, from = 0, max = 64 << 20): Promise<boolean> {
  const s = await stat(file).catch(() => null);
  if (!s || s.size <= from) return false;
  const fh = await open(file, 'r');
  try {
    const length = Math.min(s.size - from, max);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, from);
    return buf.subarray(0, bytesRead).includes(needle);
  } finally {
    await fh.close();
  }
}

/** sha256 of a file's first `bytes` bytes: is the source still what a checkpoint read? */
export async function prefixSha(file: string, bytes: number): Promise<string | null> {
  const s = await stat(file).catch(() => null);
  if (!s || s.size < bytes) return null;
  const h = createHash('sha256');
  const fh = await open(file, 'r');
  try {
    let offset = 0;
    const buf = Buffer.alloc(CHUNK);
    while (offset < bytes) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, bytes - offset), offset);
      if (!bytesRead) return null;
      h.update(buf.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

