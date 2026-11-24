# 02 · Sessions

Everything you can do *to* a session. Where each action is reachable is in the
[parity matrix](audit.md#parity-matrix).

## SES-1 · Agents and shells — shipped

A session is an **agent** (a preset with an agent command) or a **shell**.
Shells never offer agent-only actions: Fork, Continue in, Send to's agent
side, Queue, Snapshots, GUI, model / effort / permissions. They are absent, not
disabled.

## SES-2 · New session — shipped

Opened by ⌃⇧↵, the sidebar's New session, the Inbox's New session, the phone's
**+**, the palette, or a pane chooser's "New session…". On desktop it takes the
space the session will occupy (never a modal); on a phone it is a sheet.

Fields, in order:

1. **Shell | Agent** switch.
2. **Agent**: the three most-used agents on this device (plus any running on
   the host) as buttons, the rest under "N more". Only agents installed and
   not hidden on that host.
3. **Project**: a path field with chips for known projects and **New folder**.
   A bare project name resolves to that project. A path that doesn't exist says
   what Start will create (one level, inside `files.roots`, optional
   `git init`).
4. **Model** (live catalog, or an exact custom id), **Effort**,
   **Permissions** (the agent's modes, Skip permissions marked as dangerous).
   For a shell: which shell.
5. **Prompt**: optional, sent once the session starts.
6. **More options**: Name, **Isolated git worktree** (SES-14), additional CLI
   arguments (quoted, never concatenated into a shell string), tmux session,
   machine (multi-host). "· changed" shows when any is set.

Defaults: the focused session's project (else the last one started from this
device, else the most recently active session's), and the last agent and
model used (P11). A device that has started nothing opens on Agent, with its
most-used agent (or one running on the host) chosen and the keyboard on it. Start is the ⌘↵ button. ah starts sessions only from presets.

## SES-3 · New Space — shipped

Sidebar "Projects +", the palette, or New session's **New folder** chip: name a
folder in the projects root, optionally `git init`, and start any agent in it.

## SES-4 · Run in Space — shipped

Palette → Run in Space → a Space → an agent or a shell: two keystrokes from
anywhere.

## SES-5 · Send (the one verb) — shipped

`Core.send` decides by state, and the caller cannot tell which happened
(unless it asks):

| Session is | The message |
|---|---|
| idle | is typed in now |
| waiting | is delivered now (it is the answer to the prompt) |
| working | is **queued** until the next idle (SES-6) |
| ended | resumes the session first, then is delivered |

Paste and Enter are one serialized operation per session, across every caller
(composer, CLI, queue, widget buttons, review comments).

**Delivered means the agent has it.** Keys can be lost on the way (an Enter
taken as a newline mid-paste, a redraw, tmux's scrollback), so every message
typed into an agent whose conversation ah reads (any with a chat view) is
watched until that conversation shows it from the user; the next one waits
behind it. One the agent settles without gets one more Enter; still not seen,
it is shown as **not sent** (first in the queue, `unsent: true`, for a client
that asks with `?unsent=1`): Send now types
it again, Cancel lets it go, and it goes on its own once the conversation has it.
An agent ah can't read (a shell, a custom command) is typed into unwatched.

## SES-6 · Queue — shipped

- Persisted in the registry under the conversation; follows adoption and
  resume. At-most-once: an item is removed before it is typed; a paste that
  typed nothing is requeued.
- Delivered at the next idle, never into a waiting session (typed text would
  answer its prompt), except replies sent while waiting, which deliver at once.
- Per item: **Send now** (stops the turn, delivers this; a prompt the stop
  hands back unanswered, as Claude Code does stopped before its first word,
  goes in again ahead of it, a blank line between, pictures and all), **Edit** (back into
  the composer), **Cancel**, and drag to reorder (two or more). **Cancel all**.
- Shown in the composer's queue tray (GUI), the Queue side panel, the
  palette's Turn and queue branch, and `ah queue`.

## SES-7 · Answer — shipped

Approve / Deny, a picker option, or Claude's question form, from the Inbox
card, the session (GUI ask panel or the terminal's answer card), the palette,
chords (⌃⌥↵ / ⌃⌥⌫, digits), or push → open. The server re-reads the screen
and types keys only if the same prompt is still there and untouched. Pickers
ah can't drive (`/model`) say **Answer in terminal**.

## SES-8 · Stop the turn — shipped

Stop button, Esc in an empty composer, ⌃⌥X, the palette. Agents get Esc, shells
Ctrl-C; resolves once a hooked turn visibly stops. A Send just made holds Stop
for 700 ms, so a double tap on Send can't stop the turn it queued.

## SES-9 · Resume — shipped

Brings an ended session or a saved conversation back **in place**: same uid,
title, pin, order and launch choices, with `resumeId` (`claude --resume <id>`)
or `resume` (continue last) for agents without ids. Concurrent resumes share
one launch. From the ended session's own view (⌘↵), History (tap a row), the
switcher, a recent conversation offered by an empty Inbox or a blank GUI,
typing a message into it (SES-5), `ah resume`.
→ F7 open: only on the host that holds the conversation.

## SES-10 · Relaunch — shipped

Same conversation, fresh process: creates the new window first, keeps pin /
order / worktree / fork meta. Used by model / effort / mode changes the agent
can't make live, by Settings → Environment's Restart, and by bypass mode.

## SES-11 · Model, effort, permissions — shipped

From the GUI composer's chips, the palette's Model and effort branch, ⌃⌥M /
⌃⌥E, or New session / Fork. Each change is, in order of preference:

1. **live**, where the agent has a command (Claude's `/model`, `/effort`,
   Shift+Tab mode cycling until its footer shows the mode);
2. a **relaunch** of the same conversation with the new flag;
3. the agent's **own picker** in its terminal, when ah has no list.

Busy agents queue the change. The chip shows what is actually running (the
model the transcript reports; the mode the footer shows), not the launch flag.
The picker says which of the three a choice will do ("Changes this session" /
"Restarts this session with it").

## SES-12 · Rename — shipped

⌃⌥N, the session menu, the header title (click to edit), the palette.
Optimistic. Renames the tmux window; the title then wins over the agent's own.

## SES-13 · Pin and order — shipped

- **Pin to top** (session menu, palette): pinned sessions lead their group.
- **Drag to reorder** within a sidebar group; sparse order keys persist on the
  host, so every device sees the same order. Groups themselves reorder per
  device.
- Open: keyboard reordering.

## SES-14 · Worktrees — shipped

- **Isolated git worktree** at start: `ah/<name>` branch in
  `<parent>/.worktrees/<repo>/`. One writing agent per checkout.
- **Worktrees** dialog (sidebar footer): every managed worktree with dirty /
  ahead / in-use, on-disk size (background), orphans, safe removal (branch
  kept), bulk clean-up, open a shell in one. `ah worktrees`.
- Reached from the sidebar's footer and the palette (Go to → Worktrees), so
  also from a phone.

## SES-15 · Branch — shipped

The header's branch chip (desktop), Branch in the session menu (every
device), or the palette's Switch branch…: switch to or create a branch in the
session's checkout; shows the pull request when there is one.

## SES-16 · Fork — shipped

Copies the conversation under a new id into a fresh `ah/<slug>` worktree, from
the last commit (uncommitted changes are named, not carried), with an optional
first message, model, effort and permissions. Claude Code, Codex, Muse.
The dialog, the default name ("Docs link audit (fork)") and the fork use the
session's title. Lineage in `ah.fork` meta: a fork count on the parent, "Fork of …" on the
child. From the session menu, sidebar row menu, History row menu, palette,
⌃⌥F, `ah fork`. Open: forking from a mid-transcript point.

## SES-17 · Continue in another agent — shipped

A new session on another agent in the same project, primed with this
conversation (its prose, newest last, within a budget; no model involved).
Session menu row of agent marks, phone action sheet with names, palette.

## SES-18 · Send to… — shipped

Hand something from this session to another one (or a new one): the last
reply, or a summary written by a chat subscription. Prefers an agent in the
same project, then any agent, then New session; never preselects a shell.
⌃⌥T, session menu, palette.

## SES-19 · Terminate — shipped

Kills the tmux window, after a confirmation naming the session. The record and
conversation stay (History, resumable). Sidebar row ✕ and menu, session menu,
palette. Revoking a device also closes its terminals. → A-09: no CLI command.

## SES-20 · Forget — shipped

History → ··· → Hide: removes an ended session or saved conversation from
History. The transcript on disk is untouched.

## SES-21 · Session environment — shipped

Variables every new, resumed, relaunched or forked window starts with
(`tmux new-window -e`). Secrets are write-only. A chat subscription can hand
its key to sessions under a name. Sessions on older values are listed with
Restart (SES-10). See SET-7.

## SES-22 · Snapshots and rollback — shipped

Per-turn git snapshots under `refs/ah-snapshots/`, captured at turn start
(per session, can be switched off). Restore takes a safety snapshot first, so
a restore is itself undoable; a failed restore says whether files are back or
half restored, and an agent not told about a rollback is flagged. Snapshots
panel, `ah snapshots`, `ah rollback`.

## SES-23 · Preview — shipped

A session's dev server in a browser pane: ports its processes listen on are
offered, any port can be typed. ah proxies it on a port of its own (range
`preview.ports`) behind the same sign-in, published on the tailnet as
`https://<node>.ts.net:<port>`; live reload works through it. One preview per
session; survives ah restarts. Side panel (⌃⌥6).
