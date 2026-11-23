<!-- Imported from port/agent-hub-uikit-port-audit.md; original SHA-256 recorded in SOURCE.json. -->
> **Local reconciliation — 23 October 2026.** Source `../ah` is at `be111749eea838c0103293ced5821cb843981439`, exactly the supplied audit baseline. The implementation mission is [SPEC.md](SPEC.md). All web/server/product-spec paths below refer to the sibling source checkout. Original audit body follows this note.
>
> The port ZIP contains byte-identical copies of the loose audit and mission. This workspace imports one canonical copy of each as root `AUDIT.md` and `SPEC.md`; no archive or duplicate `docs/port` tree is carried over. A SHA-256 scan of 388 non-generated source files found 0 nonempty exact-duplicate groups. Similar implementations were not automatically deleted: for example, web GUI and review Markdown renderers have different roles and need semantic assessment during porting.
>
> Executing the actual `web/shortcuts.ts` catalog yields **89 unique commands**, consistent with this audit and superseding the older spec count of 84. All nine settings sections and the current Origin/X-AH/Serve and PTY boundaries were cross-checked. Source references are pinned by file hashes in [SOURCE.json](SOURCE.json).
>
> The prepared workspace contains UIKit/SwiftUI/Observation groundwork, local GRDB scene metadata, terminal frame types, tests and a generated-project recipe. Native auth, live data, APNs, a terminal engine and full restoration are not implemented. Linux has no Swift/Xcode here: no native build or simulator run is claimed. Detailed native progress and blockers are in [PARITY.md](docs/native/PARITY.md), [RISKS.md](docs/native/RISKS.md) and [TEST-MATRIX.md](docs/native/TEST-MATRIX.md).

# Agent Hub (ah) — UIKit Port: Codebase Capability Audit

**Audit baseline:** `ealush/agent-house`, `main` at commit `57770d9ab723be3ac8b97b5991fde536c977bce8` (latest available commit, 19 October 2026). **Audit date:** 23 October 2026.  
**Source:** actual GitHub repository tree and sampled implementations, cross-checked against `docs/spec/01–12`, `docs/spec/audit.md`, `web/api.ts`, `web/reviewApi.ts`, `web/shortcuts.ts`, Settings components and backend security.  
**Method limitation:** source audit only. No running iOS build, browser session, Xcode compilation, on-device test or complete execution of all source branches. “Shipped” means the code/spec implements it, not that I personally verified it in production. Some adapter formats have documented-but-not-real-install-verified limitations.

## Executive findings

The native target should be a **UIKit iOS + iPadOS client** for the *existing* Node/tmux/Git/SQLite service on the Omarchy/Linux host. The iPhone and iPad should not become tmux hosts. Preserve the server and working web desktop app. This is an **interface/transport/security-client port**, not a rewrite of agents, Git operations, review logic or transcript adapters.

**Most valuable day-one behaviors**: attention Inbox, session list and navigation, reliable agent responses/approvals, structured GUI transcripts and composer, persistent queue and urgent steering, full terminal including reconnect and keys, saved history/resume, trustworthy state/notifications, authenticated connection, drafts/handoff. For iPad: split workspace and full physical-keyboard command model are high priority, not optional decoration. Review/stack workflow is a major differentiator and should make the first real release, ideally in a subsequent phase after the core is proven.

**High-risk native interfaces**: (1) `server/gate.ts` requires browser-like exact Origin on *writes and WebSocket upgrades*; direct native URLSession and WebSocket do not naturally operate like same-origin web pages. (2) Current WebAuthn registration/login is associated with a private `.ts.net` web origin; native AuthenticationServices passkey support needs an appropriate associated domain/credential flow. (3) Web Push and PWA app badging do not translate to APNs and native badges without backend work. (4) Embedded dev-server previews depend on cookies/identity, extra Tailscale Serve ports and cross-origin framing; they need an explicit `WKWebView` strategy. (5) xterm.js is not a UIKit terminal; a native ANSI/PTY renderer, keyboard bridge, resizing and tmux protocol adapter are necessary.

**Inventory discrepancy:** `docs/spec/06-keyboard.md` states 84 commands, but `web/shortcuts.ts` defines 71 static command IDs plus dynamically generated workspace-1…9 and send-to-workspace-1…9 = **89 commands**. The native port should treat the actual catalog as canonical.


### Ranked top 20 user journeys for the port

This is the **subjective product-priority ranking**, distinct from implementation difficulty. It reflects an attention-first, mobile-first, keyboard-first personal agent hub, not a generic terminal app.

| Rank | User journey / capability | Target | Why it is above the next item |
|---:|---|---|---|
| 1 | Needs-you Inbox + accurate state + one-tap safe answers | iPhone/iPad | The reason to check ah remotely |
| 2 | Durable multi-agent session navigation and presence | iPhone/iPad | Your agents become a single place |
| 3 | GUI transcript reading with tool states, Markdown and rich results | iPhone/iPad | Most interactions should not require terminal literacy |
| 4 | Reliable composer, send/queue/steer/interrupt, optimistic feedback | iPhone/iPad | Interaction must actually reach the agent |
| 5 | First-class native auth, secure access and revocation | iPhone/iPad | All other functions depend on it; remote shell is high trust |
| 6 | Full native terminal with keyboard, reconnect and exact resize | iPhone/iPad | Universal escape hatch, works for unsupported agents |
| 7 | Drafts, handoff, deep links, ended sessions and resume | iPhone/iPad | Continuity is the product's distinguishing property |
| 8 | Actionable APNs notifications and badge | iPhone/iPad | Supervising agents while app is suspended |
| 9 | iPad hardware keyboard, command palette and focused action routing | iPad | The recent 10× ergonomics improvement must survive |
| 10 | iPad panes, workspaces, pane focus/resize and scratchpad | iPad | True work environment rather than oversized phone |
| 11 | Stack-aware PR review, reviewer chat and request-fixes loop | iPad/iPhone | High-stakes daily architectural decisions |
| 12 | Exact-head merge & next, findings/checks/re-review | iPad/iPhone | Complete safe work-to-land flow |
| 13 | New session/project, preset/model/effort/permissions | iPhone/iPad | Start/redirect work remotely |
| 14 | History, search and conversation turn navigation | iPhone/iPad | Find and recover prior work |
| 15 | Files, code diff and line-anchored feedback | iPad/iPhone | Review code and steer implementation without Mac |
| 16 | Native touch/pointer quality, sheets, gestures, haptics | iPhone/iPad | Makes the port materially better than PWA |
| 17 | Developer preview with HMR and safe auth | iPad/iPhone | See what agents built without leaving ah |
| 18 | Fork / continue in / send to / snapshot rollback | iPhone/iPad | Advanced agent workflows |
| 19 | Side chat and provider selection | iPhone/iPad | Independent architectural Q&A and handoffs |
| 20 | Worktrees, environment and system admin | iPad/iPhone | Operational completeness rather than primary loop |

