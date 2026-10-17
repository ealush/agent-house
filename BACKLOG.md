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
| F47 | GUI view | ✅ | Transcript adapters (Claude Code, Codex, Gemini, Grok, Muse, opencode, Hermes) → typed events over SSE → separate React tree with tool and widget dispatch. Agents' pickers (permission prompts, Claude's question dialog, cursor lists like folder trust) are answered from the GUI, inbox and phone; model, effort and permission mode change from the composer's chips (P45). |
| F48 | Session environment | ✅ | Settings → Environment: variables every session window starts with (`tmux new-window -e`; new, resumed, relaunched, forked). Secrets are write-only like chat keys. A chat subscription can hand its key to sessions under a name (OPENAI_API_KEY), so one key serves side chat and agents. Sessions on older values are listed with a Restart (relaunch with no change: same conversation, fresh process). `server/env.ts`. |

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
| P3 | Continue on this device | ✅ | Handoff: opening ah offers the session you were just using on another device. |
| P4 | Drafts follow you | ✅ | An unsent composer draft is kept per session on the host: start on the phone, finish at the desk, survive reloads. |
| P5 | GUI by default where it reads better | ✅ | Phones open agent sessions in the GUI unless you chose otherwise. |
| P6 | One visual language | ✅ | One keycap style (platform aware), status pills, clean model names, no duplicated header meta. |
| P7 | Native permission prompts | ✅ | Edit approvals render with the GUI's own diff; the tool row says it is waiting for you, not "Running". |
| P8 | App badge | ✅ | Home-screen/installed app icon carries the needs-you count. |
| P9 | Motion | ✅ | Consistent, quick transitions between pages, sessions and panels; reduced motion respected. |
| P10 | Inbox and History polish | ✅ | Aligned columns, actions on hover/focus, tidier rows. |
| P11 | New session knows where you are | ✅ | Starts in the focused session's project with the last harness and model you used. |
| P12 | Desktop app | ✅ | `ah setup desktop` / Settings → System: an Omarchy web app (Super+Space), a Hyprland bind to copy, `ah open` from tmux. |
| P13 | Continue in another agent | ✅ | Session menu row and palette: a new session on another harness, primed with this conversation's transcript. |
| P14 | Honest tool states | ✅ | A call the turn ended without shows No result, not Running… forever. |
| P15 | Phone chrome | ✅ | Tabs that fit, edge fades on tabs and key bar, "Shell · project" subtitles, clean titles. |
| P16 | Instant first paint | ✅ | The session list paints from the encrypted cache before the stream answers; an empty inbox offers recent conversations. |
| P17 | Which-key | ✅ | Hold Ctrl+Alt / Ctrl+Shift to see what each key does right now. |
| P18 | Lean wire | ✅ | State streams as patches of changed fields: ~740 → ~195 KB per 15 s with one busy session. |
| P19 | Lean boot | ✅ | Terminal, markdown, passkeys, Settings load on demand: main script 333 → 147 KB gz; throttled phone first paint 984 → 592 ms, ready 1301 → 885 ms. |
| P20 | One scale | ✅ | Type ramp, radius scale, four weights, one scrim, enforced by test/design.test.ts. |
| P21 | One motion | ✅ | One curve, two durations; sheets and menus arrive, buttons press in; one reduced-motion rule. |
| P22 | Settings as one system | ✅ | Titled cards everywhere, readable activity log, honest host chip. |
| P23 | Tiling that moves | ✅ | Split panes placed flat (no remount: terminals stay live through split/close/maximize) and animated from their old tile (FLIP); split grows out of the single view, closing grows the last pane into it. |
| P24 | Direction | ✅ | One gliding selection highlight per list (Glide.tsx); views arrive from where they are: down/up the sidebar, iOS push/pop on phones, workspaces slide sideways. |
| P25 | Lists that move | ✅ | useFlip: rows glide between sections as status changes, new rows fade in; status dots pop on change. Fixed a reorder race that could restore the old sidebar order. |
| P26 | Surfaces with an origin | ✅ | Menus/popovers grow from their button, steps and disclosures unfold, toasts rise and sink, palette levels slide by depth, new GUI steps rise in. |
| P27 | New project | ✅ | Sidebar "Projects +", palette and the dialog's New folder chip: name a folder in the projects root, optional `git init`, and start any agent in it. A path that doesn't exist yet says what Start will create; ah only creates one level, inside `files.roots`. |
| P28 | Type | ✅ | Every root page has the large title with the pink full stop. Inline code is smaller and keeps its corners when it wraps. Counts and times use tabular figures. Headings balance. Touch devices drop keycap hints. |
| P29 | Depth | ✅ | Floating layers share one frosted surface and two elevation steps (`--elev-1/2`, `--glass`). The GUI composer lines up with the conversation column on the same ground. |
| P30 | Controls | ✅ | Chips, segments and send dip when pressed. Send is the primary pink. Selects share one chevron and checkboxes take the brand. The Files toolbar uses icons instead of emoji. Side panel tabs are in sentence case so six fit. |
| P31 | Lists | ✅ | History times are flush right and swap to actions on hover. Idle dots are gone. Status pills read the same in the header and the inbox. The question card's "Something else" row is aligned. |
| P32 | Phone and light | ✅ | The OpenAI and Grok marks show on the light theme. Light menus are near-solid. New session shows an even agent grid. Phone menus fit on screen. |
| P33 | Touch | ✅ | History rows resume on tap and keep Fork and Hide behind ···. Menus close on an outside tap or Esc (useDismiss). Sidebar grips hide on touch, and ··· shows on the current row only. Rows darken under the finger. Small icon buttons get 44px targets. A narrow page drops the inbox Detail column (an iPad in portrait). |
| P34 | Phone shell | ✅ | The tab bar has icons over labels on frosted glass, and lists scroll under it. Settings' highlight is fixed on narrow screens. Rows show "needs you" and "working" status. |
| P35 | Action sheet | ✅ | On a phone the session ··· menu rises from the bottom with 48px rows. Tapping the scrim closes it without the tap reaching what's underneath. |
| P36 | Large titles | ✅ | Scrolling a root page reveals a compact frosted bar with its name. It is a sticky `::before` driven by a scroll timeline, with no script, and hidden when the page can't scroll. |
| P37 | Swipe back | ✅ | On a phone, an edge swipe leaves a session (useSwipeBack): the view follows the finger, commits past ⅓ or on a flick, and the list comes forward. It never starts in the terminal or a text field. |
| P38 | Touch sizing | ✅ | Touch-only devices drop key hints. Segments and chips are 36px, question options 48px, iPad menu rows 44px. The switcher has a short prompt on touch. Links use the accent color. |
| P39 | Swipe back, underneath | ✅ | Swiping back shows the page under the session, set back and dimmed like the pop transition, and moves it with the finger, so the swipe and the slide are one motion. It also works over a full-screen terminal: the hook listens in the capture phase and keeps a swipe's moves from the terminal. |
| P40 | Floating tab bar | ✅ | The phone's tab bar is an iOS 26 glass capsule, inset from the sides and floating just above the home indicator. |
| P41 | Sheets | ✅ | On a phone every modal except confirmations covers the screen, rises from the bottom, scrolls inside, and has a grabber and an X (sheet.tsx). Drag it down by the bar, or by its content once scrolled to the top, to close it. New session rises the same way. Settings is a sheet over the page it was opened from. |
| P42 | 44pt targets | ✅ | Every phone control is at least Apple's 44pt minimum: nav-bar circles, view tabs, Settings' sections, agent choices and keys. Chips keep their size with larger hit areas. Nav icons are 22px and tab icons 24px. |
| P43 | Action sheet, iPhone style | ✅ | The session menu is grouped, with Cancel apart in the tint color. It drags down to close, and slides away on Cancel or a scrim tap. |
| P44 | Your messages rail | ✅ | The GUI's left edge has a tick per message you sent; the lit one is the turn in view. A tick scrolls its message to the top (hover or arrow keys show its text). Past 15 the rail becomes a window that follows the scroll, its edges fading. Hidden on a phone. |
| P45 | Settings without the terminal | ✅ | The GUI's Permissions rows switch the mode: live on Claude Code (Shift+Tab pressed until its footer shows the mode), else, or for bypass in a session not launched with it, a relaunch of the conversation in it. The check shows the mode the footer says is on, not the launch flag. Default model and effort reset with `/model default` and `/effort auto`; the terminal picker shows only when ah has no list. Also in the palette. |

