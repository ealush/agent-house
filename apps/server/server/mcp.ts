// Built-in Agent House MCP server core (`ah mcp`): role-scoped tool catalog,
// JSON-RPC 2.0 request handler, and compaction-proof role playbooks.
// Pure functional core: zero I/O (tested directly with a mock McpApi).
import { basename } from 'node:path';

export type McpRole = 'chief' | 'worker' | 'reviewer' | 'default';

/** Environment variables passed through to `ah mcp` (e.g. Codex `mcp_servers.ah.env_vars`). */
export const MCP_ENV_VARS: readonly string[] = [
  'AH_PORT',
  'AH_SESSION_UID',
  'AH_SESSION_TOKEN',
  'AH_SPACE',
  'AH_SPACE_DIR',
  'AH_SPACE_MEMORY_DIR',
  'AH_SPACE_ARTIFACTS_DIR',
  'AH_SPACE_CONTEXT_FILE',
  'AH_ROLE',
  'AH_MANAGED_BY',
  'XDG_STATE_HOME',
];

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True for downward management / orchestration tools (never exposed to supervised workers). */
  chiefOnly?: boolean;
};

export type McpApiResult = { status: number; data: unknown };

export type McpApi = {
  request: (method: string, path: string, body?: unknown) => Promise<McpApiResult>;
  uploadArtifact?: (o: { dir: string; filePath: string; name?: string }) => Promise<McpApiResult>;
};

export type McpContext = {
  role: McpRole;
  sessionUid: string | null;
  space: string | null;
  managedBy: string | null;
  api: McpApi;
};

export function roleFromEnv(env: Record<string, string | undefined>): McpRole {
  const raw = env.AH_ROLE?.trim().toLowerCase();
  if (raw === 'chief' || raw === 'worker' || raw === 'reviewer') return raw;
  return 'default';
}

export function isChiefCapable(role: McpRole, _managedBy: string | null | undefined): boolean {
  return role === 'chief';
}

