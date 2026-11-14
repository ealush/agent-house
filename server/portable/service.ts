// Portable conversations, orchestrated: read a conversation into a portable
// document, preview what continuing it elsewhere would transfer, do it, and keep
// the lineage (docs/spec/13-conductor.md, "Portable conversations").
//
// The operations have different guarantees and are never passed off as one
// another (schema.ts `Strategy`). Every continuation is an edge written before
// anything launches, with its destination uid chosen up front, so a crash or a
// restart finds it and either finishes it or says it failed; a retried request
// with the same idempotency key returns the same edge instead of a second session.
// The source conversation is only ever read.
import type { Preset } from '../config.ts';
import type { SessionRecord } from '../registry.ts';
import type { Transcript } from '../discovery.ts';
import { buildHandoff, DEFAULT_BUDGET, type Segment } from './handoff.ts';
import { conversationId, extract, prefixSha, PortableError } from './extract.ts';
import { PortableStore, type Link } from './store.ts';
import type { Limitation, LineageRef, LinkKind, PortableConversation, Strategy } from './schema.ts';

/** A conversation ah can find on this host: a session record, or a transcript on disk. */
export type Resolved = {
  uid: string | null;
  harness: string;
  harnessId: string | null;
  cwd: string;
  title: string;
  file: string | null;
  model: string | null;
  /** Running now; mid-turn by its own hooks' word (a guess from screen output doesn't count). */
  live: boolean;
  busy: boolean;
  session: string | null;
};

export type PortableDeps = {
  host: () => string;
  presets: () => Preset[];
  available: (presetId: string) => boolean;
  resolve: (ref: string) => Promise<Resolved | null>;
  transcripts: () => Promise<Transcript[]>;
  record: (uid: string) => SessionRecord | undefined;
  freshUid: () => string;
  /** Starts the destination: a new conversation, or (`resume`) one whose transcript is already there. */
  launch: (o: { preset: string; cwd: string; name: string; uid: string; resume?: string; session: string | null; meta: Record<string, unknown>; sel: LaunchChoice }) => Promise<{ uid: string; windowId: string }>;
  /** Checks a model/effort/mode choice against the agent's catalog (launch.ts), throwing with why it can't. */
  checkLaunch: (preset: string, sel: LaunchChoice) => Promise<void>;
  /** Types (or queues) the hand-off; `id` makes a second call with the same id a no-op. */
  send: (uid: string, text: string, id: string) => Promise<{ outcome: string }>;
  /** Whether `needle` is in the session's own transcript yet (the hand-off arrived). */
  transcriptHas: (uid: string, needle: string, fromBytes: number) => Promise<boolean>;
  /** Copies a transcript under a new id homed at `cwd`, cut at `uptoBytes` (server/fork.ts). */
  copyTranscript: (harness: string, file: string, cwd: string, uptoBytes?: number) => Promise<{ harnessId: string; file: string }>;
  removeCopy: (file: string) => Promise<void>;
  worktree: (cwd: string, name: string) => Promise<{ path: string; branch: string }>;
  /** Same-harness forks go through the existing fork (worktree, wait for the turn to end). */
  fork: (ref: string, o: { name?: string } & LaunchChoice) => Promise<{ uid: string; harnessId: string }>;
  isDir: (p: string) => Promise<boolean>;
  uploadDirs: () => string[];
  changed: () => void;
};

/** The destination's launch choices, as New session takes them (ids from its catalog). */
export type LaunchChoice = { model?: string; effort?: string; mode?: string };

export type ContinueOptions = LaunchChoice & {
  /** Destination agent (a preset id). */
  to: string;
  /** `continue`: you're moving on (same checkout by default). `fork`: both carry on (own worktree by default). */
  intent?: 'continue' | 'fork';
  worktree?: boolean;
  name?: string;
  budget?: number;
  idempotencyKey?: string;
};

