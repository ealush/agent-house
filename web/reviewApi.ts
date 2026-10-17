// Stack review's client (server/review/api.ts). Types mirror server/review/service.ts.
import { request } from './api.ts';

export type Checks = { pass: number; fail: number; pending: number; failing: string[] };
export type Verdict = { items: { id: number; verdict: 'addressed' | 'partly' | 'not'; evidence: string }[]; unrequested: { title: string; path: string | null; line: number | null }[]; summary: string };
export type RevView = { id: number; baseSha: string; headSha: string; patchId: string; files: number; additions: number; deletions: number; summary: string | null; verdict: Verdict | null };
export type LayerStatus = 'unreviewed' | 'changes' | 'fixing' | 'rereview' | 'approved' | 'merged' | 'closed' | 'skipped';
export type Gate = { key: 'reviewed' | 'findings' | 'checks' | 'mergeable' | 'base' | 'below' | 'order'; ok: boolean; label: string; detail?: string };
export type DispatchView = { id: number; pr: number; state: string; targetUid: string; targetTitle: string | null; targetAgent: string | null; sentAt: number; doneAt: number | null; findings: number[]; text: string };
export type Finding = {
  id: number;
  ownerPr: number;
  foundOnPr: number;
  title: string;
  body: string;
  severity: 'blocking' | 'should' | 'nit';
  state: 'proposed' | 'open' | 'sent' | 'addressed' | 'wontfix' | 'dismissed';
  source: string;
  path: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  ghUrl: string | null;
  ghThread: boolean;
  note: string | null;
  messageId: number | null;
  dispatchId: number | null;
  createdAt: number;
  /** Who moved it to its state ("you", "reviewer", "github"), when, and at which head. */
  stateBy: string | null;
  stateAt: number;
  stateHead: string | null;
};
export type Layer = {
  pr: number;
  role: string;
  position: number;
  title: string;
  url: string;
  author: string;
  state: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeable: string | null;
  checks: Checks;
  needs: string;
  status: LayerStatus;
  approved: boolean;
  samePatch: boolean;
  rebased: boolean;
  current: RevView | null;
  reviewed: RevView | null;
  open: number;
  /** Open findings whose layer already merged; they're fixed on this (the next open) layer. */
  followups: number;
  blocking: number;
  dispatch: DispatchView | null;
  gates: Gate[];
  ownerUid: string | null;
  /** The GitHub stack the PR is in, and its place there (1 at the bottom): GitHub merges it with the PRs under it. */
  ghStack: number | null;
  ghPos: number | null;
};
export type Owner = { uid: string; key: string; title: string; agent: string | null; status: string; live: boolean; branch: string | null } | null;
export type Stack = {
  id: string;
  title: string;
  repo: string;
  repoRoot: string;
  trunk: string;
  mergeMethod: 'merge' | 'squash' | 'rebase';
  methods: ('merge' | 'squash' | 'rebase')[];
  /** "tree": GitHub's chain under one PR (new ones join); "manual": the PRs you picked, in your order. */
  source: 'tree' | 'manual' | 'native';
  /** The stack on GitHub this one follows (source "native"). */
  ghStack: number | null;
  /** The agent session that made it: its conversation is the why behind the stack. */
  origin: Owner;
  /** Whether its open PRs can become a stack on GitHub (or go on top of one), and if not, why. null: nothing to link. */
  link: { ok: boolean; prs: number[]; onto: number | null; why: string | null } | null;
  planPath: string | null;
  state: string;
  syncedAt: number;
  syncError: string | null;
  syncing: boolean;
  owner: Owner;
  layers: Layer[];
  next: number | null;
  decisions: { id: number; text: string; fromPr: number | null; at: number }[];
};
export type StackSummary = { id: string; title: string; repo: string; trunk: string; state: string; source: 'tree' | 'manual' | 'native'; ghStack: number | null; layers: number; merged: number; needsYou: number; next: number | null; syncedAt: number; spine: { pr: number; role: string; status: LayerStatus }[] };
export type Candidate = { number: number; title: string; headRefName: string; baseRefName: string; draft: boolean; author: string; additions: number; deletions: number; updatedAt: string; inStack: string | null };
/** A stack on GitHub with open PRs, bottom to top. */
export type CandidateStack = { number: number; base: string; prs: number[] };
export type Candidates = { root: string; repo: string; trunk: string; trees: CandidateTree[]; stacks: { id: string; title: string }[]; native: CandidateStack[] };
export type CandidateTree = { pr: Candidate; children: CandidateTree[] };
/** The stack a session is building (server/review/service.ts SessionStack). */
export type SessionStack = {
  repo: string | null;
  root: string;
  trunk: string;
  source: 'gh-stack' | 'chain' | null;
  branch: string | null;
  ghStack: number | null;
  branches: {
    branch: string;
    current: boolean;
    pr: { number: number; title: string; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; draft: boolean; checks: Checks; additions: number; deletions: number } | null;
    layer: { status: LayerStatus; role: string } | null;
  }[];
  review: { id: string; title: string } | null;
  start: { native: number } | { prs: number[] } | null;
};
export type OwnerSuggestion = { uid: string; key: string; title: string; agent: string | null; status: string; cwd: string; branch: string | null; live: boolean; reason: 'branch' | 'repo'; origin: boolean };
export type ThreadMsg = { role: 'user' | 'assistant'; text: string; at: number; id: number };
export type Followup = { title: string; kind: 'session' | 'chat'; text: string };
export type DiffOut = { kind: 'patch' | 'range'; text: string; truncated: boolean; from: string; to: string };

