// Pure supervision, unidirectional hierarchy control (`CoS > session`), attention-routing,
// and external approval-guardrail policies for cross-session orchestration.
// Zero I/O: tested directly with plain values.
import type { Ask } from './sessions.ts';
import { DomainError } from './errors.ts';

export type SessionRole = 'chief' | 'worker' | 'reviewer';
export const SESSION_ROLES: readonly SessionRole[] = ['chief', 'worker', 'reviewer'];

export type Supervision = {
  role?: SessionRole;
  /** The supervising session uid that manages this session (null/absent = unmanaged). */
  managedBy?: string | null;
  /** Optional Space name this Chief of Staff is scoped to (absent = fleet-wide). */
  space?: string | null;
  /** Suppress direct user push alerts while `managedBy` is live; fails open after `escalateAfterSeconds`. */
  muteAlerts?: boolean;
  /** Seconds a waiting prompt stays muted before failing open to the user (default 120). */
  escalateAfterSeconds?: number;
  /** Labels for grouping sessions across tasks/domains. */
  tags?: string[];
};

export type SupervisionGraph = ReadonlyMap<string, Supervision>;

export const DEFAULT_ESCALATE_AFTER_S = 120;

export class SupervisionError extends DomainError {
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
  }
}

/** Reads `ah.supervision` from a session record's metadata, returning null when absent/empty. */
export function supervisionOf(meta: Record<string, unknown> | undefined): Supervision | null {
  const raw = meta?.['ah.supervision'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const out: Supervision = {};
  if (typeof s.role === 'string' && (SESSION_ROLES as readonly string[]).includes(s.role)) out.role = s.role as SessionRole;
  if (typeof s.managedBy === 'string' && s.managedBy) out.managedBy = s.managedBy;
  if (typeof s.space === 'string' && s.space.trim()) out.space = s.space.trim().slice(0, 64);
  if (typeof s.muteAlerts === 'boolean') out.muteAlerts = s.muteAlerts;
  if (typeof s.escalateAfterSeconds === 'number' && Number.isFinite(s.escalateAfterSeconds)) out.escalateAfterSeconds = s.escalateAfterSeconds;
  if (Array.isArray(s.tags)) {
    const tags = s.tags.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 20);
    if (tags.length) out.tags = tags;
  }
  return Object.keys(out).length ? out : null;
}

/** Builds a SupervisionGraph from any iterable of `{ id, meta }` records. */
export function supervisionGraph(records: Iterable<{ id: string; meta?: Record<string, unknown> }>): Map<string, Supervision> {
  const g = new Map<string, Supervision>();
  for (const r of records) {
    const s = supervisionOf(r.meta);
    if (s) g.set(r.id, s);
  }
  return g;
}

/** Walks `managedBy` links upward from `uid`, cycle-safely: `[parent, grandparent, …]`. */
export function ancestorsOf(uid: string, graph: SupervisionGraph): string[] {
  const out: string[] = [];
  const seen = new Set<string>([uid]);
  let cur = graph.get(uid)?.managedBy ?? null;
  while (cur && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = graph.get(cur)?.managedBy ?? null;
  }
  return out;
}

/** True iff `maybeAncestor` is a direct or transitive supervisor of `uid`. */
export function isAncestor(maybeAncestor: string, uid: string, graph: SupervisionGraph): boolean {
  if (!maybeAncestor || maybeAncestor === uid) return false;
  return ancestorsOf(uid, graph).includes(maybeAncestor);
}

/** True iff setting `targetUid.managedBy = nextManagedBy` would create a self-loop or cycle. */
export function wouldCreateCycle(targetUid: string, nextManagedBy: string | null | undefined, graph: SupervisionGraph): boolean {
  if (!nextManagedBy) return false;
  if (nextManagedBy === targetUid) return true;
  return isAncestor(targetUid, nextManagedBy, graph);
}

/** Returns the sibling broadcast address (`siblings:<parentUid>`) when `uid` is supervised, else null. */
export function siblingGroupOf(uid: string, graph: SupervisionGraph): string | null {
  const parent = graph.get(uid)?.managedBy;
  return parent ? `siblings:${parent}` : null;
}

export type HierarchyRelation = 'human' | 'self' | 'downward' | 'upward' | 'sibling' | 'peer';

/**
 * Classifies the relationship from `actorUid` to `targetUid` in the supervision hierarchy:
 * - `human`: no acting session (human caller)
 * - `self`: `actorUid === targetUid`
 * - `downward`: `actor` is an ancestor (direct or transitive supervisor) of `target`
 * - `upward`: `target` is an ancestor of `actor`, OR `target` is a `chief` and `actor` is not an ancestor of `target`
 * - `sibling`: `actor` and `target` share the same supervisor
 * - `peer`: neither supervises the other
 */