export type Plan = {
  strategy: Strategy;
  kind: LinkKind;
  source: { ref: string; uid: string | null; harness: string; conversationId: string; title: string; cwd: string; live: boolean; busy: boolean };
  destination: { harness: string; name: string; cwd: string; worktree: boolean } & LaunchChoice;
  /** Plain words for what transfers and what doesn't (shown before you confirm). */
  transfers: string[];
  limitations: Limitation[];
  /** Why it can't go ahead; null when it can. */
  blocked: { code: string; message: string } | null;
  /** The ancestor a native copy would come from (ancestor-fork). */
  ancestor: { conversationId: string; harness: string; title: string; checkpointLine: number } | null;
  handoff: { chars: number; messagesIncluded: number; messagesOmitted: number; preview: string } | null;
  stats: PortableConversation['stats'] | null;
};

const now = () => Math.floor(Date.now() / 1000);

const launchChoice = (d: LaunchChoice): LaunchChoice => ({ ...(d.model ? { model: d.model } : {}), ...(d.effort ? { effort: d.effort } : {}), ...(d.mode ? { mode: d.mode } : {}) });

export class PortableService {
  readonly store: PortableStore;
  private deps: PortableDeps;
  /** Edges still settling (destination not adopted yet): checked on each tick, cheaply. */
  private pending = new Map<string, Link>();
  private reconciling: Promise<void> | null = null;

  constructor(store: PortableStore, deps: PortableDeps) {
    this.store = store;
    this.deps = deps;
  }

  private preset(id: string): Preset | undefined {
    return this.deps.presets().find((p) => p.id === id);
  }

  private name(id: string): string {
    return this.preset(id)?.name ?? id;
  }

  /** What each agent on this host can do with portable conversations. */
  capabilities() {
    const forkable = new Set(['claude', 'codex', 'muse']);
    return {
      version: 1,
      format: { name: 'ah.portable-conversation', version: 1 },
      /** preview and continue take `model`, `effort` and `mode` for the destination, from its catalog. */
      launchOptions: true,
      strategies: ['native-resume', 'native-fork', 'ancestor-fork', 'context-handoff'] satisfies Strategy[],
      harnesses: this.deps
        .presets()
        .filter((p) => p.command.trim() && p.id !== 'shell')
        .map((p) => ({
          id: p.id,
          name: p.name,
          available: this.deps.available(p.id),
          /** ah reads its transcripts into portable documents. */
          read: !!p.feed,
          /** Resumes its own conversations by id. */
          nativeResume: !!p.resumeId,
          /** ah can copy its transcripts natively (fork, and coming back to it). */
          nativeFork: !!p.feed && forkable.has(p.feed) && !!p.resumeId,
          /** Can be handed a conversation from another agent (as a reconstructed record). */
          receive: true,
          notes: p.feed === 'muse' ? ["Muse's transcript format isn't verified against a local install."] : [],
        })),
    };
  }

  private async resolveOr404(ref: string): Promise<Resolved> {
    const r = await this.deps.resolve(ref);
    if (!r) throw new PortableError(404, 'not_found', 'conversation not found');
    if (r.harness === 'shell') throw new PortableError(422, 'not_a_conversation', 'shell sessions have no conversation to carry');
    return r;
  }

  private adapterOf(harness: string): string | null {
    return this.preset(harness)?.feed ?? null;
  }

  /** Reads `r` into a document (and writes it, unless `dryRun`). */
  private async read(r: Resolved, o: { uptoBytes?: number; write?: boolean } = {}): Promise<{ doc: PortableConversation; path: string | null }> {
    const adapter = this.adapterOf(r.harness);
    if (!adapter) throw new PortableError(422, 'unsupported_source', `ah can't read ${this.name(r.harness)} conversations yet (no transcript reader)`);
    if (!r.harnessId || !r.file) throw new PortableError(422, 'no_transcript', 'this session has no conversation on disk yet');
    const id = conversationId(r.harness, r.harnessId);
    const doc = await extract(
      { host: this.deps.host(), harness: r.harness, adapter, harnessId: r.harnessId, file: r.file, uid: r.uid ?? undefined, title: r.title, cwd: r.cwd, model: r.model ?? undefined },
      { uptoBytes: o.uptoBytes, attachDir: o.write === false ? undefined : this.store.attachDir(id), uploadDirs: this.deps.uploadDirs() },
    );
    doc.lineage = await this.lineageRefs(doc.id);
    if (o.write === false) return { doc, path: null };
    const path = await this.store.writeDoc(doc);
    await this.store.upsertConversation(doc, path);
    return { doc, path };
  }