**Lowest priority / do not port verbatim:** web PWA manifest and service worker; Safari viewport-shim/checkbox-haptic tricks; Omarchy `.desktop` launcher control; `pnpm` web rebuilding UI; raw CLI/shell implementation on-device; host-only config edits; speculative architecture visualization not yet shipped. Preserve those capabilities where they belong (host/web) instead of imitating them in UIKit.

### Priority key

- **P0 — Functional survival / trust:** without this, native is not a usable replacement for the mobile app.
- **P1 — Daily-driver parity:** essential to the differentiated premium experience, especially iPad and heavy review work.
- **P2 — Full parity:** important existing workflows; can follow once the core is solid.
- **P3 — Host/admin or browser-only:** retain in web/CLI, offer deep link or native equivalent only if valuable.
- **Surface:** **F** phone, **I** iPad, **D** desktop web, **H** host/CLI. Native target F/I; desktop capabilities listed to avoid losing iPad functionality.

## A. Foundation and shared session model

| Priority | Capability (today) | Surface | Native implementation / portability | Code |
|---|---|---|---|---|
| P0 | One remote control plane; Node daemon bound to loopback; persistent tmux agents | F/I/D/H | **Retain server unchanged in intent**; native is a client | `server/main.ts`, `server/core.ts`, `server/tmux.ts` |
| P0 | Stable uid for session across tmux window replacement, restart and resume; multi-host `host/uid` | F/I/D | Canonical native identity and navigation routes; never key on window `@N` | `server/registry.ts`, `web/sessionKeys.ts` |
| P0 | State reconciliation ~1.5s and SSE initial full snapshot plus patches; polling/recovery | F/I/D | URLSession SSE parser + typed Codable state store, patch ordering and wake reconnect | `web/api.ts` `subscribe`, `web/useHosts.ts`, `server/core.ts` |
| P0 | States: waiting/needs you, busy/working, attention/done/new output, idle, limited/reset, ended, starting, unavailable | F/I/D | Consistent states, temporal correctness, accessible labels | `server/sessions.ts`, `web/status.ts`, `docs/spec/01-foundation.md` |
| P0 | Hook-derived ask details, process/screen fallback, current activity text, unread/viewed state | F/I/D | Preserve server decisions, don't reclassify in UIKit | `server/sessions.ts`, `server/choices.ts`, `web/askView.ts` |
| P0 | Multiple devices view same tmux process independently; last writer controls tmux size | F/I/D | Multiple viewers/identity and focus; respect independent terminal sockets | `server/terminal.ts`, `server/tmux.ts` |
| P0 | Persisted conversations, host registry, transcript identity; session remains after process death | F/I/D | Resume-in-place and ended-session render model | `server/discovery.ts`, `server/registry.ts`, `web/Ended.tsx` |
| P0 | Native-safe authentication, device revocation and network trust | F/I | **Backend contract change required**; do not weaken Host/Origin/Tailscale checks | `server/gate.ts`, `server/auth.ts`, `web/auth.ts`, `SECURITY.md` |
| P0 | Multi-host hub merges state, proxies peer HTTP/SSE/WebSocket under `/h/<host>` | F/I/D | One hub connection, base URL routing, host-scoped sessions, host online/offline | `server/peers.ts`, `web/useHosts.ts` |
| P1 | Registered/present devices, "On Desk too", viewed status, focus/handoff | F/I/D | Presence/focus lifecycle with scenes, not accidental device duplication | `server/terminal.ts`, `web/Handoff.tsx`, `web/handoff.ts` |
| P2 | Live catalog/preset updates based on agent CLI versions; hooks and discovery | F/I/D/H | Server-side only; native consumes presets/harnesses | `server/harnesses.ts`, `server/catalog.ts`, `server/hooks.ts` |
| P3 | CLI/script protocol (`ah list/new/attach/send/wait/read/answer/stop/...`) | H | Retain independent host CLI, not port CLI to iOS | `bin/cli.js` |

## B. Sessions — creation, steering and lifecycle

