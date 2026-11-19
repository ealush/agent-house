// Side chats and subscriptions over HTTP: the providers you've connected (Settings →
// Subscriptions), a window's change discussion outside the agent's context, stored chats,
// and one-shot summaries. Every provider call is sidechat.ts's.
import { expandHome } from '../config.ts';
import { pullRequest } from '../git.ts';
import { HttpError, readJson, send, str } from '../http.ts';
import { changeContext } from '../sidechat.ts';
import type { Core } from '../core.ts';
import type { SideChatStore } from '../sidechat.ts';
import { route, type Audit, type Route } from './router.ts';

export type ChatRouteDeps = {
  audit: Audit;
  core: Core;
  sidechat: SideChatStore;
};

export function chatRoutes({ audit, core, sidechat }: ChatRouteDeps): Route[] {
  const chatKeyFor = async (windowId: string) => {
    const w = (await core.current()).windows.find((w) => w.id === windowId);
    if (!w) throw new HttpError(404, 'window not found');
    const key = sidechat.chatKey(w.agent, w.harnessId, w.uid);
    await sidechat.rekey(w.uid, key);
    return key;
  };
  return [
    route('GET', /^\/api\/subscriptions$/, async ({ res }) => send(res, 200, await sidechat.list())),
    route('POST', /^\/api\/subscriptions$/, async ({ req, res }) => {
      const body = await readJson(req);
      const out = await sidechat.put({
        ...(body.id === undefined ? {} : { id: str(body.id, 'id', 40) }),
        name: str(body.name ?? '', 'name', 80),
        baseUrl: str(body.baseUrl ?? '', 'baseUrl', 200),
        model: str(body.model ?? '', 'model', 80),
        ...(body.apiKey === undefined ? {} : { apiKey: str(body.apiKey, 'apiKey', 500) }),
        ...(body.envName === undefined ? {} : { envName: str(body.envName, 'envName', 128) }),
      });
      audit(req, 'subscription.save', { id: out.id, name: out.name, ...(out.envName ? { env: out.envName } : {}) });
      return send(res, 200, out);
    }),
    // The models an endpoint offers, so the form can offer them: a typed key, or a saved one at its own URL.
    route('POST', /^\/api\/subscriptions\/models$/, async ({ req, res }) => {
      const body = await readJson(req);
      const models = await sidechat.models({
        baseUrl: str(body.baseUrl ?? '', 'baseUrl', 200),
        ...(body.apiKey === undefined ? {} : { apiKey: str(body.apiKey, 'apiKey', 500) }),
        ...(body.id === undefined ? {} : { id: str(body.id, 'id', 40) }),
      });
      return send(res, 200, { models });
    }),
    route('DELETE', /^\/api\/subscriptions\/([\w-]{1,40})$/, async ({ req, res, m }) => {
      await sidechat.remove(m[1]);
      audit(req, 'subscription.remove', { id: m[1] });
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/subscriptions\/default$/, async ({ req, res }) => {
      const id = str((await readJson(req)).id, 'id', 40);
      await sidechat.setDefault(id);
      audit(req, 'subscription.default', { id });
      return send(res, 200, { ok: true });
    }),
    // Handoff brief: summarize a transcript with the chat subscription. Not stored.
    route('POST', /^\/api\/summarize$/, async ({ req, res }) => {
      const body = await readJson(req);
      const text = str(body.text ?? '', 'text', 24_000).trim();
      if (!text) throw new HttpError(400, 'text required');
      const summary = await sidechat.summarize(text, body.subscriptionId === undefined ? undefined : str(body.subscriptionId, 'subscriptionId', 40));
      return send(res, 200, { summary });
    }),
    route('GET', /^\/api\/windows\/(@\d+)\/chat$/, async ({ res, m }) => {
      const key = await chatKeyFor(m![1]);
      const [messages, subscriptionId] = await Promise.all([sidechat.history(key), sidechat.picked(key)]);
      return send(res, 200, { messages, subscriptionId });
    }),
    // The subscription this side chat answers with, picked before (or between) turns.
    route('PUT', /^\/api\/windows\/(@\d+)\/chat\/subscription$/, async ({ req, res, m }) => {
      const key = await chatKeyFor(m![1]);
      await sidechat.pick(key, str((await readJson(req)).id, 'id', 40));
      return send(res, 200, { ok: true });
    }),
    route('POST', /^\/api\/windows\/(@\d+)\/chat$/, async ({ req, res, m }) => {
      const w = (await core.current()).windows.find((w) => w.id === m![1]);
      if (!w) throw new HttpError(404, 'window not found');
      const key = sidechat.chatKey(w.agent, w.harnessId, w.uid);
      await sidechat.rekey(w.uid, key);
      const body = await readJson(req);
      const text = str(body.text ?? '', 'text', 8000).trim();
      if (!text) throw new HttpError(400, 'text required');
      const dir = expandHome(w.cwd);
      const [chg, pr] = await Promise.all([changeContext(dir).catch(() => null), pullRequest(dir).catch(() => null)]);
      const msg = await sidechat.chat(
        key,
        text,
        { title: w.title, session: w.session, branch: chg?.branch ?? w.branch, pr: pr?.number ?? null, diff: chg?.diff ?? '', dir },
        body.subscriptionId === undefined ? undefined : str(body.subscriptionId, 'subscriptionId', 40),
      );
      return send(res, 200, msg);
    }),
    route('DELETE', /^\/api\/windows\/(@\d+)\/chat$/, async ({ res, m }) => {
      const key = await chatKeyFor(m![1]);
      await sidechat.clear(key);
      return send(res, 200, { ok: true });
    }),
    route('GET', /^\/api\/chats$/, async ({ res, url }) => {
      const q = url.searchParams.get('q') ?? undefined;
      return send(res, 200, await sidechat.listChats(q?.slice(0, 200)));
    }),
    route('GET', /^\/api\/chats\/([\w:.-]{1,80})$/, async ({ res, url, m }) => {
      return send(res, 200, { messages: await sidechat.history(m[1], Number(url.searchParams.get('msgId')) || undefined) });
    }),
  ];
}
