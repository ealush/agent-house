import { readFileSync, existsSync, accessSync, constants } from 'node:fs';
import { DEFAULT_USAGE, type UsageConfig } from './usage/settings.ts';
import { DEFAULT_RECOVERY, type RecoveryConfig } from './recovery/settings.ts';
import { reviveConfig, type ReviveConfig } from './revive/settings.ts';
import { DEFAULT_SPACES, type SpacesConfig } from './spaces/settings.ts';
import { DEFAULT_CHECKOUTS, type CheckoutsConfig } from './checkouts/settings.ts';
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
  /**
   * Opens conversation `{id}` as a new conversation of the agent's own, in the current
   * directory (Codex: `codex fork`). A fork runs this in its worktree and adopts the
   * conversation the agent makes; without it ah copies the transcript (server/fork.ts).
   */
  fork?: string;
  /** Regex tested against the basenames of running processes' argv[0]/argv[1]. */
  match?: string;
  /**
   * Terminal rules for agents without hooks: regexes (multiline) tested against the last
   * screen lines of a quiet window. A match means "waiting for you". Keep them tight —
   * a false "needs you" is worse than a missed one.
   */
  waitingPatterns?: string[];
  /**
   * For agents without hooks: a regex tested against the screen's last line, matching only
   * while a turn runs (agy's "esc to cancel" footer). Without it there, the agent is at its
   * prompt, and a shell still under it is a background task it left running (a dev server,
   * a demo host), not a tool its turn is waiting on.
   */
  turnFooter?: string;
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
  catalog?: 'claude' | 'codex' | 'muse' | 'grok' | 'agy';
  /** tmux keys that interrupt the agent's current turn (Stop button). */
  interruptKeys?: string[];
  /**
   * Typed into a live session to switch model / effort, e.g. "/model {model}". A model
   * template may also hold `{effort}` where the agent names both in one id (see
   * modelSwitch in server/launch.ts).
   */
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
  modeCycle?: {
    key: string;
    detect: Record<string, string>;
    /**
     * The mode a footer that names none means, told by `footer` (multiline regex) being
     * on screen: agy names every mode but Ask. Without it, a footer that names no mode
     * reads as "not showing its mode".
     */
    unnamed?: { mode: string; footer: string };
    /**
     * Regexes for the empty prompt box's hint, by mode, read when the footer names none:
     * agy drops the mode from a footer too narrow for it (a phone), never from the hint.
     */
    prompt?: Record<string, string>;
  };
  /**
   * GUI view: the transcript adapter that turns this agent's structured log into
   * typed events (server/feed). Agents without one are terminal-only.
   */
  feed?: string;
  /** How the agent's multiple-choice question dialog takes keys (server/choices.ts). */
  questions?: 'claude';
  /**
   * Declarative Space context injection flags (verified against each CLI's `--help`):
   * - `addDirArgs`: adds the Space context directory (preferences, memory/, artifacts/) to the workspace when different from `cwd`
   *   (`{dir}`, or `{tomlDir}`: the same as a TOML string).
   * - `promptArgs`: appends a compact Space pointer to the system prompt / rules.
   */
  spaceContext?: {
    addDirArgs?: string[];
    promptArgs?: string[];
  };
  /**
   * Declarative MCP injection flags for Agent House's built-in stdio MCP server (`ah mcp`):
   * - `configArgs`: JSON config file flag (`--mcp-config {configFile}`).
   * - `allowToolsArgs`: optional tool allowlist (`--allowedTools mcp__ah__*`).
   * - `inlineArgs`: inline TOML config overrides (Codex `-c mcp_servers.ah.*=...`).
   */
  mcp?: {
    configArgs?: string[];
    allowToolsArgs?: string[];
    inlineArgs?: string[];
  };
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
   * keys and all) — a deliberate choice, not a default. `media`: folders the media
   * viewers may also stream pictures, video and sound from (those types only, read-only);
   * ~/Pictures, ~/Videos and ~/Music by default. `artifacts`: where the agents keep what they
   * make for you outside the project (Gemini's ~/.gemini/antigravity-cli/brain, Claude's
   * ~/.claude/plans): a file there that an agent links opens or downloads, read-only, any type.
   */
  files: { roots: string[]; media: string[]; artifacts: string[] };
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
   * Sessions a tmux server stop or a host restart cut off (CND-8) come back by themselves,
   * paced, mid-turn ones first (server/revive.ts). `autoRestore: false` leaves them to you.
   */
  interruptions: ReviveConfig;
  /**
   * Usage (server/usage): how long daily counts are kept, your prices per model id
   * (USD per million tokens, over the built-in list prices), and how each provider
   * bills you (`api`, `subscription` or `unknown`), so estimates are read rightly.
   */
  usage: UsageConfig;
  /** Spaces (server/spaces): where plain Spaces are made. `~/spaces` unless set. */
  spaces: SpacesConfig;
  /** Checkouts (server/checkouts): automatic worktree isolation, port allocation, and GC policy. */
  checkouts: CheckoutsConfig;
  /**
   * Sessions' source control state in lists (server/scm.ts): uncommitted changes, and the
   * branch's pull request and its checks (through `gh`). `false` reads none and shows none.
   */
  sourceControl: boolean;
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
    spaceContext: {
      addDirArgs: ['--add-dir', '{dir}'],
      promptArgs: ['--append-system-prompt', '{pointer}'],
    },
    mcp: {
      configArgs: ['--mcp-config', '{configFile}'],
      allowToolsArgs: ['--allowedTools', 'mcp__ah__*'],
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
    // Codex keeps its threads in a store of its own (0.157+): a rollout file ah copies in
    // isn't one it finds, so it forks the thread itself. `tui.resume_cwd` answers its
    // "Working directory · fork" picker (the session's folder or this one) with this one,
    // the fork's worktree.
    fork: `codex fork {id} -c 'tui.resume_cwd="current"'`,
    match: '^codex',
    // In a git folder: "› 1. Trust and continue" / "2. Back to Agent Command Center". Its
    // sign-in (a picker of ways in, a browser link, a device code, an API key box) is
    // read as any agent's.
    trust: { pattern: 'Trust this folder\\? Codex can', accept: '^Trust and continue' },
    waitingPatterns: ['Would you like to (run|make|apply)', 'Allow (Codex|command)', '\\(y\\)es.*\\(n\\)o'],
    approveKeys: ['y'],
    denyKeys: ['Escape'],
    interruptKeys: ['Escape'],
    spaceContext: {
      // Not `--add-dir`: in a folder it doesn't trust yet (a new checkout) Codex starts
      // read-only, and there it quits on --add-dir before it asks about the folder (0.162). A
      // writable root it applies when it can write, and skips when it can't.
      addDirArgs: ['-c', 'sandbox_workspace_write.writable_roots=[{tomlDir}]'],
      promptArgs: ['-c', 'developer_instructions={tomlPointer}'],
    },
    mcp: {
      inlineArgs: [
        '-c',
        'mcp_servers.ah.command={tomlNode}',
        '-c',
        'mcp_servers.ah.args={tomlArgs}',
        '-c',
        'mcp_servers.ah.env_vars={tomlEnvVars}',
      ],
    },
  },
  {
    id: 'gemini',
    name: 'Gemini',
    // Google's Antigravity CLI. It took over from Gemini CLI (`gemini`), which isn't tuned
    // for the Gemini 4 models and is now for Code Assist enterprise users; sessions
    // started with it no longer resume. Flags and screens from agy 1.5.14.
    command: 'agy',
    // agy starts in Auto unless its settings say otherwise (`agentMode`); --mode takes
    // accept-edits, auto and plan. Ask (agy's "default") has no flag: --settings sets it
    // for the one session, without saving.
    modes: [
      { id: 'default', name: 'Auto', args: ['--mode', 'auto'], description: 'Edits and safe commands run without asking; anything irreversible asks.' },
      { id: 'ask', name: 'Ask', args: ['--settings', '{"agentMode":""}'], description: 'Asks before edits and commands.' },
      { id: 'accept-edits', name: 'Accept edits', args: ['--mode', 'accept-edits'], description: 'Edits files without asking; asks before commands.' },
      { id: 'plan', name: 'Plan', args: ['--mode', 'plan'], description: 'Researches and plans; changes nothing.' },
      { id: 'yolo', name: 'YOLO', args: ['--dangerously-skip-permissions'], dangerous: true, description: 'Approves every tool call automatically.' },
    ],
    // Shift+Tab cycles Ask → Accept edits → Auto → Plan; the footer names every mode but Ask,
    // when it fits: on a narrow screen it's "? for shortcuts" alone (and spaces), Ask's
    // footer only when the model still shows, and the empty prompt's hint ("> Plan mode:
    // research & plan only…", Ask's bare ">") is what tells them apart.
    modeCycle: {
      key: 'BTab',
      detect: { default: 'auto · ', 'accept-edits': 'accept-edits · ', plan: 'plan · ' },
      unnamed: { mode: 'ask', footer: '^\\? for shortcuts\\s+\\S' },
      prompt: { default: '^> Auto mode: ', 'accept-edits': '^> Accept-edits mode: ', plan: '^> Plan mode: ', ask: '^>\\s*$' },
    },
    // The live list is `agy models` (catalog); these stand in when it can't be read. agy
    // names a model with its effort ("gemini-4-neon-high"); --model takes it without.
    catalog: 'agy',
    models: [
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', args: ['--model', 'gemini-4-neon'], efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon', args: ['--model', 'gemini-4-argon'], efforts: ['low', 'medium', 'high'] },
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', args: ['--model', 'gemini-4-hydrogen'], efforts: ['low', 'medium', 'high', 'xhigh'] },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', args: ['--model', 'gemini-3.8-flash'], efforts: ['low', 'medium', 'high'] },
    ],
    modelArgs: ['--model', '{model}'],
    effort: { args: ['--effort', '{level}'], levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    // "/model gemini-4-neon" alone picks whichever effort its list highlights.
    switchModel: '/model {model}-{effort}',
    switchEffort: '/effort {level}',
    settingsCommands: { model: '/model', effort: '/effort' },
    feed: 'gemini',
    resume: 'agy -c',
    resumeId: 'agy --conversation {id}',
    match: '^agy$',
    // "> Yes, I trust this folder" / "No, exit", over "↑/↓ Navigate · enter Confirm".
    trust: { pattern: 'Do you trust the contents of this project\\?', accept: '^Yes, I trust this folder' },
    gates: [
      // First run: a color scheme (its list of themes beside a preview), then the terms and
      // whether Google may use your data (a box Enter toggles). Answered in the terminal.
      { kind: 'setup', pattern: '^\\s*colorblind-friendly dark\\b', from: '^Welcome to Antigravity CLI!' },
      { kind: 'setup', pattern: 'I agree to help improve Antigravity CLI', from: '^Terms of Service & Data Use$' },
      // "Select login method:" — 1. Google OAuth, 2. Use a Google Cloud project.
      { kind: 'signin', pattern: 'You are currently not signed in\\.' },
      // Google's page hands back to antigravity.google, which shows the code to paste here.
      { kind: 'signin', pattern: 'paste the authorization code below:', from: '^\\s*Your browser should open automatically' },
    ],
    // "Requesting permission for: / echo done > out.txt / Run this command? / > 1. Yes, run command … 4. No, cancel".
    waitingPatterns: ['^\\s*Requesting permission for:', '^\\s*Run this command\\?'],
    // Its footer starts "esc to cancel" through a turn, at any width; back at its prompt it's
    // "? for shortcuts", or the model and "1 task(s) · /tasks" alone on a narrow screen.
    turnFooter: '^esc to cancel\\b',
    approveKeys: ['1'],
    denyKeys: ['Escape'],
    interruptKeys: ['Escape'],
    spaceContext: {
      addDirArgs: ['--add-dir', '{dir}'],
    },
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
    // Radio rows over a footer: a command or edit to approve ("2 (●) Yes, proceed" over
    // "2/4:select │ Tab:next option"), or its own question (over "Tab:next answer"); and a plan
    // to approve (over "… │ a:approve │ q:quit plan"). Its turn timer runs on meanwhile; the
    // picker over the footer is what says it waits.
    waitingPatterns: ['^\\s*\\d+/\\d+:select\\s', '^\\s*Tab:next answer\\b', '\\ba:approve\\s+│\\s+q:quit plan\\b'],
    interruptKeys: ['Escape'],
    spaceContext: {
      addDirArgs: ['--add-dir', '{dir}'],
      promptArgs: ['--rules', '{pointer}'],
    },
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
    // `muse resume <session-ref>` (an exact session UUID, as its transcripts name it) or the
    // most recent in this workspace. Without them a resume started a new conversation.
    resume: 'muse resume --last',
    resumeId: 'muse resume {id}',
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
    files: { roots: [...(user.projectRoots ?? ['~/code']), spacesConfig(user.spaces).root, '~/.cache/ah/uploads', '/tmp'], media: ['~/Pictures', '~/Videos', '~/Music'], artifacts: ['~/.gemini/antigravity-cli/brain', '~/.claude/plans'], ...user.files },
    promptHistory: user.promptHistory ?? 60,
    snapshots: { maxFileBytes: 10 * 1024 * 1024, keepTurns: 50, retentionDays: 7, ...user.snapshots },
    preview: { ports: [47600, 47699], ...user.preview },
    uploads: uploadLimits(user.uploads),
    jobs: jobLimits(user.jobs),
    recovery: recoveryConfig(user.recovery),
    interruptions: reviveConfig(user.interruptions),
    usage: {
      retentionDays: typeof user.usage?.retentionDays === 'number' && user.usage.retentionDays >= 1 ? Math.floor(user.usage.retentionDays) : DEFAULT_USAGE.retentionDays,
      prices: user.usage?.prices && typeof user.usage.prices === 'object' ? user.usage.prices : {},
      billing: user.usage?.billing && typeof user.usage.billing === 'object' ? user.usage.billing : {},
    },
    spaces: spacesConfig(user.spaces),
    checkouts: checkoutsConfig(user.checkouts),
    sourceControl: user.sourceControl !== false,
    migration: { pathMap: Array.isArray(user.migration?.pathMap) ? user.migration.pathMap.filter((r) => typeof r?.from === 'string' && typeof r?.to === 'string' && r.from.startsWith('/') && r.to.startsWith('/')) : [] },
    presets: user.presets ?? DEFAULT_PRESETS,
  };
}

