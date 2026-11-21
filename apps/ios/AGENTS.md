# Agent Hub Native workspace

Read root `AUDIT.md`, `SPEC.md` and `docs/native/ARCHITECTURE.md` before changing behavior.

- Target iOS/iPadOS 26+. UIKit owns lifecycle, scenes, presentation, navigation and keyboard routing; SwiftUI hosts content. Use Observation (no Combine/ObservableObject) and Swift concurrency with explicit ownership and cancellation.
- GRDB is the only persistence library. Preserve migration history. Credentials and key material belong in Keychain; anything sensitive cached in GRDB goes through `SealedCache`, never the scene journal.
- The server and web client are in this repository (the root, until they move to `apps/server`); they're the canonical backend/web reference. Don't copy their code, node_modules, web build, lockfile or PWA into the app. Backend changes stay additive and backward compatible with installed apps; a change on both sides can land in one stack.
- No fake sessions, success states or terminal substitutes. Never spoof Origin/Tailscale identity headers, reuse the host CLI token, expose the backend publicly or change its loopback binding.
- Keep non-UI code in `Sources` outside `Features`/`Platform` so `swift test` and `scripts/integration.sh` cover it. Gate commits on `swift test` passing.
- Keep `docs/native/PARITY.md` statuses truthful with evidence. Don't claim an Apple build, simulator or device check passed without running it.
- Honor the repository root's `AGENTS.md` and `~/code/CLAUDE.md` shipping rules (stacked PRs via `gh stack`). Never push or deploy without the owner's instruction.