### Trust and coherence pass (12 October 2026)

From a product review and a live run of real Claude Code sessions through a
throwaway ah, on desktop and phone.

| # | Item | | Notes |
|---|---|---|---|
| T1 | Registry after migrations | ✅ | Sessions load once the schema is migrated and legacy state imported; a failed load stops ah instead of starting empty (which would re-register live windows under new uids). |
| T2 | Screen-rule audit (F18) | ✅ | Every prompt a hook reports also tests the screen rules hookless sessions use (`server/audit.ts`); Settings → System shows caught/missed per harness with the last missed screen. |
| T3 | Usage limits | ✅ | Claude's session/weekly and Codex's usage-limit notices read as a "limited" pill with the reset time, and notify as such; the notice counts only until the reset. Auto-resume (F40) stays open. |
| T4 | One status vocabulary | ✅ | needs you / working / done (new output for shells) / idle / limited, from `web/status.ts`, in rows, headers, sections and taglines. |
| T5 | No terminal leakage | ✅ | Idle shells show the command they last ran, not their prompt (foreground process group, a little scrollback). Screen prompts are unwrapped prose; picker labels rejoin wrapped paths; tool names, upload paths and tool-call JSON read as words. |
| T6 | Back | ✅ | Pages and sessions are history entries; the chevron, edge swipe and Settings sheet go through history.back(). |
| T7 | Shells vs agents | ✅ | Shells don't offer Fork, Queue or Snapshots. |
| T8 | Devices | ✅ | Name this device (Security); the GUI counts as viewing (seen state, "On Desk too"). Sign-in off is stated, not half-shown. |
| T9 | GUI honesty | ✅ | Pending calls in the present tense (Edit, Run), project-relative paths, the feed stays pinned when the queue tray or a diff resizes it, the model chip shows the running model, a new turn clears the last turn's detail. |
| T10 | Snapshot restore | ✅ | A failed restore says whether files are back or half-restored (and which safety snapshot to use); an agent that wasn't told about a rollback is flagged. |
| T11 | Browser smoke suite | ✅ | `pnpm test:ui` (test/ui): the built page on desktop and phone against a throwaway ah, including a stand-in claude's prompt answered from the inbox; its own CI job. |

