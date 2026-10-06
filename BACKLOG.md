# Backlog status

✅ done · ◐ partial · ✗ not yet · — not applicable by design

## Phase 0 — Foundation

| # | Feature | | Where / notes |
|---|---|---|---|
| F1 | Host daemon | ✅ | `server/core.ts`. Wraps tmux; re-derives everything on start, so restarting ah never touches sessions. |
| F2 | Session registry | ✅ | `server/registry.ts`, `~/.local/state/ah/sessions.json`: id, host, harness, harnessId, cwd, model, title, status, lifecycle, created/lastActivity/ended, exitCode, tmux, `meta` (our keys are `ah.*`). exitCode is always null today: tmux doesn't keep it without `remain-on-exit`. |
| F3 | Register-on-spawn | ✅ | Every window is registered the first time it's seen, shells and windows ah didn't create included. |
| F4 | Local is just a host | ✅ | `server/peers.ts`: same daemon everywhere; the one you open proxies the rest under `/h/<host>/`. |
| F5 | list + attach CLI | ✅ | `ah list / new / attach / send / read / wait / resume / history / queue` (`bin/cli.js`). |

## Phase 1 — Continuity

| # | Feature | | Where / notes |
|---|---|---|---|
| F6 | Harness adapter table | ✅ | Presets (`command`, `resume`, `resumeId`, `match`, `waitingPatterns`) + discoverers for Claude Code and Codex. No transcript code. Other harnesses fall back to "continue last". |
| F7 | Resume on chosen host | ◐ | Resumes on the host that holds the conversation. Resuming a conversation on a *different* machine needs its files moved first (F31). |
| F8 | Alive/dead branch on send | ✅ | `Core.send`: types into idle agents, queues for busy ones, resumes dead ones then delivers. The caller can't tell which happened (unless it wants to). |
| F9 | Lifecycle states | ✅ | `starting / live / ended / unavailable`, with `pendingResume` as an orthogonal flag. "Saved" = discovered history. |
| F10 | Transcript discovery | ✅ | `server/discovery.ts` (~20 ms cold, cached per file). Live agent windows without hooks adopt their transcript id. |
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
| F22 | Durable prompt queue | ✅ | Persisted in the registry; delivered at the next idle; review and cancel individual follow-ups or clear all, on desktop and phone. Input operations are serialized per session, with a short submit grace period. |

## Phase 4 — Surfaces

| # | Feature | | Where / notes |
|---|---|---|---|
| F23 | Web UI | ✅ | |
| F24 | Mobile steering | ✅ | Composer (dictation, recent prompts, attachments), key bar, swipe scroll, text view, diff view. |
| F25 | Notifications | ✅ | Web Push with per-device opt-in for "needs you" and "finished". No "error" event yet. |
| F26 | Terminal view | ✅ | |
| F27 | Search with filters | ✅ | ⌘K: fuzzy search over live and history, with `h:` host/harness, `s:` status, `p:` project, `m:` model. |
| F28 | Host/project views | ✅ | Status / Projects / Hosts (or tmux sessions on a single host). |

## Phase 5 — Workspace hygiene

| # | Feature | | Where / notes |
|---|---|---|---|
| F29 | Worktree per session | ✅ | "Isolated git worktree" → `ah/<name>` branch in `<parent>/.worktrees/<repo>/`. |
| F30 | Worktree lifecycle | ◐ | List with dirty/ahead/in-use, orphan detection, safe removal. No disk-usage reporting. |
| F31 | Move session between hosts | ✗ | |

## Phase 6 — Nice to have

| # | Feature | | |
|---|---|---|---|
| F32 | Project briefs | ✗ | CLAUDE.md / AGENTS.md already do this per repo. |
| F33 | Settings transfer | ✗ | |
| F34 | Diff view | ✅ | Read-only status + patch. |
| F35 | Inline code comments | ✅ | Click a diff line to send the agent a file/line/code-anchored comment. |
| F36 | Session forking | ✅ | `server/fork.ts` + `Core.fork`: transcript copied to a new conversation id homed in a fresh `ah/<slug>` worktree (Claude Code and Codex), lineage in `ah.fork` meta, fork dialog + family view, `ah fork`. Mid-transcript fork points are not supported (fork is at the current end). |
| F37 | Agent-to-agent control | ✅ | `ah send X … && ah wait X && ah read X` |
| F38 | Scheduled runs | ✗ | |
| F39 | Snapshots + rollback | ✗ | |
| F40 | Idle respawn / rate-limit resume | ✗ | |
| F41 | Quota display | ✗ | |
| F42 | Launch choices | ✅ | Preset modes, models, and quoted additional arguments in the web dialog and CLI. Resume retains configured mode/model choices. |
| F43 | Session ordering | ✅ | Drag to reorder within a sidebar group; sparse keys persist across devices. |
| F44 | Session termination | ✅ | Sidebar and session controls, with confirmation for stopping a session. |
| F45 | Split workspace | ✅ | Independent terminal viewers, resizable horizontal/vertical splits, device-local persistence, phone tabs. Duplicate viewers have independent pane controls. |
| F46 | GUI view | ◐ | Branch `gui-support`. Transcript adapters (Claude Code, Codex) → typed events over SSE → separate React tree with tool and widget dispatch. Terminal-only interactions (agent pickers) hand off to the terminal. No adapters yet for Gemini, Grok, Muse, Hermes, opencode. |
| F46 | Workspace navigation | ✅ | Replace the focused pane from the sidebar or picker; drag sessions onto pane edges to split. |

## Reliability pass — October 2026

- Concurrent resumes share one launch; concurrent sends keep paste + Enter together.
- Detect agents that replace their pane's root shell with `exec`, including Hermes launchers.
- Preserve transcript/model identity only within the same harness.
- Keep mobile navigation in layout flow so history rows remain visible and scrollable.
- Isolate ordering tests from the real config, session store, and tmux server.

Remaining larger work: conversation transfer between hosts (including files),
worktree disk usage, and richer adapters for agents without hooks. These require explicit
product decisions rather than guessing at conversation or workspace ownership.

## Taken from tlbx (ideas reimplemented; tlbx is AGPL, no code copied)

- Prompt history across devices (composer → Recent)
- Screenshot paste / drag-drop → file on the host, path typed in
- File browser with upload into any folder, download, preview, insert as @mention
- Git changes view beside the session
- Scheduled follow-ups → the prompt queue (send now or when the agent is free)
- Bookmarks → pinned sessions

Not taken: tlbx's structured "Agent Controller" views (ACP), and the docked dev browser.
