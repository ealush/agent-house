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

    func installCategories() {
        let approve = UNNotificationAction(identifier: Self.approveAction, title: "Approve", options: [.authenticationRequired])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive, .authenticationRequired])
        let category = UNNotificationCategory(identifier: Self.approvalCategory, actions: [approve, deny], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: "An agent needs you", options: [.hiddenPreviewsShowTitle])
        UNUserNotificationCenter.current().setNotificationCategories([category])
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
        lastError = error.localizedDescription
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
