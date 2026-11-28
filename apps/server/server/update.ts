// Settings → System → Update the host: bring the checkout ah runs from up to the newest server
// on GitHub (origin's main) that serves the client asking, build it, and restart.
//
// A client says what it needs as the features it gates on (`requires`, name → version; the
// app's are `AppProtocol.requires`, held to its sources by packages/protocol/check-app.mjs).
// The target's own packages/protocol/versions.json says what it announces, so a server that
// wouldn't serve the app is refused before anything moves. The contract is additive
// (packages/protocol/README.md), so the newest main that announces enough is the one to run.
//
// Only a fast-forward of a clean `main`: a checkout with local changes, on another branch, or
// ahead of GitHub is the owner's to sort out, and is refused with why. A build that fails puts
// the checkout back where it was and builds that again, so the host keeps running what it ran.
//
// App releases are tagged `ios/v<version>` (scripts/tag-app-release.sh) on the commit the App
// Store build came from: that commit pins the app and the server it was tested with.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DomainError } from './errors.ts';

const exec = promisify(execFile);

export class UpdateError extends DomainError {}

/** Feature name → the contract version a client needs (`supports(name, version:)`). */
export type Requires = Record<string, number>;

export type HostVersion = {
  /** The checkout's HEAD. */
  commit: string;
  /** Its branch; null when detached. */
  branch: string | null;
  /** HEAD's commit time, ISO 8601. */
  committedAt: string;
  /** HEAD's subject line. */
  subject: string;
  /** No tracked file differs from HEAD. */
  clean: boolean;
  /** App releases whose tag (`ios/v<version>`) this checkout contains, oldest first: the app versions this server was built with or after. */
  appReleases: string[];
};

export type UpdateCheck = {
  current: HostVersion;
  /** origin/main as just fetched. */
  target: { commit: string; committedAt: string; subject: string };
  /** Commits the checkout is behind it. 0: up to date. */
  behind: number;
  /** What the target lacks of `requires`, as "name version": empty when it serves the client. */
  missing: string[];
  /** Why the checkout can't be moved to it, when it can't. */
  blocked?: { code: string; message: string };
};

export type UpdateResult = { updated: boolean; from: string; to: string };

/** The branch an update follows, on origin (GitHub). */
export const UPDATE_BRANCH = 'main';
const APP_TAGS = 'ios/v*';
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

async function git(repo: string, args: string[], timeout = 15_000): Promise<string> {
  const { stdout } = await exec('git', ['-C', repo, ...args], { timeout, maxBuffer: 4 * 1024 * 1024, env: GIT_ENV });
  return stdout.trim();
}

/** The repository `dir` is in: the workspace root above apps/server. */
export async function repoRoot(dir: string): Promise<string> {
  return git(dir, ['rev-parse', '--show-toplevel']);
}

/** "1.10" sorts after "1.9". */
function byVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export async function hostVersion(repo: string): Promise<HostVersion> {
  const [head, branch, status, tags] = await Promise.all([
    git(repo, ['log', '-1', '--format=%H%n%cI%n%s']),
    git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
    git(repo, ['status', '--porcelain', '--untracked-files=no']),
    git(repo, ['tag', '--merged', 'HEAD', '--list', APP_TAGS]),
  ]);
  const [commit, committedAt, subject] = head.split('\n');
  return {
    commit,
    branch: branch || null,
    committedAt,
    subject: subject ?? '',
    clean: status === '',
    appReleases: tags.split('\n').filter(Boolean).map((t) => t.slice('ios/v'.length)).sort(byVersion),
  };
}

/** What `announced` (a versions.json) lacks of `requires`. Pure. */
export function missingFeatures(requires: Requires, announced: { features?: Record<string, number> }): string[] {
  const features = announced.features ?? {};
  return Object.entries(requires)
    .filter(([name, version]) => (features[name] ?? 0) < version)
    .map(([name, version]) => `${name} ${version}`)
    .sort();
}

/** A request's `requires`: an object of feature names to positive whole versions. */
export function parseRequires(raw: unknown): Requires {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new UpdateError(400, 'requires must be an object of feature versions');
  const out: Requires = {};
  for (const [name, version] of Object.entries(raw)) {
    if (!/^\w{1,48}$/.test(name) || !Number.isInteger(version) || (version as number) < 1) throw new UpdateError(400, `requires.${name.slice(0, 48)} must be a whole version of 1 or more`);
    out[name] = version as number;
  }
  if (Object.keys(out).length > 200) throw new UpdateError(400, 'requires names too many features');
  return out;
}

