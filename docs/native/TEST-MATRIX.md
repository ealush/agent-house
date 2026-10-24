# Test matrix and evidence

Environment, 24 October 2026: Arch Linux, official Swift 6.2 toolchain in `~/.cache/ah-native-swift-validation` (wrapper `swiftw`). No Xcode, iOS SDK or simulator. Requirement status lives in [PARITY.md](PARITY.md); this file records what ran.

## Commands

| Check | Invocation | Result (24 October 2026) |
| --- | --- | --- |
| Workspace, links, plists, provenance, 89-command rows | `./scripts/verify.sh --static` | PASS |
| Unit tests (all non-UI sources) | `swift test` (here: `swiftw test`) | PASS — 130 tests in 3 suites |
| Integration against a disposable `ah` | `AH_SOURCE=<ah checkout with native branches> ./scripts/integration.sh` | PASS — 18 tests in 3 suites |
| Backend suite on `native/1-device-auth` + `native/2-apns` | `npm test`, `npx tsc --noEmit` in `ah` | PASS — 552/552, typecheck clean |
| UI layer syntax | `swiftc -frontend -parse` on `Sources/Features`, `Sources/Platform`, `App`, `Tests/UI` | PASS (syntax only; not type-checked) |
| Xcode build, unit + UI tests on a simulator | `./scripts/verify.sh` on macOS | **Not run** — no Mac |
| Device journeys, APNs delivery, hardware keyboard | Signed iPhone/iPad | **Not run** — needs signing and devices |

`scripts/integration.sh` starts `ah` from `AH_SOURCE` through its own test helper (isolated home, port and tmux socket), with fake agents named `ahit-agent`, `ahit-claude` and `ahit-picker`, runs the suites serially (see the `ah` window-creation race in RISKS) and tears everything down. `AH_IT_LOG` keeps the host log.

## What the integration suites prove (real host, real tmux)

| Area | Tests |
| --- | --- |
| Enrollment and sign-in with a device key; a foreign signature is refused | `enrollsWithAHostCodeAndSignsInAgainWithTheDeviceKey`, `aSignatureFromAnotherKeyIsRefused` |
| Revocation ends streams and terminals (4401) | `revocationSignsTheDeviceOutAndClosesItsStreamsAndTerminals` |
| Lock and Face ID-style sign-in again | `lockEndsTheSignInAndFaceIDSignsBackIn` |
| Live state: snapshot then patches; one stream per host | `liveStateArrivesAsSnapshotThenPatches`, `enrollingStartsOneLiveStreamAndMergesSessions` |
| Send, queue while busy, steer, stop; refused sends return | `sendDeliversQueuesWhileBusyAndSteersOrStops`, `composerSendsOptimisticallyAndTheQueueSteers`, `aRefusedSendComesBackIntoTheBox` |
| Approving only the prompt that's showing | `approvesAPermissionPromptOnlyWhileItIsShowing` |
| Typed transcript with tool calls and widgets | `guiFeedCarriesTypedTranscriptToolCallsAndWidgets` |
| Real tmux output through SwiftTerm, input, Unicode | `terminalRendersRealTmuxOutputThroughSwiftTermAndAcceptsInput` |
| Drafts across devices, never overwriting typing | `draftsFollowTheSessionAcrossDevicesAndClearWhenEmpty`, `draftsFillAnUntouchedBoxButNeverOverwriteTyping` |
| Uploads land owner-only and come back as attachments | `uploadsLandOwnerOnlyAndComeBackAsAttachments` |
| Sealed transcript page and session list: written while live, ciphertext at rest, paint a later window or a cold start, erased on forget | `theNewestTranscriptPageIsSealedAndPaintsBeforeTheStream` |
| Hardware key routing drives the workspace; the keyboard follows pane focus, swap, balance, ⌃Tab and workspace stepping, and returns after the palette; Go to session focuses an on-screen pane, is remembered in Recent, and moves a session to another workspace | `hardwareKeysDriveTheWorkspace` |
| A relaunched window reopens where it was and reconciles with the host | `aRelaunchedWindowReopensWhereItWasAndReconciles` |

## Still to run (in order)

1. On a Mac: `brew install xcodegen && ./scripts/verify.sh` — expect compile fixes in the UI layer, which has never been type-checked.
2. Simulator: pairing UI test, then setup → Inbox → session → terminal against a host running the native branches (Debug simulator builds may use a loopback host).
3. Signed device: Secure Enclave enrollment and Face ID sign-in, APNs delivery/actions/badge, background and relaunch.
4. iPad with keyboard and trackpad: all 89 commands plus the 13 native ones, pane mode, which-key and two-key chords, Stage Manager sizes (including the one-pane-at-a-time fallback), two windows. Walk WORKSPACE-SPEC §7 without the mouse, then check hover focus, pane and divider drags, pane menus and that the keyboard returns after every sheet.
5. A disposable GitHub stack: review → request fixes → re-review → exact-head merge.
6. Accessibility pass (VoiceOver, Dynamic Type, Reduce Motion) and performance on large transcripts.

Use disposable hosts, tmux sockets and fake agents; never production agents or real secrets as fixtures.
