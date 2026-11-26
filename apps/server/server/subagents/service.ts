// The subagents context's use cases: a conversation's tree of children, the summary each
// live session row carries, and where a child's own transcript is. It reads through the
// store (store.ts) and decides through the pure model (model.ts); which conversations
// exist and which still run come in through its ports.
import { basename } from 'node:path';
import type { Transcript } from '../discovery.ts';
import {
  capabilities,
  claudeRef,
  claudeState,
  codexState,
  geminiState,
  isActive,
  line,
  orderTree,
  parseClaudeRef,
  runningBelow,
  summarize,
  type Harness,
  type Liveness,
  type SubagentRoot,
  type SubagentSummary,
  type SubagentTree,
  type SubagentView,
} from './model.ts';
import { SubagentStore, claudeChildFile } from './store.ts';

/** A conversation children can hang from: the harness's id for it, its transcript, and whether it runs. */
export type Root = {
  harness: Harness;
  harnessId: string;
  file: string;
  title: string;
  /** Its live window, while it has one. */
  uid: string | null;
  live: Liveness;
  /** Working now: new children are looked for sooner. */
  busy?: boolean;
};

export type SubagentDeps = {
  /** Every conversation discovery knows, at most `maxAgeMs` old. */
  transcripts(maxAgeMs: number): Promise<Transcript[]>;
};

/** A child's own transcript, for the feed: which adapter reads it, and from which line. */
export type ChildSource = { adapter: string; harness: Harness; file: string; from?: number };

export class SubagentService {
  private store = new SubagentStore();
  private summaries = new Map<string, SubagentSummary | null>();
  private running: Promise<void> | null = null;

  private deps: SubagentDeps;

  constructor(deps: SubagentDeps) {
    this.deps = deps;
  }

  /** The children under `root`, parents before their children. */
  async tree(root: Root, maxAgeMs = 3000): Promise<SubagentTree> {
    const rootRef = `${root.harness}:${root.harnessId}`;
    const view: SubagentRoot = { ref: rootRef, uid: root.uid, title: root.title, live: root.live.live };
    const nodes = root.harness === 'claude' ? await this.claudeNodes(root, rootRef) : root.harness === 'codex' ? await this.codexNodes(root, rootRef, maxAgeMs) : await this.spawnedNodes(root, rootRef, maxAgeMs);
    return { root: view, nodes: nodes ? orderTree(nodes, rootRef) : [] };
  }

  /** A row's summary: null for a session whose harness has none, a zero count for one with no children yet. */
  peek(uid: string): SubagentSummary | null {
    return this.summaries.get(uid) ?? null;
  }

  /**
   * Brings the summaries of these live roots up to date, one pass at a time (a pass that's
   * running answers a second call). Sessions not given are forgotten.
   */
  refresh(roots: Root[]): Promise<void> {
    this.running ??= (async () => {
      const next = new Map<string, SubagentSummary | null>();
      for (const r of roots) {
        if (!r.uid) continue;
        try {
          const tree = await this.tree(r, r.busy ? 3000 : 15_000);
          next.set(r.uid, summarize(tree.nodes));
        } catch {
          next.set(r.uid, this.summaries.get(r.uid) ?? null);
        }
      }
      this.summaries = next;
    })().finally(() => (this.running = null));
    return this.running;
  }

  /** The root a child ref hangs from (its conversation id), or null when `ref` isn't a child's. */
  async rootOf(ref: string): Promise<{ harness: Harness; harnessId: string } | null> {
    const c = parseClaudeRef(ref);
    if (c) return { harness: 'claude', harnessId: c.sessionId };
    const spawned = await this.spawnedChild(ref);
    if (spawned?.spawned) return { harness: spawned.harness as Harness, harnessId: spawned.spawned.rootId };
    if (!ref.startsWith('codex:')) return null;
    const t = (await this.deps.transcripts(3000)).find((x) => x.harness === 'codex' && x.harnessId === ref.slice(6));
    return t?.spawned ? { harness: 'codex', harnessId: t.spawned.rootId } : null;
  }