const ALL_TOOLS: readonly McpToolDef[] = [
  // ---------- Shared / Worker-safe tools ----------
  {
    name: 'space_context',
    description:
      'Fetch the Space context bundle: preferences (AGENTS.md), shared memory index and entries, Space notes, and artifacts inventory.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format (default: markdown).' },
      },
    },
  },
  {
    name: 'space_artifacts',
    description:
      'List artifacts in the Space artifacts/ folder, or upload a local file into the Space artifacts/ folder.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add'], description: 'Operation to perform (default: list).' },
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        filePath: { type: 'string', description: 'Absolute path to local file (required when action="add").' },
        name: { type: 'string', description: 'Optional destination filename inside artifacts/ (when action="add").' },
      },
    },
  },
  {
    name: 'space_promote_knowledge',
    description:
      'Promote a durable decision, finding, or runbook into the Space shared memory/ (auto-indexed in memory/MEMORY.md).',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['title', 'markdown'],
      properties: {
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        title: { type: 'string', description: 'Short title for the knowledge entry.' },
        markdown: { type: 'string', description: 'Markdown content to store in Space memory.' },
        file: { type: 'string', description: 'Optional .md filename inside memory/.' },
        summary: { type: 'string', description: 'Optional one-line summary for MEMORY.md.' },
        source: { type: 'string', description: 'Optional provenance label (e.g. "session", "review").' },
      },
    },
  },
  {
    name: 'note_list',
    description: 'List notes belonging to this Space.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
      },
    },
  },
  {
    name: 'note_create',
    description: 'Create a new note filed in this Space.',
    inputSchema: {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: 'Note title.' },
        body: { type: 'string', description: 'Markdown body of the note.' },
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
      },
    },
  },
  {
    name: 'task_list',
    description: 'List durable fleet tasks in this Space.',
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'] },
        assignedTo: { type: 'string', description: 'Filter by assigned session uid (or "self").' },
      },
    },
  },
  {
    name: 'task_update',
    description: 'Update an assigned task status, result summary, or description.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Task id (tk-xxxxxxxx).' },
        status: { type: 'string', enum: ['open', 'in_progress', 'blocked', 'done', 'cancelled'] },
        result: { type: 'string', description: 'Outcome or verification notes.' },
        description: { type: 'string', description: 'Updated task description.' },
      },
    },
  },
  {
    name: 'mail_inbox',
    description: 'Read mailbox messages addressed to this session (including sibling/fleet broadcasts).',
    inputSchema: {
      type: 'object',
      properties: {
        unreadOnly: { type: 'boolean', description: 'Only return unread messages (default: true).' },
        limit: { type: 'number', description: 'Max messages to return (default: 20).' },
      },
    },
  },
  {
    name: 'mail_report_up',
    description:
      'Report progress, completion, handoff, or a blocker upward to your supervisor/Chief of Staff (never a directive).',
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string', description: 'Message content.' },
        subject: { type: 'string', description: 'Optional short subject.' },
        kind: { type: 'string', enum: ['report', 'blocker', 'handoff', 'message'], description: 'Default: report.' },
        toUid: { type: 'string', description: 'Supervisor/Chief session uid (defaults to $AH_MANAGED_BY).' },
        wake: { type: 'boolean', description: 'Wake the recipient if idle (default: true).' },
      },
    },
  },
  {
    name: 'mail_broadcast_siblings',
    description:
      'Broadcast a status update, handoff, or blocker to sibling sessions supervised by the same Chief.',
    inputSchema: {
      type: 'object',
      required: ['body'],
      properties: {
        body: { type: 'string', description: 'Broadcast content.' },
        subject: { type: 'string', description: 'Optional short subject.' },
        kind: { type: 'string', enum: ['message', 'report', 'blocker', 'handoff'], description: 'Default: message.' },
      },
    },
  },

  // ---------- Chief / Management tools ----------
  {
    name: 'space_sessions',
    description:
      'List live sessions in this Space with status, agent, title, pending prompt/ask, supervision role, and managedBy.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        includeAllSpaces: { type: 'boolean', description: 'List sessions across all Spaces (default: false).' },
      },
    },
  },
  {
    name: 'session_spawn',
    description:
      'Spawn a new worker or reviewer session in this Space supervised by this Chief (unidirectional CoS > worker).',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['preset'],
      properties: {
        preset: { type: 'string', description: 'Harness preset id (e.g. claude, codex, gemini, grok, shell).' },
        name: { type: 'string', description: 'Session label/title.' },
        cwd: { type: 'string', description: 'Working folder (defaults to Space path).' },
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        role: { type: 'string', enum: ['worker', 'reviewer'], description: 'Supervision role (default: worker).' },
        mode: { type: 'string', description: 'Permission mode (e.g. default, edits, auto, plan).' },
        model: { type: 'string', description: 'Optional model id.' },
        effort: { type: 'string', description: 'Optional reasoning effort.' },
        prompt: { type: 'string', description: 'Optional initial task prompt to send immediately after launch.' },
        worktree: { type: 'boolean', description: 'Explicitly isolate in a git worktree.' },
        muteAlerts: { type: 'boolean', description: 'Mute routine user alerts while Chief supervises (default: true).' },
      },
    },
  },
  {
    name: 'session_read',
    description: 'Read a session latest reply, structured feed, or terminal screen.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'Session uid or window id.' },
        mode: { type: 'string', enum: ['last', 'feed', 'screen'], description: 'What to read (default: last).' },
        lines: { type: 'number', description: 'Number of lines/entries (default: 40).' },
      },
    },
  },
  {
    name: 'session_send',
    description: 'Send instructions or follow-up text to a supervised session.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['target', 'text'],
      properties: {
        target: { type: 'string', description: 'Session uid or window id.' },
        text: { type: 'string', description: 'Message text to deliver (queues if busy).' },
      },
    },
  },
  {
    name: 'session_answer',
    description:
      'Approve or deny a waiting permission prompt on a supervised worker (destructive commands and sign-in gates are blocked by server guardrails — use session_forward for those).',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['target', 'choice'],
      properties: {
        target: { type: 'string', description: 'Session uid or window id.' },
        choice: { type: 'string', enum: ['yes', 'no'], description: 'Approve (yes) or deny (no).' },
      },
    },
  },
  {
    name: 'session_forward',
    description:
      'Escalate a waiting prompt, destructive approval, sign-in gate, or product decision directly to the human user.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'Session uid or window id.' },
        note: { type: 'string', description: 'Short explanation for the user of what needs a decision.' },
      },
    },
  },
  {
    name: 'session_supervise',
    description: 'Adopt an unmanaged session in this Space or update supervision settings.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'Session uid.' },
        role: { type: 'string', enum: ['worker', 'reviewer', 'chief'] },
        managedBy: { type: 'string', description: 'Supervisor uid, or "self" (defaults to self).' },
        muteAlerts: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'session_interrupt',
    description: 'Interrupt (Stop) a supervised session current turn.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['target'],
      properties: {
        target: { type: 'string', description: 'Session uid or window id.' },
      },
    },
  },
  {
    name: 'task_create',
    description: 'Create a durable task in this Space and optionally assign it to a worker session.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Task title.' },
        description: { type: 'string', description: 'Detailed acceptance criteria / context.' },
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        assignedUid: { type: 'string', description: 'Optional worker session uid.' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      },
    },
  },
  {
    name: 'mail_send',
    description: 'Send a directive, message, handoff, or report to a specific session via the fleet mailbox.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      required: ['toUid', 'body'],
      properties: {
        toUid: { type: 'string', description: 'Recipient session uid.' },
        body: { type: 'string', description: 'Message body.' },
        subject: { type: 'string', description: 'Optional subject.' },
        kind: { type: 'string', enum: ['directive', 'message', 'handoff', 'report', 'blocker'], description: 'Default: directive.' },
        wake: { type: 'boolean', description: 'Wake the recipient if idle (default: true).' },
      },
    },
  },
  {
    name: 'wake_subscribe',
    description:
      'List active wake/heartbeat jobs, subscribe this Chief to Space session events (waiting/idle/ended/stalled), add a periodic heartbeat, or cancel a job.',
    chiefOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'watch_space', 'heartbeat', 'cancel'], description: 'Default: list.' },
        space: { type: 'string', description: 'Space name (defaults to $AH_SPACE).' },
        on: { type: 'string', enum: ['waiting', 'idle', 'ended', 'stalled'], description: 'Event kind for watch_space (default: waiting).' },
        everySeconds: { type: 'number', description: 'Interval in seconds for heartbeat (min 30, default 900).' },
        text: { type: 'string', description: 'Optional custom wake prompt.' },
        jobId: { type: 'string', description: 'Job id (jb-xxxxxxxx) when action="cancel".' },
      },
    },
  },
];

