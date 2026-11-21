// A session's attached terminal (attachedTerminal.ts): a shell beside the agent, in its
// folder, optionally running a snippet from a reply.
import { HttpError, readJson, send, str } from '../http.ts';
import type { AttachedTerminals } from '../attachedTerminal.ts';
import type { Core } from '../core.ts';
import { route, type Audit, type Route } from './router.ts';

export type TerminalsRouteDeps = {
  audit: Audit;
  core: Core;
  terminals: AttachedTerminals;
};

export function terminalsRoutes({ audit, core, terminals }: TerminalsRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/terminal$/, async ({ res, m }) => {
      return send(res, 200, { terminal: await terminals.get(m[1]) });
    }),
    // Its text for the chat: the newest command run in it with what that printed, and the screen.
    route('GET', /^\/api\/sessions\/([\w-]{1,40})\/terminal\/text$/, async ({ res, m }) => {
      return send(res, 200, await terminals.text(m[1]));
    }),
    route('POST', /^\/api\/sessions\/([\w-]{1,40})\/terminal$/, async ({ req, res, m }) => {
      const uid = m[1];
      const body = await readJson(req);
      const command = body.command === undefined ? undefined : str(body.command, 'command', 60_000);
      if (command !== undefined && !command.trim()) throw new HttpError(400, 'command required');
      if (body.run !== undefined && typeof body.run !== 'boolean') throw new HttpError(400, 'run must be a boolean');
      const run = body.run !== false;
      const terminal = await terminals.open(uid, command, run);
      audit(req, command === undefined ? 'terminal.open' : run ? 'terminal.run' : 'terminal.type', { uid });
      await core.tick();
      return send(res, 200, { terminal });
    }),
    route('DELETE', /^\/api\/sessions\/([\w-]{1,40})\/terminal$/, async ({ req, res, m }) => {
      await terminals.close(m[1]);
      audit(req, 'terminal.close', { uid: m[1] });
      await core.tick();
      return send(res, 200, { ok: true });
    }),
  ];
}
