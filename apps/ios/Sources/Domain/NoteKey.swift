import Foundation

/// A scratchpad's place in the session namespace: "note:<uuid>". Panes, routes, the scene
/// journal and the palette all address sessions by key; a note is addressed the same way,
/// so it opens, tiles, restores and switches like any session, but no host owns the key:
/// it never parses as a `SessionKey`, and nothing asks a host about it.
enum NoteKey {
    static let prefix = "note:"

    static func key(_ id: String) -> String { prefix + id }

    /// The note's id for a note key; nil for any other key.
    static func id(_ key: String) -> String? {
        guard key.hasPrefix(prefix) else { return nil }
        let id = String(key.dropFirst(prefix.count))
        return isID(id) ? id : nil
    }

    static func isNote(_ key: String) -> Bool { id(key) != nil }

    /// Lowercase UUIDs, as the host keeps them.
    static func newID() -> String { UUID().uuidString.lowercased() }

    static func isID(_ s: String) -> Bool {
        s.count == 36 && UUID(uuidString: s) != nil && s == s.lowercased()
    }
}
