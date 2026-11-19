// The API as tables of routes, one table per bounded context (server/api/*.ts). A route
// is a method, an anchored path pattern and a handler; the first route whose method and
// pattern match answers. Matching is pure; handlers are the delivery layer: decode the
// request, call one service, write the answer. Each context's table gets only the
// services it needs (its `deps`), never the whole app.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from '../auth.ts';

export type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

export type Ctx<C extends Caller | null = Caller> = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  /** The path's captures: m[1] is the first group. */
  m: RegExpMatchArray;
  caller: C;
};

export type Route = { method: string; path: RegExp; public: boolean; run: (c: Ctx<Caller | null>) => unknown };

/** A route for signed-in callers: dispatching it without one is a 401, whatever the front door did. */
export const route = (method: string, path: RegExp, run: (c: Ctx) => unknown): Route => ({ method, path, public: false, run: run as Route['run'] });

/** One of the few routes reachable signed out (sign-in itself). Must also be in admission.ts's PUBLIC_ROUTES. */
export const publicRoute = (method: string, path: RegExp, run: (c: Ctx<Caller | null>) => unknown): Route => ({ method, path, public: true, run });

/** The first route for this method and path, with its captures. */
export function match(routes: readonly Route[], method: string, path: string): { route: Route; m: RegExpMatchArray } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.path);
    if (m) return { route: r, m };
  }
  return null;
}
