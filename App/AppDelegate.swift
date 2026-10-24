import UIKit
import UserNotifications

/// The process: shared storage, Keychain, the device key store and transport; every host
/// account; the menu bar's commands; APNs registration, notification actions and the badge.
/// Each window's navigation belongs to its `SceneDelegate`.
@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private(set) var app: AppModel!
    /// Set when the database can't open (disk full, protected data before first unlock).
    private(set) var startupError: String?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        do {
            let services = AppServices(
                database: try AppDatabase(),
                vault: CredentialVault(store: KeychainSecretStore()),
                keys: SecureEnclaveKeyStore(),
                transport: URLSessionTransport(),
                device: DeviceDescriptor(name: DeviceDescriptor.sanitizedName(UIDevice.current.model), client: DeviceDescriptor.newClientID()),
                allowLoopback: Self.allowLoopback)
            app = AppModel(services: services)
        } catch {
            startupError = error.localizedDescription
            return true
        }
        app.activateAll()
        let push = PushRegistrar.shared
        UNUserNotificationCenter.current().delegate = self
        push.installCategories()
        Task { await push.registerIfAuthorized() }
        observeBadge()
        return true
    }

    /// Loopback hosts are for the simulator against a local `ah` only.
    private static var allowLoopback: Bool {
        #if DEBUG && targetEnvironment(simulator)
        return true
        #else
        return false
        #endif
    }

    // MARK: Scenes

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    func application(_ application: UIApplication, didDiscardSceneSessions sceneSessions: Set<UISceneSession>) {
        guard let app else { return }
        for session in sceneSessions { try? app.services.scenes.remove(sceneID: session.persistentIdentifier) }
    }

    // MARK: Menu bar and ⌘-hold overlay

    override func buildMenu(with builder: any UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard builder.system == .main, let app else { return }
        builder.remove(menu: .format)
        builder.remove(menu: .toolbar)
        builder.insertChild(MenuCommands.palette(bindings: app.keyBindings), atStartOfMenu: .application)
        var previous = UIMenu.Identifier.view
        for menu in MenuCommands.menus(bindings: app.keyBindings) {
            builder.insertSibling(menu, afterMenu: previous)
            previous = menu.identifier
        }
    }

    // MARK: APNs

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        guard let app else { return }
        PushRegistrar.shared.didRegister(deviceToken, app: app)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: any Error) {
        PushRegistrar.shared.didFail(error)
    }

    /// Foreground: the session list already shows it, so only a banner for another session.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    /// A tap opens the session or review layer in the most recent window; Approve and Deny
    /// answer from the notification itself (both require the device unlocked).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let userInfo = response.notification.request.content.userInfo
        let action = response.actionIdentifier
        guard let payload = PushPayload(userInfo) else { return }
        await MainActor.run { self.route(payload, action: action) }
    }

    private func route(_ payload: PushPayload, action: String) {
        guard let app else { return }
        let account = app.accounts.first { $0.status == .signedIn && ($0.hostname == payload.link.host || $0.hub.hosts.contains { $0.name == payload.link.host }) } ?? app.accounts.first
        if action == PushRegistrar.approveAction || action == PushRegistrar.denyAction {
            guard let account, let key = payload.link.sessionKey(localHost: account.hostname) else { return }
            let approve = action == PushRegistrar.approveAction
            Task {
                do {
                    let uid = SessionKey(key)?.uid ?? key
                    try await account.hub.client(forKey: key).answer(uid, approve: approve)
                } catch {
                    // The session moved on (answered elsewhere, ended): opening it shows where it is.
                    SceneDelegate.open(payload.link, origin: account.origin)
                }
            }
            return
        }
        SceneDelegate.open(payload.link, origin: account?.origin)
    }

    // MARK: Badge

    /// The icon badge follows sessions waiting on you across hosts, live.
    private func observeBadge() {
        guard let app else { return }
        withObservationTracking {
            PushRegistrar.shared.updateBadge(app.badgeCount)
        } onChange: {
            Task { @MainActor [weak self] in self?.observeBadge() }
        }
    }
}
