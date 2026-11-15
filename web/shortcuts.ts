// UI shortcuts for ah itself: navigation, sessions, splits. Terminal bytes
// (arrows into the pty, the touch key bar) stay in keyboard.ts.
//
// Defaults live here. A device may override them in localStorage (`ah.shortcuts.v1`).
// A chord needs Ctrl, Alt, or Super, so a plain letter still reaches the agent.
// Matching uses the character the layout produces (Colemak included), except
// digits and punctuation, which stay on the physical key so Shift does not turn
// "1" into "!" or "\" into "|".

export type Scope = 'app' | 'terminal' | 'field' | 'dialog' | 'ask';

export type Chord = {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
};

type Digit = '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';

export type CommandId =
  | `workspace-${Digit}`
  | `to-workspace-${Digit}`
  | 'command-palette'
  | 'switcher'
  | 'new-session'
  | 'new-project'
  | 'cycle-prev'
  | 'cycle-next'
  | 'toggle-sidebar'
  | 'go-inbox'
  | 'go-history'
  | 'go-review'
  | 'go-jobs'
  | 'go-usage'
  | 'go-settings'
  | 'toggle-view'
  | 'toggle-steps'
  | 'toggle-panel'
  | 'reply'
  | 'approve'
  | 'deny'
  | 'terminate'
  | 'interrupt'
  | 'send-now'
  | 'clear-queue'
  | 'rename'
  | 'fork'
  | 'send-to'
  | 'pin'
  | 'panel-diff'
  | 'panel-files'
  | 'panel-chat'
  | 'panel-queue'
  | 'panel-snapshots'
  | 'panel-preview'
  | 'panel-stack'
  | 'panel-terminal'
  | 'pick-model'
  | 'pick-effort'
  | 'copy-last'
  | 'jump-latest'
  | 'browse-messages'
  | 'scrollback'
  | 'copy-attach'
  | 'toggle-keys'
  | 'session-menu'
  | 'focus-sidebar'
  | 'focus-main'
  | 'reload-page'
  | 'split-right'
  | 'split-below'
  | 'close-pane'
  | 'focus-pane-left'
  | 'focus-pane-right'
  | 'focus-pane-up'
  | 'focus-pane-down'
  | 'move-pane-left'
  | 'move-pane-right'
  | 'move-pane-up'
  | 'move-pane-down'
  | 'toggle-split'
  | 'resize-left'
  | 'resize-right'
  | 'resize-up'
  | 'resize-down'
  | 'resize-mode'
  | 'pane-mode'
  | 'replace-pane'
  | 'open-in-pane'
  | 'scratchpad'
  | 'maximize-pane'
  | 'exit-split'
  | 'show-shortcuts'
  | 'go-search'
  | 'worktrees'
  | 'switch-branch';

export type CommandGroup = 'Navigate' | 'Session' | 'Workspace';

/** One to three extra words that find this item after matches on its own name. */
export type SearchTerms = readonly [string] | readonly [string, string] | readonly [string, string, string];

export type Command = {
  id: CommandId;
  group: CommandGroup;
  label: string;
  detail: string;
  chords: Chord[];
  /** Where the chord is allowed to steal the key. `ask` is never listed: those dialogs own the keyboard. */
  scopes: Array<Exclude<Scope, 'ask'>>;
  /**
   * In a text box the chord also edits text (Ctrl+Shift+← selects a word), so it fires
   * only when that edit has nowhere to go: the caret at the start or end, or the box empty.
   */
  field?: FieldEdge;
  /** Related words. A query that hits only these ranks under one that hits the name. */
  terms?: SearchTerms;
};

export type FieldEdge = 'start' | 'end' | 'empty';
export type FieldState = Partial<Record<FieldEdge, boolean>>;

const nav: Array<Exclude<Scope, 'ask'>> = ['app', 'terminal', 'field'];
const session: Array<Exclude<Scope, 'ask'>> = ['app', 'terminal', 'field'];
/** Ctrl+Alt chords edit nothing in a text box, so they work from the composer too. */
const act: Array<Exclude<Scope, 'ask'>> = ['app', 'terminal', 'field'];

