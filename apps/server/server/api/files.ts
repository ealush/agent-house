// Files over HTTP, confined to config.files.roots (files.ts): browsing, downloads, the
// explorer's uploads, composer attachments streamed into the uploads folder, and the @
// completion for a box with no session behind it (a note, docs/spec/15-scratchpads.md SCR-7).
import { stat } from 'node:fs/promises';
import { projectFiles } from '../complete.ts';
import { FsError, list, makeDir, receive, roots, safePath, sendFile } from '../files.ts';
import { readJson, send, str } from '../http.ts';
import { shortPath } from '../sessions.ts';
import { admit, declaredLength, streamToFile } from '../uploads.ts';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { route, type Audit, type Route } from './router.ts';

export type FilesRouteDeps = {
  audit: Audit;
  config: Config;
  /** Where attachments land (~/.cache/ah/uploads). */
  uploadDir: string;
};

export function filesRoutes({ audit, config, uploadDir }: FilesRouteDeps): Route[] {
  return [
    route('GET', /^\/api\/fs\/list$/, async ({ res, url }) => {
      return send(res, 200, { ...(await list(url.searchParams.get('path') || roots()[0], url.searchParams.get('hidden') === '1')), roots: roots().map(shortPath) });
    }),
    // The files under a folder inside the roots that match what follows an @, as a session's
    // own completion lists them (GET /api/sessions/:uid/files): relative to that folder.
    route('GET', /^\/api\/fs\/complete$/, async ({ res, url }) => {
      const dir = await safePath(url.searchParams.get('dir') ?? '');
      if (!(await stat(dir)).isDirectory()) throw new FsError(400, 'not a directory');
      return send(res, 200, await projectFiles(dir, (url.searchParams.get('q') ?? '').slice(0, 200)));
    }),
    route('GET', /^\/api\/fs\/file$/, ({ res, url }) => sendFile(res, url.searchParams.get('path') ?? '', url.searchParams.get('download') === '1')),
    route('POST', /^\/api\/fs\/upload$/, async ({ req, res, url }) => {
      const path = await receive(req, url.searchParams.get('dir') ?? '', url.searchParams.get('name') ?? '', config.uploads);
      audit(req, 'file.upload', { path });
      return send(res, 201, { path });
    }),
    route('POST', /^\/api\/fs\/mkdir$/, async ({ req, res }) => {
      const path = await makeDir(str((await readJson(req)).path, 'path', 1024));
      audit(req, 'file.mkdir', { path });
      return send(res, 201, { path });
    }),
    route('POST', /^\/api\/upload$/, async ({ req, res, url }) => {
      // Pasted/dropped files land in ah's own upload folder, readable only by you,
      // streamed to disk (a screen recording runs to hundreds of megabytes).
      const name = (url.searchParams.get('name') ?? 'upload').replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(-80) || 'upload';
      await mkdir(uploadDir, { recursive: true, mode: 0o700 });
      const declared = declaredLength(req);
      await admit(uploadDir, declared, config.uploads, uploadDir);
      const file = join(uploadDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
      const out = await streamToFile(req, (n) => (n ? file.replace(/(\.[^./]*)?$/, `-${n}$1`) : file), config.uploads, { declared, quotaDir: uploadDir });
      audit(req, 'file.upload', { path: out.path, bytes: out.bytes });
      return send(res, 201, { path: out.path, bytes: out.bytes });
    }),
  ];
}
