import Foundation

/// What the app does with ah's alerts while it's in use (`server/apns.ts`): no banner for a
/// session you're looking at, Notification Center only while the app is in front (its own
/// nudge says it), and alerts that no longer mean anything taken out of Notification Center.
enum AlertRules {
    enum Presentation: Equatable, Sendable {
        /// Banner, Notification Center and sound: the app isn't in front.
        case banner
        /// Kept in Notification Center, quietly: the app is in front and nudges on its own.
        case listOnly
        /// Nothing: you're looking at that session.
        case nothing
    }

    /// An alert arriving while the app runs. `key` is the session it's about (nil for a stack
    /// review, which nothing in the app nudges for).
    static func presentation(key: String?, onScreen: Bool, appActive: Bool) -> Presentation {
        guard let key, !key.isEmpty else { return .banner }
        if onScreen { return .nothing }
        return appActive ? .listOnly : .banner
    }

    /// A delivered alert, as the app can read it: its id, the session it's about, and its event.
    struct Delivered: Equatable, Sendable {
        let id: String
        let key: String?
        let event: String
        /// Its host's session list is live: only then does "not waiting" mean answered.
        var live = true
    }

    /// Alerts to take out of Notification Center: "needs you" for a session that no longer
    /// waits (answered anywhere, or ended; known only while its host's list is live), and
    /// anything about a session now on screen.
    static func stale(_ delivered: [Delivered], waiting: Set<String>, seen: Set<String>) -> [String] {
        delivered.compactMap { alert in
            guard let key = alert.key else { return nil }
            if seen.contains(key) { return alert.id }
            if alert.event == "waiting", alert.live, !waiting.contains(key) { return alert.id }
            return nil
        }
    }
}

/// The alerts ah's host sends (`server/push.ts observe`), worked out by the app from the
/// session lists it already has: for a build that can't receive the host's push (no APNs
/// capability), or a device that didn't register for it. A session that starts needing
/// you, or finishes after working; at most one alert per session every 30 seconds; and the
/// first look at a list alerts nothing.
struct AlertWatcher {
    enum Event: String, Equatable, Sendable { case waiting, done }

    struct Alert: Equatable, Sendable {
        /// Unique across hosts: "<origin>#<session key>".
        let id: String
        let event: Event
        let title: String
        let body: String
        /// Where the alert opens (`ah` payload: host and route).
        let host: String
        let uid: String
        /// One-tap Approve / Deny is safe (a plain permission prompt).
        let answerable: Bool
        /// The prompt it's about (the host's `askId`), sent back with Approve / Deny.
        var prompt: String? = nil
    }

    private var last: [String: SessionDTO.Status] = [:]
    private var primed: Set<String> = []
    private var sentAt: [String: Date] = [:]
    static let cooldown: TimeInterval = 30

    /// One host's session list, as it is now. `origin` names the host's sign-in;
    /// `agentName` turns an agent id into its name ("Claude Code").
    mutating func observe(origin: String, rows: [SessionRow], now: Date = Date(), agentName: (String) -> String = { $0 }) -> [Alert] {
        var alerts: [Alert] = []
        let firstLook = !primed.contains(origin)
        primed.insert(origin)
        for row in rows {
            let id = "\(origin)#\(row.key)"
            let previous = last[id]
            last[id] = row.dto.status
            guard !firstLook, let previous, previous != row.dto.status else { continue }
            let event: Event? = row.dto.status == .waiting ? .waiting : (row.dto.status == .attention && previous == .busy ? .done : nil)
            guard let event else { continue }
            if let sent = sentAt[id], now.timeIntervalSince(sent) < Self.cooldown { continue }
            sentAt[id] = now
            let title = row.title
            let detail = event == .waiting ? AskParts.line(row.dto.ask) : ""
            // What was said last, as the host's alerts have it (`server/push.ts`), not the tool it ran.
            let fallback = row.dto.limit ?? SessionActivityRules.lastSaid(row.dto.reply, max: 240) ?? row.dto.agent.map(agentName) ?? "Shell"
            alerts.append(Alert(
                id: id,
                event: event,
                title: event == .waiting ? "\(title) needs you" : row.dto.limit != nil ? "\(title) hit its usage limit" : "\(title) finished",
                body: "\(row.dto.project) · \(detail.isEmpty ? fallback : detail)",
                host: row.host,
                uid: row.uid,
                answerable: event == .waiting && row.dto.answerable,
                prompt: event == .waiting ? row.dto.askId : nil
            ))
        }
        return alerts
    }
}
