# 04 · Session view

One session, shown by exactly one **surface** at a time (Terminal or GUI),
with a shared header and side panels (`web/surface.ts`).

## Header

### VIEW-1 · Desktop header — shipped

Agent mark · breadcrumb (project · Agent · Model) over the **title** (click to
rename) · **status pill** · **branch chip** (branch, `*` when dirty; opens the
branch switcher, SES-15) · **View** segmented control (GUI | Terminal; agents
with a GUI adapter only) · side panel toggle · **···** session menu.

### VIEW-2 · Phone header — shipped

Back (glass circle) · title over a subtitle that leads with the status pill
(then project ⌥ branch · agent) · a glass capsule with the view (GUI or
terminal) and ···. Below it, the session's **tabs** pick what you look at:
Session, Diff, Files, Chat, Queue, Snapshots, Preview (and Stack while the
branch is in review), as icons with the open one named, so they all fit.

### VIEW-3 · Session menu — shipped

··· or ⌃⌥. Desktop: a popover; phone: an iOS action sheet (grouped, 48 px rows,
Cancel apart, drag down to close). Rows, each with its chord:

- Rename session · Switch branch… · Fork session… · Send to… · **Continue in** (a row
  of agent marks; names under them on a phone) · Pin
- Diff · Files · Chat · Queue (n) · Send next queued now ·
  Snapshots · Preview
- Split right · Split below · Flip split · Replace pane… · Close pane
  (desktop, in a split)
- Scrollback as text · Hide/Show steps · Show/Hide on-screen keys · Copy attach command (
  `ah attach <id>`) · All commands…
- **Terminate session** (danger)

## Terminal surface

### VIEW-4 · Terminal — shipped

xterm.js (WebGL) on a real tmux client; every device views independently
(FND-2). Selecting text copies it (Shift-drag, or Option-drag on macOS, when
the TUI captures the mouse); links open; Unicode 11 widths.

- **Phone:** edge to edge, exact-line touch scrolling with momentum, pinch to
  change the font size, the **key bar** (ctrl, alt, shift sticky; paste, esc,
  tab, arrows) with edge fades.
- **Scrollback as text** (session menu): the window's scrollback as
  selectable text, for phones.
- **Answer card** under the terminal while it waits: the ask summary and the
  picker's options as rows (SES-7, VIEW-6).
- **Terminal pool:** a terminal you leave is parked 4 s and adopted if you come
  back; "Attaching…" shows only after 400 ms.
- Omarchy theme and font when Appearance is Omarchy (SET-2).

## GUI surface

### VIEW-5 · Feed — shipped

Built from the agent's structured transcript (never from the screen), through
one adapter per agent (FND-10) and an SSE stream (snapshot, then appends;
older pages on demand). Same live session; switching views restarts nothing.

- **Your messages** as right-aligned bubbles with time; attachments read as
  attachments, not upload paths. Messages you just sent show at once
  (outbox) until the transcript has them.
- **Pictures** in a message (what you attached, one pasted into the agent's
  terminal, what a tool saw) open over the conversation at the one tapped,
  growing out of its tile: swipe, the arrow keys or the dots go to the next,
  the first and last give, and a flick down or Esc puts it back in its tile.
  ⌘-click opens the file in a tab of its own.
  Several sit in a pile (the first on top, two more askew under it, and how
  many), which opens from the first; or side by side as tiles (SET-2).
- **Agent prose** as markdown (GFM tables, code with copy, links; local paths
  open through Files). Raw HTML never renders.
- **@mentions** in your messages and the agent's prose: an `@path` naming a
  file that's there is the composer's chip, and opens the file the same way.
  In code (inline or fenced) it stays code.
- **Tool calls as objects**: a row with a status dot, verb and subject
  (Ran, Read, Edited, Asked, Updated the plan), expandable to the command and
  output, a diff, a checklist, the question. Pending calls are in the present
  tense (Run, Edit); a call waiting on you says **Waiting for you**; a call the
  turn ended without says **No result**. Every kind of ask (a command, an
edit, a question) marks the call it is about.
- **Working line**: "Working · 12s" and what it is doing, "Esc stops".
- **Widgets** (generative UI): an agent's ```` ```ah-widget ```` block renders as
  card, choices, table, checklist, stats, bar chart, progress, links, image,
  code or diff ([docs/gui.md](../gui.md)). Choices are the same numbered
  option rows as an agent's own question; digits pick.
- **Answered questions** fold to one line.
- **Hide steps** (per device): tool calls and thinking fold to one line per
  run, so the conversation reads as prose.
- **Message rail**: a tick per message you sent on the left edge; the lit one
  is the turn in view; press and slide to jump. Hidden on a phone.