function spacesConfig(user: Partial<SpacesConfig> | undefined): SpacesConfig {
  return { root: typeof user?.root === 'string' && user.root.trim() ? user.root.trim() : DEFAULT_SPACES.root };
}

function checkoutsConfig(user: Partial<CheckoutsConfig> | undefined): CheckoutsConfig {
  const out: CheckoutsConfig = { ...DEFAULT_CHECKOUTS, portRange: [...DEFAULT_CHECKOUTS.portRange] };
  if (typeof user?.autoIsolate === 'boolean') out.autoIsolate = user.autoIsolate;
  if (typeof user?.gcEnabled === 'boolean') out.gcEnabled = user.gcEnabled;
  for (const k of ['gcIntervalSeconds', 'mergedRetentionHours', 'unmergedRetentionDays', 'portsPerCheckout'] as const) {
    const v = user?.[k];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  if (user?.diskBudgetBytes === null) out.diskBudgetBytes = null;
  else if (typeof user?.diskBudgetBytes === 'number' && Number.isFinite(user.diskBudgetBytes) && user.diskBudgetBytes > 0) out.diskBudgetBytes = user.diskBudgetBytes;
  if (user?.minFreeBytes === null) out.minFreeBytes = null;
  else if (typeof user?.minFreeBytes === 'number' && Number.isFinite(user.minFreeBytes) && user.minFreeBytes >= 0) out.minFreeBytes = user.minFreeBytes;
  if (Array.isArray(user?.portRange) && user.portRange.length === 2 && Number.isInteger(user.portRange[0]) && Number.isInteger(user.portRange[1]) && user.portRange[0] >= 1024 && user.portRange[1] <= 65535 && user.portRange[0] < user.portRange[1]) {
    out.portRange = [user.portRange[0], user.portRange[1]];
  }
  return out;
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
