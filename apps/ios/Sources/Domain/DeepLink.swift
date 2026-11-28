import Foundation

/// Where a notification or a link lands. Push routes are the web's hash without `#`
/// (`server/push.ts`): a session uid, or `review/<stack>/<pr>`. App links are
/// `agenthub://<host>/<route>` with the same route, so a link copied from one device opens the
/// same place on another.
enum DeepLink: Equatable, Sendable {
    case session(host: String?, uid: String)
    case review(host: String?, ReviewRoute)
    case inbox(host: String?)

    static let scheme = "agenthub"

    /// The host it names, if any ("local" in an app link means the account's own host).
    var host: String? {
        switch self {
        case .session(let host, _), .review(let host, _), .inbox(let host): return host == "local" ? nil : host
        }
    }

    /// A push payload's `ah.route` from `host` (the hostname that sent it).
    init(route: String, host: String?) {
        var r = route.hasPrefix("/") ? String(route.dropFirst()) : route
        if r.hasPrefix("#") { r.removeFirst() }
        r = r.removingPercentEncoding ?? r
        if r == "review" || r.hasPrefix("review/") {
            self = .review(host: host, ReviewRoute(fragment: r))
        } else if Self.inboxPages.contains(r) {
            // The web's own pages that are the Inbox here: "#interrupted" (auto-revive's alerts),
            // "#sessions". Read as a session id, the alert opened nothing.
            self = .inbox(host: host)
        } else if Self.isUID(r) {
            self = .session(host: host, uid: r)
        } else {
            self = .inbox(host: host)
        }
    }

    /// `agenthub://<host>/<route>`; anything else is not ours.
    init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        let host = url.host.flatMap { $0.isEmpty ? nil : $0 }
        let path = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
        self.init(route: url.fragment.map { path.isEmpty ? $0 : "\(path)#\($0)" } ?? path, host: host)
    }

    var url: URL {
        var c = URLComponents()
        c.scheme = Self.scheme
        switch self {
        case .session(let host, let uid):
            c.host = host ?? "local"
            c.path = "/\(uid)"
        case .review(let host, let route):
            c.host = host ?? "local"
            c.path = "/\(route.fragment)"
        case .inbox(let host):
            c.host = host ?? "local"
            c.path = "/"
        }
        return c.url!
    }

    /// Session uids are tmux-safe names (`ah` mints `[A-Za-z0-9_-]`).
    /// The web's hashes that are the Inbox (`web/App.tsx`): never a session's id.
    static let inboxPages: Set<String> = ["interrupted", "sessions", "inbox"]

    static func isUID(_ s: String) -> Bool {
        (1...80).contains(s.count) && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") }
    }

    /// The session key this link opens from an account on `localHost`: bare for the host's own
    /// sessions, `host/uid` for a peer's.
    func sessionKey(localHost: String?) -> String? {
        guard case .session(let host, let uid) = self else { return nil }
        guard let host, host != "local", host != localHost else { return uid }
        return "\(host)/\(uid)"
    }
}
