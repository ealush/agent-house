import Foundation

/// What a notification's `ah` payload names (`server/apns.ts`): where to go and what for, and
/// what a newer host adds: the prompt a "needs you" alert showed, and its count of sessions
/// waiting on you. The app's own alerts (`LocalAlerts`, failure notes) use the same shape.
struct PushPayload: Equatable, Sendable {
    let link: DeepLink
    /// "waiting", "done", "resolved" (a quiet push: a session stopped waiting), or the app's
    /// own "failed" (an action from a notification that didn't go through).
    let event: String
    /// The `askId` of the prompt a "needs you" alert is about. Approve and Deny send it back,
    /// and the host refuses them if the session asks something else now. Nil from older hosts.
    let prompt: String?
    /// The sending host's count of sessions waiting on you, as of this push.
    let waiting: Int?
    /// A reply that couldn't be sent from a notification, kept for the session's composer.
    let draft: String?

    init?(_ userInfo: [AnyHashable: Any]) {
        guard let ah = userInfo["ah"] as? [String: Any], let route = ah["route"] as? String else { return nil }
        link = DeepLink(route: route, host: ah["host"] as? String)
        event = ah["event"] as? String ?? ""
        prompt = (ah["prompt"] as? String).flatMap { $0.isEmpty || $0.count > 64 ? nil : $0 }
        waiting = (ah["waiting"] as? Int) ?? (ah["waiting"] as? NSNumber)?.intValue
        draft = ah["draft"] as? String
    }

    /// The `userInfo` of an alert the app posts itself, shaped like a host's.
    static func userInfo(host: String?, route: String, event: String, prompt: String? = nil, draft: String? = nil) -> [String: Any] {
        var ah: [String: Any] = ["v": 1, "route": route, "event": event]
        if let host { ah["host"] = host }
        if let prompt { ah["prompt"] = prompt }
        if let draft { ah["draft"] = draft }
        return ["ah": ah]
    }
}

/// A signed-in host as a notification response sees it.
struct NotifiedAccount: Equatable, Sendable {
    let origin: String
    /// The account's own hostname, and the peers it reaches.
    let hostname: String
    let peers: [String]

    func serves(_ host: String?) -> Bool {
        guard let host else { return false }
        return hostname == host || peers.contains(host)
    }
}

/// What a tap or an action on an alert does, decided against the hosts this device is signed
/// in to right now. It never falls back to some other host: an Approve meant for a host this
/// device isn't signed in to is refused here, not sent somewhere else.
enum NotificationPlan: Equatable, Sendable {
    /// Open the place in a window (on that account; nil leaves the window's own).
    case open(DeepLink, origin: String?)
    case answer(origin: String, key: String, approve: Bool, prompt: String?)
    case reply(origin: String, key: String, text: String)
    /// Nothing can be sent: the host it's from isn't signed in here.
    case notSignedIn(host: String?)
    case nothing
}

enum NotificationResponses {
    /// `UNNotificationDefaultActionIdentifier` and `UNNotificationDismissActionIdentifier`.
    static let defaultAction = "com.apple.UNNotificationDefaultActionIdentifier"
    static let dismissAction = "com.apple.UNNotificationDismissActionIdentifier"
    static let approveAction = "AH_APPROVE"
    static let denyAction = "AH_DENY"
    static let replyAction = "AH_REPLY_SEND"

    /// The signed-in account that serves the alert's host. An alert without a host (an old
    /// one) belongs to the only signed-in account, or to none.
    static func account(for link: DeepLink, in accounts: [NotifiedAccount]) -> NotifiedAccount? {
        if let host = link.host { return accounts.first { $0.serves(host) } }
        return accounts.count == 1 ? accounts.first : nil
    }

    static func plan(_ payload: PushPayload, action: String, reply: String?, accounts: [NotifiedAccount]) -> NotificationPlan {
        let account = account(for: payload.link, in: accounts)
        switch action {
        case dismissAction:
            return .nothing
        case approveAction, denyAction:
            guard let account else { return .notSignedIn(host: payload.link.host) }
            guard let key = payload.link.sessionKey(localHost: account.hostname) else { return .open(payload.link, origin: account.origin) }
            return .answer(origin: account.origin, key: key, approve: action == approveAction, prompt: payload.prompt)
        case replyAction:
            let text = reply?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard let account else { return text.isEmpty ? .open(payload.link, origin: nil) : .notSignedIn(host: payload.link.host) }
            guard !text.isEmpty, let key = payload.link.sessionKey(localHost: account.hostname) else { return .open(payload.link, origin: account.origin) }
            return .reply(origin: account.origin, key: key, text: text)
        default:
            return .open(payload.link, origin: account?.origin)
        }
    }

    /// The note posted when an action from a notification didn't go through: what happened,
    /// in words that don't claim more than the app knows. Nil when it went through.
    struct Failure: Equatable, Sendable {
        let title: String
        let body: String
    }

    static func failure(_ plan: NotificationPlan, error: APIError?, hostname: String?) -> Failure? {
        let host = hostname ?? "its host"
        switch plan {
        case .notSignedIn(let name):
            return Failure(title: "Nothing was sent", body: "This device isn’t signed in to \(name ?? "that host"). Open Agent House to sign in.")
        case .answer(_, _, let approve, _):
            guard let error else { return nil }
            let verb = approve ? "approved" : "denied"
            switch error {
            case .conflict(let message) where message.contains("asking something else"):
                return Failure(title: "Not \(verb)", body: "It’s asking something else now. Open it to see what.")
            case .conflict, .notFound:
                return Failure(title: "Not \(verb)", body: "It’s no longer waiting on that: answered elsewhere, or it moved on.")
            case .unauthorized:
                return Failure(title: "Not \(verb)", body: "Your sign-in to \(host) ended. Open Agent House to sign in again.")
            case .transport:
                return Failure(title: "Couldn’t reach \(host)", body: "Agent House couldn’t confirm it was \(verb). Open it to see where it stands.")
            default:
                return Failure(title: "Not \(verb)", body: error.message)
            }
        case .reply:
            guard let error else { return nil }
            switch error {
            case .unauthorized:
                return Failure(title: "Reply not sent", body: "Your sign-in to \(host) ended. Your words are kept: tap to open it.")
            case .transport:
                return Failure(title: "Couldn’t reach \(host)", body: "Agent House couldn’t confirm your reply was sent. Your words are kept: tap to check.")
            default:
                return Failure(title: "Reply not sent", body: "\(error.message) Your words are kept: tap to open it.")
            }
        case .open, .nothing:
            return nil
        }
    }
}

/// The host-side count of sessions waiting on you, per signed-in host, for the icon badge
/// when the app is woken by a host's push and its own lists may be out of date.
struct BadgeLedger: Equatable, Sendable {
    private(set) var counts: [String: Int] = [:]

    /// A live list (or a push) says `origin` has `count` sessions waiting.
    mutating func set(_ count: Int, for origin: String) { counts[origin] = max(0, count) }
    /// Only hosts still signed in count.
    mutating func keep(_ origins: Set<String>) { counts = counts.filter { origins.contains($0.key) } }
    var total: Int { counts.values.reduce(0, +) }
}
