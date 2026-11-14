// What a migration moves (docs/spec/13-conductor.md, CND-3): the manifest the source
// builds and the destination checks before anything moves. It names files by role,
// never by a path the destination would write to, and carries no secrets: the
// session's environment travels as variable names only, and credential stores,
// keys and provider tokens are never part of it.

export const MANIFEST_VERSION = 1;

export type ManifestFile = {
  /** transcript | doc | att-<n> | ldoc-<linkId>: the destination decides where each goes. */
  name: string;
  role: 'transcript' | 'doc' | 'attachment' | 'lineage-doc';
  bytes: number;
  sha256: string;
  /** For an attachment: the path the conversation names it by on the source (rewritten on arrival). */
  sourcePath?: string;
};

/** A lineage edge that touches the conversation, so its history survives the move. */
export type ManifestLink = {
  id: string;
  kind: string;
  strategy: string;
  parentId: string;
  childId: string | null;
  parentUid: string | null;
  childUid: string | null;
  fromHarness: string;
  toHarness: string;
  fromHost: string;
  toHost: string;
  checkpoint: { line: number; bytes: number; sha256: string } | null;
  limitations: unknown[];
  /** The parent document that edge read, when it's in `files` (ldoc-<id>). */
  parentDoc: string | null;
  createdAt: number;
};

export type Manifest = {
  version: typeof MANIFEST_VERSION;
  id: string;
  from: { host: string; home: string; uploadsDir: string };
  session: {
    uid: string;
    harness: string;
    harnessId: string;
    conversationId: string;
    title: string;
    cwd: string;
    model: string | null;
    launch: { mode?: string; model?: string; effort?: string };
    createdAt: number;
  };
  project: { root: string | null; rel: string; branch: string | null; head: string | null; remote: string | null; dirty: number; worktree: boolean };
  /** The source transcript's file name (Codex names rollouts by time). */
  transcriptName: string;
  files: ManifestFile[];
  lineage: ManifestLink[];
  /** Session environment variable names on the source (Settings → Environment); values never travel. */
  env: string[];
};

export type Requirement = { code: string; message: string; blocking: boolean };

export type Preflight = {
  ok: boolean;
  destCwd: string | null;
  /** How the destination folder was found. */
  resolvedBy: 'explicit' | 'path_map' | 'same_path' | 'home_relative' | 'git_remote' | null;
  requirements: Requirement[];
  /** `identical`: already here, byte for byte (a retry); `conflict`: something else holds the id. */
  existing: 'none' | 'identical' | 'conflict';
  host: string;
};

const HEX64 = /^[0-9a-f]{64}$/;
const FILE_NAME = /^(transcript|doc|att-\d{1,3}|ldoc-lk-[0-9a-f]{8})$/;
const ID = /^mg-[0-9a-f]{8}$/;
const HARNESS_ID = /^[\w.-]{1,80}$/;

export class ManifestError extends Error {}

/** Checks a manifest from another host before any of it is used. Throws ManifestError. */
export function validManifest(m: unknown, maxBytes: number): Manifest {
  const fail = (why: string): never => {
    throw new ManifestError(`invalid manifest: ${why}`);
  };
  const v = m as Manifest;
  if (!v || typeof v !== 'object') fail('not an object');
  if (v.version !== MANIFEST_VERSION) fail(`version ${String(v.version)} (this host reads ${MANIFEST_VERSION})`);
  if (!ID.test(String(v.id))) fail('id');
  if (typeof v.from?.host !== 'string' || !/^[\w.-]{1,64}$/.test(v.from.host)) fail('from.host');
  const s = v.session;
  if (!s || typeof s.harness !== 'string' || !/^[\w-]{1,48}$/.test(s.harness)) fail('session.harness');
  if (!HARNESS_ID.test(String(s.harnessId))) fail('session.harnessId');
  if (typeof s.cwd !== 'string' || !s.cwd.startsWith('/') || s.cwd.length > 1024) fail('session.cwd');
  if (typeof s.title !== 'string' || s.title.length > 200) fail('session.title');
  if (!Array.isArray(v.files) || v.files.length > 200) fail('files');
  const names = new Set<string>();
  for (const f of v.files) {
    if (!FILE_NAME.test(String(f?.name)) || names.has(f.name)) fail(`file name ${String(f?.name)}`);
    names.add(f.name);
    if (!HEX64.test(String(f.sha256))) fail(`${f.name} sha256`);
    if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > maxBytes) fail(`${f.name} size`);
  }
  if (!v.files.some((f) => f.name === 'transcript')) fail('no transcript');
  if (!Array.isArray(v.lineage) || v.lineage.length > 500) fail('lineage');
  for (const l of v.lineage) if (!/^lk-[0-9a-f]{8}$/.test(String(l?.id))) fail('lineage id');
  if (!Array.isArray(v.env) || v.env.some((n) => typeof n !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(n))) fail('env');
  if (typeof v.transcriptName !== 'string' || /[/\\]/.test(v.transcriptName) || v.transcriptName.length > 200) fail('transcriptName');
  return v;
}