| Priority | Capability | Surface | Native behavior / important nuance | Code |
|---|---|---|---|---|
| P0 | List all active sessions grouped by project, host or status | F/I/D | Status-first, same title/detail everywhere | `web/Inbox.tsx`, `web/Sidebar.tsx`, `web/TabBar.tsx` |
| P0 | Open/select a session from lists, Inbox, History and switcher | F/I/D | Keyboard/pointer/touch and deep-link restoration | `web/App.tsx`, `web/Switcher.tsx` |
| P0 | New session: Shell/Agent; choose installed available preset, project, machine | F/I/D | UIKit creation sheet or contextual pane; proper defaults | `web/NewDialog.tsx`, `server/launch.ts` |
| P0 | New session: model, custom model id, reasoning effort, permission mode | F/I/D | Preserve dangerous-mode warnings; supported choices from live presets | `web/NewDialog.tsx`, `web/ModelPicker.tsx` |
| P0 | Optional initial prompt; sends when new session ready | F/I/D | Explicit delivery state; avoid duplicate send | `web/useLaunch.ts`, `server/core.ts` |
| P0 | Message delivery: type now / answer if waiting / queue if busy / resume if ended | F/I/D | Native UI must never imply accepted when merely queued/pasted | `server/core.ts`, `web/Composer.tsx`, `web/outbox.ts` |
| P0 | Stop/interruption (Escape for agent, Ctrl-C shell), correctly settle state | F/I/D | Stop button/keyboard; distinguish cancellation vs terminate | `server/core.ts`, `web/Composer.tsx` |
| P0 | Answer permission prompts Approve/Deny; choices/cursor pickers | F/I/D | Live screen re-validation, no stale replies, differentiate approval vs text reply | `server/choices.ts`, `web/AskPanel.tsx` |
| P0 | Multi-question elicitation forms; custom answers and submit | F/I/D | Native form with correct selection and final confirmation | `web/AskPanel.tsx`, `server/choices.ts` |
| P0 | Persistent follow-up queue and queued-message count | F/I/D | Queue tray and dedicated queue UI | `server/queue.ts`, `web/QueueTray.tsx` |
| P0 | Queue: Send now (interrupts current turn), Edit, Cancel, Cancel all | F/I/D | Maintain ordering and at-most-once semantics | `web/Queue.tsx`, `web/QueueTray.tsx` |
| P0 | Queue drag-to-reorder | F/I/D | Native reorder via drag/drop/edit mode and keyboard | `web/QueueTray.tsx`, `server/queue.ts` |
| P0 | Ended session stays visible with Resume; typing resumes and sends | F/I/D | No navigation bounce on process exit | `web/Ended.tsx`, `server/core.ts` |
| P1 | Agent-native live model/effort change, mode cycling, fallback relaunch with same conversation | F/I/D | Clearly distinguish live change, restart, or terminal picker; truthful displayed value | `web/Composer.tsx`, `server/core.ts` |
| P1 | Rename session inline; pin/unpin; shared session ordering | F/I/D | Reorder list, host persistence, state updates | `web/Sidebar.tsx`, `web/Session.tsx` |
| P1 | Fork conversation to new id + isolated git worktree, optional prompt/choices, lineage | F/I/D | Native fork sheet; fork only where supported | `web/ForkDialog.tsx`, `server/fork.ts` |
| P1 | Continue conversation in another agent (transcript priming) | F/I/D | Agent picker; copy context without pretending same provider session | `web/Session.tsx`, `server/core.ts` |
| P1 | Send to another agent/session: last reply or subscription summary | F/I/D | Context handoff dialog, target matching project | `web/SendToDialog.tsx`, `server/sidechat.ts` |
| P1 | Slash autocomplete (`/`) and project file mention (`@`) | F/I/D | Native text input + suggestion overlay, insertion respecting cursor | `web/Suggest.tsx`, `web/Composer.tsx`, `server/complete.ts` |
| P1 | Attach local files, image paste/drop, upload paths into prompt | F/I/D | Photos, Files picker, camera/paste, upload progress, bounded size | `web/Composer.tsx`, `web/uploads.ts`, `server/files.ts` |
| P1 | Dictation/mic; keep composer focus and keyboard when sending | F/I/D | UIKit dictation via system keyboard; optional speech action | `web/Composer.tsx` |
| P1 | Recent prompts (cross-device), compose/edit, shift-enter multiline, empty Enter steers queued top | F/I/D | Explicit send semantics for hardware/software keyboards | `web/Composer.tsx`, `server/prompts.ts` |
| P1 | Saved unsent draft per session across devices (source device), 14d expiry | F/I/D | Keyboard-conflict policy, debounce, no stale-overwrite; native scene identity | `server/drafts.ts`, `web/useDraftSync.ts` |
| P1 | Session/branch selector, new branch, dirty marker, PR link | F/I/D | Contextual native menu | `web/Git.tsx`, `server/git.ts` |
| P1 | Terminate session with confirmation (record stays in History) | F/I/D | Distinguish terminate/stop/forget | `web/Session.tsx`, `server/core.ts` |
| P2 | Custom tmux session/name; launch args; optional continue/isolated worktree; multi-host create | F/I/D | Disclosure / advanced launch sheet | `web/NewDialog.tsx` |
| P2 | New project folder (one level within root) + optional `git init` | F/I/D | Project sheet; avoid arbitrary path creates | `web/NewDialog.tsx`, `server/files.ts` |
| P2 | "Run in project" command hierarchy | I/D | Command palette with project→agent/shell | `web/palette.ts` |
| P2 | Hide ended/saved record from History without deleting transcript | F/I/D | Context menu with clear semantics | `web/HistoryView.tsx` |
| P2 | Copy attach CLI command, direct terminal scrollback text and copy-last-reply | F/I/D | Share/copy actions, native clipboard | `web/Session.tsx`, `web/TerminalSurface.tsx` |
| P3 | Host-owned update installed agent CLIs, version detection | H | Settings controls optional; no local iOS CLI installs | `server/harnesses.ts`, `web/AgentsSettings.tsx` |

## C. Read surfaces: terminal, transcript, Inbox, Search

| Priority | Capability | Surface | Native treatment / issue | Code |
|---|---|---|---|---|
| P0 | Full interactive terminal with ANSI/Unicode, text selection, copy/paste, links | F/I/D | Native terminal emulator; raw WS bytes and input/resize contract | `web/Terminal.tsx`, `server/terminal.ts` |
| P0 | Terminal attach/re-attach on network loss, live resize and immediate redraw | F/I/D | Preserve tmux viewer semantics and reconnect limits | `server/terminal.ts`, `web/Terminal.tsx` |
| P0 | Touch terminal scrollback, on-screen key bar Ctrl/Alt/Shift, Esc/Tab/arrows/paste | F/I | Native terminal gestures and toolbar; system keyboard compatibility | `web/KeyBar.tsx`, `web/Terminal.tsx` |
| P0 | GUI transcript typed feed snapshot/append/paging, switches without restarting agent | F/I/D | Codable event model + native diff/message/tool renderer + pagination | `server/feed/schema.ts`, `web/gui/useFeed.ts`, `web/gui/reducer.ts` |
| P0 | GUI user/assistant bubbles, Markdown/GFM, tables, links, fenced code/copy | F/I/D | Native text system; correct long-code scrolling and copy | `web/gui/GuiSurface.tsx`, `web/gui/CodeBlock.tsx` |
| P0 | GUI tool events with statuses, expandable args/results, command output, diffs, plans/checklists | F/I/D | Structured native cards; do not flatten into raw text | `web/gui/tools.tsx`, `web/gui/router.tsx` |
| P0 | Pending/waiting/finished/no-result and hidden/visible reasoning/tool steps | F/I/D | Trustworthy state and optional compact reading mode | `web/gui/steps.ts`, `web/gui/GuiSurface.tsx` |
| P0 | Inbox: needs-you cards with same AskSummary and options as session; working/idle/done groups | F/I/D | Primary launch surface; one-tap approval/deny | `web/Inbox.tsx`, `web/AskPanel.tsx`, `web/askView.ts` |
| P0 | Status badges, session detail, unread, elapsed-time updates, usage-limit notices | F/I/D | Shared native SessionRow and Status model | `web/status.ts`, `web/sessionLine.tsx` |
| P1 | GUI: optimistic outbox messages until in transcript; live working timer | F/I/D | No duplicate bubbles, preserve request ordering | `web/outbox.ts`, `web/gui/GuiSurface.tsx` |
| P1 | GUI: message rail tick per user prompt, jump to previous turns; Browse messages | I/D | Native indexed jump; optional compact phone alternative | `web/gui/MessageRail.tsx`, `web/gui/GuiSurface.tsx` |
| P1 | History: registered ended + discovered sessions, filter, resume, fork, hide | F/I/D | Search/filter; lazy pagination | `web/HistoryView.tsx`, `server/discovery.ts` |
| P1 | Switcher: live/history/content matches; fuzzy search, scoped query tokens; open at turn | I/D/F via Commands | Native searchable command/search overlay | `web/Switcher.tsx`, `server/search.ts` |
| P1 | Content search full-text over agent transcripts and side chats, across hosts | F/I/D | Search screen with scope, speaker, project/host/model and dates | `web/SearchView.tsx`, `server/search.ts` |
| P1 | Generative UI widgets: card, choices, table, checklist, stats, bar-chart, progress, links, image, code, diff | F/I/D | Native typed widget renderer; unknown JSON degrades to text; URL/path safety | `web/gui/widgets.tsx`, `docs/gui.md` |
| P1 | Agent asking: command, permission, edit diff, multi-choice form, unsupported picker fallback to Terminal | F/I/D | One native Ask surface in all contexts | `web/AskPanel.tsx`, `web/gui/tools.tsx` |
| P1 | Blank GUI and empty Inbox offer recent conversations | F/I/D | Appropriate recovery entry point | `web/Inbox.tsx`, `web/gui/GuiSurface.tsx` |
| P2 | Terminal scrollback as selectable text; selectable last screen when ended | F/I/D | Native copy/select alternative | `web/TerminalSurface.tsx`, `web/Ended.tsx` |
| P2 | Cache newest GUI page and session list encrypted per signed-in browser, fast first paint | F/I/D | New native **Keychain-bound encrypted** cache; do not reuse IndexedDB mechanics | `web/gui/feedCache.ts`, `web/useHosts.ts` |
| P2 | Inline GFM specialized GitHub rendering of descriptions/review threads | F/I/D | Secure Markdown+safe HTML subset and private image proxy | `web/review/GitHubText.tsx` |
| P2 | Cached scroll position, session recentness, keyboard focus/selection state across navigation | F/I/D | Native continuity behavior, no wrong input target | `web/App.tsx`, `web/Terminal.tsx`, `web/gui/GuiSurface.tsx` |