  /** GET /portable/:ref: the conversation as a portable document (written beside ah's state too). */
  async export(ref: string): Promise<{ doc: PortableConversation; path: string }> {
    const r = await this.resolveOr404(ref);
    const { doc, path } = await this.read(r);
    return { doc, path: path! };
  }

  /** The edges a conversation came through, nearest first. */
  private async lineageRefs(id: string): Promise<LineageRef[]> {
    const out: LineageRef[] = [];
    const seen = new Set<string>([id]);
    let cur = id;
    for (let depth = 0; depth < 32; depth++) {
      const { parents } = await this.store.edges(cur);
      const e = parents.filter((p) => p.state === 'linked').pop();
      if (!e || seen.has(e.parentId)) break;
      seen.add(e.parentId);
      const conv = await this.store.conversation(e.parentId);
      out.push({ linkId: e.id, kind: e.kind, strategy: e.strategy, conversationId: e.parentId, harness: e.fromHarness, title: conv?.title ?? '', uid: e.parentUid, checkpointLine: e.checkpoint?.line ?? null, at: e.createdAt });
      cur = e.parentId;
    }
    return out;
  }

  /**
   * The lineage path behind `id`, root first, each with the edge that left it for
   * the next one (the last, `id` itself, has none): what an ancestor-fork copies
   * from and what a hand-off accumulates.
   */
  private async path(id: string): Promise<Array<{ conversationId: string; via: Link | null }>> {
    const chain: Array<{ conversationId: string; via: Link | null }> = [{ conversationId: id, via: null }];
    const seen = new Set([id]);
    let cur = id;
    for (let depth = 0; depth < 32; depth++) {
      const { parents } = await this.store.edges(cur);
      const e = parents.filter((p) => p.state === 'linked' && (p.kind === 'portable' || p.kind === 'fork' || p.kind === 'migration')).pop();
      if (!e || seen.has(e.parentId)) break;
      seen.add(e.parentId);
      chain.unshift({ conversationId: e.parentId, via: e });
      cur = e.parentId;
    }
    return chain;
  }

  /** The document an edge recorded for its parent: exactly what was read at the branch point. */
  private async parentDoc(link: Link): Promise<PortableConversation | null> {
    const p = link.detail.parentDoc;
    return typeof p === 'string' ? this.store.readDoc(p) : null;
  }

  /** What continuing `ref` in `o.to` would do, without doing anything. */
  async preview(ref: string, o: ContinueOptions): Promise<Plan & { text: string | null }> {
    return this.plan(ref, o, false);
  }

