# Native completion and parity tracker

Prepared from the supplied audit and executable source catalog at `be111749eea838c0103293ced5821cb843981439`.

Last reconciled: **24 October 2026**. This is the completion companion to [SPEC.md](../../SPEC.md); [AUDIT.md](../../AUDIT.md) remains the source capability inventory. Keep implementation status here and execution evidence in [TEST-MATRIX.md](TEST-MATRIX.md).

Statuses: `unstarted`, `implemented` (code exists; its stated evidence is all that ran), `verified` (the named test/platform ran and passed), `blocked` (needs something this machine or session can't provide), `substituted` (a web/host mechanism replaced by a native one, or deliberately kept on the host). `[x]` marks verified rows only.

**Current outcome:** every P0/P1 capability has native code. The non-UI core (protocol, auth, streams, models, keyboard routing, workspace, persistence, review logic) is compiled and tested on Linux: **141 unit tests** and **19 integration tests against a disposable `ah`** with real tmux and fake agents. The UIKit/SwiftUI layer builds with Xcode 27.1, and the unit and UI tests pass on an iOS 27 simulator (25 October 2026). No screen has yet been walked against a real host, and no device, APNs delivery or hardware-keyboard behavior is verified. **No implementation-phase exit gate is closed**; G-0 needs the setup → Inbox → session → terminal walk.

Evidence shorthand used below: **UT** = `swift test` (Linux, Swift 6.2); **IT** = `scripts/integration.sh` (Linux, disposable `ah` on branches `native/1-device-auth` + `native/2-apns`); **UI** = SwiftUI/UIKit source that compiles in Xcode 27.1 but hasn't been seen running.

## Built component inventory

| Built | ID | Component | Implementation | Verification |
| --- | --- | --- | --- | --- |
| [x] | B-01 | Canonical audit/spec import and pinned provenance | [AUDIT](../../AUDIT.md), [SPEC](../../SPEC.md), [SOURCE.json](../../SOURCE.json) | verified: `scripts/check-workspace.py --source ../ah` |
| [x] | B-02 | Native device enrollment, bearer sessions, device removal, preview session (backend) | `ah` `native/1-device-auth`: `server/auth.ts`, `server/main.ts`, `test/security/native.test.ts` | verified: ah suite 552/552, tsc clean |
| [x] | B-03 | APNs provider, registration routes, payload/category/badge (backend) | `ah` `native/2-apns`: `server/apns.ts`, `server/push.ts` | verified: ah tests with a loopback gateway; real APNs unverified |
| [x] | B-04 | Typed client for every web route | [APIClient](../../Sources/Networking/APIClient.swift), [ReviewAPI](../../Sources/Review/ReviewAPI.swift) | verified: UT + IT |
| [x] | B-05 | Live state: SSE snapshot/patch, backoff, polling, resync, peers | [StateStream](../../Sources/Connection/StateStream.swift), [HubStore](../../Sources/Models/HubStore.swift) | verified: IT (peers not exercised) |
| [x] | B-06 | Transcript feed, projection, tools, widgets, Markdown | [Feed](../../Sources/Feed), [Markdown](../../Sources/Markdown) | verified: UT + IT |
| [x] | B-07 | Terminal over the PTY WebSocket into SwiftTerm | [TerminalConnection](../../Sources/Terminal/TerminalConnection.swift) | verified: IT on Linux; iOS view unverified |
| [x] | B-08 | Enrollment/sign-in signing, device keys, revocation | [NativeAuth](../../Sources/Auth), [AppModel](../../Sources/Models/AppModel.swift) | verified: IT; Secure Enclave/Face ID unverified |
| [x] | B-09 | Composer, outbox, drafts, queue | [Composer](../../Sources/Models/Composer.swift) | verified: IT |
| [x] | B-10 | Per-window navigation, panes, workspaces, 89 command handlers, restoration | [SceneModel](../../Sources/Models/SceneModel.swift), [WorkspaceModel](../../Sources/Models/WorkspaceModel.swift), [Workspace](../../Sources/Workspace), [Keyboard](../../Sources/Keyboard) | verified: UT + IT |
| [x] | B-11 | GRDB database, scene journal, accounts, preferences, sealed cache | [Persistence](../../Sources/Persistence) | verified: UT + IT |
| [x] | B-12 | Review model: confidence, exact-head merge, stack merge plan, management | [Review](../../Sources/Review) | verified: UT (no GitHub fixture) |
| [x] | B-13 | Panel and settings models | [PanelModels](../../Sources/Models/PanelModels.swift), [SettingsModels](../../Sources/Models/SettingsModels.swift) | verified: UT |
| [x] | B-14 | Deep links and push payload routing | [DeepLink](../../Sources/Domain/DeepLink.swift) | verified: UT |
| [ ] | B-14a | Links to any place (session with its view/panel, a message, a page, a Settings section): the host's web link with the place as its hash, `agenthub://<host>/…` as the app link; Copy Link / Share Link (session menu, message menu, Settings), ⌥⌘C, Open Link in the palette | [AppLink](../../Sources/Domain/AppLink.swift) | UT (format, hosts, Copy Link); UI: not yet seen running |
| [ ] | B-15 | UIKit shell: scenes, split/tabs, panes, presentation, menu commands, key routing | [App](../../App), [Shell](../../Sources/Features/Shell) | implemented: UI |
| [ ] | B-16 | Screens: Inbox, Sessions, History, Search, session (transcript, widgets, composer, ask, terminal, panels) | [Features](../../Sources/Features) | implemented: UI |
| [ ] | B-17 | Review screens, Settings (nine sections), sheets, palette/switcher/shortcuts, setup and sign-in | [Review](../../Sources/Features/Review), [Settings](../../Sources/Features/Settings), [Sheets](../../Sources/Features/Sheets), [Setup](../../Sources/Features/Setup) | implemented: UI |
| [ ] | B-18 | Keychain, Secure Enclave keys, APNs registration, notification actions, badge | [Platform](../../Sources/Platform), [AppDelegate](../../App/AppDelegate.swift) | implemented: UI |
| [ ] | B-19 | Xcode project, Info.plist, entitlements, UI tests | [project.yml](../../project.yml), [Info.plist](../../Config/Info.plist), [entitlements](../../Config/AgentHubNative.entitlements), [UI tests](../../Tests/UI) | implemented: plists parse; XcodeGen/Xcode unrun |

## Specification crosswalk

| Done | Area | State |
| --- | --- | --- |
| [ ] | T-01–T-08 technology and native standards | All code follows them (iOS 26, UIKit shell, SwiftUI content, Observation, GRDB, Keychain); Apple compilation outstanding (Q-01). |
| [ ] | P0-01 sign-in, pairing, lock, revoke | Built and IT-verified at the protocol/model level (B-02, B-08); screens UI-only. |
| [ ] | P0-02 Inbox, status, asks, cross-host, offline | Model IT-verified (B-05); screens UI-only; peers not exercised. |
| [ ] | P0-03 sessions lifecycle | Built; IT covers send/queue/steer/stop/approve; create/resume screens UI-only. |
| [ ] | P0-04 rich GUI | Feed IT-verified with the Claude adapter; other adapters rely on the same server-normalized feed. |
| [ ] | P0-05 composer/queue/drafts | IT-verified (B-09); keyboard behavior UI-only. |
| [ ] | P0-06 terminal | IT-verified through SwiftTerm on Linux; iOS input/IME unverified. |
| [ ] | P0-07 identity, deep links, presence, cache, restoration | IT-verified, including the sealed session list and Handoff between windows; Handoff between devices needs signed devices. |
| [ ] | P0-08 APNs | Host side tested; device delivery blocked on signing (AP-01, AP-09). |
| [ ] | P1-01 iPad workspace | Model UT/IT-verified; UIKit layout UI-only. |
| [ ] | P1-02 all 89 commands | Handlers tested; hardware mapping unverified. |
| [ ] | P1-03 stack review | Built including management and exact-head merge; needs a GitHub fixture (Q-12, Q-13). |
| [ ] | P1-04 Git/files/search/chat/preview/worktrees/snapshots/fork/hand-offs | Built; UI-only beyond uploads/drafts IT. |
| [ ] | P1-05 widgets | All types built; choices IT-verified. |
| [ ] | P2-01 settings | All nine sections built; UI-only. |
| [ ] | P2-02 outages/restoration/accessibility | Restoration IT-verified; accessibility audit blocked on devices. |

| Done | Phase | Exit evidence still required |
| --- | --- | --- |
| [ ] | G-0 — Foundations | Xcode build + simulator run of setup → Inbox → session → terminal |
| [ ] | G-1 — iPhone end-to-end | The P0 journeys on a signed device, including APNs |
| [ ] | G-2 — iPad native | Panes, windows, all 89 commands on hardware, Stage Manager |
| [ ] | G-3 — Review, Git and files | GitHub fixture stack through exact-head merge |
| [ ] | G-4 — Settings/parity sweep | Every row here verified or explicitly substituted |
| [ ] | G-5 — Premium refinement | Device rounds, screenshots/recordings, accessibility, performance, release signing |

## Source capability checklist

| ID | Capability | Priority | Native destination | Status | Source / evidence |
| --- | --- | --- | --- | --- | --- |
| F-001 | One remote control plane; Node daemon bound to loopback; persistent tmux agents | P0 | HubStore, AccountSession | implemented | [AUDIT.md:68](../../AUDIT.md#L68); One state stream per host for all windows; IT enrollingStartsOneLiveStreamAndMergesSessions |
| F-002 | Stable uid for session across tmux window replacement, restart and resume; multi-host `host/uid` | P0 | SessionKey, TerminalConnection, RestorationReconciler | implemented | [AUDIT.md:69](../../AUDIT.md#L69); host/uid keys; terminal re-resolves the tmux id per attach (IT terminal); relaunch reconcile (IT aRelaunchedWindow…) |
| F-003 | State reconciliation ~1.5s and SSE initial full snapshot plus patches; polling/recovery | P0 | StateStream, HubStateReducer | implemented | [AUDIT.md:70](../../AUDIT.md#L70); snapshot+patches, backoff, polling while down, foreground resync; IT liveStateArrivesAsSnapshotThenPatches; UT reducer/SSE |
| F-004 | States: waiting/needs you, busy/working, attention/done/new output, idle, limited/reset, ended, starting, unavailable | P0 | StatusWord, StatusPill | implemented | [AUDIT.md:71](../../AUDIT.md#L71); UT DomainTests; UI pills |
| F-005 | Hook-derived ask details, process/screen fallback, current activity text, unread/viewed state | P0 | AskParts, AskSummaryView | implemented | [AUDIT.md:72](../../AUDIT.md#L72); UT ask reading; UI Inbox/session |
| F-006 | Multiple devices view same tmux process independently; last writer controls tmux size | P0 | TerminalConnection, TerminalScreen | implemented | [AUDIT.md:73](../../AUDIT.md#L73); per-viewer PTY, resize frames; IT terminal |
| F-007 | Persisted conversations, host registry, transcript identity; session remains after process death | P0 | HistoryView, SessionModel.resume | implemented | [AUDIT.md:74](../../AUDIT.md#L74); UI History/EndedBanner; host persistence unchanged |
| F-008 | Native-safe authentication, device revocation and network trust | P0 | NativeAuth, AccountSession, ah native/1-device-auth | implemented | [AUDIT.md:75](../../AUDIT.md#L75); IT enrolls/refuses foreign signature/revocation closes streams+terminals; ah security suite (10 native tests); device Face ID unverified |
| F-009 | Multi-host hub merges state, proxies peer HTTP/SSE/WebSocket under `/h/<host>` | P0 | HubStore peers (/h/<peer>) | implemented | [AUDIT.md:76](../../AUDIT.md#L76); peer streams merged with host/uid keys; not exercised by IT (single host) |
| F-010 | Registered/present devices, "On Desk too", viewed status, focus/handoff | P0 | SessionModel.otherDevices, api.focus | implemented | [AUDIT.md:77](../../AUDIT.md#L77); presence + focus; Handoff (`NSUserActivity` with the host origin and the web hash; the host's web page as the fallback): UT handoffCarriesTheWebHashBothWays, IT continuing in another window; device-to-device needs signing |
| F-011 | Live catalog/preset updates based on agent CLI versions; hooks and discovery | P2 | HubStore.presets, AgentsSettings | implemented | [AUDIT.md:78](../../AUDIT.md#L78); live presets from state; check versions in Settings |
| F-012 | CLI/script protocol (`ah list/new/attach/send/wait/read/answer/stop/...`) | P3 | Retain host CLI | substituted | [AUDIT.md:79](../../AUDIT.md#L79); Retained on the host: no iOS CLI port |
| F-013 | List all active sessions grouped by project, host or status | P0 | SessionListView, SessionOrdering | implemented | [AUDIT.md:85](../../AUDIT.md#L85); UT ordering/sections; UI |
| F-014 | Open/select a session from lists, Inbox, History and switcher | P0 | SceneModel.open | implemented | [AUDIT.md:86](../../AUDIT.md#L86); Inbox/Sessions/History/switcher/search; IT scene routing |
| F-015 | New session: Shell/Agent; choose installed available preset, project, machine | P0 | NewSessionSheet | implemented | [AUDIT.md:87](../../AUDIT.md#L87); UI; SceneModel.start |
| F-016 | New session: model, custom model id, reasoning effort, permission mode | P0 | NewSessionSheet, LaunchPickerSheet, LaunchState | implemented | [AUDIT.md:88](../../AUDIT.md#L88); UT launch plans, newSessionsTakeATypedModelAndAnyTmuxSession (“Other model version” for agents with modelArgs, validated like the web); sheet seen running on the iPhone simulator against the demo host (10 November 2026): agent, folder, worktree, permissions, model and effort rows; Start opened the new session |
| F-017 | Optional initial prompt; sends when new session ready | P0 | SceneModel.start | implemented | [AUDIT.md:89](../../AUDIT.md#L89); prompt sent after create; UI |
| F-018 | Message delivery: type now / answer if waiting / queue if busy / resume if ended | P0 | ComposerModel, Outbox | implemented | [AUDIT.md:90](../../AUDIT.md#L90); IT composerSendsOptimistically…, sendDeliversQueuesWhileBusy… |
| F-019 | Stop/interruption (Escape for agent, Ctrl-C shell), correctly settle state | P0 | ComposerModel.stop, SessionModel.interrupt | implemented | [AUDIT.md:91](../../AUDIT.md#L91); IT sendDeliversQueuesWhileBusyAndSteersOrStops |
| F-020 | Answer permission prompts Approve/Deny; choices/cursor pickers | P0 | AskPanelView, AskTarget | implemented | [AUDIT.md:92](../../AUDIT.md#L92); IT approvesAPermissionPromptOnlyWhileItIsShowing |
| F-021 | Multi-question elicitation forms; custom answers and submit | P0 | QuestionForm, QuestionFormView | implemented | [AUDIT.md:93](../../AUDIT.md#L93); UT question form; UI |
| F-022 | Persistent follow-up queue and queued-message count | P0 | QueueModel, QueueTrayView | implemented | [AUDIT.md:94](../../AUDIT.md#L94); IT queue |
| F-023 | Queue: Send now (interrupts current turn), Edit, Cancel, Cancel all | P0 | QueueModel, QueuePanel | implemented | [AUDIT.md:95](../../AUDIT.md#L95); IT steer; edit/cancel UI |
| F-024 | Queue drag-to-reorder | P0 | QueuePanel onMove | implemented | [AUDIT.md:96](../../AUDIT.md#L96); UI |
| F-025 | Ended session stays visible with Resume; typing resumes and sends | P0 | EndedBanner, ComposerModel | implemented | [AUDIT.md:97](../../AUDIT.md#L97); send resumes first; UI |
| F-026 | Agent-native live model/effort change, mode cycling, fallback relaunch with same conversation | P1 | LaunchState, ConfirmPlanSheet | implemented | [AUDIT.md:98](../../AUDIT.md#L98); UT plans; UI pickers; the composer's model and effort chips open menus: on the iPhone simulator against the demo host (10 November 2026) Sonnet then Opus switched live (host audit `session.switch … delivered`); Skip permissions asked to confirm first |
| F-027 | Rename session inline; pin/unpin; shared session ordering | P1 | SessionHeader, SessionListView | implemented | [AUDIT.md:99](../../AUDIT.md#L99); rename/pin/reorder; UI |
| F-028 | Fork conversation to new id + isolated git worktree, optional prompt/choices, lineage | P1 | ForkSheet | implemented | [AUDIT.md:100](../../AUDIT.md#L100); UI |
| F-029 | Continue conversation in another agent (transcript priming) | P1 | ContinueInSheet, FeedProjection.continuePrompt | implemented | [AUDIT.md:101](../../AUDIT.md#L101); UT continue prompt; UI |
| F-030 | Send to another agent/session: last reply or subscription summary | P1 | SendToSheet, SessionModel.handoff | implemented | [AUDIT.md:102](../../AUDIT.md#L102); UT hand-off text; UI |
| F-031 | Slash autocomplete (`/`) and project file mention (`@`) | P1 | ComposerModel suggestions | implemented | [AUDIT.md:103](../../AUDIT.md#L103); UT completion trigger; UI; on touch, / and @ also wait in the composer's tray (a swipe up): seen on the iPhone simulator, @ listing the demo project's files and inserting the pick; the tray and the suggestions float over the transcript without moving it (11 November 2026, see TEST-MATRIX) |
| F-032 | Attach local files, image paste/drop, upload paths into prompt | P1 | ComposerModel.attach, ComposerTextView paste/drop | implemented | [AUDIT.md:104](../../AUDIT.md#L104); IT uploadsLandOwnerOnly… |
| F-033 | Dictation/mic; keep composer focus and keyboard when sending | P1 | ComposerTextView (UITextView) | implemented | [AUDIT.md:105](../../AUDIT.md#L105); system dictation; focus kept on send |
| F-034 | Recent prompts (cross-device), compose/edit, shift-enter multiline, empty Enter steers queued top | P1 | ComposerModel recall/steer | implemented | [AUDIT.md:106](../../AUDIT.md#L106); UI keys; UT; on a touch keyboard Return starts a new line (Send is the button), and your bubble keeps the line breaks: seen on the iPhone simulator (11 November 2026); Option-Return not yet seen |
| F-035 | Saved unsent draft per session across devices (source device), 14d expiry | P0 | DraftSync | implemented | [AUDIT.md:107](../../AUDIT.md#L107); IT draftsFollowTheSessionAcrossDevices…, draftsFillAnUntouchedBox… |
| F-036 | Session/branch selector, new branch, dirty marker, PR link | P1 | BranchSheet, DiffModel.pull | implemented | [AUDIT.md:108](../../AUDIT.md#L108); UI |
| F-037 | Terminate session with confirmation (record stays in History) | P1 | ConfirmTerminateSheet, SceneModel.terminate | implemented | [AUDIT.md:109](../../AUDIT.md#L109); UI |
| F-038 | Custom tmux session/name; launch args; optional continue/isolated worktree; multi-host create | P2 | NewSessionSheet | implemented | [AUDIT.md:110](../../AUDIT.md#L110); label/args/resume/worktree/host and a tmux session picker with New session… (per host); IT aNewSessionGoesIntoTheTmuxSessionYouName |
| F-039 | New project folder (one level within root) + optional `git init` | P2 | NewSessionSheet | implemented | [AUDIT.md:111](../../AUDIT.md#L111); new folder + git init; UI |
| F-040 | "Run in project" command hierarchy | P2 | Palette provider .projects | implemented | [AUDIT.md:112](../../AUDIT.md#L112); UT palette |
| F-041 | Hide ended/saved record from History without deleting transcript | P2 | HistoryRowView | implemented | [AUDIT.md:113](../../AUDIT.md#L113); Hide from History; UI |
| F-042 | Copy attach CLI command, direct terminal scrollback text and copy-last-reply | P2 | SessionMenu, ScrollbackSheet | implemented | [AUDIT.md:114](../../AUDIT.md#L114); copy attach/scrollback/copy last; UI |
| F-043 | Host-owned update installed agent CLIs, version detection | P3 | Sessions / Composer | substituted | [AUDIT.md:115](../../AUDIT.md#L115); Host installs/updates CLIs; native shows versions and runs the check (Settings → Agents) |
| F-044 | Full interactive terminal with ANSI/Unicode, text selection, copy/paste, links | P0 | TerminalScreen (SwiftTerm 1.99.1) | implemented | [AUDIT.md:121](../../AUDIT.md#L121); IT terminalRendersRealTmuxOutputThroughSwiftTerm… (Linux); iOS rendering unverified |
| F-045 | Terminal attach/re-attach on network loss, live resize and immediate redraw | P0 | TerminalConnection | implemented | [AUDIT.md:122](../../AUDIT.md#L122); re-attach, resize; IT |
| F-046 | Touch terminal scrollback, on-screen key bar Ctrl/Alt/Shift, Esc/Tab/arrows/paste | P0 | KeyBar, AppTerminalView | implemented | [AUDIT.md:123](../../AUDIT.md#L123); sticky modifiers, pan scroll; a tap gives the terminal the keyboard (a program tracking the mouse, like tmux, used to take that first tap as a click, so a phone could never type); one key row (SwiftTerm's own accessory is off) with Hide Keyboard pinned at its end; pasted images and dropped files upload and type their paths; tour on the iPhone simulator |
| F-047 | GUI transcript typed feed snapshot/append/paging, switches without restarting agent | P0 | FeedStream, TranscriptView | implemented | [AUDIT.md:124](../../AUDIT.md#L124); IT guiFeedCarriesTypedTranscript… |
| F-048 | GUI user/assistant bubbles, Markdown/GFM, tables, links, fenced code/copy | P0 | Markdown, MarkdownView, SelectableProse | implemented | [AUDIT.md:125](../../AUDIT.md#L125); UT MarkdownTests; the agent's words select under a finger (press and hold picks a word, dragging on selects across paragraphs, headings and lists), their edit menu adds Quote in Reply (the selection, as Markdown) and Message (Copy Message, Copy Link, Share Link…); steps and widgets keep the message's context menu; selection walk on an iPhone 18 Pro simulator, 11 November 2026 (TEST-MATRIX) |
| F-049 | GUI tool events with statuses, expandable args/results, command output, diffs, plans/checklists | P0 | ToolPresentation, ToolRowView | implemented | [AUDIT.md:126](../../AUDIT.md#L126); IT tool call |
| F-050 | Pending/waiting/finished/no-result and hidden/visible reasoning/tool steps | P0 | TranscriptView, stepsHidden | implemented | [AUDIT.md:127](../../AUDIT.md#L127); UI |
| F-051 | Inbox: needs-you cards with same AskSummary and options as session; working/idle/done groups | P0 | InboxView, AskCard | implemented | [AUDIT.md:128](../../AUDIT.md#L128); UI; IT approve |
| F-052 | Status badges, session detail, unread, elapsed-time updates, usage-limit notices | P0 | StatusPill, Elapsed | implemented | [AUDIT.md:129](../../AUDIT.md#L129); UI |
| F-053 | GUI: optimistic outbox messages until in transcript; live working timer | P1 | Outbox, TranscriptView | implemented | [AUDIT.md:130](../../AUDIT.md#L130); IT optimistic send |
| F-054 | GUI: message rail tick per user prompt, jump to previous turns; Browse messages | P1 | MessageRail, FeedProjection.railItems/activeRail/railRange, SessionModel.reveal | implemented | [AUDIT.md:131](../../AUDIT.md#L131); UT theRailLists…, pastFifteenTicks…; tap or slide to a tick, older pages load to reach it; browse/jump commands; the rail seen drawn beside long transcripts on the iPhone and iPad simulators (10 November 2026); tapping a tick not yet walked |
| F-055 | History: registered ended + discovered sessions, filter, resume, fork, hide | P1 | HistoryView | implemented | [AUDIT.md:132](../../AUDIT.md#L132); UI |
| F-056 | Switcher: live/history/content matches; fuzzy search, scoped query tokens; open at turn | P1 | SwitcherSearch, SwitcherContent, SwitcherView, SceneModel.openHit | implemented | [AUDIT.md:133](../../AUDIT.md#L133); UT SwitcherTests (tokens, filters, ranking, History gate, content query, highlights, off/indexing notes); IT open-at-turn on a live transcript; switcher seen open on the iPad simulator (⌘K, 10 November 2026), listing live sessions with status, project and branch, and narrowing as you type; open-at-turn not walked there |
| F-057 | Content search full-text over agent transcripts and side chats, across hosts | P1 | SearchView, SearchModel | implemented | [AUDIT.md:134](../../AUDIT.md#L134); UI; scopes/filters |
| F-058 | Generative UI widgets: card, choices, table, checklist, stats, bar-chart, progress, links, image, code, diff | P1 | WidgetModel, WidgetView | implemented | [AUDIT.md:135](../../AUDIT.md#L135); IT choices widget; UI all types |
| F-059 | Agent asking: command, permission, edit diff, multi-choice form, unsupported picker fallback to Terminal | P1 | AskPanelView, ScreenChoicesView | implemented | [AUDIT.md:136](../../AUDIT.md#L136); terminal fallback; IT AskIntegrationTests: the question dialog one question at a time and as the hook's whole set, its review (answers listed), a folder-trust cursor list, plan approval with the plan drawn from ExitPlanMode; an agent's *startup* folder-trust prompt (Grok, Claude Code, Gemini, Muse; ah native/5-trust-prompts) reads as waiting with `ask.trust`: the first screen says so, Up next holds what's sent (no Steer now), and New session's "Skip startup confirmations" has the host accept it (demo tour 2026-11-11, `.demo-untrusted` folder) |
| F-060 | Blank GUI and empty Inbox offer recent conversations | P1 | InboxView | implemented | [AUDIT.md:137](../../AUDIT.md#L137); recent conversations on empty; UI |
| F-061 | Terminal scrollback as selectable text; selectable last screen when ended | P2 | ScrollbackSheet, EndedScreen | implemented | [AUDIT.md:138](../../AUDIT.md#L138); UI |
| F-062 | Cache newest GUI page and session list encrypted per signed-in browser, fast first paint | P2 | SessionModel.FeedCache, HubStore.useCache, SealedCache | implemented | [AUDIT.md:139](../../AUDIT.md#L139); IT theNewestTranscriptPageIsSealedAndPaintsBeforeTheStream (page and list, ciphertext at rest, cold start paints); UT aColdStartPaintsLastTimesListUntilTheHostAnswers |
| F-063 | Inline GFM specialized GitHub rendering of descriptions/review threads | P2 | MarkdownView | implemented | [AUDIT.md:140](../../AUDIT.md#L140); PR descriptions, threads; UT |
| F-064 | Cached scroll position, session recentness, keyboard focus/selection state across navigation | P0 | SceneSnapshot scroll/focus | implemented | [AUDIT.md:141](../../AUDIT.md#L141); IT aRelaunchedWindowReopensWhereItWas… |
| F-065 | Split right and below; independent sessions in tiled panes | P1 | WorkspaceModel, WorkspaceView | implemented | [AUDIT.md:149](../../AUDIT.md#L149); UT LayoutTests/WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace |
| F-066 | Drag divider to resize; focused pane accent border | P1 | SeamHandle, PaneView | implemented | [AUDIT.md:150](../../AUDIT.md#L150); UI |
| F-067 | In-pane chooser: new shell, new agent or existing session | P1 | ChooserPane | implemented | [AUDIT.md:151](../../AUDIT.md#L151); UI; UT |
| F-068 | Replace focused pane from sidebar/chooser | P1 | WorkspaceModel.fill/replace | implemented | [AUDIT.md:152](../../AUDIT.md#L152); UT |
| F-069 | Close pane without terminating its process; maximize; flip split | P1 | WorkspaceModel | implemented | [AUDIT.md:153](../../AUDIT.md#L153); UT |
| F-070 | Workspaces 1–9; per-workspace tiles; move session to workspace | P1 | Workspaces | implemented | [AUDIT.md:154](../../AUDIT.md#L154); UT; IT |
| F-071 | Pane mode submap `h/j/k/l`, Shift-move, split, resize, maximize, flip, replace, close | P1 | WorkspaceModel.submapKey, SubmapHUD | implemented | [AUDIT.md:155](../../AUDIT.md#L155); UT |
| F-072 | Resize mode and directional focus with Ctrl+Shift+arrows | P1 | WorkspaceModel.nudge/focusPane | implemented | [AUDIT.md:156](../../AUDIT.md#L156); UT |
| F-073 | Command palette hierarchy and searchable action catalog | P1 | PaletteTree, PaletteView | implemented | [AUDIT.md:157](../../AUDIT.md#L157); UT palette |
| F-074 | Hardware keyboard on iPad, all bindings, key hints, which-key overlay | P1 | MenuCommands, SceneRootController, WhichKeyHUD | implemented | [AUDIT.md:158](../../AUDIT.md#L158); UT matcher/which-key; hardware keyboard unverified |
| F-075 | iPad width adapts: wide sidebar, medium-width overlay, compact phone UI | P1 | MainSplitController | implemented | [AUDIT.md:159](../../AUDIT.md#L159); split ↔ compact tabs; UI |
| F-076 | iPad long press/right-click menus, pointer hover, drag reordering, edge reveal sidebar | P1 | SessionListView, context menus | implemented | [AUDIT.md:160](../../AUDIT.md#L160); UI |
| F-077 | Drag sidebar session onto edge of pane to split | P1 | PaneDrop (edge or center zones) | implemented | [AUDIT.md:161](../../AUDIT.md#L161); UT droppingOnPanesSplitsSwapsAndCarriesTheKeyboard; drop zones highlighted; panes drag too; UI compiles, not yet seen running |
| F-078 | Scratchpad floating shell from anywhere | P1 | SceneModel.toggleScratchpad, ScratchpadView | implemented | [AUDIT.md:162](../../AUDIT.md#L162); UI |
| F-079 | Split/open in new pane from switcher (Ctrl+Enter) | P1 | SwitcherState.asTile, SwitcherView ⌘↵/⌃↵ | implemented | [AUDIT.md:163](../../AUDIT.md#L163); open-in-pane command and ⌘↵/⌃↵ in the switcher; UI compiles, not yet seen running |
| F-080 | FLIP pane transitions, gliding list selection, spring/reduced motion | P2 | SwiftUI animations | implemented | [AUDIT.md:164](../../AUDIT.md#L164); system Reduce Motion; UI |
| F-081 | Stage Manager window control inset setting for standalone PWA | P2 | System window controls | substituted | [AUDIT.md:165](../../AUDIT.md#L165); PWA inset setting has no native equivalent; iPadOS draws window controls |
| F-082 | Omarchy desktop launcher / Hyprland shortcut to open ah | P3 | SystemSection (Desktop) | implemented | [AUDIT.md:166](../../AUDIT.md#L166); add/remove the host's launcher entry, copy the Hyprland bind; integration test |
| F-083 | Bottom bar Inbox / Sessions / History / Commands with counts | P0 | MainSplitController tabs | implemented | [AUDIT.md:172](../../AUDIT.md#L172); Inbox/Sessions/History/Review/Search tabs, Inbox badge; Commands via palette |
| F-084 | Push/pop session navigation and interactive edge swipe back | P0 | UINavigationController per tab | implemented | [AUDIT.md:173](../../AUDIT.md#L173); push/pop + edge swipe; UI |
| F-085 | Keyboard-aware composer, stable focus, safe areas; no page jump on typing | P0 | ComposerTextField | implemented | [AUDIT.md:174](../../AUDIT.md#L174); UI; walked on the iPhone and iPad simulators (10 November 2026, see TEST-MATRIX): grows to eight lines then scrolls, shrinks back when emptied, a flick down puts the keyboard away on touch; the transcript holds still as the box grows, the chips open, a message is queued or a menu lifts (11 November 2026, recordings measured frame by frame) |
| F-086 | Agents open in GUI by default unless device chose terminal | P0 | SceneModel.setSurface | implemented | [AUDIT.md:175](../../AUDIT.md#L175); per-device surface preference; UI |
| F-087 | Full-width sheet for New session/Settings, detents for reviewer, draggable dismissal | P1 | SceneRootController.makeModal | implemented | [AUDIT.md:176](../../AUDIT.md#L176); form/page sheets with detents |
| F-088 | Session/History press-and-hold context menu, swipe actions, distinct danger confirmations | P1 | context menus, swipe actions, confirmations | implemented | [AUDIT.md:177](../../AUDIT.md#L177); UI; a session's row swiped right pins, swiped left (or all the way) terminates through the same confirmation as the menu: seen on the iPhone simulator (11 November 2026, see TEST-MATRIX) |
| F-089 | Touch-first session toolbar: GUI/Terminal, Diff, Files, Chat, Queue, Snapshots, Preview, Stack | P1 | SessionHeader, PanelsMenu | implemented | [AUDIT.md:178](../../AUDIT.md#L178); UI |
| F-090 | Native-style toggle switches, minimum touch targets, content size & accessibility | P1 | system controls | implemented | [AUDIT.md:179](../../AUDIT.md#L179); UI; accessibility audit pending |
| F-091 | Platform haptic for holds and swipe thresholds | P1 | Haptics | implemented | [AUDIT.md:180](../../AUDIT.md#L180); UI |
| F-092 | Large title collapse, frosted bottom/nav chrome | P2 | UIKit bars | implemented | [AUDIT.md:181](../../AUDIT.md#L181); UI |
| F-093 | Terminal exact-line inertial scroll, pinch font resize, sticky key modifiers | P2 | AppTerminalView | implemented | [AUDIT.md:182](../../AUDIT.md#L182); exact-line pan with momentum after a flick (yields to a text selection's drag); pinch, ⌘= / ⌘- / ⌘0 and Settings share one per-device size that every open terminal follows; sticky modifiers |
| F-094 | iOS PWA standalone viewport shim, WebKit visualViewport polling, Safari faux haptic toggle | P3 | Native keyboard/safe areas/haptics; web hacks excluded | substituted | [AUDIT.md:183](../../AUDIT.md#L183); Safari/PWA viewport hacks replaced by native keyboard/safe-area/haptics |
| F-095 | Home-screen installation and service worker mechanics | P3 | Native lifecycle/distribution/APNs; PWA artifacts excluded | substituted | [AUDIT.md:184](../../AUDIT.md#L184); PWA install replaced by native distribution and APNs |
| F-096 | Live uncommitted diff by file with +/− and line numbers | P1 | DiffModel, DiffPanel | implemented | [AUDIT.md:190](../../AUDIT.md#L190); UI; UT diff parsing |
| F-097 | Add file/line anchored feedback and send to current agent | P1 | DiffModel.send(comment:) | implemented | [AUDIT.md:191](../../AUDIT.md#L191); UI |
| F-098 | Browse remote host files, roots, hidden files, directories | P1 | FilesModel, FilesPanel | implemented | [AUDIT.md:192](../../AUDIT.md#L192); UI |
| F-099 | Host file preview, download, upload into directory, insert path/mention into conversation | P1 | FilesModel | implemented | [AUDIT.md:193](../../AUDIT.md#L193); IT uploads; preview/download UI |
| F-100 | Git branch search/switch/create and PR discovery | P1 | BranchSheet | implemented | [AUDIT.md:194](../../AUDIT.md#L194); UI |
| F-101 | Per-session developer preview: discover listening ports, start/stop proxy, HMR/WS | P1 | PreviewModel, PreviewPanel, preview-session cookie | implemented | [AUDIT.md:195](../../AUDIT.md#L195); ah native/1-device-auth preview session tests; UI |
| F-102 | Worktree create on session start, list managed trees; dirty/ahead/in use/sizes | P2 | NewSessionSheet, WorktreesView | implemented | [AUDIT.md:196](../../AUDIT.md#L196); UI |
| F-103 | Worktree safe removal/orphan detection/bulk cleanup | P2 | WorktreesModel | implemented | [AUDIT.md:197](../../AUDIT.md#L197); UI; force needed for dirty/ahead |
| F-104 | Per-turn git snapshots; enable/disable; safety snapshot before rollback | P2 | SnapshotsModel, SnapshotsPanel | implemented | [AUDIT.md:198](../../AUDIT.md#L198); UI |
| F-105 | GitHub PR link and session-associated stack panel | P2 | StackPanel | implemented | [AUDIT.md:199](../../AUDIT.md#L199); UI |
| F-106 | Review landing page lists stacks in progress, recent project PRs, alerts | P1 | ReviewHomeView, ReviewAlertRow | implemented | [AUDIT.md:207](../../AUDIT.md#L207); UI |
| F-107 | Start a review from GitHub PR chain, manually chosen PRs, native GitHub stack | P1 | StartReviewView | implemented | [AUDIT.md:208](../../AUDIT.md#L208); chain/manual/native; UI |
| F-108 | Ordered stack spine showing trunk, layers, role labels, progress, checks, findings, merge status | P1 | StackCockpitView spine, LayerRow | implemented | [AUDIT.md:209](../../AUDIT.md#L209); UI; UT LayerConfidence |
| F-109 | Stack cockpit: Up next, merge order, made-in and fixes-go-to agents, plan, pinned decisions | P1 | StackCockpitView | implemented | [AUDIT.md:210](../../AUDIT.md#L210); up next, made-in, fixes-go-to, plan, decisions; UI |
| F-110 | Layer page: title, progress prev/next, new/re-review status banner, action | P1 | LayerView | implemented | [AUDIT.md:211](../../AUDIT.md#L211); UI; j/k, ⌥⌘↓ next. Decision bar (I reviewed → Merge → Merged), next layer on a phone, stack bar (Review #N, Merge N layers). Walked on the demo host, iPhone 18 Pro sim (2026-11-11) |
| F-111 | Layer diff scopes: This PR, Since review (including `git range-diff`), cumulative From trunk | P1 | ReviewModel.loadDiff | implemented | [AUDIT.md:212](../../AUDIT.md#L212); This PR / Since review (range-diff) / From trunk; UI; files fold, Viewed boxes per head (in memory). Walked on the demo host, iPhone 18 Pro sim (2026-11-11) |
| F-112 | PR description (GitHub Markdown, HTML/suggestions/images) and model-generated briefing | P1 | LayerView.understand | implemented | [AUDIT.md:213](../../AUDIT.md#L213); briefing labeled as a model summary; UI |
| F-113 | Reviewer conversation via configured subscription, one stack thread with per-question layer scope | P1 | ReviewModel.ask | implemented | [AUDIT.md:214](../../AUDIT.md#L214); UI |
| F-114 | Attach diff line/range/file or existing finding to reviewer; Ask reviewer | P1 | AskContext attach | implemented | [AUDIT.md:215](../../AUDIT.md#L215); UT encoding; UI; a tapped line is picked, its actions (Ask, Finding) in the bar. Walked on the demo host, iPhone 18 Pro sim (2026-11-11) |
| F-115 | Findings: from user, reviewer, GitHub threads/bots; blocking/should/nit; ownership and state | P1 | FindingRow | implemented | [AUDIT.md:216](../../AUDIT.md#L216); UI |
| F-116 | Convert selected findings into one drafted agent instruction with stack context | P1 | DispatchSheet | implemented | [AUDIT.md:217](../../AUDIT.md#L217); UI |
| F-117 | Agent working/fixing/no-push, re-review verdict: addressed/partial/not, unrequested changes | P1 | LayerView.verify | implemented | [AUDIT.md:218](../../AUDIT.md#L218); verdict shown as the model's, accepted only by you; UI |
| F-118 | Mark reviewed, withdraw, Accept fixes; stale patch detection, separate merge gates | P1 | ReviewModel.markReviewed/acceptFixes | implemented | [AUDIT.md:219](../../AUDIT.md#L219); UT LayerConfidence; mark reviewed walked (bar turns to Merge); withdraw not walked (the sim's menu keyboard hid it). Walked on the demo host, iPhone 18 Pro sim (2026-11-11) |
| F-119 | Merge & next exact-head SHA, retarget/restack, GitHub-native stack merge and queue | P1 | MergeLayerSheet, ReviewModel.merge(expectedHead:) | implemented | [AUDIT.md:220](../../AUDIT.md#L220); re-sync, refuse moved head; UT |
| F-120 | Merge the stack bottom-up; method merge/squash/rebase; held/waiting/restack | P1 | StackMergeSheet, StackMergePlan | implemented | [AUDIT.md:221](../../AUDIT.md#L221); markReviewed:false always; UT StackMergePlan |
| F-121 | Ask implementation harness to carry out restack or merge; track whether it completed | P2 | DispatchSheet kind restack/merge | implemented | [AUDIT.md:222](../../AUDIT.md#L222); UI |
| F-122 | Import bot/human GitHub threads with code suggestions and replies; reply & resolve | P2 | importThreads, ResolveThreadSheet | implemented | [AUDIT.md:223](../../AUDIT.md#L223); UI |
| F-123 | Add/remove/reorder/rename/skips layers; change owner, plan, merge method, sync | P2 | StackManageSheet | implemented | [AUDIT.md:224](../../AUDIT.md#L224); rename/method/plan/owner/order/roles/skip/add/remove; UI |
| F-124 | Convert chain to GitHub native stack, follow new PRs | P2 | StackManageSheet link | implemented | [AUDIT.md:225](../../AUDIT.md#L225); UI |
| F-125 | Review Inbox cards, notifications, stack panel in sessions | P2 | InboxView, StackPanel, APNs review alerts | implemented | [AUDIT.md:226](../../AUDIT.md#L226); UI |
| F-126 | Semantic overview of what changes, architecture visualization, evidence-backed diagrams | P2 | Review | unstarted | [AUDIT.md:227](../../AUDIT.md#L227); no native journey evidence |
| F-127 | Session side chat independent of the coding agent, includes code/repo context | P1 | SideChatModel, ChatPanel | implemented | [AUDIT.md:235](../../AUDIT.md#L235); UI |
| F-128 | Read-only repo tools (`repo_map`, `pr_info`, `pr_diff`, `working_diff`, `read_file`, `commit_show`) | P1 | host tools via ChatPanel | implemented | [AUDIT.md:236](../../AUDIT.md#L236); tools run on the host |
| F-129 | Review tools (`stack_map`, exact `layer_diff`, `read_file`, `pr_threads`, `origin`, plan, findings, commits) | P1 | host tools via reviewer | implemented | [AUDIT.md:237](../../AUDIT.md#L237); tools run on the host |
| F-130 | Conversation-specific chat provider selection; follow-up buttons; send chat output to agent | P1 | ChatPanel | implemented | [AUDIT.md:238](../../AUDIT.md#L238); per-chat subscription, follow-ups, send to agent; UI |
| F-131 | Past side-chat conversation list/search, clear thread | P2 | PastChatsView | implemented | [AUDIT.md:239](../../AUDIT.md#L239); list/search/read; UI |
| F-132 | Summary to send to another agent through subscription | P2 | SendToSheet | implemented | [AUDIT.md:240](../../AUDIT.md#L240); UI |
| F-133 | Search index enable/rebuild; source scope/speaker/time filter | P2 | SearchView filters, SearchSection | implemented | [AUDIT.md:241](../../AUDIT.md#L241); scope/speaker/time/host; UI |
| F-134 | **Security:** device name; lock now; sign out; one-time device enrollment code | P0 | SecuritySection, AppearanceSection | implemented | [AUDIT.md:247](../../AUDIT.md#L247); device name, lock, remove device, setup codes; UI |
| F-135 | **Security:** passkeys list/add/remove; signed-in device list, revoke, sign out others | P0 | SecuritySection | implemented | [AUDIT.md:248](../../AUDIT.md#L248); passkeys list/remove; adding passkeys substituted by device enrollment (DECISIONS) |
| F-136 | **Security:** machine/host bearer tokens list, make & revoke | P1 | SecuritySection, NewTokenCard | implemented | [AUDIT.md:249](../../AUDIT.md#L249); make (secret shown once, never stored, local-only clipboard that expires), list with last use, revoke; integration test |
| F-137 | **Security:** optional host-only master password status, prompt history clear, recent activity/audit log | P2 | SecuritySection | implemented | [AUDIT.md:250](../../AUDIT.md#L250); master password status, prompt history clear, activity; UI |
| F-138 | **Appearance:** System, Dark, Light, Omarchy (host colors/font sync) | P0 | AppearanceSection, ThemeModel | implemented | [AUDIT.md:251](../../AUDIT.md#L251); UT Omarchy mapping; UI |
| F-139 | **Appearance:** Window buttons `In a window/Always/Never` | P3 | System window controls | substituted | [AUDIT.md:252](../../AUDIT.md#L252); PWA-only setting |
| F-140 | **Shortcuts:** searchable 89-command list, rebind/clear/reset conflicts and when-applicable | P1 | ShortcutsSection, ChordRecorder | implemented | [AUDIT.md:253](../../AUDIT.md#L253); UT KeyBindings; UI |
| F-141 | **Notifications:** enable, Needs you, Finished toggle per device | P0 | NotificationsSection, PushRegistrar, LocalAlerts, AlertJanitor | implemented | [AUDIT.md:254](../../AUDIT.md#L254); ah APNs tests; without push (a Personal Team build) the app posts the same alerts itself while it runs (Mac in the background, iPad beside another app, the grace period after leaving with a session at work); no banner for the session on screen, Notification Center only while the app is in front, alerts leave once answered or opened; leaving the app stops being a viewer, so a turn that ends meanwhile isn't taken as seen; UT AlertRules/AlertWatcher; simulator walk |
| F-142 | **Agents:** show/hide from New session, installed CLI names/versions, check updates | P1 | AgentsSection | implemented | [AUDIT.md:255](../../AUDIT.md#L255); UI |
| F-143 | **Agents:** add arbitrary CLI command / remove custom preset | P2 | AgentsSection | implemented | [AUDIT.md:256](../../AUDIT.md#L256); UI |
| F-144 | **Subscriptions:** provider presets Claude/OpenAI/Gemini/Muse/Other; name, URL, model, key | P1 | SubscriptionsSection | implemented | [AUDIT.md:257](../../AUDIT.md#L257); UI |
| F-145 | **Subscriptions:** active default, per-chat/review/briefing choice, model discovery, edit/delete | P1 | SubscriptionsSection, ChatPanel | implemented | [AUDIT.md:258](../../AUDIT.md#L258); default, discovery, per-chat, briefing choice; UI |
| F-146 | **Subscriptions:** optionally expose key to launched sessions via named env var | P1 | SubscriptionEditor | implemented | [AUDIT.md:259](../../AUDIT.md#L259); UI |
| F-147 | **Environment:** add/edit/delete global values, secret mask, stale running sessions, restart one/all idle | P1 | EnvironmentSection | implemented | [AUDIT.md:260](../../AUDIT.md#L260); UI |
| F-148 | **Search:** enabled, index status/details, rebuild | P2 | SearchSection | implemented | [AUDIT.md:261](../../AUDIT.md#L261); UI |
| F-149 | **System:** hook status per agent, install/remove, screen-rule audit and clear | P2 | SystemSection | implemented | [AUDIT.md:262](../../AUDIT.md#L262); UI |
| F-150 | **System:** Add/remove Omarchy desktop launcher; copy Hyprland bind | P3 | SystemSection (Desktop) | implemented | [AUDIT.md:263](../../AUDIT.md#L263); `/api/system/desktop`; integration test |
| F-151 | **System:** Restart server, rebuild and restart, reload UI, uploads disk usage, clear uploads | P2 | SystemSection | implemented | [AUDIT.md:264](../../AUDIT.md#L264); restart, rebuild and restart (build output shown on failure), clear uploads; reload UI is the web page's own; no uploads-usage endpoint exists in the source |
| F-152 | Host `config.json`: `port`, host, `defaultSession`, `projectRoots`, `idleAfter`, `peers`, `files.roots`, `promptHistory`, `snapshots`, `preview.ports`, auth, presets | P3 | Settings | substituted | [AUDIT.md:265](../../AUDIT.md#L265); Host config stays host/CLI authority; the meaningful GUI controls are in Settings |

## Keyboard command checklist

Captured by executing the actual TypeScript catalog. Every command has a native handler in `SceneModel` (availability + action) and a menu-bar `UIKeyCommand`; the logic is tested on Linux, the UIKit mapping has not run on hardware. `to-workspace-N` is the actual source ID (the mission also calls it send-to-workspace). Editor/terminal ownership, dialogs, field boundaries and iPadOS key conflicts remain separate verification gates.

| Command ID | Group / action | Scopes | Priority | Status | Source / test evidence |
| --- | --- | --- | --- | --- | --- |
| `command-palette` | Navigate: Command palette | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `switcher` | Navigate: Search or jump | app, terminal, field, dialog | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `cycle-prev` | Navigate: Previous session | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `cycle-next` | Navigate: Next session | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `new-session` | Navigate: New session | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `new-project` | Navigate: New project | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `toggle-sidebar` | Navigate: Toggle sidebar | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `go-inbox` | Navigate: Inbox | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `go-history` | Navigate: History | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `go-review` | Navigate: Review | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `go-search` | Navigate: Search | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `worktrees` | Navigate: Worktrees | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `go-settings` | Navigate: Settings | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `focus-sidebar` | Navigate: Focus the session list | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `focus-main` | Navigate: Focus the session | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `reload-page` | Navigate: Reload page | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `show-shortcuts` | Navigate: Keyboard shortcuts | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `toggle-view` | Session: GUI or terminal | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `toggle-steps` | Session: Hide / show steps | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `toggle-panel` | Session: Toggle side panel | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `reply` | Session: Reply | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `approve` | Session: Approve | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `deny` | Session: Deny | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `interrupt` | Session: Stop the turn | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `send-now` | Session: Send next queued now | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `clear-queue` | Session: Cancel all queued | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `pick-model` | Session: Switch model | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `pick-effort` | Session: Switch reasoning effort | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `copy-last` | Session: Copy the agent's last reply | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `jump-latest` | Session: Jump to latest | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `browse-messages` | Session: Browse messages | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `switch-branch` | Session: Switch branch… | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `rename` | Session: Rename session | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `fork` | Session: Fork session… | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `send-to` | Session: Send to… | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `pin` | Session: Pin | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `panel-diff` | Session: Diff | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `panel-files` | Session: Files | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `panel-chat` | Session: Chat | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `panel-queue` | Session: Queue | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `panel-snapshots` | Session: Snapshots | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `panel-preview` | Session: Preview | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `panel-stack` | Session: Stack | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `session-menu` | Session: Session menu | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `scrollback` | Session: Scrollback as text | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `copy-attach` | Session: Copy attach command | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `toggle-keys` | Session: Show or hide on-screen keys | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `terminate` | Session: Terminate session | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `split-right` | Workspace: Split right | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `split-below` | Workspace: Split below | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `close-pane` | Workspace: Close pane | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `focus-pane-left` | Workspace: Pane left | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `focus-pane-right` | Workspace: Pane right | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `focus-pane-up` | Workspace: Pane up | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `focus-pane-down` | Workspace: Pane down | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `move-pane-left` | Workspace: Move pane left | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `move-pane-right` | Workspace: Move pane right | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `move-pane-up` | Workspace: Move pane up | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `move-pane-down` | Workspace: Move pane down | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `toggle-split` | Workspace: Flip split | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `resize-left` | Workspace: Resize: divider left | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `resize-right` | Workspace: Resize: divider right | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `resize-up` | Workspace: Resize: divider up | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `resize-down` | Workspace: Resize: divider down | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `resize-mode` | Workspace: Resize mode | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `pane-mode` | Workspace: Pane mode | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `replace-pane` | Workspace: Replace pane… | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `open-in-pane` | Workspace: Open a session as a new pane… | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `scratchpad` | Workspace: Scratchpad shell | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `maximize-pane` | Workspace: Maximize pane | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `exit-split` | Workspace: Exit split | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-1` | Workspace: Workspace 1 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-2` | Workspace: Workspace 2 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-3` | Workspace: Workspace 3 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-4` | Workspace: Workspace 4 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-5` | Workspace: Workspace 5 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-6` | Workspace: Workspace 6 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-7` | Workspace: Workspace 7 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-8` | Workspace: Workspace 8 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `workspace-9` | Workspace: Workspace 9 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-1` | Workspace: Send to workspace 1 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-2` | Workspace: Send to workspace 2 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-3` | Workspace: Send to workspace 3 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-4` | Workspace: Send to workspace 4 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-5` | Workspace: Send to workspace 5 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-6` | Workspace: Send to workspace 6 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-7` | Workspace: Send to workspace 7 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-8` | Workspace: Send to workspace 8 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |
| `to-workspace-9` | Workspace: Send to workspace 9 | app, terminal, field | P1 | implemented | `../ah/web/shortcuts.ts`; `SceneModel.isAvailable/perform` (UT KeyboardTests, WorkspaceModelTests; IT hardwareKeysDriveTheWorkspace); menu `UIKeyCommand` + `canPerformAction` scope deferral written, unverified on hardware |

## Detailed pending work

The following expands the broad F/specification rows so individual controls, adapters, widgets and important failure cases cannot disappear inside a single completion mark. A row is checked only when verified in the stated scope. A parent F/specification row closes only when its applicable detail rows and acceptance evidence are complete. Destinations below are planned ownership areas, not existing implementations.

### Authentication and secure connection

Source: [SPEC security boundary](../../SPEC.md#native-client-architecture-and-server-boundaries), F-008 and F-134–F-137; canonical backend references are `../ah/server/gate.ts`, `server/auth.ts`, `server/main.ts`, `SECURITY.md` and their security tests. Built on `ah` branch `native/1-device-auth` and in `Sources/Auth`, `Sources/Models/AppModel.swift`; see [TRANSPORT](TRANSPORT.md).

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | A-01 | Define/version an explicit native HTTP/SSE/WS credential and authorization contract without bypassing browser gate rules — *versioned `ah-native-{enroll,login}-v1` contract; ah native/1-device-auth; SECURITY.md* | P0 | implemented |
| [ ] | A-02 | Prove actual Tailscale Serve host/owner identity; reject off-tailnet, wrong-owner, tagged/untrusted-device and identity-unavailable cases — *ah's existing Serve/owner gate applies unchanged to native requests* | P0 | implemented |
| [ ] | A-03 | Implement authenticated user-approved enrollment/pairing, short-lived single-use challenge, expiry/replay/rate-limit protections and truthful failures — *one-time host code, single-use challenge, expiry; ah tests + IT* | P0 | implemented |
| [ ] | A-04 | Issue scoped revocable per-device credentials with expiry; least-privilege HTTP and terminal access; no host CLI-token reuse — *per-device bearer sessions, expiry, removable; never the CLI token* | P0 | implemented |
| [ ] | A-05 | Preserve browser Host/exact-Origin/X-AH/CSRF and Serve protections; adversarial browser/native HTTP/WS regression tests — *browser Origin/X-AH/CSRF unchanged; ah authz + native security tests* | P0 | implemented |
| [ ] | A-06 | Keychain storage/read/update/delete, access policy and protected-data/keychain-loss failure handling; no secret in preferences/logs/journal — *KeychainSecretStore, Secure Enclave key; device unverified* | P0 | implemented |
| [ ] | A-07 | Native lock/sign-out/revocation invalidates state, stops HTTP/SSE/WS and clears account-bound caches/push registration — *IT revocationSignsTheDeviceOutAndClosesItsStreamsAndTerminals; cache cleared on forget* | P0 | implemented |
| [ ] | A-08 | Revalidate credentials on foreground and after expiry/401/403; fail closed without insecure fallback or mutation replay — *any 401/4401 signs out; foreground resync* | P0 | implemented |
| [ ] | A-09 | Verify private `.ts.net` passkey Associated Domains/webcredentials feasibility; implement AuthenticationServices flow or authenticated pairing alternative — *Associated Domains can't cover private per-user .ts.net hosts; device enrollment (DECISIONS)* | P0 | substituted |
| [ ] | A-10 | Configure actual team/bundle ID, signing/provisioning and approved entitlement set; document device/release setup — *needs the account owner's team and provisioning* | P0 | blocked |
| [ ] | A-11 | Account/device identity and cancellation ownership shared across scenes; isolation on host/account change and late-response rejection — *AccountSession shared across scenes; UT/IT* | P0 | implemented |
| [ ] | A-12 | Server audit records for native enrollment/auth failures/revocation/privileged actions, privacy-safe diagnostic errors and secret-leak checks — *ah audit events for native enroll/sign-in/removal; activity shown in Settings* | P0 | implemented |

### Networking and typed APIs

Source: [SPEC transport/DTO boundaries](../../SPEC.md#native-client-architecture-and-server-boundaries), F-001–F-011 and feature APIs in `../ah/web/api.ts`, `web/reviewApi.ts`, `server/feed/schema.ts`. Native destination: Networking and account/host state repositories. B-14–B-20 are the completed pure-code subset only.

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | N-01 | Complete DTO/request/response/error coverage for state, history, presets/catalog, delivery/queue, feed, review, Git/files/search/chat/settings and API compatibility — *APIClient covers every web/api.ts and reviewApi.ts route; UT + IT* | P0 | implemented |
| [ ] | N-02 | Actor-owned authenticated URLSession REST client; host/account attribution, path/query encoding, bounded responses, timeouts and cancellation — *URLSessionTransport (no cookies/cache/redirects), APIClient; IT over FoundationNetworking* | P0 | implemented |
| [ ] | N-03 | Real authenticated SSE read loop feeding parser/reducer serially; full initial state, visibility/freshness/error publication and stream ownership — *StateStream; IT liveStateArrivesAsSnapshotThenPatches* | P0 | implemented |
| [ ] | N-04 | Bounded retry/backoff, full-state reconnect, foreground resync, connection-generation checks and cancellation on suspend/disconnect/revocation — *StateStream backoff/resync, cancellation on revoke; IT revocation* | P0 | implemented |
| [ ] | N-05 | Polling fallback and post-action refresh without stale polls/late prior-connection events overwriting newer state — *StateStream polling while down, never concurrent with the stream* | P0 | implemented |
| [ ] | N-06 | Peer `/h/<host>` HTTP/SSE/WS routing, merged stable identities, peer availability/error UI and removal of stale offline-peer state — *HubStore peer streams; not exercised by IT* | P0 | implemented |
| [ ] | N-07 | Typed feed snapshot/append/pagination transport, bounded incremental decoding and task cancellation on session change — *FeedStream; IT guiFeed* | P0 | implemented |
| [ ] | N-08 | Real WebSocket PTY authorization, binary/control output handling, current-address resolution, attach/resize/input/scroll and explicit close/errors — *TerminalConnection; IT terminal + 4401 on revocation* | P0 | implemented |
| [ ] | N-09 | Authenticated uploads/streaming downloads with filenames/types/size bounds, progress, cancellation and truthful retry/failure state — *uploads IT; downloads via Files* | P0 | implemented |
| [ ] | N-10 | Isolated authenticated preview proxy/cookie/origin strategy, restricted WKWebView navigation, safe media URLs, HMR/absolute-URL tests — *preview-session cookie, non-persistent WKWebView; device HMR unverified* | P1 | implemented |
| [ ] | N-11 | Review/Git/files/search/chat/settings repositories and mutations; server remains authority; destructive actions have explicit intent/results — *Review/panel/settings models; UT* | P1 | implemented |

### Navigation, restoration, drafts and local persistence

Source: [SPEC restoration requirement](../../SPEC.md#nonnegotiable-technology-decisions), [persistence/ownership boundaries](../../SPEC.md#native-client-architecture-and-server-boundaries), F-002, F-007, F-010, F-035, F-062–F-064 and workspace rows. Native destination: UIKit coordinators, per-scene models and GRDB repositories. The v1 host-origin journal is built in B-10–B-13; all extensions below remain pending.

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | R-01 | Typed UIKit routes for Inbox/Sessions/History/Commands/Review/Search/Settings and selected session/panel; push/pop/back behavior — *MainSplitController + tabs; UI* | P0 | implemented |
| [ ] | R-02 | Deep-link parsing/validation and routing to stable host/uid, notification target and conversation turn; no stale tmux navigation — *DeepLink; UT deepLinksFromPushRoutesAndURLs* | P0 | implemented |
| [ ] | R-03 | Versioned selected screen/tab/session/panel/stack/PR restoration metadata and proactive saves on significant navigation — *SceneSnapshot; IT relaunch* | P0 | implemented |
| [ ] | R-04 | Persist workspace 1–9 pane trees, divider ratios, selected workspace, focused/maximized pane and scratchpad context per scene — *Workspaces in SceneSnapshot; UT/IT* | P1 | implemented |
| [ ] | R-05 | Restore independent iPad windows/scene activities and shared account truth without sharing mutable navigation — *SceneModel per UIScene; UI* | P1 | implemented |
| [ ] | R-06 | Reconcile deleted/ended/moved sessions, unavailable hosts and changed review revisions; recover to truthful reachable routes — *RestorationReconciler; IT* | P0 | implemented |
| [ ] | R-07 | Restore scroll/turn/selection/focus/surface preference safely, including rotation/window resize and UI transitions — *scroll anchors/surface/composer focus; IT* | P0 | implemented |
| [ ] | R-08 | Synced per-session drafts with debounce, device/source identity, expiry and multi-device conflict/stale-overwrite handling — *DraftSync; IT* | P0 | implemented |
| [ ] | R-09 | Handoff, other-device presence and focus lifecycle; scene-safe device identity and reconnect without duplicate presence — *presence/focus; Handoff model and continuation: UT, IT; between devices needs signed devices* | P0 | implemented |
| [ ] | R-10 | Design account-bound sensitive caching; Keychain/CryptoKit encryption before storing transcript pages, drafts or sensitive pending UI state — *SealedCache (HKDF + AES-GCM); IT* | P0 | implemented |
| [ ] | R-11 | Bounded retention, storage quotas, fast encrypted cache read, expiry and deletion on sign-out/revocation/account change — *bounded cache, cleared on forget; IT* | P0 | implemented |
| [x] | R-12 | Incremental GRDB metadata/cache migrations and failure recovery preserving history/data; future/corrupt/mismatched payload tests — *GRDB migrator; UT SceneStoreTests run on Linux* | P0 | verified |
| [ ] | R-13 | Protected-data-locked/storage-full/write-failure behavior, backup policy and cache/secret/log inspection on real devices — *needs a device* | P0 | blocked |
| [ ] | R-14 | Kill/relaunch/background/foreground/discard/recreate/two-scene restoration tests with revoked credentials, missing resources and conflicting drafts — *IT relaunch/revocation; device kill/relaunch pending* | P0 | implemented |

### APNs and badges

Source: [SPEC P0 push requirement](../../SPEC.md#product-contract-every-existing-meaningful-workflow) and [push boundary](../../SPEC.md#native-client-architecture-and-server-boundaries); existing `../ah/server/push.ts`/Web Push is a reference for event audience only. Native destination: app notification coordinator plus minimal backward-compatible backend APNs support.

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | AP-01 | Provision APNs app identity, signing, environment-specific entitlement and sender credentials — *entitlements declared; team, APNs key and provisioning need the account owner* | P0 | blocked |
| [ ] | AP-02 | Native permission/registration flow and honest denied/unsupported/error states — *PushRegistrar; NotificationsSection* | P0 | implemented |
| [ ] | AP-03 | Authenticated server registration, token rotation, device/account/environment binding and invalid-token cleanup — *ah native/2-apns registration tied to native sign-in; ah tests* | P0 | implemented |
| [ ] | AP-04 | Host APNs delivery for needs-you/finished audiences with per-device preferences; preserve Web Push — *ah server/apns.ts; ah tests with loopback gateway* | P0 | implemented |
| [ ] | AP-05 | Privacy-minimized notification text/payload; no raw transcript, prompt or credential leakage — *private preview → title only* | P0 | implemented |
| [ ] | AP-06 | Stable host/uid deep-link routing from foreground/background/terminated app; revalidate before any answer/action — *DeepLink + SceneDelegate.open; Approve/Deny need unlock* | P0 | implemented |
| [ ] | AP-07 | Native icon badge calculation/reconciliation/clear; distinguish read/viewed state and multiple hosts — *AppDelegate badge observation* | P0 | implemented |
| [ ] | AP-08 | Preference changes/sign-out/revocation unregister or invalidate audience and prevent stale delivery/actions — *registration dies with the sign-in; ah tests* | P0 | implemented |
| [ ] | AP-09 | Signed physical-device suspended/terminated delivery, permission changes, token rotation and badge/routing verification — *needs a signed device* | P0 | blocked |

### Transcript adapters

Source: SPEC P0 GUI, F-047–F-050, `../ah/server/feed/schema.ts`, `server/feed/adapters/` and `web/gui/`. Native destination: typed feed store and SwiftUI transcript renderer. Each adapter needs actual feed fixtures plus native snapshot/append/pagination/tool-state/rendering evidence; a server adapter existing does not establish native support.

| Done | ID | Adapter / acceptance scope | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | AD-01 | Claude: native feed, text/tool/ask/result behavior and pagination — *IT with a fake Claude transcript* | P0 | implemented |
| [ ] | AD-02 | Codex: native feed, text/tool/ask/result behavior and pagination — *server-normalized feed; not exercised per adapter* | P0 | implemented |
| [ ] | AD-03 | Gemini: native feed, text/tool/ask/result behavior and pagination — *server-normalized feed; not exercised per adapter* | P0 | implemented |
| [ ] | AD-04 | Grok: native feed, text/tool/ask/result behavior and pagination — *server-normalized feed; not exercised per adapter* | P0 | implemented |
| [ ] | AD-05 | Muse: native feed, startup/approval/tool/result behavior and pagination — *server-normalized feed; not exercised per adapter* | P0 | implemented |
| [ ] | AD-06 | Hermes: native feed, text/tool/ask/result behavior and pagination — *server-normalized feed; not exercised per adapter* | P0 | implemented |
| [ ] | AD-07 | opencode: native feed, text/tool/ask/result behavior and pagination — *server-normalized feed; not exercised per adapter* | P0 | implemented |
| [ ] | AD-08 | Unsupported/missing/reset/truncated/malformed feed: truthful unavailable state and real-terminal fallback without restarting conversation — *feed unavailable → terminal surface* | P0 | implemented |

Shared transcript work remains in F-047–F-050/F-053–F-054: GFM/tables/links/code/copy, rich media, expandable tool args/results, command output, diffs, plans/checklists, hidden steps, timers, turn navigation, optimistic outbox reconciliation and pending/no-result states. None has a native renderer yet.

### Native widgets

Source: SPEC P1 widget list, F-058 and `../ah/web/gui/widgets.tsx`/`docs/gui.md`. Native destination: typed SwiftUI widget components. Each row includes decoding, rendering, accessibility, bounds and safe action handling.

| Done | ID | Widget / acceptance scope | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | W-01 | `card`: heading/body/actions with safe native behavior — *WidgetView; UI* | P1 | implemented |
| [ ] | W-02 | `choices`: selectable values and current prompt/action validity — *IT choices widget* | P1 | implemented |
| [ ] | W-03 | `table`: readable rows/columns and overflow behavior — *WidgetView; UI* | P1 | implemented |
| [ ] | W-04 | `checklist`: checked/pending state and accessible labels — *WidgetView; UI* | P1 | implemented |
| [ ] | W-05 | `stats`: values, units and readable accessibility order — *WidgetView; UI* | P1 | implemented |
| [ ] | W-06 | `bar-chart`: bounded values, labels and nonvisual equivalent — *WidgetView; UI* | P1 | implemented |
| [ ] | W-07 | `progress`: determinate/indeterminate semantics and bounds — *WidgetView; UI* | P1 | implemented |
| [ ] | W-08 | `links`: URL validation and appropriate native opening — *WidgetView; UI* | P1 | implemented |
| [ ] | W-09 | `image`: authenticated safe media URLs, loading/failure and accessibility — *WidgetView; UI* | P1 | implemented |
| [ ] | W-10 | `code`: language/code rendering, horizontal reading and copy — *WidgetView; UI* | P1 | implemented |
| [ ] | W-11 | `diff`: safe code comparison with readable additions/deletions — *WidgetView; UI* | P1 | implemented |
| [ ] | W-12 | Unknown/malformed/oversized widget: safe readable fallback; never execute arbitrary content — *WidgetView; UI* | P1 | implemented |

### All nine settings sections

Source: SPEC settings, F-134–F-152 and the source files named in each group. Native destination: UIKit Settings routing and SwiftUI settings forms backed by the appropriate device preferences or host APIs. All nine sections are built in `Sources/Features/Settings/SettingsView.swift` against the host APIs and device preferences; none has run on an Apple platform yet.

| Done | ID | Section / individual control | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | SET-01 | Security — rename this device for drafts/presence/Handoff — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-02 | Security — lock now — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-03 | Security — sign out this device — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-04 | Security — generate/display one-time enrollment code with expiry/single-use behavior — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-05 | Security — passkey list including origin/created/last-used metadata — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-06 | Security — add a passkey where native association is supported, or explain supported pairing path — *passkeys can't bind to a private .ts.net host; device enrollment instead (DECISIONS)* | P0 | substituted |
| [ ] | SET-07 | Security — remove passkey with explicit confirmation — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-08 | Security — signed-in devices/current-device/expiry and last-seen display — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-09 | Security — revoke another device — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-10 | Security — sign out all other devices with confirmation — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-11 | Security — list machine/peer bearer credentials with masked metadata — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-12 | Security — revoke a machine/peer credential — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-13 | Security — master-password configured status; setting/removing stays host-only — *status shown; set/remove stays host-only* | P2 | implemented |
| [ ] | SET-14 | Security — clear server prompt history with confirmation — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-15 | Security — recent activity/audit log with privacy-safe detail — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-16 | Appearance — System mode — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-17 | Appearance — Dark mode — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-18 | Appearance — Light mode — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-19 | Appearance — Omarchy host colors/font sync with native contrast/terminal theming — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-20 | Shortcuts — searchable 89-command list, scopes/default/current bindings and native Help/discoverability — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-21 | Shortcuts — record/rebind keys with conflict/system-reservation validation — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-22 | Shortcuts — clear a binding — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-23 | Shortcuts — reset one command to defaults — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-24 | Shortcuts — reset all bindings with confirmation — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-25 | Notifications — enable/request native APNs permission with truthful authorization/registration state — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-26 | Notifications — per-device Needs you preference — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-27 | Notifications — per-device Finished preference — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-28 | Notifications — disable/unregister and explain denied OS permission/recovery — *SettingsView; UI* | P0 | implemented |
| [ ] | SET-29 | Agents — list installed/available CLI names, versions and detection changes — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-30 | Agents — show/hide a preset in New session — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-31 | Agents — check host CLI versions/updates and report actual results — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-32 | Agents — add suggested/custom CLI preset with name/command validation — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-33 | Agents — remove a custom preset — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-34 | Subscriptions — add provider preset (Claude/OpenAI/Gemini/Muse/Other), name, endpoint, model and secure key input — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-35 | Subscriptions — discover available models/custom-model entry and loading/error states — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-36 | Subscriptions — choose active default subscription — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-37 | Subscriptions — choose provider for an individual side chat/reviewer conversation — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-38 | Subscriptions — review briefing/re-check override or follow active subscription — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-39 | Subscriptions — edit endpoint/model/name/key while preserving masked-key semantics — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-40 | Subscriptions — delete subscription with affected-use handling — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-41 | Subscriptions — optionally expose key to host-launched sessions via named environment variable, with explicit exposure decision — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-42 | Environment — add global name/value with validation — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-43 | Environment — edit global value without replacing an untouched masked secret — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-44 | Environment — delete global variable — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-45 | Environment — secret flag/masked display and sensitive editing — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-46 | Environment — display subscription-exported variables and route to owning subscription — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-47 | Environment — identify stale running sessions and why restart is unavailable — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-48 | Environment — restart one eligible session with confirmation — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-49 | Environment — restart all eligible idle sessions with confirmation/results — *SettingsView; UI* | P1 | implemented |
| [ ] | SET-50 | Search — enable/disable indexing — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-51 | Search — index/build/source/entry/status details and errors — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-52 | Search — rebuild index with visible progress/result — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-53 | System — per-agent hook status — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-54 | System — install hooks on host — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-55 | System — remove hooks on host — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-56 | System — screen-rule audit results and missed prompt detail — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-57 | System — clear screen-rule audit — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-58 | System — restart host service with confirmation and reconnect/result handling — *SettingsView; UI* | P2 | implemented |
| [ ] | SET-59 | System — uploads disk-usage display — *the source has no uploads-usage endpoint* | P2 | substituted |
| [ ] | SET-60 | System — clear uploads with confirmation and actual result — *SettingsView; UI* | P2 | implemented |

Source mapping: Security `../ah/web/Security.tsx`; Appearance `web/Appearance.tsx`/`theme.ts`; Shortcuts `web/shortcuts.tsx`/`shortcuts.ts`; Notifications `web/NotifyDialog.tsx`/`notify.ts`; Agents `web/AgentsSettings.tsx`; Subscriptions `web/Subscriptions.tsx`/`SubscriptionPicker.tsx`; Environment `web/Environment.tsx`; Search `web/SearchSettings.tsx`; System `web/System.tsx`. All are relative to `../ah`. Device appearance, keymap, notification opt-in, layouts, surface/hide-steps/keyboard preferences, Inbox grouping and agent recents also need deliberate native preference storage; none is implemented.

### Keyboard contexts beyond the 89-command catalog

Source: [AUDIT contextual bindings](../../AUDIT.md#contextual-bindings-and-behavior-outside-the-catalog), SPEC P1 keyboard contract, `../ah/web/keyboard.ts`, `shortcuts.tsx`, `rove.ts` and feature controls. Native destination: UIKit responder/key-command routing plus feature focus models. Command inventory above remains authoritative for individual IDs.

| Done | ID | Context / acceptance scope | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | K-01 | App/terminal/field/dialog enabled scopes and foreground scene/focused pane ownership — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |
| [ ] | K-02 | Respect normal text entry/terminal input and editor caret boundaries before directional pane routing — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |
| [ ] | K-03 | Colemak/produced-character letters, physical punctuation/digits and iPadOS reserved-key conflict testing — *physical HID usages + produced characters; hardware unverified* | P1 | implemented |
| [ ] | K-04 | Command palette/switcher arrows, Enter, Right/submenu, Left/Backspace/back, typed search and open-as-pane — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |
| [ ] | K-05 | Pane submap h/j/k/l, Shift move, split/close/maximize/flip/resize/open/replace, workspaces and Escape — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |
| [ ] | K-06 | Resize-mode arrows/Escape, focus movement and divider bounds — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |
| [ ] | K-07 | Review j/k when not typing and eligible primary action via Cmd/Ctrl+Enter — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |
| [ ] | K-08 | Composer Enter/Shift+Enter, empty-Enter queue steering, empty-Escape stop, slash/path completion and first-keystroke focus — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P0 | implemented |
| [ ] | K-09 | Ask digits/arrows/Space/custom text/Ctrl+Enter submission and honest unsupported-picker terminal fallback — *AskPanelView: a waiting session's choices take the keyboard on open, on Reply and when a question arrives in an empty composer; digits, ↑/↓/Tab, Space/Return, ⌘Return, Esc back to the input* | P0 | implemented |
| [ ] | K-10 | Diff-line navigation, Enter/Space comment, Cmd/Ctrl+Enter send and Escape cancel — *`DiffCursor`: UT theDiffCursorWalksCommentableLinesAcrossFiles; ↑↓/j/k, Home/End, Return/Space, inline comment box with ⌘↵/⌃↵ and Esc; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | K-11 | Roving lists retain intended item/focus through reorder; scoped main-action dispatch respects dialogs/controls — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |
| [ ] | K-12 | Which-key modifier-hold HUD, native shortcut discoverability, key hints, rebindings and conflict feedback — *SceneModel.handle + UIKit routing; UT KeyboardTests* | P1 | implemented |

### Keyboard-first workspace

Source: the owner's [WORKSPACE-SPEC.md](../../WORKSPACE-SPEC.md) (24 October 2026), which refines SPEC's keyboard, palette and tiling contract. Native-only commands (beyond the web's 89) are listed after the table. "Model" means the behavior lives in `SceneModel`/`WorkspaceModel`/`LayoutNode`/`KeyBindings` and is tested on Linux; the UIKit/SwiftUI side is unverified until the first Apple build.

| Done | ID | Requirement (WORKSPACE-SPEC section) — *evidence* | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | KW-01 | §1 A global shortcut opens the palette from anywhere — *⌘⇧P/⌃⇧P menu key command with priority over text; UI unverified* | P1 | implemented |
| [ ] | KW-02 | §1 Nested categories walked in place: arrows move, ↵ runs or opens, → opens a category or a session's choices, ← / ⌫ go back, crumbs click back — *UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-03 | §1 Every row: icon, label, keycaps right-aligned (two-key chords as both steps) — *an SF Symbol for every command: UT everyCommandHasItsOwnIcon; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-04 | §1 Forgiving fuzzy search from any level reaches nested commands — *UT KeyboardTests (PaletteTree.search)* | P1 | implemented |
| [ ] | KW-05 | §1 Context-sensitive: only what can run in this window and pane — *UT KeyboardTests; IT hardwareKeysDriveTheWorkspace* | P1 | implemented |
| [ ] | KW-06 | §1 Recently used actions surfaced without reordering unpredictably — *Recent heads an empty palette; in search recency only breaks ties: UT recentRowsComeFirstOnlyAmongEqualMatches; IT recentPaletteRows; UI compiles, not yet seen running* | P2 | implemented |
| [ ] | KW-07 | §1 Sessions in the same search, set apart from actions (agent mark, “Session” tag, status, project, branch, host, on screen); a Go to → Sessions branch (`go-to-session`); ⌘↵ opens one as a pane — *IT hardwareKeysDriveTheWorkspace; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-08 | §1 Session destinations: switch to (or focus its pane), open as a pane, move to workspace N — *Enter runs, → opens the choices: UT, IT (sendSession, goTo)* | P1 | implemented |
| [ ] | KW-09 | §1 Compact floating surface on a solid elevated fill with a hairline and shadow, keycaps, tinted selection that follows the pointer, push/fade between levels, key hints in a footer — *seen on the iPhone and iPad simulators (10 November 2026): the elevated surface, hairline, keycaps, tinted first row and the footer's key hints; pointer and level transitions not walked* | P1 | implemented |
| [ ] | KW-10 | §2 Shortcut editor search by name, category or shortcut, typed (“ctrl shift p”, “⌃⇧P”) or pressed; changed/no-shortcut filters — *UT theEditorFindsCommandsByNameGroupOrKeys; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-11 | §2 Record a new combination straight from the keyboard, one key or two (Return keeps, Esc cancels) — *UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-12 | §2 Two-key chords where appropriate (“⌃K ⌃S”), with a legend of what can follow and a 2 s timeout — *UT twoKeyChords…, aTwoKeyChordWaits…; menu keeps them out of key equivalents* | P2 | implemented |
| [ ] | KW-13 | §2 Conflicts detected (scope-aware, including a key that starts another two-key chord) with a banner that takes the shortcut over or cancels; keys iPadOS or typing keep are refused with the reason — *UT conflictsAreFound…, keysTheSystem…; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-14 | §2 Reset one shortcut (per row), remove or change any one of several, or reset all (confirmed) — *UT addingRemovingAndResettingShortcuts; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-15 | §2 App-wide and context-only shortcuts told apart: each row says where it works (“Not while typing or in a dialog”, “only from the start of the text”…) — *UI compiles, not yet seen running* | P2 | implemented |
| [ ] | KW-16 | §2 Palette, menu bar, which-key, pane menus, the cheat sheet and the editor always show the same bindings — *one `KeyBindings`; menu rebuilt on change; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-17 | §2 Which-key overlay for held modifiers, and a legend of second keys while a two-key chord waits — *UT KeyboardTests, twoKeyChords…; UI compiles, not yet seen running* | P2 | implemented |
| [ ] | KW-18 | §3 Split the focused pane right, below, left or above, recursively — *UT TilingFocusTests, WorkspaceModelTests; IT* | P1 | implemented |
| [ ] | KW-19 | §3 Resize by dragging dividers (hover highlight) or by key — *UT LayoutTests; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-20 | §3 Move and swap panes by key, from a pane's menu, or by dragging its mark onto another pane (edge splits beside, center swaps) — *UT TilingFocusTests (dropping…), LayoutTests; IT (swap); UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-21 | §3 Close a pane; its neighbors reclaim the space — *UT WorkspaceModelTests* | P1 | implemented |
| [ ] | KW-22 | §3 Maximize and return to the arrangement; a badge says which pane of how many and restores — *UT; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-23 | §3 Workspaces 1–9 with next/previous, and a strip at the foot of the sidebar (current, in use, tap to go, send here) — *UT TilingFocusTests; IT; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-24 | §3 Balance sizes; flip a split — *UT TilingFocusTests; IT (⌃⇧=)* | P1 | implemented |
| [ ] | KW-25 | §3 Every workspace capability is in the palette — *UT everyCommandHasAPlaceInThePaletteTree* | P1 | implemented |
| [ ] | KW-26 | §3 One unmistakable active pane: a 2 pt accent border, other panes' headers dimmed, a hairline otherwise; no extra chrome — *seen with two panes on the iPad simulator (10 November 2026): the focused pane's accent border* | P1 | implemented |
| [ ] | KW-27 | §4 Directional focus follows the real spatial arrangement — *UT LayoutTests (neighbor)* | P1 | implemented |
| [ ] | KW-28 | §4 Moving focus moves the real keyboard focus; each pane remembers its composer or terminal; clicking into another pane's composer makes it the focused pane — *model: UT TilingFocusTests, IT; composer and terminal report focus; UI compiles, not yet seen running* | P0 | implemented |
| [ ] | KW-29 | §4 Hover-to-focus without flicker during drags, overlays or layout changes; a Settings switch and a palette command turn it off — *model gating: UT TilingFocusTests; `onContinuousHover`; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-30 | §4 Focus stays right through split, move, swap, close, maximize, session and workspace switches — *model: UT, IT* | P0 | implemented |
| [ ] | KW-31 | §4 Temporary interfaces give the keyboard back on dismissal (including swipe-to-dismiss); deliberate navigation focuses the destination; an empty pane's search takes the keyboard after a split — *model: UT, IT; UI compiles, not yet seen running* | P0 | implemented |
| [ ] | KW-32 | §4 Global shortcuts reachable from pane content without breaking typing — *scopes and caret edges: UT KeyboardTests* | P0 | implemented |
| [ ] | KW-33 | §5 One capability, four paths: palette, shortcut (and menu bar), a pane's context menu, and a visible control (the header's pane/split menu, the maximize badge, the workspace strip) — all call `SceneModel.perform` — *UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-34 | §6 Motion with spatial continuity: panes animate their boxes, new panes scale in, closed ones fade, maximize grows in place, palette levels push; Reduce Motion turns movement into fades — *UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-35 | §6 Clear hover (pointer highlight on rows, seams, strip), pressed, selected and disabled (menu items unavailable here are disabled) states — *UI compiles, not yet seen running* | P2 | implemented |
| [ ] | KW-36 | §6 A window too small for the layout shows the focused pane with a strip of pane tabs (others stay alive underneath) — *`LayoutNode.fits`: UT TilingFocusTests; UI compiles, not yet seen running* | P1 | implemented |
| [ ] | KW-37 | §6 Accessibility: panes say “Pane 2 of 3, focused”, palette rows are buttons with selection, keycaps read as the chord, Reduce Motion respected — *labels written; needs a device*  | P1 | implemented |
| [ ] | KW-38 | §7 Everything in the quality bar without a mouse, on an iPad with a keyboard | P0 | blocked |

Native workspace commands (DECISIONS: Keyboard-first workspace). The web's 89 stay as above; these add to them, with defaults that clash with none (UT `nativeCommandsKeepTheWebCatalogAndClashWithNothing`).

| ID | Command | Default | Pane mode |
| --- | --- | --- | --- |
| KW-C01 | `split-left` Split left | ⌃⌥⇧\\ | ⇧V |
| KW-C02 | `split-above` Split above | ⌃⌥⇧- | ⇧S |
| KW-C03 | `balance-panes` Balance panes | ⌃⇧= | = |
| KW-C04 | `swap-pane-left/right/up/down` Swap with a neighbor | — | ⌥H/J/K/L |
| KW-C05 | `focus-pane-next/prev` Next/previous pane | ⌃Tab / ⌃⇧Tab | Tab / ⇧Tab |
| KW-C06 | `workspace-next/prev` Next/previous workspace | ⌃⌥] / ⌃⌥[ | ] / [ |
| KW-C07 | `go-to-session` Go to session… | — | — |
| KW-C08 | `focus-follows-pointer` Focus follows the pointer | — | — |

### Delivery, safety and recovery edge cases

Source: SPEC product/security/review requirements, [AUDIT acceptance criteria](../../AUDIT.md#acceptance-criteria-not-merely-an-implementation-checklist), source composer/outbox/queue/draft/review/file/preview contracts. Native destinations: the corresponding feature state/repositories plus integration/UI tests.

| Done | ID | Pending behavior / failure case | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | X-01 | Distinguish typed/pasted, pending, server-accepted, delivered, queued, failed and unknown outcome; never call PTY paste a delivered instruction — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-02 | New/resumed session readiness, initial prompt exactly once, ended-in-place behavior and no missing-selection navigation bounce — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-03 | Lost/delayed mutation response, double tap, duplicate/late response, cancellation and reconnect cannot silently duplicate a send/approval — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-04 | Queue persistent ordering, send-now interruption, edit/cancel/cancel-all/reorder conflicts and server outcome reconciliation — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-05 | Approval/denial/picker/form requires current server-validated prompt; stale ask, changed choice or partial-answer state cannot approve another prompt — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-06 | Offline/loading/empty/error/limited/starting/ended/unavailable states, unread/viewed accuracy and no stale state presented as fresh — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-07 | Stop vs terminate vs close-pane vs hide-history are distinct; dangerous permissions/relaunch/destructive actions have accurate warnings/confirmation — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-08 | Multiple devices/scenes sending or editing drafts preserve ordering/ownership and reject stale overwrites without claiming success — *models + IT where noted in TEST-MATRIX* | P0 | implemented |
| [ ] | X-09 | Review base/head/diff-scope evidence survives updates; changed head immediately before merge blocks or requires fresh review/confirmation — *models + IT where noted in TEST-MATRIX* | P1 | implemented |
| [ ] | X-10 | Keep model verdict, human reviewed state and merge authorization separate; never auto-mark unseen layers reviewed; no-checks distinct from passed-checks — *models + IT where noted in TEST-MATRIX* | P1 | implemented |
| [ ] | X-11 | Treat PR text/comments/model/tool output as untrusted; reviewer sources are revision-grounded; dispatch/merge only with the required explicit user intent — *models + IT where noted in TEST-MATRIX* | P1 | implemented |
| [ ] | X-12 | Files remain within server-approved roots; path/URL traversal, upload type/size and private media errors have safe native handling — *models + IT where noted in TEST-MATRIX* | P1 | implemented |
| [ ] | X-13 | Preview cookie/auth/origin isolation, navigation policy, HMR/absolute URLs and VPN loss; never expose raw dev ports/public tunnels — *models + IT where noted in TEST-MATRIX* | P1 | implemented |
| [ ] | X-14 | Dirty branch/worktree deletion, snapshots/rollback safety snapshot, fork lineage and continue/send-to provider/session context stay accurate — *models + IT where noted in TEST-MATRIX* | P1 | implemented |

### Verification, refinement and release

Source: SPEC implementation gates, Apple standards and definition of excellence. Native destination: [TEST-MATRIX](TEST-MATRIX.md), automated tests and recorded simulator/device/manual evidence. Existing portable tests/static checks are checked in B-23/B-26; all checks below remain pending.

| Done | ID | Required proof | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | Q-01 | XcodeGen generation, GRDB resolution, UIKit/SwiftUI/Observation/GRDB compilation and Apple unit/UI tests via `./scripts/verify.sh` — *no macOS/Xcode on this machine* | P0 | blocked |
| [ ] | Q-02 | Small/large iPhone and iPad portrait/landscape, rotation, multitasking and narrow/wide Stage Manager — *needs simulators/devices* | P0 | blocked |
| [ ] | Q-03 | Physical iPad keyboard: every command/context, selection/IME/dead keys, first keystroke and focus after navigation/presentation — *needs an iPad with a keyboard* | P1 | blocked |
| [ ] | Q-04 | Pointer/trackpad, context menus, drag/drop/reordering/split targets and independent multiple windows — *needs an iPad with a trackpad* | P1 | blocked |
| [ ] | Q-05 | VoiceOver reading/actions, Dynamic Type, touch targets, contrast, Reduce Motion and semantic status labels — *needs devices* | P0 | blocked |
| [ ] | Q-06 | Native bars/materials/type/SF Symbols, sheets/detents, toolbars, safe areas, keyboard layout/dictation and haptics — *needs devices* | P1 | blocked |
| [x] | Q-07 | GRDB migration/reopen/window isolation/delete/future-version tests, then all restoration/cache migration regressions — *UT SceneStoreTests on Linux* | P0 | verified |
| [x] | Q-08 | Disposable backend/tmux/synthetic-agent integration fixtures; no production agents/user secrets as fixtures — *scripts/integration.sh: disposable ah + tmux + fake agents, 19 tests* | P0 | verified |
| [ ] | Q-09 | Disconnect/reconnect/server restart/VPN loss, suspend/wake, cancellation, late responses, memory/storage pressure and no leaked competing tasks — *IT revocation/reconnect; device suspend/wake pending* | P0 | implemented |
| [ ] | Q-10 | Real terminal ANSI/colors/Unicode/graphemes, IME/modifiers, selection/copy/paste/links/scrollback and touch input — *IT SwiftTerm on Linux; iOS input/IME pending* | P0 | implemented |
| [ ] | Q-11 | Terminal exact resize/redraw, network interruption, two independent viewers, input targeting and current tmux-address re-resolution — *IT resize/re-resolve; device pending* | P0 | implemented |
| [ ] | Q-12 | Review a multi-layer/10-PR fixture stack: grounded chat, line context, findings dispatch, revision update and re-review — *needs a disposable GitHub stack fixture* | P1 | unstarted |
| [ ] | Q-13 | Exact-head explicit merge/next, bottom-up stack handling, retarget/restack, missing/failed checks and last-moment head change — *needs a disposable GitHub stack fixture* | P1 | unstarted |
| [ ] | Q-14 | Large transcript/pagination/widget/diff/file/search workload: rendering latency, memory, cancellation and scroll/focus preservation — *needs devices* | P1 | blocked |
| [ ] | Q-15 | Cold/warm launch, fresh-state first paint, foreground catch-up, offline recovery and drafts without input jank — *needs devices* | P0 | blocked |
| [ ] | Q-16 | Repeated simulator/on-device interaction rounds; screenshots/recordings for visual/native behavior and documented fixes — *needs devices* | P1 | blocked |
| [ ] | Q-17 | App icons/assets, final privacy declarations/dependency manifests, notification privacy and signing/distribution packaging — *needs the account owner* | P2 | blocked |
| [ ] | Q-18 | Full feature/setting/adapter/widget/89-command sweep, explicit P2/P3 exceptions and current source/test evidence for every completion claim — *this sweep; Apple verification outstanding* | P1 | implemented |
| [ ] | Q-19 | Run Linux core and macOS simulator CI, and fix failures before any review-ready shipping claim — *CI runs on push; not pushed without authorization* | P0 | blocked |
| [ ] | Q-20 | Backward-compatible backend/web/CLI/security regression evidence; meaningful independent stack-layer checks; publish/push/deploy only when user instructs — *ah suite 552/552 and tsc on native/1-device-auth + native/2-apns* | P0 | implemented |

## Platform integration

How the app reaches into iOS beyond its own windows. Verified scope in each row.

| Done | ID | Integration | Where | Evidence |
| --- | --- | --- | --- | --- |
| [ ] | PL-01 | App Intents: Open Session, What Needs Me, New Session, Send Message, Show Inbox; App Shortcuts phrases (Siri, Spotlight, Action button) | [AppIntents.swift](../../Sources/Platform/AppIntents.swift), [AppShortcuts.swift](../../Sources/Models/AppShortcuts.swift) | UT ranking, matching, spoken summaries; builds for iOS; not yet run from Siri on a device |
| [ ] | PL-02 | Home Screen quick actions: New Session, Search, Inbox with a live count | [QuickActions.swift](../../Sources/Platform/QuickActions.swift), Info.plist | UT commands and titles; simulator |
| [ ] | PL-03 | Notification actions: Approve/Deny on answerable asks, Reply on a finished session | [Push.swift](../../Sources/Platform/Push.swift), AppDelegate | simulator push payloads; APNs delivery needs signing |
| [x] | PL-04 | Badge: sessions that need you, across hosts | AppDelegate | UT inbox badge; simulator |
| [ ] | PL-05 | Windows: multiple scenes, state restoration per window, titles, New Window, Open in New Window | SceneDelegate, SceneModel | UT titles, restoration IT; simulator |
| [x] | PL-06 | Handoff between devices | [Handoff.swift](../../Sources/Domain/Handoff.swift) | UT |
| [x] | PL-07 | Keyboard: UIKeyCommand menus, ⌘-hold overlay, rebinding | Keyboard | UT + IT |
| [ ] | PL-08 | Pointer: hover highlight on every custom control, focus follows pointer | Features | simulator |
| [x] | PL-09 | Drag and drop: sessions to panes and groups, files into Files and the composer | Features | UI tours |
| [x] | PL-10 | QuickLook and the share sheet for host files | PanelView | UI tour |
| [x] | PL-11 | Face ID / Secure Enclave device key; Keychain bearer | NativeAuth, Keychain | UT + IT (software key) |
| [ ] | PL-12 | Live Activities and widgets | — | Not built: a working session's state reaches a suspended app only by push, and ah has no Live Activity push yet (RISKS) |
| [ ] | PL-13 | Share extension (send text or a link into a new session) | — | Not built: an extension needs a shared keychain group, which needs signing (RISKS) |

## Host and browser exclusions

These are deliberate specification boundaries, not pending requests to clone web/host code onto iOS. F IDs remain in the audit table so the source capability is not lost. Their native replacement or retained host behavior still needs the listed evidence; absence of an excluded artifact does not make an entire product feature complete.

| Source rows / artifact | Native disposition | Pending evidence / linked work |
| --- | --- | --- |
| F-012 — host CLI/script protocol | Keep in `ah`; do not port a CLI/server/tmux host to iOS | Preserve host behavior and backend compatibility, Q-20 |
| F-043 — host CLI installation/update implementation | Host owns executable installation; native may inspect/detect or request meaningful remote actions | SET-29–SET-33; no simulated on-device CLI installs |
| F-081, F-139 — PWA window-button insets | Do not copy; use native safe areas/window chrome | T-01/T-02, Q-02/Q-06; no fake window-buttons setting |
| F-082, F-150 — Omarchy launcher/Hyprland bind | Every backend capability gets a native path (owner, 2026-10-25): the app adds/removes the host's launcher entry and copies the bind | Integration test; demo and test hosts stand in for Omarchy's installer so nothing touches the real desktop |
| F-094 — Safari viewport/visualViewport/synthetic haptic hacks | Do not copy; native keyboard/safe-area/haptic behavior | F-085, F-091, Q-06 |
| F-095 — PWA install/service worker/manifest | Do not copy; native lifecycle, app distribution and APNs replace relevant intent | B-04 is groundwork; AP-01–AP-09, Q-17 |
| F-137 master-password set/remove | Keep host-only command; native status/admin boundaries as meaningful | SET-13; no native password-management bypass |
| F-151 web rebuild/reload | Rebuild and restart is a backend action, so the app runs it (real request, the host's build output on failure); reloading the web page has no native meaning | N-04–N-05, SET-58; no fake web-build progress in native |
| F-152 entire host config editor | Keep host config/CLI authority; do not invent parity for knobs absent from the source GUI | Meaningful existing controls via SET/N; record any future scope decision |
| Web CSS/DOM/layout heuristics, IndexedDB and cached web shell | Native layout/focus/preferences and account-bound encrypted GRDB cache | R/K/Q lists; no React/PWA/WKWebView app shell |
| Web VAPID push | Preserve existing clients; implement actual APNs separately | AP-01–AP-09; Web Push is not native notification completion |
| F-126 — semantic architecture visualization | Not a shipped dedicated web feature; retain as explicit later enhancement, not a web-parity claim | Native product/design decision and evidence before implementation/completion |

No additional P0/P1 feature is waived. No remaining P2 item is silently deferred or considered complete.

## Maintaining completion

When implementing a slice, update its B/F/command/detail rows in the same change. Keep IDs stable, link actual destination files and test evidence, and split any newly discovered compound behavior before marking its parent complete. A checkbox closes only for its stated scope; `verified` must name the executed test/platform or recorded journey. Keep `implemented` where Apple/device/live-host validation has not run. If a source contract changes, reconcile [SOURCE.json](../../SOURCE.json), the audit reference and affected requirement evidence before relying on the new behavior.

Do not move pending requirements into the built inventory as interfaces or placeholder screens. Add a narrow built row for the real foundation and leave the parent delivery gate open. Preserve one canonical specification and audit at the root; this file records their implementation status, not a second specification.
