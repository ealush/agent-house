# Backlog status

✅ done · ◐ partial · ✗ not yet · — not applicable by design

## Phase 0 — Foundation

| # | Feature | | Where / notes |
|---|---|---|---|
| F1 | Host daemon | ✅ | `server/core.ts`. Wraps tmux; re-derives everything on start, so restarting ah never touches sessions. The tmux server itself is owned by `contrib/ah-tmux.service` (`exit-empty off`, also enforced by `ensureServer()` on every boot); ended records keep their harness id/cwd and stay one-tap resumable from History (`server/crash.test.ts`). |
| F2 | Session registry | ✅ | `server/registry.ts`, `~/.local/state/ah/sessions.json`: id, host, harness, harnessId, cwd, model, title, status, lifecycle, created/lastActivity/ended, exitCode, tmux, `meta` (our keys are `ah.*`). exitCode is always null today: tmux doesn't keep it without `remain-on-exit`. |
| F3 | Register-on-spawn | ✅ | Every window is registered the first time it's seen, shells and windows ah didn't create included. |
| F4 | Local is just a host | ✅ | `server/peers.ts`: same daemon everywhere; the one you open proxies the rest under `/h/<host>/`. |
| F5 | list + attach CLI | ✅ | `ah list / new / attach / send / read / wait / resume / history / queue` (`bin/cli.js`). |

## Phase 1 — Continuity

| # | Feature | | Where / notes |
|---|---|---|---|
| F6 | Harness adapter table | ✅ | Presets (`command`, `resume`, `resumeId`, `match`, `waitingPatterns`) + discoverers for Claude Code and Codex. No transcript code. Other harnesses fall back to "continue last". |
| F7 | Resume on chosen host | ◐ | Resumes on the host that holds the conversation. Resuming a conversation on a *different* machine needs its files moved first (F31). |
| F8 | Alive/dead branch on send | ✅ | `Core.send`: types into idle agents, delivers immediately to waiting ones (the reply is the answer to the prompt), queues for busy ones, resumes dead ones then delivers. The caller can't tell which happened (unless it wants to). |
| F9 | Lifecycle states | ✅ | `starting / live / ended / unavailable`, with `pendingResume` as an orthogonal flag. "Saved" = discovered history. |
| F10 | Transcript discovery | ✅ | `server/discovery.ts` (~20 ms cold, cached per file). Live agent windows without hooks adopt their transcript id by conversation identity (launch novelty + ownership, never recency). |
| F11 | Multi-writer policy | ✅ | **Decision: last-active-wins.** Each device attaches through its own grouped tmux session, so viewing is independent; tmux `window-size latest` gives the window to whoever typed last. No locks or leases. |

## Phase 2 — Transport

| # | Feature | | Where / notes |
|---|---|---|---|
| F12 | One connection per host | ◐ | State: one SSE stream per host, via the hub. Terminals: one WebSocket each, by design (each one is a tmux client). |
| F13 | Reconnect + reconstruction | ✅ | Exponential backoff, plus an immediate retry on wake/online; the open session is restored from the URL. |
| F14–F16 | Watermarks, history gaps, no resend | — | There's no event log to sequence: tmux repaints the whole screen on attach, so a reattach is always consistent. The prompt queue is at-most-once (an item is removed before it's typed), so a turn is never sent twice. |

## Phase 3 — Status

| # | Feature | | Where / notes |
|---|---|---|---|
| F17 | Status from hooks | ✅ | `bin/ah-hook.js` writes window options; `ah hooks install`. |
| F18 | Status from terminal | ◐ | Per-harness `waitingPatterns`, pinned by tests in `server/sessions.test.ts`. No scheduled drift audit yet. |
| F19 | Needs-you vs done | ✅ | Conservative: only permission/elicitation prompts count as "needs you"; idle nags and anything unknown are "done". No model classifier. |
| F20 | Background work isn't idle | ◐ | Live tool shells below an agent keep silent commands busy; persistent services alone do not. Fresh working hooks count before terminal output. Commands that replace their tool shell still rely on hooks/activity. |
| F21 | Status grouping | ✅ | Needs you → done → working → idle. |
| F22 | Durable prompt queue | ✅ | Persisted in the registry under the conversation identity (follows adoption/resume); delivered at the next idle, except replies sent while waiting, which deliver immediately; review and cancel individual follow-ups or clear all, on desktop and phone. Input operations are serialized per session, with a short submit grace period. |