## D. iPad workspace, keyboard, layout

**Critical**: these are shipped desktop/iPad capabilities; if UIKit ships them only on iPhone later, the iPad native app will be a regression.

| Priority | Capability | Surface | Port note | Code |
|---|---|---|---|---|
| P1 | Split right and below; independent sessions in tiled panes | I/D | UIKit custom tiling tree, independent terminal connections | `web/Workspace.tsx`, `web/layout.ts` |
| P1 | Drag divider to resize; focused pane accent border | I/D | UIKit pan gestures + keyboard; preserve ratios | `web/Workspace.tsx`, `web/layout.ts` |
| P1 | In-pane chooser: new shell, new agent or existing session | I/D | Contextual pane content, search/keyboard; avoid duplicate viewers of same window | `web/PanePicker.tsx` |
| P1 | Replace focused pane from sidebar/chooser | I/D | Native pane coordinator | `web/Workspace.tsx`, `web/PanePicker.tsx` |
| P1 | Close pane without terminating its process; maximize; flip split | I/D | Visually and semantically distinguish pane vs session | `web/Workspace.tsx`, `web/layout.ts` |
| P1 | Workspaces 1–9; per-workspace tiles; move session to workspace | I/D | Device-local persistence; dedicated iPad keyboard/nav | `web/workspaces.ts`, `web/shortcuts.ts` |
| P1 | Pane mode submap `h/j/k/l`, Shift-move, split, resize, maximize, flip, replace, close | I/D | Native `UIKeyCommand` command routing and HUD | `web/shortcuts.ts`, `web/Workspace.tsx` |
| P1 | Resize mode and directional focus with Ctrl+Shift+arrows | I/D | In text fields, don't steal caret movement until boundary | `web/shortcuts.ts`, `web/keyboard.ts` |
| P1 | Command palette hierarchy and searchable action catalog | I/D/F | Shared native command registry and availability, not just menu screenshots | `web/palette.ts`, `web/shortcuts.ts` |
| P1 | Hardware keyboard on iPad, all bindings, key hints, which-key overlay | I | Proper native keyboard support; UIKit hardware keyboard APIs | `web/hardwareKeyboard.ts`, `web/shortcuts.tsx` |
| P1 | iPad width adapts: wide sidebar, medium-width overlay, compact phone UI | I | UIKit size classes and scene/window width, Stage Manager support | `web/Sidebar.tsx`, `docs/spec/10-platforms.md` |
| P1 | iPad long press/right-click menus, pointer hover, drag reordering, edge reveal sidebar | I | Native context/pointer/drag interaction; no fake CSS hover state | `web/PressMenu.tsx`, `web/Sidebar.tsx`, `web/useSideSwipe.ts` |
| P2 | Drag sidebar session onto edge of pane to split | I/D | Native drag-drop with targets | `web/Workspace.tsx`, `web/Sidebar.tsx` |
| P2 | Scratchpad floating shell from anywhere | I/D | Overlay separate scene-local terminal, preserve active process | `web/Workspace.tsx`, `web/workspaces.ts` |
| P2 | Split/open in new pane from switcher (Ctrl+Enter) | I/D | Native shortcut/multiwindow | `web/Switcher.tsx`, `web/Workspace.tsx` |
| P2 | FLIP pane transitions, gliding list selection, spring/reduced motion | I/D | UIKit spring/interactive transitions; do not blindly copy CSS | `web/useFlip.ts`, `web/motion.ts`, `web/Glide.tsx` |
| P2 | Stage Manager window control inset setting for standalone PWA | I web | **Discard** hack; respect `safeAreaInsets` and native window chrome instead | `web/Appearance.tsx`, `web/windowControls.ts` |
| P3 | Omarchy desktop launcher / Hyprland shortcut to open ah | D/H | Keep host function; not an iOS Settings control | `server/desktop.ts`, `web/System.tsx` |

## E. Phone-native interaction details

