// Files over HTTP, confined to config.files.roots (files.ts): browsing, downloads, the
// explorer's uploads, and composer attachments streamed into the uploads folder.
import { list, makeDir, receive, roots, sendFile } from '../files.ts';
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
    route('GET', /^\/api\/fs\/file$/, ({ res, url }) => sendFile(res, url.searchParams.get('path') ?? '', url.searchParams.get('download') === '1')),
    route('POST', /^\/api\/fs\/upload$/, async ({ req, res, url }) => {
      const path = await receive(req, url.searchParams.get('dir') ?? '', url.searchParams.get('name') ?? '', config.uploads);
      audit(req, 'file.upload', { path });
      return send(res, 201, { path });
    }),
    route('POST', /^\/api\/fs\/mkdir$/, async ({ req, res }) => send(res, 201, { path: await makeDir(str((await readJson(req)).path, 'path', 1024)) })),
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
