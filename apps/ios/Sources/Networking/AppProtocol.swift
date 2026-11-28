import Foundation

/// What this build of the app needs of a host, beyond API `HubStateDTO.supportedAPIVersion`:
/// every feature it gates on (`supports(name, version:)`) at the highest version it asks for.
/// A host that announces less still works (each gate falls back), but it's behind this app:
/// the app says so and offers to update it (`POST /api/system/update`, which sends these so
/// the host only moves to a server that announces them).
///
/// Generated from the app's own gates and held to them by `packages/protocol/check-app.mjs`
/// (`--write` rewrites the block), so it can't drift. An App Store release is tagged
/// `ios/v<version>` (`scripts/tag-app-release.sh`): at that commit this list, the app and the
/// server it was tested against are one tree.
enum AppProtocol {
    static let requires: [String: Int] = [
        // BEGIN requires (check-app.mjs --write)
        "attachedTerminal": 2,
        "checkouts": 1,
        "draftParts": 1,
        "fleet": 1,
        "folderFiles": 1,
        "jobs": 1,
        "logging": 1,
        "media": 1,
        "notes": 2,
        "portable": 1,
        "reviewPost": 1,
        "reviewPulls": 1,
        "reviewReady": 1,
        "serverUpdate": 1,
        "spaceChief": 1,
        "spaces": 3,
        "subagents": 1,
        "supervision": 1,
        "unsent": 1,
        "usage": 1,
        "voice": 1,
        // END requires
    ]

    /// What `features` (a host's announced versions; nil from one that predates them) lacks
    /// of `requires`, as "name version", by name. Empty: the host serves everything this app does.
    static func missing(from features: [String: Int]?) -> [String] {
        requires.keys.sorted().compactMap { name in
            let needed = requires[name]!
            return (features?[name] ?? 0) < needed ? "\(name) \(needed)" : nil
        }
    }
}
