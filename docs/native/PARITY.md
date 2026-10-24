# Native completion and parity tracker

Prepared from the supplied audit and executable source catalog at `be111749eea838c0103293ced5821cb843981439`.

Last reconciled: **24 October 2026**, against the current native files and the unchanged audited source. This is the completion companion to [SPEC.md](../../SPEC.md); [AUDIT.md](../../AUDIT.md) remains the source capability inventory. Keep implementation status here and execution evidence in [TEST-MATRIX.md](TEST-MATRIX.md).

`[x]` means the narrowly named component is built; its verification column states what actually ran. `[ ]` means work or required verification remains. Statuses are `unstarted`, `implemented`, `verified`, `blocked`. An authored test, interface, DTO or configuration is not a verified product workflow. A broad capability can remain unstarted while its supporting components are checked below. Blocked items are pending, not omitted. Tables use these same statuses without checkboxes where an entire capability is tracked.

**Current outcome:** local host-address setup and protocol/persistence groundwork exist. All **19 portable Swift tests passed**. The iOS application has not been built or launched here; no authenticated request, native product journey, terminal session or APNs delivery has been verified. **All six implementation-phase exit gates remain open.** No product-completion percentage is claimed.

Inventory size: **29 checked built components**, **152 audit capability rows**, **89 command rows** and **172 detailed pending rows**. These overlap intentionally: specification/capability rows map to their component and acceptance details, so their counts must not be added into a completion percentage. The detailed rows include seven named adapters plus fallback, eleven widget types plus fallback, and 60 controls across all nine settings sections.

Use these sections together:

