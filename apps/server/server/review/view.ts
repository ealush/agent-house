// What a review stack looks like now: every layer's status, its gates to merging, who
// owns it and what's in flight. Pure: buildStackView takes the stack's rows (as the
// database has them), the sessions and GitHub's stacks (as last fetched), and derives
// the view; ReviewService.view() reads those and calls it. The mappers from stored rows
// to their views live here too, so this module needs nothing from the service.
import type { ReviewDecision, ReviewDispatch, ReviewFinding, ReviewLayer, ReviewRevision, ReviewStack } from '@prisma/client';
import type { Checks, MergeMethod, NativeStack } from './gh.ts';
import type { Verdict } from './reviewer.ts';
import type { DispatchView, Gate, LayerStatus, LayerView, Owner, RevView, SessionLite, StackView } from './service.ts';
import { resolveSession } from './owners.ts';

export const OPEN_FINDING = ['open', 'sent'];
export const ACTIVE_DISPATCH = ['sent', 'working'];
export const label = (l: { role: string; pr: number }) => (l.role ? `${l.role} #${l.pr}` : `#${l.pr}`);

export const sourceOf = (s: ReviewStack): StackView['source'] => (s.source === 'manual' || s.source === 'native' ? s.source : 'tree');

export function checksOf(l: ReviewLayer): Checks {
  try {
    const c = JSON.parse(l.checksJson) as Checks;
    return { pass: c.pass ?? 0, fail: c.fail ?? 0, pending: c.pending ?? 0, failing: c.failing ?? [] };
  } catch {
    return { pass: 0, fail: 0, pending: 0, failing: [] };
  }
}

/** A revision's stored verdict; one that doesn't parse (a reviewer's malformed answer) is none. */
export function verdictOf(r: { verdictJson: string | null } | null | undefined): Verdict | null {
  try {
    return r?.verdictJson ? (JSON.parse(r.verdictJson) as Verdict) : null;
  } catch {
    return null;
  }
}

export function revView(r: ReviewRevision | undefined | null): RevView | null {
  if (!r) return null;
  const verdict = verdictOf(r);
  return { id: r.id, baseSha: r.baseSha, headSha: r.headSha, patchId: r.patchId, files: r.files, additions: r.additions, deletions: r.deletions, summary: r.summary, verdict };
}

/**
 * How a stack's open layers would become a stack on GitHub: all of them, in
 * order, each based on the one before; or, when its bottom layers already are
 * the top of one, the rest on top of that.
 */
export function linkPlan(layers: Pick<LayerView, 'pr' | 'role' | 'state' | 'headRef' | 'baseRef' | 'ghStack'>[], natives: NativeStack[]): StackView['link'] {
  const open = layers.filter((l) => l.state === 'open' || l.state === 'skipped');
  const no = (why: string) => ({ ok: false, prs: [], onto: null, why });
  const stacks = [...new Set(open.map((l) => l.ghStack).filter((n): n is number => n !== null))];
  if (stacks.length === 1 && open.every((l) => l.ghStack === stacks[0])) return null;
  if (open.length < 2) return null;
  if (stacks.length > 1) return no(`its pull requests are in ${stacks.length} stacks on GitHub`);
  const inStack = open.filter((l) => l.ghStack !== null).length;
  if (open.slice(0, inStack).some((l) => l.ghStack === null)) return no('only its bottom layers can already be a stack on GitHub');
  const ns = stacks.length ? natives.find((n) => n.number === stacks[0]) : undefined;
  if (stacks.length && ns && ns.prs.filter((p) => p.open).at(-1)?.number !== open[inStack - 1].pr) return no(`stack #${stacks[0]} on GitHub goes on past #${open[inStack - 1].pr}`);
  for (let i = Math.max(1, inStack); i < open.length; i++) {
    if (open[i].baseRef !== open[i - 1].headRef) return no(`#${open[i].pr} isn't built on #${open[i - 1].pr}, the layer before it`);
  }
  const rest = open.slice(inStack);
  const skipped = rest.find((l) => l.state === 'skipped');
  if (skipped) return no(`#${skipped.pr} is skipped here`);
  return { ok: true, prs: rest.map((l) => l.pr), onto: stacks[0] ?? null, why: null };
}

