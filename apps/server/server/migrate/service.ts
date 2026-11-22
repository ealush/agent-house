// Moving a stopped session to another host (docs/spec/13-conductor.md, CND-3).
//
// The source drives; the destination checks, stages, restores and verifies. Each
// step is idempotent and its progress durable (the Migration table, on both
// ends), so a failure or a restart picks up where it stopped: a file already
// staged with the right hash isn't sent again, a restore that already happened is
// recognised byte for byte. The source's conversation is never touched: it stays
// resumable on the source, marked as moved, until you remove it yourself.
//
// Outgoing:  planned → transferring → committing → verifying → completed
// Incoming:  receiving → committed → verified
// Either:    failed (retry resumes) · cancelled (the destination's restore rolled back)
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { PrismaClient, Migration as Row } from '@prisma/client';
import type { Preset } from '../config.ts';
import type { SessionRecord } from '../registry.ts';
import type { Peer } from '../peers.ts';
import { peerFetch } from '../peers.ts';
import { REHOME, nativeFile, writeNative } from '../fork.ts';
import { hasCommit, headInfo, remoteUrl, toplevel } from '../git.ts';
import { resumeSelection } from '../launch.ts';
import { streamToFile, type UploadLimits } from '../uploads.ts';
import { conversationId } from '../portable/extract.ts';
import type { PortableConversation } from '../portable/schema.ts';
import type { PortableStore } from '../portable/store.ts';
import type { Resolved } from '../portable/service.ts';
import { MANIFEST_VERSION, ManifestError, validManifest, type Manifest, type ManifestFile, type Preflight, type Requirement } from './manifest.ts';
import { resolveDestination, type PathRule } from './paths.ts';
import { DomainError } from '../errors.ts';

export class MigrateError extends DomainError {
  declare readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(status, message, code);
  }
}

export type MigrateDeps = {
  host: () => string;
  home: () => string;
  stateDir: string;
  uploadsDir: string;
  limits: () => UploadLimits;
  peer: (name: string) => Peer | undefined;
  resolve: (ref: string) => Promise<Resolved | null>;
  record: (uid: string) => SessionRecord | undefined;
  restoreRecord: (r: SessionRecord) => boolean;
  removeRecord: (uid: string) => void;
  setMeta: (uid: string, key: string, value: unknown) => void;
  freshUid: () => string;
  presets: () => Preset[];
  available: (id: string) => boolean;
  exportDoc: (ref: string) => Promise<{ doc: PortableConversation; path: string }>;
  portable: PortableStore;
  envNames: () => Promise<string[]>;
  /** The harness's transcript for a conversation on this host, scanned fresh. */
  findTranscript: (harness: string, harnessId: string) => Promise<{ file: string } | null>;
  isLive: (uid: string) => boolean;
  rules: () => PathRule[];
  roots: () => string[];
  changed: () => void;
  /** A transcript restored here from another host: its history's usage was counted there. */
  copied?: (file: string) => void;
};

const now = () => Math.floor(Date.now() / 1000);
const MOVABLE = new Set(Object.keys(REHOME));

async function sha256File(path: string): Promise<{ sha256: string; bytes: number }> {
  const h = createHash('sha256');
  let bytes = 0;
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      bytes += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return { sha256: h.digest('hex'), bytes };
}

const parse = <T>(s: string, d: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return d;
  }
};