| Priority | Shipped web behavior | Native replacement / importance | Code |
|---|---|---|---|
| P0 | Bottom bar Inbox / Sessions / History / Commands with counts | UIKit tab bar; Review route accessible from Inbox/menu | `web/TabBar.tsx`, `web/App.tsx` |
| P0 | Push/pop session navigation and interactive edge swipe back | UINavigationController and interactive transition | `web/useSwipeBack.ts`, `web/App.tsx` |
| P0 | Keyboard-aware composer, stable focus, safe areas; no page jump on typing | Native keyboard layout guide / safe area, no visual-viewport hacks | `web/viewport.ts`, `web/Composer.tsx` |
| P0 | Agents open in GUI by default unless device chose terminal | Persist per-session surface preference on device | `web/surface.ts`, `web/Session.tsx` |
| P1 | Full-width sheet for New session/Settings, detents for reviewer, draggable dismissal | `UISheetPresentationController` and native presentation | `web/sheet.tsx`, `web/review/ReviewerSheet.tsx` |
| P1 | Session/History press-and-hold context menu, swipe actions, distinct danger confirmations | `UIContextMenuInteraction`, swipe actions, UIKit feedback | `web/PressMenu.tsx`, `web/Swipe.tsx`, `web/HistoryView.tsx` |
| P1 | Touch-first session toolbar: GUI/Terminal, Diff, Files, Chat, Queue, Snapshots, Preview, Stack | Native contextual tabs/toolbar, preserve feature access | `web/Session.tsx`, `web/TabBar.tsx` |
| P1 | Native-style toggle switches, minimum touch targets, content size & accessibility | UIKit controls, VoiceOver, Dynamic Type and Reduce Motion | `web/Settings.tsx`, `web/styles.css` |
| P1 | Platform haptic for holds and swipe thresholds | Native `UIFeedbackGenerator` instead of Safari switch hack | `web/haptic.ts` |
| P2 | Large title collapse, frosted bottom/nav chrome | UIKit bars/materials, not web CSS recreation | `web/Sidebar.tsx`, `web/styles.css` |
| P2 | Terminal exact-line inertial scroll, pinch font resize, sticky key modifiers | UIKit gestures and terminal buffer scroll | `web/Terminal.tsx`, `web/KeyBar.tsx` |
| P3 | iOS PWA standalone viewport shim, WebKit visualViewport polling, Safari faux haptic toggle | **Do not port**: native OS replaces the workaround | `web/viewport.ts`, `web/haptic.ts` |
| P3 | Home-screen installation and service worker mechanics | Replace with native app lifecycle | `web/public/manifest.webmanifest`, `web/public/sw.js` |

## F. Git, code, files and previews

| Priority | Capability | Native port | Code |
|---|---|---|---|
| P1 | Live uncommitted diff by file with +/− and line numbers | Native diff renderer and selection | `web/Git.tsx`, `server/git.ts` |
| P1 | Add file/line anchored feedback and send to current agent | Native code context action | `web/Git.tsx`, `server/core.ts` |
| P1 | Browse remote host files, roots, hidden files, directories | Native list/tree with strict server-side root containment | `web/Files.tsx`, `server/files.ts` |
| P1 | Host file preview, download, upload into directory, insert path/mention into conversation | Quick Look / file import/export where supported; authenticated URL | `web/Files.tsx`, `web/api.ts` |
| P1 | Git branch search/switch/create and PR discovery | UIKit context menu; do not replicate git logic locally | `web/Git.tsx`, `server/git.ts` |
| P1 | Per-session developer preview: discover listening ports, start/stop proxy, HMR/WS | `WKWebView`, explicit URL-auth/Origin/cookie strategy and TLS/Serve checks | `web/Preview.tsx`, `server/preview.ts` |
| P2 | Worktree create on session start, list managed trees; dirty/ahead/in use/sizes | Native management UI | `web/Git.tsx`, `server/git.ts` |
| P2 | Worktree safe removal/orphan detection/bulk cleanup | Destructive confirmation and status verification | `web/Git.tsx`, `server/git.ts` |
| P2 | Per-turn git snapshots; enable/disable; safety snapshot before rollback | Native timeline/confirmation UI | `web/Snapshots.tsx`, `server/snapshots.ts` |
| P2 | GitHub PR link and session-associated stack panel | Native deep link into Review, open GitHub URL | `web/review/SessionStack.tsx`, `web/Git.tsx` |

## G. Review & PR stack — feature-complete inventory

**Current product, not the old design mock:** `web/review/`, `server/review/`, `web/reviewApi.ts`, `docs/spec/12-review.md`.

| Priority | Capability | Native implementation / cautions |
|---|---|---|
| P1 | Review landing page lists stacks in progress, recent project PRs, alerts | Native `Review` destination and stack cards; phone not necessarily permanent tab |
| P1 | Start a review from GitHub PR chain, manually chosen PRs, native GitHub stack | Preserve three discovery/pick methods and topology validation |
| P1 | Ordered stack spine showing trunk, layers, role labels, progress, checks, findings, merge status | iPad list/sidebar, phone navigable layer list |
| P1 | Stack cockpit: Up next, merge order, made-in and fixes-go-to agents, plan, pinned decisions | First-priority situational understanding |
| P1 | Layer page: title, progress prev/next, new/re-review status banner, action | Native layer navigation with retained reviewer context |
| P1 | Layer diff scopes: This PR, Since review (including `git range-diff`), cumulative From trunk | Preserve exact reviewed revision/base+head and truncation disclosures |
| P1 | PR description (GitHub Markdown, HTML/suggestions/images) and model-generated briefing | Render safely and show both clearly |
| P1 | Reviewer conversation via configured subscription, one stack thread with per-question layer scope | Persist chat and scoped attachments across layers/device switches |
| P1 | Attach diff line/range/file or existing finding to reviewer; Ask reviewer | Native context selection from diff; keyboard/touch |
| P1 | Findings: from user, reviewer, GitHub threads/bots; blocking/should/nit; ownership and state | Evidence linked to code/revision; propose/keep/dismiss/reassign |
| P1 | Convert selected findings into one drafted agent instruction with stack context | Send to original session, another session, or new worktree agent |
| P1 | Agent working/fixing/no-push, re-review verdict: addressed/partial/not, unrequested changes | Preserve review checkpoints, do not silently auto-accept |
| P1 | Mark reviewed, withdraw, Accept fixes; stale patch detection, separate merge gates | Distinguish human action vs model verdict |
| P1 | Merge & next exact-head SHA, retarget/restack, GitHub-native stack merge and queue | Native merge confirmation + fresh backend checks |
| P1 | Merge the stack bottom-up; method merge/squash/rebase; held/waiting/restack | High-impact destructive workflow; show exactly what lands |
| P2 | Ask implementation harness to carry out restack or merge; track whether it completed | Separate explicit automation action from AI discussion |
| P2 | Import bot/human GitHub threads with code suggestions and replies; reply & resolve | Native Markdown + auth/private media |
| P2 | Add/remove/reorder/rename/skips layers; change owner, plan, merge method, sync | Stack maintenance |
| P2 | Convert chain to GitHub native stack, follow new PRs | Explicit confirmation; no surprise GitHub mutation |
| P2 | Review Inbox cards, notifications, stack panel in sessions | Native notification/deep link |
| P2 | Semantic overview of what changes, architecture visualization, evidence-backed diagrams | **Not shipped as a dedicated feature**; docs mark R4–R5 open. Design it in native later, don't claim web parity. |

