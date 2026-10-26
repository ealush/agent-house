import Foundation

/// Server-owned stable identity. A tmux window ID is a temporary transport address.
struct SessionIdentity: Codable, Hashable, Sendable {
    let host: String
    let uid: String
}