export function toolsForRole(role: McpRole, managedBy?: string | null): McpToolDef[] {
  const chief = isChiefCapable(role, managedBy);
  return ALL_TOOLS.filter((t) => chief || !t.chiefOnly).map(({ chiefOnly: _c, ...rest }) => rest);
}

/**
 * Compact, compaction-proof operating playbook injected via system prompt / SessionStart hook
 * so Chiefs and workers always know their MCP tools, CLI fallback, and unidirectional hierarchy.
 */
export function renderRolePlaybook(o: {
  role: McpRole;
  space?: string | null;
  managedBy?: string | null;
  hasMcp?: boolean;
}): string {
  const spaceLabel = o.space ? `Space "${o.space}"` : 'Agent House';
  if (o.role === 'chief') {
    const tools = o.hasMcp !== false
      ? 'Prefer your native `mcp__ah__*` tools (`space_context`, `space_sessions`, `session_spawn`, `session_read`, `session_send`, `session_answer`, `session_forward`, `session_supervise`, `task_create`, `task_list`, `note_create`, `space_artifacts`, `space_promote_knowledge`, `mail_inbox`, `mail_send`, `wake_subscribe`). CLI fallback: `ah ...`.'
      : 'Use `ah` CLI commands (`ah list`, `ah new`, `ah send`, `ah answer`, `ah forward`, `ah space context`, `ah tasks`, `ah mail`).';
    return [
      `## Agent House Chief of Staff Playbook (${spaceLabel})`,
      `- Role: Chief of Staff (\`AH_ROLE=chief\`). You coordinate sessions in ${spaceLabel}; control is strictly unidirectional (Chief > worker).`,
      `- Tools: ${tools}`,
      '- Space event wakes are subscribed automatically: when a worker waits or finishes, inspect it, approve routine safe steps, or escalate destructive/sign-in/product decisions via `session_forward` (`ah forward`).',
      '- Keep continuity durable: save deliverables in Space `artifacts/`, promote lasting decisions into Space memory (`space_promote_knowledge`), and keep Space tasks/notes current.',
    ].join('\n');
  }
  if (o.role === 'worker' || o.role === 'reviewer') {
    const sup = o.managedBy ? ` (supervised by ${o.managedBy})` : '';
    const tools = o.hasMcp !== false
      ? 'Use `mcp__ah__*` tools (`space_context`, `space_artifacts`, `note_list`, `note_create`, `task_list`, `task_update`, `mail_inbox`, `mail_report_up`, `mail_broadcast_siblings`) or `ah` CLI.'
      : 'Use `ah space context`, `ah space artifacts`, `ah mail send` (upward), and `ah mail broadcast` (siblings).';
    return [
      `## Agent House ${o.role === 'reviewer' ? 'Reviewer' : 'Worker'} Playbook (${spaceLabel})${sup}`,
      `- Tools: ${tools}`,
      '- Hierarchy is strictly unidirectional: never attempt to control your supervisor or drive siblings directly — report blockers/results upward (`mail_report_up`) or broadcast status to siblings (`mail_broadcast_siblings`).',
      '- Read Space preferences/memory via `space_context`, publish deliverables via `space_artifacts`, and propose durable knowledge updates to your Chief via `mail_report_up`.',
    ].join('\n');
  }
  return '';
}

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

