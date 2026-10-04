import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export type Preset = {
  id: string;
  name: string;
  /** Typed into a fresh shell. Empty for a plain shell. */
  command: string;
  /** Optional command that continues the most recent conversation in the cwd. */
  resume?: string;
  /** Resumes one specific conversation; `{id}` is replaced by the id agent hooks reported. */
  resumeId?: string;
  /** Regex tested against the basenames of running processes' argv[0]/argv[1]. */
  match?: string;
  /**
   * Terminal rules for agents without hooks: regexes (multiline) tested against the last
   * screen lines of a quiet window. A match means "waiting for you". Keep them tight —
   * a false "needs you" is worse than a missed one.
   */
  waitingPatterns?: string[];
};

export type Config = {
  port: number;
  host: string;
  /** tmux session that new windows go into unless another is chosen. */
  defaultSession: string;
  /** Directories whose children are offered as project folders. */
  projectRoots: string[];
  /** Extra Host header values to accept (the Tailscale name and IPs are added automatically). */
  allowedHosts: string[];
  /** Seconds since last output after which a window counts as idle. */
  idleAfter: number;
  /**
   * Other machines running ah. "auto" finds your own online tailnet machines that
   * answer on ah's port or via `tailscale serve`; or list them: [{ "name", "url" }].
   */
  peers: Array<{ name: string; url: string }> | 'auto';
  presets: Preset[];
};

const DEFAULT_PRESETS: Preset[] = [
  { id: 'shell', name: 'Shell', command: '' },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    resume: 'claude --continue',
    resumeId: 'claude --resume {id}',
    match: '^claude$',
    waitingPatterns: ['Do you want to (proceed|make this edit|create|allow)', '^\\s*❯\\s*1\\.\\s*Yes'],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    resume: 'codex resume --last',
    resumeId: 'codex resume {id}',
    match: '^codex',
    waitingPatterns: ['Would you like to (run|make|apply)', 'Allow (Codex|command)', '\\(y\\)es.*\\(n\\)o'],
  },
  { id: 'gemini', name: 'Gemini', command: 'gemini', match: '^gemini$' },
  { id: 'grok', name: 'Grok', command: 'grok', match: '^grok$' },
  { id: 'muse', name: 'Muse', command: 'muse', match: '^muse' },
  { id: 'hermes', name: 'Hermes', command: 'hermes', match: '^hermes' },
  { id: 'opencode', name: 'opencode', command: 'opencode', match: '^opencode' },
];

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ah', 'config.json');

export function loadConfig(): Config {
  let user: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  }
  return {
    port: 7681,
    host: '127.0.0.1',
    defaultSession: 'agents',
    projectRoots: ['~/code'],
    allowedHosts: [],
    idleAfter: 4,
    peers: 'auto',
    ...user,
    presets: user.presets ?? DEFAULT_PRESETS,
  };
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

export function isExecutableOnPath(cmd: string, pathVar: string): boolean {
  const bin = cmd.trim().split(/\s+/)[0];
  if (!bin) return true;
  if (isAbsolute(bin)) return canExec(bin);
  return pathVar.split(':').some((dir) => dir && canExec(join(dir, bin)));
}

function canExec(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