export type MigrationView = {
  id: string;
  role: 'outgoing' | 'incoming';
  state: string;
  peer: string;
  sourceUid: string | null;
  destUid: string | null;
  harness: string;
  title: string;
  sourceCwd: string;
  destCwd: string | null;
  preflight: Preflight | null;
  progress: Record<string, { bytes: number; sent: boolean }>;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

function view(r: Row): MigrationView {
  const pre = parse<Preflight | Record<string, never>>(r.preflightJson, {});
  return {
    id: r.id,
    role: r.role as 'outgoing' | 'incoming',
    state: r.state,
    peer: r.peer,
    sourceUid: r.sourceUid,
    destUid: r.destUid,
    harness: r.harness,
    title: r.title,
    sourceCwd: r.sourceCwd,
    destCwd: r.destCwd,
    preflight: 'ok' in pre ? (pre as Preflight) : null,
    progress: parse(r.progressJson, {}),
    error: r.error,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class MigrationService {
  private db: PrismaClient;
  private deps: MigrateDeps;
  /** Outgoing migrations being driven now (one driver each). */
  private running = new Map<string, Promise<void>>();

  constructor(db: PrismaClient, deps: MigrateDeps) {
    this.db = db;
    this.deps = deps;
  }

  private staging(id: string): string {
    return join(this.deps.stateDir, 'migrations', id);
  }

  private async update(id: string, data: Partial<Row>): Promise<Row> {
    return this.db.migration.update({ where: { id }, data: { ...data, updatedAt: now() } });
  }

  async get(id: string): Promise<MigrationView> {
    const r = await this.db.migration.findUnique({ where: { id } });
    if (!r) throw new MigrateError(404, 'not_found', 'no such migration');
    return view(r);
  }

  async list(): Promise<MigrationView[]> {
    return (await this.db.migration.findMany({ orderBy: { createdAt: 'desc' }, take: 50 })).map(view);
  }

  // ---------- source side

  private peerOr(name: string): Peer {
    if (name === this.deps.host()) throw new MigrateError(400, 'same_host', 'that session is already on this host');
    const peer = this.deps.peer(name);
    if (!peer) throw new MigrateError(502, 'destination_unreachable', `${name} isn't online as a host this one trusts (Settings → Hosts; \`ah peers trust\`)`);
    return peer;
  }

  /** What moves, and what it needs. Reads only. */
  private async manifest(ref: string, id: string): Promise<{ manifest: Manifest; paths: Map<string, string>; r: Resolved }> {
    const r = await this.deps.resolve(ref);
    if (!r) throw new MigrateError(404, 'not_found', 'session not found');
    if (r.harness === 'shell' || !r.harnessId) throw new MigrateError(422, 'no_conversation', 'only an agent session with a conversation can move');
    if (r.live) throw new MigrateError(409, 'source_running', 'end the session first: a running session stays where it is (only stopped sessions move)');
    if (!MOVABLE.has(r.harness)) throw new MigrateError(422, 'unsupported_harness', `${r.harness} conversations can't move between hosts yet (Claude Code, Codex and Muse can)`);
    if (!r.file) throw new MigrateError(422, 'no_transcript', 'the conversation has no transcript on this host');
    const paths = new Map<string, string>();
    const files: ManifestFile[] = [];
    const add = async (name: string, role: ManifestFile['role'], path: string, sourcePath?: string) => {
      const h = await sha256File(path);
      if (h.bytes > this.deps.limits().maxBytes) throw new MigrateError(413, 'too_large', `${name} is larger than the upload limit`);
      files.push({ name, role, ...h, ...(sourcePath ? { sourcePath } : {}) });
      paths.set(name, path);
    };
    await add('transcript', 'transcript', r.file);
    const { doc, path: docPath } = await this.deps.exportDoc(ref);
    await add('doc', 'doc', docPath);
    let n = 0;
    for (const a of doc.attachments) {
      if (a.kind !== 'file' || !a.path || !a.path.startsWith(this.deps.uploadsDir + '/')) continue;
      if (!(await stat(a.path).catch(() => null))?.isFile()) continue;
      await add(`att-${++n}`, 'attachment', a.path, a.path);
    }
    const { parents, children } = await this.deps.portable.edges(doc.id);
    const lineage = [];
    for (const l of [...parents, ...children]) {
      const parentDoc = typeof l.detail.parentDoc === 'string' && (await stat(l.detail.parentDoc).catch(() => null)) ? (l.detail.parentDoc as string) : null;
      if (parentDoc && !paths.has(`ldoc-${l.id}`)) await add(`ldoc-${l.id}`, 'lineage-doc', parentDoc);
      lineage.push({ id: l.id, kind: l.kind, strategy: l.strategy, parentId: l.parentId, childId: l.childId, parentUid: l.parentUid, childUid: l.childUid, fromHarness: l.fromHarness, toHarness: l.toHarness, fromHost: l.fromHost, toHost: l.toHost, checkpoint: l.checkpoint, limitations: l.limitations, parentDoc: parentDoc ? `ldoc-${l.id}` : null, createdAt: l.createdAt });
    }
    const rec = r.uid ? this.deps.record(r.uid) : undefined;
    const root = await toplevel(r.cwd).catch(() => null);
    const head = root ? await headInfo(root).catch(() => null) : null;
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      id,
      from: { host: this.deps.host(), home: this.deps.home(), uploadsDir: this.deps.uploadsDir },
      session: {
        uid: r.uid ?? '',
        harness: r.harness,
        harnessId: r.harnessId,
        conversationId: conversationId(r.harness, r.harnessId),
        title: r.title,
        cwd: r.cwd,
        model: r.model,
        launch: rec ? resumeSelection(rec.meta as Record<string, unknown>) : {},
        createdAt: rec?.createdAt ?? 0,
      },
      project: {
        root,
        rel: root ? relative(root, r.cwd) || '.' : '.',
        branch: head?.branch ?? null,
        head: head?.head || null,
        remote: root ? await remoteUrl(root) : null,
        dirty: head?.dirty ?? 0,
        worktree: !!rec?.meta['ah.worktree'],
      },
      transcriptName: basename(r.file),
      files,
      lineage,
      env: await this.deps.envNames().catch(() => []),
    };
    return { manifest, paths, r };
  }

  /** What moving `ref` to `to` would need: the destination's verdict, nothing moved. */
  async preview(ref: string, to: string, cwd: string | null): Promise<{ manifest: Omit<Manifest, 'files'> & { files: Array<Omit<ManifestFile, 'sourcePath'>> }; preflight: Preflight }> {
    const peer = this.peerOr(to);
    const { manifest } = await this.manifest(ref, `mg-${randomUUID().replace(/-/g, '').slice(0, 8)}`);
    const preflight = await this.call<Preflight>(peer, '/api/migrations/incoming/preflight', { manifest, cwd });
    return { manifest: { ...manifest, files: manifest.files.map(({ sourcePath: _s, ...f }) => f) }, preflight };
  }

  /** Starts moving `ref` to `to`. Refused before anything moves if the destination can't take it. */
  async start(ref: string, o: { to: string; cwd?: string | null; acceptWarnings?: boolean; idempotencyKey?: string }): Promise<{ migration: MigrationView; existed: boolean }> {
    if (o.idempotencyKey) {
      const prior = await this.db.migration.findUnique({ where: { idempotencyKey: o.idempotencyKey } });
      if (prior) return { migration: view(prior), existed: true };
    }
    const peer = this.peerOr(o.to);
    const id = `mg-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    const { manifest, r } = await this.manifest(ref, id);
    const preflight = await this.call<Preflight>(peer, '/api/migrations/incoming/preflight', { manifest, cwd: o.cwd ?? null });
    const blocking = preflight.requirements.filter((q) => q.blocking);
    if (!preflight.ok || blocking.length) throw new MigrateError(409, blocking[0]?.code ?? 'destination_refused', blocking.map((q) => q.message).join(' ') || `${o.to} can't take it`);
    const warnings = preflight.requirements.filter((q) => !q.blocking);
    if (warnings.length && !o.acceptWarnings) throw new MigrateError(409, 'needs_confirmation', `Confirm first: ${warnings.map((q) => q.message).join(' ')}`);
    try {
      await this.db.migration.create({
        data: { id, role: 'outgoing', state: 'planned', peer: o.to, sourceUid: r.uid, harness: r.harness, harnessId: r.harnessId!, title: r.title, sourceCwd: r.cwd, destCwd: preflight.destCwd, manifestJson: JSON.stringify(manifest), preflightJson: JSON.stringify(preflight), idempotencyKey: o.idempotencyKey ?? null, createdAt: now(), updatedAt: now() },
      });
    } catch (err) {
      if (o.idempotencyKey && (err as { code?: string }).code === 'P2002') {
        const prior = await this.db.migration.findUnique({ where: { idempotencyKey: o.idempotencyKey } });
        if (prior) return { migration: view(prior), existed: true };
      }
      throw err;
    }
    this.drive(id);
    return { migration: await this.get(id), existed: false };
  }

  /** Runs (or resumes) an outgoing migration in the background; one driver per migration. */
  private drive(id: string): Promise<void> {
    const prior = this.running.get(id);
    if (prior) return prior;
    const task = this.run(id)
      .catch(async (err) => {
        const message = err instanceof MigrateError ? err.message : `${(err as Error).message}`;
        console.warn(`migration ${id} failed:`, message);
        await this.update(id, { state: 'failed', error: message }).catch(() => {});
      })
      .finally(() => {
        this.running.delete(id);
        this.deps.changed();
      });
    this.running.set(id, task);
    return task;
  }

  /** Resolves once a migration's background driver (if any) is done. Tests. */
  settled(id: string): Promise<void> {
    return this.running.get(id) ?? Promise.resolve();
  }

  private async run(id: string): Promise<void> {
    let row = await this.db.migration.findUniqueOrThrow({ where: { id } });
    const manifest = JSON.parse(row.manifestJson) as Manifest;
    const peer = this.peerOr(row.peer);
    // The destination keeps its own record (idempotent by id).
    await this.call(peer, '/api/migrations/incoming', { manifest, cwd: row.destCwd });
    row = await this.update(id, { state: 'transferring', error: null });
    const progress = parse<Record<string, { bytes: number; sent: boolean }>>(row.progressJson, {});
    const source = new Map<string, string>();
    for (const f of manifest.files) {
      // Where it is here: the transcript and documents are found again (a restart may sit between).
      source.set(f.name, f.role === 'attachment' && f.sourcePath ? f.sourcePath : '');
    }
    const r = await this.deps.resolve(row.sourceUid ?? `${row.harness}:${row.harnessId}`);
    if (r?.file) source.set('transcript', r.file);
    const conv = await this.deps.portable.conversation(manifest.session.conversationId);
    if (conv?.docPath) source.set('doc', conv.docPath);
    for (const l of manifest.lineage) {
      if (!l.parentDoc) continue;
      const link = await this.deps.portable.link(l.id);
      if (typeof link?.detail.parentDoc === 'string') source.set(l.parentDoc, link.detail.parentDoc);
    }
    for (const f of manifest.files) {
      if (progress[f.name]?.sent) continue;
      const path = source.get(f.name);
      if (!path) throw new MigrateError(409, 'source_changed', `${f.name} is no longer on this host`);
      // The file must still be what the destination agreed to take.
      const h = await sha256File(path);
      if (f.role === 'transcript' && h.sha256 !== f.sha256) throw new MigrateError(409, 'source_changed', 'the conversation changed since the move was planned (was it resumed?); start the move again');
      if (h.sha256 !== f.sha256) throw new MigrateError(409, 'source_changed', `${f.name} changed since the move was planned`);
      const res = await peerFetch(peer, `/api/migrations/incoming/${id}/files/${f.name}`, { method: 'PUT', body: createReadStream(path), length: f.bytes, headers: { 'x-ah-sha256': f.sha256 }, timeoutMs: 30 * 60_000 });
      if (!res.ok) throw new MigrateError(502, 'transfer_failed', `sending ${f.name} failed: ${await errorOf(res)}`);
      progress[f.name] = { bytes: f.bytes, sent: true };
      await this.update(id, { progressJson: JSON.stringify(progress) });
    }
    await this.update(id, { state: 'committing' });
    const committed = await this.call<{ uid: string; cwd: string }>(peer, `/api/migrations/incoming/${id}/commit`, {});
    await this.update(id, { state: 'verifying', destUid: committed.uid, destCwd: committed.cwd });
    const verified = await this.call<{ resumable: boolean; uid: string }>(peer, `/api/migrations/incoming/${id}/verify`, {});
    if (!verified.resumable) throw new MigrateError(502, 'not_resumable', `${row.peer} restored the conversation but can't resume it`);
    // Cutover: the source stays as it was, marked as moved (and still resumable here).
    if (row.sourceUid && this.deps.record(row.sourceUid)) this.deps.setMeta(row.sourceUid, 'ah.movedTo', { host: row.peer, uid: verified.uid, id, at: now() });
    await this.deps.portable
      .createLink({ kind: 'migration', strategy: 'transfer', state: 'linked', parentId: manifest.session.conversationId, childId: manifest.session.conversationId, parentUid: row.sourceUid, childUid: verified.uid, fromHarness: row.harness, toHarness: row.harness, fromHost: this.deps.host(), toHost: row.peer, checkpoint: null, limitations: [], detail: { migration: id }, idempotencyKey: `migration:${id}` })
      .catch(() => {});
    await this.update(id, { state: 'completed', error: null });
  }

  async retry(id: string): Promise<MigrationView> {
    const row = await this.db.migration.findUnique({ where: { id } });
    if (!row || row.role !== 'outgoing') throw new MigrateError(404, 'not_found', 'no such outgoing migration');
    if (row.state === 'completed' || row.state === 'cancelled') throw new MigrateError(409, 'finished', `it is ${row.state}`);
    if (!this.running.has(id)) this.drive(id);
    return this.get(id);
  }

  /** Stops a migration and rolls the destination back (refused if it was resumed there). */
  async cancel(id: string): Promise<MigrationView> {
    const row = await this.db.migration.findUnique({ where: { id } });
    if (!row || row.role !== 'outgoing') throw new MigrateError(404, 'not_found', 'no such outgoing migration');
    if (row.state === 'cancelled') return view(row);
    await this.running.get(id)?.catch(() => {});
    const peer = this.peerOr(row.peer);
    const res = await peerFetch(peer, `/api/migrations/incoming/${id}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new MigrateError(res.status === 409 ? 409 : 502, 'rollback_refused', await errorOf(res));
    if (row.sourceUid && (this.deps.record(row.sourceUid)?.meta['ah.movedTo'] as { id?: string } | undefined)?.id === id) this.deps.setMeta(row.sourceUid, 'ah.movedTo', undefined);
    return view(await this.update(id, { state: 'cancelled' }));
  }

  /** At start: outgoing migrations a restart interrupted carry on (each step is idempotent). */
  async recover(): Promise<number> {
    const rows = await this.db.migration.findMany({ where: { role: 'outgoing', state: { in: ['planned', 'transferring', 'committing', 'verifying'] } } });
    for (const r of rows) this.drive(r.id);
    return rows.length;
  }

  private async call<T>(peer: Peer, path: string, json: unknown): Promise<T> {
    let res: Response;
    try {
      res = await peerFetch(peer, path, { json, timeoutMs: 60_000 });
    } catch (err) {
      throw new MigrateError(502, 'destination_unreachable', `${peer.name} didn't answer: ${(err as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new MigrateError(502, 'destination_refused', `${peer.name} refused this host (${res.status}): trust it with a token from ${peer.name} (\`ah auth token\` there, \`ah peers trust\` here)`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new MigrateError(res.status === 409 || res.status === 422 ? res.status : 502, body.code ?? 'destination_error', `${peer.name}: ${body.error ?? res.statusText}`);
    }
    return (await res.json()) as T;
  }

  // ---------- destination side

  /** Can this host take it, and where would it go? No side effects. */
  async preflight(input: unknown, cwd: string | null): Promise<Preflight> {
    const m = this.checked(input);
    const reqs: Requirement[] = [];
    const preset = this.deps.presets().find((p) => p.id === m.session.harness);
    if (!MOVABLE.has(m.session.harness)) reqs.push({ code: 'unsupported_harness', blocking: true, message: `this host can't take ${m.session.harness} conversations` });
    else if (!preset) reqs.push({ code: 'missing_harness', blocking: true, message: `${this.deps.host()} has no ${m.session.harness} agent set up: add it there first (Settings → Agents)` });
    else if (!this.deps.available(preset.id)) reqs.push({ code: 'missing_harness', blocking: true, message: `${preset.name} isn't installed on ${this.deps.host()}: install it there first` });
    const dest = await resolveDestination(m, cwd, { home: this.deps.home(), roots: this.deps.roots(), rules: this.deps.rules(), remoteOf: (d) => remoteUrl(d) });
    if (!dest.cwd) {
      reqs.push({ code: 'missing_project', blocking: true, message: cwd ? `${cwd} isn't a folder inside ${this.deps.host()}'s project folders` : `no checkout of ${m.project.remote ?? 'the project'} in ${this.deps.host()}'s project folders (and ${m.session.cwd} isn't there): clone it, or name the folder` });
    } else if (m.project.head || m.project.branch) {
      const root = await toplevel(dest.cwd).catch(() => null);
      if (!root) reqs.push({ code: 'not_a_repository', blocking: false, message: `${dest.cwd} isn't a git checkout here; the files won't match what the conversation saw` });
      else {
        if (m.project.head && !(await hasCommit(root, m.project.head))) reqs.push({ code: 'commit_missing', blocking: false, message: `commit ${m.project.head.slice(0, 7)} isn't in ${root} here: push it from ${m.from.host} and pull, or the agent will see older files` });
        const here = await headInfo(root).catch(() => null);
        // A different branch at the very commit the session left is the same files (an ah worktree
        // branch nothing was committed on): nothing to confirm.
        if (m.project.branch && here?.branch && here.branch !== m.project.branch && !(m.project.head && here.head === m.project.head)) reqs.push({ code: 'branch_differs', blocking: false, message: `${root} here is on ${here.branch}; the session worked on ${m.project.branch}` });
      }
    }
    if (m.project.dirty > 0) reqs.push({ code: 'uncommitted_changes', blocking: false, message: `${m.project.dirty} uncommitted change${m.project.dirty === 1 ? '' : 's'} on ${m.from.host} stay there: only the conversation moves, files move through git` });
    if (m.env.length) {
      const here = new Set(await this.deps.envNames().catch(() => []));
      const missing = m.env.filter((n) => !here.has(n));
      if (missing.length) reqs.push({ code: 'env_missing', blocking: false, message: `session variables set on ${m.from.host} but not here: ${missing.join(', ')} (Settings → Environment; values never travel)` });
    }
    // Already here: this very migration, restored before (a retry), or something else
    // under that id, which is never overwritten.
    const found = await this.deps.findTranscript(m.session.harness, m.session.harnessId);
    let existing: Preflight['existing'] = 'none';
    if (found) {
      const same = await this.db.migration.findUnique({ where: { id: m.id } });
      existing = same?.role === 'incoming' && (same.state === 'committed' || same.state === 'verified') ? 'identical' : 'conflict';
      if (existing === 'conflict') reqs.push({ code: 'conflict', blocking: true, message: `${this.deps.host()} already has this conversation (${found.file}); nothing is overwritten. Remove that copy first to move this one over it.` });
    }
    return { ok: !reqs.some((r) => r.blocking), destCwd: dest.cwd, resolvedBy: dest.by, requirements: reqs, existing, host: this.deps.host() };
  }

  private checked(input: unknown): Manifest {
    try {
      return validManifest(input, this.deps.limits().maxBytes);
    } catch (err) {
      if (err instanceof ManifestError) throw new MigrateError(400, 'invalid_manifest', err.message);
      throw err;
    }
  }

  /** The source opens (or re-opens) its migration here. */
  async receive(input: unknown, cwd: string | null, from: string): Promise<MigrationView> {
    const m = this.checked(input);
    const prior = await this.db.migration.findUnique({ where: { id: m.id } });
    if (prior) {
      if (prior.role !== 'incoming') throw new MigrateError(409, 'id_in_use', 'that migration id is in use here');
      return view(prior);
    }
    const pre = await this.preflight(m, cwd);
    if (!pre.ok) throw new MigrateError(409, pre.requirements.find((r) => r.blocking)?.code ?? 'refused', pre.requirements.filter((r) => r.blocking).map((r) => r.message).join(' '));
    await mkdir(this.staging(m.id), { recursive: true, mode: 0o700 });
    const row = await this.db.migration.create({
      data: { id: m.id, role: 'incoming', state: 'receiving', peer: m.from.host, sourceUid: m.session.uid || null, harness: m.session.harness, harnessId: m.session.harnessId, title: m.session.title, sourceCwd: m.session.cwd, destCwd: pre.destCwd, manifestJson: JSON.stringify(m), preflightJson: JSON.stringify({ ...pre, from }), createdAt: now(), updatedAt: now() },
    });
    return view(row);
  }

  private async incoming(id: string): Promise<{ row: Row; manifest: Manifest }> {
    if (!/^mg-[0-9a-f]{8}$/.test(id)) throw new MigrateError(400, 'invalid_id', 'invalid migration id');
    const row = await this.db.migration.findUnique({ where: { id } });
    if (!row || row.role !== 'incoming') throw new MigrateError(404, 'not_found', 'no such incoming migration');
    return { row, manifest: JSON.parse(row.manifestJson) as Manifest };
  }

  /** One file, streamed into staging and checked against the manifest's hash. */
  async stage(id: string, name: string, body: import('node:stream').Readable, declaredSha: string | undefined): Promise<{ bytes: number; sha256: string }> {
    const { row, manifest } = await this.incoming(id);
    if (row.state !== 'receiving') throw new MigrateError(409, 'not_receiving', `it is ${row.state}`);
    const f = manifest.files.find((x) => x.name === name);
    if (!f) throw new MigrateError(400, 'unknown_file', `${name} isn't in the manifest`);
    if (declaredSha && declaredSha !== f.sha256) throw new MigrateError(400, 'hash_mismatch', `${name}: the hash sent doesn't match the manifest`);
    const target = join(this.staging(id), name);
    const have = await stat(target).catch(() => null);
    if (have && (await sha256File(target)).sha256 === f.sha256) {
      body.resume();
      return { bytes: have.size, sha256: f.sha256 };
    }
    await rm(target, { force: true });
    const limits = { ...this.deps.limits(), maxBytes: f.bytes };
    await streamToFile(body, target, limits, { declared: f.bytes });
    const got = await sha256File(target);
    if (got.sha256 !== f.sha256) {
      await rm(target, { force: true });
      throw new MigrateError(400, 'hash_mismatch', `${name} arrived damaged (sha256 differs); send it again`);
    }
    return got;
  }

  /** Restores the conversation into this host's own stores. Idempotent. */
  async commit(id: string): Promise<{ uid: string; cwd: string; file: string }> {
    const { row, manifest: m } = await this.incoming(id);
    if (row.state === 'committed' || row.state === 'verified') {
      const done = parse<{ uid?: string; file?: string }>(row.progressJson, {});
      return { uid: row.destUid!, cwd: row.destCwd!, file: done.file ?? '' };
    }
    if (row.state !== 'receiving') throw new MigrateError(409, 'not_receiving', `it is ${row.state}`);
    for (const f of m.files) {
      const p = join(this.staging(id), f.name);
      if ((await sha256File(p).catch(() => null))?.sha256 !== f.sha256) throw new MigrateError(409, 'incomplete', `${f.name} hasn't arrived whole yet`);
    }
    const cwd = row.destCwd!;
    // Attachments the conversation names by their source path land in this host's uploads.
    const moved: string[] = [];
    let text = await readFile(join(this.staging(id), 'transcript'), 'utf8');
    for (const f of m.files.filter((x) => x.role === 'attachment' && x.sourcePath)) {
      await mkdir(this.deps.uploadsDir, { recursive: true, mode: 0o700 });
      let dest = join(this.deps.uploadsDir, basename(f.sourcePath!));
      const there = await stat(dest).catch(() => null);
      if (there && (await sha256File(dest)).sha256 !== f.sha256) dest = join(this.deps.uploadsDir, `${id}-${basename(f.sourcePath!)}`);
      if (!(await stat(dest).catch(() => null))) {
        await copyFile(join(this.staging(id), f.name), dest);
        moved.push(dest);
      }
      text = text.split(f.sourcePath!).join(dest);
    }
    text = REHOME[m.session.harness](text, m.session.harnessId, cwd);
    const file = nativeFile(m.session.harness, m.session.harnessId, cwd, m.transcriptName);
    const exists = await stat(file).catch(() => null);
    if (exists) {
      if ((await readFile(file, 'utf8')) !== text) throw new MigrateError(409, 'conflict', 'this host already has a different conversation under that id; nothing was overwritten');
    } else {
      try {
        await writeNative(file, text);
      } catch (err) {
        for (const p of moved) await rm(p, { force: true });
        throw err;
      }
      this.deps.copied?.(file);
    }
    // Its portable record and its lineage, with documents at this host's paths.
    const docs = new Map<string, string>();
    for (const f of m.files.filter((x) => x.role === 'doc' || x.role === 'lineage-doc')) {
      const doc = JSON.parse(await readFile(join(this.staging(id), f.name), 'utf8')) as PortableConversation;
      if (doc?.format !== 'ah.portable-conversation') continue;
      const path = await this.deps.portable.writeDoc(doc);
      docs.set(f.name, path);
      if (f.role === 'doc') await this.deps.portable.upsertConversation({ ...doc, source: { ...doc.source, host: this.deps.host(), file } }, path);
    }
    for (const l of m.lineage) {
      if (await this.deps.portable.link(l.id)) continue;
      await this.deps.portable.importLink({ ...l, detail: { ...(l.parentDoc && docs.has(l.parentDoc) ? { parentDoc: docs.get(l.parentDoc) } : {}), importedFrom: m.from.host } }).catch(() => {});
    }
    const uid = this.deps.freshUid();
    this.deps.restoreRecord({
      id: uid,
      host: this.deps.host(),
      harness: m.session.harness,
      harnessId: m.session.harnessId,
      cwd,
      model: m.session.model ?? undefined,
      title: m.session.title,
      status: 'ended',
      lifecycle: 'ended',
      createdAt: m.session.createdAt || now(),
      lastActivityAt: now(),
      endedAt: now(),
      exitCode: null,
      meta: {
        ...(m.session.launch.mode ? { 'ah.launch.mode': m.session.launch.mode } : {}),
        ...(m.session.launch.model ? { 'ah.launch.model': m.session.launch.model } : {}),
        ...(m.session.launch.effort ? { 'ah.launch.effort': m.session.launch.effort } : {}),
        'ah.continued': { linkId: id, fromUid: m.session.uid || null, fromHarness: m.session.harness, fromTitle: m.session.title, fromHost: m.from.host, kind: 'migration', strategy: 'transfer', at: now() },
        'ah.migration': { id, from: m.from.host },
      },
    });
    const committedSize = (await stat(file)).size;
    await this.update(id, { state: 'committed', destUid: uid, progressJson: JSON.stringify({ file, size: committedSize, moved }) });
    this.deps.changed();
    return { uid, cwd, file };
  }

  /** Can this host resume it? Its own discovery must find the transcript where the restore put it. */
  async verify(id: string): Promise<{ resumable: boolean; uid: string }> {
    const { row } = await this.incoming(id);
    if (row.state !== 'committed' && row.state !== 'verified') throw new MigrateError(409, 'not_committed', `it is ${row.state}`);
    const done = parse<{ file?: string }>(row.progressJson, {});
    const found = await this.deps.findTranscript(row.harness, row.harnessId);
    const resumable = !!found && found.file === done.file && !!this.deps.record(row.destUid!);
    if (resumable) {
      await this.update(id, { state: 'verified' });
      await rm(this.staging(id), { recursive: true, force: true });
    }
    return { resumable, uid: row.destUid! };
  }

  /** Undoes a restore that hasn't been used here: refused once the conversation went on here. */
  async rollback(id: string): Promise<{ rolledBack: boolean }> {
    const { row } = await this.incoming(id);
    if (row.state === 'cancelled') return { rolledBack: true };
    const done = parse<{ file?: string; size?: number; moved?: string[] }>(row.progressJson, {});
    if (row.destUid && this.deps.isLive(row.destUid)) throw new MigrateError(409, 'in_use', `it is running on ${this.deps.host()}; end it there first`);
    if (done.file) {
      const s = await stat(done.file).catch(() => null);
      if (s && s.size !== done.size) throw new MigrateError(409, 'diverged', `it has been resumed on ${this.deps.host()} since; remove it there yourself if you mean to`);
      await rm(done.file, { force: true });
    }
    for (const p of done.moved ?? []) await rm(p, { force: true });
    if (row.destUid) this.deps.removeRecord(row.destUid);
    await rm(this.staging(id), { recursive: true, force: true });
    await this.update(id, { state: 'cancelled' });
    this.deps.changed();
    return { rolledBack: true };
  }

  /** Staging a crash left behind (incoming that never finished), after a day. */
  async sweep(): Promise<void> {
    const stale = await this.db.migration.findMany({ where: { role: 'incoming', state: 'receiving', updatedAt: { lt: now() - 86_400 } } });
    for (const r of stale) {
      await rm(this.staging(r.id), { recursive: true, force: true });
      await this.update(r.id, { state: 'failed', error: 'the source never finished sending' });
    }
  }
}

async function errorOf(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text).error ?? text;
  } catch {
    return text || res.statusText;
  }
}