### Test-drive pass (13 October 2026)

The production page driven in a headless browser by keystroke, click and
touch, with in-page instrumentation (focus after every action, toasts,
animations, long tasks, layout shifts, Event Timing), at 1x and 4x CPU.

| # | Item | | Notes |
|---|---|---|---|
| D1 | Focus lands where you are | ✅ | Dialogs give focus back; a session claims the keyboard until it lands (lazy surfaces, view transitions), including the GUI composer on first load (14ms, was ~320); split panes take it whatever they hold; arrows enter an unfocused page's list; lists keep your place when an item goes; pickers open on the current choice. |
| D2 | Keyboard everywhere | ✅ | Pane commands on chooser panes; New session as a radio group with arrows; History "/" and Escape; Ctrl+Shift+9 on pages; optimistic rename. |
| D3 | Terminal pool | ✅ | A terminal you leave is parked 4s; showing that window again adopts it: no blank pane mid-split, switching back paints in ~15ms; "Attaching…" only after 400ms. |
| D4 | Calm | ✅ | Toasts at the top, timed by length, only for what you can't see; status dots and pills pop on change only; no workspace toast with the sidebar open. |
| D5 | Speed | ✅ | No full-screen scrim blur (search keystroke to paint 40 → 16–24ms); one date formatter and content-visibility for History (reopen long task 65ms → none); palette scrolls its list only when needed; reduced motion creates no transitions. |

