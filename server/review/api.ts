// HTTP for stack review, under /api/review. Thin: validation here, behavior in
// service.ts. Every GitHub write and every send to an agent is audited.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, send, str } from '../http.ts';
import { SideChatError } from '../sidechat.ts';
import { ReviewError, type ReviewService } from './service.ts';

type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

const ID = '([\\w-]{4,40})';
const PR = '(\\d{1,7})';

function int(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `invalid ${field}`);
  return n;
}

function opt<T>(v: unknown, fn: (v: unknown) => T): T | undefined {
  return v === undefined ? undefined : fn(v);
}

export async function reviewApi(req: IncomingMessage, res: ServerResponse, url: URL, path: string, svc: ReviewService, audit: Audit): Promise<void> {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: string) => (method === verb ? path.match(new RegExp(`^/api/review${re}$`)) : null);
  let m: RegExpMatchArray | null;
  try {
    if (route('GET', '/repos')) return send(res, 200, await svc.repos());

    if (route('GET', '/candidates')) return send(res, 200, await svc.candidates(str(url.searchParams.get('root') ?? '', 'root', 1000)));

    if (route('GET', '/stacks')) return send(res, 200, await svc.list());

    if (route('GET', '/settings')) return send(res, 200, await svc.settings());

    if (route('PUT', '/settings')) {
      const body = await readJson(req);
      return send(res, 200, await svc.setSummaryModel(body.summaryId === null ? null : str(body.summaryId, 'summaryId', 40)));
    }

    if (route('POST', '/stacks')) {
      const body = await readJson(req);
      const input = Array.isArray(body.prs) ? { prs: body.prs.slice(0, 61).map((n) => int(n, 'prs')) } : body.native !== undefined ? { native: int(body.native, 'native') } : { pr: int(body.pr, 'pr') };
      const v = await svc.create(str(body.root, 'root', 1000), input, opt(body.title, (x) => str(x, 'title', 120)));
      audit(req, 'review.stack', { stack: v.id, repo: v.repo, source: v.source, prs: v.layers.map((l) => l.pr) });
      return send(res, 200, v);
    }

    if ((m = route('GET', `/stacks/${ID}`))) return send(res, 200, await svc.view(m[1]));

    if ((m = route('PATCH', `/stacks/${ID}`))) {
      const body = await readJson(req);
      const order = body.order === undefined ? undefined : Array.isArray(body.order) && body.order.length <= 200 ? body.order.map((n) => int(n, 'order')) : (() => { throw new HttpError(400, 'invalid order'); })();
      return send(
        res,
        200,
        await svc.update(m[1], {
          title: opt(body.title, (x) => str(x, 'title', 120)),
          planPath: body.planPath === null ? null : opt(body.planPath, (x) => str(x, 'planPath', 1000)),
          mergeMethod: opt(body.mergeMethod, (x) => str(x, 'mergeMethod', 10)),
          state: opt(body.state, (x) => str(x, 'state', 10)),
          ownerUid: body.ownerUid === null ? null : opt(body.ownerUid, (x) => str(x, 'ownerUid', 80)),
          order,
        }),
      );
    }

    if ((m = route('DELETE', `/stacks/${ID}`))) {
      await svc.remove(m[1]);
      audit(req, 'review.remove', { stack: m[1] });
      return send(res, 200, { ok: true });
    }

    if ((m = route('POST', `/stacks/${ID}/link`))) {
      const v = await svc.link(m[1]);
      audit(req, 'review.link', { stack: m[1], ghStack: v.ghStack, prs: v.layers.filter((l) => l.ghStack === v.ghStack).map((l) => l.pr) });
      return send(res, 200, v);
    }

    if ((m = route('POST', `/stacks/${ID}/sync`))) {
      await svc.sync(m[1], true);
      return send(res, 200, await svc.view(m[1]));
    }

    if ((m = route('GET', `/stacks/${ID}/owners`))) return send(res, 200, await svc.ownerSuggestions(m[1]));

    if ((m = route('GET', `/stacks/${ID}/plan`))) return send(res, 200, await svc.plan(m[1]));

    if ((m = route('POST', `/stacks/${ID}/layers`))) {
      const body = await readJson(req);
      if (!Array.isArray(body.prs)) throw new HttpError(400, 'prs required');
      return send(res, 200, await svc.addLayers(m[1], body.prs.slice(0, 61).map((n) => int(n, 'prs'))));
    }

    if ((m = route('DELETE', `/stacks/${ID}/layers/${PR}`))) {
      const v = await svc.removeLayer(m[1], Number(m[2]));
      audit(req, 'review.removeLayer', { stack: m[1], pr: Number(m[2]) });
      return send(res, 200, v);
    }

    if ((m = route('PATCH', `/stacks/${ID}/layers/${PR}`))) {
      const body = await readJson(req);
      return send(
        res,
        200,
        await svc.setLayer(m[1], Number(m[2]), {
          role: opt(body.role, (x) => str(x, 'role', 16)),
          skipped: opt(body.skipped, (x) => x === true),
          ownerUid: body.ownerUid === null ? null : opt(body.ownerUid, (x) => str(x, 'ownerUid', 80)),
        }),
      );
    }

    if ((m = route('GET', `/stacks/${ID}/layers/${PR}/diff`))) {
      const mode = url.searchParams.get('mode');
      return send(res, 200, await svc.layerDiff(m[1], Number(m[2]), mode === 'since' || mode === 'cumulative' ? mode : 'this'));
    }

    if ((m = route('GET', `/stacks/${ID}/layers/${PR}/busy`))) return send(res, 200, svc.busy(m[1], Number(m[2])));

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/summary`))) {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      return send(res, 200, await svc.summarize(m[1], Number(m[2]), body.force === true));
    }

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/approve`))) {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      return send(res, 200, await svc.approve(m[1], Number(m[2]), body.approved !== false));
    }

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/accept`))) {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const overrides: Record<number, 'addressed' | 'open'> = {};
      if (body.overrides && typeof body.overrides === 'object') {
        for (const [k, v] of Object.entries(body.overrides as Record<string, unknown>)) if (v === 'addressed' || v === 'open') overrides[int(k, 'finding')] = v;
      }
      return send(res, 200, await svc.acceptVerdict(m[1], Number(m[2]), overrides));
    }

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/threads`))) return send(res, 200, await svc.importThreads(m[1], Number(m[2])));

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/merge`))) {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const out = await svc.merge(m[1], Number(m[2]), { outOfOrder: body.outOfOrder === true });
      audit(req, 'review.merge', { stack: m[1], pr: Number(m[2]), merged: out.merged, retargeted: out.retargeted, waiting: out.waiting });
      return send(res, 200, out);
    }

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/retarget`))) {
      const v = await svc.retargetLayer(m[1], Number(m[2]));
      audit(req, 'review.retarget', { stack: m[1], pr: Number(m[2]), base: v.trunk });
      return send(res, 200, v);
    }

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/ready`))) {
      const v = await svc.ready(m[1], Number(m[2]));
      audit(req, 'review.ready', { stack: m[1], pr: Number(m[2]) });
      return send(res, 200, v);
    }

    if ((m = route('GET', `/stacks/${ID}/layers/${PR}/dispatch`))) {
      const ids = (url.searchParams.get('findings') ?? '').split(',').filter(Boolean).slice(0, 50).map((x) => int(x, 'finding'));
      const kind = url.searchParams.get('kind');
      const text = kind === 'restack' ? await svc.restackText(m[1], Number(m[2])) : await svc.dispatchText(m[1], Number(m[2]), ids, (url.searchParams.get('extra') ?? '').slice(0, 8000));
      return send(res, 200, { text });
    }

    if ((m = route('POST', `/stacks/${ID}/layers/${PR}/dispatch`))) {
      const body = await readJson(req);
      const ids = Array.isArray(body.findingIds) ? body.findingIds.slice(0, 50).map((x) => int(x, 'finding')) : [];
      const out = await svc.dispatch(m[1], Number(m[2]), { findingIds: ids, text: str(body.text, 'text', 16_000), targetUid: opt(body.targetUid, (x) => str(x, 'targetUid', 80)) });
      audit(req, 'review.dispatch', { stack: m[1], pr: Number(m[2]), to: out.dispatch.targetUid, findings: ids.length });
      return send(res, 200, out);
    }

    if ((m = route('GET', `/stacks/${ID}/findings`))) {
      const pr = url.searchParams.get('pr');
      return send(res, 200, await svc.findings(m[1], pr ? int(pr, 'pr') : undefined));
    }

    if ((m = route('POST', `/stacks/${ID}/findings`))) {
      const body = await readJson(req);
      const line = (k: string) => (body[k] === undefined || body[k] === null ? null : int(body[k], k));
      return send(
        res,
        200,
        await svc.addFinding(m[1], {
          ownerPr: int(body.ownerPr, 'ownerPr'),
          foundOnPr: body.foundOnPr === undefined ? undefined : int(body.foundOnPr, 'foundOnPr'),
          title: str(body.title, 'title', 140),
          body: opt(body.body, (x) => str(x, 'body', 4000)),
          severity: opt(body.severity, (x) => str(x, 'severity', 10)),
          path: body.path === undefined || body.path === null ? null : str(body.path, 'path', 300),
          lineStart: line('lineStart'),
          lineEnd: line('lineEnd'),
        }),
      );
    }

    if ((m = route('PATCH', `/stacks/${ID}/findings/(\\d{1,9})`))) {
      const body = await readJson(req);
      return send(
        res,
        200,
        await svc.updateFinding(m[1], Number(m[2]), {
          state: opt(body.state, (x) => str(x, 'state', 12)),
          severity: opt(body.severity, (x) => str(x, 'severity', 10)),
          title: opt(body.title, (x) => str(x, 'title', 140)),
          body: opt(body.body, (x) => str(x, 'body', 4000)),
          ownerPr: opt(body.ownerPr, (x) => int(x, 'ownerPr')),
          note: body.note === null ? null : opt(body.note, (x) => str(x, 'note', 1000)),
        }),
      );
    }

    if ((m = route('POST', `/stacks/${ID}/findings/(\\d{1,9})/resolve`))) {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const out = await svc.resolveThread(m[1], Number(m[2]), body.body === undefined ? '' : str(body.body, 'body', 4000));
      audit(req, 'review.resolve', { stack: m[1], finding: Number(m[2]) });
      return send(res, 200, out);
    }

    if ((m = route('POST', `/stacks/${ID}/decisions`))) {
      const body = await readJson(req);
      return send(res, 200, await svc.addDecision(m[1], str(body.text, 'text', 500), body.fromPr === undefined || body.fromPr === null ? null : int(body.fromPr, 'fromPr')));
    }

    if ((m = route('DELETE', `/stacks/${ID}/decisions/(\\d{1,9})`))) return send(res, 200, await svc.removeDecision(m[1], Number(m[2])));

    // Threads: the stack's own (no pr), or a layer's.
    if ((m = route('GET', `/stacks/${ID}/chat`))) {
      const pr = url.searchParams.get('pr');
      return send(res, 200, await svc.thread(m[1], pr ? int(pr, 'pr') : null));
    }

    if ((m = route('POST', `/stacks/${ID}/chat`))) {
      const body = await readJson(req);
      const text = str(body.text, 'text', 8000).trim();
      if (!text) throw new HttpError(400, 'text required');
      const pr = body.pr === undefined || body.pr === null ? null : int(body.pr, 'pr');
      return send(res, 200, await svc.ask(m[1], pr, text, opt(body.subscriptionId, (x) => str(x, 'subscriptionId', 40))));
    }

    if ((m = route('DELETE', `/stacks/${ID}/chat`))) {
      const pr = url.searchParams.get('pr');
      await svc.clearThread(m[1], pr ? int(pr, 'pr') : null);
      return send(res, 200, { ok: true });
    }
  } catch (err) {
    if (err instanceof ReviewError || err instanceof SideChatError) throw new HttpError(err.status, err.message);
    throw err;
  }
  throw new HttpError(404, 'not found');
}
