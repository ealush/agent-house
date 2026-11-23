import Foundation

/// A live session as Siri, Shortcuts, Spotlight and Home Screen quick actions name it.
/// Read from the hubs in memory when asked, never indexed or written anywhere: titles are
/// conversation content, and only the sealed cache keeps them at rest.
struct ShortcutSession: Equatable, Sendable, Identifiable {
    /// `<origin>#<key>`: which signed-in host, then the session key there.
    let id: String
    let origin: String
    let key: String
    let title: String
    let project: String
    let agent: String?
    let word: StatusWord
    /// The host's name when more than one is in play, so two "api" sessions read apart.
    let host: String?
    let activity: Double

    init(origin: String, row: SessionRow, showHost: Bool) {
        id = "\(origin)#\(row.key)"
        self.origin = origin
        key = row.key
        title = row.title
        project = row.dto.project
        agent = row.dto.agent
        word = row.word
        host = showHost ? row.host : nil
        activity = row.lastActive
    }

    /// The parts of an id, or nil for one this app didn't mint.
    static func parse(_ id: String) -> (origin: String, key: String)? {
        guard let hash = id.lastIndex(of: "#") else { return nil }
        let origin = String(id[..<hash]), key = String(id[id.index(after: hash)...])
        return origin.isEmpty || key.isEmpty ? nil : (origin, key)
    }

    /// "orbit-web · needs you", "mac · orbit-web · working".
    var subtitle: String { [host, project.isEmpty ? nil : project, word.rawValue].compactMap { $0 }.joined(separator: " · ") }

    var link: DeepLink { .session(host: host, uid: SessionKey(key)?.uid ?? key) }
}

@MainActor
enum ShortcutCatalog {
    /// Every live session on every signed-in host: those that need you first, then working
    /// ones, then the rest by latest activity.
    static func sessions(_ app: AppModel) -> [ShortcutSession] {
        let signedIn = app.accounts.filter { $0.status == .signedIn }
        var all: [ShortcutSession] = []
        for account in signedIn {
            let showHost = signedIn.count > 1 || account.hub.multiHost
            all += account.hub.rows.map { ShortcutSession(origin: account.origin, row: $0, showHost: showHost) }
        }
        return ranked(all)
    }

    nonisolated static func ranked(_ sessions: [ShortcutSession]) -> [ShortcutSession] {
        func rank(_ word: StatusWord) -> Int {
            switch word {
            case .needsYou, .limited: return 0
            case .working: return 1
            default: return 2
            }
        }
        return sessions.sorted { a, b in rank(a.word) != rank(b.word) ? rank(a.word) < rank(b.word) : a.activity > b.activity }
    }

    /// Best matches for what was said or typed ("the api one", "welcome flow").
    nonisolated static func matching(_ text: String, in sessions: [ShortcutSession]) -> [ShortcutSession] {
        let words = text.lowercased().split(whereSeparator: \.isWhitespace).filter { !fillers.contains(String($0)) }.joined(separator: " ")
        guard !words.isEmpty else { return sessions }
        return sessions
            .compactMap { s -> (ShortcutSession, Double)? in
                let score = CommandMatcher.fuzzy(words, "\(s.title) \(s.project) \(s.agent ?? "") \(s.host ?? "")")
                return score > 0 ? (s, score) : nil
            }
            .sorted { $0.1 > $1.1 }
            .map(\.0)
    }

    /// Words people say around a name that aren't part of it.
    nonisolated private static let fillers: Set<String> = ["the", "my", "session", "one", "agent", "a", "in", "on"]

    /// What Siri says when asked what needs you.
    nonisolated static func needsYouSummary(_ sessions: [ShortcutSession]) -> String {
        let waiting = sessions.filter { $0.word == .needsYou || $0.word == .limited }
        let working = sessions.filter { $0.word == .working }.count
        let busy = working == 0 ? "" : working == 1 ? " One is working." : " \(working) are working."
        switch waiting.count {
        case 0: return "Nothing needs you." + busy
        case 1: return "\(waiting[0].title) needs you." + busy
        default:
            let names = waiting.prefix(3).map(\.title)
            let list = waiting.count > 3 ? names.joined(separator: ", ") + " and \(waiting.count - 3) more"
                : names.dropLast().joined(separator: ", ") + " and " + names.last!
            return "\(waiting.count) sessions need you: \(list)." + busy
        }
    }

    /// What Siri says after sending a message.
    nonisolated static func sentSummary(_ outcome: SendResult.Outcome, title: String) -> String {
        outcome == .queued ? "Queued for \(title); it goes in when the agent is free." : "Sent to \(title)."
    }
}

/// Home Screen quick actions (touch and hold the icon). The Inbox one carries only a count:
/// the system keeps quick actions outside the app's sealed storage, so no titles go there.
enum QuickAction: String, CaseIterable, Sendable {
    case newSession = "dev.ealush.ah.native.new-session"
    case search = "dev.ealush.ah.native.search"
    case inbox = "dev.ealush.ah.native.inbox"

    /// The palette command each one runs in the window it opens.
    var command: CommandID {
        switch self {
        case .newSession: return "new-session"
        case .search: return "go-search"
        case .inbox: return "go-inbox"
        }
    }

    static func inboxTitle(needsYou: Int) -> String {
        switch needsYou {
        case 0: return "Inbox"
        case 1: return "1 Needs You"
        default: return "\(needsYou) Need You"
        }
    }
}
