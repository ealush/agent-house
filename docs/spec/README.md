# ah — product specification

The spec of what ah **is**, written back from what it does (code, tests and the
running product on 17 October 2026, `main` at 67ba26b). It is the reference a
change is checked against: if the product and this document disagree, one of
them is wrong, and the change says which.

ah is not one screen. It is an ecosystem around one idea, **tmux owns the
processes; ah owns the experience**, reached from several surfaces that must
behave as one product:

| Surface | What it is | Spec |
|---|---|---|
| **Host daemon** | `server/main.ts` on each machine, loopback only, re-deriving everything from tmux | [01 Foundation](01-foundation.md) |
| **Web app, desktop** | sidebar + main area + split workspace, keyboard first | [03](03-attention.md), [04](04-session.md), [05](05-workspace.md), [06](06-keyboard.md) |
| **Web app, phone and iPad** | the same app as a home-screen PWA: tab bar, sheets, swipe back, GUI by default | [10 Platforms](10-platforms.md) |
| **Desktop app** | ah in its own window from the app launcher (Omarchy web app), `ah open` from tmux | [10 Platforms](10-platforms.md) |
| **CLI** | `ah …`, a thin view over the local daemon; also how agents drive agents | [09 CLI](09-cli.md) |
| **Agents** | Claude Code, Codex, Gemini, Grok, Muse, Hermes, opencode, Cursor, Copilot, Crush, pi, any shell | [02 Sessions](02-sessions.md) |
| **Hooks** | `bin/ah-hook.js` in each agent, writing status into tmux | [01 Foundation](01-foundation.md) |
| **Push** | Web Push to every opted-in device, app badge | [07 Continuity](07-continuity.md) |
| **Review** | PR stacks reviewed layer by layer, with agents fixing findings; GitHub's own stacks | [12 Review](12-review.md) |
| **Other hosts** | the same daemon elsewhere on the tailnet, proxied under `/h/<host>/` | [01 Foundation](01-foundation.md) |

## Feature freeze (from 17 October 2026)

No new features. Work is limited to:

1. **Specification**: this folder. Every shipped feature has an entry with an ID.
2. **Consistency**: the findings in [audit.md](audit.md): the same thing must
   look, read, and behave the same on every surface it appears on.
3. **Finish**: bugs, polish, and the redesign (one visual system for every
   screen; [11 Design system](11-design-system.md)).

Review (stack review), GitHub's own stacks and subscription providers landed
on main on 17 October at the owner's call, outside the freeze. They are now in
the spec ([12 Review](12-review.md), SET-6) and the audit's second pass
(A-30 to A-37), and read the design system's tokens like everything else.
A change that adds a capability needs the freeze lifted, and an entry here first.
The owner lifted it on 14 November 2026 for the conductor work ([13](13-conductor.md)).
On 16 November 2026 the owner lifted it for voice dictation ([14](14-voice.md)),
and on 18 November for scratchpads ([15](15-scratchpads.md)), and on 20 November for subagents ([16](16-subagents.md)).

## Spec files

| # | File | IDs | Covers |
|---|---|---|---|
| 01 | [Foundation](01-foundation.md) | `FND` | daemon, tmux, registry, identity, lifecycle, status, harnesses, hooks, discovery, hosts, config and state |
| 02 | [Sessions](02-sessions.md) | `SES` | starting, resuming, relaunching, naming, ordering, pinning, ending, forking, handing to another agent, model/effort/mode, environment, worktrees |
| 03 | [Attention](03-attention.md) | `ATT` | sidebar, Inbox, Search (with History), switcher, Handoff card |
| 04 | [Session view](04-session.md) | `VIEW` | header, terminal, GUI, composer, queue, answering, side panels |
| 05 | [Workspace](05-workspace.md) | `WS` | splits, pane chooser, workspaces 1–9, pane and resize modes, scratchpad |
| 06 | [Keyboard and commands](06-keyboard.md) | `KEY` | command catalog, palette, chords, which-key, shortcuts table, ⌘↵ |
| 07 | [Continuity](07-continuity.md) | `CON` | stable links, ended in place, Handoff, drafts, presence, notifications, badge, reconnect, caches |
| 08 | [Settings and host](08-settings.md) | `SET` | every Settings section, server operations, the desktop app entry |
| 09 | [CLI](09-cli.md) | `CLI` | every command |
| 10 | [Platforms](10-platforms.md) | `PLT` | desktop, iPad, phone, desktop app, PWA, Omarchy |
| 11 | [Design system](11-design-system.md) | `DS` | tokens, type, shape, material, motion, components, voice |
| 12 | [Review](12-review.md) | `REV` | the Review page, making a stack, the stack, a layer, the reviewer, findings, GitHub's threads, sending, re-review, merging and GitHub's own stacks, the Stack tab |
| 13 | [Conductor](13-conductor.md) | `CND` | feature versions and the client contract, streamed uploads, portable conversations and lineage (and, as they land: moving sessions between hosts, scheduled jobs, recovery, usage) |
| 14 | [Voice](14-voice.md) | `VOX` | dictation into the composer: speech through a host subscription (or on the device), optional cleanup, the Voice settings |
| 15 | [Scratchpads](15-scratchpads.md) | `SCR` | Markdown notes as sessions of their own: written offline, synced by revision with tombstones, filed under a project, saved as a file, handed to an agent |
| 16 | [Subagents](16-subagents.md) | `SUB` | The agents a session's agent spawned as sessions of their own: a tree with nested children, lifecycle, read-only capabilities by harness, each child's transcript live and after the fact |
| — | [Security](../../SECURITY.md) | `SEC` | threat model and tested invariants (kept in SECURITY.md; summarised in 01) |
| — | [Audit](audit.md) | `A` | parity matrix, vocabulary, findings, and their resolution |

