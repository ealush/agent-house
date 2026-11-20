# Architecture

## Target and authority

iPhone and iPad, iOS/iPadOS 26+, Swift 6 with complete strict concurrency. The `../ah` service stays the authority for sessions, tmux, queues, drafts, review state, providers and files; the app is another client of it. Backend changes are additive and live on their own stacked branches in `ah` (native device auth, APNs).

## Modules and where they compile

| Layer | Directory | Compiles on | Owns |
| --- | --- | --- | --- |
| Domain | `Sources/Domain` | Linux + Apple | Host endpoint validation, session identity/status words, ask reading and question forms, theme palettes, deep links |
| Networking | `Sources/Networking` | Linux + Apple | `APIClient` for every `web/api.ts` route, `URLSessionTransport` (no cookies, cache or redirects; delegate-streamed SSE), wire DTOs, SSE parser, snapshot/patch reducer |
| Auth | `Sources/Auth` | Linux + Apple | `NativeAuth` enroll/sign-in signing, device keys (`DeviceKey`), credential types |
| Connection | `Sources/Connection` | Linux + Apple | `StateStream` (per-connection reducer, backoff, polling while down, foreground resync), `FeedStream` |
| Feed | `Sources/Feed` | Linux + Apple | Transcript schema, reducer, projection to blocks/tools/widgets, diff parsing, hand-off text |
| Terminal | `Sources/Terminal` | Linux + Apple | `TerminalConnection` (PTY WebSocket, re-resolves the tmux window per attach, never replays keys), input/resize/scroll frames |
| Keyboard | `Sources/Keyboard` | Linux + Apple | The 89-command catalog, chords, bindings, matcher, which-key, palette tree |
| Workspace | `Sources/Workspace` | Linux + Apple | Pane layout tree, tiles/seams geometry, neighbors, the journal's slot |
| Persistence | `Sources/Persistence` | Linux + Apple | GRDB `AppDatabase` (migrations), scene journal, accounts, preferences, sealed cache, credential vault |
| Models | `Sources/Models` | Linux + Apple | `AppModel`, `AccountSession`, `HubStore`, `SceneModel`, `SessionModel`, composer/outbox/drafts/queue, launch plans, panel and settings models |
| Review | `Sources/Review` | Linux + Apple | `ReviewAPI`, review DTOs, `ReviewModel`, `LayerConfidence`, `StackMergePlan` |
| Markdown | `Sources/Markdown` | Linux + Apple | GitHub-flavored Markdown parser for native rendering |
| Platform | `Sources/Platform` | Apple only | Keychain store, Secure Enclave keys, `UIKey` → `KeyPress`, menu commands, haptics, styles, `PushRegistrar` |
| Features | `Sources/Features` | Apple only | SwiftUI content: Inbox and Search pages (the session list's blocks in the Inbox, History in Search), session screen (transcript, widgets, composer, ask, terminal, panels), Review, Settings, sheets, overlays, the UIKit shell |
| App | `App` | Apple only | `AppDelegate`, `SceneDelegate` |

`Package.swift` builds everything except `Features`, `Platform` and `App` as `AgentHubKit`, so the protocol, persistence, models and keyboard logic are compiled and tested on Linux with the same sources XcodeGen compiles into the app. `swift-crypto` stands in for CryptoKit on Linux only.

## Ownership

- **App** (`AppModel`): storage, Keychain vault, device key store, transport, device preferences and shortcuts, the outbox, every enrolled account. Created once by `AppDelegate`.
- **Account** (`AccountSession`): one host origin, its bearer credential (Keychain), its `APIClient` and `HubStore`. `HubStore` runs one state stream for the hub and one per online peer (under `/h/<peer>`), for the whole app; windows observe it and never open their own. Rejection (401/4401) from any request or stream signs the account out everywhere at once.
- **Window** (`SceneModel`): route, workspace/panes, sheet/palette/switcher state, focus requests, key scope, toasts. Each UIKit scene has its own, keyed by the scene session's persistent identifier. `SessionModel`s are per window (their feed streams are per viewer, like a browser tab).
- **Session view** (`SessionModel`): feed stream, composer, queue, notices; created on first display and pruned when no pane or route shows it.

## UIKit shell

`SceneRootController` is each window's root. It swaps between setup, sign-in and the app by account state, and on iOS 26 uses `updateProperties()` observation tracking to follow `SceneModel` without Combine:

- **Layout**: `MainSplitController` (`UISplitViewController`, double column) with the SwiftUI sidebar and detail; its `.compact` column is a `UITabBarController` (`UITab`s: Inbox, Review, Search; the Inbox, grouped by project, is a phone's session list, and Search lists every session and History before a word is typed) whose `UINavigationController`s push a `SessionHostController` per session. Rotation and Stage Manager resizing keep the same `SceneModel`, so the place survives.
- **Panes**: `WorkspaceView` lays tiles out flat from `LayoutNode.tiles()`, so a session's view (and terminal) survives the tree changing; seams drag to resize. Maximized, or when `LayoutNode.fits` says the window is too small, it shows the focused pane alone with a pane strip, keeping the others alive underneath. Each pane hovers to focus, drops sessions or other panes on its edges (split) or center (replace/swap), and its header carries the same pane commands as the palette (`PaneMenuItems`, also its context menu). An empty pane is an inline session search.
- **Presentation**: one modal slot driven by `SceneModel.sheet`/`palette`/`switcher`/`showingShortcuts`; dismissing by swipe writes back to state. Toasts, which-key and the submap legend float in a pass-through overlay.
- **Focus**: `SceneModel` is the one place that decides where the keyboard goes. Every command, palette row, switcher pick, hover and pane tap runs inside `following`, which compares what the window shows before and after; if the focused pane or its content changed and nothing asked for focus meanwhile, it requests the pane's remembered spot (composer or terminal, kept per session from `didFocus`) or a chooser's search. Requests made while a sheet or the palette is up wait until it's dismissed, and a dismissal with no request puts the keyboard back where it was. Automatic moves happen only with a hardware keyboard attached. Hover focus is gated by drags, overlays, submaps, zoom and a short quiet period after any layout change.
- **Keyboard**: `AppDelegate.buildMenu` puts every command in the menu bar (and the ⌘-hold overlay) with `UIKeyCommand`s targeting `runKeyCommand(_:)` on the root. `canPerformAction` asks `SceneModel.allowsMenuCommand`, which matches the chord through the current key scope (composer field edges, terminal), so a disabled command lets the key reach the focused responder. The composer (`UITextView`) and terminal (`TerminalView`) route their own `pressesBegan` through `SceneModel.handle` first; the root handles leftover app-scope keys (submaps, workspace digits) and held-modifier which-key.

- **Conversation layout**: a session's conversation is a UIKit container (`ConversationController`). The transcript's collection view fills it, and the composer's dock stands on the keyboard layout guide, the only place the keyboard is accounted for. SwiftUI's keyboard safe area is off around session screens. Who owns which geometry, and the invariants, are in [CONVERSATION-LAYOUT.md](CONVERSATION-LAYOUT.md).

## Security

- Enrollment needs a one-time setup code from an already signed-in device (or `ah auth code` on the host). The device key is a Secure Enclave P-256 key (`.userPresence`, Face ID); only its public half leaves the device. Sign-in signs a fresh host challenge. Sessions are bearer tokens in Keychain; removing the device on any other device ends every sign-in from it and closes its streams and terminals.
- The client never sends forged Origin or Tailscale identity headers. Writes carry `X-AH`; the host accepts a missing Origin only with a native bearer and no cookies. The backend's loopback binding and browser defenses are unchanged.
- Local data: GRDB under Application Support, excluded from backup, `completeUntilFirstUserAuthentication`. Transcript pages are sealed with AES-GCM under a key derived (HKDF) from a device secret in Keychain and a per-sign-in server key, bound to the host origin; locking drops the key, forgetting an account deletes its rows.
- Developer preview uses a non-persistent `WKWebView` with a host-only preview cookie from `/api/auth/native/preview-session`; links leaving the host open in Safari.

## Restoration

Each scene's journal row (`SceneSnapshot`, versioned) records route, workspaces/panes, per-session surface/panel/scroll anchor/composer focus, search and filters. `SceneDelegate` keeps only the scene identifier and account origin in `stateRestorationActivity`; after relaunch `SceneModel.restore()` loads the row, and `reconcileIfReady()` checks every session against the host once state arrives (ended sessions fall back to History, gone ones are dropped). Saves are debounced, immediate on backgrounding; termination callbacks are never relied on.

## Notifications

`PushRegistrar` asks for permission once, registers for APNs, and sends the token plus per-device opt-ins (needs you, finished, private preview) to every signed-in host (`PUT /api/push/apns`). The host's `server/apns.ts` sends ES256-JWT-authenticated HTTP/2 pushes; payloads carry `ah: {host, route, event}` and, for plain permission prompts only, the `AH_APPROVAL` category with Approve/Deny actions that require an unlocked device. Taps route through `DeepLink` to the right account and window. The icon badge counts sessions waiting on you across hosts.
