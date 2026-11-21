// HTTP for scratchpads, under /api/notes (docs/spec/15-scratchpads.md). Behind the same
// sign-in as every route. Thin: the rules are in store.ts, export.ts and handoff.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Caller } from '../auth.ts';
import { HttpError, readBody, send, str } from '../http.ts';
import { exportNote } from './export.ts';
import type { Handoffs } from './handoff.ts';
import { MAX_MARKDOWN, NoteError, noteId, projectOf, revisionOf, writeId, type NotesStore } from './store.ts';

type Audit = (req: IncomingMessage, event: string, detail?: Record<string, unknown>) => void;

const NOTE = '([0-9a-fA-F-]{36})';
/** A note's text is up to a million characters; JSON-escaped, it can be a few times that. */
const NOTE_BODY = 8 * 1024 * 1024;
/** A hand-off's text is up to 32 768 characters of any script (three UTF-8 bytes each, more escaped). */
const HANDOFF_BODY = 512 * 1024;

function who(caller: Caller | null): string {
  if (caller?.kind === 'token') return `token:${caller.token.name}`;
  if (caller?.kind === 'session') return `device:${caller.session.label || caller.session.id}`;
  return 'local';
}

/** Text whose length the store or the hand-off checks (with its own code, not a bare 400). */
function text(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new HttpError(400, `invalid ${field}`);
  return v;
}

async function bigJson(req: IncomingMessage, limit = NOTE_BODY): Promise<Record<string, unknown>> {
  const body = await readBody(req, limit);
  try {
    const v = JSON.parse(body.toString() || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export async function notesApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  path: string,
  caller: Caller | null,
  o: { store: NotesStore; handoffs: Handoffs; host: () => string; audit: Audit },
): Promise<void> {
  const method = req.method ?? 'GET';
  const route = (verb: string, re: string) => (method === verb ? path.match(new RegExp(`^/api/notes${re}$`)) : null);
  let m: RegExpMatchArray | null;
  try {
    if (route('GET', '')) {
      const since = url.searchParams.get('since');
      const limit = Number(url.searchParams.get('limit') ?? 200);
      return send(res, 200, { ...(await o.store.list(since === null ? 0 : revisionOf(since), Number.isFinite(limit) ? limit : 200)), state: o.store.state() });
    }

    // A snapshot of a note (from this host or only on the device) written into a project.
    if (route('POST', '/export')) {
      const body = await bigJson(req);
      const markdown = text(body.markdown, 'markdown');
      if (markdown.length > MAX_MARKDOWN) throw new NoteError(413, 'note_too_long', `a note holds at most ${MAX_MARKDOWN} characters`);
      const dir = str(body.dir, 'dir', 1024);
      const out = await exportNote(dir, str(body.path, 'path', 512), markdown, body.replace === true);
      const revision = body.revision === undefined ? 0 : revisionOf(body.revision);
      if (typeof body.noteId === 'string') await o.store.recordExport(body.noteId, { host: o.host(), path: out.path, revision, at: Math.floor(Date.now() / 1000) }).catch(() => {});
      o.audit(req, 'note.export', { path: out.path, bytes: out.bytes, replaced: out.replaced });
      return send(res, out.replaced ? 200 : 201, out);
    }

    if (route('POST', '/handoffs')) {
      const body = await bigJson(req, HANDOFF_BODY);
      const out = await o.handoffs.hand({
        id: str(body.id, 'id', 40),
        noteId: str(body.noteId, 'noteId', 36),
        revision: revisionOf(body.revision),
        target: str(body.target, 'target', 80),
        text: text(body.text, 'text'),
        resend: body.resend === true,
      });
      if (!out.replay) o.audit(req, 'note.handoff', { note: out.noteId, target: out.target, outcome: out.outcome });
      return send(res, 200, out);
    }
    if ((m = route('GET', '/handoffs/([\\w-]{8,40})'))) return send(res, 200, await o.handoffs.get(m[1]));

    if ((m = route('GET', `/${NOTE}`))) return send(res, 200, await o.store.get(m[1]));
    if ((m = route('PUT', `/${NOTE}`))) {
      const body = await bigJson(req);
      const out = await o.store.put(m[1], {
        baseRevision: revisionOf(body.baseRevision),
        writeId: writeId(body.writeId),
        title: body.title === undefined ? '' : text(body.title, 'title'),
        markdown: body.markdown === undefined ? '' : text(body.markdown, 'markdown'),
        project: body.project === undefined ? null : projectOf(body.project),
        writer: who(caller),
        createdAt: typeof body.createdAt === 'number' ? body.createdAt : undefined,
      });
      if (out.created) o.audit(req, 'note.create', { id: out.note.id });
      return send(res, out.created ? 201 : 200, out.note);
    }
    if ((m = route('DELETE', `/${NOTE}`))) {
      const gone = await o.store.remove(m[1], revisionOf(url.searchParams.get('baseRevision') ?? ''), writeId(url.searchParams.get('writeId') ?? ''), who(caller));
      o.audit(req, 'note.delete', { id: noteId(m[1]) });
      return send(res, 200, gone);
    }
    throw new HttpError(404, 'not found');
  } catch (err) {
    // Refusals carry the note as the host has it, so the device can keep both versions.
    if (err instanceof NoteError) {
      const suggestion = (err as NoteError & { suggestion?: string }).suggestion;
      return send(res, err.status, { error: err.message, code: err.code, ...(err.note ? { note: err.note } : {}), ...(suggestion ? { suggestion } : {}) });
    }
    throw err;
  }
}