const enc = encodeURIComponent;

/** Review calls on one host (base "" locally, "/h/<host>" through it). */
export function reviewApi(base = '') {
  const r = <T>(method: string, path: string, body?: unknown) => request<T>(method, `${base}/api/review${path}`, body);
  const s = (id: string) => `/stacks/${enc(id)}`;
  const l = (id: string, pr: number) => `${s(id)}/layers/${pr}`;
  return {
    repos: () => r<{ root: string; repo: string; trunk: string }[]>('GET', '/repos'),
    candidates: (root: string) => r<Candidates>('GET', `/candidates?root=${enc(root)}`),
    stacks: () => r<StackSummary[]>('GET', '/stacks'),
    sessionStack: (uid: string) => r<SessionStack>('GET', `/sessions/${enc(uid)}/stack`),
    settings: () => r<{ summaryId: string | null }>('GET', '/settings'),
    setSummaryModel: (summaryId: string | null) => r<{ summaryId: string | null }>('PUT', '/settings', { summaryId }),
    /** One PR takes GitHub's chain under it; a list is the PRs you picked, in review order. */
    link: (id: string) => r<Stack>('POST', `${s(id)}/link`),
    create: (root: string, pick: { pr: number } | { prs: number[] } | { native: number }, title?: string, from?: string) => r<Stack>('POST', '/stacks', { root, ...pick, ...(title ? { title } : {}), ...(from ? { from } : {}) }),
    addLayers: (id: string, prs: number[]) => r<Stack>('POST', `${s(id)}/layers`, { prs }),
    removeLayer: (id: string, pr: number) => r<Stack>('DELETE', l(id, pr)),
    stack: (id: string) => r<Stack>('GET', s(id)),
    update: (id: string, patch: { title?: string; planPath?: string | null; mergeMethod?: string; order?: number[]; ownerUid?: string | null; originUid?: string | null; state?: string }) => r<Stack>('PATCH', s(id), patch),
    remove: (id: string) => r('DELETE', s(id)),
    sync: (id: string) => r<Stack>('POST', `${s(id)}/sync`),
    owners: (id: string) => r<OwnerSuggestion[]>('GET', `${s(id)}/owners`),
    plan: (id: string) => r<{ path: string | null; text: string | null }>('GET', `${s(id)}/plan`),
    setLayer: (id: string, pr: number, patch: { role?: string; skipped?: boolean; ownerUid?: string | null }) => r<Stack>('PATCH', l(id, pr), patch),
    diff: (id: string, pr: number, mode: 'this' | 'since' | 'cumulative') => r<DiffOut>('GET', `${l(id, pr)}/diff?mode=${mode}`),
    busy: (id: string, pr: number) => r<{ summarizing: boolean; rechecking: boolean }>('GET', `${l(id, pr)}/busy`),
    summarize: (id: string, pr: number, force = false) => r<{ started: boolean; reason?: string }>('POST', `${l(id, pr)}/summary`, { force }),
    approve: (id: string, pr: number, approved = true) => r<Stack>('POST', `${l(id, pr)}/approve`, { approved }),
    accept: (id: string, pr: number, overrides: Record<number, 'addressed' | 'open'> = {}) => r<Stack>('POST', `${l(id, pr)}/accept`, { overrides }),
    importThreads: (id: string, pr: number) => r<{ added: number }>('POST', `${l(id, pr)}/threads`),
    merge: (id: string, pr: number, outOfOrder = false) => r<{ next: number | null; retargeted: number[]; restack: number[]; merged: number[]; waiting: 'github' | 'queue' | null }>('POST', `${l(id, pr)}/merge`, { outOfOrder }),
    retarget: (id: string, pr: number) => r<Stack>('POST', `${l(id, pr)}/retarget`),
    ready: (id: string, pr: number) => r<Stack>('POST', `${l(id, pr)}/ready`),
    dispatchText: (id: string, pr: number, findings: number[], extra = '', kind?: 'restack') =>
      r<{ text: string }>('GET', `${l(id, pr)}/dispatch?findings=${findings.join(',')}&extra=${enc(extra)}${kind ? `&kind=${kind}` : ''}`),
    dispatch: (id: string, pr: number, body: { findingIds: number[]; text: string; targetUid?: string }) => r<{ dispatch: DispatchView; outcome: string }>('POST', `${l(id, pr)}/dispatch`, body),
    findings: (id: string, pr?: number) => r<Finding[]>('GET', `${s(id)}/findings${pr ? `?pr=${pr}` : ''}`),
    addFinding: (id: string, body: { ownerPr: number; foundOnPr?: number; title: string; body?: string; severity?: string; path?: string | null; lineStart?: number | null; lineEnd?: number | null }) =>
      r<Finding>('POST', `${s(id)}/findings`, body),
    updateFinding: (id: string, fid: number, patch: { state?: string; severity?: string; title?: string; body?: string; ownerPr?: number; note?: string | null }) => r<Finding>('PATCH', `${s(id)}/findings/${fid}`, patch),
    resolveThread: (id: string, fid: number, body: string) => r<Finding>('POST', `${s(id)}/findings/${fid}/resolve`, { body }),
    addDecision: (id: string, text: string, fromPr: number | null) => r<Stack>('POST', `${s(id)}/decisions`, { text, fromPr }),
    removeDecision: (id: string, did: number) => r<Stack>('DELETE', `${s(id)}/decisions/${did}`),
    thread: (id: string, pr: number | null) => r<{ messages: ThreadMsg[]; findings: Finding[] }>('GET', `${s(id)}/chat${pr ? `?pr=${pr}` : ''}`),
    ask: (id: string, pr: number | null, text: string, subscriptionId?: string) =>
      r<{ message: ThreadMsg; followups: Followup[]; findings: Finding[] }>('POST', `${s(id)}/chat`, { text, pr, ...(subscriptionId ? { subscriptionId } : {}) }),
    clearThread: (id: string, pr: number | null) => r('DELETE', `${s(id)}/chat${pr ? `?pr=${pr}` : ''}`),
  };
}

