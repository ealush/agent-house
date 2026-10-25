import UIKit

/// One window: its `SceneModel` (navigation, panes, presentation, keyboard), restored from
/// the GRDB journal by the scene's persistent identifier and reconciled with the hosts once
/// they answer; deep links and notification taps land here.
@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    static let activityType = "dev.ealush.ah.native.scene"

    var window: UIWindow?
    private(set) var model: SceneModel?
    private var root: SceneRootController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene, let delegate = UIApplication.shared.delegate as? AppDelegate else { return }
        #if targetEnvironment(macCatalyst)
        // A Mac window: content up into the title bar, and never so small the panes give up.
        windowScene.sizeRestrictions?.minimumSize = CGSize(width: 860, height: 560)
        if let titlebar = windowScene.titlebar {
            titlebar.titleVisibility = .hidden
            titlebar.toolbar = nil
        }
        #endif
        let window = KeyboardSensingWindow(windowScene: windowScene)
        self.window = window
        guard let app = delegate.app else {
            window.rootViewController = StartupFailureController(message: delegate.startupError ?? "Agent Hub couldn’t open its data.")
            window.makeKeyAndVisible()
            return
        }
        // The journal is keyed by the system's scene identifier; the activity only names it.
        let model = SceneModel(sceneID: session.persistentIdentifier, app: app)
        if let origin = (session.stateRestorationActivity ?? options.userActivities.first)?.userInfo?["origin"] as? String {
            model.useAccount(origin)
        }
        model.restore()
        model.clipboard = { UIPasteboard.general.string = $0 }
        self.model = model
        let root = SceneRootController(scene: model)
        self.root = root
        window.rootViewController = root
        window.onHardwareKey = { [weak model, weak root] event in
            if model?.hardwareKeyboard == false { model?.hardwareKeyboard = true }
            root?.sawKeys(event)
        }
        window.makeKeyAndVisible()
        windowScene.title = nil

        for context in options.urlContexts { handle(context.url) }
        if let activity = options.userActivities.first(where: { $0.activityType == Handoff.activityType }), let handoff = Handoff(userInfo: activity.userInfo ?? [:]) {
            model.continueHandoff(handoff)
        }
        if let link = (options.userActivities.first?.userInfo?["link"] as? String).flatMap(URL.init(string:)) { handle(link) }
        if let response = options.notificationResponse, let payload = PushPayload(response.notification.request.content.userInfo) {
            open(payload.link, origin: nil)
        }
        if let item = options.shortcutItem { _ = perform(item) }
    }

    /// A Home Screen quick action, chosen while the app was running or as it launched.
    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem) async -> Bool {
        perform(shortcutItem)
    }

    private func perform(_ item: UIApplicationShortcutItem) -> Bool {
        guard let action = QuickAction(rawValue: item.type), let model else { return false }
        model.perform(action.command)
        return true
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        model?.scheduleSave(now: true)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        model?.willEnterForeground()
        if let app = model?.app {
            app.resyncAll()
            Task { await PushRegistrar.shared.registerIfAuthorized() }
        }
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        model?.didEnterBackground()
    }

    /// The system keeps this with the scene session; GRDB holds the window's real state.
    func stateRestorationActivity(for scene: UIScene) -> NSUserActivity? {
        let activity = NSUserActivity(activityType: Self.activityType)
        var info: [String: Any] = ["sceneID": scene.session.persistentIdentifier]
        if let origin = model?.account?.origin { info["origin"] = origin }
        activity.userInfo = info
        return activity
    }

    /// Handoff from another of your devices into this window.
    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == Handoff.activityType, let handoff = Handoff(userInfo: userActivity.userInfo ?? [:]) else { return }
        model?.continueHandoff(handoff)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { handle(context.url) }
    }

    private func handle(_ url: URL) {
        guard let link = DeepLink(url: url) else { return }
        open(link, origin: nil)
    }

    /// Goes to a link in this window: picks the account that serves its host, then the place.
    func open(_ link: DeepLink, origin: String?) {
        guard let model else { return }
        let app = model.app
        if let origin { model.useAccount(origin) }
        else if let host = link.host, let account = app.accounts.first(where: { $0.hostname == host || $0.hub.hosts.contains { $0.name == host } }) {
            model.useAccount(account.origin)
        }
        switch link {
        case .session:
            if let key = link.sessionKey(localHost: model.hub?.hostname) { model.open(key) }
        case .review(_, let route):
            model.openReview(route)
        case .inbox:
            model.show(.inbox)
        }
    }

    /// Words that couldn't be sent from a notification, waiting in the session's composer.
    static func draft(_ text: String, into key: String) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let target = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        guard let session = (target?.delegate as? SceneDelegate)?.model?.session(key), session.composer.text.isEmpty else { return }
        session.composer.text = text
    }

    /// From the app delegate (a notification tap): the foreground window, else the most recent.
    static func open(_ link: DeepLink, origin: String?) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let target = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        if let delegate = target?.delegate as? SceneDelegate {
            delegate.open(link, origin: origin)
        } else {
            // No window yet: ask for one; it opens the link once connected.
            let activity = NSUserActivity(activityType: activityType)
            var info: [String: Any] = ["link": link.url.absoluteString]
            if let origin { info["origin"] = origin }
            activity.userInfo = info
            UIApplication.shared.requestSceneSessionActivation(nil, userActivity: activity, options: nil) { _ in }
        }
    }
}

/// Shown only when local storage can't open: what happened, and that hosts are untouched.
private final class StartupFailureController: UIViewController {
    let message: String
    init(message: String) {
        self.message = message
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        var config = UIContentUnavailableConfiguration.empty()
        config.image = UIImage(systemName: "externaldrive.badge.exclamationmark")
        config.text = "Agent Hub couldn’t start"
        config.secondaryText = "\(message)\n\nYour hosts and their sessions are unaffected. Try again after unlocking the device, or free some storage."
        contentUnavailableConfiguration = config
    }
}

/// Notices a hardware keyboard by its first key press, and shows the root every key event
/// (which-key needs the releases a focused terminal or text field keeps). `GCKeyboard` can report one late, or
/// not at all for a keyboard the system forwards (a Mac's, in the Simulator), and the window
/// should move keyboard focus with navigation from the first key on.
final class KeyboardSensingWindow: UIWindow {
    /// Every event carrying a hardware key, before any responder sees it.
    var onHardwareKey: ((UIPressesEvent) -> Void)?

    override func sendEvent(_ event: UIEvent) {
        if let presses = event as? UIPressesEvent, presses.allPresses.contains(where: { $0.key != nil }) {
            onHardwareKey?(presses)
        }
        super.sendEvent(event)
    }
}
