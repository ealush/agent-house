// The stack reviewer: a model you pick under Settings → Subscriptions,
// talking about exact revisions through read-only tools. It proposes
// findings, follow-ups and verdicts; it cannot merge, push, retarget,
// resolve threads, or send anything to an agent. Every action is a button.
import type { Checks, ReviewThread } from './gh.ts';
import { commits, diff, mergeBase, showAt, sinceReview } from './git.ts';
import { parseObject, parseStructured, type Followup, type ToolDef } from '../sidechat.ts';

const TOOL_LIMIT = 12_000;
const INLINE_DIFF = 14_000;
const PLAN_EXCERPT = 6_000;

export type LayerCtx = {
  pr: number;
  role: string;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
  /** Current revision; null until the layer has synced. */
  base: string | null;
  head: string | null;
  /** The revision you last reviewed. */
  reviewed: { base: string; head: string } | null;
  stat: { files: number; additions: number; deletions: number } | null;
  checks: Checks;
};

export type FindingLite = { id: number; ownerPr: number; title: string; body: string; severity: string; state: string; path: string | null; lineStart: number | null; source: string };

/** What the reviewer can see. Built by the service per request. */
export type ReviewEnv = {
  root: string;
  repo: string;
  trunk: string;
  title: string;
  order: number[];
  layers: LayerCtx[];
  trunkTip: () => Promise<string | null>;
  plan: () => Promise<string | null>;
  body: (pr: number) => Promise<string>;
  findings: () => Promise<FindingLite[]>;
  decisions: () => Promise<string[]>;
  threads: (pr: number) => Promise<ReviewThread[]>;
};

const num = { type: 'number' } as const;
const PR = { type: 'number', description: 'PR number of a layer in this stack.' } as const;
const MAX = { type: 'number', description: `Cap on returned characters (default ${TOOL_LIMIT}, max 60000).` } as const;

