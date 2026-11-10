import OSLog
import UIKit
import UserNotifications

/// This device's APNs token and notification permission, and registering them with every
/// signed-in host (each sign-in owns its own registration; signing out drops it host-side).
@MainActor
@Observable
final class PushRegistrar {
    static let shared = PushRegistrar()

    private(set) var token: Data?
    private(set) var authorization: UNAuthorizationStatus = .notDetermined
    private(set) var lastError: String?

    /// Debug builds are signed with the development `aps-environment`; App Store and
    /// TestFlight builds with production. The host sends to the matching APNs gateway.
    nonisolated static var environment: String {
        #if DEBUG
        return "development"
        #else
        return "production"
        #endif
    }

    /// The approval category: Approve and Deny straight from the notification. Approve asks
    /// for the device to be unlocked (`.authenticationRequired`); neither opens the app.
    static let approvalCategory = "AH_APPROVAL"
    static let approveAction = "AH_APPROVE"
    static let denyAction = "AH_DENY"
    /// A finished session: Reply sends a follow-up without opening the app.
    static let replyCategory = "AH_REPLY"
    static let replyAction = "AH_REPLY_SEND"

    func installCategories() {
        let approve = UNNotificationAction(identifier: Self.approveAction, title: "Approve", options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "checkmark"))
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive, .authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "xmark"))
        // Alerts group by session (`thread-id`); a stack of them says how many more there are.
        let approval = UNNotificationCategory(identifier: Self.approvalCategory, actions: [approve, deny], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "An agent needs you", categorySummaryFormat: "%u more from this session", options: [.hiddenPreviewsShowTitle])
        let reply = UNTextInputNotificationAction(identifier: Self.replyAction, title: "Reply", options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Tell the agent what’s next")
        let finished = UNNotificationCategory(identifier: Self.replyCategory, actions: [reply], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "A session finished", categorySummaryFormat: "%u more from this session", options: [.hiddenPreviewsShowTitle])
        UNUserNotificationCenter.current().setNotificationCategories([approval, finished])
    }

    func refreshAuthorization() async {
        authorization = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Asks once; a refusal is respected and pointed at Settings from then on.
    func enable() async -> Bool {
        do {
            let granted = try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound, .timeSensitive])
            await refreshAuthorization()
            if granted { UIApplication.shared.registerForRemoteNotifications() }
            return granted
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func registerIfAuthorized() async {
        await refreshAuthorization()
        if authorization == .authorized || authorization == .provisional || authorization == .ephemeral {
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(_ token: Data, app: AppModel) {
        self.token = token
        lastError = nil
        Task { await sync(app) }
    }

    func didFail(_ error: any Error) {
        // A build signed without the Push Notifications capability (a free Personal Team
        // can't have it) is refused a device token: that's how this build is, not an error.
        if error.localizedDescription.contains("aps-environment") {
            pushUnavailable = true
        } else {
            lastError = error.localizedDescription
        }
    }

    /// This build can't receive the hosts' push; the app alerts on its own (`LocalAlerts`).
    private(set) var pushUnavailable = false

    static let unavailableNote = "This build can’t receive your hosts’ push notifications: it’s signed without the Push Notifications capability, which a Personal Team can’t add. Agent Hub notifies you itself while it’s running: on a Mac in the background, on an iPad beside another app, and for a short while after you leave it with a session at work."

    /// Sends this device's token and opt-ins to every signed-in host (or withdraws them).
    func sync(_ app: AppModel) async {
        guard let token else { return }
        let preferences = app.preferences.notifications
        let environment = Self.environment
        // Every host at once: one slow or unreachable host doesn't hold up the others.
        let registering = app.accounts.filter { $0.status == .signedIn }.map { account in
            Task { @MainActor in await NotificationSettings(api: account.api).register(token: token, environment: environment, preferences: preferences) }
        }
        for registration in registering { await registration.value }
    }

    /// The icon badge: sessions waiting on you, across hosts (never the unread count).
    func updateBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
    }
}

let alertLog = Logger(subsystem: "dev.ealush.ah.native", category: "alerts")

/// Keeps Notification Center honest while the app runs (`AlertRules`): "needs you" alerts for
/// sessions that stopped waiting, and alerts for sessions you've opened, are taken out.
@MainActor
enum AlertJanitor {
    /// The signed-in host an alert came from, and the session key it means there.
    static func session(_ link: DeepLink, in app: AppModel) -> (account: AccountSession, key: String)? {
        guard case .session = link else { return nil }
        let signedIn = app.accounts.filter { $0.status == .signedIn }
        let host = { () -> String? in if case .session(let host, _) = link { return host } else { return nil } }()
        guard let account = signedIn.first(where: { $0.hostname == host || $0.hub.hosts.contains { $0.name == host } }) ?? (signedIn.count == 1 ? signedIn.first : nil),
              let key = link.sessionKey(localHost: account.hostname) else { return nil }
        return (account, key)
    }

    /// Takes stale alerts out. `seen`: sessions a window just showed.
    static func sweep(_ app: AppModel, seen: Set<String> = []) async {
        let center = UNUserNotificationCenter.current()
        var delivered: [AlertRules.Delivered] = []
        for note in await center.deliveredNotifications() {
            guard let payload = PushPayload(note.request.content.userInfo) else { continue }
            let found = session(payload.link, in: app)
            delivered.append(.init(id: note.request.identifier, key: found?.key, event: payload.event, live: found?.account.hub.phase == .live))
        }
        guard !delivered.isEmpty else { return }
        var waiting: Set<String> = []
        for account in app.accounts where account.status == .signedIn {
            for row in account.hub.rows where row.dto.status == .waiting { waiting.insert(row.key) }
        }
        let stale = AlertRules.stale(delivered, waiting: waiting, seen: seen)
        alertLog.debug("\(delivered.count, privacy: .public) delivered, \(stale.count, privacy: .public) no longer apply")
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }
}

/// What a notification's `ah` payload names (`server/apns.ts`): where to go, and what for.
struct PushPayload: Equatable, Sendable {
    let link: DeepLink
    let event: String

    init?(_ userInfo: [AnyHashable: Any]) {
        guard let ah = userInfo["ah"] as? [String: Any], let route = ah["route"] as? String else { return nil }
        link = DeepLink(route: route, host: ah["host"] as? String)
        event = ah["event"] as? String ?? ""
    }
}

/// Alerts the app posts itself (`AlertWatcher`), shaped exactly like the host's push so taps,
/// Approve / Deny, Reply, grouping and clean-up treat them the same. Only while no window is
/// in front (a Mac app in the background, an iPad beside another app, the moments after
/// leaving) and only when this device gets no push from the hosts: never both.
@MainActor
enum LocalAlerts {
    private static var watcher = AlertWatcher()
    private static var background: UIBackgroundTaskIdentifier = .invalid

    /// Follows every signed-in host's session list for as long as the app runs.
    static func watch(_ app: AppModel) {
        let lists = withObservationTracking {
            app.accounts.filter { $0.status == .signedIn && $0.hub.phase == .live }.map { ($0, $0.hub.rows) }
        } onChange: {
            Task { @MainActor in watch(app) }
        }
        for (account, rows) in lists {
            let hub = account.hub
            let alerts = watcher.observe(origin: account.origin, rows: rows) { id in hub.presets(host: nil).first { $0.id == id }?.name ?? id }
            for alert in alerts {
                alertLog.debug("session \(alert.event.rawValue, privacy: .public): \(alert.id, privacy: .private)")
                post(alert, app: app)
            }
        }
        // Back in the background with nothing working: no reason to keep the app awake.
        if background != .invalid, !lists.contains(where: { $0.1.contains { $0.dto.status == .busy } }) { endBackground() }
    }

    private static func post(_ alert: AlertWatcher.Alert, app: AppModel) {
        let prefs = app.preferences.notifications
        guard prefs.enabled, alert.event == .waiting ? prefs.needsYou : prefs.finished else { return }
        // The host's push carries it already.
        guard PushRegistrar.shared.token == nil else { return }
        guard !UIApplication.shared.connectedScenes.contains(where: { $0.activationState == .foregroundActive }) else {
            alertLog.debug("not posted: a window is in front")
            return
        }
        alertLog.debug("posting it")
        let content = UNMutableNotificationContent()
        if prefs.privatePreview {
            content.title = alert.event == .waiting ? "A session needs you" : "A session finished"
        } else {
            content.title = alert.title
            content.body = alert.body
        }
        content.sound = .default
        content.threadIdentifier = alert.uid
        content.categoryIdentifier = alert.event == .waiting ? (alert.answerable ? PushRegistrar.approvalCategory : "") : PushRegistrar.replyCategory
        content.userInfo = ["ah": ["v": 1, "host": alert.host, "route": alert.uid, "event": alert.event.rawValue]]
        // One per session, the newest replacing the last (the host's apns-collapse-id).
        let request = UNNotificationRequest(identifier: "ah.local.\(alert.id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request) { _ in }
    }

    /// Leaving the app with a session at work: ask for the time iOS allows, so its reply
    /// can still be told. Ends when nothing works any more, or when the time is up.
    static func keepWatching(_ app: AppModel) {
        alertLog.debug("left the app: token \(PushRegistrar.shared.token != nil, privacy: .public), enabled \(app.preferences.notifications.enabled, privacy: .public)")
        guard background == .invalid, PushRegistrar.shared.token == nil, app.preferences.notifications.enabled else { return }
        let working = app.accounts.contains { $0.status == .signedIn && $0.hub.rows.contains { $0.dto.status == .busy } }
        guard working else { return }
        background = UIApplication.shared.beginBackgroundTask(withName: "Watching sessions at work") { endBackground() }
        alertLog.debug("keeping watch in the background")
    }

    static func endBackground() {
        guard background != .invalid else { return }
        UIApplication.shared.endBackgroundTask(background)
        background = .invalid
    }
}
