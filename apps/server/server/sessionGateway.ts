// The Sessions context's door for every other context. Review, portable conversations,
// jobs, notes, recovery and migrations all need the same few things from sessions —
// start a configured agent, name a session by a ref, find its transcript, say something
// to it as a program — and each used to get its own copy of how, written into main.ts.
// Here they're written once, over Core; the composition root hands each context the
// ones it uses. Nothing here decides policy: launch rules are launch.ts's, sending is
// Core's.
import { stat } from 'node:fs/promises';
import { expandHome, type Config, type Preset } from './config.ts';
import type { Core, SendResult } from './core.ts';
import { withCatalog } from './catalog.ts';
import { buildLaunch, type LaunchSelection } from './launch.ts';
import { createWorktree, removeWorktree, type Worktree } from './git.ts';
import type { CheckoutsService } from './checkouts/service.ts';
import { discover, type Transcript } from './discovery.ts';
import { uidOfRef } from './registry.ts';
import type { Resolved } from './portable/service.ts';
import * as t from './tmux.ts';

export type AgentStart = {
  /** A configured agent: sessions start only from presets, never from a command line. */
  preset: string;
  selection?: LaunchSelection;
  cwd: string;
  name: string;
  /** A tmux session to start in when it still exists; otherwise the default one. */
  session?: string | null;
  uid?: string;
  /** Resume this conversation of the agent's, rather than start a new one. */
  resume?: string;
  /** In a new worktree of `root` (default: `cwd`), on a branch named for `label` (default: `name`), or `false` to opt out of automatic isolation. */
  worktree?: { root?: string; label?: string; fromRef?: string } | false;
  meta?: Record<string, unknown>;
};

export class SessionGateway {
  private core: Core;
  private config: Config;
  private checkouts: CheckoutsService | null;

  constructor(core: Core, config: Config, checkouts: CheckoutsService | null = null) {
    this.core = core;
    this.config = config;
    this.checkouts = checkouts;
  }

  /** Starts a configured agent, last in the list, and answers once its window is registered. */
  async startAgent(o: AgentStart): Promise<{ uid: string; windowId: string; preset: Preset; worktree: Worktree | null }> {
    const preset = await withCatalog(this.core.preset(o.preset));
    const plan = buildLaunch(preset, { ...o.selection, ...(o.resume ? { resume: o.resume } : {}) });
    const session = o.session && (await t.hasSession(o.session)) ? o.session : this.config.defaultSession;

    if (this.checkouts) {
      const uid = o.uid ?? this.core.registry.freshId();
      const explicitWorktree = o.worktree === false ? false : o.worktree ? true : o.resume ? false : undefined;
      const continued = o.meta?.['ah.continued'] as { fromUid?: string | null } | undefined;
      const acquired = await this.checkouts.acquireForLaunch({
        uid,
        preset,
        cwd: o.worktree && o.worktree.root ? o.worktree.root : o.cwd,
        name: o.worktree && o.worktree.label ? o.worktree.label : o.name,
        resumingInPlace: !!o.resume,
        explicitWorktree,
        fromRef: o.worktree ? o.worktree.fromRef : undefined,
        handOffFromUid: explicitWorktree === false ? (continued?.fromUid ?? null) : null,
        // Continued in this agent: stays in the source's checkout, whoever owns it.
        continuation: !!continued && explicitWorktree === false,
      });
      try {
        const out = await this.core.launch({
          preset,
          cwd: acquired.cwd,
          session,
          name: o.name,
          command: plan.command,
          uid,
          harnessId: o.resume,
          pendingResume: !!o.resume,
          env: acquired.env,
          meta: {
            ...plan.meta,
            ...o.meta,
            ...(acquired.worktree ? { 'ah.worktree': acquired.worktree } : {}),
            ...(acquired.checkoutId ? { 'ah.checkoutId': acquired.checkoutId } : {}),
            'ah.order': this.core.nextOrder(),
          },
        });
        await this.core.refreshTmuxPath();
        return { ...out, preset, worktree: acquired.worktree };
      } catch (err) {
        await acquired.rollback();
        throw err;
      }
    }

    const worktree = o.worktree ? await createWorktree(o.worktree.root ?? o.cwd, o.worktree.label ?? o.name, o.worktree.fromRef) : null;
    try {
      const out = await this.core.launch({
        preset,
        cwd: worktree?.path ?? o.cwd,
        session,
        name: o.name,
        command: plan.command,
        uid: o.uid,
        harnessId: o.resume,
        pendingResume: !!o.resume,
        meta: { ...plan.meta, ...o.meta, ...(worktree ? { 'ah.worktree': worktree } : {}), 'ah.order': this.core.nextOrder() },
      });
      await this.core.refreshTmuxPath();
      return { ...out, preset, worktree };
    } catch (err) {
      if (worktree) await removeWorktree(worktree.path, true).catch(() => {});
      throw err;
    }
  }

