import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { DEFAULT_USAGE, type UsageConfig } from './usage/service.ts';
import { DEFAULT_RECOVERY, type RecoveryConfig } from './recovery/engine.ts';
import { DEFAULT_UPLOAD_LIMITS, type UploadLimits } from './uploads.ts';
import type { GateRule } from './agentgate.ts';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

export type LaunchAppliesTo = 'launch' | 'resume' | 'both';

export type PresetChoice = {
  id: string;
  name: string;
  /** Extra argv appended after the base command. */
  args?: string[];
  /** Shown with a warning; never becomes the implicit default. */
  dangerous?: boolean;
  description?: string;
  appliesTo?: LaunchAppliesTo;
};

export type ModelChoice = {
  id: string;
  name: string;
  args: string[];
  appliesTo?: LaunchAppliesTo;
  description?: string;
  /** Effort levels this model supports (defaults to the preset's). */
  efforts?: string[];
  /** The harness's own default (from its config), filled in by the catalog. */
  isDefault?: boolean;
};

/** Reasoning effort: argv template with {level}, and the accepted levels, low → high. */
export type EffortSpec = { args: string[]; levels: string[]; appliesTo?: LaunchAppliesTo };

export type Preset = {
  id: string;
  name: string;
  /** Typed into a fresh shell. Empty for a plain shell. */
  command: string;
  /** Declarative launch choices (F42). For shells, modes select the shell binary. */
  modes?: PresetChoice[];
  models?: ModelChoice[];
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
  /**
   * The agent's startup folder-trust prompt ("Do you trust this folder?"): `pattern`
   * (multiline regex) tells it is on screen, `accept` matches the label of the
   * picker row that trusts the folder. While it is up the session waits for you
   * and a message sent to it is queued, never typed into the prompt (the paste
   * is dropped and its Enter answers the default row). A session launched with
   * `trust` has it accepted by ah.
   */
  trust?: { pattern: string; accept: string };
  /**
   * The agent's other screens in front of its prompt (server/agentgate.ts): its own
   * sign-in and first-run setup, where any agent's sign-in isn't enough to tell.
   * While one is up the session waits for you and a message waits in the queue.
   */
  gates?: GateRule[];
  /**
   * Text the agent shows once it's past those screens, at its prompt (multiline regex):
   * for an agent that prints them line by line, they stay on screen above it after.
   */
  ready?: string;
  /** tmux key names typed for one-tap Approve / Deny on a permission prompt. */
  approveKeys?: string[];
  denyKeys?: string[];
  effort?: EffortSpec;
  /** Where to read the live model list / defaults from (see server/catalog.ts). */
  catalog?: 'claude' | 'codex' | 'muse' | 'grok';
  /** tmux keys that interrupt the agent's current turn (Stop button). */
  interruptKeys?: string[];
  /** Typed into a live session to switch model / effort, e.g. "/model {model}". */
  switchModel?: string;
  switchEffort?: string;
  /** Typed to go back to the agent's own default model / effort, e.g. "/effort auto". */
  resetModel?: string;
  resetEffort?: string;
  /** Native TUI pickers used when a setting cannot be changed by a direct command. */
  settingsCommands?: { model?: string; effort?: string; mode?: string };
  /** argv for a model id that isn't in the list ("Other model…"), e.g. ["--model", "{model}"]. */
  modelArgs?: string[];
  /**
   * Live permission-mode switching for agents that cycle modes with a key (Claude:
   * Shift+Tab). `detect` maps mode ids to text the agent shows in its footer while
   * that mode is on; a mode with no entry is the one where none of them show.
   */
  modeCycle?: { key: string; detect: Record<string, string> };
  /**
   * GUI view: the transcript adapter that turns this agent's structured log into
   * typed events (server/feed). Agents without one are terminal-only.
   */
  feed?: string;
  /** How the agent's multiple-choice question dialog takes keys (server/choices.ts). */
  questions?: 'claude';
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
  /** Per-turn snapshots (F39): size cap per untracked file, per-session turn cap, days kept after a session ends. */
  snapshots: { enabled?: boolean; maxFileBytes: number; keepTurns: number; retentionDays: number };
  /**
   * Browser previews of a session's dev server (server/preview.ts): the ports
   * their proxies listen on and publish on the tailnet, inclusive.
   */
  preview: { ports: [number, number] };
  /** App sign-in on top of Tailscale. See server/auth.ts. */
  auth: { mode: 'passkey' | 'off'; idleHours: number; maxDays: number };
  /**
   * Native app notifications through Apple's APNs (server/apns.ts): the Apple team, the
   * .p8 signing key Apple issued, and the app's bundle id. Absent: no native push.
   */
  apns?: { teamId: string; keyId: string; keyFile: string; topic: string };
  /**
   * Uploads (server/uploads.ts), streamed to disk: one file's size, the total ah's
   * own upload folder may hold, the free space kept on the disk, and how long an
   * upload may send nothing before it's dropped. Bytes and milliseconds.
   */
  uploads: UploadLimits;
  /**
   * Moving sessions between hosts (server/migrate): where a path on another machine
   * is on this one, by prefix ({ "from": "/home/me/", "to": "/Users/me/" }).
   */
  migration: { pathMap: Array<{ from: string; to: string }> };
  /** The scheduler's limits (server/jobs): runs at once, sessions it may start an hour, retries a minute. */
  jobs: { maxConcurrent: number; maxLaunchesPerHour: number; maxRetriesPerMinute: number };
  /**
   * Keeping agents going through temporary failures (server/recovery). `auto` (off by
   * default) is the host's default; each session can switch it on or off.
   */
  recovery: RecoveryConfig;
  /**
   * Usage (server/usage): how long daily counts are kept, your prices per model id
   * (USD per million tokens, over the built-in list prices), and how each provider
   * bills you (`api`, `subscription` or `unknown`), so estimates are read rightly.
   */
  usage: UsageConfig;
  presets: Preset[];
};