  private async plan(ref: string, o: ContinueOptions, write: boolean, linkId = 'lk-00000000'): Promise<Plan & { text: string | null; segments?: Segment[]; ancestorFile?: string; ancestorBytes?: number; sourceDoc?: PortableConversation; sourcePath?: string | null; docPaths?: string[] }> {
    const r = await this.resolveOr404(ref);
    const dest = this.preset(o.to);
    const intent = o.intent ?? 'continue';
    const worktree = o.worktree ?? intent === 'fork';
    const sel: LaunchChoice = { ...(o.model ? { model: o.model } : {}), ...(o.effort ? { effort: o.effort } : {}), ...(o.mode ? { mode: o.mode } : {}) };
    const base: Omit<Plan, 'strategy' | 'kind' | 'transfers' | 'limitations' | 'blocked' | 'ancestor' | 'handoff' | 'stats'> = {
      source: { ref, uid: r.uid, harness: r.harness, conversationId: r.harnessId ? conversationId(r.harness, r.harnessId) : '', title: r.title, cwd: r.cwd, live: r.live, busy: r.busy },
      destination: { harness: o.to, name: o.name?.trim() || r.title || this.name(r.harness), cwd: r.cwd, worktree, ...sel },
    };
    const blocked = (code: string, message: string) => ({ ...base, strategy: 'context-handoff' as Strategy, kind: 'portable' as LinkKind, transfers: [], limitations: [], blocked: { code, message }, ancestor: null, handoff: null, stats: null, text: null });
    if (!dest || !dest.command.trim() || dest.id === 'shell') return blocked('unknown_destination', `${o.to} isn't an agent on this host`);
    if (!this.deps.available(dest.id)) return blocked('destination_unavailable', `${dest.name} isn't installed on this host`);
    if (Object.keys(sel).length) {
      try {
        await this.deps.checkLaunch(dest.id, sel);
      } catch (err) {
        throw new PortableError(400, 'invalid_launch', (err as Error).message);
      }
    }

    // Same agent: its own history carries over natively.
    if (dest.id === r.harness) {
      if (intent === 'continue') {
        return { ...base, strategy: 'native-resume', kind: 'resume', transfers: [`The same ${dest.name} conversation, resumed by ${dest.name} itself: everything it knew.`], limitations: [], blocked: r.harnessId ? null : { code: 'no_conversation', message: 'this session has no conversation id yet' }, ancestor: null, handoff: null, stats: null, text: null };
      }
      return { ...base, destination: { ...base.destination, worktree: true }, strategy: 'native-fork', kind: 'fork', transfers: [`A copy of the ${dest.name} conversation under a new id, in its own worktree and branch: ${dest.name} re-reads all of it.`, 'The original keeps running, untouched.'], limitations: [], blocked: null, ancestor: null, handoff: null, stats: null, text: null };
    }

    const adapter = this.adapterOf(r.harness);
    if (!adapter) return blocked('unsupported_source', `ah can't read ${this.name(r.harness)} conversations yet, so there's nothing to hand over`);
    if (!r.harnessId || !r.file) return blocked('no_transcript', 'this session has no conversation on disk yet');
    if (r.busy && !worktree) return blocked('source_busy', `${this.name(r.harness)} is working; continue when its turn ends, or in a worktree of its own`);

    const { doc: sourceDoc, path: sourcePath } = await this.read(r, { write });
    const chain = await this.path(sourceDoc.id);
    // The nearest conversation behind this one in the destination's own agent, still on disk as it was at the branch.
    let ancestor: { conversationId: string; harness: string; title: string; checkpointLine: number } | null = null;
    let ancestorFile: string | undefined;
    let ancestorBytes: number | undefined;
    let fromIndex = 0;
    const limitations: Limitation[] = [];
    for (let i = chain.length - 2; i >= 0; i--) {
      const node = chain[i];
      const leaving = node.via!;
      if (leaving.fromHarness !== dest.id || !leaving.checkpoint) continue;
      const conv = await this.store.conversation(node.conversationId);
      const preset = this.preset(dest.id);
      const forkable = !!preset?.feed && ['claude', 'codex', 'muse'].includes(preset.feed) && !!preset.resumeId;
      if (!conv || !forkable) break;
      const found = (await this.deps.transcripts()).find((t) => t.harness === preset.feed && t.harnessId === conv.harnessId);
      if (!found) {
        limitations.push({ code: 'source_changed', message: `The ${dest.name} conversation this came from isn't on this host, so it is handed over as a record instead of copied natively.` });
        break;
      }
      if ((await prefixSha(found.file, leaving.checkpoint.bytes)) !== leaving.checkpoint.sha256) {
        limitations.push({ code: 'source_changed', message: `The ${dest.name} conversation this came from has changed on disk since it branched, so it is handed over as a record instead of copied natively.` });
        break;
      }
      ancestor = { conversationId: conv.id, harness: dest.id, title: conv.title, checkpointLine: leaving.checkpoint.line };
      ancestorFile = found!.file;
      ancestorBytes = leaving.checkpoint.bytes;
      fromIndex = i + 1;
      break;
    }

    // The segments the hand-off reads: after the ancestor (a delta), or the whole path.
    const segments: Segment[] = [];
    const docPaths: string[] = sourcePath ? [sourcePath] : [];
    for (let i = fromIndex; i < chain.length; i++) {
      const isSource = i === chain.length - 1;
      const next = chain[i].via;
      // An earlier conversation as it was when this lineage left it (the document that edge read).
      const doc: PortableConversation | null = isSource ? sourceDoc : next ? await this.parentDoc(next) : null;
      if (!doc) continue;
      if (!isSource && typeof next?.detail.parentDoc === 'string') docPaths.unshift(next.detail.parentDoc);
      segments.push({ conv: doc, harnessName: this.name(doc.source.harness), ...(!isSource && next?.checkpoint ? { uptoLine: next.checkpoint.line } : {}) });
    }
    if (!segments.length) segments.push({ conv: sourceDoc, harnessName: this.name(r.harness) });
    const mode = ancestor ? 'delta' : 'handoff';
    const plan = buildHandoff({ linkId, segments, destName: dest.name, mode, docPaths, budget: o.budget ?? DEFAULT_BUDGET });
    limitations.push(...plan.limitations);
    if (!worktree && r.live) limitations.push({ code: 'same_checkout', message: `The ${this.name(r.harness)} session is still running in this checkout; don't let both edit at once.` });
    const transfers = ancestor
      ? [`Your earlier ${dest.name} conversation ("${ancestor.title}"), copied natively as it was when it branched off: ${dest.name} re-reads all of it.`, `What happened since, in ${segments.map((s) => s.harnessName).join(', ')}, as a reconstructed record (${plan.messagesIncluded} messages).`, 'The originals stay as they are.']
      : [`A new ${dest.name} session primed with a record of the conversation (${plan.messagesIncluded} messages${plan.messagesOmitted ? `, ${plan.messagesOmitted} older ones left out` : ''}), reconstructed from ${this.name(r.harness)}'s transcript.`, `${this.name(r.harness)}'s own memory of it does not transfer: ${dest.name} starts from the record.`, 'The original conversation stays as it is.'];
    return {
      ...base,
      strategy: ancestor ? 'ancestor-fork' : 'context-handoff',
      kind: 'portable',
      transfers,
      limitations,
      blocked: null,
      ancestor,
      handoff: { chars: plan.chars, messagesIncluded: plan.messagesIncluded, messagesOmitted: plan.messagesOmitted, preview: plan.text.length > 4000 ? `${plan.text.slice(0, 2000)}\n…\n${plan.text.slice(-1500)}` : plan.text },
      stats: sourceDoc.stats,
      text: plan.text,
      segments,
      ancestorFile,
      ancestorBytes,
      sourceDoc,
      sourcePath,
      docPaths,
    };
  }

