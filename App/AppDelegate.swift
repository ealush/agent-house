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
        AhType.applyToBars()
        // Dictation listens with the real microphone and this device's own speech.
        DictationModel.makeCapture = { VoiceCapture() }
        DictationModel.thisDeviceName = DeviceSpeech.thisDevice
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
            let model: AppModel = app
            DictationModel.wordsAsYouSpeak = { [weak model] in model?.preferences.wordsAsYouSpeak ?? true }
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
        LocalAlerts.watch(app)
        Sending.install(app)
        SessionActivities.install(app)
        app.didShowSessions = { [weak app] keys in
            guard let app else { return }
            Task { await AlertJanitor.sweep(app, seen: keys) }
        }
        // Signed in again (Face ID) or newly paired: that host gets this device's push again.
        app.didSignIn = { [weak app] account in
            guard let app else { return }
            Task { await PushRegistrar.shared.sync(app) }
            SessionActivities.signedIn(account)
        }
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

    /// While the app runs (`AlertRules`): nothing for the session you're looking at, Notification
    /// Center only while the app is in front (its own nudge says it), a banner otherwise.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let payload = PushPayload(notification.request.content.userInfo)
        return await MainActor.run {
            // An alert can land already answered (here or elsewhere): look again once it's in.
            if let app = self.app {
                Task {
                    try? await Task.sleep(for: .seconds(1))
                    await AlertJanitor.sweep(app)
                }
            }
            return self.presentation(of: payload)
        }
    }

    private func presentation(of payload: PushPayload?) -> UNNotificationPresentationOptions {
        let key = payload.flatMap { p in app.flatMap { AlertJanitor.session(p.link, in: $0)?.key } }
        let active = UIApplication.shared.connectedScenes.contains { $0.activationState == .foregroundActive }
        let onScreen = key.map { key in
            UIApplication.shared.connectedScenes.contains { scene in
                scene.activationState == .foregroundActive && ((scene.delegate as? SceneDelegate)?.model?.shows(key) ?? false)
            }
        } ?? false
        let decided = AlertRules.presentation(key: key, onScreen: onScreen, appActive: active)
        alertLog.debug("an alert arrived in front: \(String(describing: decided), privacy: .public)")
        switch decided {
        case .banner: return [.banner, .list, .sound]
        case .listOnly: return [.list]
        case .nothing: return []
        }
    }

    /// A tap opens the session or review layer in the most recent window; Approve, Deny and
    /// Reply answer from the notification itself (all require the device unlocked), against
    /// the host the alert came from and nowhere else (`NotificationResponses.plan`).
    /// UIKit finishes handling a response on the main thread (it refreshes the window's
    /// snapshot); the `async` form of this method completes on another thread and aborts.
    /// The handler is called once the answer has reached the host (or failed, with a note
    /// saying so): called at once, a suspended or just-launched app could be stopped before
    /// its request went out.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let payload = PushPayload(response.notification.request.content.userInfo)
        let action = response.actionIdentifier
        let reply = (response as? UNTextInputNotificationResponse)?.userText
        let id = NotificationClaims.id(response)
        Task { @MainActor in
            if let payload, NotificationClaims.claim(id) { await self.respond(payload, action: action, reply: reply) }
            completionHandler()
        }
    }

    private func respond(_ payload: PushPayload, action: String, reply: String?) async {
        guard let app else { return }
        let signedIn = app.accounts.filter { $0.status == .signedIn }
        let plan = NotificationResponses.plan(payload, action: action, reply: reply, accounts: signedIn.map { NotifiedAccount(origin: $0.origin, hostname: $0.hostname, peers: $0.hub.hosts.map(\.name)) })
        let account = { (origin: String) in signedIn.first { $0.origin == origin } }
        // An answer from the Lock Screen outlives the moment iOS gives a background app.
        let task = UIApplication.shared.beginBackgroundTask(withName: "Answering from a notification")
        defer { if task != .invalid { UIApplication.shared.endBackgroundTask(task) } }
        switch plan {
        case .nothing:
            return
        case .open(let link, let origin):
            SceneDelegate.open(link, origin: origin)
            if let draft = payload.draft, let key = origin.flatMap(account).flatMap({ link.sessionKey(localHost: $0.hostname) }) {
                SceneDelegate.draft(draft, into: key)
            }
        case .notSignedIn:
            if let note = NotificationResponses.failure(plan, error: nil, hostname: nil) { NotificationNotes.post(note, about: payload, draft: reply) }
        case .answer(let origin, let key, let approve, let prompt):
            guard let account = account(origin) else { return }
            do {
                try await account.hub.client(forKey: key).answer(SessionKey(key)?.uid ?? key, approve: approve, prompt: prompt)
                alertLog.debug("answered from a notification")
            } catch {
                let failure = NotificationResponses.failure(plan, error: APIError.wrap(error), hostname: account.hostname)
                alertLog.debug("answer from a notification failed: \(APIError.wrap(error).message, privacy: .public)")
                if let failure { NotificationNotes.post(failure, about: payload) }
            }
        case .reply(let origin, let key, let text):
            guard let account = account(origin) else { return }
            do {
                _ = try await account.hub.client(forKey: key).send(SessionKey(key)?.uid ?? key, text: text)
                SessionActivities.began(key: key, app: app)
            } catch {
                // Not delivered (ended, signed out, unreachable): a note that opens it with
                // the words in the box. Opening a window from the background isn't possible.
                if let failure = NotificationResponses.failure(plan, error: APIError.wrap(error), hostname: account.hostname) {
                    NotificationNotes.post(failure, about: payload, draft: text)
                }
                if UIApplication.shared.applicationState == .active {
                    SceneDelegate.open(payload.link, origin: account.origin)
                    SceneDelegate.draft(text, into: key)
                }
            }
        }
    }

    /// A host's quiet push (`event: resolved`): a session that alerted "needs you" no longer
    /// waits (answered on another device, moved on, ended). Its alert comes down, and the
    /// badge is counted again with the host's own number.
    /// (The completion-handler form, called on the main thread, as for responses above.)
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let app, let payload = PushPayload(userInfo) else { return completionHandler(.noData) }
        let signedIn = app.accounts.filter { $0.status == .signedIn }
        let found = NotificationResponses.account(for: payload.link, in: signedIn.map { NotifiedAccount(origin: $0.origin, hostname: $0.hostname, peers: $0.hub.hosts.map(\.name)) })
        if let found, let waiting = payload.waiting { badges.set(waiting, for: found.origin) }
        guard payload.event == "resolved" else { return completionHandler(.noData) }
        Task { @MainActor in
            await AlertJanitor.resolve(payload.link)
            self.updateBadge()
            completionHandler(.newData)
        }
    }

    // MARK: Badge

    /// Each signed-in host's count of sessions waiting on you: from its live list while the
    /// app follows it, else the last its push said.
    private var badges = BadgeLedger()

    private func updateBadge() {
        guard let app else { return }
        let signedIn = app.accounts.filter { $0.status == .signedIn }
        badges.keep(Set(signedIn.map(\.origin)))
        for account in signedIn where account.hub.phase == .live { badges.set(account.hub.inbox(narrow: false).badge, for: account.origin) }
        PushRegistrar.shared.updateBadge(badges.total)
    }

    /// The icon badge follows sessions waiting on you across hosts, live.
    private func observeBadge() {
        guard let app else { return }
        withObservationTracking {
            let count = app.badgeCount
            _ = app.accounts.map { $0.hub.phase }
            updateBadge()
            QuickActions.update(needsYou: max(count, badges.total), signedIn: app.accounts.contains { $0.status == .signedIn })
            // Fewer waiting: some "needs you" alert may be answered (here or elsewhere).
            Task { await AlertJanitor.sweep(app) }
        } onChange: {
            Task { @MainActor [weak self] in self?.observeBadge() }
        }
    }
}