export function hierarchyRelation(actorUid: string | null | undefined, targetUid: string, graph: SupervisionGraph): HierarchyRelation {
  const actor = actorUid?.trim();
  if (!actor) return 'human';
  if (actor === targetUid) return 'self';
  if (isAncestor(actor, targetUid, graph)) return 'downward';
  if (isAncestor(targetUid, actor, graph)) return 'upward';
  const actorParent = graph.get(actor)?.managedBy;
  const targetParent = graph.get(targetUid)?.managedBy;
  const targetRole = graph.get(targetUid)?.role;
  // A Chief is upward for unmanaged sessions or sub-Chief siblings under the same root,
  // but NOT for a worker supervised by a different Chief in another subtree/Space.
  if (targetRole === 'chief' && (!actorParent || actorParent === targetParent)) return 'upward';
  if (actorParent && targetParent && actorParent === targetParent) return 'sibling';
  return 'peer';
}

/** Validates and merges a supervision update patch onto an existing Supervision object. */
export function mergeSupervision(
  prev: Supervision | null,
  patch: Record<string, unknown>,
  targetUid?: string,
  graph?: SupervisionGraph,
): Supervision | null {
  const next: Supervision = { ...(prev ?? {}) };
  if ('role' in patch) {
    if (patch.role === null || patch.role === '') delete next.role;
    else if (typeof patch.role === 'string' && (SESSION_ROLES as readonly string[]).includes(patch.role)) next.role = patch.role as SessionRole;
    else throw new SupervisionError(400, 'invalid_supervision', `role must be one of: ${SESSION_ROLES.join(', ')}`);
  }
  if ('managedBy' in patch) {
    if (patch.managedBy === null || patch.managedBy === '') delete next.managedBy;
    else if (typeof patch.managedBy === 'string' && /^[\w-]{1,40}$/.test(patch.managedBy)) {
      if (targetUid && patch.managedBy === targetUid) throw new SupervisionError(400, 'supervision_cycle', 'a session cannot supervise itself');
      if (targetUid && graph && wouldCreateCycle(targetUid, patch.managedBy, graph)) {
        throw new SupervisionError(400, 'supervision_cycle', `setting managedBy=${patch.managedBy} would create a supervision cycle`);
      }
      next.managedBy = patch.managedBy;
    } else throw new SupervisionError(400, 'invalid_supervision', 'invalid managedBy session uid');
  }
  if ('space' in patch) {
    if (patch.space === null || patch.space === '') delete next.space;
    else if (typeof patch.space === 'string') {
      const trimmed = patch.space.trim();
      if (!trimmed || trimmed.length > 64 || trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
        throw new SupervisionError(400, 'invalid_supervision', 'invalid space name');
      }
      next.space = trimmed;
    } else throw new SupervisionError(400, 'invalid_supervision', 'space must be a string');
  }
  if ('muteAlerts' in patch) {
    if (patch.muteAlerts === null) delete next.muteAlerts;
    else if (typeof patch.muteAlerts === 'boolean') next.muteAlerts = patch.muteAlerts;
    else throw new SupervisionError(400, 'invalid_supervision', 'muteAlerts must be true or false');
  }
  if ('escalateAfterSeconds' in patch) {
    if (patch.escalateAfterSeconds === null) delete next.escalateAfterSeconds;
    else if (typeof patch.escalateAfterSeconds === 'number' && Number.isInteger(patch.escalateAfterSeconds) && patch.escalateAfterSeconds >= 10 && patch.escalateAfterSeconds <= 86_400) {
      next.escalateAfterSeconds = patch.escalateAfterSeconds;
    } else throw new SupervisionError(400, 'invalid_supervision', 'escalateAfterSeconds must be an integer between 10 and 86400');
  }
  if ('tags' in patch) {
    if (patch.tags === null) delete next.tags;
    else if (Array.isArray(patch.tags)) {
      const cleaned = [...new Set(patch.tags.map((t) => {
        if (typeof t !== 'string') throw new SupervisionError(400, 'invalid_supervision', 'tags must be strings');
        const trimmed = t.trim();
        if (!/^[\w:./-]{1,40}$/.test(trimmed)) throw new SupervisionError(400, 'invalid_supervision', `invalid tag "${t}"`);
        return trimmed;
      }))];
      if (cleaned.length > 20) throw new SupervisionError(400, 'invalid_supervision', 'at most 20 tags');
      if (cleaned.length) next.tags = cleaned;
      else delete next.tags;
    } else throw new SupervisionError(400, 'invalid_supervision', 'tags must be a list of strings');
  }
  return Object.keys(next).length ? next : null;
}

