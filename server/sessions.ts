// Turns raw tmux windows into the model the UI shows: which agent is running,
// which project it belongs to, and whether it is working, idle or waiting on you.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { listWindows, setWindowOption, type RawWindow } from './tmux.ts';
import { Registry } from './registry.ts';
import { snapshot, descendants } from './procs.ts';
import type { Config, Preset } from './config.ts';

// busy: producing output · waiting: agent asked for input/permission (hooks only)
// attention: finished since you last looked · idle: nothing new
export type Status = 'busy' | 'idle' | 'waiting' | 'attention';

export type WindowView = {
  id: string;
  session: string;
  index: number;
  name: string;
  uid: string | null;
  agent: string | null;
  model: string | null;
  /** True when status comes from agent hooks rather than output heuristics. */
  hooked: boolean;
  command: string;
  cwd: string;
  project: string;
  projectPath: string;
  status: Status;
  viewers: number;
  activity: number;
  createdAt: number;
  panes: number;
};

const HOME = homedir();
const gitRootCache = new Map<string, string | null>();

function gitRoot(dir: string): string | null {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir)!;
  let cur = dir;
  let found: string | null = null;
  while (cur && cur !== '/') {
    if (existsSync(join(cur, '.git'))) {
      found = cur;
      break;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  gitRootCache.set(dir, found);
  return found;
}

export function shortPath(p: string): string {
  return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p;
}

function compileMatchers(presets: Preset[]): Array<[string, RegExp]> {
  return presets
    .filter((p) => p.command)
    .map((p) => [p.id, new RegExp(p.match ?? `^${escape(basename(p.command.split(/\s+/)[0]))}$`)]);
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectAgent(w: RawWindow, procs: Awaited<ReturnType<typeof snapshot>>, matchers: Array<[string, RegExp]>) {
  const tree = descendants(procs, w.panePid);
  for (const proc of tree) {
    const names = proc.argv.slice(0, 2).map((a) => basename(a));
    for (const [id, re] of matchers) {
      if (names.some((n) => re.test(n))) return id;
    }
  }
  return null;
}

export async function buildWindows(config: Config, viewerCounts: Map<string, number>, registry: Registry): Promise<WindowView[]> {
  const [raw, procs] = await Promise.all([listWindows(), snapshot()]);
  const matchers = compileMatchers(config.presets);
  const now = Date.now() / 1000;
  const alive = new Set<string>();

  const views = await Promise.all(
    raw.map(async (w) => {
      const viewers = viewerCounts.get(w.windowId) ?? 0;
      // Anything printed while someone is looking counts as read.
      let seen = w.seen;
      if (viewers > 0 && w.activity > seen) {
        seen = w.activity;
        await setWindowOption(w.windowId, '@ah-seen', String(seen)).catch(() => {});
      }

      const agent = detectAgent(w, procs, matchers);
      const quiet = now - w.activity >= config.idleAfter;
      // Hook state is trusted only while that agent is still running in the window.
      const hooked = !!w.hookState && w.hookState !== 'ended' && agent === w.harness;
      let status: Status;
      if (hooked && w.hookState === 'waiting') status = 'waiting';
      // An interrupted turn may never send Stop; long silence overrides "working".
      else if (hooked && w.hookState === 'working' && now - w.activity < 30) status = 'busy';
      else if (hooked && (w.hookState === 'done' || w.hookState === 'idle'))
        status = w.hookAt > seen && viewers === 0 ? 'attention' : quiet ? 'idle' : 'busy';
      else status = !quiet ? 'busy' : w.activity > seen && viewers === 0 && seen > 0 ? 'attention' : 'idle';

      const root = gitRoot(w.path);
      const projectPath = root ?? w.path;

      // Register agent windows so they can be resumed after tmux itself is gone.
      const harness = agent ?? (w.harness || (w.agentTag && w.agentTag !== 'shell' ? w.agentTag : ''));
      let uid = w.uid || null;
      if (harness && !uid) {
        uid = Registry.newId();
        await setWindowOption(w.windowId, '@ah-uid', uid).catch(() => {});
      }
      if (uid) {
        alive.add(uid);
        registry.upsert(uid, {
          tmuxSession: w.session,
          windowId: w.windowId,
          name: w.name,
          cwd: w.path,
          harness: harness || registry.get(uid)?.harness || 'shell',
          harnessId: w.harness === harness ? w.harnessId : undefined,
          model: w.harness === harness ? w.model : undefined,
          status,
          createdAt: w.createdAt || undefined,
        });
      }

      return {
        id: w.windowId,
        session: w.session,
        index: w.index,
        name: w.name,
        uid,
        agent,
        model: hooked && w.model ? w.model : null,
        hooked,
        command: w.command,
        cwd: shortPath(w.path),
        project: projectPath === HOME ? '~' : basename(projectPath),
        projectPath: shortPath(projectPath),
        status,
        viewers,
        activity: w.activity,
        createdAt: w.createdAt,
        panes: w.panes,
      };
    }),
  );
  registry.reconcile(alive);
  return views;
}