export type ReviewApi = ReturnType<typeof reviewApi>;

export type ReviewRoute = { stack: string | null; pr: number | null; pick: boolean };

/** Where a review link points: the list, picking PRs (for a new stack, or to add to one), a stack, or one layer. */
export function reviewHash(stack?: string | null, pr?: number | null, pick = false): string {
  if (pick) return stack ? `review/${stack}/add` : 'review/new';
  return stack ? (pr ? `review/${stack}/${pr}` : `review/${stack}`) : 'review';
}

export function parseReviewHash(hash: string): ReviewRoute {
  const h = hash.replace(/^#/, '');
  if (h === 'review/new') return { stack: null, pr: null, pick: true };
  const m = h.match(/^review(?:\/([\w-]{4,40})(?:\/(\d+|add))?)?$/);
  return { stack: m?.[1] ?? null, pr: m?.[2] && m[2] !== 'add' ? Number(m[2]) : null, pick: m?.[2] === 'add' };
}

export const STATUS_WORD: Record<LayerStatus, string> = {
  unreviewed: 'To review',
  changes: 'Changes',
  fixing: 'Fixing',
  rereview: 'Re-review',
  approved: 'Reviewed',
  merged: 'Merged',
  closed: 'Closed',
  skipped: 'Skipped',
};

/** Pill class in the shared status vocabulary (web/status.ts): needs you, working, done. */
export const STATUS_PILL: Record<LayerStatus, string> = {
  unreviewed: '',
  changes: 'waiting',
  fixing: 'busy',
  rereview: 'waiting',
  approved: 'attention',
  merged: 'merged',
  closed: 'muted',
  skipped: 'muted',
};

export const layerName = (l: { role: string; pr: number }) => (l.role ? `${l.role}` : `#${l.pr}`);

/** A layer's place in the shared status vocabulary: needs you, an agent working, reviewed, merged, waiting its turn. */
export type Tone = 'todo' | 'needs' | 'busy' | 'ready' | 'merged' | 'off';
export function toneOf(status: LayerStatus): Tone {
  if (status === 'changes' || status === 'rereview') return 'needs';
  if (status === 'fixing') return 'busy';
  if (status === 'approved') return 'ready';
  if (status === 'merged') return 'merged';
  if (status === 'skipped' || status === 'closed') return 'off';
  return 'todo';
}