Measured, not changed: a new session's xterm costs ~12ms at 1x (~47 at 4x)
to measure and lay out; palette and switcher filtering ~40ms per key at 4x.

### Polish pass (14 October 2026)

A throwaway ah with fake Claude agents (long transcripts, a permission prompt,
busy, resume), driven in Chromium on desktop, iPad and iPhone emulation by
keyboard, mouse and touch, plus two low-cost model testers on scripted
journeys. Details and repros: `docs/polish-audit.md`.

| # | Item | | Notes |
|---|---|---|---|
| Q1 | Long names | ✅ | Project names ellipsize in Inbox columns, sidebar groups, section headings and New session chips; hover actions replace the sidebar's model label. |
| Q2 | No repeated context | ✅ | Rows under a project heading don't name it again; a row without detail gives its title the Detail column; the permission chip names the mode that's on. |
| Q3 | Keyboard | ✅ | Palette rows carry agent logos; the shortcut table shows this platform's keys and per-row actions on hover; New session's agent grid wraps with Home/End; a project's bare name picks it. |
| Q4 | Answer from the Inbox | ✅ | The keys drawn on a prompt's choices work from anywhere on its card; focus stays on the answer. |
| Q5 | Phone header and composer | ✅ | The status leads the subtitle so the title keeps the row (live and ended alike); chips and actions share a line when they fit; touch placeholders name no keys; Continue in labels its agents. |
| Q6 | Truthful presence | ✅ | A page counts once among a session's viewers, however many connections it holds: switching views no longer shows "On <this device>". |
| Q7 | Plain errors | ✅ | An unreachable host reads as such ("Failed to fetch" before), in every browser's wording. |
| Q8 | Keys go where you look | ✅ | New session keeps the keyboard when opened right after a session (keys went into the hidden terminal); Send keeps focus in the composer; a double tap on Send can't stop the turn it queued. |
| Q9 | Safe defaults | ✅ | Send to… never preselects a shell. |
| Q10 | Contrast and empty states | ✅ | Light theme secondary text meets AA (guarded by test/design.test.ts); phone Sessions and History say what to do when empty; a clipped Files path fades. |

Measured, not changed: switching GUI sessions shows the new title in 10–20ms
at 1x and 40–90ms at 4x CPU, CLS 0; 40 sessions at 4x load in ~0.9s with
switcher filtering at 20–30ms per key.

Next candidates: rate-limit auto-resume (F40, opt-in; the reset times are
now parsed), quota display (F41), keyboard reordering in the sidebar.

### Agents that keep up (14 October 2026)

| # | Item | | Notes |
|---|---|---|---|
| A1 | More agents | ✅ | Cursor Agent, Copilot, Crush and pi, from their own `--help`; terminal-only (no transcript adapters yet). New session offers what's installed. |
| A2 | Settings that follow the CLI | ✅ | `server/harnesses.ts`: a new CLI version has its `--help` read; the choices for the preset's mode and effort flags replace the written ones (new appear, dropped go, known keep their words). Checked at start and hourly; Settings → Agents shows what changed and checks on demand. |
| A3 | The host's own list | ✅ | Settings → Agents hides an agent from New session, and adds any agent CLI by its command (a dropdown offers known ones found on PATH). |

Next: transcript adapters (GUI view) for the new agents; live model lists for
Cursor (needs sign-in), Crush (configured providers only) and opencode.

Remaining larger work: conversation transfer between hosts (including files),
worktree disk usage, and richer adapters for agents without hooks. These require explicit
product decisions rather than guessing at conversation or workspace ownership.

## Phase 8 — Feature freeze (from 17 October 2026)

No new features. Every shipped feature is specified in
[docs/spec/](docs/spec/README.md), reverse-written from the code and the
running product, with IDs (FND, SES, ATT, VIEW, WS, KEY, CON, SET, CLI, PLT,
DS). Work until the freeze lifts:

