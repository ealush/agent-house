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
  /** tmux key names typed for one-tap Approve / Deny on a permission prompt. */
  approveKeys?: string[];
  denyKeys?: string[];
};

export type Config = {
  port: number;
  host: string;
  /** tmux session that new windows go into unless another is chosen. */
  defaultSession: string;
  /** Directories whose children are offered as project folders. */
  projectRoots: string[];
  /** Seconds since last output after which a window counts as idle. */
  idleAfter: number;
  /**
   * Other machines running ah. "auto" finds your own online tailnet machines that
   * answer on ah's port or via `tailscale serve`; or list them: [{ "name", "url" }].
   */
  peers: Array<{ name: string; url: string; token?: string }> | 'auto';
  /**
   * Where the file browser may read and write. Defaults to your project roots,
   * ah's upload folder and /tmp; add "~" to open up your whole home (dotfiles,
   * keys and all) — a deliberate choice, not a default.
   */
  files: { roots: string[] };
  /** How many sent prompts to remember for "recent" (0 = don't keep any). They're sensitive. */
  promptHistory: number;
  /** App sign-in on top of Tailscale. See server/auth.ts. */
  auth: { mode: 'passkey' | 'off'; idleHours: number; maxDays: number };
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
    // The permission dialog highlights "Yes"; Esc declines.
    approveKeys: ['Enter'],
    denyKeys: ['Escape'],
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    resume: 'codex resume --last',
    resumeId: 'codex resume {id}',
    match: '^codex',
    waitingPatterns: ['Would you like to (run|make|apply)', 'Allow (Codex|command)', '\\(y\\)es.*\\(n\\)o'],
    approveKeys: ['y'],
    denyKeys: ['Escape'],
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
    try {
      user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      // Refuse to guess: a typo here could silently change who can get in.
      throw new Error(`${CONFIG_PATH} is not valid JSON (${(err as Error).message}). Fix it and restart.`);
    }
  }
  return {
    port: 7681,
    host: '127.0.0.1',
    defaultSession: 'agents',
    projectRoots: ['~/code'],
    idleAfter: 4,
    // Multi-host is opt-in: list peers, or "auto" to discover your own tailnet machines.
    peers: [],
    ...user,
    auth: { mode: 'passkey', idleHours: 24, maxDays: 30, ...user.auth },
    files: { roots: [...(user.projectRoots ?? ['~/code']), '~/.cache/ah/uploads', '/tmp'], ...user.files },
    promptHistory: user.promptHistory ?? 60,
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