  /** A child whose transcript discovery recorded under a parent, of any harness. A guessed ref names nothing. */
  private async spawnedChild(ref: string) {
    const i = ref.indexOf(':');
    if (i <= 0 || ref.startsWith('claude:')) return null;
    const harness = ref.slice(0, i);
    const id = ref.slice(i + 1);
    if (!id || id.includes('/') || id.includes('..') || harness === 'codex') return null;
    const t = (await this.deps.transcripts(3000)).find((x) => x.harness === harness && x.harnessId === id);
    return t?.spawned?.kind === 'spawn' ? t : null;
  }

  /** Where a child's transcript is, or null when `ref` names no child discovery can vouch for. */
  async source(ref: string): Promise<ChildSource | null> {
    const c = parseClaudeRef(ref);
    if (c) {
      const root = (await this.deps.transcripts(3000)).find((t) => t.harness === 'claude' && t.harnessId === c.sessionId && !t.spawned);
      const file = root ? claudeChildFile(root.file, c.agentId) : null;
      // A ref is only good for a child that's really there: a guessed one names nothing.
      return file && (await this.store.exists(file, root!.file)) ? { adapter: 'claude-subagent', harness: 'claude', file } : null;
    }
    const spawned = await this.spawnedChild(ref);
    if (spawned) return { adapter: spawned.harness, harness: spawned.harness as Harness, file: spawned.file, ...(spawned.spawned?.historyStart ? { from: spawned.spawned.historyStart } : {}) };
    if (!ref.startsWith('codex:')) return null;
    const t = (await this.deps.transcripts(3000)).find((x) => x.harness === 'codex' && x.harnessId === ref.slice(6));
    if (!t?.spawned) return null;
    return { adapter: 'codex', harness: 'codex', file: t.file, ...(t.spawned.historyStart ? { from: t.spawned.historyStart } : {}) };
  }

  private async claudeNodes(root: Root, rootRef: string): Promise<SubagentView[] | null> {
    const kids = await this.store.claude(root.file);
    if (!kids) return [];
    const refOf = (agentId: string) => claudeRef(root.harnessId, agentId);
    const ids = new Set(kids.map((k) => k.agentId));
    const parentRef = (k: (typeof kids)[number]) => (k.meta.parentAgentId && ids.has(k.meta.parentAgentId) ? refOf(k.meta.parentAgentId) : rootRef);
    // Two passes: a child waits on the children of its own that still run, so theirs first.
    const first = kids.map((k) => ({ k, s: claudeState({ background: k.meta.background, outcomes: k.outcomes, tail: k.tail, root: root.live, runningChildren: 0 }) }));
    const below = runningBelow(first.map(({ k, s }) => ({ ref: refOf(k.agentId), parentRef: parentRef(k), active: isActive(s.state) })));
    return first.map(({ k }) => {
      const ref = refOf(k.agentId);
      const s = claudeState({ background: k.meta.background, outcomes: k.outcomes, tail: k.tail, root: root.live, runningChildren: below.get(ref) ?? 0 });
      return {
        ref,
        harness: 'claude',
        agentId: k.agentId,
        parentRef: parentRef(k),
        rootRef,
        depth: k.meta.depth,
        name: k.meta.description ?? line(k.prompt, 80) ?? k.meta.agentType ?? 'Subagent',
        role: k.meta.agentType,
        prompt: k.prompt,
        state: s.state,
        background: k.meta.background,
        startedAt: k.birthAt,
        updatedAt: Math.max(k.birthAt, k.tail?.lastAt ?? 0),
        endedAt: s.endedAt,
        activity: k.tail?.activity ?? null,
        toolCallId: k.meta.toolUseId,
        capabilities: capabilities('claude', s.state, root.live.live),
      } satisfies SubagentView;
    });
  }