**Existing confidence caveats to carry into the native design:** a passing checks gate may reflect *no checks reported*; `mergeStack(markReviewed=true)` can mark previously unreviewed layers as reviewed; a generic briefing/availability of diff is not evidence that you inspected it. These are existing workflow choices/weaknesses, not problems for UIKit to paper over. See `server/review/service.ts` and `web/review/stackMerge.ts`.

## H. Side chat, providers and content search

| Priority | Capability | Native port / backend |
|---|---|---|
| P1 | Session side chat independent of the coding agent, includes code/repo context | Native assistant chat; persisted server-side | `server/sidechat.ts`, `web/SideChat.tsx` |
| P1 | Read-only repo tools (`repo_map`, `pr_info`, `pr_diff`, `working_diff`, `read_file`, `commit_show`) | Server side; native displays results and links | `server/sidechat.ts` |
| P1 | Review tools (`stack_map`, exact `layer_diff`, `read_file`, `pr_threads`, `origin`, plan, findings, commits) | Server side; native displays findings, citations and diagrams if added | `server/review/reviewer.ts` |
| P1 | Conversation-specific chat provider selection; follow-up buttons; send chat output to agent | Native conversation + dispatch | `web/SideChat.tsx`, `server/sidechat.ts` |
| P2 | Past side-chat conversation list/search, clear thread | Native archive; confirmations | `web/ChatHistory.tsx`, `web/SideChat.tsx` |
| P2 | Summary to send to another agent through subscription | Native send-to sheet, same backend | `web/SendToDialog.tsx` |
| P2 | Search index enable/rebuild; source scope/speaker/time filter | Native screen, server retains FTS index | `web/SearchView.tsx`, `web/SearchSettings.tsx` |

## I. Settings — complete audit (9 sections)

| Priority | Section and control | Ownership | Native recommendation / source |
|---|---|---|---|
| P0 | **Security:** device name; lock now; sign out; one-time device enrollment code | Device / Host | Native Settings + separate secure pairing screen; `web/Security.tsx` |
| P0 | **Security:** passkeys list/add/remove; signed-in device list, revoke, sign out others | Host | Preserve lifecycle; native passkey flow requires origin design; `server/auth.ts` |
| P1 | **Security:** machine/host bearer tokens list & revoke | Host | Device/peer admin; avoid exposing actual token; `web/Security.tsx` |
| P2 | **Security:** optional host-only master password status, prompt history clear, recent activity/audit log | Host | Status/actions; master password set/remove stays host-only | `web/Security.tsx`, `server/auth.ts` |
| P0 | **Appearance:** System, Dark, Light, Omarchy (host colors/font sync) | Device | UIKit appearance / terminal theming, inspect contrast | `web/Appearance.tsx`, `web/theme.ts` |
| P3 | **Appearance:** Window buttons `In a window/Always/Never` | Device-web-only | **Do not transfer the hack**; native controls safe area; `web/windowControls.ts` |
| P1 | **Shortcuts:** searchable 89-command list, rebind/clear/reset conflicts and when-applicable | Device | Native `UIKeyCommand`/shortcut registry; revisit reserved system shortcuts | `web/shortcuts.tsx`, `web/shortcuts.ts` |
| P0 | **Notifications:** enable, Needs you, Finished toggle per device | Device | APNs registration and local preference; server changes required | `web/NotifyDialog.tsx`, `server/push.ts` |
| P1 | **Agents:** show/hide from New session, installed CLI names/versions, check updates | Host | Native grouped list/toggles; `web/AgentsSettings.tsx` |
| P2 | **Agents:** add arbitrary CLI command / remove custom preset | Host | Admin sheet + safety validation; `web/AgentsSettings.tsx` |
| P1 | **Subscriptions:** provider presets Claude/OpenAI/Gemini/Muse/Other; name, URL, model, key | Host | Native secret entry, keys masked on read; `web/Subscriptions.tsx` |
| P1 | **Subscriptions:** active default, per-chat/review/briefing choice, model discovery, edit/delete | Host | Shared selector, not duplicate native model runtime; `web/SubscriptionPicker.tsx` |
| P1 | **Subscriptions:** optionally expose key to launched sessions via named env var | Host | Confirm broad secret exposure; `web/Subscriptions.tsx` |
| P1 | **Environment:** add/edit/delete global values, secret mask, stale running sessions, restart one/all idle | Host | Native sensitive controls, relaunch confirmation; `web/Environment.tsx` |
| P2 | **Search:** enabled, index status/details, rebuild | Host | Native admin screen; `web/SearchSettings.tsx` |
| P2 | **System:** hook status per agent, install/remove, screen-rule audit and clear | Host | Native remote admin, do not run locally | `web/System.tsx` |
| P3 | **System:** Add/remove Omarchy desktop launcher; copy Hyprland bind | Host/desktop | Keep web or CLI; nonsensical on iOS | `web/System.tsx` |
| P2 | **System:** Restart server, rebuild and restart, reload UI, uploads disk usage, clear uploads | Host/Device | Show restart and uploads; *rebuild web UI* is web-only maintenance, not needed for native app | `web/System.tsx` |
| P3 | Host `config.json`: `port`, host, `defaultSession`, `projectRoots`, `idleAfter`, `peers`, `files.roots`, `promptHistory`, `snapshots`, `preview.ports`, auth, presets | Host | Not currently editable as one complete GUI Settings screen; preserve host config/CLI. Native need not invent every knob. `server/config.ts` |

**Native settings ownership mapping:** keep host-wide state on server and per-device settings in iOS preferences (appearance, keymap, notification opt-in, layouts, GUI/terminal mode, hide steps, keyboard overlay, Inbox grouping and agent recents). Keep secrets in Keychain; don't duplicate subscription keys onto devices unless needed for transport.

## J. Actual keyboard catalog — 89 commands + contextual navigation

Canonical source `web/shortcuts.ts` (71 literal IDs + 18 programmatically generated); documented in `docs/spec/06-keyboard.md`. Chords are **web defaults**, not a guarantee iPadOS delivers every combination unmodified. UIKit needs deliberate `UIKeyCommand` mapping and system-conflict tests.

