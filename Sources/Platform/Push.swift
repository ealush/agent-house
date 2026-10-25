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
        let approval = UNNotificationCategory(identifier: Self.approvalCategory, actions: [approve, deny], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "An agent needs you", options: [.hiddenPreviewsShowTitle])
        let reply = UNTextInputNotificationAction(identifier: Self.replyAction, title: "Reply", options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"),
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Tell the agent what’s next")
        let finished = UNNotificationCategory(identifier: Self.replyCategory, actions: [reply], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "A session finished", options: [.hiddenPreviewsShowTitle])
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
        lastError = Self.explain(error)
    }

    /// A build signed without the Push Notifications capability (a free Personal Team can't
    /// have it) is refused a device token: say what that means rather than the system's text.
    nonisolated static func explain(_ error: any Error) -> String {
        let text = error.localizedDescription
        guard text.contains("aps-environment") else { return text }
        return "This build can’t receive notifications from your hosts: it’s signed without the Push Notifications capability, which a Personal Team can’t add. While Agent Hub is open, it still tells you when a session needs you."
    }

    /// Sends this device's token and opt-ins to every signed-in host (or withdraws them).
    func sync(_ app: AppModel) async {
        guard let token else { return }
        for account in app.accounts where account.status == .signedIn {
            await NotificationSettings(api: account.api).register(token: token, environment: Self.environment, preferences: app.preferences.notifications)
        }
    }

    /// The icon badge: sessions waiting on you, across hosts (never the unread count).
    func updateBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
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
