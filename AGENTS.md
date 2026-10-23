# Agent Hub Native workspace

Read root `AUDIT.md`, `SPEC.md` and `docs/native/ARCHITECTURE.md` before porting. The current task delivered preparation only; the implementation mission in SPEC describes subsequent product work.

- Target iOS/iPadOS 26+. UIKit owns lifecycle, presentation, navigation, keyboard routing and scenes. SwiftUI hosts content. Use Observation and Swift concurrency, with explicit ownership and cancellation.
- GRDB is the local persistence library. Preserve migration history. Store only non-secret navigation metadata until encrypted account-bound caching is designed. Credentials belong in Keychain.
- `../ah` is the canonical backend/web reference. Do not copy its server, node_modules, web build, lockfile or PWA into this project. `SOURCE.json` pins the audited baseline; verify drift before relying on it.
- No fake sessions, success states or terminal substitutes. Authentication, APNs and signing are unresolved product gates. Never spoof Origin/Tailscale identity headers or reuse the host CLI token.
- Keep one canonical copy of the audit and specification at the root. Maintain source/test evidence and truthful statuses in `docs/native/PARITY.md`.
- `project.yml` generates the Xcode project. Run `./scripts/verify.sh --static` anywhere and `./scripts/verify.sh` on macOS. Do not claim an Apple build or device check passed without executing it.
- Honor inherited `../AGENTS.md` shipping requirements. Preparation stays local until builds and meaningful checks pass; never push or deploy without the user's instruction.