  /**
   * Continues `ref` in another agent (or forks it), per the plan preview() shows.
   * Returns the edge; the destination is launching or already delivered to.
   */
  async continue(ref: string, o: ContinueOptions): Promise<{ link: Link; existed: boolean }> {
    if (o.idempotencyKey) {
      const prior = await this.store.linkByKey(o.idempotencyKey);
      if (prior) return { link: prior, existed: true };
    }
    const r = await this.resolveOr404(ref);
    const dest = this.preset(o.to);
    if (dest?.id === r.harness) return this.nativeSameHarness(ref, r, o);

    const draft = await this.plan(ref, { ...o }, true);
    if (draft.blocked) throw new PortableError(409, draft.blocked.code, draft.blocked.message);
    const sourceDoc = draft.sourceDoc!;
    const { link, existed } = await this.store.createLink({
      kind: 'portable',
      strategy: draft.strategy,
      state: 'preparing',
      parentId: sourceDoc.id,
      parentUid: r.uid,
      // Chosen before anything launches, so a restart can tell whether it did.
      childUid: this.deps.freshUid(),
      fromHarness: r.harness,
      toHarness: o.to,
      fromHost: this.deps.host(),
      toHost: this.deps.host(),
      checkpoint: { line: sourceDoc.source.lines, bytes: sourceDoc.source.bytes, sha256: sourceDoc.source.sha256 },
      limitations: draft.limitations,
      detail: { parentDoc: draft.sourcePath, intent: o.intent ?? 'continue', name: draft.destination.name, sel: launchChoice(draft.destination), ...(draft.ancestor ? { ancestor: draft.ancestor, ancestorBytes: draft.ancestorBytes } : {}) },
      idempotencyKey: o.idempotencyKey ?? null,
    });
    // The same request twice at once: the key let one in, and only that one launches.
    if (existed) return { link, existed };
    // The hand-off names its own edge (the preview's placeholder id is never typed).
    const plan = buildHandoff({ linkId: link.id, segments: draft.segments!, destName: this.name(o.to), mode: draft.ancestor ? 'delta' : 'handoff', docPaths: draft.docPaths ?? [], budget: o.budget ?? DEFAULT_BUDGET });
    return { link: await this.run(link, r, draft, plan.text), existed: false };
  }

