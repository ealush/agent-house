// Spaces (docs/spec/17-spaces.md): the list, a new plain Space, its preferences and
// memory, removing and restoring. Thin: the rules are server/spaces.
import type { IncomingMessage } from 'node:http';
import { HttpError, readBody, send } from '../http.ts';
import type { SpacesService } from '../spaces/service.ts';
import { route, type Audit, type Route } from './router.ts';

export type SpacesRouteDeps = {
  audit: Audit;
  spaces: SpacesService;
};

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

export function spacesRoutes({ audit, spaces }: SpacesRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/spaces$/, async ({ res }) => send(res, 200, await spaces.list())),
    route('POST', /^\/api\/spaces$/, async ({ req, res }) => {
      const body = await json(req);
      const space = await spaces.create(body.name, body.preferences);
      audit(req, 'space.create', { name: space.name });
      return send(res, 201, { space });
    }),
    route('POST', /^\/api\/spaces\/remove$/, async ({ req, res }) => {
      const body = await json(req);
      const removed = await spaces.remove(body.name);
      audit(req, 'space.remove', { name: removed.name, kind: removed.kind, archived: removed.archived });
      return send(res, 200, { removed });
    }),
    route('POST', /^\/api\/spaces\/restore$/, async ({ req, res }) => {
      const body = await json(req);
      const space = await spaces.restore(body.name);
      audit(req, 'space.restore', { name: body.name });
      return send(res, 200, { space });
    }),
    route('GET', /^\/api\/spaces\/([^/]{1,600})\/preferences$/, async ({ res, m }) => send(res, 200, await spaces.preferences(named(m[1])))),
    route('PUT', /^\/api\/spaces\/([^/]{1,600})\/preferences$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      const out = await spaces.setPreferences(name, (await json(req)).text);
      audit(req, 'space.preferences', { name });
      return send(res, 200, out);
    }),
    route('GET', /^\/api\/spaces\/([^/]{1,600})\/memory$/, async ({ res, m }) => send(res, 200, await spaces.memory(named(m[1])))),
    route('PUT', /^\/api\/spaces\/([^/]{1,600})\/memory\/([^/]{1,200})$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      const file = await spaces.setMemory(name, named(m[2]), (await json(req)).text);
      audit(req, 'space.memory.save', { name, file: file.name });
      return send(res, 200, file);
    }),
    route('DELETE', /^\/api\/spaces\/([^/]{1,600})\/memory\/([^/]{1,200})$/, async ({ req, res, m }) => {
      const name = named(m[1]);
      const file = named(m[2]);
      await spaces.deleteMemory(name, file);
      audit(req, 'space.memory.delete', { name, file });
      return send(res, 200, { ok: true });
    }),
  ];
}
