# Test matrix and evidence

Environments: Arch Linux with the official Swift 6.2 toolchain in `~/.cache/ah-native-swift-validation` (wrapper `swiftw`), 24 October 2026; macOS 27.0.1 with Xcode 27.1 and an iPhone 18 Pro simulator (iOS 27.0), 25 October 2026. Requirement status lives in [PARITY.md](PARITY.md); this file records what ran.

## Commands

| Check | Invocation | Result (24 October 2026) |
| --- | --- | --- |
| Workspace, links, plists, provenance, 89-command rows | `./scripts/verify.sh --static` | PASS |
| Unit tests (all non-UI sources) | `swift test` (here: `swiftw test`) | PASS — 141 tests in 3 suites |
| Integration against a disposable `ah` | `AH_SOURCE=<ah checkout with native branches> ./scripts/integration.sh` | PASS — 33 tests in 5 suites (26 October 2026) |
| Every backend route has a native path (or a stated reason) | `AH_SOURCE=<ah> node scripts/backend-coverage.mjs` (also the first step of `integration.sh`); map in [BACKEND-COVERAGE.md](BACKEND-COVERAGE.md) | PASS (25 October 2026) — 169 of 169 routes |
| Backend suite on `native/1-device-auth` + `native/2-apns` | `npm test`, `npx tsc --noEmit` in `ah` | PASS — 552/552, typecheck clean |
| Xcode build, unit + UI tests on a simulator | `./scripts/verify.sh` on macOS (by hand; CI blocked by Actions billing) | PASS (25 October 2026) — app and tests build; 122 unit tests, 2 UI tests (setup screen). Every stack layer passes on its own. |
| Mac app (Mac Catalyst) | built by `./scripts/verify.sh`; run with `open --env AH_EPHEMERAL=1 --env 'AH_DEBUG_PAIR=<origin>|<code>' --env AH_SNAPSHOT_DIR=<dir> AgentHubNative.app` | Builds; runs, pairs with the demo host and shows the Inbox and a session (25 October 2026). No UI tests on the Mac without a signing team. |
| Setup → Inbox → session → terminal on a simulator against a real host (G-0) | Manual | **Not run** |
| Device journeys, APNs delivery, hardware keyboard | Signed iPhone/iPad | **Not run** — needs signing and devices |

`scripts/integration.sh` starts `ah` from `AH_SOURCE` through its own test helper (isolated home, port and tmux socket), with fake agents named `ahit-agent`, `ahit-claude`, `ahit-picker`, `ahit-question` (ah's question-dialog fixture) and `ahit-demo` (the demo's scripted Claude), runs the suites serially (see the `ah` window-creation race in RISKS) and tears everything down. `AH_IT_LOG` keeps the host log.

## What the integration suites prove (real host, real tmux)

