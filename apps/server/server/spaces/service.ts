// Spaces' use cases (docs/spec/17-spaces.md): the list, a new plain Space, its preferences
// and memory, removing and restoring. The rules are model.ts's; the folders are reached
// through the SpaceFs port (files.ts), the sessions through the deps the composition
// root connects.
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  CONTEXT_FILE,
  MAX_MEMORY,
  MAX_MEMORY_FILES,
  MEMORY_INDEX,
  PREFERENCES_FILE,
  SpaceError,
  archiveName,
  firstHeadingOrLine,
  formatPromotedKnowledge,
  listSpaces,
  memoryFile,
  memoryText,
  preferencesText,
  removedView,
  renderSpaceContextMarkdown,
  renderSpacePointer,
  shown,
  slugMemoryFile,
  spaceName,
  startingFiles,
  startingMemory,
  startingPreferences,
  stillRemoved,
  upsertMemoryIndex,
  type Placed,
  type Removed,
  type RemovedView,
  type SpaceArtifact,
  type SpaceCatalogEntry,
  type SpaceContextNote,
  type SpaceContextView,
  type SpaceKind,
  type SpaceView,
  type SpacesState,
} from './model.ts';

/** The filesystem, as Spaces needs it. Paths are absolute. */
export type SpaceFs = {
  isDir: (path: string) => Promise<boolean>;
  exists: (path: string) => boolean;
  /** Folders directly in `path`, not hidden ones, with their modification time (seconds). */
  folders: (path: string) => Promise<Array<{ name: string; at: number }>>;
  /** Makes `path` (its parents as needed); refuses one that's already there. */
  makeDir: (path: string) => Promise<'made' | 'exists'>;
  read: (path: string, limit: number) => Promise<{ text: string; bytes: number; at: number } | null>;
  write: (path: string, text: string) => Promise<number>;
  remove: (path: string) => Promise<boolean>;
  /** `.md` files directly in `path`. */
  markdown: (path: string) => Promise<string[]>;
  /** Non-hidden files directly in `path` (used to inventory `artifacts/`). */
  listFiles?: (path: string) => Promise<Array<{ name: string; bytes: number; at: number }>>;
  move: (from: string, to: string) => Promise<void>;
  loadJson: (path: string) => Promise<unknown>;
  saveJson: (path: string, value: unknown) => Promise<void>;
};

export type SpacesDeps = {
  /** The Spaces folder, absolute. */
  root: string;
  /** Where removals are kept (spaces.json). */
  stateFile: string;
  fs: SpaceFs;
  /** What's live and in History now, as the state shows it (removed Spaces already hidden). */
  current: () => Promise<{ live: Placed[]; history: Placed[] }>;
  /** A repository's root, else a folder: for a Space outside the Spaces folder. */
  isRepo: (path: string) => boolean;
  shortPath: (path: string) => string;
  expandHome: (path: string) => string;
  /** Something changed that the state shows: run a pass now and wait for it. */
  refresh: () => Promise<void>;
  /** Every conversation History has in a Space (the state shows only the newest). */
  refsIn: (name: string) => Promise<string[]>;
  /** Optional provider of Space-scoped notes for context snapshots. */
  notesIn?: (spacePath: string | null, spaceName?: string, roots?: string[]) => Promise<SpaceContextNote[]> | SpaceContextNote[];
  now?: () => number;
};

export type MemoryFile = { name: string; text: string; bytes: number; updatedAt: number; truncated?: boolean };

const ARCHIVE = '.archive';

export class SpacesService {
  private removed: Removed[] = [];
  private catalog = new Map<string, SpaceCatalogEntry>();
  private revision = 0;
  private saving: Promise<void> = Promise.resolve();

  private d: SpacesDeps;

  constructor(d: SpacesDeps) {
    this.d = d;
  }

