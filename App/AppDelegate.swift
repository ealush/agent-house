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
            let ephemeral = Self.ephemeral
            let services = AppServices(
                database: try AppDatabase(directory: ephemeral ? FileManager.default.temporaryDirectory.appendingPathComponent("ah-ephemeral-\(UUID().uuidString)") : nil),
                vault: CredentialVault(store: ephemeral ? MemorySecretStore() : KeychainSecretStore()),
                keys: ephemeral ? MemoryDeviceKeyStore() : SecureEnclaveKeyStore(),
                transport: URLSessionTransport(),
                device: DeviceDescriptor(name: Self.deviceName, client: DeviceDescriptor.newClientID()),
                allowLoopback: Self.allowLoopback)
            app = AppModel(services: services)
        } catch {
            startupError = error.localizedDescription
            return true
        }
        app.activateAll()
        #if DEBUG
        DebugHooks.install(app: app)
        #endif
        let push = PushRegistrar.shared
        UNUserNotificationCenter.current().delegate = self
        push.installCategories()
        Task { await push.registerIfAuthorized() }
        observeBadge()
        return true
    }

    private static var deviceName: String {
        #if targetEnvironment(macCatalyst)
        return DeviceDescriptor.macName(hostName: ProcessInfo.processInfo.hostName)
        #else
        return DeviceDescriptor.sanitizedName(UIDevice.current.model)
        #endif
    }

    /// Debug builds started with `AH_EPHEMERAL=1` keep everything for this run only: secrets
    /// and device keys in memory, a throwaway database. That's how a Mac build signed to run
    /// locally (no keychain entitlement) runs at all; a signed build uses the Keychain.
    private static var ephemeral: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["AH_EPHEMERAL"] == "1"
        #else
        return false
        #endif
    }

    /// Loopback hosts are for debug builds in the simulator or on a Mac, against a local `ah`.
    private static var allowLoopback: Bool {
        #if DEBUG && (targetEnvironment(simulator) || targetEnvironment(macCatalyst))
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
        if builder.menu(for: .newScene) != nil {
            builder.replace(menu: .newScene, with: MenuCommands.newWindow())
        }
        // ⌘, opens the app's own Settings, not the system Settings app's page for it.
        if builder.menu(for: .preferences) != nil {
            builder.replace(menu: .preferences, with: MenuCommands.settings())
        } else {
            builder.insertChild(MenuCommands.settings(), atStartOfMenu: .application)
        }
        builder.insertChild(MenuCommands.chordStarts(bindings: app.keyBindings), atEndOfMenu: .application)
        var previous = UIMenu.Identifier.view
        for menu in MenuCommands.menus(bindings: app.keyBindings) {
            builder.insertSibling(menu, afterMenu: previous)
            previous = menu.identifier
        }
    }

    @objc func newWindow(_ sender: Any?) {
        UIApplication.shared.requestSceneSessionActivation(nil, userActivity: nil, options: nil) { _ in }
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
    /// UIKit finishes handling a response on the main thread (it refreshes the window's
    /// snapshot); the `async` form of this method completes on another thread and aborts.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let payload = PushPayload(response.notification.request.content.userInfo)
        let action = response.actionIdentifier
        Task { @MainActor in
            if let payload { self.route(payload, action: action) }
            completionHandler()
        }
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
            let count = app.badgeCount
            PushRegistrar.shared.updateBadge(count)
            QuickActions.update(needsYou: count, signedIn: app.accounts.contains { $0.status == .signedIn })
        } onChange: {
            Task { @MainActor [weak self] in self?.observeBadge() }
        }
    }
}