  /** Launch, deliver, and leave the edge for the tick to link once the destination has its conversation. */
  private async run(link: Link, r: Resolved, draft: Awaited<ReturnType<PortableService['plan']>>, text: string): Promise<Link> {
    let cwd = r.cwd;
    const meta: Record<string, unknown> = {
      'ah.continued': { linkId: link.id, fromUid: r.uid, fromHarness: r.harness, fromTitle: r.title, kind: link.kind, strategy: link.strategy, at: now() },
    };
    let copied: { harnessId: string; file: string } | null = null;
    try {
      if (draft.destination.worktree) {
        const wt = await this.deps.worktree(cwd, draft.destination.name);
        cwd = wt.path;
        meta['ah.worktree'] = wt;
      } else if (!(await this.deps.isDir(cwd))) {
        throw new PortableError(409, 'cwd_missing', `the conversation's folder is gone: ${cwd}`);
      }
      if (draft.strategy === 'ancestor-fork' && draft.ancestorFile) {
        // As it was at the branch: the bytes the edge that left it read, checked by its sha in plan().
        copied = await this.deps.copyTranscript(link.toHarness, draft.ancestorFile, cwd, draft.ancestorBytes);
      }
      link = await this.store.updateLink(link.id, { state: 'launching', detail: { ...link.detail, cwd, ...(copied ? { copiedId: copied.harnessId, copiedFile: copied.file, copiedBytes: draft.ancestorBytes ?? 0 } : {}) } });
      await this.deps.launch({ preset: link.toHarness, cwd, name: draft.destination.name, uid: link.childUid!, resume: copied?.harnessId, session: r.session, meta, sel: launchChoice(draft.destination) });
      link = await this.store.updateLink(link.id, { state: 'delivering', ...(copied ? { childId: conversationId(link.toHarness, copied.harnessId) } : {}) });
      await this.deps.send(link.childUid!, text, link.id);
    } catch (err) {
      if (copied && link.state !== 'delivering') await this.deps.removeCopy(copied.file).catch(() => {});
      const message = (err as Error).message;
      await this.store.updateLink(link.id, { state: 'failed', error: message }).catch(() => {});
      if (err instanceof PortableError) throw err;
      throw new PortableError(500, 'continue_failed', `continuing failed: ${message}`);
    }
    this.pending.set(link.id, link);
    this.deps.changed();
    return link;
  }

  /** Same agent: resume it (no new conversation), or fork it natively (the existing fork). */
  private async nativeSameHarness(ref: string, r: Resolved, o: ContinueOptions): Promise<{ link: Link; existed: boolean }> {
    if ((o.intent ?? 'continue') === 'continue') throw new PortableError(409, 'use_resume', `it's already a ${this.name(r.harness)} conversation: resume it instead (POST /api/sessions/${ref}/resume)`);
    if (!r.harnessId) throw new PortableError(422, 'no_conversation', 'this session has no conversation id yet');
    const parentId = conversationId(r.harness, r.harnessId);
    const out = await this.deps.fork(ref, { name: o.name, model: o.model, effort: o.effort, mode: o.mode });
    const { link } = await this.store.createLink({
      kind: 'fork', strategy: 'native-fork', state: 'linked', parentId, childId: conversationId(r.harness, out.harnessId), parentUid: r.uid, childUid: out.uid,
      fromHarness: r.harness, toHarness: r.harness, fromHost: this.deps.host(), toHost: this.deps.host(), checkpoint: null, limitations: [], detail: { intent: 'fork' }, idempotencyKey: o.idempotencyKey ?? null,
    });
    return { link, existed: false };
  }

