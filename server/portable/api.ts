// HTTP for portable conversations, under /api/portable (docs/spec/13-conductor.md).
// Thin: validation here, behavior in service.ts. Reached only past main.ts's gate,
// like every route: a signed-in device or a machine token, X-AH and Origin on
// writes. Continuations start sessions only from configured agents, and are audited.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, send, str } from '../http.ts';

import type { ContinueOptions, PortableService } from './service.ts';

type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

/** A session uid, or `harness:harnessId` for a conversation found on disk. */
const REF = '([\\w:.-]{1,80})';
const LINK = '(lk-[0-9a-f]{8})';

function options(body: Record<string, unknown>): ContinueOptions {
  const to = str(body.to, 'to', 48);
  const intent = body.intent === undefined ? undefined : body.intent === 'continue' || body.intent === 'fork' ? body.intent : null;
  if (intent === null) throw new HttpError(400, 'intent must be continue or fork', 'invalid_intent');
  const budget = body.budget === undefined ? undefined : Number(body.budget);
  if (budget !== undefined && (!Number.isInteger(budget) || budget < 2000 || budget > 400_000)) throw new HttpError(400, 'budget must be 2000–400000 characters', 'invalid_budget');
  const key = body.idempotencyKey === undefined ? undefined : str(body.idempotencyKey, 'idempotencyKey', 120);
  if (key !== undefined && !/^[\w:.-]{8,120}$/.test(key)) throw new HttpError(400, 'idempotencyKey must be 8–120 letters, digits, : . - _', 'invalid_key');
  const choice = (k: string, max: number) => (body[k] === undefined || body[k] === null || body[k] === '' ? undefined : str(body[k], k, max));
  return {
    to,
    intent,
    model: choice('model', 80),
    effort: choice('effort', 20),
    mode: choice('mode', 40),
    worktree: body.worktree === undefined ? undefined : body.worktree === true,
    name: body.name === undefined ? undefined : str(body.name, 'name', 80).trim() || undefined,
    budget,
    idempotencyKey: key,
  };
}

export async function portableApi(req: IncomingMessage, res: ServerResponse, url: URL, path: string, svc: PortableService, audit: Audit): Promise<void> {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: string) => (method === verb ? path.match(new RegExp(`^/api/portable${re}$`)) : null);
  let m: RegExpMatchArray | null;
  if (route('GET', '/capabilities')) return send(res, 200, svc.capabilities());

  if ((m = route('GET', `/conversations/${REF}`))) {
    const { doc, path: file } = await svc.export(m[1]);
    audit(req, 'portable.export', { ref: m[1], conversation: doc.id });
    // ?download=1: the document as a file to keep.
    if (url.searchParams.get('download') === '1') {
      res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': `attachment; filename="${doc.id}.json"`, 'cache-control': 'no-store' });
      return void res.end(JSON.stringify(doc));
    }
    return send(res, 200, { conversation: doc, path: file });
  }

  if ((m = route('GET', `/conversations/${REF}/lineage`))) return send(res, 200, await svc.lineage(m[1]));

  if ((m = route('POST', `/conversations/${REF}/preview`))) {
    const plan = await svc.preview(m[1], options(await readJson(req)));
    const { text: _text, ...shown } = plan;
    return send(res, 200, shown);
  }

  if ((m = route('POST', `/conversations/${REF}/continue`))) {
    const o = options(await readJson(req));
    const { link, existed } = await svc.continue(m[1], o);
    if (!existed) audit(req, 'portable.continue', { ref: m[1], to: o.to, link: link.id, strategy: link.strategy, uid: link.childUid });
    return send(res, existed ? 200 : 201, { operation: await svc.operation(link.id), existed });
  }

  if ((m = route('GET', `/operations/${LINK}`))) return send(res, 200, await svc.operation(m[1]));

  if ((m = route('POST', `/operations/${LINK}/retry`))) {
    const link = await svc.retry(m[1]);
    audit(req, 'portable.retry', { link: link.id, uid: link.childUid });
    return send(res, 200, await svc.operation(link.id));
  }

  if ((m = route('POST', `/operations/${LINK}/cancel`))) {
    const link = await svc.cancel(m[1]);
    audit(req, 'portable.cancel', { link: link.id });
    return send(res, 200, await svc.operation(link.id));
  }

  if (route('GET', '/operations')) return send(res, 200, { operations: (await svc.store.recent(50)).map((l) => ({ id: l.id, kind: l.kind, strategy: l.strategy, state: l.state, fromHarness: l.fromHarness, toHarness: l.toHarness, parentUid: l.parentUid, childUid: l.childUid, error: l.error, createdAt: l.createdAt, updatedAt: l.updatedAt })) });

  throw new HttpError(404, 'not found');
}