  private now(): number {
    return this.d.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /** Where Space-owned context for Repo/Folder Spaces lives (outside any git repository). */
  private stateSpacesDir(): string {
    return join(dirname(this.d.stateFile), 'spaces');
  }

  async load(): Promise<void> {
    const v = (await this.d.fs.loadJson(this.d.stateFile).catch(() => null)) as { removed?: Removed[]; catalog?: SpaceCatalogEntry[] } | null;
    this.removed = Array.isArray(v?.removed)
      ? v.removed.filter((r) => typeof r?.name === 'string' && typeof r.removedAt === 'number').map((r) => ({ ...r, refs: Array.isArray(r.refs) ? r.refs.filter((x) => typeof x === 'string') : [] }))
      : [];
    this.catalog.clear();
    if (Array.isArray(v?.catalog)) {
      for (const c of v.catalog) {
        if (typeof c?.id === 'string' && typeof c?.name === 'string' && c.name) {
          this.catalog.set(c.name, { ...c, roots: Array.isArray(c.roots) ? c.roots.filter((x) => typeof x === 'string') : [] });
        }
      }
    }
  }

  state(): SpacesState {
    return { revision: this.revision };
  }

  private changed(): void {
    this.revision++;
    const removed = this.removed;
    const catalog = [...this.catalog.values()];
    this.saving = this.saving.then(() => this.d.fs.saveJson(this.d.stateFile, { removed, catalog })).catch((err) => console.error('spaces: saving spaces.json failed:', err));
  }

  /** Ensures a Space has a stable server-side id (`sp-xxxxxxxx`), persisting it lazily. */
  private ensureCatalog(name: string, kind: SpaceKind, path: string | null, roots: string[] = []): SpaceCatalogEntry {
    const existing = this.catalog.get(name);
    if (existing) {
      let dirty = false;
      if (path && !existing.path) {
        existing.path = path;
        dirty = true;
      }
      if (roots.length) {
        const merged = [...new Set([...(existing.roots ?? []), ...roots])];
        if (merged.length !== (existing.roots ?? []).length) {
          existing.roots = merged;
          dirty = true;
        }
      }
      if (dirty) this.changed();
      return existing;
    }
    const entry: SpaceCatalogEntry = {
      id: `sp-${randomUUID().replace(/-/g, '').slice(0, 8)}`,
      name,
      kind,
      path,
      roots: [...new Set([path, ...roots].filter((x): x is string => !!x))],
      createdAt: this.now(),
    };
    this.catalog.set(name, entry);
    this.changed();
    return entry;
  }

  /**
   * For each state pass (Core): which of History's conversations to show (SPC-5). A
   * removed Space with a session running in it, or a conversation newer than its removal,
   * is used again: it comes back, conversations and all, from this pass on.
   */
  historyFilter(live: Array<{ project: string; createdAt: number }>): (h: { project: string; ref: string }) => boolean {
    if (!this.removed.length) return () => true;
    const kept = stillRemoved(this.removed, live, []);
    if (kept.length !== this.removed.length) {
      this.removed = kept;
      this.changed();
    }
    return (h) => {
      if (shown(this.removed, h)) {
        // Not one it hid: if the Space was removed, this is new there, and brings it back.
        const r = this.removed.find((x) => x.name === h.project);
        if (r) {
          this.removed = this.removed.filter((x) => x !== r);
          this.changed();
        }
        return true;
      }
      return false;
    };
  }

  /** Folders New session shouldn't offer: removed Spaces' (SPC-5). Short paths. */
  hiddenPaths(): Set<string> {
    return new Set(this.removed.map((r) => r.path).filter((p): p is string => !!p));
  }

  rootShort(): string {
    return this.d.shortPath(this.d.root);
  }

  private kindOf = (path: string | null): SpaceKind => {
    if (!path) return 'folder';
    const abs = this.d.expandHome(path);
    // A git repo cloned inside `~/spaces/` stays a `repo` so Space-owned context lives under
    // `~/.local/state/ah/spaces/<id>/` and never pollutes the repository working tree.
    if (this.d.isRepo(abs)) return 'repo';
    if (abs.startsWith(this.d.root + '/') && !abs.slice(this.d.root.length + 1).includes('/')) return 'space';
    return 'folder';
  };

  async list(): Promise<{ root: string; spaces: SpaceView[]; removed: RemovedView[] }> {
    const [now, plain] = await Promise.all([this.d.current(), this.d.fs.folders(this.d.root).catch(() => [])]);
    // Track all distinct folder/repo roots used by sessions in each Space (supports multi-repo Spaces).
    const rootsBySpace = new Map<string, Set<string>>();
    for (const item of [...now.live, ...now.history]) {
      if (!item.project || !item.projectPath) continue;
      let set = rootsBySpace.get(item.project);
      if (!set) {
        set = new Set();
        rootsBySpace.set(item.project, set);
      }
      set.add(item.projectPath);
    }
    const base = listSpaces({
      plain: plain.map((p) => ({ name: p.name, path: this.d.shortPath(join(this.d.root, p.name)), at: p.at })),
      live: now.live,
      history: now.history,
      removed: this.removed,
      kindOf: this.kindOf,
      exists: (p) => !!p && this.d.fs.exists(this.d.expandHome(p)),
    });
    const spaces: SpaceView[] = base.map((s) => {
      const roots = [...(rootsBySpace.get(s.name) ?? [])];
      const entry = this.ensureCatalog(s.name, s.kind, s.path, roots);
      const contextAbs = s.kind === 'space' ? join(this.d.root, s.name) : join(this.stateSpacesDir(), entry.id);
      return {
        ...s,
        id: entry.id,
        contextPath: this.d.shortPath(contextAbs),
        roots: entry.roots?.length ? entry.roots : s.path ? [s.path] : [],
      };
    });
    return { root: this.rootShort(), spaces, removed: [...this.removed].sort((a, b) => b.removedAt - a.removedAt).map(removedView) };
  }

  private async find(name: string): Promise<SpaceView | undefined> {
    return (await this.list()).spaces.find((s) => s.name === name);
  }

  /** Returns the Space-owned context directory (absolute) for any Space (`space`, `repo`, or `folder`). */
  async contextDirOf(name: string): Promise<{ space: SpaceView; dir: string }> {
    if (typeof name !== 'string' || !name || name.length > 200) throw new SpaceError(404, 'space_not_found', 'no Space by that name');
    const s = await this.find(name);
    if (!s) throw new SpaceError(404, 'space_not_found', `no Space called ${name} on this host`);
    const dir = s.contextPath ? this.d.expandHome(s.contextPath) : join(this.stateSpacesDir(), s.id ?? slugMemoryFile(name).replace(/\.md$/, ''));
    return { space: s, dir };
  }

  async create(nameIn: unknown, preferencesIn?: unknown): Promise<SpaceView> {
    const name = spaceName(nameIn);
    const preferences = preferencesIn === undefined || preferencesIn === null ? undefined : preferencesText(preferencesIn);
    const taken = (await this.list()).spaces.some((s) => s.name.toLowerCase() === name.toLowerCase());
    if (taken || this.removed.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      throw new SpaceError(409, 'space_exists', `there's already a Space called ${name} on this host${taken ? '' : ' (removed: restore it, or pick another name)'}`);
    }
    const dir = join(this.d.root, name);
    if ((await this.d.fs.makeDir(dir)) === 'exists') throw new SpaceError(409, 'space_exists', `${this.d.shortPath(dir)} is already there`);
    for (const f of startingFiles(name, preferences)) await this.d.fs.write(join(dir, f.file), f.text);
    // Create artifacts/ folder up front so Space deliverables always have a home.
    await this.d.fs.makeDir(join(dir, 'artifacts'));
    const entry = this.ensureCatalog(name, 'space', this.d.shortPath(dir));
    this.changed();
    await this.d.refresh();
    return (
      (await this.find(name)) ?? {
        id: entry.id,
        name,
        kind: 'space',
        path: this.d.shortPath(dir),
        contextPath: this.d.shortPath(dir),
        roots: [this.d.shortPath(dir)],
        exists: true,
        live: 0,
        conversations: 0,
        lastActivityAt: 0,
      }
    );
  }

  /**
   * Resolves the Space-owned context directory for any Space (plain, repo, or folder).
   * Plain Spaces use `~/spaces/<name>/`; Repo & Folder Spaces use `~/.local/state/ah/spaces/<id>/`
   * so Space instructions, memory, and artifacts never modify tracked repository files.
   */
  private async contextDir(nameIn: unknown, initIfMissing = false): Promise<{ space: SpaceView; dir: string }> {
    if (typeof nameIn !== 'string' || !nameIn || nameIn.length > 200) throw new SpaceError(404, 'space_not_found', 'no Space by that name');
    const ok = (() => {
      try {
        spaceName(nameIn);
        return true;
      } catch {
        return false;
      }
    })();
    const plainDir = join(this.d.root, nameIn);
    if (ok && !this.removed.some((r) => r.name === nameIn) && (await this.d.fs.isDir(plainDir)) && !this.d.isRepo(plainDir)) {
      const entry = this.ensureCatalog(nameIn, 'space', this.d.shortPath(plainDir));
      return {
        space: {
          id: entry.id,
          name: nameIn,
          kind: 'space',
          path: this.d.shortPath(plainDir),
          contextPath: this.d.shortPath(plainDir),
          roots: entry.roots ?? [this.d.shortPath(plainDir)],
          exists: true,
          live: 0,
          conversations: 0,
          lastActivityAt: 0,
        },
        dir: plainDir,
      };
    }
    const found = await this.find(nameIn);
    if (!found) throw new SpaceError(404, 'space_not_found', `no Space called ${nameIn} on this host`);
    const dir = found.contextPath ? this.d.expandHome(found.contextPath) : join(this.stateSpacesDir(), found.id ?? nameIn);
    if (initIfMissing && !(await this.d.fs.isDir(dir))) {
      await this.d.fs.makeDir(dir);
      await this.d.fs.makeDir(join(dir, 'artifacts'));
      await this.d.fs.write(join(dir, PREFERENCES_FILE), startingPreferences(found.name, found.kind));
      // Claude Code and Gemini (`agy`) read CLAUDE.md / GEMINI.md when given `--add-dir <contextDir>`.
      await this.d.fs.write(join(dir, 'CLAUDE.md'), `@${PREFERENCES_FILE}\n`);
      await this.d.fs.write(join(dir, 'GEMINI.md'), `@${PREFERENCES_FILE}\n`);
      await this.d.fs.write(join(dir, 'memory', MEMORY_INDEX), startingMemory(found.name));
    }
    return { space: found, dir };
  }

  /** Lists non-hidden deliverables inside a Space's `artifacts/` directory. */
  async artifacts(name: unknown): Promise<{ space: string; artifactsDir: string; artifacts: SpaceArtifact[] }> {
    const { space, dir } = await this.contextDir(name);
    const artifactsDir = join(dir, 'artifacts');
    const raw = (await this.d.fs.listFiles?.(artifactsDir).catch(() => [])) ?? [];
    const artifacts: SpaceArtifact[] = raw.map((f) => {
      const full = join(artifactsDir, f.name);
      return { name: f.name, path: full, shortPath: this.d.shortPath(full), bytes: f.bytes, updatedAt: f.at };
    });
    return { space: space.name, artifactsDir, artifacts };
  }

  /**
   * Builds the full Space context bundle (preferences, shared memory, artifacts, notes,
   * rendered markdown snapshot, and compact system-prompt pointer) for harnesses & CLI.
   */
  async context(name: unknown, { sync = false, initIfMissing = false } = {}): Promise<SpaceContextView> {
    const { space, dir } = await this.contextDir(name, initIfMissing);
    const memoryDir = join(dir, 'memory');
    const artifactsDir = join(dir, 'artifacts');
    const contextFile = join(dir, CONTEXT_FILE);
    const [prefsRead, memRes, rawArtifacts, notes] = await Promise.all([
      this.d.fs.read(join(dir, PREFERENCES_FILE), MAX_MEMORY),
      this.memory(space.name),
      this.d.fs.listFiles?.(artifactsDir).catch(() => []) ?? Promise.resolve([]),
      Promise.resolve(
        this.d.notesIn
          ? this.d.notesIn(
              space.path ? this.d.expandHome(space.path) : null,
              space.name,
              (space.roots ?? []).map((r) => this.d.expandHome(r)),
            )
          : [],
      ).catch(() => [] as SpaceContextNote[]),
    ]);
    const preferences = prefsRead?.text ?? (space.kind === 'space' ? '' : startingPreferences(space.name, space.kind));
    const indexFile = memRes.files.find((f) => f.name === MEMORY_INDEX);
    const memoryIndex = indexFile?.text ?? '';
    const memoryFiles = memRes.files.map((f) => ({
      name: f.name,
      summary: firstHeadingOrLine(f.text),
      bytes: f.bytes,
      updatedAt: f.updatedAt,
    }));
    const artifacts: SpaceArtifact[] = rawArtifacts.map((f) => {
      const full = join(artifactsDir, f.name);
      return { name: f.name, path: full, shortPath: this.d.shortPath(full), bytes: f.bytes, updatedAt: f.at };
    });
    const hasCustomContext =
      space.kind === 'space' ||
      !!prefsRead ||
      memRes.files.some((f) => f.name !== MEMORY_INDEX || f.updatedAt > 0) ||
      artifacts.length > 0 ||
      notes.length > 0;
    const pointer = renderSpacePointer({
      space: space.name,
      kind: space.kind,
      contextDir: dir,
      memoryDir,
      artifactsDir,
      contextFile,
      artifactCount: artifacts.length,
      memoryFileCount: memoryFiles.length,
      noteCount: notes.length,
    });
    const markdown = renderSpaceContextMarkdown({
      space: space.name,
      kind: space.kind,
      path: space.path,
      contextDir: dir,
      memoryDir,
      artifactsDir,
      roots: space.roots ?? (space.path ? [space.path] : []),
      preferences,
      memoryIndex,
      memoryFiles,
      artifacts,
      notes,
    });
    if (sync && (initIfMissing || (await this.d.fs.isDir(dir)))) {
      if (initIfMissing) {
        await this.d.fs.makeDir(artifactsDir);
        if (!this.d.fs.exists(join(dir, 'CLAUDE.md'))) await this.d.fs.write(join(dir, 'CLAUDE.md'), `@${PREFERENCES_FILE}\n`);
        if (!this.d.fs.exists(join(dir, 'GEMINI.md'))) await this.d.fs.write(join(dir, 'GEMINI.md'), `@${PREFERENCES_FILE}\n`);
      }
      await this.d.fs.write(contextFile, markdown).catch(() => {});
    }
    return {
      space: space.name,
      kind: space.kind,
      path: space.path,
      contextPath: dir,
      memoryDir,
      artifactsDir,
      contextFile,
      roots: space.roots ?? (space.path ? [space.path] : []),
      preferences,
      memoryIndex,
      memoryFiles,
      artifacts,
      notes,
      hasCustomContext,
      pointer,
      markdown,
    };
  }

  /**
   * Prepares Space context for a session launch/resume/fork: refreshes `.ah-space-context.md`
   * when the Space already has context (or when explicitly attached to a Space) and returns
   * the canonical `AH_SPACE*` environment variables and harness launch injection inputs.
   */
  async prepareSessionContext(
    spaceNameIn: string,
    cwd: string,
    { explicit = false } = {},
  ): Promise<{
    env: Record<string, string>;
    contextDir: string;
    contextFile: string;
    pointer: string;
    shouldAddDir: boolean;
    shouldInjectPrompt: boolean;
  } | null> {
    try {
      const ctx = await this.context(spaceNameIn, { sync: true, initIfMissing: explicit });
      const sameDir = ctx.contextPath.replace(/\/+$/, '') === cwd.replace(/\/+$/, '');
      const dirExists = await this.d.fs.isDir(ctx.contextPath);
      const env: Record<string, string> = {
        AH_SPACE: ctx.space,
        AH_SPACE_DIR: ctx.contextPath,
        AH_SPACE_MEMORY_DIR: ctx.memoryDir,
        AH_SPACE_ARTIFACTS_DIR: ctx.artifactsDir,
        AH_SPACE_CONTEXT_FILE: ctx.contextFile,
      };
      return {
        env,
        contextDir: ctx.contextPath,
        contextFile: ctx.contextFile,
        pointer: ctx.pointer,
        shouldAddDir: dirExists && !sameDir && (explicit || ctx.hasCustomContext),
        shouldInjectPrompt: explicit || ctx.hasCustomContext,
      };
    } catch {
      return null;
    }
  }

  async preferences(name: unknown): Promise<{ text: string; file: string; updatedAt: number; contextPath?: string }> {
    const { space, dir } = await this.contextDir(name);
    const got = await this.d.fs.read(join(dir, PREFERENCES_FILE), Number.MAX_SAFE_INTEGER);
    return {
      text: got?.text ?? (space.kind === 'space' ? '' : startingPreferences(space.name, space.kind)),
      file: PREFERENCES_FILE,
      updatedAt: got?.at ?? 0,
      ...(space.contextPath ? { contextPath: space.contextPath } : {}),
    };
  }

  async setPreferences(name: unknown, textIn: unknown, expectedUpdatedAt?: number): Promise<{ text: string; file: string; updatedAt: number }> {
    const { dir } = await this.contextDir(name, true);
    if (typeof expectedUpdatedAt === 'number' && Number.isFinite(expectedUpdatedAt)) {
      const cur = await this.d.fs.read(join(dir, PREFERENCES_FILE), 16);
      if (cur && cur.at !== expectedUpdatedAt) {
        throw new SpaceError(409, 'space_conflict', 'preferences were updated concurrently; reload and retry');
      }
    }
    const text = preferencesText(textIn);
    const at = await this.d.fs.write(join(dir, PREFERENCES_FILE), text);
    await this.context(name, { sync: true }).catch(() => {});
    return { text, file: PREFERENCES_FILE, updatedAt: at };
  }

  async memory(name: unknown): Promise<{ files: MemoryFile[] }> {
    const { space, dir: base } = await this.contextDir(name);
    const dir = join(base, 'memory');
    const names = (await this.d.fs.markdown(dir).catch(() => [] as string[]))
      .filter((n) => {
        try {
          return !!memoryFile(n);
        } catch {
          return false;
        }
      })
      .sort((a, b) => Number(b === MEMORY_INDEX) - Number(a === MEMORY_INDEX) || a.localeCompare(b))
      .slice(0, MAX_MEMORY_FILES);
    const files: MemoryFile[] = [];
    for (const n of names) {
      const got = await this.d.fs.read(join(dir, n), MAX_MEMORY);
      if (!got) continue;
      files.push({ name: n, text: got.text, bytes: got.bytes, updatedAt: got.at, ...(got.bytes > MAX_MEMORY ? { truncated: true } : {}) });
    }
    if (!files.length && space.kind !== 'space') {
      const text = startingMemory(space.name);
      files.push({ name: MEMORY_INDEX, text, bytes: Buffer.byteLength(text), updatedAt: 0 });
    }
    return { files };
  }

  async setMemory(name: unknown, fileIn: unknown, textIn: unknown, expectedUpdatedAt?: number): Promise<MemoryFile> {
    const { dir: base } = await this.contextDir(name, true);
    const dir = join(base, 'memory');
    const file = memoryFile(fileIn);
    if (typeof expectedUpdatedAt === 'number' && Number.isFinite(expectedUpdatedAt)) {
      const cur = await this.d.fs.read(join(dir, file), 16);
      if (cur && cur.at !== expectedUpdatedAt) {
        throw new SpaceError(409, 'space_conflict', `${file} was updated concurrently; reload and retry`);
      }
    }
    const text = memoryText(textIn);
    const at = await this.d.fs.write(join(dir, file), text);
    await this.context(name, { sync: true }).catch(() => {});
    return { name: file, text, bytes: Buffer.byteLength(text), updatedAt: at };
  }

  async deleteMemory(name: unknown, fileIn: unknown): Promise<void> {
    const { dir: base } = await this.contextDir(name);
    const dir = join(base, 'memory');
    const file = memoryFile(fileIn);
    if (file === MEMORY_INDEX) throw new SpaceError(409, 'memory_index', `${MEMORY_INDEX} is the memory's index: edit it instead`);
    if (!(await this.d.fs.remove(join(dir, file)))) throw new SpaceError(404, 'memory_not_found', `no ${file} in this Space's memory`);
    await this.context(name, { sync: true }).catch(() => {});
  }

  /** Promotes a note, task result, or artifact into Space memory/knowledge and indexes it in MEMORY.md. */
  async promoteKnowledge(
    name: unknown,
    input: { title: unknown; markdown: unknown; file?: unknown; source?: unknown; by?: string | null },
  ): Promise<{ file: MemoryFile; index: MemoryFile }> {
    const { space, dir: base } = await this.contextDir(name, true);
    const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : 'Promoted knowledge';
    const rawMarkdown = memoryText(input.markdown);
    let file = input.file ? memoryFile(input.file) : memoryFile(slugMemoryFile(title));
    if (file === MEMORY_INDEX) throw new SpaceError(400, 'invalid_memory_file', `pick a topic file name instead of ${MEMORY_INDEX}`);
    // Avoid silently overwriting an existing unrelated knowledge file when auto-slugging a title.
    if (!input.file) {
      const memDir = join(base, 'memory');
      const stem = file.replace(/\.md$/i, '');
      let seq = 2;
      while (this.d.fs.exists(join(memDir, file)) && seq <= 99) {
        file = memoryFile(`${stem.slice(0, 68)}-${seq++}.md`);
      }
    }
    const source = typeof input.source === 'string' ? input.source.trim().slice(0, 200) : undefined;
    const formatted = formatPromotedKnowledge({ title, markdown: rawMarkdown, source, promotedAt: this.now(), by: input.by });
    const saved = await this.setMemory(space.name, file, formatted);
    const idxPath = join(base, 'memory', MEMORY_INDEX);
    const curIndex = (await this.d.fs.read(idxPath, MAX_MEMORY))?.text ?? '';
    const nextIndex = upsertMemoryIndex(curIndex, space.name, file, title);
    const index = await this.setMemory(space.name, MEMORY_INDEX, nextIndex);
    return { file: saved, index };
  }

  async remove(nameIn: unknown): Promise<RemovedView> {
    if (typeof nameIn !== 'string' || !nameIn || nameIn.length > 200) throw new SpaceError(404, 'space_not_found', 'no Space by that name');
    const name = nameIn;
    const s = await this.find(name);
    if (!s) throw new SpaceError(404, 'space_not_found', `no Space called ${name} on this host`);
    if (s.live > 0) throw new SpaceError(409, 'space_busy', `${name} has ${s.live === 1 ? 'a session' : `${s.live} sessions`} running: end ${s.live === 1 ? 'it' : 'them'} first`);
    let archive: string | null = null;
    if (s.kind === 'space') {
      const from = join(this.d.root, name);
      if (await this.d.fs.isDir(from)) {
        const shelf = join(this.d.root, ARCHIVE);
        await this.d.fs.makeDir(shelf);
        archive = join(shelf, archiveName(name, (c) => this.d.fs.exists(join(shelf, c))));
        await this.d.fs.move(from, archive);
      }
    }
    const refs = await this.d.refsIn(name);
    const r: Removed = { name, kind: s.kind, path: s.path, removedAt: this.now(), conversations: refs.length, archive, refs };
    this.removed = [r, ...this.removed.filter((x) => x.name !== name)];
    this.changed();
    await this.d.refresh();
    return removedView(r);
  }

  async restore(nameIn: unknown): Promise<SpaceView | null> {
    const r = this.removed.find((x) => x.name === nameIn);
    if (!r) throw new SpaceError(404, 'space_not_found', 'no removed Space by that name');
    if (r.archive) {
      const to = join(this.d.root, r.name);
      if (this.d.fs.exists(to)) throw new SpaceError(409, 'space_exists', `${this.d.shortPath(to)} was made since: move it, then restore`);
      if (this.d.fs.exists(r.archive)) await this.d.fs.move(r.archive, to);
    }
    this.removed = this.removed.filter((x) => x !== r);
    this.changed();
    await this.d.refresh();
    return (await this.find(r.name)) ?? null;
  }

  /** Waits for spaces.json to be written (tests, shutdown). */
  flushed(): Promise<void> {
    return this.saving;
  }
}