  /** Edges whose destination hasn't got its conversation yet: link them as it appears. Runs from the tick. */
  reconcile(): Promise<void> {
    if (!this.pending.size) return Promise.resolve();
    this.reconciling ??= this.reconcileNow().finally(() => (this.reconciling = null));
    return this.reconciling;
  }

  private async reconcileNow() {
    for (const [id, link] of [...this.pending]) {
      try {
        const rec = link.childUid ? this.deps.record(link.childUid) : undefined;
        const detail = { ...link.detail };
        // Delivered once the destination's own transcript holds the hand-off (it names this edge).
        if (!detail.delivered && link.childUid && (await this.deps.transcriptHas(link.childUid, link.id, Number(detail.copiedBytes) || 0).catch(() => false))) detail.delivered = now();
        let childId = link.childId;
        if (rec?.harnessId && rec.harness === link.toHarness) {
          childId = conversationId(rec.harness, rec.harnessId);
          // The child is a conversation too: an identity row, so its own lineage resolves.
          if (!(await this.store.conversation(childId))) await this.store.upsertConversationRow({ id: childId, harness: rec.harness, harnessId: rec.harnessId, host: this.deps.host(), title: rec.title, cwd: rec.cwd });
        }
        if (childId && detail.delivered) {
          this.pending.delete(id);
          await this.store.updateLink(id, { state: 'linked', childId, detail });
          this.deps.changed();
        } else if (rec?.lifecycle === 'ended' && !detail.delivered) {
          this.pending.delete(id);
          await this.store.updateLink(id, { state: 'failed', childId, detail, error: `the ${this.name(link.toHarness)} session ended before it took the hand-off` });
          this.deps.changed();
        } else if (childId !== link.childId || detail.delivered !== link.detail.delivered) {
          this.pending.set(id, await this.store.updateLink(id, { childId, detail }));
        }
      } catch (err) {
        console.warn(`portable: settling ${id} failed:`, err);
      }
    }
  }

  /**
   * At start: edges a restart interrupted. One whose destination was never
   * created failed (nothing ran; retry makes it again). One whose destination
   * exists is watched again; a hand-off not yet in its queue or transcript goes
   * in once (the queue item carries the edge's id, so it can't go in twice).
   */
  async recover(): Promise<{ resumed: number; failed: number }> {
    let resumed = 0;
    let failed = 0;
    for (const link of await this.store.unfinished()) {
      if (link.kind !== 'portable') continue;
      const rec = link.childUid ? this.deps.record(link.childUid) : undefined;
      if (!rec) {
        await this.store.updateLink(link.id, { state: 'failed', error: 'ah stopped before the destination session started; nothing was launched. Retry to continue.' });
        failed++;
        continue;
      }
      this.pending.set(link.id, link);
      resumed++;
    }
    return { resumed, failed };
  }

