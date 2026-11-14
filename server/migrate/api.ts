// HTTP for moving sessions between hosts, under /api/migrations (CND-3).
//
// Two audiences. You (a signed-in device, the CLI) start, watch, retry and cancel a
// move on the host the session is on. The other host talks to /api/migrations/incoming:
// those routes take only a machine token (the one this host issued to that peer), never
// a browser's sign-in, and treat everything sent as untrusted input.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from '../auth.ts';
import { HttpError, readBody, readJson, send, str } from '../http.ts';
import { MigrateError, type MigrationService } from './service.ts';

type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

const REF = '([\\w:.-]{1,80})';
const ID = '(mg-[0-9a-f]{8})';
const FILE = '(transcript|doc|att-\\d{1,3}|ldoc-lk-[0-9a-f]{8})';

/** Manifests can list many files; still far from a body worth streaming. */
async function readManifestBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, 4 * 1024 * 1024);
  try {
    const v = JSON.parse(body.toString() || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export async function migrateApi(req: IncomingMessage, res: ServerResponse, path: string, caller: Caller | null, svc: MigrationService, audit: Audit): Promise<void> {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: string) => (method === verb ? path.match(new RegExp(`^/api/migrations${re}$`)) : null);
  let m: RegExpMatchArray | null;
  try {
    if (path.startsWith('/api/migrations/incoming')) {
      // Host to host only: a peer's token (or a host with sign-in off), never a device's session.
      if (caller?.kind === 'session') throw new HttpError(403, 'only another host can send a migration here', 'machine_only');
      const from = caller?.kind === 'token' ? caller.token.name : 'local';
      if (route('POST', '/incoming/preflight')) {
        const body = await readManifestBody(req);
        return send(res, 200, await svc.preflight(body.manifest, body.cwd == null ? null : str(body.cwd, 'cwd', 1024)));
      }
      if (route('POST', '/incoming')) {
        const body = await readManifestBody(req);
        const out = await svc.receive(body.manifest, body.cwd == null ? null : str(body.cwd, 'cwd', 1024), from);
        audit(req, 'migration.receive', { id: out.id, from: out.peer, token: from, harness: out.harness });
        return send(res, 200, out);
      }
      if ((m = route('PUT', `/incoming/${ID}/files/${FILE}`))) {
        const sha = req.headers['x-ah-sha256'];
        return send(res, 200, await svc.stage(m[1], m[2], req, typeof sha === 'string' ? sha : undefined));
      }
      if ((m = route('POST', `/incoming/${ID}/commit`))) {
        const out = await svc.commit(m[1]);
        audit(req, 'migration.restore', { id: m[1], uid: out.uid, cwd: out.cwd });
        return send(res, 200, out);
      }
      if ((m = route('POST', `/incoming/${ID}/verify`))) return send(res, 200, await svc.verify(m[1]));
      if ((m = route('DELETE', `/incoming/${ID}`))) {
        const out = await svc.rollback(m[1]);
        audit(req, 'migration.rollback', { id: m[1] });
        return send(res, 200, out);
      }
      throw new HttpError(404, 'not found');
    }

    if (route('GET', '')) return send(res, 200, { migrations: await svc.list() });
    if ((m = route('GET', `/${ID}`))) return send(res, 200, await svc.get(m[1]));
    if (route('POST', '/preview')) {
      const body = await readJson(req);
      return send(res, 200, await svc.preview(str(body.ref, 'ref', 80), str(body.to, 'to', 64), body.cwd == null ? null : str(body.cwd, 'cwd', 1024)));
    }
    if (route('POST', '')) {
      const body = await readJson(req);
      const key = body.idempotencyKey === undefined ? undefined : str(body.idempotencyKey, 'idempotencyKey', 120);
      if (key !== undefined && !/^[\w:.-]{8,120}$/.test(key)) throw new HttpError(400, 'idempotencyKey must be 8–120 letters, digits, : . - _', 'invalid_key');
      const ref = str(body.ref, 'ref', 80);
      if (!new RegExp(`^${REF}$`).test(ref)) throw new HttpError(400, 'invalid ref');
      const out = await svc.start(ref, { to: str(body.to, 'to', 64), cwd: body.cwd == null ? null : str(body.cwd, 'cwd', 1024), acceptWarnings: body.acceptWarnings === true, idempotencyKey: key });
      if (!out.existed) audit(req, 'migration.start', { id: out.migration.id, ref, to: out.migration.peer });
      return send(res, out.existed ? 200 : 201, out);
    }
    if ((m = route('POST', `/${ID}/retry`))) {
      audit(req, 'migration.retry', { id: m[1] });
      return send(res, 200, await svc.retry(m[1]));
    }
    if ((m = route('POST', `/${ID}/cancel`))) {
      const out = await svc.cancel(m[1]);
      audit(req, 'migration.cancel', { id: m[1] });
      return send(res, 200, out);
    }
    throw new HttpError(404, 'not found');
  } catch (err) {
    if (err instanceof MigrateError) throw new HttpError(err.status, err.message, err.code);
    throw err;
  }
}
