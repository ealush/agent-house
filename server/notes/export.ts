// Saving a note as a file in a project (docs/spec/15-scratchpads.md, SCR-5): a snapshot
// written once, on request. The file isn't the note and isn't kept in step with it.
//
// Only inside the folders ah may browse (files.roots, server/files.ts), and only inside
// the project folder named: the relative path can't climb out of it, through `..` or
// through a symlink anywhere along the way, and never into `.git`. An existing file is
// replaced only when asked; otherwise the answer is 409 with a free name to offer. The
// text is written to a temporary file beside the target and moved into place, so a
// reader never sees half a file and a failure leaves the old one as it was.
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join, sep } from 'node:path';
import { safePath } from '../files.ts';
import { NoteError } from './store.ts';

export type ExportResult = { path: string; bytes: number; replaced: boolean };

/** "docs/proposals/x.md" as checked segments; refuses anything that could leave the folder. */
export function relativeSegments(raw: string): string[] {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 512) throw new NoteError(400, 'invalid_path', 'a file name or a path inside the project');
  if (raw.startsWith('/') || raw.startsWith('~')) throw new NoteError(400, 'invalid_path', 'a path inside the project, not an absolute one');
  if (/[\x00-\x1f\\]/.test(raw)) throw new NoteError(400, 'invalid_path', 'no control characters or backslashes in a path');
  const parts = raw.trim().split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..') throw new NoteError(400, 'invalid_path', 'no empty, "." or ".." parts in a path');
    if (p.length > 255) throw new NoteError(400, 'invalid_path', 'a name is at most 255 characters');
    if (p.toLowerCase() === '.git') throw new NoteError(400, 'invalid_path', 'not inside .git');
  }
  return parts;
}

const inside = (dir: string, p: string) => p === dir || p.startsWith(dir + sep);

/** "SPEC.md" → "SPEC (1).md", the first name not taken in `dir`. */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!(await lstat(join(dir, candidate)).catch(() => null))) return candidate;
  }
  throw new NoteError(409, 'file_exists', 'no free name');
}

/**
 * Writes `markdown` to `relative` inside `dir` (a project folder, absolute or ~). Folders
 * along the way are made. `replace`: an existing regular file may be replaced.
 */
export async function exportNote(dirInput: string, relative: string, markdown: string, replace: boolean): Promise<ExportResult> {
  const parts = relativeSegments(relative);
  const project = await safePath(dirInput);
  if (!(await stat(project)).isDirectory()) throw new NoteError(400, 'not_a_directory', 'the project is not a folder');
  let dir = project;
  for (const seg of parts.slice(0, -1)) {
    const next = join(dir, seg);
    const found = await lstat(next).catch(() => null);
    if (!found) await mkdir(next, { mode: 0o755 }).catch((err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    });
    else if (!found.isDirectory() && !found.isSymbolicLink()) throw new NoteError(409, 'not_a_directory', `${seg} is a file, not a folder`);
    // A symlinked folder is followed only while it stays inside the project.
    const real = await realpath(next);
    if (!inside(project, real)) throw new NoteError(403, 'outside_project', 'that path leads outside the project');
    if (!(await stat(real)).isDirectory()) throw new NoteError(409, 'not_a_directory', `${seg} is not a folder`);
    dir = real;
  }
  const name = parts[parts.length - 1];
  const target = join(dir, name);
  const existing = await lstat(target).catch(() => null);
  if (existing?.isSymbolicLink()) throw new NoteError(409, 'file_symlink', `${name} is a link; choose another name`);
  if (existing && !existing.isFile()) throw new NoteError(409, 'not_a_file', `${name} is not a file`);
  if (existing && !replace) {
    const err = new NoteError(409, 'file_exists', `${name} already exists`);
    (err as NoteError & { suggestion?: string }).suggestion = [...parts.slice(0, -1), await freeName(dir, name)].join('/');
    throw err;
  }
  const data = Buffer.from(markdown, 'utf8');
  const tmp = join(dir, `.${basename(name)}.ah-${randomBytes(4).toString('hex')}.tmp`);
  const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, existing ? existing.mode & 0o777 : 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    if (existing) await rename(tmp, target);
    else {
      // A link never replaces: a file made at that name meanwhile is still refused.
      await link(tmp, target).catch((err) => {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new NoteError(409, 'file_exists', `${name} already exists`);
        throw err;
      });
      await unlink(tmp).catch(() => {});
    }
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  return { path: target, bytes: data.length, replaced: !!existing };
}
