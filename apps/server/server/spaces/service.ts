// Spaces' use cases (docs/spec/17-spaces.md): the list, a new plain Space, its preferences
// and memory, removing and restoring. The rules are model.ts's; the folders are reached
// through the SpaceFs port (files.ts), the sessions through the deps the composition
// root connects.
import { join } from 'node:path';
import {
  MAX_MEMORY,
  MAX_MEMORY_FILES,
  MEMORY_INDEX,
  PREFERENCES_FILE,
  SpaceError,
  archiveName,
  listSpaces,
  memoryFile,
  memoryText,
  preferencesText,
  removedView,
  shown,
  spaceName,
  startingFiles,
  stillRemoved,
  type Placed,
  type Removed,
  type RemovedView,
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
  now?: () => number;
};

export type MemoryFile = { name: string; text: string; bytes: number; updatedAt: number; truncated?: boolean };

const ARCHIVE = '.archive';

export class SpacesService {
  private removed: Removed[] = [];
  private revision = 0;
  private saving: Promise<void> = Promise.resolve();

  private d: SpacesDeps;

  constructor(d: SpacesDeps) {
    this.d = d;
  }

  private now(): number {
    return this.d.now?.() ?? Math.floor(Date.now() / 1000);
  }

  async load(): Promise<void> {
    const v = (await this.d.fs.loadJson(this.d.stateFile).catch(() => null)) as { removed?: Removed[] } | null;
    this.removed = Array.isArray(v?.removed)
      ? v.removed.filter((r) => typeof r?.name === 'string' && typeof r.removedAt === 'number').map((r) => ({ ...r, refs: Array.isArray(r.refs) ? r.refs.filter((x) => typeof x === 'string') : [] }))
      : [];
  }

  state(): SpacesState {
    return { revision: this.revision };
  }

  private changed(): void {
    this.revision++;
    const removed = this.removed;
    this.saving = this.saving.then(() => this.d.fs.saveJson(this.d.stateFile, { removed })).catch((err) => console.error('spaces: saving spaces.json failed:', err));
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
    if (abs.startsWith(this.d.root + '/') && !abs.slice(this.d.root.length + 1).includes('/')) return 'space';
    return this.d.isRepo(abs) ? 'repo' : 'folder';
  };

  async list(): Promise<{ root: string; spaces: SpaceView[]; removed: RemovedView[] }> {
    const [now, plain] = await Promise.all([this.d.current(), this.d.fs.folders(this.d.root).catch(() => [])]);
    const spaces = listSpaces({
      plain: plain.map((p) => ({ name: p.name, path: this.d.shortPath(join(this.d.root, p.name)), at: p.at })),
      live: now.live,
      history: now.history,
      removed: this.removed,
      kindOf: this.kindOf,
      exists: (p) => !!p && this.d.fs.exists(this.d.expandHome(p)),
    });
    return { root: this.rootShort(), spaces, removed: [...this.removed].sort((a, b) => b.removedAt - a.removedAt).map(removedView) };
  }

  private async find(name: string): Promise<SpaceView | undefined> {
    return (await this.list()).spaces.find((s) => s.name === name);
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
    this.changed();
    await this.d.refresh();
    return (await this.find(name)) ?? { name, kind: 'space', path: this.d.shortPath(dir), exists: true, live: 0, conversations: 0, lastActivityAt: 0 };
  }

  /** A plain Space's folder, or why there's none: 404 for no Space, 409 for one of another kind. */
  private async plain(nameIn: unknown): Promise<string> {
    if (typeof nameIn !== 'string' || !nameIn || nameIn.length > 200) throw new SpaceError(404, 'space_not_found', 'no Space by that name');
    const ok = (() => {
      try {
        spaceName(nameIn);
        return true;
      } catch {
        return false;
      }
    })();
    const dir = join(this.d.root, nameIn);
    if (ok && !this.removed.some((r) => r.name === nameIn) && (await this.d.fs.isDir(dir))) return dir;
    if (await this.find(nameIn)) throw new SpaceError(409, 'not_a_plain_space', `${nameIn} is a repository or a folder: its own files hold its instructions`);
    throw new SpaceError(404, 'space_not_found', `no Space called ${nameIn} on this host`);
  }

  async preferences(name: unknown): Promise<{ text: string; file: string; updatedAt: number }> {
    const dir = await this.plain(name);
    const got = await this.d.fs.read(join(dir, PREFERENCES_FILE), Number.MAX_SAFE_INTEGER);
    return { text: got?.text ?? '', file: PREFERENCES_FILE, updatedAt: got?.at ?? 0 };
  }

  async setPreferences(name: unknown, textIn: unknown): Promise<{ text: string; file: string; updatedAt: number }> {
    const dir = await this.plain(name);
    const text = preferencesText(textIn);
    const at = await this.d.fs.write(join(dir, PREFERENCES_FILE), text);
    return { text, file: PREFERENCES_FILE, updatedAt: at };
  }

  async memory(name: unknown): Promise<{ files: MemoryFile[] }> {
    const dir = join(await this.plain(name), 'memory');
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
    return { files };
  }

  async setMemory(name: unknown, fileIn: unknown, textIn: unknown): Promise<MemoryFile> {
    const dir = join(await this.plain(name), 'memory');
    const file = memoryFile(fileIn);
    const text = memoryText(textIn);
    const at = await this.d.fs.write(join(dir, file), text);
    return { name: file, text, bytes: Buffer.byteLength(text), updatedAt: at };
  }

  async deleteMemory(name: unknown, fileIn: unknown): Promise<void> {
    const dir = join(await this.plain(name), 'memory');
    const file = memoryFile(fileIn);
    if (file === MEMORY_INDEX) throw new SpaceError(409, 'memory_index', `${MEMORY_INDEX} is the memory's index: edit it instead`);
    if (!(await this.d.fs.remove(join(dir, file)))) throw new SpaceError(404, 'memory_not_found', `no ${file} in this Space's memory`);
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