  /** Re-runs a failed edge: same source, same destination, same edge id (and a fresh destination uid). */
  async retry(id: string): Promise<Link> {
    const link = await this.store.link(id);
    if (!link) throw new PortableError(404, 'not_found', 'no such continuation');
    if (link.state !== 'failed') throw new PortableError(409, 'not_failed', `it is ${link.state}, not failed`);
    if (link.childUid && this.deps.record(link.childUid)) throw new PortableError(409, 'destination_exists', 'its destination session exists; open it instead');
    const ref = link.parentUid ?? (await this.store.conversation(link.parentId).then((c) => (c ? `${c.harness}:${c.harnessId}` : null)));
    if (!ref) throw new PortableError(404, 'source_gone', 'the source conversation is no longer known here');
    const r = await this.resolveOr404(ref);
    const draft = await this.plan(ref, { to: link.toHarness, intent: (link.detail.intent as 'continue' | 'fork') ?? 'continue', name: link.detail.name as string | undefined, ...((link.detail.sel as LaunchChoice | undefined) ?? {}) }, true);
    if (draft.blocked) throw new PortableError(409, draft.blocked.code, draft.blocked.message);
    const fresh = await this.store.updateLink(id, { state: 'preparing', error: null, childUid: this.deps.freshUid(), detail: { ...link.detail, parentDoc: draft.sourcePath, ...(draft.ancestor ? { ancestor: draft.ancestor, ancestorBytes: draft.ancestorBytes } : {}) } });
    const plan = buildHandoff({ linkId: id, segments: draft.segments!, destName: this.name(link.toHarness), mode: draft.ancestor ? 'delta' : 'handoff', docPaths: draft.docPaths ?? [], budget: DEFAULT_BUDGET });
    return this.run(fresh, r, draft, plan.text);
  }

  async cancel(id: string): Promise<Link> {
    const link = await this.store.link(id);
    if (!link) throw new PortableError(404, 'not_found', 'no such continuation');
    if (link.state === 'linked' || link.state === 'cancelled') return link;
    this.pending.delete(id);
    return this.store.updateLink(id, { state: 'cancelled' });
  }

  async operation(id: string) {
    const link = await this.store.link(id);
    if (!link) throw new PortableError(404, 'not_found', 'no such continuation');
    return this.describe(link);
  }

  private describe(link: Link) {
    const { parentDoc: _p, copiedFile: _c, ...detail } = link.detail as Record<string, unknown>;
    return { ...link, detail, fromName: this.name(link.fromHarness), toName: this.name(link.toHarness) };
  }

  /**
   * The whole tree `ref` belongs to: every conversation reachable by edges, with
   * the sessions ah knows for each. Bounded (64 nodes) and read from small tables.
   */
  async lineage(ref: string) {
    const r = await this.resolveOr404(ref);
    if (!r.harnessId) return { root: null, nodes: [], edges: [] };
    const start = conversationId(r.harness, r.harnessId);
    const links = (await this.store.allLinks()).filter((l) => l.state !== 'cancelled');
    const ids = new Set([start]);
    for (let grew = true; grew && ids.size < 64; ) {
      grew = false;
      for (const l of links) {
        const touch = ids.has(l.parentId) || (l.childId && ids.has(l.childId));
        if (!touch) continue;
        for (const x of [l.parentId, l.childId]) if (x && !ids.has(x)) (ids.add(x), (grew = true));
      }
    }
    const edges = links.filter((l) => ids.has(l.parentId) || (l.childId && ids.has(l.childId)));
    const nodes = [];
    for (const id of ids) {
      const conv = await this.store.conversation(id);
      const uids = new Set(edges.flatMap((e) => [e.parentId === id ? e.parentUid : null, e.childId === id ? e.childUid : null]).filter((u): u is string => !!u));
      nodes.push({ conversationId: id, harness: conv?.harness ?? null, harnessName: conv ? this.name(conv.harness) : null, harnessId: conv?.harnessId ?? null, title: conv?.title ?? '', host: conv?.host ?? null, uids: [...uids], current: id === start });
    }
    const hasParent = new Set(edges.filter((e) => e.childId).map((e) => e.childId));
    const root = nodes.find((n) => !hasParent.has(n.conversationId))?.conversationId ?? start;
    return { root, nodes, edges: edges.map((e) => this.describe(e)) };
  }

  /** Every session ref in `ref`'s lineage (uids and harness:harnessId keys), for searching across it. */
  async lineageKeys(ref: string): Promise<string[]> {
    const tree = await this.lineage(ref).catch(() => null);
    if (!tree) return [];
    return tree.nodes.flatMap((n) => [...n.uids, ...(n.harness && n.harnessId ? [`${n.harness}:${n.harnessId}`] : [])]);
  }
}
