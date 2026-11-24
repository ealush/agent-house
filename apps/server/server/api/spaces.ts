// Spaces (docs/spec/17-spaces.md): the list, a new plain Space, its preferences and
// memory, removing and restoring. Thin: the rules are server/spaces.
import type { IncomingMessage } from 'node:http';
import { actorUid, HttpError, readBody, send } from '../http.ts';
import type { SpacesService } from '../spaces/service.ts';
import { buildChiefBrief, type SupervisionGraph } from '../supervision.ts';
import { route, type Audit, type Route } from './router.ts';

export type SpacesRouteDeps = {
  audit: Audit;
  spaces: SpacesService;
  graph?: () => SupervisionGraph;
  sessionsInSpace?: (spaceName: string) => Promise<Array<{ uid: string; title: string; agent: string | null; status: string }>>;
};

/**
 * Enforces Space write authorization when called by an acting session:
 * - Human callers (no `actorUid`) are always allowed.
 * - Supervised workers/reviewers and unmanaged non-chief sessions cannot rewrite Space
 *   preferences, promote/delete memory, or create/remove Spaces.
 * - Space-scoped Chiefs may write/promote ONLY inside their own Space (never another Space,
 *   and never creating/removing Spaces globally).
 * - Fleet-wide Chiefs (`role === 'chief'` with no `space`) may write to any Space.
 */
function assertSpaceWriteAllowed(
  req: IncomingMessage,
  graph?: () => SupervisionGraph,
  targetSpace?: string | null,
  globalOp = false,
): void {
  const actor = actorUid(req);
  if (!actor || !graph) return;
  const sup = graph().get(actor);
  if (sup?.managedBy && sup.role !== 'chief') {
    throw new HttpError(403, 'supervised worker sessions cannot overwrite Space preferences, remove Spaces, or delete Space memory; propose changes to your Chief of Staff', 'upward_control_denied');
  }
  if (sup?.role !== 'chief') {
    throw new HttpError(403, 'only the user or a Chief of Staff may modify Space preferences, memory, or lifecycle', 'not_managed_by_caller');
  }
  if (sup.space) {
    if (globalOp) {
      throw new HttpError(403, `chief ${actor} is scoped to Space "${sup.space}" and cannot create, remove, or restore Spaces`, 'not_managed_by_caller');
    }
    if (targetSpace && targetSpace.toLowerCase() !== sup.space.toLowerCase()) {
      throw new HttpError(403, `chief ${actor} is scoped to Space "${sup.space}" and cannot modify Space "${targetSpace}"`, 'not_managed_by_caller');
    }
  }
}

function assertSpaceReadAllowed(
  req: IncomingMessage,
  graph?: () => SupervisionGraph,
  targetSpace?: string | null,
): void {
  const actor = actorUid(req);
  if (!actor || !graph || !targetSpace) return;
  const sup = graph().get(actor);
  // Space-scoped sessions (Chiefs or workers explicitly bound to a Space) cannot read another Space's context.
  if (sup?.space && sup.space.toLowerCase() !== targetSpace.toLowerCase()) {
    throw new HttpError(403, `session ${actor} is scoped to Space "${sup.space}" and cannot read Space "${targetSpace}"`, 'not_managed_by_caller');
  }
}

