import Foundation

/// A subagent's place in the session namespace: "sub:<ref>" on the hub, "sub:<host>/<ref>" on
/// a peer, where `ref` is the host's own ref for the child (`claude:<session>:<agent>`,
/// `codex:<thread>`, ah's docs/spec/16-subagents.md). Like a note's key it never parses as a
/// `SessionKey`, so nothing takes a child for a live window of its own; panes, routes, the
/// journal and links carry it as they carry any session's key.
struct SubagentKey: Hashable, Sendable, CustomStringConvertible {
    static let prefix = "sub:"

    let host: String?
    /// The host's ref for the child: what its routes take.
    let ref: String

    init(host: String?, ref: String) {
        self.host = host
        self.ref = ref
    }

    init?(_ raw: String) {
        guard raw.hasPrefix(Self.prefix) else { return nil }
        let rest = raw.dropFirst(Self.prefix.count)
        var host: String?
        var ref = String(rest)
        if let slash = rest.lastIndex(of: "/") {
            host = String(rest[..<slash])
            ref = String(rest[rest.index(after: slash)...])
            guard let h = host, Self.validHost(h) else { return nil }
        }
        guard Self.validRef(ref) else { return nil }
        self.init(host: host, ref: ref)
    }

    var description: String { Self.prefix + (host.map { "\($0)/" } ?? "") + ref }

    static func isSubagent(_ raw: String) -> Bool { SubagentKey(raw) != nil }

    /// What a host's routes take as a session ref: `harness:` then ids, no slashes.
    static func validRef(_ s: String) -> Bool {
        (3...80).contains(s.count) && s.contains(":") && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" || $0 == ":" || $0 == ".") }
    }

    private static func validHost(_ s: String) -> Bool {
        (1...64).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" || $0 == ".") }
    }
}