  /** Would this agent start with these choices? Throws the launch error if not. */
  async checkLaunch(id: string, sel: LaunchSelection): Promise<{ dangerous: boolean }> {
    const preset = await withCatalog(this.core.preset(id));
    buildLaunch(preset, sel);
    return { dangerous: !!preset.modes?.find((m) => m.id === sel.mode)?.dangerous };
  }

  /**
   * Says `text` to a session as a program (a job, a continuation, recovery), not as you:
   * with its idempotency id, and not remembered in your recent prompts.
   */
  sendAs(uid: string, text: string, id: string, actorUid?: string | null): Promise<SendResult> {
    return this.core.send(uid, text, true, undefined, { id, remember: false, actorUid });
  }

  /** The uid for a session uid or `harness:harnessId`, among the sessions ah knows. */
  uidOf(ref: string): string | null {
    return uidOfRef(this.core.registry.all(), ref);
  }

  queueIds(uid: string): string[] {
    return this.core.queue(uid).map((q) => q.id);
  }

  /** Something changed that the state should show: a pass soon, never awaited. */
  changed(): void {
    void this.core.tick().catch(() => {});
  }

  /** One conversation's transcript on disk. `fresh`: rescan now rather than trust the cached scan. */
  async findTranscript(harness: string, harnessId: string, o: { fresh?: boolean } = {}): Promise<Transcript | null> {
    const adapter = this.core.presets().find((p) => p.id === harness)?.feed ?? harness;
    const pick = (list: Transcript[]) => list.find((x) => x.harness === adapter && x.harnessId === harnessId) ?? null;
    if (o.fresh) return pick(await discover(0));
    // The cached scan first; a conversation that started since it was taken needs a fresh one.
    return pick(await discover()) ?? pick(await discover(0));
  }

  /** A session's transcript and the feed adapter that reads it, when it has both. */
  async transcriptOf(uid: string): Promise<{ file: string; adapter: string } | null> {
    const rec = this.core.registry.get(uid);
    if (!rec?.harnessId) return null;
    const adapter = this.core.presets().find((p) => p.id === rec.harness)?.feed;
    const found = adapter ? await this.findTranscript(rec.harness, rec.harnessId) : null;
    return found && adapter ? { file: found.file, adapter } : null;
  }

  /** A session uid or `harness:harnessId`, as portable conversations and migrations need it. */
  async resolveConversation(ref: string): Promise<Resolved | null> {
    const state = await this.core.current();
    const live = state.windows.find((w) => w.uid === ref);
    const rec = this.core.registry.get(ref);
    let harness: string | null;
    let harnessId: string | null;
    let cwd: string;
    let title: string;
    let model: string | null;
    if (live || rec) {
      harness = live?.agent ?? rec?.harness ?? null;
      harnessId = live?.harnessId ?? rec?.harnessId ?? null;
      cwd = expandHome(rec?.cwd ?? live!.cwd);
      title = live?.title || rec?.title || '';
      model = live?.model ?? rec?.model ?? null;
    } else {
      const i = ref.indexOf(':');
      if (i <= 0) return null;
      const found = await this.findTranscript(ref.slice(0, i), ref.slice(i + 1));
      if (!found) return null;
      const known = this.core.registry.all().find((r) => r.harness === ref.slice(0, i) && r.harnessId === found.harnessId);
      if (known) return this.resolveConversation(known.id);
      [harness, harnessId, cwd, title, model] = [ref.slice(0, i), found.harnessId, found.cwd, found.title, found.model ?? null];
    }
    if (!harness) return null;
    const file = harnessId ? ((await this.findTranscript(harness, harnessId))?.file ?? null) : null;
    // Busy by the agent's own hooks only: output alone (a terminal attaching redraws the
    // screen) is a guess, and a guess shouldn't refuse a continuation.
    return { uid: live?.uid ?? rec?.id ?? null, harness, harnessId, cwd, title, file, model, live: !!live, busy: live?.status === 'busy' && live.statusSource === 'hook', session: rec?.tmux?.session ?? null };
  }

  async isDir(p: string): Promise<boolean> {
    return !!(await stat(p).catch(() => null))?.isDirectory();
  }
}