export const REVIEW_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'stack_map',
      description: 'Every layer in merge order: role, PR, title, state, base branch, size, checks, open findings. Call first when you need the shape of the stack.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'layer_diff',
      description:
        "A layer's patch at its current revision. mode: 'this' = what the PR itself changes (vs the layer below); 'cumulative' = everything from the trunk up to this layer; 'since_review' = what changed since the revision the human last reviewed; 'next' = the patches of the layers directly above, to see how this one is used. Narrow with paths on large layers.",
      parameters: {
        type: 'object',
        properties: { pr: PR, mode: { type: 'string', enum: ['this', 'cumulative', 'since_review', 'next'] }, paths: { type: 'array', items: { type: 'string' } }, max_chars: MAX },
        required: ['pr'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: "A whole file at an exact revision: a layer's head (default) or base, or the trunk.",
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, pr: PR, at: { type: 'string', enum: ['head', 'base', 'trunk'] }, max_chars: MAX },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: { name: 'commits', description: "A layer's commits, oldest first.", parameters: { type: 'object', properties: { pr: PR }, required: ['pr'], additionalProperties: false } },
  },
  {
    type: 'function',
    function: {
      name: 'pr_info',
      description: "A layer's PR description, checks and state.",
      parameters: { type: 'object', properties: { pr: PR }, required: ['pr'], additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'plan',
      description: "The human's plan for this stack (contracts, ownership, budgets). Optionally one section, by words from its heading.",
      parameters: { type: 'object', properties: { section: { type: 'string' }, max_chars: MAX }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'findings',
      description: 'Findings recorded so far (all layers, or one), with their state.',
      parameters: { type: 'object', properties: { pr: num }, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pr_threads',
      description: 'Review threads on a layer\'s PR on GitHub, from people and bots, with whether each is resolved.',
      parameters: { type: 'object', properties: { pr: PR }, required: ['pr'], additionalProperties: false },
    },
  },
];

function cap(args: Record<string, unknown>): number {
  const n = args.max_chars;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(60_000, Math.max(1000, Math.floor(n))) : TOOL_LIMIT;
}

function clip(text: string, max: number, note = 'truncated'): string {
  return text.length > max ? `${text.slice(0, max)}\n... (${note}; narrow with paths or max_chars)` : text;
}

function label(l: LayerCtx): string {
  return `${l.role ? `${l.role} ` : ''}#${l.pr}`;
}

export function stackMap(env: ReviewEnv, findings: FindingLite[]): string {
  const lines = env.order.map((n, i) => {
    const l = env.layers.find((x) => x.pr === n);
    if (!l) return '';
    const open = findings.filter((f) => f.ownerPr === n && (f.state === 'open' || f.state === 'sent')).length;
    const size = l.stat ? `${l.stat.files} files +${l.stat.additions} −${l.stat.deletions}` : 'not synced';
    const checks = l.checks.fail ? `checks failing (${l.checks.failing.join(', ')})` : l.checks.pending ? 'checks pending' : 'checks green';
    return `${i + 1}. ${label(l)} "${l.title}" [${l.state}${l.draft ? ', draft' : ''}] on ${l.baseRef} · ${size} · ${checks}${open ? ` · ${open} open findings` : ''}`;
  });
  return [`Stack "${env.title}" in ${env.repo}, trunk ${env.trunk}, merge order:`, ...lines.filter(Boolean)].join('\n');
}

function sectionOf(plan: string, words: string): string | null {
  const want = words.toLowerCase().split(/\s+/).filter(Boolean);
  const parts = plan.split(/(?=^#{1,4} )/m);
  const hit = parts.find((p) => {
    const head = p.split('\n', 1)[0].toLowerCase();
    return head.startsWith('#') && want.every((w) => head.includes(w));
  });
  return hit ?? null;
}

/** One reviewer tool call. Never throws: bad input and git failures become notes. */
export async function runReviewTool(env: ReviewEnv, name: string, raw: unknown): Promise<string> {
  try {
    const args = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const layer = (): LayerCtx | string => {
      const n = Number(args.pr);
      const l = env.layers.find((x) => x.pr === n);
      if (!l) return `#${args.pr} is not a layer of this stack. Layers: ${env.order.map((n) => `#${n}`).join(', ')}.`;
      return l;
    };
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, 50) : undefined;
    switch (name) {
      case 'stack_map':
        return stackMap(env, await env.findings());
      case 'layer_diff': {
        const l = layer();
        if (typeof l === 'string') return l;
        if (!l.base || !l.head) return `${label(l)} has not been fetched (${l.state}).`;
        const mode = typeof args.mode === 'string' ? args.mode : 'this';
        if (mode === 'this') return clip((await diff(env.root, l.base, l.head, paths)).patch || '(empty patch)', cap(args));
        if (mode === 'cumulative') {
          const tip = await env.trunkTip();
          const from = tip ? await mergeBase(env.root, tip, l.head) : null;
          if (!from) return `The trunk (${env.trunk}) is not available locally.`;
          return clip((await diff(env.root, from, l.head, paths)).patch || '(empty patch)', cap(args));
        }
        if (mode === 'since_review') {
          if (!l.reviewed) return `${label(l)} has not been reviewed yet; use mode 'this'.`;
          if (l.reviewed.head === l.head && l.reviewed.base === l.base) return 'Nothing changed since the review.';
          const s = await sinceReview(env.root, l.reviewed, { base: l.base, head: l.head });
          return clip(`${s.kind === 'range' ? 'Rebased since the review; git range-diff of the old and new commits:\n' : ''}${s.text || '(no changes)'}`, cap(args));
        }
        if (mode === 'next') {
          const above = env.layers.filter((c) => c.baseRef === l.headRef && c.base && c.head);
          if (!above.length) return `Nothing in this stack sits on ${label(l)}.`;
          const each = Math.floor(cap(args) / above.length);
          const out: string[] = [];
          for (const c of above) out.push(`=== ${label(c)} "${c.title}"\n${clip((await diff(env.root, c.base!, c.head!, paths)).patch || '(empty patch)', each)}`);
          return out.join('\n\n');
        }
        return "mode must be 'this', 'cumulative', 'since_review' or 'next'.";
      }
      case 'read_file': {
        if (typeof args.path !== 'string') return 'read_file needs a path.';
        const at = args.at === 'base' || args.at === 'trunk' ? args.at : 'head';
        if (at === 'trunk') {
          const tip = await env.trunkTip();
          return tip ? await showAt(env.root, tip, args.path, cap(args)) : 'The trunk is not available locally.';
        }
        const l = args.pr === undefined ? env.layers.find((x) => x.head) : layer();
        if (!l || typeof l === 'string') return l ?? 'No layer has been fetched.';
        const sha = at === 'base' ? l.base : l.head;
        return sha ? await showAt(env.root, sha, args.path, cap(args)) : `${label(l)} has not been fetched.`;
      }
      case 'commits': {
        const l = layer();
        if (typeof l === 'string') return l;
        return l.base && l.head ? (await commits(env.root, l.base, l.head)) || '(no commits)' : `${label(l)} has not been fetched.`;
      }
      case 'pr_info': {
        const l = layer();
        if (typeof l === 'string') return l;
        const body = await env.body(l.pr);
        const c = l.checks;
        return [`${label(l)} ${l.title}`, l.url, `State: ${l.state}${l.draft ? ' (draft)' : ''}`, `Base: ${l.baseRef}  Head: ${l.headRef}`, `Checks: ${c.pass} pass, ${c.fail} fail, ${c.pending} pending${c.failing.length ? ` (failing: ${c.failing.join(', ')})` : ''}`, '', clip(body || '(no description)', 8000)].join('\n');
      }
      case 'plan': {
        const plan = await env.plan();
        if (!plan) return 'This stack has no plan file; the root PR description is the closest thing (pr_info).';
        if (typeof args.section === 'string' && args.section.trim()) return clip(sectionOf(plan, args.section) ?? `No heading matches "${args.section}".`, cap(args));
        return clip(plan, cap(args));
      }
      case 'findings': {
        const all = await env.findings();
        const pick = args.pr === undefined ? all : all.filter((f) => f.ownerPr === Number(args.pr));
        if (!pick.length) return 'No findings recorded.';
        return pick.map((f) => `F${f.id} [${f.severity}, ${f.state}] #${f.ownerPr} ${f.title}${f.path ? ` (${f.path}${f.lineStart ? `:${f.lineStart}` : ''})` : ''} — from ${f.source}${f.body ? `\n   ${f.body.slice(0, 400)}` : ''}`).join('\n');
      }
      case 'pr_threads': {
        const l = layer();
        if (typeof l === 'string') return l;
        const ts = await env.threads(l.pr);
        if (!ts.length) return 'No review threads.';
        return clip(
          ts
            .map((t) => `${t.resolved ? '[resolved]' : '[open]'}${t.outdated ? '[outdated]' : ''} ${t.path ?? ''}${t.line ? `:${t.line}` : ''}\n${t.comments.map((c) => `  ${c.author}: ${c.body.slice(0, 1200)}`).join('\n')}`)
            .join('\n\n'),
          cap(args),
        );
      }
      default:
        return `Unknown tool: ${name}.`;
    }
  } catch (err) {
    return `Tool failed: ${err instanceof Error ? err.message : 'unknown error'}`;
  }
}

const ROLE = [
  'You are the reviewer inside "ah", reviewing a stack of pull requests that coding agents wrote for the human you are talking to. The human owns the architecture and makes every decision; the agents implemented it.',
  'Be an independent, critical reviewer: correctness, contracts in the plan, accepted decisions, layering (does this belong in this layer, or another), unnecessary abstractions, tests that would catch a regression. Not style nits unless asked.',
  'You read exact revisions through read-only tools; call them instead of guessing. You cannot run code, tests, or change anything, and you never claim to have.',
  'Name files and lines (path:line) for every claim about code.',
].join(' ');

const ENVELOPE = [
  'Format content as GitHub-flavored markdown: short sections under ### headings, - bullets, fenced code with language tags.',
  'Reply with ONLY a JSON object, no fences, no other text:',
  '{"content": "markdown answer", "followups": [{"title": "4 words max", "kind": "session|chat", "text": "..."}], "findings": [{"title": "short imperative", "body": "why, and what to change", "severity": "blocking|should|nit", "path": "repo/relative.ts", "line_start": 1, "line_end": 2, "owner_pr": 123}]}.',
  'findings: 0-4 concrete changes you recommend, each one the human could send to the agent as is; owner_pr is the layer that should change (it may differ from the one being discussed). Leave findings empty when answering a question that needs no change.',
  'A "session" followup sends its text to the agent that owns the stack; a "chat" followup asks you a premade question. 0-2, only when useful.',
].join(' ');

export type Scope = { pr: number | null };

async function contextBlock(env: ReviewEnv, scope: Scope, extra: { summary?: string | null }): Promise<string> {
  const [findings, decisions, plan] = await Promise.all([env.findings(), env.decisions(), env.plan()]);
  const parts = [stackMap(env, findings)];
  if (decisions.length) parts.push(`Decisions the human accepted (hold the code to these):\n${decisions.map((d) => `- ${d}`).join('\n')}`);
  if (plan) parts.push(`Plan (first part; the plan tool has the rest):\n${plan.slice(0, PLAN_EXCERPT)}${plan.length > PLAN_EXCERPT ? '\n...' : ''}`);
  const l = scope.pr === null ? null : env.layers.find((x) => x.pr === scope.pr);
  if (l) {
    parts.push(`You are reviewing ${label(l)} "${l.title}" (${l.headRef} on ${l.baseRef}). Default scope is this layer's own change; widen only when the question needs it.`);
    if (extra.summary) parts.push(`Summary of this layer:\n${extra.summary}`);
    const mine = findings.filter((f) => f.ownerPr === l.pr && f.state !== 'dismissed' && f.state !== 'proposed');
    if (mine.length) parts.push(`Findings on this layer:\n${mine.map((f) => `- F${f.id} [${f.severity}, ${f.state}] ${f.title}${f.path ? ` (${f.path}${f.lineStart ? `:${f.lineStart}` : ''})` : ''}`).join('\n')}`);
    if (l.base && l.head) {
      const d = await diff(env.root, l.base, l.head).catch(() => null);
      if (d && d.patch.length <= INLINE_DIFF) parts.push(`This layer's patch:\n${d.patch || '(empty)'}`);
      else if (d) parts.push(`This layer's patch is ${Math.round(d.patch.length / 1000)}k characters; read it with layer_diff (narrow with paths).`);
    }
  } else parts.push('You are discussing the stack as a whole: its shape, ownership of behavior between layers, and whether the architecture holds together.');
  return parts.join('\n\n');
}

export type ProposedFinding = { title: string; body: string; severity: 'blocking' | 'should' | 'nit'; path: string | null; lineStart: number | null; lineEnd: number | null; ownerPr: number | null };

/** The reviewer's reply: answer, follow-ups, and proposed findings (dropped when misshapen). */
export function parseReply(raw: string, layers: number[]): { content: string; followups: Followup[]; findings: ProposedFinding[] } {
  const { content, followups } = parseStructured(raw);
  const obj = parseObject(raw) as { findings?: unknown } | undefined;
  const findings: ProposedFinding[] = [];
  if (obj && Array.isArray(obj.findings)) {
    for (const f of obj.findings) {
      if (findings.length >= 4) break;
      if (!f || typeof f !== 'object') continue;
      const x = f as Record<string, unknown>;
      if (typeof x.title !== 'string' || !x.title.trim()) continue;
      const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);
      const owner = int(x.owner_pr);
      findings.push({
        title: x.title.trim().slice(0, 140),
        body: typeof x.body === 'string' ? x.body.trim().slice(0, 4000) : '',
        severity: x.severity === 'blocking' || x.severity === 'nit' ? x.severity : 'should',
        path: typeof x.path === 'string' && x.path.trim() ? x.path.trim().slice(0, 300) : null,
        lineStart: int(x.line_start),
        lineEnd: int(x.line_end),
        ownerPr: owner && layers.includes(owner) ? owner : null,
      });
    }
  }
  return { content, followups, findings };
}

export async function reviewMessages(env: ReviewEnv, scope: Scope, history: { role: 'user' | 'assistant'; text: string }[], text: string, summary: string | null): Promise<Record<string, unknown>[]> {
  return [
    { role: 'system', content: `${ROLE} ${ENVELOPE}\n\n${await contextBlock(env, scope, { summary })}` },
    ...history.map((m) => ({ role: m.role, content: m.text })),
    { role: 'user', content: text },
  ];
}

/** Messages for a layer's summary: what it does, how it fits, where to look, tests. Plain markdown. */
export async function summaryMessages(env: ReviewEnv, pr: number): Promise<Record<string, unknown>[]> {
  return [
    {
      role: 'system',
      content: [
        ROLE,
        'Write a briefing for the human before they review this layer. Plain markdown, no JSON, no title, under 220 words, these sections:',
        '### What it does (2-4 bullets) · ### How it fits (1-3 bullets: what it builds on, what the layers above need from it, anything the plan says it owns) · ### Look closely at (0-4 bullets of risks, each with path:line) · ### Tests (what the change covers, what it leaves out).',
      ].join(' '),
    },
    { role: 'user', content: await contextBlock(env, { pr }, {}) },
  ];
}

export type Verdict = { items: { id: number; verdict: 'addressed' | 'partly' | 'not'; evidence: string }[]; unrequested: { title: string; path: string | null; line: number | null }[]; summary: string };

/** Messages for a re-review: which sent findings the new revision addresses, and what else changed. */
export async function recheckMessages(env: ReviewEnv, pr: number, sent: FindingLite[]): Promise<Record<string, unknown>[]> {
  const l = env.layers.find((x) => x.pr === pr)!;
  const since = l.reviewed && l.base && l.head ? await sinceReview(env.root, l.reviewed, { base: l.base, head: l.head }).catch(() => null) : null;
  return [
    {
      role: 'system',
      content: [
        ROLE,
        'The human sent these findings to the agent, and the agent pushed a new revision. For each finding, judge from the code whether it is addressed, partly addressed, or not, citing path:line.',
        'Then list changes nobody asked for (behavior changes, new APIs, removed tests), and one summary line.',
        'Reply with ONLY JSON: {"items": [{"id": 1, "verdict": "addressed|partly|not", "evidence": "path:line — what you saw"}], "unrequested": [{"title": "...", "path": "...", "line": 1}], "summary": "one line"}.',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Layer ${label(l)} "${l.title}".`,
        `Findings sent:\n${sent.map((f) => `- id ${f.id} [${f.severity}] ${f.title}${f.path ? ` (${f.path}${f.lineStart ? `:${f.lineStart}` : ''})` : ''}: ${f.body.slice(0, 1500)}`).join('\n')}`,
        since ? `What changed since the review (${since.kind === 'range' ? 'rebased: git range-diff' : 'diff of the heads'}):\n${clip(since.text, 40_000)}` : 'The diff since the review is unavailable; use layer_diff.',
      ].join('\n\n'),
    },
  ];
}

export function parseVerdict(raw: string, ids: number[]): Verdict | null {
  const obj = parseObject(raw) as { items?: unknown; unrequested?: unknown; summary?: unknown } | undefined;
  if (!obj || !Array.isArray(obj.items)) return null;
  const items: Verdict['items'] = [];
  for (const it of obj.items) {
    if (!it || typeof it !== 'object') continue;
    const x = it as Record<string, unknown>;
    const id = Number(x.id);
    if (!ids.includes(id) || items.some((i) => i.id === id)) continue;
    const verdict = x.verdict === 'addressed' || x.verdict === 'partly' ? x.verdict : 'not';
    items.push({ id, verdict, evidence: typeof x.evidence === 'string' ? x.evidence.slice(0, 600) : '' });
  }
  const unrequested: Verdict['unrequested'] = [];
  if (Array.isArray(obj.unrequested)) {
    for (const u of obj.unrequested.slice(0, 6)) {
      if (!u || typeof u !== 'object') continue;
      const x = u as Record<string, unknown>;
      if (typeof x.title !== 'string' || !x.title.trim()) continue;
      unrequested.push({ title: x.title.slice(0, 200), path: typeof x.path === 'string' ? x.path.slice(0, 300) : null, line: typeof x.line === 'number' ? x.line : null });
    }
  }
  return { items, unrequested, summary: typeof obj.summary === 'string' ? obj.summary.slice(0, 300) : '' };
}