| Area | Tests |
| --- | --- |
| Enrollment and sign-in with a device key; a foreign signature is refused | `enrollsWithAHostCodeAndSignsInAgainWithTheDeviceKey`, `aSignatureFromAnotherKeyIsRefused` |
| Revocation ends streams and terminals (4401) | `revocationSignsTheDeviceOutAndClosesItsStreamsAndTerminals` |
| Lock and Face ID-style sign-in again | `lockEndsTheSignInAndFaceIDSignsBackIn` |
| Live state: snapshot then patches; one stream per host | `liveStateArrivesAsSnapshotThenPatches`, `enrollingStartsOneLiveStreamAndMergesSessions` |
| Send, queue while busy, steer, stop; refused sends return | `sendDeliversQueuesWhileBusyAndSteersOrStops`, `composerSendsOptimisticallyAndTheQueueSteers`, `aRefusedSendComesBackIntoTheBox` |
| Approving only the prompt that's showing | `approvesAPermissionPromptOnlyWhileItIsShowing` |
| Claude's question dialog: one question at a time off the screen, then its review listing the answers and Submit; the hook's whole set in one go (exact keys typed); a folder-trust cursor list; a plan up for approval drawn as the plan, then approved | `aQuestionDialogIsAnsweredOneQuestionAtATimeThenReviewed`, `theHooksWholeSetIsAnsweredInOneGo`, `aFolderTrustListIsAnsweredByMovingItsCursor`, `aPlanUpForApprovalShowsThePlanAndTakesTheChoice` |
| Typed transcript with tool calls and widgets | `guiFeedCarriesTypedTranscriptToolCallsAndWidgets` |
| A long session's transcript (a snapshot of megabytes in one line) loads | `aLongSessionsTranscriptStillLoads` |
| Real tmux output through SwiftTerm, input, Unicode | `terminalRendersRealTmuxOutputThroughSwiftTermAndAcceptsInput` |
| Drafts across devices, never overwriting typing | `draftsFollowTheSessionAcrossDevicesAndClearWhenEmpty`, `draftsFillAnUntouchedBoxButNeverOverwriteTyping` |
| Uploads land owner-only and come back as attachments | `uploadsLandOwnerOnlyAndComeBackAsAttachments` |
| Sealed transcript page and session list: written while live, ciphertext at rest, paint a later window or a cold start, erased on forget; a search hit opens its session on the GUI at that turn | `theNewestTranscriptPageIsSealedAndPaintsBeforeTheStream` |
| A new session goes into the tmux session you name | `aNewSessionGoesIntoTheTmuxSessionYouName` |
| Hardware key routing drives the workspace; the keyboard follows pane focus, swap, balance, ⌃Tab and workspace stepping, and returns after the palette; Go to session focuses an on-screen pane, is remembered in Recent, and moves a session to another workspace | `hardwareKeysDriveTheWorkspace` |
| A relaunched window reopens where it was and reconciles with the host; it offers Handoff, and another window continues there | `aRelaunchedWindowReopensWhereItWasAndReconciles` |
| Files: browse a project, read a file, make a folder, upload into it, go up, show hidden files | `filesBrowseReadMakeFoldersAndUpload` |
| Git panel: changes and untracked files parse into the drawn diff; switch to a new branch and back; the row follows the branch | `theGitPanelReadsChangesAndSwitchesBranches` |
| Snapshots: one per turn with its prompt, restore puts files back, Undo restores the safety snapshot, off and on per session | `snapshotsCaptureEachTurnAndARestoreCanBeUndone` |
| Fork: its own branch in its own worktree, the parent untouched, lineage on both rows, listed in Worktrees | `aForkStartsOnItsOwnBranchInItsOwnWorktree` |
| Composer controls: launch with a model and effort; effort switches live; too soon after a send the app says to wait; a permission mode and then a model relaunch the conversation, carrying the other settings | `modelEffortAndPermissionChangesReachTheAgent` |
| New Session: the folder hint (folder, new, file), a new folder made a git repository, a session in its own worktree grouped with its project, recent projects | `aNewSessionMakesItsFolderOrItsOwnWorktree` |
| Session management: rename, pin to the top of its project, drag order, end into History | `sessionsRenamePinReorderEndAndComeBack` |

## Seeing it run: the demo host and UI tours

`scripts/demo/host.mjs` starts a disposable `ah` like the integration host does: its own home, state and tmux server, loopback only. It seeds something to look at:
- **Two git projects** (`orbit-web`, `orbit-api`), with branches, a worktree session and uncommitted changes.
- **A dev server** for Preview.
- **Sessions in every state:** waiting on you, idle with a full conversation (`scripts/demo/agent.mjs` writes a Claude Code-shaped transcript with thinking, reads, real edits, a test run, a plan and widgets), a plain shell, and an ended session in History.

No model, network or secret is involved.

```sh
AH_SOURCE=../ah node scripts/demo/host.mjs --dir /tmp/ah-demo   # prints {port, localToken, dir}
node scripts/demo/code.mjs /tmp/ah-demo                          # a setup code, like `ah auth code`
```

The simulator reaches a host on the Mac's own loopback (debug builds allow loopback there only). If the host runs on another machine, `ssh -R 127.0.0.1:47681:127.0.0.1:<port> <mac>` puts it at `http://127.0.0.1:47681` on the Mac.

`scripts/demo/tour.sh <simulator id> '<steps>' [origin] [setup code]` runs `TourUITests`. It pairs on first run, follows steps such as `shot:inbox;tap:Welcome flow;key:k+cmd;shot:palette`, and saves a screenshot and an accessibility tree per step in `tour-out/`. Tours build with ad-hoc simulator signing, because the Keychain refuses an app with no entitlements (`CODE_SIGNING_ALLOWED=NO`, which `verify.sh` uses).

### Simulator polish walk, 10 November 2026

macOS 27, Xcode 27, the demo host (`scripts/demo/host.mjs`) on an iPhone 18 Pro and an iPad Pro 13 simulator (iOS 27), driven by `TourUITests`, screenshots read after every change. Light and dark, Dynamic Type at accessibility-large, the software keyboard and a hardware one. Each fix was built for the simulator and passed `swift test` before it was pushed.