export const COMMANDS: Command[] = [
  {
    id: 'command-palette',
    group: 'Navigate',
    label: 'Command palette',
    detail: 'Search the actions you can run right now. The binding sits on the right of each one.',
    // ⌘⇧P on a Mac, Ctrl+Shift+P elsewhere. Same letter as VS Code.
    chords: [{ key: 'p', meta: true, shift: true }, { key: 'p', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'switcher',
    group: 'Navigate',
    label: 'Search or jump',
    detail: 'Open the switcher. Also works while a text field or another dialog is open.',
    chords: [{ key: 'k', meta: true }, { key: 'k', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field', 'dialog'],
  },
  {
    id: 'cycle-prev',
    group: 'Navigate',
    label: 'Previous session',
    detail: 'The previous session in sidebar order. From the inbox, this opens the last one. Also works while a text field is focused.',
    chords: [{ key: 'ArrowUp', alt: true }],
    scopes: ['app', 'terminal', 'field'],
    // In a draft, ⌥↑ moves the caret by a paragraph on a Mac: switch only from its start.
    field: 'start',
  },
  {
    id: 'cycle-next',
    group: 'Navigate',
    label: 'Next session',
    detail: 'The next session in sidebar order. From the inbox, this opens the first one. Also works while a text field is focused.',
    chords: [{ key: 'ArrowDown', alt: true }],
    scopes: ['app', 'terminal', 'field'],
    // In a draft, ⌥↓ moves the caret by a paragraph on a Mac: switch only from its end.
    field: 'end',
  },
  {
    id: 'new-session',
    group: 'Navigate',
    label: 'New session',
    detail: 'Open the new-session dialog.',
    chords: [{ key: 'Enter', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'new-project',
    group: 'Navigate',
    label: 'New project',
    detail: 'Create a folder and start a session in it.',
    chords: [],
    scopes: nav,
  },
  {
    id: 'toggle-sidebar',
    group: 'Navigate',
    label: 'Toggle sidebar',
    detail: 'Show or hide the sidebar.',
    chords: [{ key: 'e', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'go-inbox',
    group: 'Navigate',
    label: 'Inbox',
    detail: 'Leave the session or split and show the inbox.',
    chords: [{ key: '1', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'go-history',
    group: 'Navigate',
    label: 'History',
    detail: 'Open the history page.',
    chords: [{ key: '2', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'go-review',
    group: 'Navigate',
    label: 'Review',
    detail: 'Open Review: your pull request stacks, one layer at a time.',
    chords: [{ key: '4', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'go-jobs',
    group: 'Navigate',
    label: 'Jobs',
    detail: 'Scheduled agent work, and the decisions it waits on.',
    chords: [{ key: '6', ctrl: true, shift: true }],
    scopes: nav,
    terms: ['schedule', 'cron', 'workflow'],
  },
  {
    id: 'go-usage',
    group: 'Navigate',
    label: 'Usage',
    detail: 'Tokens, limits and estimated cost, per model and conversation.',
    chords: [{ key: '7', ctrl: true, shift: true }],
    scopes: nav,
    terms: ['tokens', 'cost', 'quota'],
  },
  {
    id: 'go-search',
    group: 'Navigate',
    label: 'Search',
    detail: 'Search every conversation and side chat, on every host.',
    chords: [{ key: '5', ctrl: true, shift: true }],
    scopes: nav,
    terms: ['find', 'full text', 'transcripts'],
  },
  {
    id: 'worktrees',
    group: 'Navigate',
    label: 'Worktrees',
    detail: 'Managed worktrees: dirty, ahead, orphaned, and their size; clean up.',
    chords: [],
    scopes: nav,
    terms: ['branches', 'checkouts', 'clean'],
  },
  {
    id: 'go-settings',
    group: 'Navigate',
    label: 'Settings',
    detail: 'Open settings.',
    chords: [{ key: '3', ctrl: true, shift: true }],
    scopes: nav,
  },
  {
    id: 'focus-sidebar',
    group: 'Navigate',
    label: 'Focus the session list',
    detail: 'Move focus to the current session in the sidebar. On a phone, open the Sessions tab. Arrows move, Enter opens.',
    chords: [{ key: '0', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'focus-main',
    group: 'Navigate',
    label: 'Focus the session',
    detail: 'Back to the open session: its composer in the GUI, the terminal otherwise.',
    chords: [{ key: '9', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'reload-page',
    group: 'Navigate',
    label: 'Reload page',
    detail: 'Load the app again on this device. Sessions keep running.',
    chords: [],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'show-shortcuts',
    group: 'Navigate',
    label: 'Keyboard shortcuts',
    detail: 'Open the shortcut table.',
    chords: [{ key: '/', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'toggle-view',
    group: 'Session',
    label: 'GUI or terminal',
    detail: 'Switch the focused session between the terminal and the transcript GUI.',
    chords: [{ key: 'g', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'panel-terminal',
    group: 'Session',
    label: 'Terminal',
    detail: 'Open this session’s attached shell. It stays running when hidden.',
    chords: [],
    scopes: session,
  },
  {
    id: 'toggle-steps',
    group: 'Session',
    label: 'Hide / show steps',
    detail: 'In the GUI, fold tool calls and thinking to one line per run, so the conversation reads as prose. Applies to every session on this device.',
    chords: [{ key: 'h', ctrl: true, alt: true }],
    scopes: act,
    terms: ['tool calls', 'collapse', 'thinking'],
  },
  {
    id: 'toggle-panel',
    group: 'Session',
    label: 'Toggle side panel',
    detail: 'Show or hide the session side panel.',
    // J, not P: Ctrl+Shift+P opens the command palette.
    chords: [{ key: 'j', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'reply',
    group: 'Session',
    label: 'Reply',
    detail: 'Focus the composer, or the terminal when that is the current view.',
    chords: [{ key: 'r', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'approve',
    group: 'Session',
    label: 'Approve',
    detail: 'Approve the prompt on the focused session, when it is waiting for one.',
    chords: [{ key: 'Enter', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'deny',
    group: 'Session',
    label: 'Deny',
    detail: 'Deny the prompt on the focused session, when it is waiting for one.',
    chords: [{ key: 'Backspace', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'interrupt',
    group: 'Session',
    label: 'Stop the turn',
    detail: 'Interrupt what the agent is doing right now (Esc in its terminal). In the GUI, Esc in an empty composer does the same.',
    chords: [{ key: 'x', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'send-now',
    group: 'Session',
    label: 'Send next queued now',
    detail: 'Stop the current turn and deliver the oldest queued follow-up right away.',
    chords: [{ key: 's', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'clear-queue',
    group: 'Session',
    label: 'Cancel all queued',
    detail: 'Drop every follow-up waiting for this session.',
    chords: [],
    scopes: act,
  },
  {
    id: 'pick-model',
    group: 'Session',
    label: 'Switch model',
    detail: 'Open the model picker for this session.',
    chords: [{ key: 'm', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'pick-effort',
    group: 'Session',
    label: 'Switch reasoning effort',
    detail: 'Open the effort picker for this session.',
    chords: [{ key: 'e', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'copy-last',
    group: 'Session',
    label: "Copy the agent's last reply",
    detail: 'Copy the newest agent message as text (GUI view).',
    chords: [{ key: 'c', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'jump-latest',
    group: 'Session',
    label: 'Jump to latest',
    detail: 'Scroll the conversation to its newest message.',
    chords: [{ key: 'End', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'browse-messages',
    group: 'Session',
    label: 'Browse messages',
    detail: 'Put the keyboard on the newest message (GUI): ↑↓ or j/k move, c copies, r restores the files to before it, Esc returns to the composer.',
    chords: [{ key: 'b', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'switch-branch',
    group: 'Session',
    label: 'Switch branch…',
    detail: "Switch the session's checkout to another branch, or create one.",
    chords: [],
    scopes: session,
    terms: ['git', 'checkout'],
  },
  {
    id: 'rename',
    group: 'Session',
    label: 'Rename session',
    detail: 'Edit the session name in place. Enter saves, Escape cancels.',
    chords: [{ key: 'n', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'fork',
    group: 'Session',
    label: 'Fork session…',
    detail: 'Copy this conversation into a new session on its own worktree.',
    chords: [{ key: 'f', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'send-to',
    group: 'Session',
    label: 'Send to…',
    detail: 'Hand a summary and the last reply to another session or a new one.',
    chords: [{ key: 't', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'pin',
    group: 'Session',
    label: 'Pin',
    detail: 'Keep the session at the top of its group, on every device; again to unpin.',
    chords: [],
    scopes: act,
  },
  {
    id: 'panel-diff',
    group: 'Session',
    label: 'Diff',
    detail: 'Show the git changes beside the session. Again to close.',
    chords: [{ key: '1', ctrl: true, alt: true }],
    scopes: act,
    terms: ['panel'],
  },
  {
    id: 'panel-files',
    group: 'Session',
    label: 'Files',
    detail: 'Browse files beside the session. Again to close.',
    chords: [{ key: '2', ctrl: true, alt: true }],
    scopes: act,
    terms: ['panel'],
  },
  {
    id: 'panel-chat',
    group: 'Session',
    label: 'Chat',
    detail: 'Discuss this work with another model. Again to close.',
    chords: [{ key: '3', ctrl: true, alt: true }],
    scopes: act,
    terms: ['panel'],
  },
  {
    id: 'panel-queue',
    group: 'Session',
    label: 'Queue',
    detail: 'Review, send or cancel queued follow-ups. Again to close.',
    chords: [{ key: '4', ctrl: true, alt: true }],
    scopes: act,
    terms: ['panel'],
  },
  {
    id: 'panel-snapshots',
    group: 'Session',
    label: 'Snapshots',
    detail: 'Per-turn snapshots and restore. Again to close.',
    chords: [{ key: '5', ctrl: true, alt: true }],
    scopes: act,
    terms: ['panel'],
  },
  {
    id: 'panel-preview',
    group: 'Session',
    label: 'Preview',
    detail: 'A dev server running in this session (Storybook, Vite…), in a browser pane served from the host. Again to close.',
    terms: ['browser', 'storybook', 'panel'],
    chords: [{ key: '6', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'panel-stack',
    group: 'Session',
    label: 'Stack',
    detail: 'The stack this session is building: its branches bottom to top, each with its pull request, and Review. Again to close.',
    terms: ['review', 'pull requests', 'gh stack'],
    chords: [{ key: '7', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'session-menu',
    group: 'Session',
    label: 'Session menu',
    detail: 'Open the session menu; arrows move, Enter runs, Escape closes.',
    chords: [{ key: '.', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'scrollback',
    group: 'Session',
    label: 'Scrollback as text',
    detail: "The terminal's scrollback as selectable, copyable text.",
    chords: [],
    scopes: act,
  },
  {
    id: 'copy-attach',
    group: 'Session',
    label: 'Copy attach command',
    detail: 'Copy “ah attach <id>” to open this session from a terminal.',
    chords: [],
    scopes: act,
  },
  {
    id: 'toggle-keys',
    group: 'Session',
    label: 'Show or hide on-screen keys',
    detail: 'The Esc / Tab / arrows / Ctrl key bar under the terminal.',
    // K for the key bar. Ctrl+Alt still fires from the terminal and a text field.
    chords: [{ key: 'k', ctrl: true, alt: true }],
    scopes: act,
  },
  {
    id: 'terminate',
    group: 'Session',
    label: 'Terminate session',
    detail: 'Stop the focused session. Asks for confirmation first.',
    chords: [],
    scopes: act,
  },
  {
    id: 'split-right',
    group: 'Workspace',
    label: 'Split right',
    detail: 'Open another session to the right of the focused one.',
    terms: ['pane'],
    chords: [{ key: '\\', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'split-below',
    group: 'Workspace',
    label: 'Split below',
    detail: 'Open another session below the focused one.',
    terms: ['pane'],
    chords: [{ key: '-', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'close-pane',
    group: 'Workspace',
    label: 'Close pane',
    detail: 'Close the focused pane, or the current tab on a narrow screen, without stopping the session.',
    chords: [{ key: 'Backspace', ctrl: true, shift: true }],
    scopes: session,
    field: 'empty',
  },
  {
    id: 'focus-pane-left',
    group: 'Workspace',
    label: 'Pane left',
    detail: 'Move to the pane on the left. On a narrow screen this switches tabs.',
    chords: [{ key: 'ArrowLeft', ctrl: true, shift: true }],
    scopes: session,
    field: 'start',
  },
  {
    id: 'focus-pane-right',
    group: 'Workspace',
    label: 'Pane right',
    detail: 'Move to the pane on the right. On a narrow screen this switches tabs.',
    chords: [{ key: 'ArrowRight', ctrl: true, shift: true }],
    scopes: session,
    field: 'end',
  },
  {
    id: 'focus-pane-up',
    group: 'Workspace',
    label: 'Pane up',
    detail: 'Move to the pane above. On a narrow screen this switches tabs.',
    chords: [{ key: 'ArrowUp', ctrl: true, shift: true }],
    scopes: session,
    field: 'start',
  },
  {
    id: 'focus-pane-down',
    group: 'Workspace',
    label: 'Pane down',
    detail: 'Move to the pane below. On a narrow screen this switches tabs.',
    chords: [{ key: 'ArrowDown', ctrl: true, shift: true }],
    scopes: session,
    field: 'end',
  },
  {
    id: 'move-pane-left',
    group: 'Workspace',
    label: 'Move pane left',
    detail: 'Move the focused pane left. At the edge of its split, it spans the column beyond.',
    chords: [{ key: 'ArrowLeft', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'move-pane-right',
    group: 'Workspace',
    label: 'Move pane right',
    detail: 'Move the focused pane right. At the edge of its split, it spans the column beyond.',
    chords: [{ key: 'ArrowRight', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'move-pane-up',
    group: 'Workspace',
    label: 'Move pane up',
    detail: 'Move the focused pane up. At the edge of its split, it spans the row beyond.',
    chords: [{ key: 'ArrowUp', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'move-pane-down',
    group: 'Workspace',
    label: 'Move pane down',
    detail: 'Move the focused pane down. At the edge of its split, it spans the row beyond.',
    chords: [{ key: 'ArrowDown', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'toggle-split',
    group: 'Workspace',
    label: 'Flip split',
    detail: 'Turn the split around the focused pane the other way, side by side or stacked.',
    chords: [{ key: 'j', ctrl: true, alt: true }],
    scopes: session,
  },
  {
    id: 'resize-left',
    group: 'Workspace',
    label: 'Resize: divider left',
    detail: 'Move the divider beside the focused pane left. With no split, widen the side panel.',
    chords: [{ key: 'ArrowLeft', ctrl: true, shift: true, alt: true }],
    scopes: session,
  },
  {
    id: 'resize-right',
    group: 'Workspace',
    label: 'Resize: divider right',
    detail: 'Move the divider beside the focused pane right. With no split, narrow the side panel.',
    chords: [{ key: 'ArrowRight', ctrl: true, shift: true, alt: true }],
    scopes: session,
  },
  {
    id: 'resize-up',
    group: 'Workspace',
    label: 'Resize: divider up',
    detail: 'Move the divider above or below the focused pane up.',
    chords: [{ key: 'ArrowUp', ctrl: true, shift: true, alt: true }],
    scopes: session,
  },
  {
    id: 'resize-down',
    group: 'Workspace',
    label: 'Resize: divider down',
    detail: 'Move the divider above or below the focused pane down.',
    chords: [{ key: 'ArrowDown', ctrl: true, shift: true, alt: true }],
    scopes: session,
  },
  {
    id: 'resize-mode',
    group: 'Workspace',
    label: 'Resize mode',
    detail: 'Like a Hyprland submap: arrows move the nearest divider (Shift for big steps) until Escape or Enter.',
    chords: [{ key: 'r', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'pane-mode',
    group: 'Workspace',
    label: 'Pane mode',
    detail: 'A Hyprland-style submap: h j k l (or arrows) focus, Shift moves, v / s split, x closes, f maximizes, t flips, r resizes, 1–9 go to a workspace (Shift sends), o opens a session as a new pane, Esc leaves.',
    chords: [{ key: ' ', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'replace-pane',
    group: 'Workspace',
    label: 'Replace pane…',
    detail: 'Choose another session, a new shell, or a new session for the focused pane, inside the pane. Esc keeps what was there.',
    chords: [{ key: 'p', ctrl: true, alt: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'open-in-pane',
    group: 'Workspace',
    label: 'Open a session as a new pane…',
    detail: 'Pick a session; it opens beside the focused pane, split along its longer side.',
    chords: [{ key: 'o', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'scratchpad',
    group: 'Workspace',
    label: 'Scratchpad shell',
    detail: "Show or hide a floating shell over anything, like Hyprland's special workspace. It keeps running while hidden.",
    chords: [{ key: '`', ctrl: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  },
  {
    id: 'maximize-pane',
    group: 'Workspace',
    label: 'Maximize pane',
    detail: 'Show the focused pane alone, like Hyprland fullscreen. Again to bring the split back.',
    chords: [{ key: 'f', ctrl: true, shift: true }],
    scopes: session,
  },
  {
    id: 'exit-split',
    group: 'Workspace',
    label: 'Exit split',
    detail: 'Leave split view and close every pane. Sessions keep running.',
    chords: [],
    scopes: session,
  },
];

// Workspaces 1–9, Hyprland-style: Alt+N goes there, Alt+Shift+N sends the focused session.
const DIGITS: Digit[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
for (const d of DIGITS) {
  COMMANDS.push({
    id: `workspace-${d}`,
    group: 'Workspace',
    label: `Workspace ${d}`,
    detail: `Go to workspace ${d}. What you leave is kept there: its split, or its session.`,
    chords: [{ key: d, alt: true }],
    scopes: ['app', 'terminal', 'field'],
  });
}
for (const d of DIGITS) {
  COMMANDS.push({
    id: `to-workspace-${d}`,
    group: 'Workspace',
    label: `Send to workspace ${d}`,
    detail: `Move the focused session to workspace ${d}, as a new tile beside what is there.`,
    chords: [{ key: d, alt: true, shift: true }],
    scopes: ['app', 'terminal', 'field'],
  });
}

const BY_ID = new Map(COMMANDS.map((c) => [c.id, c]));

/** Shifted glyphs we still want to name as the unshifted key. */
const CODE_CHAR: Record<string, string> = {
  Backslash: '\\',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
};

export function eventKey(e: { key: string; code: string }): string {
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (CODE_CHAR[e.code] && e.key.length === 1) return CODE_CHAR[e.code];
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

export function chordFromEvent(e: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): Chord | null {
  if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return null;
  return {
    key: eventKey(e),
    meta: e.metaKey || undefined,
    ctrl: e.ctrlKey || undefined,
    alt: e.altKey || undefined,
    shift: e.shiftKey || undefined,
  };
}

export function chordUsable(c: Chord): boolean {
  return !!(c.meta || c.ctrl || c.alt);
}

export function chordsEqual(a: Chord, b: Chord): boolean {
  return a.key === b.key && !!a.meta === !!b.meta && !!a.ctrl === !!b.ctrl && !!a.alt === !!b.alt && !!a.shift === !!b.shift;
}

export type Overrides = Partial<Record<CommandId, Chord[] | null>>;

function parseChord(value: unknown): Chord | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== 'string' || !v.key) return null;
  const chord: Chord = { key: v.key };
  if (v.meta === true) chord.meta = true;
  if (v.ctrl === true) chord.ctrl = true;
  if (v.alt === true) chord.alt = true;
  if (v.shift === true) chord.shift = true;
  return chord;
}

/** Parse a stored override blob. Unknown ids and bare-key chords are dropped. */
export function readOverrides(raw: string | null): Overrides {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== 'object') return {};
  const out: Overrides = {};
  for (const cmd of COMMANDS) {
    if (!Object.prototype.hasOwnProperty.call(data, cmd.id)) continue;
    const value = (data as Record<string, unknown>)[cmd.id];
    if (value === null) {
      out[cmd.id] = null;
      continue;
    }
    if (!Array.isArray(value)) continue;
    out[cmd.id] = value.map(parseChord).filter((c): c is Chord => !!c && chordUsable(c));
  }
  return out;
}

export function resolveChords(id: CommandId, overrides: Overrides = {}): Chord[] {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) return overrides[id] ?? [];
  return BY_ID.get(id)?.chords ?? [];
}

export function matchShortcut(
  e: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  scope: Scope,
  overrides: Overrides = {},
  field: FieldState = {},
): CommandId | null {
  if (scope === 'ask') return null;
  const chord = chordFromEvent(e);
  if (!chord || !chordUsable(chord)) return null;
  for (const cmd of COMMANDS) {
    if (!cmd.scopes.includes(scope)) continue;
    if (scope === 'field' && cmd.field && !field[cmd.field]) continue;
    if (resolveChords(cmd.id, overrides).some((c) => chordsEqual(c, chord))) return cmd.id;
  }
  return null;
}

const FIELD_WHEN: Record<FieldEdge, string> = {
  start: 'only from the start of the text',
  end: 'only from the end of the text',
  empty: 'only in an empty box',
};

/** Short "when" clause for the shortcut table. Confirm dialogs always own the keyboard. */
export function whenLabel(id: CommandId): string {
  const scopes = BY_ID.get(id)?.scopes ?? [];
  const has = (s: Exclude<Scope, 'ask'>) => scopes.includes(s);
  const edge = BY_ID.get(id)?.field;
  if (edge) return `Not in a dialog; while typing, ${FIELD_WHEN[edge]}`;
  if (has('dialog') && has('field')) return 'Anywhere except a confirm';
  if (has('field')) return 'Not in a dialog';
  return 'Not while typing or in a dialog';
}

export function hintChord(id: CommandId, mac: boolean, overrides: Overrides = {}): Chord | null {
  const chords = resolveChords(id, overrides);
  if (!chords.length) return null;
  return chords.find((c) => (mac ? !!c.meta : !c.meta)) ?? chords[0];
}

const KEY_LABEL: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Backspace: '⌫',
  Escape: 'Esc',
  ' ': 'Space',
};

/** The keys a Mac draws as glyphs in its menus (Return ↩, Delete ⌫, Tab ⇥). */
const MAC_KEY: Record<string, string> = { Enter: '↩', Backspace: '⌫', Tab: '⇥' };

/** Return as this platform draws it: ↩ on a Mac, ↵ elsewhere. */
export const returnKey = (mac = isMac()) => (mac ? '↩' : '↵');

export function formatChord(c: Chord, mac: boolean): string {
  const key = (mac && MAC_KEY[c.key]) || KEY_LABEL[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key);
  // Apple's order: ⌃ ⌥ ⇧ ⌘.
  if (mac) return `${c.ctrl ? '⌃' : ''}${c.alt ? '⌥' : ''}${c.shift ? '⇧' : ''}${c.meta ? '⌘' : ''}${key}`;
  const parts: string[] = [];
  if (c.ctrl) parts.push('Ctrl');
  if (c.alt) parts.push('Alt');
  if (c.shift) parts.push('Shift');
  if (c.meta) parts.push('Super');
  parts.push(key);
  return parts.join('+');
}

/** One label per key: off a Mac in the order VS Code draws a chord (Ctrl, Shift, Alt, Super), on a
 *  Mac in Apple's (⌃ ⌥ ⇧ ⌘) with its glyphs for Return, Delete and Tab; then the key. */
const PART_LABEL: Record<string, string> = {
  ...KEY_LABEL,
  Enter: '↵',
  Backspace: 'Backspace',
  Tab: 'Tab',
};

/** A modifier as a keycap shows it: Apple's glyphs on a Mac, its printed name elsewhere (as on the key itself). */
export function modLabel(mod: 'ctrl' | 'shift' | 'alt' | 'meta', mac = isMac()): string {
  return mac ? { ctrl: '⌃', shift: '⇧', alt: '⌥', meta: '⌘' }[mod] : { ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', meta: 'Super' }[mod];
}

export function chordParts(c: Chord, mac = isMac()): string[] {
  const order = mac ? (['ctrl', 'alt', 'shift', 'meta'] as const) : (['ctrl', 'shift', 'alt', 'meta'] as const);
  const parts: string[] = order.filter((m) => c[m]).map((m) => modLabel(m, mac));
  parts.push((mac && MAC_KEY[c.key]) || PART_LABEL[c.key] || (c.key.length === 1 ? c.key.toUpperCase() : c.key));
  return parts;
}

export function bindingError(id: CommandId, chord: Chord, overrides: Overrides, mac = false): string | null {
  if (!chordUsable(chord)) return 'Use Ctrl, Alt, or Super together with another key.';
  for (const cmd of COMMANDS) {
    if (cmd.id === id) continue;
    if (resolveChords(cmd.id, overrides).some((c) => chordsEqual(c, chord))) return `${formatChord(chord, mac)} is already ${cmd.label}.`;
  }
  return null;
}

export function isMac(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const STORAGE_KEY = 'ah.shortcuts.v1';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadOverrides(): Overrides {
  return readOverrides(storage()?.getItem(STORAGE_KEY) ?? null);
}

const listeners = new Set<() => void>();

export function subscribeShortcuts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function writeOverrides(next: Overrides) {
  const store = storage();
  if (!store) return;
  try {
    if (Object.keys(next).length) store.setItem(STORAGE_KEY, JSON.stringify(next));
    else store.removeItem(STORAGE_KEY);
  } catch {
    // Private mode and full disks keep the defaults.
  }
  listeners.forEach((fn) => fn());
}

/**
 * Bind `chords` on this device. `null` unbinds the command. Picking any default
 * chord clears the override, so both defaults (⌘K and Ctrl+Shift+K) come back.
 * Returns an error string and changes nothing when the chord is illegal or taken.
 */
export function setOverride(id: CommandId, chords: Chord[] | null): string | null {
  const chord = chords?.[0] ?? null;
  const current = loadOverrides();
  if (chord) {
    const error = bindingError(id, chord, current, isMac());
    if (error) return error;
  }
  const next: Overrides = { ...current };
  const def = BY_ID.get(id)?.chords ?? [];
  if (!chord) next[id] = null;
  else if (def.some((c) => chordsEqual(c, chord))) delete next[id];
  else next[id] = [chord];
  writeOverrides(next);
  return null;
}

export function resetOverride(id: CommandId) {
  const next = { ...loadOverrides() };
  delete next[id];
  writeOverrides(next);
}

export function resetAllOverrides() {
  writeOverrides({});
}

export function isOverridden(id: CommandId, overrides: Overrides = loadOverrides()): boolean {
  return Object.prototype.hasOwnProperty.call(overrides, id);
}

export function shortcutContext(target: EventTarget | null, root: { querySelector(sel: string): unknown } | null = typeof document === 'undefined' ? null : document): Scope {
  if (root?.querySelector('dialog.ask[open]')) return 'ask';
  if (root?.querySelector('dialog[open]')) return 'dialog';
  const candidate = target as unknown as { closest?: (sel: string) => unknown } | null;
  if (candidate && typeof candidate.closest === 'function') {
    if (candidate.closest('.xterm')) return 'terminal';
    if (candidate.closest('input, textarea, select, [contenteditable="true"]')) return 'field';
  }
  return 'app';
}

/** Where the caret sits in a text box, for chords that edit text there too. */
export function fieldState(target: EventTarget | null): FieldState {
  const el = target as { value?: unknown; selectionStart?: number | null; selectionEnd?: number | null; textContent?: string | null } | null;
  if (!el) return {};
  if (typeof el.value !== 'string') return { empty: !el.textContent?.trim() };
  const empty = el.value === '';
  // Inputs like number and email have no selection API; only an empty one is safe.
  if (el.selectionStart == null || el.selectionEnd == null) return { empty, start: empty, end: empty };
  const collapsed = el.selectionStart === el.selectionEnd;
  return { empty, start: collapsed && el.selectionStart === 0, end: collapsed && el.selectionEnd === el.value.length };
}

type Handler = () => void;
const handlers = new Map<CommandId, Set<Handler>>();

export function registerCommand(id: CommandId, fn: Handler): () => void {
  let set = handlers.get(id);
  if (!set) handlers.set(id, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

/** True when a mounted view is listening, so the action can run right now. */
export function commandActive(id: CommandId): boolean {
  return (handlers.get(id)?.size ?? 0) > 0;
}

/** Subsequence score. Contiguous runs and word starts count more. Zero when a character is missing. */
export function fuzzy(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let s = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    run = found === ti ? run + 1 : 1;
    s += run + (found === 0 || /[\s/+·:_-]/.test(t[found - 1] ?? '') ? 3 : 0);
    ti = found + 1;
  }
  return s;
}

/**
 * Commands the palette can offer. The palette itself is left out.
 * An empty query keeps catalog order. A query ranks the label, the group, and the recorded binding.
 * The long detail counts only when it contains the query as a phrase, so a short word does not match every description.
 */
export function searchCommands(query: string, opts: { active?: (id: CommandId) => boolean; mac?: boolean; overrides?: Overrides } = {}): Command[] {
  const active = opts.active ?? commandActive;
  const mac = opts.mac ?? false;
  const overrides = opts.overrides ?? {};
  const q = query.trim().toLowerCase();
  const hits = COMMANDS.filter((cmd) => cmd.id !== 'command-palette' && active(cmd.id)).map((cmd) => {
    if (!q) return { cmd, s: 1 };
    const chords = resolveChords(cmd.id, overrides).map((c) => formatChord(c, mac));
    const chordScore = chords.reduce((best, chord) => Math.max(best, fuzzy(q, chord)), 0);
    const detail = cmd.detail.toLowerCase().includes(q) ? q.length : 0;
    const own = Math.max(fuzzy(q, cmd.label), fuzzy(q, cmd.group), chordScore, detail);
    // A related word still finds the command, but only under matches on its own name.
    const related = own > 0 ? 0 : (cmd.terms ?? []).reduce((best, term) => Math.max(best, fuzzy(q, term)), 0);
    return { cmd, s: own || related, related: own === 0 && related > 0 };
  });
  const matched = hits.filter((hit) => hit.s > 0);
  if (q) matched.sort((a, b) => Number(a.related) - Number(b.related) || b.s - a.s || COMMANDS.indexOf(a.cmd) - COMMANDS.indexOf(b.cmd));
  return matched.map((hit) => hit.cmd);
}

/** Run the most recently registered handler. False when nothing is listening. */
type Mods = { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean };

/**
 * What answers these held modifiers right now (plus one key): the which-key
 * overlay. Only commands something mounted can run, by their current binding.
 */
export function chordsFor(mods: Mods, mac: boolean, overrides: Overrides = {}): Array<{ id: CommandId; label: string; key: string }> {
  const out: Array<{ id: CommandId; label: string; key: string }> = [];
  for (const cmd of COMMANDS) {
    if (!handlers.get(cmd.id)?.size) continue;
    const c = resolveChords(cmd.id, overrides).find((c) => (mac ? true : !c.meta) && !!c.ctrl === mods.ctrl && !!c.alt === mods.alt && !!c.shift === mods.shift && !!c.meta === mods.meta);
    if (c) out.push({ id: cmd.id, label: cmd.label, key: chordParts(c).at(-1)! });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

export function runCommand(id: CommandId): boolean {
  const set = handlers.get(id);
  const fn = set && [...set].at(-1);
  if (!fn) return false;
  fn();
  return true;
}

/**
 * Run a command as soon as something offers it: for an action on a session that is
 * opening now (a sidebar row's menu opens the session, then renames it). Gives up
 * after `ms` if nothing ever registers it.
 */
export function runCommandSoon(id: CommandId, ms = 1500): void {
  const end = Date.now() + ms;
  const attempt = () => {
    if (runCommand(id) || Date.now() > end) return;
    requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

let capture: ((e: KeyboardEvent) => void) | null = null;

/** While set, the shortcut listener hands the next key here instead of running a command. */
export function setShortcutCapture(fn: ((e: KeyboardEvent) => void) | null) {
  capture = fn;
}

export function handleShortcutKey(e: KeyboardEvent) {
  if (e.repeat || e.isComposing) return;
  // AltGr reports as Ctrl+Alt on some systems; it types characters, never commands.
  if (e.getModifierState?.('AltGraph')) return;
  if (capture) {
    capture(e);
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  const scope = shortcutContext(e.target);
  const id = matchShortcut(e, scope, loadOverrides(), scope === 'field' ? fieldState(e.target) : {});
  if (!id || !runCommand(id)) return;
  e.preventDefault();
  e.stopPropagation();
}

/** A command's label, the same words wherever it is offered: menus, the palette, the shortcut table. */
export function commandLabel(id: CommandId): string {
  return COMMANDS.find((c) => c.id === id)?.label ?? id;
}
