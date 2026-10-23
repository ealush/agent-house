# Agent Hub Native

Native iPhone and iPad client workspace for [`../ah`](../ah), prepared from the port kit on 23 October 2026.

The selected stack is **iOS/iPadOS 26+, Swift 6, UIKit navigation, SwiftUI content, Observation, Swift concurrency, and GRDB.swift**. The Linux Node/tmux/Prisma service remains the authority for sessions and agent operations.

Start with [AUDIT.md](AUDIT.md) and [SPEC.md](SPEC.md). These are the only imported port documents; the ZIP and its duplicate document tree were deliberately omitted. [SOURCE.json](SOURCE.json) records their provenance and the source revision/file hashes.

The full [completion and pending-work checklist](docs/native/PARITY.md) pairs with the specification: every built component has a checked row with implementation/test evidence, and every product phase, audit capability, command, setting, adapter, widget and acceptance gate has explicit remaining status. Use it as the live progress record; an implemented foundation does not close a product journey.

## What is prepared

- UIKit application/scene delegates, a navigation coordinator and a hosted SwiftUI host-address form.
- Observation model, strict HTTPS Tailscale-origin validation and stable host/uid identity.
- Actor-owned GRDB `DatabasePool`, a first migration and versioned per-scene metadata restoration.
- Terminal input/resize/scroll encoding and replaceable transport/renderer interfaces.
- API 28 Inbox state/ask DTOs, an atomic snapshot/patch reducer and a bounded incremental SSE parser, with a portable Swift test harness.
- XcodeGen project specification, signing overrides, simulator validation scripts, unit/UI test targets and a macOS CI workflow.
- Architecture, decisions, risks, test matrix, and a source-linked parity tracker including all 89 keyboard commands.

This is a scaffold. The form saves an address locally; it makes no network request. Authentication/pairing, Inbox, terminal rendering, other product views, and APNs await implementation. The native authentication contract must be established before authenticated features are connected.

## On a Mac

Install Xcode 26 or newer with an iOS 26+ simulator runtime and XcodeGen 2.44 or newer. Select the full Xcode installation with `xcode-select` if needed.

```bash
brew install xcodegen
./scripts/bootstrap.sh
open AgentHubNative.xcodeproj
./scripts/verify.sh
```

`project.yml` is the project source of truth. The generated `.xcodeproj` is ignored; regenerate it after changing targets or dependencies. GRDB is pinned to **7.11.1**, including its packaged privacy manifest. There are no CocoaPods, JavaScript packages, or embedded web shell.

`verify.sh` runs the static workspace check, regenerates the project, chooses an available iOS 26+ iPhone simulator, and runs the unit and UI tests. Override the destination when needed:

```bash
AH_SIMULATOR_DESTINATION='platform=iOS Simulator,id=SIMULATOR_UDID' ./scripts/verify.sh
```

Replace `SIMULATOR_UDID` with an installed device's UUID from `xcrun simctl list devices available`. For a physical device, copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` and fill in your team and bundle identifier. APNs and Associated Domains entitlements are deliberately absent until provisioning and the native auth design are settled. Distribution icons and signing are later release tasks.

## On Linux / source verification

```bash
./scripts/verify.sh --static
python3 scripts/check-workspace.py --source ../ah
# With a Swift 6+ toolchain installed (Linux or macOS):
swift test
```

The static checks detect duplicate/case-colliding files, broken local Markdown links, missing scaffold files, malformed metadata/plists, and source drift. `swift test` separately compiles and tests the Foundation protocol sources in `Package.swift`: host validation, terminal encoding, SSE framing and state reduction. It does not compile UIKit, the Observation feature model or GRDB. The macOS Xcode unit-test target also includes these core tests. See [the transport contract](docs/native/TRANSPORT.md) for coverage and connection/authentication gates.

Preparation ran on Linux without Swift, Xcode or an Apple simulator. On 24 October, an isolated Swift 6.2 Linux toolchain compiled the portable core and all **19 Swift tests passed**. UIKit/GRDB compilation and simulator/UI tests have **not** run. See [docs/native/TEST-MATRIX.md](docs/native/TEST-MATRIX.md) for gates and evidence.

## Porting next

1. On macOS, generate, resolve and build the scaffold; resolve compiler/SDK issues before feature work.
2. Design and test scoped/revocable native credentials and pairing in `ah`, preserving its existing browser defenses.
3. Implement typed REST/SSE state, a first authenticated Inbox journey, and a real terminal adapter.
4. Continue through the priorities and acceptance gates in [SPEC.md](SPEC.md), updating [PARITY.md](docs/native/PARITY.md) with evidence.

The source application has not been changed. This is an independent local Git repository; scaffolding continues on `scaffold/state-foundations`, without a remote, commit, push or deployment. Follow the parent `../AGENTS.md` stacked-PR rules when it is ready to ship.