  private async codexNodes(root: Root, rootRef: string, maxAgeMs: number): Promise<SubagentView[]> {
    const all = (await this.deps.transcripts(maxAgeMs)).filter((t) => t.harness === 'codex' && t.spawned?.kind === 'spawn');
    // Everything under this root: by the tree's root id, and by walking parents (an older thread may not name its root).
    const inTree = new Set([root.harnessId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of all) {
        if (inTree.has(t.harnessId)) continue;
        if (t.spawned!.rootId === root.harnessId || inTree.has(t.spawned!.parentId)) {
          inTree.add(t.harnessId);
          grew = true;
        }
      }
    }
    // One conversation can span several rollouts (a resumed thread): the newest of each.
    const byId = new Map<string, Transcript>();
    for (const t of all) if (t.harnessId !== root.harnessId && inTree.has(t.harnessId) && (!byId.has(t.harnessId) || byId.get(t.harnessId)!.updatedAt < t.updatedAt)) byId.set(t.harnessId, t);
    // In the order they were spawned: a rollout's name starts with its creation time, to the millisecond.
    const spawned = [...byId.values()].sort((a, b) => basename(a.file).localeCompare(basename(b.file)));
    const kids = (await Promise.all(spawned.map((t) => this.store.codex(t).catch(() => null)))).filter((k) => !!k);
    const refOf = (id: string) => (id === root.harnessId ? rootRef : `codex:${id}`);
    const first = kids.map((k) => ({ k, s: codexState({ last: k.last, tail: k.tail, root: root.live, runningChildren: 0 }) }));
    const below = runningBelow(first.map(({ k, s }) => ({ ref: refOf(k.transcript.harnessId), parentRef: refOf(k.transcript.spawned!.parentId), active: isActive(s.state) })));
    return first.map(({ k }) => {
      const t = k.transcript;
      const sp = t.spawned!;
      const ref = refOf(t.harnessId);
      const s = codexState({ last: k.last, tail: k.tail, root: root.live, runningChildren: below.get(ref) ?? 0 });
      const startedAt = sp.bornAt ?? t.updatedAt;
      return {
        ref,
        harness: 'codex',
        agentId: t.harnessId,
        parentRef: refOf(sp.parentId),
        rootRef,
        depth: sp.depth,
        name: sp.nickname ?? line(k.prompt, 80) ?? 'Subagent',
        role: sp.role ?? null,
        prompt: k.prompt,
        state: s.state,
        background: false,
        startedAt,
        updatedAt: Math.max(t.updatedAt, k.tail?.lastAt ?? 0),
        endedAt: s.endedAt,
        activity: k.tail?.activity ?? null,
        toolCallId: null,
        capabilities: capabilities('codex', s.state, root.live.live),
      } satisfies SubagentView;
    });
  }

  /** Children discovery recorded under a parent, for every harness that writes them as conversations of their own. */
  private async spawnedNodes(root: Root, rootRef: string, maxAgeMs: number): Promise<SubagentView[]> {
    const all = (await this.deps.transcripts(maxAgeMs)).filter((t) => t.harness === root.harness && t.spawned?.kind === 'spawn');
    const inTree = new Set([root.harnessId]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of all) {
        if (inTree.has(t.harnessId)) continue;
        if (t.spawned!.rootId === root.harnessId || inTree.has(t.spawned!.parentId)) {
          inTree.add(t.harnessId);
          grew = true;
        }
      }
    }
    const kids = all.filter((t) => t.harnessId !== root.harnessId && inTree.has(t.harnessId)).sort((a, b) => a.updatedAt - b.updatedAt);
    const refOf = (id: string) => (id === root.harnessId ? rootRef : `${root.harness}:${id}`);
    const first = kids.map((t) => ({ t, s: geminiState({ killed: t.spawned?.killed, idle: t.spawned?.idle, endedAt: t.spawned?.endedAt, updatedAt: t.updatedAt, root: root.live }) }));
    const below = runningBelow(first.map(({ t, s }) => ({ ref: refOf(t.harnessId), parentRef: refOf(t.spawned!.parentId), active: isActive(s.state) })));
    return first.map(({ t, s: firstState }) => {
      const sp = t.spawned!;
      const ref = refOf(t.harnessId);
      const s = firstState.state === 'completed' && (below.get(ref) ?? 0) > 0 ? { state: 'waiting' as const, endedAt: null } : firstState;
      return {
        ref,
        harness: root.harness,
        agentId: t.harnessId,
        parentRef: refOf(sp.parentId),
        rootRef,
        depth: sp.depth,
        name: line(t.title, 80) || sp.nickname || 'Subagent',
        role: sp.role ?? sp.nickname ?? null,
        prompt: t.title && t.title !== sp.nickname ? t.title : null,
        state: s.state,
        background: false,
        startedAt: sp.bornAt ?? t.birthAt ?? t.updatedAt,
        updatedAt: t.updatedAt,
        endedAt: s.endedAt,
        activity: null,
        toolCallId: null,
        capabilities: capabilities(root.harness, s.state, root.live.live),
      } satisfies SubagentView;
    });
  }
}
