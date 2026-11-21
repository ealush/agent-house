// The agents a session's agent spawned, as a tree of sessions (server/subagents). Each
// child's conversation is then read like any session's, by its ref, through feed.ts.
// Read-only: nothing here changes anything, so nothing is audited.
import { send } from '../http.ts';
import type { Core } from '../core.ts';
import { route, type Route } from './router.ts';

export type SubagentRouteDeps = {
  core: Core;
};

export function subagentRoutes({ core }: SubagentRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/subagents$/, async ({ res, m }) => send(res, 200, await core.subagentTree(m![1]))),
  ];
}