## Phase 4 — Surfaces

| # | Feature | | Where / notes |
|---|---|---|---|
| F23 | Web UI | ✅ | |
| F24 | Mobile steering | ✅ | Composer (dictation, recent prompts, attachments), key bar, swipe scroll, text view, diff view. |
| F25 | Notifications | ✅ | Web Push with per-device opt-in for "needs you" and "finished". No "error" event yet. |
| F26 | Terminal view | ✅ | |
| F27 | Search with filters | ✅ | ⌘K: full-text search (`server/search.ts`, FTS with fingerprints and incremental indexing) over transcripts, side-chats and history, with `h:` host/harness, `s:` status, `p:` project, `m:` model, role and time-range filters, plus open-at-message navigation. |
| F28 | Host/project views | ✅ | Status / Projects / Hosts (or tmux sessions on a single host). |

## Phase 5 — Workspace hygiene

| # | Feature | | Where / notes |
|---|---|---|---|
| F29 | Worktree per session | ✅ | "Isolated git worktree" → `ah/<name>` branch in `<parent>/.worktrees/<repo>/`. |
| F30 | Worktree lifecycle | ✅ | List with dirty/ahead/in-use, orphan detection, safe removal, and background on-disk size reporting (`server/size.ts`). |
| F31 | Move session between hosts | ✗ | |

## Phase 6 — Nice to have

| # | Feature | | |
|---|---|---|---|
| F32 | Project briefs | ✗ | CLAUDE.md / AGENTS.md already do this per repo. |
| F33 | Settings transfer | ✗ | |
| F34 | Diff view | ✅ | Read-only status + patch. |
| F35 | Inline code comments | ✅ | Click a diff line to send the agent a file/line/code-anchored comment. |
| F36 | Session forking | ✅ | `server/fork.ts` + `Core.fork`: transcript copied to a new conversation id homed in a fresh `ah/<slug>` worktree (Claude Code, Codex and Muse), lineage in `ah.fork` meta, fork dialog + family view, `ah fork`. Mid-transcript fork points are not supported (fork is at the current end). |
| F37 | Agent-to-agent control | ✅ | `ah send X … && ah wait X && ah read X` |
| F38 | Scheduled runs | ✗ | |
| F39 | Snapshots + rollback | ✅ | Per-turn git snapshots under private refs (`server/snapshots.ts`), captured at turn start, with rollback that takes a safety snapshot first so a restore is itself undoable; `Snapshots.tsx` panel with per-turn list and restore. |
| F40 | Idle respawn / rate-limit resume | ✗ | |
| F41 | Quota display | ✗ | |
| F42 | Launch choices | ✅ | Preset modes, models, and quoted additional arguments in the web dialog and CLI. Resume retains configured mode/model choices. |
| F43 | Session ordering | ✅ | Drag to reorder within a sidebar group; sparse keys persist across devices. |
| F44 | Session termination | ✅ | Sidebar and session controls, with confirmation for stopping a session. |
| F45 | Split workspace | ✅ | Independent terminal viewers, resizable horizontal/vertical splits, device-local persistence, phone tabs. Duplicate viewers have independent pane controls. |
| F46 | Workspace navigation | ✅ | Replace the focused pane from the sidebar or picker; drag sessions onto pane edges to split. |
| F47 | GUI view | ✅ | Transcript adapters (Claude Code, Codex, Gemini, Grok, Muse, opencode, Hermes) → typed events over SSE → separate React tree with tool and widget dispatch. Agents' pickers (permission prompts, Claude's question dialog, cursor lists like folder trust) are answered from the GUI, inbox and phone; other TUI-only pickers (`/model`) hand off to the terminal. |

## Reliability pass — October 2026

- Concurrent resumes share one launch; concurrent sends keep paste + Enter together.
- Detect agents that replace their pane's root shell with `exec`, including Hermes launchers.
- Preserve transcript/model identity only within the same harness.
- Keep mobile navigation in layout flow so history rows remain visible and scrollable.
- Isolate ordering tests from the real config, session store, and tmux server.

## Hardening pass — 10 October 2026

- Answer from anywhere: Claude's question dialog as a form (whole set from hooks,
  else one question at a time from the screen), numbered pickers and cursor lists
  (permission prompts, folder trust) as buttons with their context; keys typed only
  after re-reading the screen (`server/choices.ts`).