/** A memory file is up to 262 144 characters of any script: a few times that once JSON-escaped. */
const BODY = 2 * 1024 * 1024;

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, BODY);
  try {
    const v = JSON.parse(body.toString() || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

/** A Space's name from the path: percent-encoded (names may hold spaces). */
function named(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    throw new HttpError(400, 'invalid name');
  }
}

export function spacesRoutes({ audit, spaces, graph, sessionsInSpace }: SpacesRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/spaces$/, async ({ res }) => send(res, 200, await spaces.list())),
    route('POST', /^\/api\/spaces$/, async ({ req, res }) => {
      assertSpaceWriteAllowed(req, graph, null, true);
      const body = await json(req);
      const space = await spaces.create(body.name, body.preferences, body.projects);
      audit(req, 'space.create', { name: space.name, projects: space.projects?.length ?? 0 });
      return send(res, 201, { space });
    }),
    // The projects attached to a Space (spaces 3): sessions started in one are in it.
    route('PUT', /^\/api\/spaces\/([^/]{1,600})\/projects$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceWriteAllowed(req, graph, name);
      const body = await json(req);
      const space = await spaces.setProjects(name, body.projects);
      audit(req, 'space.projects', { name, projects: space.projects ?? [] });
      return send(res, 200, { space });
    }),
    route('POST', /^\/api\/spaces\/remove$/, async ({ req, res }) => {
      assertSpaceWriteAllowed(req, graph, null, true);
      const body = await json(req);
      const removed = await spaces.remove(body.name);
      audit(req, 'space.remove', { name: removed.name, kind: removed.kind, archived: removed.archived });
      return send(res, 200, { removed });
    }),
    route('POST', /^\/api\/spaces\/restore$/, async ({ req, res }) => {
      assertSpaceWriteAllowed(req, graph, null, true);
      const body = await json(req);
      const space = await spaces.restore(body.name);
      audit(req, 'space.restore', { name: body.name });
      return send(res, 200, { space });
    }),
    route('GET', /^\/api\/spaces\/([^/]{1,600})\/preferences$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceReadAllowed(req, graph, name);
      return send(res, 200, await spaces.preferences(name));
    }),
    route('PUT', /^\/api\/spaces\/([^/]{1,600})\/preferences$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceWriteAllowed(req, graph, name);
      const body = await json(req);
      const expected = typeof body.expectedUpdatedAt === 'number' ? body.expectedUpdatedAt : undefined;
      const out = await spaces.setPreferences(name, body.text, expected);
      audit(req, 'space.preferences', { name });
      return send(res, 200, out);
    }),
    route('GET', /^\/api\/spaces\/([^/]{1,600})\/memory$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceReadAllowed(req, graph, name);
      return send(res, 200, await spaces.memory(name));
    }),
    route('PUT', /^\/api\/spaces\/([^/]{1,600})\/memory\/([^/]{1,200})$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceWriteAllowed(req, graph, name);
      const body = await json(req);
      const expected = typeof body.expectedUpdatedAt === 'number' ? body.expectedUpdatedAt : undefined;
      const file = await spaces.setMemory(name, named(m[2]), body.text, expected);
      audit(req, 'space.memory.save', { name, file: file.name });
      return send(res, 200, file);
    }),
    route('DELETE', /^\/api\/spaces\/([^/]{1,600})\/memory\/([^/]{1,200})$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceWriteAllowed(req, graph, name);
      const file = named(m[2]);
      await spaces.deleteMemory(name, file);
      audit(req, 'space.memory.delete', { name, file });
      return send(res, 200, { ok: true });
    }),
    // Promote a note, task outcome, or artifact into Space memory/knowledge and index it in MEMORY.md.
    route('POST', /^\/api\/spaces\/([^/]{1,600})\/knowledge\/promote$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceWriteAllowed(req, graph, name);
      const body = await json(req);
      const out = await spaces.promoteKnowledge(name, {
        title: body.title,
        markdown: body.markdown,
        file: body.file,
        source: body.source,
        by: actorUid(req),
      });
      audit(req, 'space.knowledge.promote', { name, file: out.file.name });
      return send(res, 201, out);
    }),
    // Live Space context snapshot for harnesses & CLI (preferences, memory index, artifacts, notes, markdown).
    route('GET', /^\/api\/spaces\/([^/]{1,600})\/context$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      assertSpaceReadAllowed(req, graph, name);
      return send(res, 200, await spaces.context(name, { sync: true }));
    }),
    // Single server-side source of truth for a Space's Chief of Staff opening brief (CLI, Web, iOS).
    route('GET', /^\/api\/spaces\/([^/]{1,600})\/brief$/, async ({ req, res, url, m }) => {
      const name = named(m[1]);
      assertSpaceReadAllowed(req, graph, name);
      const { space } = await spaces.contextDirOf(name);
      const sessions = sessionsInSpace ? await sessionsInSpace(space.name) : [];
      const customInstructions = url.searchParams.get('instructions') ?? undefined;
      const brief = buildChiefBrief({
        spaceName: space.name,
        spacePath: space.path,
        spaceKind: space.kind,
        contextDir: space.contextPath ?? space.path,
        sessions,
        customInstructions,
      });
      return send(res, 200, { brief, space: space.name, contextPath: space.contextPath ?? space.path });
    }),
  ];
}
