// A session's conversation as a feed (docs/gui.md): a page of it, its prompts, and a
// server-sent stream that resumes from what the client already has (feed/stream.ts).
import { SNAPSHOT, feedPage, feedPrompts, streamFeed } from '../feed/stream.ts';
import { HttpError, send, sse } from '../http.ts';
import { addViewer, clientId } from '../terminal.ts';
import type { Auth } from '../auth.ts';
import type { Core } from '../core.ts';
import { route, type Route } from './router.ts';

export type FeedRouteDeps = {
  auth: Auth;
  core: Core;
};

export function feedRoutes({ auth, core }: FeedRouteDeps): Route[] {
  return [
    // GUI view: the session's transcript as typed events (server/feed). A stream of
    // snapshot/append messages, plus pages of older entries on demand.
    route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed\/stream$/, ({ req, res, url, m, caller }) => {
      const ref = m[1];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const done = new AbortController();
      const ping = setInterval(() => sse(res, ': ping\n\n'), 25_000);
      const untrack = auth.track(caller, { close: () => res.end() });
      // Reading the GUI is looking at the session, the same as its terminal.
      const device = (url.searchParams.get('device') ?? '').slice(0, 60) || 'browser';
      let leave: (() => void) | null = null;
      void core.current().then((st) => {
        const win = st.windows.find((w) => w.uid === ref);
        if (win && !done.signal.aborted) leave = addViewer(win.id, device, clientId(url.searchParams.get('client')));
      });
      req.on('close', () => {
        done.abort();
        clearInterval(ping);
        untrack();
        leave?.();
      });
      // A viewer holding the transcript up to an entry carries on from it (feed/stream.ts Resume).
      const after = Number(url.searchParams.get('after'));
      const resume = Number.isInteger(after) && after > 0 ? { after, id: url.searchParams.get('id') ?? '', harness: url.searchParams.get('harness') ?? '' } : null;
      streamFeed((fresh) => core.feedSource(ref, fresh ? 3000 : 15_000), (msg) => sse(res, `event: ${msg.type}\ndata: ${JSON.stringify(msg)}\n\n`), done.signal, resume);
      return;
    }),
    route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed\/prompts$/, async ({ res, m }) => {
      const prompts = await feedPrompts(() => core.feedSource(m![1]));
      if (!prompts) throw new HttpError(404, 'no transcript');
      return send(res, 200, { prompts });
    }),
    route('GET', /^\/api\/sessions\/([\w:.-]{1,80})\/feed$/, async ({ res, url, m }) => {
      const before = Number(url.searchParams.get('before') ?? Infinity);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || SNAPSHOT));
      if (Number.isNaN(before)) throw new HttpError(400, 'invalid before');
      const page = await feedPage(() => core.feedSource(m![1]), before, limit);
      if (!page) throw new HttpError(404, 'no transcript');
      return send(res, 200, page);
    }),
  ];
}