// Flags below are taken from each CLI's own --help; keep them that way.
export const DEFAULT_PRESETS: Preset[] = [
  {
    id: 'shell',
    name: 'Shell',
    command: '',
    modes: [
      { id: 'default', name: 'Default shell' },
      { id: 'bash', name: 'bash', args: ['bash', '-i'] },
      { id: 'zsh', name: 'zsh', args: ['zsh', '-i'] },
      { id: 'fish', name: 'fish', args: ['fish', '-i'] },
    ],
    interruptKeys: ['C-c'],
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'plan', name: 'Plan', args: ['--permission-mode', 'plan'], description: 'Reads and plans; changes nothing until you approve the plan.' },
      { id: 'accept-edits', name: 'Accept edits', args: ['--permission-mode', 'acceptEdits'], description: 'Edits files without asking; still asks before running commands.' },
      { id: 'auto', name: 'Auto', args: ['--permission-mode', 'auto'], description: 'Routine actions run without prompts; Claude asks before anything risky.' },
      {
        id: 'dangerous',
        name: 'Skip permissions',
        args: ['--dangerously-skip-permissions'],
        dangerous: true,
        description: 'Runs any command and edits any file without asking.',
      },
    ],
    // Aliases always point at the latest model of each family.
    models: [
      { id: 'fable', name: 'Fable 5.2', args: ['--model', 'fable'], description: 'Most capable' },
      { id: 'opus', name: 'Opus 5.5', args: ['--model', 'opus'], description: 'Deep work and long tasks' },
      { id: 'sonnet', name: 'Sonnet 5.5', args: ['--model', 'sonnet'], description: 'Fast and capable' },
      { id: 'haiku', name: 'Haiku 4.5', args: ['--model', 'haiku'], description: 'Quick, lightweight tasks' },
    ],
    effort: { args: ['--effort', '{level}'], levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    catalog: 'claude',
    feed: 'claude',
    resume: 'claude --continue',
    resumeId: 'claude --resume {id}',
    match: '^claude$',
    // First run: the text-style picker, then the login method and its sub-screens
    // (the paste-a-code page is read as any agent's sign-in).
    gates: [
      { kind: 'setup', pattern: 'Choose the text style that looks best with your terminal' },
      { kind: 'signin', pattern: 'Select login method:|How do you want to sign in\\?|Using 3rd-party platforms|How do you authenticate to (?:AWS|Google Cloud)\\?' },
    ],
    // For windows without hooks: permission prompts, the question dialog's footer
    // (AskUserQuestion), and the folder-trust prompt (a picker without numbers).
    waitingPatterns: ['Do you want to (proceed|make this edit|create|allow)', '^\\s*❯\\s*1\\.\\s*Yes', 'Enter to select · .*to navigate', 'trust this folder|Enter to confirm · Esc to cancel'],
    questions: 'claude',
    trust: { pattern: 'Yes, I trust this folder', accept: '^Yes, I trust' },
    // The permission dialog highlights "Yes"; Esc declines.
    approveKeys: ['Enter'],
    denyKeys: ['Escape'],
    interruptKeys: ['Escape'],
    switchModel: '/model {model}',
    switchEffort: '/effort {level}',
    resetModel: '/model default',
    resetEffort: '/effort auto',
    settingsCommands: { model: '/model', effort: '/effort', mode: '/permissions' },
    modelArgs: ['--model', '{model}'],
    // Shift+Tab cycles Claude's permission mode (manual → accept edits → plan → auto;
    // bypass only when launched with it); its footer says which one is on.
    modeCycle: {
      key: 'BTab',
      detect: { default: 'manual mode on', 'accept-edits': 'accept edits on', plan: 'plan mode on', auto: 'auto mode on', dangerous: 'bypass permissions on' },
    },
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    modes: [
      { id: 'default', name: 'Ask' },
      {
        id: 'auto',
        name: 'Full auto',
        args: ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'],
        description: 'Runs without asking, but can only write inside the workspace.',
      },
      {
        id: 'yolo',
        name: 'Full access',
        args: ['--dangerously-bypass-approvals-and-sandbox'],
        dangerous: true,
        description: 'No approvals and no sandbox: runs any command anywhere.',
      },
    ],
    // Models and their effort levels come from Codex's own catalog (models_cache.json).
    effort: { args: ['-c', 'model_reasoning_effort={level}'], levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    catalog: 'codex',
    feed: 'codex',
    // '/model' opens the picker for model and reasoning effort; it takes no
    // direct-switch argument (the agent refuses '/model <slug>' in-conversation).
    settingsCommands: { model: '/model', effort: '/model', mode: '/permissions' },
    modelArgs: ['--model', '{model}'],
    resume: 'codex resume --last',
    resumeId: 'codex resume {id}',
    match: '^codex',
    // In a git folder: "› 1. Trust and continue" / "2. Back to Agent Command Center". Its
    // sign-in (a picker of ways in, a browser link, a device code, an API key box) is
    // read as any agent's.
    trust: { pattern: 'Trust this folder\\? Codex can', accept: '^Trust and continue' },
    waitingPatterns: ['Would you like to (run|make|apply)', 'Allow (Codex|command)', '\\(y\\)es.*\\(n\\)o'],
    approveKeys: ['y'],
    denyKeys: ['Escape'],
    interruptKeys: ['Escape'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    command: 'gemini',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'plan', name: 'Plan', args: ['--approval-mode', 'plan'], description: 'Read-only: plans without changing anything.' },
      { id: 'auto-edit', name: 'Accept edits', args: ['--approval-mode', 'auto_edit'], description: 'Edits files without asking; asks for other tools.' },
      { id: 'yolo', name: 'YOLO', args: ['--approval-mode', 'yolo'], dangerous: true, description: 'Approves every tool call automatically.' },
    ],
    modelArgs: ['--model', '{model}'],
    // '/model set <name>' switches now; bare '/model' opens the picker.
    switchModel: '/model set {model}',
    settingsCommands: { model: '/model' },
    feed: 'gemini',
    resume: 'gemini --resume latest',
    resumeId: 'gemini --resume {id}',
    match: '^gemini$',
    // A boxed radio list: "● 1. Trust folder (name)", "2. Trust parent folder", "3. Don't trust".
    trust: { pattern: 'Do you trust the files in this folder\\?', accept: '^Trust folder' },
    interruptKeys: ['Escape'],
  },
  {
    id: 'grok',
    name: 'Grok',
    command: 'grok',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'plan', name: 'Plan', args: ['--permission-mode', 'plan'], description: 'Plans without making changes.' },
      { id: 'accept-edits', name: 'Accept edits', args: ['--permission-mode', 'acceptEdits'], description: 'Edits files without asking.' },
      { id: 'auto', name: 'Auto review', args: ['--permission-mode', 'auto'], description: 'A classifier approves safe tools; dangerous ones may still prompt.' },
      { id: 'dont-ask', name: "Don't ask", args: ['--permission-mode', 'dontAsk'] },
      { id: 'bypass', name: 'Bypass permissions', args: ['--permission-mode', 'bypassPermissions'], dangerous: true, description: 'Runs anything without asking.' },
    ],
    // '/model <name>' switches (id or display name); '/effort <level>' sets effort on the current model.
    effort: { args: ['--reasoning-effort', '{level}'], levels: ['low', 'medium', 'high', 'xhigh'] },
    catalog: 'grok',
    switchModel: '/model {model}',
    switchEffort: '/effort {level}',
    settingsCommands: { model: '/model', effort: '/effort' },
    feed: 'grok',
    resume: 'grok --continue',
    resumeId: 'grok --resume {id}',
    modelArgs: ['-m', '{model}'],
    match: '^grok$',
    // Signed out it opens on a device code alone; its page is behind "click here".
    gates: [{ kind: 'signin', pattern: 'Approve in your browser to finish signing in|Select the URL below with your mouse', link: 'https://accounts.x.ai/oauth2/device?user_code={code}' }],
    // Rows with hotkeys, no cursor glyph: "Yes, proceed   y" / "No, quit   n".
    trust: { pattern: 'Do you trust the contents of this directory\\?', accept: '^Yes, proceed' },
    interruptKeys: ['Escape'],
  },
  {
    id: 'muse',
    name: 'Muse',
    command: 'muse',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'yolo', name: 'YOLO', args: ['--yolo', '--approval-mode', 'never'], dangerous: true, description: 'Disables approval and sandboxing, and trusts this workspace, for this run.' },
    ],
    effort: { args: ['--reasoning-effort', '{level}'], levels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    catalog: 'muse',
    feed: 'muse',
    // No verified direct-switch form for '/model <id>' (unlike '/effort <level>');
    // model changes go through the picker until one is confirmed live.
    switchEffort: '/effort {level}',
    settingsCommands: { model: '/models', effort: '/effort', mode: '/permissions' },
    modelArgs: ['--model', '{model}'],
    match: '^muse',
    // "Log in with browser · Enter to choose" / "Set an API key": no cursor glyph to read rows by.
    gates: [{ kind: 'signin', pattern: 'Log in with browser|^\\s*Set an API key\\s*$' }],
    // The TUI draws its own permission picker ("Would you like to allow this
    // network access?", "Yes, don't ask again this session (p)"). There are no
    // hooks, so these screen rules are what surfaces "needs you" in the inbox
    // and GUI (answered in the terminal or with one-tap keys).
    waitingPatterns: ['Would you like to allow', "don['\u2019]t ask again this session"],
    // "⟩ 1  Trust and continue" / "2  Quit": a digit picks a row.
    trust: { pattern: 'Do you trust this workspace\\?', accept: '^Trust and continue' },
    // The picker hints "(y)" for yes-once and "(esc)" for no; Enter picks the
    // highlighted row, Escape declines.
    approveKeys: ['y'],
    denyKeys: ['Escape'],
    interruptKeys: ['Escape'],
  },
  {
    id: 'hermes',
    name: 'Hermes',
    command: 'hermes',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'yolo', name: 'YOLO', args: ['--yolo'], dangerous: true, description: 'Approves every action automatically.' },
    ],
    // '/model <name> --once' switches for this session; '/reasoning <level>' sets effort.
    effort: { args: ['--reasoning', '{level}'], levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    modelArgs: ['-m', '{model}'],
    switchModel: '/model {model} --once',
    switchEffort: '/reasoning {level}',
    settingsCommands: { model: '/model', effort: '/reasoning', mode: '/approvals' },
    feed: 'hermes',
    resume: 'hermes --continue',
    resumeId: 'hermes --resume {id}',
    match: '^hermes',
    // No provider yet: "Set up a provider now? [Y/n]:", then radio lists of providers and
    // their sign-ins, read line by line (input() prompts).
    gates: [
      { kind: 'setup', pattern: 'No inference provider is configured yet|^\\s*(?:→ )?\\([●○]\\) ' },
      { kind: 'signin', pattern: 'Choose authentication method:|Starting Hermes login|\\(or Enter to cancel\\):\\s*$' },
    ],
    ready: '^Welcome to Hermes Agent!|^❯ |^(?:Login|Provider setup) (?:cancelled|succeeded|complete)',
    interruptKeys: ['Escape'],
  },
  {
    id: 'opencode',
    name: 'opencode',
    command: 'opencode',
    modelArgs: ['-m', '{model}'],
    // '/models' is a picker with no argument form, so live switching stays terminal-only.
    settingsCommands: { model: '/models' },
    feed: 'opencode',
    resume: 'opencode --continue',
    resumeId: 'opencode --session {id}',
    match: '^opencode',
    interruptKeys: ['Escape'],
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    command: 'cursor-agent',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'plan', name: 'Plan', args: ['--mode', 'plan'], description: 'Read-only: analyzes and proposes plans, no edits.' },
      { id: 'ask', name: 'Q&A', args: ['--mode', 'ask'], description: 'Read-only: explains and answers questions.' },
      { id: 'auto-review', name: 'Auto-review', args: ['--auto-review'], description: 'A classifier runs safe tool calls and asks about the rest.' },
      { id: 'force', name: 'Run everything', args: ['--force'], dangerous: true, description: 'Runs any command unless it is explicitly denied.' },
    ],
    modelArgs: ['--model', '{model}'],
    resume: 'cursor-agent --continue',
    resumeId: 'cursor-agent --resume {id}',
    match: '^cursor-agent$',
    gates: [{ kind: 'signin', pattern: 'Press any key to log in|Signing in with the browser|Scan this QR code to log in' }],
    interruptKeys: ['Escape'],
  },
  {
    id: 'copilot',
    name: 'Copilot',
    command: 'copilot',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'allow-all', name: 'Allow all tools', args: ['--allow-all-tools'], dangerous: true, description: 'Runs every tool without asking.' },
    ],
    effort: { args: ['--reasoning-effort', '{level}'], levels: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    models: [{ id: 'auto', name: 'Auto', args: ['--model', 'auto'], description: 'Copilot picks the model' }],
    modelArgs: ['--model', '{model}'],
    resume: 'copilot --continue',
    resumeId: 'copilot --resume {id}',
    match: '^copilot$',
    // A boxed numbered list: "❯ 1. Yes", "2. Yes, and remember this folder…", "3. No (Esc)".
    trust: { pattern: 'Confirm folder trust', accept: '^Yes$' },
    // /login: which account, then browser (back to 127.0.0.1) or a device code.
    gates: [{ kind: 'signin', pattern: 'What account do you want to log into\\?' }],
    interruptKeys: ['Escape'],
  },
  {
    id: 'crush',
    name: 'Crush',
    command: 'crush',
    modes: [
      { id: 'default', name: 'Ask' },
      { id: 'yolo', name: 'YOLO', args: ['--yolo'], dangerous: true, description: 'Accepts every permission automatically.' },
    ],
    resume: 'crush --continue',
    resumeId: 'crush --session {id}',
    match: '^crush$',
    // First run: choose a provider and model ("↑/↓ choose • enter confirm"), then its sign-in.
    gates: [{ kind: 'setup', pattern: '↑/↓ choose • enter confirm' }],
    interruptKeys: ['Escape'],
  },
  {
    id: 'pi',
    name: 'pi',
    command: 'pi',
    effort: { args: ['--thinking', '{level}'], levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] },
    modelArgs: ['--model', '{model}'],
    resume: 'pi --continue',
    resumeId: 'pi --session {id}',
    match: '^pi$',
    // /login, drawn above pi's own status bar: methods, providers, then a link, a code or a box.
    gates: [{ kind: 'signin', pattern: 'Select authentication method:|Select provider to configure:|Select .{1,40} login method:|^\\s*Login to \\S|Complete login in your browser' }],
    interruptKeys: ['Escape'],
  },
];

