import Foundation

/// A place in ah that a link can name, the same on every device and in the web app. Its
/// hash is the web's (`../ah/web/App.tsx` fromHash), with a session's view after a "?":
///
///     ""                       Inbox
///     sessions, history, search
///     review, review/<stack>, review/<stack>/<pr>
///     settings, settings/<section>      (bare settings and "security": the first section)
///     <uid>, <host>/<uid>      a session (a peer's, relative to the linked host)
///     <key>?view=terminal      its terminal (or view=gui)
///     <key>?panel=diff         a panel open beside it (diff, files, chat, queue, snapshots,
///                              preview, stack)
///     <key>?m=<seq>            a message: the transcript entry with that seq
///
/// Anything else is the Inbox: a link never opens what it can't name exactly.
struct Place: Equatable, Sendable, Hashable {
    var route: SceneSnapshot.Route
    var surface: SceneSnapshot.Surface?
    var panel: SceneSnapshot.Panel?
    var message: Int?

    init(_ route: SceneSnapshot.Route, surface: SceneSnapshot.Surface? = nil, panel: SceneSnapshot.Panel? = nil, message: Int? = nil) {
        self.route = route
        // Only a session has a view.
        if case .session = route {
            self.surface = surface
            self.panel = panel
            self.message = message
        }
    }

    init(hash raw: String) {
        var h = raw.hasPrefix("#") ? String(raw.dropFirst()) : raw
        h = h.removingPercentEncoding ?? h
        let path = String(h.prefix { $0 != "?" })
        let query = h.dropFirst(path.count + 1)
        let options = Dictionary(URLComponents(string: "?" + query)?.queryItems?.compactMap { item in item.value.map { (item.name, $0) } } ?? [], uniquingKeysWith: { first, _ in first })
        if path == "security" || path == "settings" { self.init(.settings(nil)); return }
        if path.hasPrefix("settings/") {
            let section = String(path.dropFirst("settings/".count))
            self.init(.settings(SettingsSection(rawValue: section) == nil || section == SettingsSection.security.rawValue ? nil : section))
            return
        }
        if path == "review" || path.hasPrefix("review/") { self.init(.review(ReviewRoute(fragment: path))); return }
        switch path {
        case "": self.init(.inbox); return
        // History is in Search now.
        case "history": self.init(.search); return
        // The web's old Sessions tab is the Inbox now.
        case "sessions": self.init(.inbox); return
        case "search": self.init(.search); return
        default: break
        }
        guard Self.isSessionKey(path) else { self.init(.inbox); return }
        self.init(
            .session(path),
            surface: options["view"].flatMap(SceneSnapshot.Surface.init(rawValue:)),
            panel: options["panel"].flatMap(SceneSnapshot.Panel.init(rawValue:)),
            message: options["m"].flatMap { Int($0) }.flatMap { $0 >= 0 ? $0 : nil }
        )
    }

    /// The web app's hash for this place, without "#".
    var hash: String {
        switch route {
        case .inbox, .worktrees: return ""
        case .search: return "search"
        case .settings(let section): return section.map { "settings/\($0)" } ?? "settings"
        case .review(let target): return target.fragment
        case .session(let key):
            var options: [String] = []
            if let surface { options.append("view=\(surface.rawValue)") }
            if let panel { options.append("panel=\(panel.rawValue)") }
            if let message { options.append("m=\(message)") }
            return options.isEmpty ? key : key + "?" + options.joined(separator: "&")
        }
    }

    /// What the place is, briefly (a palette row's detail); `title` names a session.
    func summary(title: String? = nil) -> String {
        switch route {
        case .inbox, .worktrees: return "Inbox"
        case .search: return "Search"
        case .review(let target): return target.stack == nil ? "Review" : target.pr.map { "Review · #\($0)" } ?? "Review · a stack"
        case .settings(let section): return "Settings · " + (section.flatMap(SettingsSection.init(rawValue:))?.title ?? SettingsSection.security.title)
        case .session(let key):
            var parts = [title ?? key]
            if surface == .terminal { parts.append("terminal") }
            if let panel { parts.append(panel.title) }
            if let message { parts.append("message \(message)") }
            return parts.joined(separator: " · ")
        }
    }

    /// A session key a link may name: "uid", or "host/uid" with a hostname-safe host.
    static func isSessionKey(_ path: String) -> Bool {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard let uid = parts.last, parts.count <= 2, (4...40).contains(uid.count), DeepLink.isUID(uid) else { return false }
        guard parts.count == 2 else { return true }
        return !parts[0].isEmpty && parts[0].allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-" || $0 == "_") }
    }
}