### Navigation (17)

| Command | Default chord |
|---|---|
| Command palette | Cmd+Shift+P or Ctrl+Shift+P |
| Search or jump / switcher | Cmd+K or Ctrl+Shift+K |
| Previous / Next session | Alt+Up / Alt+Down |
| New session | Ctrl+Shift+Enter |
| New project | Palette only |
| Toggle sidebar | Ctrl+Shift+E |
| Inbox / History / Settings / Review / Search | Ctrl+Shift+1 / 2 / 3 / 4 / 5 |
| Worktrees | Palette only |
| Focus sidebar list / focus session | Ctrl+Shift+0 / Ctrl+Shift+9 |
| Reload page | Palette only (replace with Refresh in native) |
| Keyboard shortcuts | Ctrl+Shift+/ |

### Session actions (31)

| Command | Default chord |
|---|---|
| Toggle GUI/Terminal | Ctrl+Shift+G |
| Hide/show steps | Ctrl+Alt+H |
| Toggle side panel | Ctrl+Shift+J |
| Reply | Ctrl+Alt+R |
| Approve / Deny | Ctrl+Alt+Enter / Ctrl+Alt+Backspace |
| Stop turn | Ctrl+Alt+X |
| Send next queued now | Ctrl+Alt+S |
| Cancel all queued | Palette only |
| Switch model / effort | Ctrl+Alt+M / Ctrl+Alt+E |
| Copy agent's last reply | Ctrl+Alt+C |
| Jump to latest / Browse messages | Ctrl+Alt+End / Ctrl+Alt+B |
| Switch branch | Palette only |
| Rename / Fork / Send to | Ctrl+Alt+N / F / T |
| Pin | Palette only |
| Panels: Diff / Files / Chat / Queue / Snapshots / Preview / Stack | Ctrl+Alt+1…7 |
| Session menu | Ctrl+Alt+. |
| Scrollback as text / Copy attach command | Palette only |
| Show/hide on-screen keys | Ctrl+Alt+K |
| Terminate session | Palette only |

### Workspace (41 = 23 explicit + 18 dynamic)

| Command | Default chord |
|---|---|
| Split right / below | Ctrl+Shift+Backslash / Ctrl+Shift+Minus |
| Close pane | Ctrl+Shift+Backspace |
| Focus pane left/right/up/down | Ctrl+Shift+arrows |
| Move pane left/right/up/down | Ctrl+Alt+arrows |
| Flip split | Ctrl+Alt+J |
| Resize divider left/right/up/down | Ctrl+Shift+Alt+arrows |
| Resize mode / Pane mode | Ctrl+Shift+R / Ctrl+Shift+Space |
| Replace pane / Open in new pane | Ctrl+Alt+P / Ctrl+Shift+O |
| Scratchpad shell / Maximize pane | Ctrl+Shift+Backtick / Ctrl+Shift+F |
| Exit split | Palette only |
| Workspace 1…9 | Alt+1…9 |
| Send to workspace 1…9 | Alt+Shift+1…9 |

### Contextual bindings and behavior outside the catalog

- **Pane mode**: `h/j/k/l` focus; `Shift+h/j/k/l` move; `v`/`s` split; `x` close; `f` maximize; `t` flip; `r` resize; `o` open in new pane; `p` replace; `1–9` workspaces; `Esc` exits. `Resize mode`: arrows move divider, Escape exits. `web/Workspace.tsx`, `docs/spec/05-workspace.md`.
- **Review**: `j/k` traverse layers when not typing; next/previous header buttons; `Cmd/Ctrl+Enter` runs primary action where eligible. `web/review/ReviewPage.tsx`, `web/review/Layer.tsx`.
- **Switcher/palette**: arrow navigation, Enter choose, Right enter submenu, Left/Backspace back, typed fuzzy filter, Ctrl+Enter open as new pane. `web/shortcuts.tsx`, `web/Switcher.tsx`.
- **Session composer**: Enter send, Shift+Enter newline, empty Enter steer next queued message, empty Escape stop current turn, `/` command completion, `@` file completion. `web/Composer.tsx`.
- **Ask controls**: digit answer; arrows focus; Space toggle; Ctrl+Enter submit; Escape/terminal fallback; server verifies prompt still matches. `web/AskPanel.tsx`.
- **Diff comments**: keyboard arrows navigate commentable lines, Enter/Space open comment, Cmd/Ctrl+Enter send, Escape cancel. `web/Git.tsx`.
- **Roving list**: sidebar, Inbox, History, menus, queues, tabs keep focus where item moves; first keystroke must go to intended pane. `web/rove.ts`, `web/shortcuts.tsx`.
- **Global main action**: Cmd/Ctrl+Enter for latest active main button on current screen/dialog, except controls that capture it. `web/shortcuts.tsx`.
- **Which-key**: hold Ctrl+Alt or Ctrl+Shift briefly; context-specific HUD of available actions. `web/shortcuts.tsx`.
- **Colemak / layout**: letters use generated character; numbers/punctuation physical position; remapping per device with conflict validation; never steal unmodified letters from terminal. `web/shortcuts.ts`.
- **Text-editing collision**: pane arrow shortcuts wait until the caret is at start/end before moving focus, preventing hijack of selection. `web/shortcuts.ts`, `web/keyboard.ts`.