/** High-risk command/action patterns that another session may never silently auto-approve. */
const DANGEROUS_APPROVAL_RULES: Array<{ rule: string; re: RegExp }> = [
  // Catch rm with recursive + force in any flag order (-rf, -fr, -r -f, --recursive --force) against /, /home/..., ~, .., $HOME, "$HOME", *, or .
  {
    rule: 'destructive_rm',
    re: /\brm\b(?=[^\n]*(?:-[^\n\s]*r|--recursive))(?=[^\n]*(?:-[^\n\s]*f|--force))[^\n]*(?:\s+["']?\/(?:home\b|Users\b|\s|$|\*)|\s+["']?~(?:\/|\s|$|["'])|\s+["']?\.\.(?:\/|\s|$|["'])|\s+["']?\$\{?HOME\}?(?:\/|\s|$|["'])|\s+\*(?:\s|$)|\s+\.(?:\/|\s|$))/i,
  },
  // Catch --force, --force-with-lease, -f, --delete, --mirror, AND refspec force push (`git push origin +main`, `+HEAD:main`)
  { rule: 'force_push', re: /\bgit\s+push\b[^\n]*(?:--force(?:-with-lease)?|--delete|--mirror|-f(?:\s|$)|\s\+[A-Za-z0-9_./:-]+)/i },
  { rule: 'hard_reset', re: /\bgit\s+reset\s+--hard\b/i },
  { rule: 'git_clean_force', re: /\bgit\s+clean\b[^\n]*-[^\n]*f/i },
  { rule: 'destructive_find', re: /\bfind\s+\/(?:\s|$)[^\n]*-delete\b/i },
  { rule: 'infra_destroy', re: /\b(?:terraform|tofu|pulumi)\s+destroy\b/i },
  { rule: 'sql_destructive', re: /\b(?:drop\s+(?:table|database|schema)|truncate\s+table)\b/i },
  { rule: 'disk_wipe', re: /\b(?:mkfs(?:\.\w+)?|dd\s+if=|wipefs|shred)\b/i },
  { rule: 'pipe_to_shell', re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:ba|z|da|k)?sh\b/i },
  { rule: 'chmod_world', re: /\bchmod\s+-R\s+777\b/i },
  { rule: 'system_power', re: /\b(?:shutdown|reboot|poweroff|halt)\b/i },
];

/**
 * Evaluates a waiting session's prompt against external safety guardrails.
 * Returns the matched rule name if blocked, or null if allowed for delegated approval.
 */
export function checkApprovalGuardrail(ask: Ask | null | undefined): { rule: string; reason: string } | null {
  if (!ask) return null;
  if (ask.gate && (ask.gate.kind === 'signin' || ask.gate.kind === 'setup')) {
    return { rule: `gate_${ask.gate.kind}`, reason: `${ask.gate.kind} gates must be handled by the user (forward it instead)` };
  }
  const text = ask.text ?? '';
  for (const { rule, re } of DANGEROUS_APPROVAL_RULES) {
    if (re.test(text)) {
      return { rule, reason: `blocked by external guardrail (${rule}): forward this prompt to the user instead of auto-approving` };
    }
  }
  return null;
}

export type ControlAction =
  | 'answer'
  | 'choose'
  | 'gate'
  | 'questions'
  | 'mode'
  | 'mode_dangerous'
  | 'switch'
  | 'settings'
  | 'send'
  | 'interrupt'
  | 'terminate'
  | 'forget'
  | 'resume'
  | 'fork'
  | 'relaunch'
  | 'queue'
  | 'snapshot'
  | 'recovery'
  | 'supervision'
  | 'terminal'
  | 'rename'
  | 'pin'
  | 'order'
  | 'forward'
  | 'job';

const SELF_ALLOWED: ReadonlySet<ControlAction> = new Set(['send', 'terminal', 'rename', 'pin', 'order', 'snapshot', 'forward']);

export type ControlVerdict =
  | { ok: true; mode: 'control' | 'upward_communicate' }
  | { ok: false; code: 'self_control_denied' | 'upward_control_denied' | 'lateral_control_denied' | 'not_managed_by_caller'; message: string };

/**
 * Enforces strict unidirectional control (`CoS > session`) when a request carries an acting
 * session identity (`X-AH-Session`). Human callers (no `actorUid`) are never blocked here.
 *
 * - Downward (supervisor/ancestor → child/descendant): full control allowed.
 * - Upward (child → parent/ancestor, or non-ancestor → chief): ALL control denied;
 *   only safe live communication (`send` in `upward_communicate` mode, or non-directive `mail`).
 * - Lateral (child → sibling, or supervised non-chief → outside its subtree): ALL control
 *   and direct `send` denied; siblings communicate via mailbox broadcast.
 * - Self: prompt answering, privilege/mode changes, supervision edits and lifecycle control
 *   denied; benign own-workspace operations (send, terminal, rename, pin, order, snapshot, forward) allowed.
 */
export function checkSessionControl(o: {
  actorUid?: string | null;
  targetUid: string;
  graph?: SupervisionGraph;
  /** Shorthand for single-target callers/tests that don't pass a full graph. */
  targetSupervision?: Supervision | null;
  /** Optional Space name of the target session, used when the caller is a Space-scoped chief. */
  targetSpace?: string | null;
  action: ControlAction;
}): ControlVerdict {
  const actor = o.actorUid?.trim();
  if (!actor) return { ok: true, mode: 'control' };
  const graph: SupervisionGraph =
    o.graph ??
    (o.targetSupervision ? new Map<string, Supervision>([[o.targetUid, o.targetSupervision]]) : new Map<string, Supervision>());

  const rel = hierarchyRelation(actor, o.targetUid, graph);
  const actorSup = graph.get(actor) ?? null;
  const targetSup = graph.get(o.targetUid) ?? null;

  if (rel === 'self') {
    if (SELF_ALLOWED.has(o.action)) return { ok: true, mode: 'control' };
    const detail =
      o.action === 'mode_dangerous' || o.action === 'mode'
        ? 'change its own permission mode'
        : o.action === 'supervision'
          ? 'modify its own supervision'
          : o.action === 'answer' || o.action === 'choose' || o.action === 'gate' || o.action === 'questions'
            ? 'answer its own prompt'
            : `perform ${o.action} on itself`;
    return { ok: false, code: 'self_control_denied', message: `a session cannot ${detail}` };
  }

  if (rel === 'downward') {
    if (o.action === 'mode_dangerous') {
      return {
        ok: false,
        code: 'upward_control_denied',
        message: 'only the human user may switch a session to a dangerous/bypass permission mode',
      };
    }
    return { ok: true, mode: 'control' };
  }

  if (rel === 'upward') {
    if (o.action === 'send') return { ok: true, mode: 'upward_communicate' };
    return {
      ok: false,
      code: 'upward_control_denied',
      message: `unidirectional control: session ${actor} cannot ${o.action} its supervisor/chief ${o.targetUid} (only upward communication is allowed)`,
    };
  }

  if (rel === 'sibling') {
    if (o.action === 'send') {
      return {
        ok: false,
        code: 'lateral_control_denied',
        message: `supervised sessions cannot directly drive sibling session ${o.targetUid}; communicate up to your supervisor or broadcast via \`ah mail broadcast\``,
      };
    }
    return {
      ok: false,
      code: 'not_managed_by_caller',
      message: `session ${o.targetUid} is supervised by ${targetSup?.managedBy}, not ${actor}`,
    };
  }

  // rel === 'peer': neither supervises the other.
  if (targetSup?.managedBy) {
    return {
      ok: false,
      code: 'not_managed_by_caller',
      message: `session ${o.targetUid} is supervised by ${targetSup.managedBy}, not ${actor}`,
    };
  }
  if (actorSup?.managedBy && actorSup.role !== 'chief') {
    if (o.action === 'send') {
      return {
        ok: false,
        code: 'lateral_control_denied',
        message: `supervised session ${actor} cannot directly drive ${o.targetUid}; communicate up to ${actorSup.managedBy} or broadcast via \`ah mail broadcast\``,
      };
    }
    return {
      ok: false,
      code: 'not_managed_by_caller',
      message: `supervised session ${actor} cannot control ${o.targetUid}`,
    };
  }
  // A peer Chief of Staff that is NOT a descendant of the caller cannot be controlled, terminated,
  // or answered by another Chief — only messaged (`send`) for cross-Chief coordination.
  if (targetSup?.role === 'chief') {
    if (o.action === 'send') return { ok: true, mode: 'control' };
    return {
      ok: false,
      code: 'not_managed_by_caller',
      message: `session ${actor} cannot ${o.action} peer chief ${o.targetUid}; only direct descendants may be controlled`,
    };
  }
  // Safe-by-default for ordinary unmanaged sessions: they may message unmanaged peers (`send`),
  // but cannot answer prompts, change permissions, terminate, adopt, or take over another peer.
  // Only the human or a Chief of Staff (within its Space) can control unmanaged peers.
  if (actorSup?.role !== 'chief') {
    if (o.action === 'send') return { ok: true, mode: 'control' };
    return {
      ok: false,
      code: 'not_managed_by_caller',
      message: `session ${actor} is not a chief or supervisor of ${o.targetUid} (promote to chief or run as the user to ${o.action})`,
    };
  }
  // A Space-scoped Chief of Staff manages sessions inside its Space (plus explicit descendants).
  if (actorSup.space && o.targetSpace && o.targetSpace !== actorSup.space) {
    return {
      ok: false,
      code: 'not_managed_by_caller',
      message: `chief ${actor} is scoped to Space "${actorSup.space}", not "${o.targetSpace}"`,
    };
  }
  if (actorSup.space && !o.targetSpace) {
    return {
      ok: false,
      code: 'not_managed_by_caller',
      message: `chief ${actor} is scoped to Space "${actorSup.space}" and cannot control ${o.targetUid} outside that Space`,
    };
  }
  return { ok: true, mode: 'control' };
}

function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Generates the opening operational brief sent to a Chief of Staff launched inside a Space.
 * Pure string builder shared by CLI, Web, and native iOS/Mac via GET /api/spaces/:name/brief.
 */
export function buildChiefBrief(o: {
  spaceName: string;
  spacePath: string | null;
  spaceKind?: 'space' | 'repo' | 'folder';
  /** Space-owned context directory (preferences, memory/, knowledge/, artifacts/), separate from repo files when repo/folder. */
  contextDir?: string | null;
  sessions?: Array<{ uid: string; title: string; agent: string | null; status: string }>;
  customInstructions?: string;
}): string {
  const qName = shellQuoteArg(o.spaceName);
  const qPath = o.spacePath ? shellQuoteArg(o.spacePath) : null;
  const ctxDir = o.contextDir ?? o.spacePath;
  const lines: string[] = [
    `You are a Chief of Staff for the "${o.spaceName}" Space in Agent House.`,
    o.spacePath ? `Working folder: ${o.spacePath} (${o.spaceKind ?? 'space'}).` : `Space kind: ${o.spaceKind ?? 'space'}.`,
    ...(ctxDir && ctxDir !== o.spacePath ? [`Space context & artifacts folder (outside repo): ${ctxDir}`] : []),
    '',
    'Your role:',
    `- Coordinate, supervise, and unblock all sessions belonging to the "${o.spaceName}" Space (including sessions across multiple folders/repos).`,
    ctxDir
      ? `- Maintain continuity using Space notes, shared Space memory (\`${ctxDir}/memory/MEMORY.md\`), Space knowledge, and deliverables in \`${ctxDir}/artifacts/\`.`
      : '- Maintain continuity across this Space using its notes, shared memory, files, and artifacts.',
    '- Keep the user out of routine coordination; escalate destructive approvals, sign-in gates, or product decisions with `ah forward <uid>` or `ah decide`.',
    '',
    'Tools (prefer native `mcp__ah__*` MCP tools when available; CLI `ah ...` works identically as fallback — `AH_SESSION_UID`, `AH_SESSION_TOKEN`, `AH_SPACE`, and `AH_ROLE` identify you automatically):',
    `- Inspect this Space's sessions: \`space_sessions\` / \`ah list --space ${qName}\`, \`session_read\` / \`ah read <uid> --last\``,
    `- Spawn a worker in this Space: \`session_spawn\` / \`ah new <agent>${qPath ? ` --cwd ${qPath}` : ''} --space ${qName} --role worker --managed-by self --mute-alerts --name "<title>" --prompt "<task>"\``,
    '- Adopt an existing session: `session_supervise` / `ah supervise <uid> --role worker --managed-by self --mute`',
    '- Drive & unblock workers: `session_send` / `ah send <uid> "<msg>"`, `session_answer` / `ah answer <uid> yes|no`, `session_forward` / `ah forward <uid> --note "<why>"`, `session_interrupt` / `ah interrupt <uid>`',
    `- Space context & artifacts: \`space_context\` / \`ah space context ${qName}\`, \`space_artifacts\` / \`ah space artifacts ${qName}\`, \`space_promote_knowledge\` / \`ah space promote ${qName} --title "<title>" "<knowledge…>"\` (env: \`$AH_SPACE\`, \`$AH_SPACE_DIR\`, \`$AH_SPACE_MEMORY_DIR\`, \`$AH_SPACE_ARTIFACTS_DIR\`)`,
    `- Space notes & tasks: \`note_list\` / \`note_create\` / \`ah notes --space ${qName}\`, \`task_list\` / \`task_create\` / \`ah tasks --space ${qName}\``,
    '- Mailbox & event wakes: `mail_inbox`, `mail_send`, `wake_subscribe` (worker waiting & finished events in this Space are auto-subscribed for you when you start).',
    '',
    'Safety & hierarchy:',
    '- Control is strictly unidirectional (Chief > worker): workers cannot control you or siblings; they report up via `ah mail send` or broadcast to siblings via `ah mail broadcast`.',
    '- Destructive commands (force push, hard reset, root rm, DROP DATABASE, sign-in/setup gates) are blocked from delegated approval — always forward those to the user with `ah forward <uid>`.',
  ];
  if (o.sessions?.length) {
    lines.push('', `Live sessions currently in "${o.spaceName}":`);
    for (const s of o.sessions) {
      lines.push(`- ${s.uid}  "${s.title}" (${s.agent ?? 'shell'}, ${s.status})`);
    }
  }
  if (o.customInstructions?.trim()) {
    lines.push('', 'Additional instructions from the user:', o.customInstructions.trim());
  }
  lines.push('', 'Start by checking `ah whoami`, listing sessions and tasks in this Space, and summarizing what is currently active or waiting.');
  return lines.join('\n');
}

/**
 * Validates who may mutate supervision metadata (`PUT /api/sessions/:uid/supervision`)
 * and guarantees no cycle, Space-scope escape, or privilege escalation can occur.
 */
export function checkSupervisionMutation(o: {
  actorUid?: string | null;
  targetUid: string;
  patch: Record<string, unknown>;
  graph: SupervisionGraph;
  targetSpace?: string | null;
}): { ok: true } | { ok: false; status: number; code: string; message: string } {
  if ('managedBy' in o.patch && typeof o.patch.managedBy === 'string' && o.patch.managedBy) {
    if (wouldCreateCycle(o.targetUid, o.patch.managedBy, o.graph)) {
      return { ok: false, status: 400, code: 'supervision_cycle', message: `setting managedBy=${o.patch.managedBy} would create a supervision cycle` };
    }
  }
  const actor = o.actorUid?.trim();
  if (!actor) return { ok: true };

  const ctrl = checkSessionControl({ actorUid: actor, targetUid: o.targetUid, graph: o.graph, targetSpace: o.targetSpace, action: 'supervision' });
  if (!ctrl.ok) return { ok: false, status: 403, code: ctrl.code, message: ctrl.message };

  const actorSup = o.graph.get(actor) ?? null;
  if (o.patch.role === 'chief' && actorSup?.role !== 'chief') {
    return { ok: false, status: 403, code: 'upward_control_denied', message: 'only the user or a chief session can assign the chief role' };
  }
  // A Space-scoped Chief cannot promote a session to fleet-wide Chief or change its Space scope outside its own Space.
  if (actorSup?.role === 'chief' && actorSup.space) {
    if ('space' in o.patch) {
      const nextSpace = typeof o.patch.space === 'string' ? o.patch.space.trim() : '';
      if (!nextSpace || nextSpace !== actorSup.space) {
        return {
          ok: false,
          status: 403,
          code: 'not_managed_by_caller',
          message: `chief ${actor} is scoped to Space "${actorSup.space}" and cannot grant broader or different Space scope`,
        };
      }
    }
    if (o.patch.role === 'chief') {
      const targetNextSpace = 'space' in o.patch ? o.patch.space : o.graph.get(o.targetUid)?.space;
      if (targetNextSpace !== actorSup.space) {
        return {
          ok: false,
          status: 403,
          code: 'not_managed_by_caller',
          message: `chief ${actor} can only grant chief role scoped to Space "${actorSup.space}"`,
        };
      }
    }
  }
  if ('managedBy' in o.patch) {
    if (o.patch.managedBy === null || o.patch.managedBy === '') {
      // A supervised sub-supervisor cannot detach a child from the hierarchy above it.
      if (actorSup?.managedBy) {
        return { ok: false, status: 403, code: 'upward_control_denied', message: 'a supervised session cannot detach a child from supervision' };
      }
    } else if (typeof o.patch.managedBy === 'string') {
      const nextMgr = o.patch.managedBy;
      if (nextMgr !== actor && !isAncestor(actor, nextMgr, o.graph)) {
        return { ok: false, status: 403, code: 'not_managed_by_caller', message: `a session can only assign supervision within its own subtree` };
      }
    }
  }
  return { ok: true };
}

/**
 * Resolves supervision for a newly spawned session (`POST /api/windows`), preventing
 * supervised child sessions or Space-scoped Chiefs from spawning unsupervised escape hatches.
 */
export function resolveSpawnSupervision(o: {
  actorUid?: string | null;
  targetUid: string;
  requested: Record<string, unknown> | null | undefined;
  graph: SupervisionGraph;
  targetSpace?: string | null;
}): Supervision | null {
  const actor = o.actorUid?.trim();
  const patch: Record<string, unknown> = o.requested ? { ...o.requested } : {};
  if (!actor) {
    return Object.keys(patch).length ? mergeSupervision(null, patch, o.targetUid, o.graph) : null;
  }
  const actorSup = o.graph.get(actor) ?? null;
  if (patch.role === 'chief' && actorSup?.role !== 'chief') {
    throw new SupervisionError(403, 'upward_control_denied', 'only the user or a chief session can spawn a chief session');
  }
  if (typeof patch.managedBy === 'string' && patch.managedBy) {
    if (patch.managedBy !== actor && !isAncestor(actor, patch.managedBy, o.graph)) {
      throw new SupervisionError(403, 'not_managed_by_caller', 'a session can only assign supervision within its own subtree');
    }
  }
  // A Space-scoped Chief cannot spawn sessions outside its Space or unscoped Chiefs.
  if (actorSup?.role === 'chief' && actorSup.space) {
    if (o.targetSpace && o.targetSpace !== actorSup.space) {
      throw new SupervisionError(403, 'not_managed_by_caller', `chief ${actor} is scoped to Space "${actorSup.space}", not "${o.targetSpace}"`);
    }
    if (typeof patch.space === 'string' && patch.space.trim() && patch.space.trim() !== actorSup.space) {
      throw new SupervisionError(403, 'not_managed_by_caller', `chief ${actor} cannot spawn sessions scoped to Space "${patch.space}"`);
    }
    // Always inherit Space scope on spawned sub-Chiefs/workers and bind under creator if no subtree manager set.
    patch.space = actorSup.space;
    if (patch.managedBy === null || patch.managedBy === '' || patch.managedBy === undefined) {
      patch.managedBy = actor;
    }
    if (!patch.role) patch.role = 'worker';
  } else if (actorSup?.role === 'chief' && patch.role === 'chief') {
    // A fleet-wide Chief spawning a sub-Chief keeps downward control over it.
    if (patch.managedBy === null || patch.managedBy === '' || patch.managedBy === undefined) {
      patch.managedBy = actor;
    }
  }
  // Transitive unidirectionality: any session spawned by a supervised session inherits
  // `managedBy: actor` so a child can never spawn an unsupervised escape-hatch session.
  if (actorSup?.managedBy) {
    if (patch.managedBy === null || patch.managedBy === '' || patch.managedBy === undefined) {
      patch.managedBy = actor;
    }
    if (!patch.role) patch.role = 'worker';
  }
  return Object.keys(patch).length ? mergeSupervision(null, patch, o.targetUid, o.graph) : null;
}

/**
 * Validates and resolves a mailbox send (`POST /api/fleet/mailbox`):
 * - Child → ancestor: allowed for non-directive kinds (`message`, `report`, `blocker`, `handoff`).
 * - Child → `siblings` (or `siblings:<ownParent>`) / `*`: allowed as broadcast (no terminal wake).
 * - Child → single sibling directly: refused (`lateral_control_denied`: broadcast to siblings instead).
 * - Supervisor/ancestor → child (or `siblings:<self>` / `*`): full mail including `directive`.
 */
export function checkMailSend(o: {
  actorUid?: string | null;
  toUid: string;
  kind?: string;
  graph: SupervisionGraph;
  targetSpace?: string | null;
}): { ok: true; resolvedTo: string; allowWake: boolean } | { ok: false; status: number; code: string; message: string } {
  const to = o.toUid.trim();
  const actor = o.actorUid?.trim();
  if (!actor) {
    if (to === 'siblings') {
      return { ok: false, status: 400, code: 'invalid_recipient', message: 'only a supervised session can broadcast to "siblings"; use "*" for fleet broadcast' };
    }
    return { ok: true, resolvedTo: to, allowWake: to !== '*' && !to.startsWith('siblings:') };
  }
  if (to === 'siblings') {
    const group = siblingGroupOf(actor, o.graph);
    if (!group) {
      return { ok: false, status: 400, code: 'invalid_recipient', message: 'only a supervised session has siblings; use "*" for fleet broadcast' };
    }
    if (o.kind === 'directive') {
      return { ok: false, status: 403, code: 'lateral_control_denied', message: 'siblings cannot broadcast directives; use message, report, blocker, or handoff' };
    }
    return { ok: true, resolvedTo: group, allowWake: false };
  }
  if (to === '*') {
    const actorSup = o.graph.get(actor);
    if (o.kind === 'directive' && ((actorSup?.managedBy && actorSup.role !== 'chief') || (actorSup?.role === 'chief' && !!actorSup.space))) {
      return { ok: false, status: 403, code: 'lateral_control_denied', message: 'cannot broadcast fleet-wide directives from a supervised worker or Space-scoped chief' };
    }
    return { ok: true, resolvedTo: '*', allowWake: false };
  }
  if (to.startsWith('siblings:')) {
    const parent = to.slice('siblings:'.length);
    const ownGroup = siblingGroupOf(actor, o.graph);
    const isSupervisorGroup = parent === actor || isAncestor(actor, parent, o.graph);
    if (!isSupervisorGroup && to !== ownGroup) {
      return { ok: false, status: 403, code: 'not_managed_by_caller', message: 'cannot broadcast to another supervisor\'s sibling group' };
    }
    if (!isSupervisorGroup && o.kind === 'directive') {
      return { ok: false, status: 403, code: 'lateral_control_denied', message: 'siblings cannot broadcast directives; use message, report, blocker, or handoff' };
    }
    return { ok: true, resolvedTo: to, allowWake: false };
  }

  const rel = hierarchyRelation(actor, to, o.graph);
  if (rel === 'downward' || rel === 'self') {
    return { ok: true, resolvedTo: to, allowWake: true };
  }
  if (rel === 'upward') {
    if (o.kind === 'directive') {
      return {
        ok: false,
        code: 'upward_control_denied',
        status: 403,
        message: 'a child session cannot send a directive to its supervisor; use report, blocker, handoff, or message',
      };
    }
    return { ok: true, resolvedTo: to, allowWake: true };
  }
  if (rel === 'sibling') {
    return {
      ok: false,
      status: 403,
      code: 'lateral_control_denied',
      message: `supervised sessions communicate up to their supervisor or broadcast to siblings (\`ah mail broadcast\`), not direct 1-to-1 sibling messaging`,
    };
  }
  const actorSup = o.graph.get(actor) ?? null;
  const targetSup = o.graph.get(to) ?? null;
  if (targetSup?.managedBy && !isAncestor(actor, to, o.graph)) {
    return { ok: false, status: 403, code: 'not_managed_by_caller', message: `session ${to} is supervised by ${targetSup.managedBy}, not ${actor}` };
  }
  if (actorSup?.managedBy && actorSup.role !== 'chief') {
    return {
      ok: false,
      status: 403,
      code: 'lateral_control_denied',
      message: `supervised session ${actor} can only communicate up to ${actorSup.managedBy} or broadcast to siblings`,
    };
  }
  if (actorSup?.role === 'chief' && actorSup.space && o.targetSpace !== undefined && o.targetSpace !== actorSup.space) {
    return {
      ok: false,
      status: 403,
      code: 'not_managed_by_caller',
      message: `chief ${actor} is scoped to Space "${actorSup.space}", not "${o.targetSpace ?? 'none'}"`,
    };
  }
  if (o.kind === 'directive' && actorSup?.role !== 'chief') {
    return {
      ok: false,
      status: 403,
      code: 'not_managed_by_caller',
      message: `session ${actor} cannot send directives to unmanaged peer ${to}`,
    };
  }
  return { ok: true, resolvedTo: to, allowWake: true };
}

/**
 * Pure attention-routing decision for Push.observe:
 * Suppresses direct user waiting alerts for supervised workers while their supervisor is live,
 * failing open to the user if the supervisor dies or a waiting prompt goes unhandled
 * past `escalateAfterSeconds` (default 120 s). Done alerts are only muted when explicitly requested.
 */
export function shouldMuteAlert(o: {
  supervision: Supervision | null | undefined;
  event: 'waiting' | 'done';
  liveUids: ReadonlySet<string>;
  waitingSince?: number | null;
  now: number;
}): boolean {
  const s = o.supervision;
  if (!s) return false;
  if (o.event === 'done') {
    // Only mute "finished" alerts when explicitly requested AND supervisor is live.
    if (s.muteAlerts !== true) return false;
    if (s.managedBy && !o.liveUids.has(s.managedBy)) return false;
    return true;
  }
  const muted = s.muteAlerts === true || (!!s.managedBy && s.muteAlerts !== false);
  if (!muted) return false;
  // Fail open if the supervisor isn't live (unless explicitly muted without a supervisor).
  if (s.managedBy && !o.liveUids.has(s.managedBy)) return false;
  if (o.waitingSince !== undefined && o.waitingSince !== null) {
    const threshold = s.escalateAfterSeconds ?? DEFAULT_ESCALATE_AFTER_S;
    if (o.now - o.waitingSince >= threshold) return false;
  }
  return true;
}