## Vocabulary

One word per thing, everywhere: UI, CLI help, docs, notifications.

| Word | Means | Never |
|---|---|---|
| **Session** | One thing running in a tmux window that ah tracks: an agent or a shell. Has a stable `uid`. | window, tab, pane (a pane is a place on screen) |
| **Agent** | A coding-agent CLI (Claude Code, Codex…). Internally a *harness* with a *preset*. | harness (in the UI), bot |
| **Shell** | A session with no agent. | terminal (the terminal is a *view*) |
| **Conversation** | An agent's transcript, keyed by `harness:harnessId`. Outlives sessions: resume brings it back. | chat (that is the side chat), thread |
| **Project** | The folder a session works in (git root or cwd basename). | repo, workspace |
| **Host** | A machine running ah. The one you opened is the *hub*. | server, node, peer (in the UI) |
| **Device** | A browser that signed in (iPhone, Desk). Named in Security. | client |
| **Status** | `needs you` · `working` · `done` (agents) / `new output` (shells) · `idle` · `limited` | waiting, busy, attention, running (in the UI) |
| **Ended** | A session whose process is gone; its conversation can be resumed. | dead, killed, closed |
| **History** | Ended sessions plus conversations found on disk; a section of Search. | archive |
| **Queue** | Messages waiting for a working agent; delivered at its next idle. | outbox, scheduled |
| **Terminal / GUI** | The two views of one session. | raw / rich, TUI |
| **Side panel** | Diff, Stack, Files, Chat, Queue, Snapshots, Preview beside a session. | drawer, inspector |
| **Pane** | A place in the split workspace showing one session. | tile, split (a split is the act) |
| **Workspace** | One of nine saved arrangements on this device. | desktop, space |
| **Fork** | A copy of a conversation in its own worktree and branch. | branch (that is git's) |
| **Continue in** | A new session in another agent carrying this conversation: a native copy where the agent's own history can hold it, else a record reconstructed from the transcript. | handoff (that is device continuity) |
| **Lineage** | Which conversations a conversation came from and led to, across agents and hosts. | history (that is the list of past sessions) |
| **Handoff** | Continuing on this device the session you were using on another. | — |
| **Worktree** | A separate checkout on an `ah/<name>` branch for one session. | — |
| **Snapshot** | The files as they were before a turn started. | checkpoint |
| **Stack** | PRs in review-and-merge order on one trunk; on GitHub, a stack GitHub knows about. | chain (only for PRs based on each other), series |
| **Layer** | One PR in a stack, labelled by its role (`F2`). | step, level |
| **Finding** | A concern owned by the layer that should change. | comment (that is GitHub's), issue |
| **Reviewer** | The model that reads a stack with you, on a chat subscription. | bot, assistant, agent (agents fix; the reviewer doesn't) |

## Invariants

These hold for every feature; a feature that breaks one is a bug.

1. **tmux is the source of truth.** ah can crash, restart or update without
   touching a session. Everything ah shows is re-derived from tmux, the
   registry and the agents' own stores. (FND-1)
2. **A session is its uid.** Links, layouts, workspaces, notifications, drafts
   and presence key on the uid, never a tmux window id. (FND-4, CON-1)
3. **A conversation is its harness id.** Transcripts, side chats, queues and
   forks attach to `harness:harnessId`, never to recency or cwd. (FND-5)
4. **Nothing is typed blind.** Approve, Deny, picker answers and queued
   messages re-check the screen or state right before typing. A stale click
   never lands in a live agent. (VIEW-20, SES-7)
5. **One status vocabulary**, from `web/status.ts`, wherever status shows. (FND-8)
6. **Every action has a keyboard path, a touch path, and a palette entry**,
   and the main button of every screen answers ⌘↵. (KEY-1)
7. **Device-local vs host-wide is explicit.** Theme, layout, workspaces,
   shortcuts, view choice and notification opt-in are this device's. Sessions,
   order, pins, drafts, queues, prompt history, environment and agents are the
   host's, and every device sees the same. (CON-10)
8. **Loopback only; Tailscale reaches it; passkeys open it.** (SEC)
9. **Shells are not agents.** Agent-only actions (Fork, Queue, Snapshots, GUI,
   model/effort/mode, Continue in) are absent, not disabled, on shells. (SES-1)

## Status markers

Entries carry one of: **shipped** (in `main`, covered by tests or the smoke
suite), **partial** (shipped with a known gap, named in the entry),
**open** (in BACKLOG, frozen). Findings that touch an entry are linked as
`→ A-nn`.