/// A link to a place on one of your hosts. A web link is the host's own address with the
/// place as its hash (`https://desk.tail1234.ts.net/#a1b2c3?m=42`): it opens the web app
/// anywhere, and this app when it's handed one. An app link names the host instead
/// (`agenthub://desk.tail1234.ts.net/a1b2c3?m=42`): the web app offers it to open the same
/// place here. Only navigation travels, never a token.
struct AppLink: Equatable, Sendable {
    /// The web link's host origin ("https://desk.tail1234.ts.net"), or nil for an app link.
    var origin: String?
    /// The app link's host: a hostname, a host's full name, or nil ("local": whichever host).
    var host: String?
    var place: Place

    init(origin: String, place: Place) {
        self.origin = origin
        self.host = nil
        self.place = place
    }

    init(host: String?, place: Place) {
        self.origin = nil
        self.host = host == "local" ? nil : host
        self.place = place
    }

    /// An `agenthub:` link, or an http(s) link with a hash (whether it names one of your hosts
    /// is for `resolve` to say).
    init?(url: URL) {
        switch url.scheme?.lowercased() {
        case DeepLink.scheme:
            let path = url.path.hasPrefix("/") ? String(url.path.dropFirst()) : url.path
            var hash = path
            if let query = url.query, !query.isEmpty { hash += "?" + query }
            // An old notification route carried the hash after a "#".
            if let fragment = url.fragment { hash = path.isEmpty ? fragment : hash }
            self.init(host: url.host.flatMap { $0.isEmpty ? nil : $0 }, place: Place(hash: hash))
        case "https", "http":
            guard let origin = Self.origin(of: url) else { return nil }
            self.init(origin: origin, place: Place(hash: url.fragment ?? ""))
        default:
            return nil
        }
    }

    /// Text someone pasted: a link, with whatever surrounded it trimmed.
    init?(text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: "<>\"'")))
        guard !trimmed.contains(where: \.isWhitespace), let url = URL(string: trimmed) else { return nil }
        self.init(url: url)
    }

    /// The web link to `place` on the host at `origin`.
    static func webURL(origin: String, place: Place) -> URL? {
        guard var components = URLComponents(string: origin), components.host != nil else { return nil }
        components.path = "/"
        components.query = nil
        let hash = place.hash
        // The hash goes in as written: it is the web app's own, already safe for a fragment.
        components.percentEncodedFragment = hash.isEmpty ? nil : hash.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed)
        return components.url
    }

    /// The app link to `place` on `host` (a host's full name, as its web origin has it).
    static func appURL(host: String, place: Place) -> URL? {
        let hash = place.hash
        let path = String(hash.prefix { $0 != "?" })
        var components = URLComponents()
        components.scheme = DeepLink.scheme
        components.host = host
        components.path = "/" + path
        if path.count < hash.count { components.percentEncodedQuery = String(hash.dropFirst(path.count + 1)) }
        return components.url
    }

    /// "https://host[:port]" for a URL.
    static func origin(of url: URL) -> String? {
        guard let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased(), !host.isEmpty else { return nil }
        let standard = scheme == "https" ? 443 : 80
        if let port = url.port, port != standard { return "\(scheme)://\(host):\(port)" }
        return "\(scheme)://\(host)"
    }

    /// One of your hosts, as a link is matched against them.
    struct Account: Equatable, Sendable {
        var origin: String
        /// The host's own name ("desk"), when known.
        var hostname: String?
        /// The other hosts this one reaches ("laptop"): their sessions are "laptop/uid" here.
        var peers: [String]
    }

    /// The account that serves this link and the place on it, or nil when it names none of
    /// your hosts. A web link matches by origin. An app link matches a host by its full name
    /// or hostname; one that names a peer opens the peer's session through the account that
    /// reaches it. "local" (no host) is the first account, or `preferred` when given.
    func resolve(_ accounts: [Account], preferred: String? = nil) -> (origin: String, place: Place)? {
        if let origin {
            guard let account = accounts.first(where: { $0.origin.lowercased() == origin.lowercased() }) else { return nil }
            return (account.origin, place)
        }
        guard let host = host?.lowercased() else {
            guard let account = accounts.first(where: { $0.origin == preferred }) ?? accounts.first else { return nil }
            return (account.origin, place)
        }
        if let account = accounts.first(where: { URL(string: $0.origin)?.host?.lowercased() == host || $0.hostname?.lowercased() == host }) {
            return (account.origin, place)
        }
        for account in accounts {
            guard let peer = account.peers.first(where: { $0.lowercased() == host }) else { continue }
            var place = place
            if case .session(let key) = place.route, !key.contains("/") {
                place = Place(.session("\(peer)/\(key)"), surface: place.surface, panel: place.panel, message: place.message)
            }
            return (account.origin, place)
        }
        return nil
    }
}
