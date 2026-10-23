# Architecture

## Target and authority

iPhone/iPad, iOS 26+. The existing `../ah` service owns agent sessions, tmux, queues, drafts, review state, provider configuration and filesystem operations. Native is an additional client. The current preparation makes no backend changes.

## Layers

| Area | Ownership / current files |
| --- | --- |
| Lifecycle and navigation | `AppDelegate` creates one shared scene store. `SceneDelegate` owns a coordinator/window. `AppCoordinator` owns UIKit navigation and hosts SwiftUI content. |
| Feature state | `HostSetupModel` uses `@Observable` and `@MainActor`. A distinct instance belongs to each scene. SwiftUI binds to its projection. |
| Domain | `HostEndpoint` validates the hub's HTTPS Tailscale Serve origin; `SessionIdentity` is host + stable uid, never a tmux window ID. These are local domain types, not a claim of complete wire DTO coverage. |
| Wire state | `Sources/Networking` defines a read-only API 28 Inbox projection, typed asks, an incremental bounded SSE parser and a per-host snapshot/patch reducer. Not connected to the app or a network transport. See [transport contract](TRANSPORT.md). |
| Persistence | `SceneStore` is an actor with one lazy GRDB `DatabasePool`, migrations, transactional upsert and scene-keyed lookup/removal. Concurrent windows justify pooled WAL readers. |
| Terminal boundary | `TerminalInput` matches current JSON input/resize/scroll messages. `TerminalTransport` and `TerminalRenderer` are interfaces only. No WebSocket or emulator has been connected. |
| Future transport | Actor-owned URLSession REST/SSE/WebSocket clients with typed DTOs, cancellation, bounded buffering, reconnect/resync and explicit delivery status. Authentication first. |

## Portable protocol harness

`Package.swift` compiles the existing Domain, Networking and terminal-input source files as `AgentHubCore` for `swift test` on Linux/macOS. XcodeGen compiles the same files directly into the app, with the same `Tests/Core` tests in its unit-test target. Conditional test imports select the module; there is one canonical implementation of each type. This harness has no external dependencies and does not compile UIKit, feature Observation models, GRDB or Keychain. Passing it cannot establish an Apple build or native authentication.

## Restoration

UIKit scene sessions supply `persistentIdentifier`; each scene loads its corresponding versioned GRDB snapshot. `NSUserActivity` carries only that lookup identifier. Significant host-address saves write immediately, with a supplementary background save. Never depend on termination callbacks. Discarding a scene removes its row on a best-effort basis.

The v1 snapshot holds schema version, scene ID and validated host origin only. It cannot yet restore session selection, tabs, pane layout, scroll position or drafts: extend it with tested migrations as those features arrive. Load errors surface without deleting the journal. Future versions are rejected instead of silently erased. A fresh scene without a journal entry opens setup.

The directory is excluded from backups and uses iOS Data Protection `completeUntilFirstUserAuthentication`. This is not application-level database encryption. No transcript/draft/credential is currently cached. Before sensitive caching, introduce Keychain-bound CryptoKit encryption, account identity/invalidation, retention, signout cleanup and revoked-account handling.

## State boundaries for the port

| Scope | State |
| --- | --- |
| Host-global | Live sessions/status, titles/order/pins, queues, synced drafts, history/review, agents/environment/providers. Reconcile with server truth. |
| Device/account | Revocable credential in Keychain; local appearance/shortcuts/notification preferences; stable device presence identity. Not implemented yet. |
| Scene | Selected route, pane tree/workspace, focus and scroll positions; never share a mutable navigation model between windows. Only host setup is wired today. |

Current auth is browser-centric: writes require exact Origin + `X-AH`, WebSocket upgrades require Origin, and Serve requests require server-injected owner identity. Read `../ah/server/gate.ts`, `server/main.ts`, `server/auth.ts`, `SECURITY.md` and adversarial security tests before changing it. Design an explicit native contract; the interfaces in this scaffold do not authorize requests.

`WKWebView` is reserved for developer previews after an authenticated, isolated cookie/origin strategy is proved. The app shell and terminal must remain native.