- [Built component inventory](#built-component-inventory): every current implementation/configuration/test artifact, with verification limits.
- [Specification crosswalk](#specification-crosswalk): each specification area, its built support and remaining delivery gate.
- [Source capability checklist](#source-capability-checklist): all 152 audit capabilities, preserving stable F IDs.
- [Keyboard command checklist](#keyboard-command-checklist): all 89 actual commands, each still pending.
- [Detailed pending work](#detailed-pending-work): transport/security, restoration, APNs, individual adapters/widgets/settings, keyboard contexts and acceptance checks.
- [Host and browser exclusions](#host-and-browser-exclusions): explicit substitutions and host-only work, with no false native completion claims.

Priorities follow SPEC when it is stronger than the audit: synced drafts/continuity and APNs are P0; scratchpad and full workspace keyboard behavior are P1. Detailed settings retain P0/P1 controls even though the specification groups the overall settings sweep under P2.

## Built component inventory

These checked items describe the code that exists, not completion of the larger requirements in the next section. `verified` below is limited to the specified portable test/static scope. Apple-dependent components remain `implemented` until their Apple checks run.

| Built | ID | Component and exact scope | Implementation evidence | Verification / remaining limit |
| --- | --- | --- | --- | --- |
| [x] | B-01 | Canonical audit/spec import, pinned backend provenance and duplicate reconciliation | [AUDIT](../../AUDIT.md), [SPEC](../../SPEC.md), [SOURCE.json](../../SOURCE.json) | verified: source revision, 385 file hashes and original/archive provenance matched; ongoing drift checks required |
| [x] | B-02 | iOS/iPadOS 26+, Swift 6 strict-concurrency application and Apple test-target recipe; GRDB 7.11.1 pin | [project.yml](../../project.yml) | implemented: YAML/paths checked; XcodeGen generation, package resolution and Apple compilation unrun |
| [x] | B-03 | Bundle/scene/orientation configuration, Debug/Release settings and optional local signing overrides | [Info.plist](../../Config/Info.plist), [Base](../../Config/Base.xcconfig), [Debug](../../Config/Debug.xcconfig), [Release](../../Config/Release.xcconfig), [signing example](../../Config/Local.xcconfig.example) | implemented: plist/static checks passed; no team, entitlement or provisioning configured |
| [x] | B-04 | UIKit app/scene lifecycle; shared scene journal and per-window coordinator | [AppDelegate](../../App/AppDelegate.swift), [SceneDelegate](../../App/SceneDelegate.swift) | implemented: source only; independent-window behavior unrun |
| [x] | B-05 | UIKit navigation controller hosting the SwiftUI setup screen | [AppCoordinator](../../App/AppCoordinator.swift) | implemented: no product routes, tab bar, sidebar or split container yet |
| [x] | B-06 | MainActor Observation setup model; per-scene loading/saving/error state | [HostSetupModel](../../Sources/Features/HostSetup/HostSetupModel.swift) | implemented: feature model not compiled by portable harness; UI/model behavior unrun |
| [x] | B-07 | Host-address form, validation feedback, local-save notice and explicit pairing-pending disclosure | [HostSetupView](../../Sources/Features/HostSetup/HostSetupView.swift) | implemented: saves metadata only; no connectivity/sign-in or visual/device verification |
| [x] | B-08 | HTTPS `.ts.net` origin validation and canonicalization; reject credentials/path/query/fragment/custom port | [HostEndpoint](../../Sources/Domain/HostEndpoint.swift), [tests](../../Tests/Core/HostEndpointTests.swift) | verified: portable normalization and 12 invalid-address cases passed; not proof of host identity/authentication |
| [x] | B-09 | Stable host + uid identity and mapping from wire sessions | [SessionIdentity](../../Sources/Domain/SessionIdentity.swift), [SessionDTO](../../Sources/Networking/HubStateDTO.swift), [tests](../../Tests/Core/HubStateReducerTests.swift) | verified: portable tmux replacement/host-scoping cases passed; native routing/deep links absent |
| [x] | B-10 | One shared GRDB DatabasePool and preserved `v1.scene-journal` migration | [AppDatabase](../../Sources/Persistence/AppDatabase.swift) | implemented: GRDB/Apple compilation and migration tests unrun |
| [x] | B-11 | Transactional scene-keyed metadata upsert/read/delete and version/origin validation | [AppDatabase](../../Sources/Persistence/AppDatabase.swift), [SceneSnapshot](../../Sources/Persistence/SceneSnapshot.swift) | implemented: version 1 stores scene ID + host origin only; reopen/future-version tests authored, unrun |
| [x] | B-12 | Scene-ID NSUserActivity payload, initial journal restore, save on host change/background, discard cleanup | [SceneDelegate](../../App/SceneDelegate.swift), [AppCoordinator](../../App/AppCoordinator.swift), [HostSetupModel](../../Sources/Features/HostSetup/HostSetupModel.swift) | implemented: termination/relaunch and scene cleanup behavior unrun; full navigation restoration absent |
| [x] | B-13 | Journal directory Data Protection and backup exclusion; payloads limited to metadata | [AppDatabase](../../Sources/Persistence/AppDatabase.swift) | implemented: device protection behavior unrun; no encryption/account-bound cache |
| [x] | B-14 | Strict API 28 read projection: hostname, hosts, windows, focus and initial Inbox session fields | [HubStateDTO](../../Sources/Networking/HubStateDTO.swift), [tests](../../Tests/Core/HubStateReducerTests.swift) | verified: synthetic portable decoding/validation passed; no HTTP or Inbox UI |
| [x] | B-15 | Typed ask kinds, questions, numbered screen options and partially answered dialogs | [AskDTO](../../Sources/Networking/HubStateDTO.swift), [tests](../../Tests/Core/HubStateReducerTests.swift) | verified: portable examples passed; no ask form, approval request or stale-prompt validation |
| [x] | B-16 | Full-state/patch reduction, whole-array replacement, omitted-vs-null focus and connection reset API | [HubStateReducer](../../Sources/Networking/HubStateReducer.swift), [tests](../../Tests/Core/HubStateReducerTests.swift) | verified: portable tests passed; no live stream/poll coordination |
| [x] | B-17 | Reject incompatible API, malformed recognized events, unknown statuses and duplicate identities; require a new baseline | [HubStateDTO](../../Sources/Networking/HubStateDTO.swift), [HubStateReducer](../../Sources/Networking/HubStateReducer.swift), [tests](../../Tests/Core/HubStateReducerTests.swift) | verified: portable failure/invalidation tests passed; account revocation handling absent |
| [x] | B-18 | Incremental SSE framing across byte/UTF-8/BOM/line-ending boundaries, comments and multiline/empty data | [ServerSentEvents](../../Sources/Networking/ServerSentEvents.swift), [tests](../../Tests/Core/ServerSentEventParserTests.swift) | verified: portable chunk-boundary cases passed; parser is not a URLSession client |
| [x] | B-19 | SSE ID/retry parsing, EOF discard, configurable line/event bounds and malformed-UTF-8 failure | [ServerSentEvents](../../Sources/Networking/ServerSentEvents.swift), [tests](../../Tests/Core/ServerSentEventParserTests.swift) | verified: portable cases passed; no retry scheduler or replay guarantee |
| [x] | B-20 | Current PTY input/resize/scroll JSON encoding with numeric bounds | [TerminalInput](../../Sources/Terminal/TerminalInput.swift), [tests](../../Tests/Core/TerminalInputTests.swift) | verified: portable wire examples/scroll bound passed; no live PTY/resize verification |
| [x] | B-21 | Replaceable terminal transport and renderer protocol declarations | [TerminalTransport](../../Sources/Terminal/TerminalTransport.swift) | implemented: interfaces only; no renderer selected, WS implementation or terminal substitute |
| [x] | B-22 | Dependency-free portable package using the same domain/network/terminal-input files as Xcode | [Package.swift](../../Package.swift) | verified: Swift 6.2 Linux core compilation passed; excludes UIKit, feature models and GRDB |
| [x] | B-23 | Four portable test files covering origins, state/identity/asks, SSE and terminal encoding | [Host tests](../../Tests/Core/HostEndpointTests.swift), [state tests](../../Tests/Core/HubStateReducerTests.swift), [SSE tests](../../Tests/Core/ServerSentEventParserTests.swift), [terminal tests](../../Tests/Core/TerminalInputTests.swift) | verified: 19 Swift Testing tests passed, including parameterized cases; execution record in TEST-MATRIX |
| [x] | B-24 | Authored GRDB reopen/isolation/delete/future-version tests and setup validation UI test | [SceneStoreTests](../../Tests/Unit/SceneStoreTests.swift), [HostSetupUITests](../../Tests/UI/HostSetupUITests.swift) | implemented: tests exist, neither has run |
| [x] | B-25 | macOS bootstrap, project/dependency generation command, simulator selection and Xcode test command | [bootstrap.sh](../../scripts/bootstrap.sh), [verify.sh](../../scripts/verify.sh) | implemented: shell syntax checked; Apple execution unrun |
| [x] | B-26 | Portable workspace/provenance verification: files, duplicate/case collisions, local links, plist and 89-command rows | [check-workspace.py](../../scripts/check-workspace.py) | verified: static/source checks passed; does not compile Swift or prove UI behavior |
| [x] | B-27 | Linux core and macOS simulator CI job definitions | [native.yml](../../.github/workflows/native.yml) | implemented: YAML parsed, both CI jobs unrun |
| [x] | B-28 | Generated/build/local-signing/secret-file ignore rules | [.gitignore](../../.gitignore) | implemented: rules authored; not a secret-scanning or release-security audit |
| [x] | B-29 | Workspace instructions, setup guide, architecture, boundaries, decisions, risks and execution matrix | [AGENTS](../../AGENTS.md), [README](../../README.md), [ARCHITECTURE](ARCHITECTURE.md), [TRANSPORT](TRANSPORT.md), [DECISIONS](DECISIONS.md), [RISKS](RISKS.md), [TEST-MATRIX](TEST-MATRIX.md) | implemented: local links/static checks passed; status must follow future source/test changes |

## Specification crosswalk

This maps the specification to the inventory and remaining checklists without duplicating the specification. Every unchecked gate is pending, including work with partial foundations. F ranges below refer to the individual rows later in this file; detailed A/R/AP/etc. IDs are in [Detailed pending work](#detailed-pending-work).

### Technology and native standards

Source: [nonnegotiable decisions](../../SPEC.md#nonnegotiable-technology-decisions) and [Apple standards](../../SPEC.md#apples-standards-are-implementation-criteria).

| Done | Requirement | Built support | Still required |
| --- | --- | --- | --- |
| [ ] | T-01 — iOS/iPadOS 26+, iPhone/iPad, Stage Manager, pointer/keyboard | B-02, B-03 | Apple build and device/size/input validation; Q-01–Q-04 |
| [ ] | T-02 — UIKit lifecycle, navigation, presentation, keyboard, scenes | B-04, B-05, B-12 | Actual product routes/tabs/sidebar/splits, sheets, responder routing and restoration; F-065–F-091, R-01–R-07, K-01–K-12 |
| [ ] | T-03 — SwiftUI feature content and specialized native views | B-05, B-07, B-21 | Every product screen, real native terminal/diff and isolated preview; F-013–F-133 |
| [ ] | T-04 — Observation/concurrency, explicit ownership and cancellation | B-06, B-10, B-16 | Shared account/host state owner, transport cancellation, scene task/lifecycle verification; A-11, N-02–N-06, Q-09 |
| [ ] | T-05 — GRDB persistence, migrations, transactional repositories | B-10, B-11, B-13, B-24 | Compile/run GRDB tests, richer metadata migrations and account-bound cache protections; R-01–R-14, Q-07 |
| [ ] | T-06 — Current Apple design/API evidence and native interaction | B-29; standard setup controls | Feature-specific decisions, all native interaction/accessibility/performance checks; Q-01–Q-06, Q-14–Q-18 |
| [ ] | T-07 — Scene restoration plus proactive versioned journal | B-11, B-12 | Screen/session/stack/layout/tab/scroll context, stale/revoked-resource reconciliation and process-death tests; R-01–R-14 |
| [ ] | T-08 — Preserve backend, CLI and working web client | B-01; no source app changes | Maintain this invariant through future auth/APNs/backend work; regression evidence A-05, Q-20 |

### Product contract

Source: [product contract](../../SPEC.md#product-contract-every-existing-meaningful-workflow). Every product delivery gate below remains open; references to built DTOs/interfaces are partial support only.

| Done | Spec requirement / priority | Built support | Full pending delivery scope |
| --- | --- | --- | --- |
| [ ] | P0-01 — Secure sign-in, pair/enroll, lock/sign out, revoke | B-07, B-08; boundary documentation | F-008; A-01–A-12; security settings SET-01–SET-15 |
| [ ] | P0-02 — Inbox/status/asks/unread/cross-host/offline | B-09, B-14–B-19 | F-003–F-005, F-009, F-020–F-021, F-051–F-052, F-059–F-060; N-01–N-06, X-01–X-06 |
| [ ] | P0-03 — Sessions, create/resume/end, models/modes/title/pin/order | B-09, B-14 | F-007, F-013–F-017, F-025–F-027, F-037–F-041; X-02, X-07 |
| [ ] | P0-04 — Rich GUI across all supported transcript adapters | B-15 is ask decoding only | F-047–F-050, F-053–F-054, F-058–F-060; AD-01–AD-08, W-01–W-12 |
| [ ] | P0-05 — Composer/send/queue/stop/files/completion/drafts/focus | B-14 queue count only | F-018–F-024, F-031–F-035, F-053, F-085; X-01–X-08, R-08–R-09 |
| [ ] | P0-06 — Fully interactive native terminal | B-20, B-21 | F-006, F-044–F-046, F-061, F-093; Q-10–Q-11; authenticated real WS/renderer |
| [ ] | P0-07 — Stable identity, deep links/Handoff/presence/reconnect/cache/restoration | B-09, B-11–B-12, B-16 | F-002, F-007, F-009–F-010, F-035, F-062–F-064; R-01–R-14, N-02–N-06 |
| [ ] | P0-08 — Real APNs/badges/preferences/stable-session routing | None | AP-01–AP-09; SET-25–SET-28; signing and backend delivery required |
| [ ] | P1-01 — Full iPad panes/workspaces/scratchpad/multiple scenes | B-04 scene ownership groundwork | F-065–F-082; R-04–R-07, Q-02–Q-04; all workspace commands |
| [ ] | P1-02 — All 89 commands, scopes/rebindings/which-key/discoverability | Command inventory only | Every command row below; F-071–F-074, F-140; K-01–K-12, SET-20–SET-24 |
| [ ] | P1-03 — Stack-aware review through exact-head user-authorized merge | None | F-106–F-125, F-129; X-09–X-11, Q-12–Q-13; F-126 remains an explicit later enhancement |
| [ ] | P1-04 — Git/files/Quick Look/History/search/chat/preview/worktrees/snapshots/fork/handoffs | None beyond identity types | F-028–F-030, F-036, F-042, F-055–F-057, F-063, F-096–F-105, F-127–F-133; N-07–N-11, X-12–X-14 |
| [ ] | P1-05 — All native widget types with safe fallback | None | F-058; individual W-01–W-12 |
| [ ] | P2-01 — All nine settings sections and meaningful controls | Setup form only; not a Settings section | F-134–F-152; individual SET-01–SET-60, plus host/browser exclusions |
| [ ] | P2-02 — Multi-host outages, complete restoration, accessibility/error/empty states | B-04, B-11–B-12, B-14–B-19 | F-009, F-060, F-064, F-075–F-076, F-090; R-01–R-14, N-06, Q-01–Q-09, Q-14–Q-18 |

### Architecture, trust and transport boundaries

Source: [native architecture/server boundaries](../../SPEC.md#native-client-architecture-and-server-boundaries).

| Done | Spec boundary | Built support | Remaining gate |
| --- | --- | --- | --- |
| [ ] | Versioned DTOs for state, feeds, queues, review and files | B-14–B-17, B-20 | N-01 and feature DTOs in N-07–N-11; typed error/delivery semantics X-01–X-04 |
| [ ] | URLSession REST, reconnecting SSE, WebSocket PTY, transfers | Parser/reducer/encoding only, B-16–B-21 | N-02–N-10, X-01–X-08; auth prerequisite A-01–A-12 |
| [ ] | Explicit native auth preserving browser/Tailscale defenses | Documented boundary only | A-01–A-12; real HTTP/WS authorization and adversarial regression tests |
| [ ] | APNs host delivery, token/revocation lifecycle and private content | None | AP-01–AP-09 |
| [ ] | Isolated authenticated WKWebView preview/HMR | None | N-10; X-12–X-13; F-101 |
| [ ] | GRDB + Data Protection + encryption/account binding/cleanup | Metadata journal B-10–B-13 only | R-10–R-14; never cache secrets/raw drafts in restoration payloads |
| [ ] | Host-global vs device/account vs per-scene state ownership | B-04, B-06, B-10 | N-02, R-04–R-09, A-11; no competing live tasks or navigation across windows |

### Implementation phases and release acceptance

Source: [required order/gates](../../SPEC.md#required-implementation-order-and-gates) and [definition of excellence](../../SPEC.md#definition-of-excellence). The local branch and documentation exist; none of these phase checkboxes can close on source scaffolding alone.

| Done | Phase | Exit evidence still required |
| --- | --- | --- |
| [ ] | G-0 — Foundations | Xcode build + GRDB migrations + secure native auth + live SSE Inbox + real WS terminal; at least one simulator/device run |
| [ ] | G-1 — iPhone end-to-end | Inbox→answer; GUI/terminal→send/queue/stop; create/resume; drafts/Handoff; deep-link/restoration; signed APNs |
| [ ] | G-2 — iPad native | Sidebar/tiling, independent windows/restoration, all 89 command handlers, trackpad, narrow/large Stage Manager and multitasking |
| [ ] | G-3 — Review, Git and files | Review→request fixes→changed revision→re-review→explicit exact-head merge/next; diff/files/preview/search/chat/worktrees/snapshots |
| [ ] | G-4 — Settings/parity sweep | Every meaningful control/feature verified; explicit P2/P3 exceptions/substitutions; backward-compatible backend security/regressions |
| [ ] | G-5 — Premium refinement | iPhone/iPad interaction rounds, screenshots/recordings, keyboard/focus, accessibility, performance, suspend/reconnect and release/signing evidence |

The combined acceptance is still pending: reopen to the correct context, show fresh trustworthy state, preserve drafts/focus across interruption and provide a usable iPad workspace plus evidence-backed review decisions. Track the concrete failure/acceptance cases in X/Q below and retain execution proof in TEST-MATRIX.

## Scaffold foundations

| ID | Area | Priority | Status | Evidence / missing gate |
| --- | --- | --- | --- | --- |
| S-01 | UIKit shell + hosted SwiftUI content + Observation | P0 | implemented | App/, Sources/Features/HostSetup; Apple build pending |
| S-02 | GRDB metadata migration and per-scene journal | P0 | implemented | Sources/Persistence; Unit/SceneStoreTests authored, not run; full route/layout restoration unstarted |
| S-03 | Strict Tailscale hub-address validation | P0 | implemented | Sources/Domain/HostEndpoint; Tests/Core/HostEndpointTests passed on Linux Swift 6.2; UI test unrun; validation is not auth |
| S-04 | Native credential/pairing contract | P0 | blocked | Browser-centric gate requires backend design; RISKS.md |
| S-05 | Terminal JSON encoding and replaceable interfaces | P0 | implemented | Sources/Terminal; Tests/Core/TerminalInputTests passed on Linux Swift 6.2; renderer/WS unstarted |
| S-06 | Native build and test evidence | P0 | blocked | Xcode/simulator unavailable on Linux; portable core compiled/tested with isolated Swift 6.2; run scripts/verify.sh on Mac |
| S-07 | API 28 Inbox state/ask DTO projection and atomic snapshot/patch reducer | P0 | implemented | Sources/Networking/HubStateDTO.swift, HubStateReducer.swift; Tests/Core/HubStateReducerTests.swift passed on Linux Swift 6.2; live auth/SSE and peer aggregation unstarted |
| S-08 | Bounded incremental SSE frame parsing | P0 | implemented | Sources/Networking/ServerSentEvents.swift; Tests/Core/ServerSentEventParserTests.swift passed on Linux Swift 6.2; not connected to URLSession |
| S-09 | Portable Swift core test target and Linux CI recipe | P0 | implemented | Package.swift, Tests/Core, .github/workflows/native.yml; 19 core tests passed locally; CI workflow unrun; does not compile UIKit/GRDB or prove native journeys |

## Source capability checklist

| ID | Capability | Priority | Native destination | Status | Source / evidence |
| --- | --- | --- | --- | --- | --- |
| F-001 | One remote control plane; Node daemon bound to loopback; persistent tmux agents | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:68](../../AUDIT.md#L68); no native journey evidence |
| F-002 | Stable uid for session across tmux window replacement, restart and resume; multi-host `host/uid` | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:69](../../AUDIT.md#L69); B-09 identity/mapping tests passed; native routes, live restart/resume and deep-link journey pending |
| F-003 | State reconciliation ~1.5s and SSE initial full snapshot plus patches; polling/recovery | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:70](../../AUDIT.md#L70); B-16–B-19 pure parser/reducer tests passed; N-03–N-05 live SSE/poll/reconnect pending |
| F-004 | States: waiting/needs you, busy/working, attention/done/new output, idle, limited/reset, ended, starting, unavailable | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:71](../../AUDIT.md#L71); B-14 decodes four wire statuses/detail/limit; native status presentation and X-06 lifecycle states pending |
| F-005 | Hook-derived ask details, process/screen fallback, current activity text, unread/viewed state | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:72](../../AUDIT.md#L72); B-14–B-15 typed read projection built/tested; live state/ask/unread UI pending |
| F-006 | Multiple devices view same tmux process independently; last writer controls tmux size | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:73](../../AUDIT.md#L73); no native journey evidence |
| F-007 | Persisted conversations, host registry, transcript identity; session remains after process death | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:74](../../AUDIT.md#L74); no native journey evidence |
| F-008 | Native-safe authentication, device revocation and network trust | P0 | Domain / Networking / Security | blocked | [AUDIT.md:75](../../AUDIT.md#L75); no native journey evidence |
| F-009 | Multi-host hub merges state, proxies peer HTTP/SSE/WebSocket under `/h/<host>` | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:76](../../AUDIT.md#L76); B-14 host-list decoding only; N-06 routing/aggregation/offline behavior pending |
| F-010 | Registered/present devices, "On Desk too", viewed status, focus/handoff | P0 | Domain / Networking / Security | unstarted | [AUDIT.md:77](../../AUDIT.md#L77); SPEC P0 continuity overrides audit P1; B-14 focus/device decoding only; R-09 presence/Handoff pending |
| F-011 | Live catalog/preset updates based on agent CLI versions; hooks and discovery | P2 | Domain / Networking / Security | unstarted | [AUDIT.md:78](../../AUDIT.md#L78); no native journey evidence |
| F-012 | CLI/script protocol (`ah list/new/attach/send/wait/read/answer/stop/...`) | P3 | Retain host CLI | unstarted | [AUDIT.md:79](../../AUDIT.md#L79); no iOS CLI port required; host compatibility evidence Q-20 remains pending |
| F-013 | List all active sessions grouped by project, host or status | P0 | Sessions / Composer | unstarted | [AUDIT.md:85](../../AUDIT.md#L85); no native journey evidence |
| F-014 | Open/select a session from lists, Inbox, History and switcher | P0 | Sessions / Composer | unstarted | [AUDIT.md:86](../../AUDIT.md#L86); no native journey evidence |
| F-015 | New session: Shell/Agent; choose installed available preset, project, machine | P0 | Sessions / Composer | unstarted | [AUDIT.md:87](../../AUDIT.md#L87); no native journey evidence |
| F-016 | New session: model, custom model id, reasoning effort, permission mode | P0 | Sessions / Composer | unstarted | [AUDIT.md:88](../../AUDIT.md#L88); no native journey evidence |
| F-017 | Optional initial prompt; sends when new session ready | P0 | Sessions / Composer | unstarted | [AUDIT.md:89](../../AUDIT.md#L89); no native journey evidence |
| F-018 | Message delivery: type now / answer if waiting / queue if busy / resume if ended | P0 | Sessions / Composer | unstarted | [AUDIT.md:90](../../AUDIT.md#L90); no native journey evidence |
| F-019 | Stop/interruption (Escape for agent, Ctrl-C shell), correctly settle state | P0 | Sessions / Composer | unstarted | [AUDIT.md:91](../../AUDIT.md#L91); no native journey evidence |
| F-020 | Answer permission prompts Approve/Deny; choices/cursor pickers | P0 | Sessions / Composer | unstarted | [AUDIT.md:92](../../AUDIT.md#L92); B-15 ask/options decoding built; answer UI, mutations and stale-prompt validation X-05 pending |
| F-021 | Multi-question elicitation forms; custom answers and submit | P0 | Sessions / Composer | unstarted | [AUDIT.md:93](../../AUDIT.md#L93); B-15 question/dialog decoding tests passed; actual forms, custom-answer and submit flow pending |
| F-022 | Persistent follow-up queue and queued-message count | P0 | Sessions / Composer | unstarted | [AUDIT.md:94](../../AUDIT.md#L94); B-14 queued-count decoding built; queue DTOs/repository/tray/UI and X-04 pending |
| F-023 | Queue: Send now (interrupts current turn), Edit, Cancel, Cancel all | P0 | Sessions / Composer | unstarted | [AUDIT.md:95](../../AUDIT.md#L95); no native journey evidence |
| F-024 | Queue drag-to-reorder | P0 | Sessions / Composer | unstarted | [AUDIT.md:96](../../AUDIT.md#L96); no native journey evidence |
| F-025 | Ended session stays visible with Resume; typing resumes and sends | P0 | Sessions / Composer | unstarted | [AUDIT.md:97](../../AUDIT.md#L97); no native journey evidence |
| F-026 | Agent-native live model/effort change, mode cycling, fallback relaunch with same conversation | P1 | Sessions / Composer | unstarted | [AUDIT.md:98](../../AUDIT.md#L98); no native journey evidence |
| F-027 | Rename session inline; pin/unpin; shared session ordering | P1 | Sessions / Composer | unstarted | [AUDIT.md:99](../../AUDIT.md#L99); no native journey evidence |
| F-028 | Fork conversation to new id + isolated git worktree, optional prompt/choices, lineage | P1 | Sessions / Composer | unstarted | [AUDIT.md:100](../../AUDIT.md#L100); no native journey evidence |
| F-029 | Continue conversation in another agent (transcript priming) | P1 | Sessions / Composer | unstarted | [AUDIT.md:101](../../AUDIT.md#L101); no native journey evidence |
| F-030 | Send to another agent/session: last reply or subscription summary | P1 | Sessions / Composer | unstarted | [AUDIT.md:102](../../AUDIT.md#L102); no native journey evidence |
| F-031 | Slash autocomplete (`/`) and project file mention (`@`) | P1 | Sessions / Composer | unstarted | [AUDIT.md:103](../../AUDIT.md#L103); no native journey evidence |
| F-032 | Attach local files, image paste/drop, upload paths into prompt | P1 | Sessions / Composer | unstarted | [AUDIT.md:104](../../AUDIT.md#L104); no native journey evidence |
| F-033 | Dictation/mic; keep composer focus and keyboard when sending | P1 | Sessions / Composer | unstarted | [AUDIT.md:105](../../AUDIT.md#L105); no native journey evidence |
| F-034 | Recent prompts (cross-device), compose/edit, shift-enter multiline, empty Enter steers queued top | P1 | Sessions / Composer | unstarted | [AUDIT.md:106](../../AUDIT.md#L106); no native journey evidence |
| F-035 | Saved unsent draft per session across devices (source device), 14d expiry | P0 | Sessions / Composer | unstarted | [AUDIT.md:107](../../AUDIT.md#L107); SPEC P0 composer/continuity overrides audit P1; R-08/X-08 pending |
| F-036 | Session/branch selector, new branch, dirty marker, PR link | P1 | Sessions / Composer | unstarted | [AUDIT.md:108](../../AUDIT.md#L108); no native journey evidence |
| F-037 | Terminate session with confirmation (record stays in History) | P1 | Sessions / Composer | unstarted | [AUDIT.md:109](../../AUDIT.md#L109); no native journey evidence |
| F-038 | Custom tmux session/name; launch args; optional continue/isolated worktree; multi-host create | P2 | Sessions / Composer | unstarted | [AUDIT.md:110](../../AUDIT.md#L110); no native journey evidence |
| F-039 | New project folder (one level within root) + optional `git init` | P2 | Sessions / Composer | unstarted | [AUDIT.md:111](../../AUDIT.md#L111); no native journey evidence |
| F-040 | "Run in project" command hierarchy | P2 | Sessions / Composer | unstarted | [AUDIT.md:112](../../AUDIT.md#L112); no native journey evidence |
| F-041 | Hide ended/saved record from History without deleting transcript | P2 | Sessions / Composer | unstarted | [AUDIT.md:113](../../AUDIT.md#L113); no native journey evidence |
| F-042 | Copy attach CLI command, direct terminal scrollback text and copy-last-reply | P2 | Sessions / Composer | unstarted | [AUDIT.md:114](../../AUDIT.md#L114); no native journey evidence |
| F-043 | Host-owned update installed agent CLIs, version detection | P3 | Sessions / Composer | unstarted | [AUDIT.md:115](../../AUDIT.md#L115); no native journey evidence |
| F-044 | Full interactive terminal with ANSI/Unicode, text selection, copy/paste, links | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:121](../../AUDIT.md#L121); B-21 declares replaceable interfaces only; renderer selection/integration and Q-10 pending |
| F-045 | Terminal attach/re-attach on network loss, live resize and immediate redraw | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:122](../../AUDIT.md#L122); B-20 wire encoding built/tested; N-08 real WS and Q-11 live resize/reconnect pending |
| F-046 | Touch terminal scrollback, on-screen key bar Ctrl/Alt/Shift, Esc/Tab/arrows/paste | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:123](../../AUDIT.md#L123); no native journey evidence |
| F-047 | GUI transcript typed feed snapshot/append/paging, switches without restarting agent | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:124](../../AUDIT.md#L124); no native journey evidence |
| F-048 | GUI user/assistant bubbles, Markdown/GFM, tables, links, fenced code/copy | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:125](../../AUDIT.md#L125); no native journey evidence |
| F-049 | GUI tool events with statuses, expandable args/results, command output, diffs, plans/checklists | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:126](../../AUDIT.md#L126); no native journey evidence |
| F-050 | Pending/waiting/finished/no-result and hidden/visible reasoning/tool steps | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:127](../../AUDIT.md#L127); no native journey evidence |
| F-051 | Inbox: needs-you cards with same AskSummary and options as session; working/idle/done groups | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:128](../../AUDIT.md#L128); no native journey evidence |
| F-052 | Status badges, session detail, unread, elapsed-time updates, usage-limit notices | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:129](../../AUDIT.md#L129); no native journey evidence |
| F-053 | GUI: optimistic outbox messages until in transcript; live working timer | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:130](../../AUDIT.md#L130); no native journey evidence |
| F-054 | GUI: message rail tick per user prompt, jump to previous turns; Browse messages | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:131](../../AUDIT.md#L131); no native journey evidence |
| F-055 | History: registered ended + discovered sessions, filter, resume, fork, hide | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:132](../../AUDIT.md#L132); no native journey evidence |
| F-056 | Switcher: live/history/content matches; fuzzy search, scoped query tokens; open at turn | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:133](../../AUDIT.md#L133); no native journey evidence |
| F-057 | Content search full-text over agent transcripts and side chats, across hosts | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:134](../../AUDIT.md#L134); no native journey evidence |
| F-058 | Generative UI widgets: card, choices, table, checklist, stats, bar-chart, progress, links, image, code, diff | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:135](../../AUDIT.md#L135); no native journey evidence |
| F-059 | Agent asking: command, permission, edit diff, multi-choice form, unsupported picker fallback to Terminal | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:136](../../AUDIT.md#L136); no native journey evidence |
| F-060 | Blank GUI and empty Inbox offer recent conversations | P1 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:137](../../AUDIT.md#L137); no native journey evidence |
| F-061 | Terminal scrollback as selectable text; selectable last screen when ended | P2 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:138](../../AUDIT.md#L138); no native journey evidence |
| F-062 | Cache newest GUI page and session list encrypted per signed-in browser, fast first paint | P2 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:139](../../AUDIT.md#L139); no native journey evidence |
| F-063 | Inline GFM specialized GitHub rendering of descriptions/review threads | P2 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:140](../../AUDIT.md#L140); no native journey evidence |
| F-064 | Cached scroll position, session recentness, keyboard focus/selection state across navigation | P0 | Inbox / Transcript / Terminal / Search | unstarted | [AUDIT.md:141](../../AUDIT.md#L141); SPEC restoration/continuity overrides audit P2; R-03/R-07 pending |
| F-065 | Split right and below; independent sessions in tiled panes | P1 | Workspace / Commands | unstarted | [AUDIT.md:149](../../AUDIT.md#L149); no native journey evidence |
| F-066 | Drag divider to resize; focused pane accent border | P1 | Workspace / Commands | unstarted | [AUDIT.md:150](../../AUDIT.md#L150); no native journey evidence |
| F-067 | In-pane chooser: new shell, new agent or existing session | P1 | Workspace / Commands | unstarted | [AUDIT.md:151](../../AUDIT.md#L151); no native journey evidence |
| F-068 | Replace focused pane from sidebar/chooser | P1 | Workspace / Commands | unstarted | [AUDIT.md:152](../../AUDIT.md#L152); no native journey evidence |
| F-069 | Close pane without terminating its process; maximize; flip split | P1 | Workspace / Commands | unstarted | [AUDIT.md:153](../../AUDIT.md#L153); no native journey evidence |
| F-070 | Workspaces 1–9; per-workspace tiles; move session to workspace | P1 | Workspace / Commands | unstarted | [AUDIT.md:154](../../AUDIT.md#L154); no native journey evidence |
| F-071 | Pane mode submap `h/j/k/l`, Shift-move, split, resize, maximize, flip, replace, close | P1 | Workspace / Commands | unstarted | [AUDIT.md:155](../../AUDIT.md#L155); no native journey evidence |
| F-072 | Resize mode and directional focus with Ctrl+Shift+arrows | P1 | Workspace / Commands | unstarted | [AUDIT.md:156](../../AUDIT.md#L156); no native journey evidence |
| F-073 | Command palette hierarchy and searchable action catalog | P1 | Workspace / Commands | unstarted | [AUDIT.md:157](../../AUDIT.md#L157); no native journey evidence |
| F-074 | Hardware keyboard on iPad, all bindings, key hints, which-key overlay | P1 | Workspace / Commands | unstarted | [AUDIT.md:158](../../AUDIT.md#L158); no native journey evidence |
| F-075 | iPad width adapts: wide sidebar, medium-width overlay, compact phone UI | P1 | Workspace / Commands | unstarted | [AUDIT.md:159](../../AUDIT.md#L159); no native journey evidence |
| F-076 | iPad long press/right-click menus, pointer hover, drag reordering, edge reveal sidebar | P1 | Workspace / Commands | unstarted | [AUDIT.md:160](../../AUDIT.md#L160); no native journey evidence |
| F-077 | Drag sidebar session onto edge of pane to split | P1 | Workspace / Commands | unstarted | [AUDIT.md:161](../../AUDIT.md#L161); SPEC P1 pointer/drag-drop workspace overrides audit P2; no native journey evidence |
| F-078 | Scratchpad floating shell from anywhere | P1 | Workspace / Commands | unstarted | [AUDIT.md:162](../../AUDIT.md#L162); SPEC P1 workspace overrides audit P2; no native journey evidence |
| F-079 | Split/open in new pane from switcher (Ctrl+Enter) | P1 | Workspace / Commands | unstarted | [AUDIT.md:163](../../AUDIT.md#L163); SPEC P1 workspace/keyboard overrides audit P2; K-04 pending |
| F-080 | FLIP pane transitions, gliding list selection, spring/reduced motion | P2 | Workspace / Commands | unstarted | [AUDIT.md:164](../../AUDIT.md#L164); no native journey evidence |
| F-081 | Stage Manager window control inset setting for standalone PWA | P2 | Native safe areas; web setting excluded | unstarted | [AUDIT.md:165](../../AUDIT.md#L165); native replacement Q-02/Q-06 pending; see exclusions |
| F-082 | Omarchy desktop launcher / Hyprland shortcut to open ah | P3 | Retain host/web launcher | unstarted | [AUDIT.md:166](../../AUDIT.md#L166); no iOS launcher port; host compatibility Q-20 pending |
| F-083 | Bottom bar Inbox / Sessions / History / Commands with counts | P0 | App / native interactions | unstarted | [AUDIT.md:172](../../AUDIT.md#L172); no native journey evidence |
| F-084 | Push/pop session navigation and interactive edge swipe back | P0 | App / native interactions | unstarted | [AUDIT.md:173](../../AUDIT.md#L173); B-05 navigation controller hosts setup only; real session routes/back/gesture verification R-01 pending |
| F-085 | Keyboard-aware composer, stable focus, safe areas; no page jump on typing | P0 | App / native interactions | unstarted | [AUDIT.md:174](../../AUDIT.md#L174); no native journey evidence |
| F-086 | Agents open in GUI by default unless device chose terminal | P0 | App / native interactions | unstarted | [AUDIT.md:175](../../AUDIT.md#L175); no native journey evidence |
| F-087 | Full-width sheet for New session/Settings, detents for reviewer, draggable dismissal | P1 | App / native interactions | unstarted | [AUDIT.md:176](../../AUDIT.md#L176); no native journey evidence |
| F-088 | Session/History press-and-hold context menu, swipe actions, distinct danger confirmations | P1 | App / native interactions | unstarted | [AUDIT.md:177](../../AUDIT.md#L177); no native journey evidence |
| F-089 | Touch-first session toolbar: GUI/Terminal, Diff, Files, Chat, Queue, Snapshots, Preview, Stack | P1 | App / native interactions | unstarted | [AUDIT.md:178](../../AUDIT.md#L178); no native journey evidence |
| F-090 | Native-style toggle switches, minimum touch targets, content size & accessibility | P1 | App / native interactions | unstarted | [AUDIT.md:179](../../AUDIT.md#L179); no native journey evidence |
| F-091 | Platform haptic for holds and swipe thresholds | P1 | App / native interactions | unstarted | [AUDIT.md:180](../../AUDIT.md#L180); no native journey evidence |
| F-092 | Large title collapse, frosted bottom/nav chrome | P2 | App / native interactions | unstarted | [AUDIT.md:181](../../AUDIT.md#L181); B-05 configures setup large title; product bar/material/scroll behavior Q-06 unverified |
| F-093 | Terminal exact-line inertial scroll, pinch font resize, sticky key modifiers | P2 | App / native interactions | unstarted | [AUDIT.md:182](../../AUDIT.md#L182); no native journey evidence |
| F-094 | iOS PWA standalone viewport shim, WebKit visualViewport polling, Safari faux haptic toggle | P3 | Native keyboard/safe areas/haptics; web hacks excluded | unstarted | [AUDIT.md:183](../../AUDIT.md#L183); native replacement F-085/F-091/Q-06 pending; see exclusions |
| F-095 | Home-screen installation and service worker mechanics | P3 | Native lifecycle/distribution/APNs; PWA artifacts excluded | unstarted | [AUDIT.md:184](../../AUDIT.md#L184); B-04 lifecycle groundwork built; native notification/release gates AP/Q-17 pending |
| F-096 | Live uncommitted diff by file with +/− and line numbers | P1 | Git / Files / Preview | unstarted | [AUDIT.md:190](../../AUDIT.md#L190); no native journey evidence |
| F-097 | Add file/line anchored feedback and send to current agent | P1 | Git / Files / Preview | unstarted | [AUDIT.md:191](../../AUDIT.md#L191); no native journey evidence |
| F-098 | Browse remote host files, roots, hidden files, directories | P1 | Git / Files / Preview | unstarted | [AUDIT.md:192](../../AUDIT.md#L192); no native journey evidence |
| F-099 | Host file preview, download, upload into directory, insert path/mention into conversation | P1 | Git / Files / Preview | unstarted | [AUDIT.md:193](../../AUDIT.md#L193); no native journey evidence |
| F-100 | Git branch search/switch/create and PR discovery | P1 | Git / Files / Preview | unstarted | [AUDIT.md:194](../../AUDIT.md#L194); no native journey evidence |
| F-101 | Per-session developer preview: discover listening ports, start/stop proxy, HMR/WS | P1 | Git / Files / Preview | unstarted | [AUDIT.md:195](../../AUDIT.md#L195); no native journey evidence |
| F-102 | Worktree create on session start, list managed trees; dirty/ahead/in use/sizes | P2 | Git / Files / Preview | unstarted | [AUDIT.md:196](../../AUDIT.md#L196); no native journey evidence |
| F-103 | Worktree safe removal/orphan detection/bulk cleanup | P2 | Git / Files / Preview | unstarted | [AUDIT.md:197](../../AUDIT.md#L197); no native journey evidence |
| F-104 | Per-turn git snapshots; enable/disable; safety snapshot before rollback | P2 | Git / Files / Preview | unstarted | [AUDIT.md:198](../../AUDIT.md#L198); no native journey evidence |
| F-105 | GitHub PR link and session-associated stack panel | P2 | Git / Files / Preview | unstarted | [AUDIT.md:199](../../AUDIT.md#L199); no native journey evidence |
| F-106 | Review landing page lists stacks in progress, recent project PRs, alerts | P1 | Review | unstarted | [AUDIT.md:207](../../AUDIT.md#L207); no native journey evidence |
| F-107 | Start a review from GitHub PR chain, manually chosen PRs, native GitHub stack | P1 | Review | unstarted | [AUDIT.md:208](../../AUDIT.md#L208); no native journey evidence |
| F-108 | Ordered stack spine showing trunk, layers, role labels, progress, checks, findings, merge status | P1 | Review | unstarted | [AUDIT.md:209](../../AUDIT.md#L209); no native journey evidence |
| F-109 | Stack cockpit: Up next, merge order, made-in and fixes-go-to agents, plan, pinned decisions | P1 | Review | unstarted | [AUDIT.md:210](../../AUDIT.md#L210); no native journey evidence |
| F-110 | Layer page: title, progress prev/next, new/re-review status banner, action | P1 | Review | unstarted | [AUDIT.md:211](../../AUDIT.md#L211); no native journey evidence |
| F-111 | Layer diff scopes: This PR, Since review (including `git range-diff`), cumulative From trunk | P1 | Review | unstarted | [AUDIT.md:212](../../AUDIT.md#L212); no native journey evidence |
| F-112 | PR description (GitHub Markdown, HTML/suggestions/images) and model-generated briefing | P1 | Review | unstarted | [AUDIT.md:213](../../AUDIT.md#L213); no native journey evidence |
| F-113 | Reviewer conversation via configured subscription, one stack thread with per-question layer scope | P1 | Review | unstarted | [AUDIT.md:214](../../AUDIT.md#L214); no native journey evidence |
| F-114 | Attach diff line/range/file or existing finding to reviewer; Ask reviewer | P1 | Review | unstarted | [AUDIT.md:215](../../AUDIT.md#L215); no native journey evidence |
| F-115 | Findings: from user, reviewer, GitHub threads/bots; blocking/should/nit; ownership and state | P1 | Review | unstarted | [AUDIT.md:216](../../AUDIT.md#L216); no native journey evidence |
| F-116 | Convert selected findings into one drafted agent instruction with stack context | P1 | Review | unstarted | [AUDIT.md:217](../../AUDIT.md#L217); no native journey evidence |
| F-117 | Agent working/fixing/no-push, re-review verdict: addressed/partial/not, unrequested changes | P1 | Review | unstarted | [AUDIT.md:218](../../AUDIT.md#L218); no native journey evidence |
| F-118 | Mark reviewed, withdraw, Accept fixes; stale patch detection, separate merge gates | P1 | Review | unstarted | [AUDIT.md:219](../../AUDIT.md#L219); no native journey evidence |
| F-119 | Merge & next exact-head SHA, retarget/restack, GitHub-native stack merge and queue | P1 | Review | unstarted | [AUDIT.md:220](../../AUDIT.md#L220); no native journey evidence |
| F-120 | Merge the stack bottom-up; method merge/squash/rebase; held/waiting/restack | P1 | Review | unstarted | [AUDIT.md:221](../../AUDIT.md#L221); no native journey evidence |
| F-121 | Ask implementation harness to carry out restack or merge; track whether it completed | P2 | Review | unstarted | [AUDIT.md:222](../../AUDIT.md#L222); no native journey evidence |
| F-122 | Import bot/human GitHub threads with code suggestions and replies; reply & resolve | P2 | Review | unstarted | [AUDIT.md:223](../../AUDIT.md#L223); no native journey evidence |
| F-123 | Add/remove/reorder/rename/skips layers; change owner, plan, merge method, sync | P2 | Review | unstarted | [AUDIT.md:224](../../AUDIT.md#L224); no native journey evidence |
| F-124 | Convert chain to GitHub native stack, follow new PRs | P2 | Review | unstarted | [AUDIT.md:225](../../AUDIT.md#L225); no native journey evidence |
| F-125 | Review Inbox cards, notifications, stack panel in sessions | P2 | Review | unstarted | [AUDIT.md:226](../../AUDIT.md#L226); no native journey evidence |
| F-126 | Semantic overview of what changes, architecture visualization, evidence-backed diagrams | P2 | Review | unstarted | [AUDIT.md:227](../../AUDIT.md#L227); no native journey evidence |
| F-127 | Session side chat independent of the coding agent, includes code/repo context | P1 | SideChat / Search | unstarted | [AUDIT.md:235](../../AUDIT.md#L235); no native journey evidence |
| F-128 | Read-only repo tools (`repo_map`, `pr_info`, `pr_diff`, `working_diff`, `read_file`, `commit_show`) | P1 | SideChat / Search | unstarted | [AUDIT.md:236](../../AUDIT.md#L236); no native journey evidence |
| F-129 | Review tools (`stack_map`, exact `layer_diff`, `read_file`, `pr_threads`, `origin`, plan, findings, commits) | P1 | SideChat / Search | unstarted | [AUDIT.md:237](../../AUDIT.md#L237); no native journey evidence |
| F-130 | Conversation-specific chat provider selection; follow-up buttons; send chat output to agent | P1 | SideChat / Search | unstarted | [AUDIT.md:238](../../AUDIT.md#L238); no native journey evidence |
| F-131 | Past side-chat conversation list/search, clear thread | P2 | SideChat / Search | unstarted | [AUDIT.md:239](../../AUDIT.md#L239); no native journey evidence |
| F-132 | Summary to send to another agent through subscription | P2 | SideChat / Search | unstarted | [AUDIT.md:240](../../AUDIT.md#L240); no native journey evidence |
| F-133 | Search index enable/rebuild; source scope/speaker/time filter | P2 | SideChat / Search | unstarted | [AUDIT.md:241](../../AUDIT.md#L241); no native journey evidence |
| F-134 | **Security:** device name; lock now; sign out; one-time device enrollment code | P0 | Settings | unstarted | [AUDIT.md:247](../../AUDIT.md#L247); no native journey evidence |
| F-135 | **Security:** passkeys list/add/remove; signed-in device list, revoke, sign out others | P0 | Settings | unstarted | [AUDIT.md:248](../../AUDIT.md#L248); no native journey evidence |
| F-136 | **Security:** machine/host bearer tokens list & revoke | P1 | Settings | unstarted | [AUDIT.md:249](../../AUDIT.md#L249); no native journey evidence |
| F-137 | **Security:** optional host-only master password status, prompt history clear, recent activity/audit log | P2 | Settings | unstarted | [AUDIT.md:250](../../AUDIT.md#L250); no native journey evidence |
| F-138 | **Appearance:** System, Dark, Light, Omarchy (host colors/font sync) | P0 | Settings | unstarted | [AUDIT.md:251](../../AUDIT.md#L251); no native journey evidence |
| F-139 | **Appearance:** Window buttons `In a window/Always/Never` | P3 | Native safe areas; web setting excluded | unstarted | [AUDIT.md:252](../../AUDIT.md#L252); native safe-area/window verification Q-02/Q-06 pending; see exclusions |
| F-140 | **Shortcuts:** searchable 89-command list, rebind/clear/reset conflicts and when-applicable | P1 | Settings | unstarted | [AUDIT.md:253](../../AUDIT.md#L253); no native journey evidence |
| F-141 | **Notifications:** enable, Needs you, Finished toggle per device | P0 | Settings | unstarted | [AUDIT.md:254](../../AUDIT.md#L254); no native journey evidence |
| F-142 | **Agents:** show/hide from New session, installed CLI names/versions, check updates | P1 | Settings | unstarted | [AUDIT.md:255](../../AUDIT.md#L255); no native journey evidence |
| F-143 | **Agents:** add arbitrary CLI command / remove custom preset | P2 | Settings | unstarted | [AUDIT.md:256](../../AUDIT.md#L256); no native journey evidence |
| F-144 | **Subscriptions:** provider presets Claude/OpenAI/Gemini/Muse/Other; name, URL, model, key | P1 | Settings | unstarted | [AUDIT.md:257](../../AUDIT.md#L257); no native journey evidence |
| F-145 | **Subscriptions:** active default, per-chat/review/briefing choice, model discovery, edit/delete | P1 | Settings | unstarted | [AUDIT.md:258](../../AUDIT.md#L258); no native journey evidence |
| F-146 | **Subscriptions:** optionally expose key to launched sessions via named env var | P1 | Settings | unstarted | [AUDIT.md:259](../../AUDIT.md#L259); no native journey evidence |
| F-147 | **Environment:** add/edit/delete global values, secret mask, stale running sessions, restart one/all idle | P1 | Settings | unstarted | [AUDIT.md:260](../../AUDIT.md#L260); no native journey evidence |
| F-148 | **Search:** enabled, index status/details, rebuild | P2 | Settings | unstarted | [AUDIT.md:261](../../AUDIT.md#L261); no native journey evidence |
| F-149 | **System:** hook status per agent, install/remove, screen-rule audit and clear | P2 | Settings | unstarted | [AUDIT.md:262](../../AUDIT.md#L262); no native journey evidence |
| F-150 | **System:** Add/remove Omarchy desktop launcher; copy Hyprland bind | P3 | Retain host/web control | unstarted | [AUDIT.md:263](../../AUDIT.md#L263); excluded from iOS Settings; host compatibility Q-20 pending |
| F-151 | **System:** Restart server, rebuild and restart, reload UI, uploads disk usage, clear uploads | P2 | Settings | unstarted | [AUDIT.md:264](../../AUDIT.md#L264); no native journey evidence |
| F-152 | Host `config.json`: `port`, host, `defaultSession`, `projectRoots`, `idleAfter`, `peers`, `files.roots`, `promptHistory`, `snapshots`, `preview.ports`, auth, presets | P3 | Settings | unstarted | [AUDIT.md:265](../../AUDIT.md#L265); no native journey evidence |

## Keyboard command checklist

Captured by executing the actual TypeScript catalog. Labels, scopes and default chords are reference data, not implemented native handlers. `to-workspace-N` is the actual source ID (the mission also calls it send-to-workspace). Editor/terminal ownership, dialogs, field boundaries and iPadOS key conflicts remain separate verification gates.

| Command ID | Group / action | Scopes | Priority | Status | Source / test evidence |
| --- | --- | --- | --- | --- | --- |
| `command-palette` | Navigate: Command palette | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `switcher` | Navigate: Search or jump | app, terminal, field, dialog | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `cycle-prev` | Navigate: Previous session | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `cycle-next` | Navigate: Next session | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `new-session` | Navigate: New session | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `new-project` | Navigate: New project | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `toggle-sidebar` | Navigate: Toggle sidebar | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `go-inbox` | Navigate: Inbox | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `go-history` | Navigate: History | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `go-review` | Navigate: Review | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `go-search` | Navigate: Search | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `worktrees` | Navigate: Worktrees | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `go-settings` | Navigate: Settings | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `focus-sidebar` | Navigate: Focus the session list | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `focus-main` | Navigate: Focus the session | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `reload-page` | Navigate: Reload page | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `show-shortcuts` | Navigate: Keyboard shortcuts | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `toggle-view` | Session: GUI or terminal | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `toggle-steps` | Session: Hide / show steps | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `toggle-panel` | Session: Toggle side panel | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `reply` | Session: Reply | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `approve` | Session: Approve | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `deny` | Session: Deny | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `interrupt` | Session: Stop the turn | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `send-now` | Session: Send next queued now | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `clear-queue` | Session: Cancel all queued | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `pick-model` | Session: Switch model | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `pick-effort` | Session: Switch reasoning effort | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `copy-last` | Session: Copy the agent's last reply | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `jump-latest` | Session: Jump to latest | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `browse-messages` | Session: Browse messages | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `switch-branch` | Session: Switch branch… | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `rename` | Session: Rename session | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `fork` | Session: Fork session… | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `send-to` | Session: Send to… | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `pin` | Session: Pin | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `panel-diff` | Session: Diff | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `panel-files` | Session: Files | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `panel-chat` | Session: Chat | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `panel-queue` | Session: Queue | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `panel-snapshots` | Session: Snapshots | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `panel-preview` | Session: Preview | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `panel-stack` | Session: Stack | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `session-menu` | Session: Session menu | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `scrollback` | Session: Scrollback as text | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `copy-attach` | Session: Copy attach command | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `toggle-keys` | Session: Show or hide on-screen keys | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `terminate` | Session: Terminate session | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `split-right` | Workspace: Split right | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `split-below` | Workspace: Split below | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `close-pane` | Workspace: Close pane | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `focus-pane-left` | Workspace: Pane left | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `focus-pane-right` | Workspace: Pane right | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `focus-pane-up` | Workspace: Pane up | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `focus-pane-down` | Workspace: Pane down | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `move-pane-left` | Workspace: Move pane left | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `move-pane-right` | Workspace: Move pane right | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `move-pane-up` | Workspace: Move pane up | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `move-pane-down` | Workspace: Move pane down | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `toggle-split` | Workspace: Flip split | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `resize-left` | Workspace: Resize: divider left | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `resize-right` | Workspace: Resize: divider right | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `resize-up` | Workspace: Resize: divider up | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `resize-down` | Workspace: Resize: divider down | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `resize-mode` | Workspace: Resize mode | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `pane-mode` | Workspace: Pane mode | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `replace-pane` | Workspace: Replace pane… | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `open-in-pane` | Workspace: Open a session as a new pane… | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `scratchpad` | Workspace: Scratchpad shell | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `maximize-pane` | Workspace: Maximize pane | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `exit-split` | Workspace: Exit split | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-1` | Workspace: Workspace 1 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-2` | Workspace: Workspace 2 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-3` | Workspace: Workspace 3 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-4` | Workspace: Workspace 4 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-5` | Workspace: Workspace 5 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-6` | Workspace: Workspace 6 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-7` | Workspace: Workspace 7 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-8` | Workspace: Workspace 8 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `workspace-9` | Workspace: Workspace 9 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-1` | Workspace: Send to workspace 1 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-2` | Workspace: Send to workspace 2 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-3` | Workspace: Send to workspace 3 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-4` | Workspace: Send to workspace 4 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-5` | Workspace: Send to workspace 5 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-6` | Workspace: Send to workspace 6 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-7` | Workspace: Send to workspace 7 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-8` | Workspace: Send to workspace 8 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |
| `to-workspace-9` | Workspace: Send to workspace 9 | app, terminal, field | P1 | unstarted | `../ah/web/shortcuts.ts`; no native test evidence |

## Detailed pending work

The following expands the broad F/specification rows so individual controls, adapters, widgets and important failure cases cannot disappear inside a single completion mark. Every item is currently unchecked. A parent F/specification row closes only when its applicable detail rows and acceptance evidence are complete. Destinations below are planned ownership areas, not existing implementations.

### Authentication and secure connection

Source: [SPEC security boundary](../../SPEC.md#native-client-architecture-and-server-boundaries), F-008 and F-134–F-137; canonical backend references are `../ah/server/gate.ts`, `server/auth.ts`, `server/main.ts`, `SECURITY.md` and their security tests. Boundary documentation exists in [TRANSPORT](TRANSPORT.md); none of the following is implemented.

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | A-01 | Define/version an explicit native HTTP/SSE/WS credential and authorization contract without bypassing browser gate rules | P0 | blocked |
| [ ] | A-02 | Prove actual Tailscale Serve host/owner identity; reject off-tailnet, wrong-owner, tagged/untrusted-device and identity-unavailable cases | P0 | unstarted |
| [ ] | A-03 | Implement authenticated user-approved enrollment/pairing, short-lived single-use challenge, expiry/replay/rate-limit protections and truthful failures | P0 | unstarted |
| [ ] | A-04 | Issue scoped revocable per-device credentials with expiry; least-privilege HTTP and terminal access; no host CLI-token reuse | P0 | unstarted |
| [ ] | A-05 | Preserve browser Host/exact-Origin/X-AH/CSRF and Serve protections; adversarial browser/native HTTP/WS regression tests | P0 | unstarted |
| [ ] | A-06 | Keychain storage/read/update/delete, access policy and protected-data/keychain-loss failure handling; no secret in preferences/logs/journal | P0 | unstarted |
| [ ] | A-07 | Native lock/sign-out/revocation invalidates state, stops HTTP/SSE/WS and clears account-bound caches/push registration | P0 | unstarted |
| [ ] | A-08 | Revalidate credentials on foreground and after expiry/401/403; fail closed without insecure fallback or mutation replay | P0 | unstarted |
| [ ] | A-09 | Verify private `.ts.net` passkey Associated Domains/webcredentials feasibility; implement AuthenticationServices flow or authenticated pairing alternative | P0 | blocked |
| [ ] | A-10 | Configure actual team/bundle ID, signing/provisioning and approved entitlement set; document device/release setup | P0 | blocked |
| [ ] | A-11 | Account/device identity and cancellation ownership shared across scenes; isolation on host/account change and late-response rejection | P0 | unstarted |
| [ ] | A-12 | Server audit records for native enrollment/auth failures/revocation/privileged actions, privacy-safe diagnostic errors and secret-leak checks | P0 | unstarted |

### Networking and typed APIs

Source: [SPEC transport/DTO boundaries](../../SPEC.md#native-client-architecture-and-server-boundaries), F-001–F-011 and feature APIs in `../ah/web/api.ts`, `web/reviewApi.ts`, `server/feed/schema.ts`. Native destination: Networking and account/host state repositories. B-14–B-20 are the completed pure-code subset only.

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | N-01 | Complete DTO/request/response/error coverage for state, history, presets/catalog, delivery/queue, feed, review, Git/files/search/chat/settings and API compatibility | P0 | unstarted |
| [ ] | N-02 | Actor-owned authenticated URLSession REST client; host/account attribution, path/query encoding, bounded responses, timeouts and cancellation | P0 | unstarted |
| [ ] | N-03 | Real authenticated SSE read loop feeding parser/reducer serially; full initial state, visibility/freshness/error publication and stream ownership | P0 | unstarted |
| [ ] | N-04 | Bounded retry/backoff, full-state reconnect, foreground resync, connection-generation checks and cancellation on suspend/disconnect/revocation | P0 | unstarted |
| [ ] | N-05 | Polling fallback and post-action refresh without stale polls/late prior-connection events overwriting newer state | P0 | unstarted |
| [ ] | N-06 | Peer `/h/<host>` HTTP/SSE/WS routing, merged stable identities, peer availability/error UI and removal of stale offline-peer state | P0 | unstarted |
| [ ] | N-07 | Typed feed snapshot/append/pagination transport, bounded incremental decoding and task cancellation on session change | P0 | unstarted |
| [ ] | N-08 | Real WebSocket PTY authorization, binary/control output handling, current-address resolution, attach/resize/input/scroll and explicit close/errors | P0 | unstarted |
| [ ] | N-09 | Authenticated uploads/streaming downloads with filenames/types/size bounds, progress, cancellation and truthful retry/failure state | P0 | unstarted |
| [ ] | N-10 | Isolated authenticated preview proxy/cookie/origin strategy, restricted WKWebView navigation, safe media URLs, HMR/absolute-URL tests | P1 | unstarted |
| [ ] | N-11 | Review/Git/files/search/chat/settings repositories and mutations; server remains authority; destructive actions have explicit intent/results | P1 | unstarted |

### Navigation, restoration, drafts and local persistence

Source: [SPEC restoration requirement](../../SPEC.md#nonnegotiable-technology-decisions), [persistence/ownership boundaries](../../SPEC.md#native-client-architecture-and-server-boundaries), F-002, F-007, F-010, F-035, F-062–F-064 and workspace rows. Native destination: UIKit coordinators, per-scene models and GRDB repositories. The v1 host-origin journal is built in B-10–B-13; all extensions below remain pending.

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | R-01 | Typed UIKit routes for Inbox/Sessions/History/Commands/Review/Search/Settings and selected session/panel; push/pop/back behavior | P0 | unstarted |
| [ ] | R-02 | Deep-link parsing/validation and routing to stable host/uid, notification target and conversation turn; no stale tmux navigation | P0 | unstarted |
| [ ] | R-03 | Versioned selected screen/tab/session/panel/stack/PR restoration metadata and proactive saves on significant navigation | P0 | unstarted |
| [ ] | R-04 | Persist workspace 1–9 pane trees, divider ratios, selected workspace, focused/maximized pane and scratchpad context per scene | P1 | unstarted |
| [ ] | R-05 | Restore independent iPad windows/scene activities and shared account truth without sharing mutable navigation | P1 | unstarted |
| [ ] | R-06 | Reconcile deleted/ended/moved sessions, unavailable hosts and changed review revisions; recover to truthful reachable routes | P0 | unstarted |
| [ ] | R-07 | Restore scroll/turn/selection/focus/surface preference safely, including rotation/window resize and UI transitions | P0 | unstarted |
| [ ] | R-08 | Synced per-session drafts with debounce, device/source identity, expiry and multi-device conflict/stale-overwrite handling | P0 | unstarted |
| [ ] | R-09 | Handoff, other-device presence and focus lifecycle; scene-safe device identity and reconnect without duplicate presence | P0 | unstarted |
| [ ] | R-10 | Design account-bound sensitive caching; Keychain/CryptoKit encryption before storing transcript pages, drafts or sensitive pending UI state | P0 | unstarted |
| [ ] | R-11 | Bounded retention, storage quotas, fast encrypted cache read, expiry and deletion on sign-out/revocation/account change | P0 | unstarted |
| [ ] | R-12 | Incremental GRDB metadata/cache migrations and failure recovery preserving history/data; future/corrupt/mismatched payload tests | P0 | unstarted |
| [ ] | R-13 | Protected-data-locked/storage-full/write-failure behavior, backup policy and cache/secret/log inspection on real devices | P0 | unstarted |
| [ ] | R-14 | Kill/relaunch/background/foreground/discard/recreate/two-scene restoration tests with revoked credentials, missing resources and conflicting drafts | P0 | unstarted |

### APNs and badges

Source: [SPEC P0 push requirement](../../SPEC.md#product-contract-every-existing-meaningful-workflow) and [push boundary](../../SPEC.md#native-client-architecture-and-server-boundaries); existing `../ah/server/push.ts`/Web Push is a reference for event audience only. Native destination: app notification coordinator plus minimal backward-compatible backend APNs support.

| Done | ID | Pending implementation / acceptance | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | AP-01 | Provision APNs app identity, signing, environment-specific entitlement and sender credentials | P0 | blocked |
| [ ] | AP-02 | Native permission/registration flow and honest denied/unsupported/error states | P0 | unstarted |
| [ ] | AP-03 | Authenticated server registration, token rotation, device/account/environment binding and invalid-token cleanup | P0 | unstarted |
| [ ] | AP-04 | Host APNs delivery for needs-you/finished audiences with per-device preferences; preserve Web Push | P0 | unstarted |
| [ ] | AP-05 | Privacy-minimized notification text/payload; no raw transcript, prompt or credential leakage | P0 | unstarted |
| [ ] | AP-06 | Stable host/uid deep-link routing from foreground/background/terminated app; revalidate before any answer/action | P0 | unstarted |
| [ ] | AP-07 | Native icon badge calculation/reconciliation/clear; distinguish read/viewed state and multiple hosts | P0 | unstarted |
| [ ] | AP-08 | Preference changes/sign-out/revocation unregister or invalidate audience and prevent stale delivery/actions | P0 | unstarted |
| [ ] | AP-09 | Signed physical-device suspended/terminated delivery, permission changes, token rotation and badge/routing verification | P0 | blocked |

### Transcript adapters

Source: SPEC P0 GUI, F-047–F-050, `../ah/server/feed/schema.ts`, `server/feed/adapters/` and `web/gui/`. Native destination: typed feed store and SwiftUI transcript renderer. Each adapter needs actual feed fixtures plus native snapshot/append/pagination/tool-state/rendering evidence; a server adapter existing does not establish native support.

| Done | ID | Adapter / acceptance scope | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | AD-01 | Claude: native feed, text/tool/ask/result behavior and pagination | P0 | unstarted |
| [ ] | AD-02 | Codex: native feed, text/tool/ask/result behavior and pagination | P0 | unstarted |
| [ ] | AD-03 | Gemini: native feed, text/tool/ask/result behavior and pagination | P0 | unstarted |
| [ ] | AD-04 | Grok: native feed, text/tool/ask/result behavior and pagination | P0 | unstarted |
| [ ] | AD-05 | Muse: native feed, startup/approval/tool/result behavior and pagination | P0 | unstarted |
| [ ] | AD-06 | Hermes: native feed, text/tool/ask/result behavior and pagination | P0 | unstarted |
| [ ] | AD-07 | opencode: native feed, text/tool/ask/result behavior and pagination | P0 | unstarted |
| [ ] | AD-08 | Unsupported/missing/reset/truncated/malformed feed: truthful unavailable state and real-terminal fallback without restarting conversation | P0 | unstarted |

Shared transcript work remains in F-047–F-050/F-053–F-054: GFM/tables/links/code/copy, rich media, expandable tool args/results, command output, diffs, plans/checklists, hidden steps, timers, turn navigation, optimistic outbox reconciliation and pending/no-result states. None has a native renderer yet.

### Native widgets

Source: SPEC P1 widget list, F-058 and `../ah/web/gui/widgets.tsx`/`docs/gui.md`. Native destination: typed SwiftUI widget components. Each row includes decoding, rendering, accessibility, bounds and safe action handling.

| Done | ID | Widget / acceptance scope | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | W-01 | `card`: heading/body/actions with safe native behavior | P1 | unstarted |
| [ ] | W-02 | `choices`: selectable values and current prompt/action validity | P1 | unstarted |
| [ ] | W-03 | `table`: readable rows/columns and overflow behavior | P1 | unstarted |
| [ ] | W-04 | `checklist`: checked/pending state and accessible labels | P1 | unstarted |
| [ ] | W-05 | `stats`: values, units and readable accessibility order | P1 | unstarted |
| [ ] | W-06 | `bar-chart`: bounded values, labels and nonvisual equivalent | P1 | unstarted |
| [ ] | W-07 | `progress`: determinate/indeterminate semantics and bounds | P1 | unstarted |
| [ ] | W-08 | `links`: URL validation and appropriate native opening | P1 | unstarted |
| [ ] | W-09 | `image`: authenticated safe media URLs, loading/failure and accessibility | P1 | unstarted |
| [ ] | W-10 | `code`: language/code rendering, horizontal reading and copy | P1 | unstarted |
| [ ] | W-11 | `diff`: safe code comparison with readable additions/deletions | P1 | unstarted |
| [ ] | W-12 | Unknown/malformed/oversized widget: safe readable fallback; never execute arbitrary content | P1 | unstarted |

### All nine settings sections

Source: SPEC settings, F-134–F-152 and the source files named in each group. Native destination: UIKit Settings routing and SwiftUI settings forms backed by the appropriate device preferences or host APIs. **No Settings section/control below is built.** The host-address setup form is B-07, not a completed Security settings screen. Auth/APNs-dependent controls stay pending until their contracts are implemented.

| Done | ID | Section / individual control | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | SET-01 | Security — rename this device for drafts/presence/Handoff | P0 | unstarted |
| [ ] | SET-02 | Security — lock now | P0 | unstarted |
| [ ] | SET-03 | Security — sign out this device | P0 | unstarted |
| [ ] | SET-04 | Security — generate/display one-time enrollment code with expiry/single-use behavior | P0 | unstarted |
| [ ] | SET-05 | Security — passkey list including origin/created/last-used metadata | P0 | unstarted |
| [ ] | SET-06 | Security — add a passkey where native association is supported, or explain supported pairing path | P0 | unstarted |
| [ ] | SET-07 | Security — remove passkey with explicit confirmation | P0 | unstarted |
| [ ] | SET-08 | Security — signed-in devices/current-device/expiry and last-seen display | P0 | unstarted |
| [ ] | SET-09 | Security — revoke another device | P0 | unstarted |
| [ ] | SET-10 | Security — sign out all other devices with confirmation | P0 | unstarted |
| [ ] | SET-11 | Security — list machine/peer bearer credentials with masked metadata | P1 | unstarted |
| [ ] | SET-12 | Security — revoke a machine/peer credential | P1 | unstarted |
| [ ] | SET-13 | Security — master-password configured status; setting/removing stays host-only | P2 | unstarted |
| [ ] | SET-14 | Security — clear server prompt history with confirmation | P2 | unstarted |
| [ ] | SET-15 | Security — recent activity/audit log with privacy-safe detail | P2 | unstarted |
| [ ] | SET-16 | Appearance — System mode | P0 | unstarted |
| [ ] | SET-17 | Appearance — Dark mode | P0 | unstarted |
| [ ] | SET-18 | Appearance — Light mode | P0 | unstarted |
| [ ] | SET-19 | Appearance — Omarchy host colors/font sync with native contrast/terminal theming | P0 | unstarted |
| [ ] | SET-20 | Shortcuts — searchable 89-command list, scopes/default/current bindings and native Help/discoverability | P1 | unstarted |
| [ ] | SET-21 | Shortcuts — record/rebind keys with conflict/system-reservation validation | P1 | unstarted |
| [ ] | SET-22 | Shortcuts — clear a binding | P1 | unstarted |
| [ ] | SET-23 | Shortcuts — reset one command to defaults | P1 | unstarted |
| [ ] | SET-24 | Shortcuts — reset all bindings with confirmation | P1 | unstarted |
| [ ] | SET-25 | Notifications — enable/request native APNs permission with truthful authorization/registration state | P0 | unstarted |
| [ ] | SET-26 | Notifications — per-device Needs you preference | P0 | unstarted |
| [ ] | SET-27 | Notifications — per-device Finished preference | P0 | unstarted |
| [ ] | SET-28 | Notifications — disable/unregister and explain denied OS permission/recovery | P0 | unstarted |
| [ ] | SET-29 | Agents — list installed/available CLI names, versions and detection changes | P1 | unstarted |
| [ ] | SET-30 | Agents — show/hide a preset in New session | P1 | unstarted |
| [ ] | SET-31 | Agents — check host CLI versions/updates and report actual results | P1 | unstarted |
| [ ] | SET-32 | Agents — add suggested/custom CLI preset with name/command validation | P2 | unstarted |
| [ ] | SET-33 | Agents — remove a custom preset | P2 | unstarted |
| [ ] | SET-34 | Subscriptions — add provider preset (Claude/OpenAI/Gemini/Muse/Other), name, endpoint, model and secure key input | P1 | unstarted |
| [ ] | SET-35 | Subscriptions — discover available models/custom-model entry and loading/error states | P1 | unstarted |
| [ ] | SET-36 | Subscriptions — choose active default subscription | P1 | unstarted |
| [ ] | SET-37 | Subscriptions — choose provider for an individual side chat/reviewer conversation | P1 | unstarted |
| [ ] | SET-38 | Subscriptions — review briefing/re-check override or follow active subscription | P1 | unstarted |
| [ ] | SET-39 | Subscriptions — edit endpoint/model/name/key while preserving masked-key semantics | P1 | unstarted |
| [ ] | SET-40 | Subscriptions — delete subscription with affected-use handling | P1 | unstarted |
| [ ] | SET-41 | Subscriptions — optionally expose key to host-launched sessions via named environment variable, with explicit exposure decision | P1 | unstarted |
| [ ] | SET-42 | Environment — add global name/value with validation | P1 | unstarted |
| [ ] | SET-43 | Environment — edit global value without replacing an untouched masked secret | P1 | unstarted |
| [ ] | SET-44 | Environment — delete global variable | P1 | unstarted |
| [ ] | SET-45 | Environment — secret flag/masked display and sensitive editing | P1 | unstarted |
| [ ] | SET-46 | Environment — display subscription-exported variables and route to owning subscription | P1 | unstarted |
| [ ] | SET-47 | Environment — identify stale running sessions and why restart is unavailable | P1 | unstarted |
| [ ] | SET-48 | Environment — restart one eligible session with confirmation | P1 | unstarted |
| [ ] | SET-49 | Environment — restart all eligible idle sessions with confirmation/results | P1 | unstarted |
| [ ] | SET-50 | Search — enable/disable indexing | P2 | unstarted |
| [ ] | SET-51 | Search — index/build/source/entry/status details and errors | P2 | unstarted |
| [ ] | SET-52 | Search — rebuild index with visible progress/result | P2 | unstarted |
| [ ] | SET-53 | System — per-agent hook status | P2 | unstarted |
| [ ] | SET-54 | System — install hooks on host | P2 | unstarted |
| [ ] | SET-55 | System — remove hooks on host | P2 | unstarted |
| [ ] | SET-56 | System — screen-rule audit results and missed prompt detail | P2 | unstarted |
| [ ] | SET-57 | System — clear screen-rule audit | P2 | unstarted |
| [ ] | SET-58 | System — restart host service with confirmation and reconnect/result handling | P2 | unstarted |
| [ ] | SET-59 | System — uploads disk-usage display | P2 | unstarted |
| [ ] | SET-60 | System — clear uploads with confirmation and actual result | P2 | unstarted |

Source mapping: Security `../ah/web/Security.tsx`; Appearance `web/Appearance.tsx`/`theme.ts`; Shortcuts `web/shortcuts.tsx`/`shortcuts.ts`; Notifications `web/NotifyDialog.tsx`/`notify.ts`; Agents `web/AgentsSettings.tsx`; Subscriptions `web/Subscriptions.tsx`/`SubscriptionPicker.tsx`; Environment `web/Environment.tsx`; Search `web/SearchSettings.tsx`; System `web/System.tsx`. All are relative to `../ah`. Device appearance, keymap, notification opt-in, layouts, surface/hide-steps/keyboard preferences, Inbox grouping and agent recents also need deliberate native preference storage; none is implemented.

### Keyboard contexts beyond the 89-command catalog

Source: [AUDIT contextual bindings](../../AUDIT.md#contextual-bindings-and-behavior-outside-the-catalog), SPEC P1 keyboard contract, `../ah/web/keyboard.ts`, `shortcuts.tsx`, `rove.ts` and feature controls. Native destination: UIKit responder/key-command routing plus feature focus models. Command inventory above remains authoritative for individual IDs.

| Done | ID | Context / acceptance scope | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | K-01 | App/terminal/field/dialog enabled scopes and foreground scene/focused pane ownership | P1 | unstarted |
| [ ] | K-02 | Respect normal text entry/terminal input and editor caret boundaries before directional pane routing | P1 | unstarted |
| [ ] | K-03 | Colemak/produced-character letters, physical punctuation/digits and iPadOS reserved-key conflict testing | P1 | unstarted |
| [ ] | K-04 | Command palette/switcher arrows, Enter, Right/submenu, Left/Backspace/back, typed search and open-as-pane | P1 | unstarted |
| [ ] | K-05 | Pane submap h/j/k/l, Shift move, split/close/maximize/flip/resize/open/replace, workspaces and Escape | P1 | unstarted |
| [ ] | K-06 | Resize-mode arrows/Escape, focus movement and divider bounds | P1 | unstarted |
| [ ] | K-07 | Review j/k when not typing and eligible primary action via Cmd/Ctrl+Enter | P1 | unstarted |
| [ ] | K-08 | Composer Enter/Shift+Enter, empty-Enter queue steering, empty-Escape stop, slash/path completion and first-keystroke focus | P0 | unstarted |
| [ ] | K-09 | Ask digits/arrows/Space/custom text/Ctrl+Enter submission and honest unsupported-picker terminal fallback | P0 | unstarted |
| [ ] | K-10 | Diff-line navigation, Enter/Space comment, Cmd/Ctrl+Enter send and Escape cancel | P1 | unstarted |
| [ ] | K-11 | Roving lists retain intended item/focus through reorder; scoped main-action dispatch respects dialogs/controls | P1 | unstarted |
| [ ] | K-12 | Which-key modifier-hold HUD, native shortcut discoverability, key hints, rebindings and conflict feedback | P1 | unstarted |

### Delivery, safety and recovery edge cases

Source: SPEC product/security/review requirements, [AUDIT acceptance criteria](../../AUDIT.md#acceptance-criteria-not-merely-an-implementation-checklist), source composer/outbox/queue/draft/review/file/preview contracts. Native destinations: the corresponding feature state/repositories plus integration/UI tests.

| Done | ID | Pending behavior / failure case | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | X-01 | Distinguish typed/pasted, pending, server-accepted, delivered, queued, failed and unknown outcome; never call PTY paste a delivered instruction | P0 | unstarted |
| [ ] | X-02 | New/resumed session readiness, initial prompt exactly once, ended-in-place behavior and no missing-selection navigation bounce | P0 | unstarted |
| [ ] | X-03 | Lost/delayed mutation response, double tap, duplicate/late response, cancellation and reconnect cannot silently duplicate a send/approval | P0 | unstarted |
| [ ] | X-04 | Queue persistent ordering, send-now interruption, edit/cancel/cancel-all/reorder conflicts and server outcome reconciliation | P0 | unstarted |
| [ ] | X-05 | Approval/denial/picker/form requires current server-validated prompt; stale ask, changed choice or partial-answer state cannot approve another prompt | P0 | unstarted |
| [ ] | X-06 | Offline/loading/empty/error/limited/starting/ended/unavailable states, unread/viewed accuracy and no stale state presented as fresh | P0 | unstarted |
| [ ] | X-07 | Stop vs terminate vs close-pane vs hide-history are distinct; dangerous permissions/relaunch/destructive actions have accurate warnings/confirmation | P0 | unstarted |
| [ ] | X-08 | Multiple devices/scenes sending or editing drafts preserve ordering/ownership and reject stale overwrites without claiming success | P0 | unstarted |
| [ ] | X-09 | Review base/head/diff-scope evidence survives updates; changed head immediately before merge blocks or requires fresh review/confirmation | P1 | unstarted |
| [ ] | X-10 | Keep model verdict, human reviewed state and merge authorization separate; never auto-mark unseen layers reviewed; no-checks distinct from passed-checks | P1 | unstarted |
| [ ] | X-11 | Treat PR text/comments/model/tool output as untrusted; reviewer sources are revision-grounded; dispatch/merge only with the required explicit user intent | P1 | unstarted |
| [ ] | X-12 | Files remain within server-approved roots; path/URL traversal, upload type/size and private media errors have safe native handling | P1 | unstarted |
| [ ] | X-13 | Preview cookie/auth/origin isolation, navigation policy, HMR/absolute URLs and VPN loss; never expose raw dev ports/public tunnels | P1 | unstarted |
| [ ] | X-14 | Dirty branch/worktree deletion, snapshots/rollback safety snapshot, fork lineage and continue/send-to provider/session context stay accurate | P1 | unstarted |

### Verification, refinement and release

Source: SPEC implementation gates, Apple standards and definition of excellence. Native destination: [TEST-MATRIX](TEST-MATRIX.md), automated tests and recorded simulator/device/manual evidence. Existing portable tests/static checks are checked in B-23/B-26; all checks below remain pending.

| Done | ID | Required proof | Priority | Status |
| --- | --- | --- | --- | --- |
| [ ] | Q-01 | XcodeGen generation, GRDB resolution, UIKit/SwiftUI/Observation/GRDB compilation and Apple unit/UI tests via `./scripts/verify.sh` | P0 | blocked |
| [ ] | Q-02 | Small/large iPhone and iPad portrait/landscape, rotation, multitasking and narrow/wide Stage Manager | P0 | unstarted |
| [ ] | Q-03 | Physical iPad keyboard: every command/context, selection/IME/dead keys, first keystroke and focus after navigation/presentation | P1 | unstarted |
| [ ] | Q-04 | Pointer/trackpad, context menus, drag/drop/reordering/split targets and independent multiple windows | P1 | unstarted |
| [ ] | Q-05 | VoiceOver reading/actions, Dynamic Type, touch targets, contrast, Reduce Motion and semantic status labels | P0 | unstarted |
| [ ] | Q-06 | Native bars/materials/type/SF Symbols, sheets/detents, toolbars, safe areas, keyboard layout/dictation and haptics | P1 | unstarted |
| [ ] | Q-07 | GRDB migration/reopen/window isolation/delete/future-version tests, then all restoration/cache migration regressions | P0 | unstarted |
| [ ] | Q-08 | Disposable backend/tmux/synthetic-agent integration fixtures; no production agents/user secrets as fixtures | P0 | unstarted |
| [ ] | Q-09 | Disconnect/reconnect/server restart/VPN loss, suspend/wake, cancellation, late responses, memory/storage pressure and no leaked competing tasks | P0 | unstarted |
| [ ] | Q-10 | Real terminal ANSI/colors/Unicode/graphemes, IME/modifiers, selection/copy/paste/links/scrollback and touch input | P0 | unstarted |
| [ ] | Q-11 | Terminal exact resize/redraw, network interruption, two independent viewers, input targeting and current tmux-address re-resolution | P0 | unstarted |
| [ ] | Q-12 | Review a multi-layer/10-PR fixture stack: grounded chat, line context, findings dispatch, revision update and re-review | P1 | unstarted |
| [ ] | Q-13 | Exact-head explicit merge/next, bottom-up stack handling, retarget/restack, missing/failed checks and last-moment head change | P1 | unstarted |
| [ ] | Q-14 | Large transcript/pagination/widget/diff/file/search workload: rendering latency, memory, cancellation and scroll/focus preservation | P1 | unstarted |
| [ ] | Q-15 | Cold/warm launch, fresh-state first paint, foreground catch-up, offline recovery and drafts without input jank | P0 | unstarted |
| [ ] | Q-16 | Repeated simulator/on-device interaction rounds; screenshots/recordings for visual/native behavior and documented fixes | P1 | unstarted |
| [ ] | Q-17 | App icons/assets, final privacy declarations/dependency manifests, notification privacy and signing/distribution packaging | P2 | unstarted |
| [ ] | Q-18 | Full feature/setting/adapter/widget/89-command sweep, explicit P2/P3 exceptions and current source/test evidence for every completion claim | P1 | unstarted |
| [ ] | Q-19 | Run Linux core and macOS simulator CI, and fix failures before any review-ready shipping claim | P0 | unstarted |
| [ ] | Q-20 | Backward-compatible backend/web/CLI/security regression evidence; meaningful independent stack-layer checks; publish/push/deploy only when user instructs | P0 | unstarted |

## Host and browser exclusions

These are deliberate specification boundaries, not pending requests to clone web/host code onto iOS. F IDs remain in the audit table so the source capability is not lost. Their native replacement or retained host behavior still needs the listed evidence; absence of an excluded artifact does not make an entire product feature complete.

| Source rows / artifact | Native disposition | Pending evidence / linked work |
| --- | --- | --- |
| F-012 — host CLI/script protocol | Keep in `ah`; do not port a CLI/server/tmux host to iOS | Preserve host behavior and backend compatibility, Q-20 |
| F-043 — host CLI installation/update implementation | Host owns executable installation; native may inspect/detect or request meaningful remote actions | SET-29–SET-33; no simulated on-device CLI installs |
| F-081, F-139 — PWA window-button insets | Do not copy; use native safe areas/window chrome | T-01/T-02, Q-02/Q-06; no fake window-buttons setting |
| F-082, F-150 — Omarchy launcher/Hyprland bind | Host/web/CLI only; no native desktop-launcher control | Retain source behavior, Q-20 |
| F-094 — Safari viewport/visualViewport/synthetic haptic hacks | Do not copy; native keyboard/safe-area/haptic behavior | F-085, F-091, Q-06 |
| F-095 — PWA install/service worker/manifest | Do not copy; native lifecycle, app distribution and APNs replace relevant intent | B-04 is groundwork; AP-01–AP-09, Q-17 |
| F-137 master-password set/remove | Keep host-only command; native status/admin boundaries as meaningful | SET-13; no native password-management bypass |
| F-151 web rebuild/reload | Keep web build/reload maintenance on host/web; native refresh/reconnect and server restart are separate real actions | N-04–N-05, SET-58; no fake web-build progress in native |
| F-152 entire host config editor | Keep host config/CLI authority; do not invent parity for knobs absent from the source GUI | Meaningful existing controls via SET/N; record any future scope decision |
| Web CSS/DOM/layout heuristics, IndexedDB and cached web shell | Native layout/focus/preferences and account-bound encrypted GRDB cache | R/K/Q lists; no React/PWA/WKWebView app shell |
| Web VAPID push | Preserve existing clients; implement actual APNs separately | AP-01–AP-09; Web Push is not native notification completion |
| F-126 — semantic architecture visualization | Not a shipped dedicated web feature; retain as explicit later enhancement, not a web-parity claim | Native product/design decision and evidence before implementation/completion |

No additional P0/P1 feature is waived. No remaining P2 item is silently deferred or considered complete.

## Maintaining completion

When implementing a slice, update its B/F/command/detail rows in the same change. Keep IDs stable, link actual destination files and test evidence, and split any newly discovered compound behavior before marking its parent complete. A checkbox closes only for its stated scope; `verified` must name the executed test/platform or recorded journey. Keep `implemented` where Apple/device/live-host validation has not run. If a source contract changes, reconcile [SOURCE.json](../../SOURCE.json), the audit reference and affected requirement evidence before relying on the new behavior.

Do not move pending requirements into the built inventory as interfaces or placeholder screens. Add a narrow built row for the real foundation and leave the parent delivery gate open. Preserve one canonical specification and audit at the root; this file records their implementation status, not a second specification.