/** A stack's rows, as the database has them. */
export type StackRows = { layers: ReviewLayer[]; revs: ReviewRevision[]; findings: ReviewFinding[]; dispatches: ReviewDispatch[]; decisions: ReviewDecision[] };

/** What else a view shows: the sessions that could own it, GitHub's stacks, the repo's merge methods, a sync in flight. */
export type StackContext = { sessions: readonly SessionLite[]; natives: NativeStack[]; methods: MergeMethod[]; syncing: boolean };

/** `rows.layers` in position order and `rows.dispatches` newest first, as ReviewService reads them. */
export function buildStackView(s: ReviewStack, rows: StackRows, ctx: StackContext): StackView {
  const { layers, revs, findings, dispatches, decisions } = rows;
  const { sessions, natives } = ctx;
  const revById = new Map(revs.map((r) => [r.id, r]));
  const ownerOf = (uid: string | null, key: string | null): Owner => {
    if (!uid && !key) return null;
    const sess = resolveSession(sessions, key, uid);
    return sess ? { uid: sess.uid, key: sess.key, title: sess.title, agent: sess.agent, status: sess.status, live: sess.live, branch: sess.branch } : { uid: uid ?? '', key: key ?? '', title: 'Ended session', agent: null, status: 'ended', live: false, branch: null };
  };
  const firstOpen = layers.find((l) => l.state === 'open')?.pr ?? null;
  const views: LayerView[] = layers.map((l) => {
    const current = l.currentRevId ? revById.get(l.currentRevId) : undefined;
    const reviewed = l.reviewedRevId ? revById.get(l.reviewedRevId) : undefined;
    const mine = findings.filter((f) => f.ownerPr === l.pr && OPEN_FINDING.includes(f.state));
    const blocking = mine.filter((f) => f.severity === 'blocking').length;
    const d = dispatches.find((x) => x.pr === l.pr);
    const samePatch = !!current && !!reviewed && current.patchId === reviewed.patchId;
    const rebased = samePatch && (current!.headSha !== reviewed!.headSha || current!.baseSha !== reviewed!.baseSha);
    const active = !!d && ACTIVE_DISPATCH.includes(d.state);
    const status: LayerStatus =
      l.state !== 'open'
        ? (l.state as LayerStatus)
        : active
          ? 'fixing'
          : reviewed && !samePatch
            ? 'rereview'
            : l.approved && samePatch
              ? 'approved'
              : mine.length
                ? 'changes'
                : 'unreviewed';
    const checks = checksOf(l);
    const lands = (l.ghStack !== null && natives.find((n) => n.number === l.ghStack)?.base) || null;
    const blocked =
      l.needs === 'merging'
        ? 'GitHub is merging it'
        : l.needs === 'queued'
          ? 'In the merge queue'
          : l.ghStack !== null && l.needs === 'restack'
            ? `Not on top of ${l.baseRef}: needs a restack`
            : l.mergeable === 'CONFLICTING'
              ? `Conflicts with ${l.baseRef}`
              : undefined;
    const gates: Gate[] =
      l.state !== 'open'
        ? []
        : [
            {
              key: 'reviewed',
              ok: l.approved && samePatch,
              label: 'Reviewed revision is current',
              detail: !reviewed || !l.approved ? 'Not marked reviewed yet' : !samePatch ? 'Changed since your review' : rebased ? 'Rebased since your review, same patch' : undefined,
            },
            { key: 'findings', ok: blocking === 0, label: 'No open blocking findings', detail: blocking ? `${blocking} blocking` : mine.length ? `${mine.length} open, none blocking` : undefined },
            {
              key: 'checks',
              ok: checks.fail === 0 && checks.pending === 0,
              label: 'Checks passed',
              detail: checks.fail ? `Failing: ${checks.failing.join(', ')}` : checks.pending ? `${checks.pending} check${checks.pending === 1 ? '' : 's'} running` : checks.pass ? undefined : 'No checks reported',
            },
            { key: 'mergeable', ok: !l.draft && !blocked, label: l.draft ? 'Draft' : 'Mergeable', detail: l.draft ? 'Mark it ready first' : blocked },
            // A PR in a GitHub stack lands in the stack's base, whatever branch it targets now.
            l.ghStack !== null
              ? { key: 'base', ok: (lands ?? s.trunk) === s.trunk, label: `Lands in ${s.trunk}`, detail: (lands ?? s.trunk) === s.trunk ? undefined : `GitHub's stack #${l.ghStack} lands in ${lands}` }
              : { key: 'base', ok: l.baseRef === s.trunk, label: `Targets ${s.trunk}`, detail: l.baseRef === s.trunk ? undefined : `Targets ${l.baseRef}` },
            { key: 'order', ok: firstOpen === l.pr, label: 'Next in merge order', detail: firstOpen === l.pr ? undefined : `#${firstOpen} comes first` },
          ];
    const dv: DispatchView | null = d
      ? { id: d.id, pr: d.pr, kind: d.kind, state: d.state, targetUid: d.targetUid, targetTitle: ownerOf(d.targetUid, d.targetKey)?.title ?? null, targetAgent: ownerOf(d.targetUid, d.targetKey)?.agent ?? null, sentAt: d.sentAt, doneAt: d.doneAt, findings: findings.filter((f) => f.dispatchId === d.id).map((f) => f.id), text: d.text }
      : null;
    return {
      pr: l.pr,
      role: l.role,
      position: l.position,
      title: l.title,
      url: l.url,
      author: l.author,
      state: l.state,
      draft: l.draft,
      headRef: l.headRef,
      baseRef: l.baseRef,
      headSha: l.headSha,
      mergeable: l.mergeable,
      checks,
      needs: l.needs,
      status,
      approved: l.approved,
      samePatch,
      rebased,
      current: revView(current),
      reviewed: revView(reviewed),
      open: mine.length,
      followups: l.pr === firstOpen ? findings.filter((f) => f.state === 'open' && layers.find((x) => x.pr === f.ownerPr)?.state === 'merged').length : 0,
      blocking,
      dispatch: dv,
      gates,
      ownerUid: l.ownerUid,
      ghStack: l.ghStack,
      ghPos: l.ghPos,
    };
  });
  // GitHub merges a PR of its stack with every unmerged PR under it, so those have to be ready too.
  for (const v of views) {
    if (v.state !== 'open' || v.ghStack === null || v.ghPos === null) continue;
    const under = views.filter((x) => x.ghStack === v.ghStack && x.ghPos !== null && x.ghPos < v.ghPos! && (x.state === 'open' || x.state === 'skipped'));
    const ns = natives.find((n) => n.number === v.ghStack);
    const outside = (ns?.prs ?? []).filter((p, i) => i + 1 < v.ghPos! && p.open && !p.merged && !views.some((x) => x.pr === p.number));
    if (!under.length && !outside.length) continue;
    const why = (x: LayerView) => {
      const g = x.gates.find((y) => !y.ok && y.key !== 'order' && y.key !== 'below');
      return x.state === 'skipped' ? 'skipped here' : g ? (g.detail ?? g.label).replace(/^./, (c) => c.toLowerCase()) : null;
    };
    const unready = under.map((x) => ({ x, g: why(x) })).find((u) => u.g);
    const names = under.map((x) => label(x)).join(', ');
    v.gates.splice(v.gates.length - 1, 0, {
      key: 'below',
      ok: !outside.length && !unready,
      label: 'The layers under it can merge',
      detail: outside.length ? `#${outside[0].number} merges with it and isn't in this review` : unready ? `${label(unready.x)} merges with it: ${unready.g}` : `${names} merge${under.length === 1 ? 's' : ''} with it`,
    });
  }
  return {
    id: s.id,
    title: s.title,
    repo: s.repo,
    repoRoot: s.repoRoot,
    trunk: s.trunk,
    mergeMethod: s.mergeMethod,
    methods: ctx.methods,
    source: sourceOf(s),
    ghStack: s.ghStack,
    origin: ownerOf(s.originUid, s.originKey),
    link: linkPlan(views, natives),
    planPath: s.planPath,
    state: s.state,
    syncedAt: s.syncedAt,
    syncError: s.syncError,
    syncing: ctx.syncing,
    owner: ownerOf(s.ownerUid, s.ownerKey),
    layers: views,
    next: firstOpen,
    decisions: decisions.map((d) => ({ id: d.id, text: d.text, fromPr: d.fromPr, at: d.at })),
  };
}