- **Jump to latest**, **Browse messages**, **Copy the agent's last reply**.
- **Unavailable** states say which: no transcript yet, or no adapter.
- **Instant paint**: the newest page of each conversation is cached in
  IndexedDB, AES-GCM encrypted with a key bound to this sign-in.
- A blank GUI offers the project's recent conversations to resume in place.

### VIEW-6 · Ask panel — shipped

A waiting agent's ask, answered without the terminal (`AskPanel.tsx`):
Claude's question dialog as a form (whole set from hooks, else one question at
a time from the screen), a numbered picker as buttons, or Approve / Deny.
Digits pick, arrows move, Space toggles, ⌃↵ submits. Edit approvals render
with the GUI's own diff.

It opens with the **ask summary** (`AskSummary`, `web/askView.ts`), the same in
the Inbox card, the GUI and the bar under the terminal: what it wants ("Wants
to run a command"), then the command as code with the agent's own description
(the hook's detail when there is one, so a wrapped command reads whole), or
the question; "Show terminal text" discloses the screen. Options are one row
style everywhere (OptionList): a number, the label, a description. A waiting
command's tool row stays folded, since the card shows the command. "Answer in
terminal" switches view when ah can't drive the picker.

### VIEW-7 · Composer — shipped

GUI only (the terminal is its own input). One box whose placeholder says what
Send will do now:

| State | Placeholder | Main button |
|---|---|---|
| idle / done | "Send a follow-up · / commands · @ files" | Send ↑ |
| working | "Add to this… (queued until it's free · Esc stops)" | Stop ■ (Send while typing) |
| waiting | a reply answers the prompt | Send |
| ended | typing resumes it | Send (resumes) |

- **Chips**: Model, Effort, Permissions (SES-11).
- **Recent prompts** (↺): sent messages from every device, newest first.
- **Attach** (paperclip), paste a screenshot, or drop files: uploaded to the
  host and inserted as paths.
- **Dictation** (mic).
- **Autocomplete**: `/` the agent's slash commands (built-in, yours, the
  project's); `@` the project's files.
- **@mentions as chips**: an `@path` naming a file that's there (in the
  session's folder, or absolute, or `~`) is a bordered chip where it's written:
  a tap opens the file (a preview sheet on the web, Quick Look in the app), the
  × in its @ takes it and its space out. The text stays the box's own (dictation,
  autocorrect). The mention still being completed, a name that's no file, and a
  shell's @ stay text. A file you attach is one too (`@paste.png`), where the
  caret was, beside its tile above the box: the message carries its path in
  that place (one whose chip was deleted as text goes in front), its chip or its
  tile's × takes both out, and the feed draws it in that place as well. Any
  chip drags to another place in the text (a press past a few points, a caret
  where it lands); a drag doesn't open it.
- Enter sends, Shift+Enter is a new line; Enter in an empty composer steers
  the top queued message; Esc in an empty composer stops the turn.
- **Queue tray** above the box while anything is queued (SES-6).
- **Draft** kept on the host (CON-4); "from iPhone" when it came from another
  device.
- Keeps focus on Send so the phone keyboard stays up.

### VIEW-8 · Ended session — shipped

An ended session stays in place: its conversation (GUI) or last screen, and
**Resume** (⌘↵). Typing a message resumes it (SES-5).

## Side panels

One panel at a time beside the session (desktop: resizable, collapsible,
closable, ⌃⌥1–7; phone: tabs). Stack (REV-11) sits beside Diff in a git
checkout. The tabs are the same set in the same order
everywhere (agent-only ones absent for a shell), drawn as icons with the open
one named; each tab's tooltip has its chord, and Queue carries its count.

### VIEW-9 · Diff — shipped

Uncommitted changes of the session's checkout, per file with real line
numbers. **Click a line** to send the agent a comment anchored to that file,
line and code. Footer: branch · files · +/−. Shells too (not agent-only).

### VIEW-10 · Files — shipped

Browse the host from the session's folder, within `files.roots` (Go to… a
root), go up, the session folder, show hidden files, new folder; download a file, preview it (CSP sandboxed);
**Upload here** from this device into any folder; **Insert** a file or folder
path into the session (as an `@mention` for agents, quoted for shells).

### VIEW-11 · Chat (side chat) — shipped

Talk about the session's change with a chat subscription (SET-6) without
touching the agent's context; the server attaches the working diff, branch and
PR. Optimistic, chained sends; history follows the conversation across
devices; past chats list. Anything worth acting on goes to the session through
the normal send path. Empty state links to Settings → Subscriptions.

### VIEW-12 · Queue — shipped

The conversation's queue (SES-6) with Send now, Edit, Cancel per row and
Cancel all. Agents only.

### VIEW-13 · Snapshots — shipped

One row per turn ("Before turn N", time, branch, files changed, Restore), the
per-session switch, and a note on how snapshots are kept (SES-22). Agents only.

### VIEW-14 · Preview — shipped

See SES-23.