export const CONFIG_PATH = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'ah', 'config.json');

export function loadConfig(): Config {
  let user: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as (Partial<Config> & { recipes?: unknown }) | null;
      if (parsed && typeof parsed === 'object') {
        delete parsed.recipes;
        user = parsed;
      }
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
    snapshots: { maxFileBytes: 10 * 1024 * 1024, keepTurns: 50, retentionDays: 7, ...user.snapshots },
    preview: { ports: [47600, 47699], ...user.preview },
    uploads: uploadLimits(user.uploads),
    jobs: jobLimits(user.jobs),
    recovery: recoveryConfig(user.recovery),
    usage: {
      retentionDays: typeof user.usage?.retentionDays === 'number' && user.usage.retentionDays >= 1 ? Math.floor(user.usage.retentionDays) : DEFAULT_USAGE.retentionDays,
      prices: user.usage?.prices && typeof user.usage.prices === 'object' ? user.usage.prices : {},
      billing: user.usage?.billing && typeof user.usage.billing === 'object' ? user.usage.billing : {},
    },
    migration: { pathMap: Array.isArray(user.migration?.pathMap) ? user.migration.pathMap.filter((r) => typeof r?.from === 'string' && typeof r?.to === 'string' && r.from.startsWith('/') && r.to.startsWith('/')) : [] },
    presets: user.presets ?? DEFAULT_PRESETS,
  };
}

function recoveryConfig(user: Partial<RecoveryConfig> | undefined): RecoveryConfig {
  const out = { ...DEFAULT_RECOVERY };
  if (typeof user?.auto === 'boolean') out.auto = user.auto;
  if (typeof user?.prompt === 'string' && user.prompt.trim()) out.prompt = user.prompt.trim().slice(0, 2000);
  for (const k of ['maxAttempts', 'backoffSeconds', 'maxBackoffSeconds', 'jitterSeconds', 'maxActionsPerMinute'] as const) {
    const v = user?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}

function jobLimits(user: Partial<Config['jobs']> | undefined): Config['jobs'] {
  const out = { maxConcurrent: 3, maxLaunchesPerHour: 20, maxRetriesPerMinute: 10 };
  for (const k of Object.keys(out) as Array<keyof typeof out>) {
    const v = user?.[k];
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

/** Configured upload limits over the defaults; a value that isn't a positive number keeps the default. */
function uploadLimits(user: Partial<UploadLimits> | undefined): UploadLimits {
  const out = { ...DEFAULT_UPLOAD_LIMITS };
  for (const k of Object.keys(out) as Array<keyof UploadLimits>) {
    const v = user?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
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