- Keyboard first: every session action is a palette command, most with Ctrl+Alt
  chords that also work from the composer; arrow keys in menus, pickers, sidebar,
  inbox, history and queue; Esc stops a turn from an empty composer.
- GUI: `/` and `@` autocomplete, queued follow-ups inline (Send now / Edit /
  Cancel), sending bubbles, a working line with elapsed time, folded answered
  questions, Hermes adapter.
- Phone: safe areas and keyboard offset, 16px fields (no zoom), exact-line touch
  scrolling with momentum, pinch for terminal font, edge-to-edge terminal.
- Reliability: relaunch creates the new window first and keeps pin/order/
  worktree/fork meta; a follow-up whose paste typed nothing is requeued; prompts
  Claude redraws every second still read as "needs you"; CSP violations fixed;
  the test harness cleans its temp dirs; hooks installable from Settings.

## Phase 7 — One product (premium pass, from 12 October 2026)

Not new features: everything should feel like one packaged, native product
that follows you across devices, harnesses, restarts and resumes.

| # | Item | | Notes |
|---|---|---|---|
| P1 | Stable session identity | ✅ | Links, layouts, workspaces, scratchpad and notification URLs key on the session's uid, not the tmux window id, so they survive resume and tmux restarts and never point at a different window. |
| P2 | Ended sessions stay where they are | ✅ | A session that ends (or a link to one) shows in place with Resume (⌘↵) instead of bouncing to the inbox; panes after a reboot offer the same. |
| P3 | Continue on this device | ✗ | Handoff: opening ah offers the session you were just using on another device. |
| P4 | Drafts follow you | ✗ | An unsent composer draft is kept per session on the host: start on the phone, finish at the desk, survive reloads. |
| P5 | GUI by default where it reads better | ✅ | Phones open agent sessions in the GUI unless you chose otherwise. |
| P6 | One visual language | ✅ | One keycap style (platform aware), status pills, clean model names, no duplicated header meta. |
| P7 | Native permission prompts | ✅ | Edit approvals render with the GUI's own diff; the tool row says it is waiting for you, not "Running". |
| P8 | App badge | ✗ | Home-screen/installed app icon carries the needs-you count. |
| P9 | Motion | ✗ | Consistent, quick transitions between pages, sessions and panels; reduced motion respected. |
| P10 | Inbox and History polish | ✗ | Aligned columns, actions on hover/focus, tidier rows. |
| P11 | New session knows where you are | ✗ | Starts in the focused session's project with the last harness and model you used. |

Next candidates: rate-limit auto-resume (F40, opt-in, needs each CLI's reset
message), quota display (F41), keyboard reordering in the sidebar.

Remaining larger work: conversation transfer between hosts (including files),
worktree disk usage, and richer adapters for agents without hooks. These require explicit
product decisions rather than guessing at conversation or workspace ownership.

## Design rules

- **Conversation identity is the attachment key.** Transcripts, side-chats, and
  queued follow-ups attach to `harness:harnessId` (the harness's own conversation
  id), never to recency, cwd proximity, or ah's local uid. Sessions whose harness
  has no conversation id (plain shells) keep the registry uid as their key.
  - Transcripts: hooks report the id (Claude/Codex); resume and fork pass it
    explicitly; ah-launched sessions snapshot the ids known at launch
    (`ah.knownTranscripts` in `server/core.ts`) and `server/sessions.ts` adopts
    only a novel, unowned id. Windows ah did not launch keep a best-effort
    recency fallback. Timing remains only for safety debounces (submit grace,
    half-drawn TUI guard), never for ownership.
  - Side-chats (`server/sidechat.ts`) key to the conversation and migrate legacy
    uid rows on access, so history survives re-adoption and resumed-as-new uids.
  - Queues (`ah.queue` in `server/registry.ts`) move with the conversation when it
    is adopted or resumed under a new uid. Forks get a new conversation id, so
    the parent keeps its queue.

## Taken from tlbx (ideas reimplemented; tlbx is AGPL, no code copied)

- Prompt history across devices (composer → Recent)
- Screenshot paste / drag-drop → file on the host, path typed in
- File browser with upload into any folder, download, preview, insert as @mention
- Git changes view beside the session
- Scheduled follow-ups → the prompt queue (send now or when the agent is free)
- Bookmarks → pinned sessions

Not taken: tlbx's structured "Agent Controller" views (ACP), and the docked dev browser.