**Catalog arithmetic:** Navigation 17 + Session 31 + Workspace 41 = **89**, source-verified. (The spec's count of 84 is stale.)

## K. Transferability and necessary native replacements

| Concern | Reuse directly | Rewrite / backend change |
|---|---|---|
| Session lifecycle, queues, statuses, agent presets, launch, discovery | `server/` business logic unchanged | Codable models, client state reducers, native screens |
| REST API | Most `web/api.ts` routes | URLSession, uploads/downloads, cancellation, serialization, retry/idempotency |
| SSE state + feed | `/api/events`, `/feed/stream`, `/feed` pages | Native streaming parser, JSON patches, reconnect/caching and app lifecycle |
| Terminal transport | `/ws/<windowId>` binary output, JSON input/resize messages | Native ANSI/PTY emulator, keyboard/selection/scroll gestures, rendering |
| Git, diff, review, files, previews | Host Git/GitHub/SQLite, authenticated routes | Native visualizations, diff code text, WKWebView previews/permissions |
| Config and BYOK subscriptions | Server-held secrets and provider calls | Native configuration screens, no local AI SDK necessary |
| Auth | Existing session/token backing store and Tailscale Serve trust root | **Native pairing/access policy**; current write/WS Origin and browser passkeys need an explicit design |
| Push | Host events and audience logic | **APNs delivery and device tokens** + notification preferences/badge; web VAPID not reused |
| Theme | Existing colors/type roles as visual source | Native design tokens, SF Symbols/brand marks, Dynamic Type, iOS materials |
| Local cache | Existing server data and cache-key concept | Native encrypted cache + Keychain-derived session binding; not IndexedDB |
| Device presence/handoff | `/api/focus`, drafts, device names | Scene lifecycle, device identifiers and multiwindow ownership |
| Native previews | Existing proxy endpoints | WKWebView navigation policies, cookie/token auth, restricted origins, HMR tests |

### Native authentication is a release-blocker, not a polish task

`server/gate.ts` rejects unsafe Origin and missing/incorrect Host, and requires Tailscale user identity on Serve requests; `server/main.ts` requires `x-ah` on mutations and Origin on WebSockets; WebAuthn uses the browser's site origin (`server/auth.ts`). A native HTTP/WebSocket client must be explicitly authorized and authenticated without weakening browser protections. Consider short-lived revocable per-device bearer tokens through verified pairing, scoped native request handling, and a server-push token registry. Do **not** embed the CLI `local-token`, spoof WebAuthn origin, or blanket-disable Origin checks. The Apple passkey route requires a separate associated-domain feasibility review for private `.ts.net` hosts.

### Native operational limitations

- iOS does not run a persistent Linux/tmux server or generally keep arbitrary background socket streams alive indefinitely. State reconnection is normal; APNs communicates while suspended.
- Server-side previews may still require Tailscale connectivity. Being a native app does not bypass restrictive VPN/flight Wi-Fi networks.
- macOS desktop native is a **different target** (UIKit + Mac Catalyst is possible, but iPhone/iPad are the identified scope); preserve existing web/Omarchy front end meanwhile.
- App Store distribution, signing, APNs entitlement, association domains and device testing are separate deliverables. Xcode/macOS are required for true iOS compilation and signing.

## L. Suggested rollout and acceptance gates

**Phase 0 — contract/security spike:** pairing/token/auth design, GET state and authenticated mutations, SSE and WebSocket test on Tailscale, reconnect after suspend. Test on actual iPhone/iPad, including off-tailnet failure and device revoke. No product UI migration before this is proven.

**Phase 1 — phone daily driver (P0):** native Inbox/status/asks; session list; GUI transcript; composer/drafts/queue; terminal; new/resume/stop/terminate; History; notifications/APNs. Strict parity and UX verification at every step.

**Phase 2 — iPad daily driver (P1):** tiling, workspaces, pane picker, resize, hardware-keyboard command registry, which-key, pointer/drag, adaptive sidebar, multiple scenes if beneficial. This is mandatory for replacing web on an iPad.

**Phase 3 — real work:** Review & stack lifecycle, code diff, findings/reviewer and merge flows, file browser/upload, chat/subscriptions, search, developer preview, forks/snapshots/worktrees, all nine Settings sections. Some of these (Review) may move earlier based on frequency of use.

**Phase 4 — polish and complete parity:** widgets, granular preferences, sophisticated layout transitions, system integrations, accessibility performance/edge-case suites, less-frequent host maintenance.

### Acceptance criteria, not merely an implementation checklist

1. User can open an iPhone and immediately see who needs them, answer safely, send/queue an instruction, background the app, and resume later without losing draft or false state.
2. A live agent's GUI and terminal represent the same conversation; switching never restarts it; terminal pasting/submitting/resize works over shaky networks.
3. One iPad hardware-keyboard workflow can create a project/agent, work in splits, move among workspaces, inspect diff, switch model/mode and send without touching the screen.
4. Review a 10-PR stack on iPad, ask a model grounded questions, attach code lines, dispatch findings, observe new revision, verify gates, merge bottom-up and continue. Revisions/targets checked freshly at action time.
5. Disconnect/reconnect, server restarts, multi-device presence, duplicate socket/late responses, rotation, Stage Manager and iOS system suspend do not silently lose data or send keystrokes to the wrong tmux window.
6. Native app preserves server security defaults; revoke signs the device out and closes its live terminal; secrets do not appear in logs/cache; file access remains root-limited.
7. VoiceOver, Dynamic Type, Reduce Motion, Contrast, external keyboards, pencil/trackpad and interactive gesture handling are validated on device.

## M. Definitive source index

- Foundations: [`docs/spec/01-foundation.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/01-foundation.md) · [`server/core.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/server/core.ts) · [`web/api.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/api.ts)
- Sessions: [`docs/spec/02-sessions.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/02-sessions.md) · [`web/NewDialog.tsx`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/NewDialog.tsx) · [`web/Session.tsx`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/Session.tsx)
- Attention: [`docs/spec/03-attention.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/03-attention.md) · [`web/Inbox.tsx`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/Inbox.tsx)
- GUI/terminal: [`docs/spec/04-session.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/04-session.md) · [`docs/gui.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/gui.md) · [`server/terminal.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/server/terminal.ts)
- Workspace: [`docs/spec/05-workspace.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/05-workspace.md) · [`web/Workspace.tsx`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/Workspace.tsx)
- Keyboard: [`web/shortcuts.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/shortcuts.ts) · [`docs/spec/06-keyboard.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/06-keyboard.md)
- Continuity: [`docs/spec/07-continuity.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/07-continuity.md)
- Settings: [`docs/spec/08-settings.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/08-settings.md) · [`web/settingsMenu.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/settingsMenu.ts)
- iOS/iPad: [`docs/spec/10-platforms.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/10-platforms.md)
- Design: [`docs/spec/11-design-system.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/11-design-system.md)
- Review: [`docs/spec/12-review.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/12-review.md) · [`server/review/service.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/server/review/service.ts) · [`web/review/ReviewPage.tsx`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/web/review/ReviewPage.tsx)
- Transport/security: [`server/gate.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/server/gate.ts) · [`server/auth.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/server/auth.ts) · [`SECURITY.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/SECURITY.md)
- Existing cross-surface QA: [`docs/spec/audit.md`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/docs/spec/audit.md) · [`test/ui/smoke.test.ts`](https://github.com/ealush/agent-house/blob/57770d9ab723be3ac8b97b5991fde536c977bce8/test/ui/smoke.test.ts)

**Bottom line:** Prioritize the *behavioral contract* of ah over one-for-one translations of React components. All core host services are already there. A great UIKit app should feel different where native conventions help, while preserving the server's state and the keyboard-first/attention-first workflow that makes ah valuable.