- On macOS the demo host needed three things: the demo home's shell profiles put the scripted `claude` ahead of Homebrew's (macOS's `path_helper` reorders the PATH in login shells), its folders opened at their real path (`/private/tmp`), and `ah` itself needed a `ps` fallback where it reads `/proc` to tell what runs in a pane (now on `ah` main, 9f016f9). Without that last one every session looked like a plain shell, with no GUI.
- `./scripts/integration.sh` against that `ah`: 35 of 36 pass. `aVideoAttachesFromDiskWellPastTheOldLimitAndLeavesNoFile` times out waiting for the upload, at the pre-campaign commit too (47c69e1): it sends 51 MB, and the host's `/api/upload` still caps a body at 50 MB (see RISKS). `aPlanUpForApprovalShowsThePlanAndTakesTheChoice` failed once with a host 500 and passed on the re-run; `guiFeedCarriesTypedTranscriptToolCallsAndWidgets` timed out once on the old commit.
- At the walk's last commit: `swift test` 211 tests pass; `xcodebuild test` on an iPhone 18 Pro simulator TEST SUCCEEDED (175 unit tests, the 2 UI tests; the tour skips without a host); the Mac Catalyst build succeeds; `./scripts/integration.sh` 35 of 36 (the 51 MB video, below). `check-workspace.py` fails only on untracked `DerivedData-device/` and `DerivedData-mac/` folders in the working tree, not on anything committed. The Mac app (Mac Catalyst) builds after every change and ran against the demo host: one window, the overlay inside it.
- The terminal's on-screen key bar was seen with Settings → Appearance → On-screen keys set to Always (the simulator reports a hardware keyboard, so by default it stays hidden): its keys scroll, fade under the hide key, and each is a 36-point cap.
- Not covered by the walk: signed devices, APNs, Face ID, and ⌘, (iPadOS keeps it; see RISKS).

### Composer walk, 10 November 2026

Twenty passes on the session composer alone, same simulators and demo host, a screenshot (and, for motion, a screen recording read frame by frame) after every change. Tours now take `AH_TOUCH_ONLY=1` (debug builds see no hardware keyboard, as a phone in the hand) and a `flickat` step: `dragat` holds before it moves, which a text view reads as a press.

- The box is one glass field beside a glass +; Send sits in its corner and folds while there's nothing to send; Queue, Run and Stop take its place. The model, effort and permission chips (and / and @ on touch) wait folded: a swipe up on the box, or its grabber, brings them out; a swipe down, a send, a scroll through the transcript or leaving the session folds them. A dangerous permission mode stays out, in red.
- Seen: light and dark; Dynamic Type at accessibility-large (the round controls grow with the text); iPad landscape; eight lines then scrolling with faded edges, and back to one line when emptied; attachments; the queue; slash and file suggestions; the question panel; a ↓ back to the newest message, pink when the agent wrote meanwhile; a draft continued from the iPhone on the iPad.
- Model and effort switched live from their menus on the demo host. Skip permissions could only be seen by forcing the condition in a throwaway build: the demo's scripted agent doesn't change modes.
- At the walk's last commit: `swift test` 212 tests pass; `xcodebuild test` on an iPhone 18 Pro simulator TEST SUCCEEDED (178 passed, the tour skipped without a host); the Mac Catalyst build succeeds. The Mac app wasn't walked: there the tray opens from its grabber.
- Not seen: a pointer's hover highlights (no pointer in the simulator), haptics, and a real device's flick.

## Still to run (in order)

1. On a Mac: `brew install xcodegen && ./scripts/verify.sh` — expect compile fixes in the UI layer, which has never been type-checked.
2. Simulator: pairing UI test, then setup → Inbox → session → terminal against a host running the native branches (Debug simulator builds may use a loopback host).
3. Signed devices: Secure Enclave enrollment and Face ID sign-in, APNs delivery/actions/badge, background and relaunch, and Handoff between an iPhone and an iPad (and to a Mac's browser).
4. iPad with keyboard and trackpad: all 89 commands plus the 13 native ones, pane mode, which-key and two-key chords, Stage Manager sizes (including the one-pane-at-a-time fallback), two windows. Walk WORKSPACE-SPEC §7 without the mouse, then check hover focus, pane and divider drags, pane menus and that the keyboard returns after every sheet.
5. A disposable GitHub stack: review → request fixes → re-review → exact-head merge.
6. Accessibility pass (VoiceOver, Dynamic Type, Reduce Motion) and performance on large transcripts.

Use disposable hosts, tmux sockets and fake agents; never production agents or real secrets as fixtures.