function okText(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function errText(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

function asStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function apiError(res: McpApiResult): string {
  const d = res.data as Record<string, unknown> | null;
  if (d && typeof d === 'object' && typeof d.error === 'string') {
    return typeof d.code === 'string' ? `${d.error} (${d.code})` : d.error;
  }
  return `HTTP ${res.status}`;
}

async function resolveWindowId(api: McpApi, target: string): Promise<{ windowId: string; uid: string; window?: Record<string, unknown> } | null> {
  if (target.startsWith('@')) return { windowId: target, uid: target };
  const stateRes = await api.request('GET', '/api/state');
  if (stateRes.status >= 400) return null;
  const windows = ((stateRes.data as { windows?: Array<Record<string, unknown>> })?.windows ?? []);
  const found = windows.find((w) => w.uid === target || w.id === target);
  if (!found || typeof found.id !== 'string') return null;
  return { windowId: found.id, uid: String(found.uid ?? target), window: found };
}

async function resolveSpaceInfo(api: McpApi, spaceName: string): Promise<Record<string, unknown> | null> {
  const res = await api.request('GET', '/api/spaces');
  if (res.status >= 400) return null;
  const spaces = ((res.data as { spaces?: Array<Record<string, unknown>> })?.spaces ?? []);
  return spaces.find((s) => String(s.name ?? '').toLowerCase() === spaceName.toLowerCase()) ?? null;
}

async function callTool(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  const def = ALL_TOOLS.find((t) => t.name === name);
  if (!def) return errText(`Unknown tool: ${name}`);
  if (def.chiefOnly && !isChiefCapable(ctx.role, ctx.managedBy)) {
    return errText(`Forbidden: tool "${name}" is restricted to Chief of Staff sessions (role=${ctx.role}).`);
  }

  const space = asStr(args.space) ?? ctx.space ?? undefined;

  switch (name) {
    case 'space_context': {
      if (!space) return errText('space is required (not inside a Space session and no space argument given).');
      const res = await ctx.api.request('GET', `/api/spaces/${encodeURIComponent(space)}/context`);
      if (res.status >= 400) return errText(apiError(res));
      const data = res.data as { markdown?: string };
      if (asStr(args.format) === 'json') return okText(JSON.stringify(res.data, null, 2));
      return okText(data.markdown || JSON.stringify(res.data, null, 2));
    }

    case 'space_artifacts': {
      if (!space) return errText('space is required (not inside a Space session and no space argument given).');
      const action = asStr(args.action) ?? 'list';
      const ctxRes = await ctx.api.request('GET', `/api/spaces/${encodeURIComponent(space)}/context`);
      if (ctxRes.status >= 400) return errText(apiError(ctxRes));
      const info = ctxRes.data as { artifactsDir?: string; artifacts?: Array<Record<string, unknown>> };
      if (action === 'add') {
        const filePath = asStr(args.filePath);
        if (!filePath) return errText('filePath is required when action="add".');
        if (!info.artifactsDir) return errText(`Space "${space}" has no artifacts directory.`);
        if (!ctx.api.uploadArtifact) return errText('Artifact upload is unavailable in this environment.');
        const up = await ctx.api.uploadArtifact({ dir: info.artifactsDir, filePath, name: asStr(args.name) ?? basename(filePath) });
        if (up.status >= 400) return errText(apiError(up));
        await ctx.api.request('GET', `/api/spaces/${encodeURIComponent(space)}/context`).catch(() => {});
        return okText(JSON.stringify(up.data, null, 2));
      }
      return okText(JSON.stringify({ space, artifactsDir: info.artifactsDir ?? null, artifacts: info.artifacts ?? [] }, null, 2));
    }

    case 'space_promote_knowledge': {
      if (!space) return errText('space is required.');
      const title = asStr(args.title);
      const markdown = asStr(args.markdown);
      if (!title || !markdown) return errText('title and markdown are required.');
      const res = await ctx.api.request('POST', `/api/spaces/${encodeURIComponent(space)}/knowledge/promote`, {
        title,
        markdown,
        ...(asStr(args.file) ? { file: asStr(args.file) } : {}),
        ...(asStr(args.summary) ? { summary: asStr(args.summary) } : {}),
        ...(asStr(args.source) ? { source: asStr(args.source) } : {}),
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'note_list': {
      const byId = new Map<string, Record<string, unknown>>();
      let since = 0;
      for (let page = 0; page < 20; page++) {
        const res = await ctx.api.request('GET', `/api/notes?since=${since}&limit=200`);
        if (res.status >= 400) return errText(apiError(res));
        const body = res.data as { notes?: Array<Record<string, unknown>>; cursor?: number; more?: boolean };
        for (const n of body.notes ?? []) {
          if (typeof n.id === 'string') byId.set(n.id, n);
        }
        if (!body.more || typeof body.cursor !== 'number' || body.cursor <= since) break;
        since = body.cursor;
      }
      const all = [...byId.values()].filter((n) => !n.deleted);
      if (!space) return okText(JSON.stringify(all, null, 2));
      const sp = await resolveSpaceInfo(ctx.api, space);
      const spPath = typeof sp?.path === 'string' ? sp.path : null;
      const spRoots = Array.isArray(sp?.roots) ? (sp.roots as string[]) : [];
      const allPaths = new Set([spPath, ...spRoots].filter((p): p is string => typeof p === 'string' && p.length > 0));
      const filtered = all.filter((n) => {
        const proj = n.project as { name?: string; path?: string } | null | undefined;
        return (proj?.name && proj.name.toLowerCase() === space.toLowerCase()) || (proj?.path && allPaths.has(proj.path));
      });
      return okText(JSON.stringify(filtered, null, 2));
    }

    case 'note_create': {
      const title = asStr(args.title);
      const body = typeof args.body === 'string' ? args.body : '';
      if (!title) return errText('title is required.');
      let project: { host: string; path: string } | undefined;
      if (space) {
        const [sp, stRes] = await Promise.all([resolveSpaceInfo(ctx.api, space), ctx.api.request('GET', '/api/state')]);
        if (!sp || typeof sp.path !== 'string') {
          return errText(`Space "${space}" was not found or has no folder path; cannot file note in that Space.`);
        }
        const st = (stRes.status < 400 && stRes.data && typeof stRes.data === 'object' ? stRes.data : {}) as { hostname?: string; home?: string };
        const host = typeof st.hostname === 'string' && st.hostname ? st.hostname : 'localhost';
        const home = typeof st.home === 'string' ? st.home.replace(/\/+$/, '') : '';
        const absPath = sp.path === '~' && home ? home : sp.path.startsWith('~/') && home ? `${home}${sp.path.slice(1)}` : sp.path;
        project = { host, path: absPath };
      }
      const noteId = globalThis.crypto.randomUUID();
      const writeId = globalThis.crypto.randomUUID();
      const res = await ctx.api.request('PUT', `/api/notes/${encodeURIComponent(noteId)}`, {
        baseRevision: 0,
        writeId,
        title,
        markdown: body,
        ...(project ? { project } : {}),
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'task_list': {
      const qs = new URLSearchParams();
      if (space) qs.set('space', space);
      if (asStr(args.status)) qs.set('status', asStr(args.status)!);
      const assigned = asStr(args.assignedTo);
      if (assigned) qs.set('assigned', assigned === 'self' && ctx.sessionUid ? ctx.sessionUid : assigned);
      const res = await ctx.api.request('GET', `/api/fleet/tasks${qs.toString() ? `?${qs}` : ''}`);
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'task_update': {
      const id = asStr(args.id);
      if (!id) return errText('id is required.');
      const patch: Record<string, unknown> = {};
      if (asStr(args.status)) patch.status = asStr(args.status);
      if (typeof args.result === 'string') patch.result = args.result;
      if (typeof args.description === 'string') patch.description = args.description;
      const res = await ctx.api.request('PATCH', `/api/fleet/tasks/${encodeURIComponent(id)}`, patch);
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'mail_inbox': {
      const qs = new URLSearchParams();
      if (args.unreadOnly !== false) qs.set('unread', '1');
      if (typeof args.limit === 'number' && Number.isFinite(args.limit)) qs.set('limit', String(Math.max(1, Math.min(100, Math.floor(args.limit)))));
      const res = await ctx.api.request('GET', `/api/fleet/mailbox?${qs}`);
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'mail_report_up': {
      const body = asStr(args.body);
      if (!body) return errText('body is required.');
      const toUid = asStr(args.toUid) ?? ctx.managedBy ?? undefined;
      if (!toUid) return errText('toUid is required (this session has no $AH_MANAGED_BY supervisor).');
      const kind = asStr(args.kind) ?? 'report';
      if (kind === 'directive') return errText('mail_report_up cannot send directives; use report, blocker, handoff, or message.');
      const res = await ctx.api.request('POST', '/api/fleet/mailbox', {
        toUid,
        body,
        kind,
        ...(asStr(args.subject) ? { subject: asStr(args.subject) } : {}),
        wake: args.wake !== false,
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'mail_broadcast_siblings': {
      const body = asStr(args.body);
      if (!body) return errText('body is required.');
      const kind = asStr(args.kind) ?? 'message';
      if (kind === 'directive') return errText('siblings cannot broadcast directives.');
      const res = await ctx.api.request('POST', '/api/fleet/mailbox', {
        toUid: 'siblings',
        body,
        kind,
        ...(asStr(args.subject) ? { subject: asStr(args.subject) } : {}),
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'space_sessions': {
      const res = await ctx.api.request('GET', '/api/state');
      if (res.status >= 400) return errText(apiError(res));
      const all = ((res.data as { windows?: Array<Record<string, unknown>> })?.windows ?? []);
      const includeAll = args.includeAllSpaces === true;
      const list = !includeAll && space
        ? all.filter((w) => String(w.space ?? w.project ?? '').toLowerCase() === space.toLowerCase())
        : all;
      const summary = list.map((w) => ({
        uid: w.uid,
        id: w.id,
        title: w.title ?? w.name,
        agent: w.agent,
        status: w.status,
        space: w.space ?? w.project,
        cwd: w.cwd,
        branch: w.branch ?? null,
        supervision: w.supervision ?? null,
        ask: w.ask ?? null,
        detail: w.detail ?? null,
        reply: w.reply ?? null,
        isSelf: ctx.sessionUid ? w.uid === ctx.sessionUid : false,
      }));
      return okText(JSON.stringify({ space: includeAll ? null : space ?? null, sessions: summary }, null, 2));
    }

    case 'session_spawn': {
      const preset = asStr(args.preset);
      if (!preset) return errText('preset is required.');
      let cwd = asStr(args.cwd);
      if (!cwd && space) {
        const sp = await resolveSpaceInfo(ctx.api, space);
        if (sp && typeof sp.path === 'string') cwd = sp.path;
      }
      const supervision: Record<string, unknown> = {
        role: asStr(args.role) ?? 'worker',
        muteAlerts: args.muteAlerts !== false,
        ...(ctx.sessionUid ? { managedBy: ctx.sessionUid } : {}),
        ...(space ? { space } : {}),
      };
      const launchRes = await ctx.api.request('POST', '/api/windows', {
        preset,
        cwd: cwd ?? '~',
        ...(asStr(args.name) ? { label: asStr(args.name) } : {}),
        ...(space ? { space } : {}),
        ...(asStr(args.mode) ? { mode: asStr(args.mode) } : {}),
        ...(asStr(args.model) ? { model: asStr(args.model) } : {}),
        ...(asStr(args.effort) ? { effort: asStr(args.effort) } : {}),
        ...(typeof args.worktree === 'boolean' ? { worktree: args.worktree } : {}),
        trust: true,
        supervision,
      });
      if (launchRes.status >= 400) return errText(apiError(launchRes));
      const spawned = launchRes.data as { id?: string; uid?: string };
      let promptOutcome: unknown = null;
      const prompt = asStr(args.prompt);
      if (prompt && spawned.uid) {
        const sendRes = await ctx.api.request('POST', `/api/sessions/${encodeURIComponent(spawned.uid)}/send`, { text: prompt, enter: true });
        promptOutcome = sendRes.status < 400 ? sendRes.data : { error: apiError(sendRes) };
      }
      return okText(JSON.stringify({ ...spawned, ...(promptOutcome ? { prompt: promptOutcome } : {}) }, null, 2));
    }

    case 'session_read': {
      const target = asStr(args.target);
      if (!target) return errText('target is required.');
      const mode = asStr(args.mode) ?? 'last';
      const resolved = await resolveWindowId(ctx.api, target);
      if (mode === 'screen') {
        const uid = resolved?.uid ?? target;
        const lines = typeof args.lines === 'number' && Number.isFinite(args.lines) ? Math.max(10, Math.min(500, Math.floor(args.lines))) : 80;
        const res = await ctx.api.request('GET', `/api/sessions/${encodeURIComponent(uid)}/capture?lines=${lines}`);
        if (res.status >= 400) return errText(apiError(res));
        return okText(typeof res.data === 'string' ? res.data : JSON.stringify(res.data, null, 2));
      }
      if (mode === 'last' && resolved?.window) {
        const w = resolved.window;
        return okText(
          JSON.stringify(
            {
              uid: w.uid,
              title: w.title ?? w.name,
              status: w.status,
              ask: w.ask ?? null,
              askId: w.askId ?? null,
              detail: w.detail ?? null,
              reply: w.reply ?? null,
            },
            null,
            2,
          ),
        );
      }
      const uid = resolved?.uid ?? target;
      const limit = typeof args.lines === 'number' && Number.isFinite(args.lines) ? Math.max(1, Math.min(100, Math.floor(args.lines))) : 20;
      const res = await ctx.api.request('GET', `/api/sessions/${encodeURIComponent(uid)}/feed?limit=${limit}`);
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'session_send': {
      const target = asStr(args.target);
      const text = asStr(args.text);
      if (!target || !text) return errText('target and text are required.');
      const resolved = await resolveWindowId(ctx.api, target);
      const uid = resolved?.uid ?? target;
      const res = await ctx.api.request('POST', `/api/sessions/${encodeURIComponent(uid)}/send`, { text, enter: true });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'session_answer': {
      const target = asStr(args.target);
      const choice = asStr(args.choice);
      if (!target || (choice !== 'yes' && choice !== 'no')) return errText('target and choice ("yes"|"no") are required.');
      const resolved = await resolveWindowId(ctx.api, target);
      if (!resolved) return errText(`Live session not found: ${target}`);
      const askId = typeof resolved.window?.askId === 'string' ? resolved.window.askId : undefined;
      const res = await ctx.api.request('POST', `/api/sessions/${encodeURIComponent(resolved.uid)}/answer`, {
        answer: choice === 'yes' ? 'approve' : 'deny',
        ...(askId ? { prompt: askId } : {}),
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'session_forward': {
      const target = asStr(args.target);
      if (!target) return errText('target is required.');
      const resolved = await resolveWindowId(ctx.api, target);
      const uid = resolved?.uid ?? target;
      const res = await ctx.api.request('POST', `/api/sessions/${encodeURIComponent(uid)}/forward`, {
        ...(asStr(args.note) ? { note: asStr(args.note) } : {}),
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'session_supervise': {
      const target = asStr(args.target);
      if (!target) return errText('target is required.');
      const patch: Record<string, unknown> = {};
      if (asStr(args.role)) patch.role = asStr(args.role);
      const mgr = asStr(args.managedBy);
      if (mgr === 'self' && ctx.sessionUid) patch.managedBy = ctx.sessionUid;
      else if (mgr) patch.managedBy = mgr;
      else if (ctx.sessionUid && !('managedBy' in args)) patch.managedBy = ctx.sessionUid;
      if (typeof args.muteAlerts === 'boolean') patch.muteAlerts = args.muteAlerts;
      if (Array.isArray(args.tags)) patch.tags = args.tags;
      const res = await ctx.api.request('PUT', `/api/sessions/${encodeURIComponent(target)}/supervision`, patch);
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'session_interrupt': {
      const target = asStr(args.target);
      if (!target) return errText('target is required.');
      const resolved = await resolveWindowId(ctx.api, target);
      const uid = resolved?.uid ?? target;
      const res = await ctx.api.request('POST', `/api/sessions/${encodeURIComponent(uid)}/interrupt`, {});
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'task_create': {
      const title = asStr(args.title);
      if (!title) return errText('title is required.');
      const prioMap: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
      const rawPrio = args.priority;
      const priority =
        typeof rawPrio === 'number' && Number.isInteger(rawPrio)
          ? rawPrio
          : typeof rawPrio === 'string' && rawPrio in prioMap
            ? prioMap[rawPrio]
            : undefined;
      const res = await ctx.api.request('POST', '/api/fleet/tasks', {
        title,
        ...(asStr(args.description) ? { description: asStr(args.description) } : {}),
        ...(space ? { space } : {}),
        ...(asStr(args.assignedUid) ? { assignedUid: asStr(args.assignedUid) } : {}),
        ...(priority !== undefined ? { priority } : {}),
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'mail_send': {
      const toUid = asStr(args.toUid);
      const body = asStr(args.body);
      if (!toUid || !body) return errText('toUid and body are required.');
      const res = await ctx.api.request('POST', '/api/fleet/mailbox', {
        toUid,
        body,
        kind: asStr(args.kind) ?? 'directive',
        ...(asStr(args.subject) ? { subject: asStr(args.subject) } : {}),
        wake: args.wake !== false,
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    case 'wake_subscribe': {
      const action = asStr(args.action) ?? 'list';
      if (action === 'list') {
        const res = await ctx.api.request('GET', '/api/jobs');
        if (res.status >= 400) return errText(apiError(res));
        return okText(JSON.stringify(res.data, null, 2));
      }
      if (action === 'cancel') {
        const jobId = asStr(args.jobId);
        if (!jobId) return errText('jobId is required when action="cancel".');
        const res = await ctx.api.request('POST', `/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
        if (res.status >= 400) return errText(apiError(res));
        return okText(JSON.stringify(res.data, null, 2));
      }
      if (!ctx.sessionUid) return errText('Cannot create wake subscription without $AH_SESSION_UID.');
      if (action === 'heartbeat') {
        const seconds = typeof args.everySeconds === 'number' && Number.isFinite(args.everySeconds) ? Math.max(30, Math.floor(args.everySeconds)) : 900;
        const text = asStr(args.text) ?? `Heartbeat check for ${space ? `Space "${space}"` : 'fleet'}: inspect sessions, unread mail, and open tasks.`;
        const res = await ctx.api.request('POST', '/api/jobs', {
          name: `Chief heartbeat${space ? ` (${space})` : ''}`,
          action: { kind: 'send', target: ctx.sessionUid, text },
          trigger: { kind: 'every', seconds },
          policy: { ifLive: true, skipIfBusy: true, until: 'delivered' },
        });
        if (res.status >= 400) return errText(apiError(res));
        return okText(JSON.stringify(res.data, null, 2));
      }
      const on = asStr(args.on) ?? 'waiting';
      const defaultText =
        on === 'waiting'
          ? '[Space event] Session {{trigger.title}} ({{trigger.session}}, {{trigger.agent}}) is waiting:\n{{trigger.ask}}\n\nInspect and approve safe actions (`session_answer`) or escalate risky/product prompts (`session_forward`).'
          : '[Space event] Session {{trigger.title}} ({{trigger.session}}, {{trigger.agent}}) event={{trigger.event}}.\nLatest reply: {{trigger.reply}}';
      const res = await ctx.api.request('POST', '/api/jobs', {
        name: `Chief watch ${on}${space ? ` (${space})` : ''}`,
        action: { kind: 'send', target: ctx.sessionUid, text: asStr(args.text) ?? defaultText },
        trigger: { kind: 'session', uid: '*', ...(space ? { space } : {}), on, repeat: true, exclude: [ctx.sessionUid], excludeRoles: ['chief'] },
        policy: { ifLive: true, skipIfBusy: true, until: 'delivered' },
      });
      if (res.status >= 400) return errText(apiError(res));
      return okText(JSON.stringify(res.data, null, 2));
    }

    default:
      return errText(`Unhandled tool: ${name}`);
  }
}

/** Pure JSON-RPC 2.0 handler for `ah mcp`. Returns null for notifications. */
export async function handleMcpRequest(msg: JsonRpcRequest, ctx: McpContext): Promise<Record<string, unknown> | null> {
  const id = msg.id;
  const method = msg.method;
  if (!method || typeof method !== 'string') {
    if (id === undefined) return null;
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (method.startsWith('notifications/')) return null;

  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  try {
    switch (method) {
      case 'initialize': {
        const clientProto = typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2024-11-05';
        return reply({
          protocolVersion: clientProto,
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'ah', version: '1.0.0' },
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: toolsForRole(ctx.role, ctx.managedBy) });
      case 'tools/call': {
        const params = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
        const toolName = typeof params.name === 'string' ? params.name : '';
        const toolArgs = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
        if (!toolName) return fail(-32602, 'tools/call requires params.name');
        return reply(await callTool(toolName, toolArgs, ctx));
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, err instanceof Error ? err.message : String(err));
  }
}