/** Why the checkout can't move, from what it holds alone (no fetch needed): another branch, or changes of its own. */
function localBlock(current: HostVersion): { code: string; message: string } | undefined {
  if (current.branch !== UPDATE_BRANCH) {
    return { code: 'not_main', message: `The host's checkout is on ${current.branch ? `branch ${current.branch}` : 'a detached commit'}, not ${UPDATE_BRANCH}: switch it back to update from GitHub.` };
  }
  if (!current.clean) return { code: 'local_changes', message: "The host's checkout has changes of its own: commit or discard them to update from GitHub." };
  return undefined;
}

/** Fetch origin's main and say whether the checkout can move to it, and whether it serves `requires`. Moves nothing. */
export async function checkUpdate(repo: string, requires: Requires, api: number): Promise<UpdateCheck> {
  try {
    await git(repo, ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${UPDATE_BRANCH}:refs/remotes/origin/${UPDATE_BRANCH}`, '+refs/tags/ios/*:refs/tags/ios/*'], 90_000);
  } catch (err) {
    const why = String((err as { stderr?: unknown }).stderr ?? '').trim() || (err as Error).message;
    throw new UpdateError(502, `Couldn't reach GitHub to look for a newer server: ${why}`, 'fetch_failed');
  }
  const remote = `origin/${UPDATE_BRANCH}`;
  const current = await hostVersion(repo);
  const [targetLine, versionsText] = await Promise.all([
    git(repo, ['log', '-1', '--format=%H%n%cI%n%s', remote]),
    git(repo, ['show', `${remote}:packages/protocol/versions.json`]).catch(() => ''),
  ]);
  const [commit, committedAt, subject] = targetLine.split('\n');
  let announced: { api?: number; features?: Record<string, number> } = {};
  try {
    announced = JSON.parse(versionsText);
  } catch {
    // A main without the manifest predates it: it announces nothing a client can count on.
  }
  const missing = missingFeatures(requires, announced);
  if (announced.api !== api) missing.unshift(`api ${api}`);
  const behind = Number(await git(repo, ['rev-list', '--count', `HEAD..${remote}`]));
  const ahead = Number(await git(repo, ['rev-list', '--count', `${remote}..HEAD`]));
  const blocked =
    localBlock(current) ??
    (ahead > 0 ? { code: 'diverged', message: `The host's checkout has ${ahead} commit${ahead === 1 ? '' : 's'} GitHub's ${UPDATE_BRANCH} doesn't: push or drop them to update.` } : undefined);
  return { current, target: { commit, committedAt, subject: subject ?? '' }, behind, missing, ...(blocked ? { blocked } : {}) };
}

/**
 * Move the checkout to origin's main and build it, when that serves `requires`. Already
 * there: nothing moves (`updated: false`). The caller restarts ah after an update.
 * A failed build is undone: the checkout goes back to `from` and that is built again.
 */
export async function applyUpdate(repo: string, requires: Requires, api: number, build: (repo: string) => Promise<void>): Promise<UpdateResult> {
  // Refused before GitHub is asked anything, when the checkout couldn't move anyway.
  const early = localBlock(await hostVersion(repo));
  if (early) throw new UpdateError(409, early.message, early.code);
  const check = await checkUpdate(repo, requires, api);
  if (check.blocked) throw new UpdateError(409, check.blocked.message, check.blocked.code);
  if (check.missing.length) {
    throw new UpdateError(409, `No server on GitHub serves this app yet: ${UPDATE_BRANCH} lacks ${check.missing.join(', ')}.`, 'no_matching_server');
  }
  const from = check.current.commit;
  const to = check.target.commit;
  if (check.behind === 0) return { updated: false, from, to };
  await git(repo, ['merge', '--ff-only', '--quiet', to], 60_000);
  try {
    await build(repo);
  } catch (err) {
    // Back to what's running, so a restart (or a crash) brings up what built before.
    await git(repo, ['reset', '--keep', from], 60_000);
    await build(repo).catch((again) => console.error(`update: rebuilding ${from.slice(0, 8)} after a failed update failed too: ${(again as Error).message}`));
    throw err;
  }
  return { updated: true, from, to };
}

const BUILD_OPTS = { timeout: 15 * 60_000, maxBuffer: 8 * 1024 * 1024 };

/** The workspace's own build: dependencies as locked (node-pty, Prisma), then the page (root package.json `build`). */
export async function buildWorkspace(repo: string): Promise<void> {
  await exec('pnpm', ['build'], { ...BUILD_OPTS, cwd: repo });
}
