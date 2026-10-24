# Agent Hub Native

Native iPhone and iPad client for [Agent Hub](../ah): your agent sessions, their asks, transcripts and terminals, the iPad workspace, stack review and settings, as a UIKit + SwiftUI app.

**Stack:** iOS/iPadOS 26+, Swift 6 (complete strict concurrency), UIKit lifecycle/scenes/navigation/keyboard, SwiftUI content in `UIHostingController`, Observation, GRDB 7.11.1, SwiftTerm 1.99.1, Keychain and the Secure Enclave. The `ah` host stays the authority for sessions and agents.

Start with [AUDIT.md](AUDIT.md) and [SPEC.md](SPEC.md) (the port's source documents) and [WORKSPACE-SPEC.md](WORKSPACE-SPEC.md) (the owner's keyboard-first workspace spec), then [ARCHITECTURE](docs/native/ARCHITECTURE.md), [TRANSPORT](docs/native/TRANSPORT.md) and [DECISIONS](docs/native/DECISIONS.md). [PARITY](docs/native/PARITY.md) tracks every capability, command and setting with its evidence; [TEST-MATRIX](docs/native/TEST-MATRIX.md) records what ran; [RISKS](docs/native/RISKS.md) lists the open gates.

## Status

- The whole app is written: pairing and Face ID sign-in, Inbox, sessions (GUI transcript with tools and widgets, composer with queue/drafts/attachments, asks and forms, SwiftTerm terminal), panels (diff, files, side chat, queue, snapshots, preview, stack), History, Search, the iPad split/panes/workspaces/scratchpad, all 89 keyboard commands in the menu bar, palette and switcher, stack review through exact-head merge, all nine Settings sections, APNs with Approve/Deny actions, deep links, restoration and an encrypted transcript cache.
- Everything except the UI layer compiles and passes on Linux: **141 unit tests** and **19 integration tests against a disposable `ah`** (real tmux, fake agents).
- **The UIKit/SwiftUI layer has never been compiled** — this was built on Linux with no Xcode. The first Mac build will need fixes. No simulator, device, APNs or hardware-keyboard check has run.
- The app needs the host on `ah` branches `native/1-device-auth` and `native/2-apns` (local, not yet pushed).

## On a Mac

Xcode 26+, an iOS 26+ simulator runtime, XcodeGen 2.44+.

```bash
brew install xcodegen
./scripts/bootstrap.sh          # generate AgentHubNative.xcodeproj, resolve packages
./scripts/verify.sh             # static checks + unit and UI tests on a simulator
```

For a device, copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` with your team and bundle ID. APNs needs an auth key configured on the host (`apns` in its config: `teamId`, `keyId`, `keyFile`, `topic`).

## Anywhere with Swift 6.2

```bash
./scripts/verify.sh --static    # workspace, links, plists, provenance
swift test                      # every non-UI source, 141 tests
AH_SOURCE=../path/to/ah ./scripts/integration.sh   # against a disposable host
```

`Package.swift` compiles all of `Sources` except `Features` and `Platform` (the UIKit/SwiftUI layer) as one module, so the models, keyboard routing and persistence run in plain `swift test`.

## Shipping

Follow `../CLAUDE.md`: stacked PRs through `gh stack`, one logical layer each, never directly to `main`, and nothing pushed without the owner's go-ahead.