| # | Item | | Notes |
|---|---|---|---|
| Z1 | Specification | ✅ | `docs/spec/`: vocabulary, invariants, 11 domain files. |
| Z2 | Consistency audit | ✅ | `docs/spec/audit.md`: parity matrix, vocabulary drift, 29 findings (A-01…A-29) with severity and resolution. |
| Z3 | Behaviour fixes | ✗ | The audit's "fix now" list. |
| Z4 | Redesign | ◐ | Designed: the ah design system (28 components, both themes) and a canvas of every screen on desktop and phone, in Claude Design (links in `docs/spec/11-design-system.md`). Next: implement it, one token file (A-17). |
| Z5 | Owner calls | ✗ | A-09 CLI parity, A-13 keycaps off Mac, A-26 New session's default. |

Stack review landed on 17 October at the owner's call, outside the freeze; its spec is `docs/stack-review.md`.

## Stack review (16 October 2026)

PR stacks reviewed one layer at a time, fixed by the agent that wrote them,
merged in order. Design and decisions: `docs/stack-review.md`. Server in
`server/review/`, page in `web/review/`.

| # | Item | | Notes |
|---|---|---|---|
| R0 | Pinned revisions | ✅ | PR heads and bases fetched into `refs/ah-review/<stack>/`, never a checkout; `patch-id` tells rebased from changed; `range-diff` shows what changed since a review; reviewed revisions pinned through force-pushes. |
| R1 | Read and discuss | ✅ | Stacks are trees from GitHub's base→head links; a first merge order puts small branches before the long chain; a plan file's owner table labels layers. Briefings per patch (background, cached), a reviewer per layer and per stack on side chat's subscriptions and tool loop, with tools that read exact revisions. |
| R2 | Findings → fix → re-review | ✅ | Findings from a diff line, the reviewer (proposals to keep) or GitHub threads (Codex's P-levels as severity). Sent as one drafted message to the stack's owning conversation through the normal send path (queue, resume), with the restack of the layers above. The watcher sees the turn end and the head move; a re-check judges each finding; Inbox card and push. |
| R3 | Merge & next | ✅ | Gates re-checked on a fresh sync; `gh pr merge --match-head-commit`; layers on the merged branch retargeted to the trunk (squash/rebase marks them for a restack, an agent dispatch). Activity log entries for merge, retarget, ready, resolve, dispatch. |
| R3b | Stacks you pick, and the redesign | ✅ | 17 October. *New stack* lists a project's open PRs with checkboxes; you order them (chains grouped, a PR above its base flagged) and they're reviewed and merged as one stack, branches stacked or not. Add or take out PRs later. Screens redesigned on a Claude Design canvas first: list with project cards, a stack spine, an Up next card, the merge order table, the reviewer in a drawer, a layer with the spine folded to labels. Then built to the canvas: finding cards with severity and the reviewer's verdict, send under the findings, boxed diff files with inline finding cards, a plan reader; and the spec's waivers with a reason, who-and-when on every finding, follow-ups from merged layers. Landed on `main` on 17 October. |
| R3c | The stack on GitHub | | Optional, explicit: write the stack's list into each PR's description, the current one marked, as Sapling does, so the stack shows on GitHub. Read the same block (and Sapling's) back to offer a stack in the picker. |
| R4 | Breadth | 🟡 | GitHub's own stacks (GA 6 October) ✅: read from the Stacks API on every sync; a layer merges through GitHub's stack merge (`merge-async`, at the reviewed head) with the layers under it, gated on them; GitHub retargets and rebases the rest; a branch off the one under it needs a restack; merging and queued states; messages to the agent use `gh stack`; *Review this stack* in the picker starts a review that follows a stack on GitHub. Peer hosts' stacks in the local page. |
| R5 | Pictures and the record | | A cited `mermaid` widget for before/after flow; a completion report when a stack closes. |

Measured against Vest's real ten-layer stack (read-only, in a scratch clone):
the tree, merge order H0 → O13/O14/O15 → F1…O10, plan labels and Codex
threads all came out right; the first fetch of ten layers takes ~25s, so a
new stack opens at once and fills in.

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
