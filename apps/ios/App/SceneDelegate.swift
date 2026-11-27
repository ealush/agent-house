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
            window.rootViewController = StartupFailureController(message: delegate.startupError ?? "Agent House couldn’t open its data.")
            window.makeKeyAndVisible()
            return
        }
        // The journal is keyed by the system's scene identifier; the activity only names it.
        let model = SceneModel(sceneID: session.persistentIdentifier, app: app)
        if let origin = (session.stateRestorationActivity ?? options.userActivities.first)?.userInfo?["origin"] as? String {
            model.useAccount(origin)
        }
        // Opened on a place ("Open in New Window"): that place, not a copy of the window it came
        // from, whose journal is the newest one there is.
        model.restore(copyingNewest: options.userActivities.first?.userInfo?["newWindow"] == nil)
        model.clipboard = { UIPasteboard.general.string = $0 }
        model.pasteboard = { UIPasteboard.general.string }
        model.share = { [weak window] url in Self.share(url, from: window) }
        if UIApplication.shared.supportsMultipleScenes {
            model.openWindow = { link, origin in Self.newWindow(link, origin: origin) }
        }
        self.model = model
        let root = SceneRootController(scene: model)
        self.root = root
        window.rootViewController = root
        window.onHardwareKey = { [weak model, weak root] event in
            if model?.hardwareKeyboard == false { model?.hardwareKeyboard = true }
            root?.sawKeys(event)
        }
        window.makeKeyAndVisible()
        followTitle(windowScene)

        for context in options.urlContexts { handle(context.url) }
        if let activity = options.userActivities.first(where: { $0.activityType == Handoff.activityType }), let handoff = Handoff(userInfo: activity.userInfo ?? [:]) {
            model.continueHandoff(handoff)
        }
        if let link = (options.userActivities.first?.userInfo?["link"] as? String).flatMap(URL.init(string:)) { handle(link) }
        // A tap that opened the app (an action never opens a window); the app delegate hears
        // the same response and leaves it to this window.
        if let response = options.notificationResponse, response.actionIdentifier == NotificationResponses.defaultAction,
           let payload = PushPayload(response.notification.request.content.userInfo), NotificationClaims.claim(NotificationClaims.id(response)) {
            open(payload.link, origin: nil)
            if let draft = payload.draft, let key = payload.link.sessionKey(localHost: model.account?.hostname) { Self.draft(draft, into: key) }
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

    /// Keeps the window named after what it shows.
    private func followTitle(_ windowScene: UIWindowScene) {
        guard let model else { return }
        withObservationTracking {
            windowScene.title = model.windowTitle
        } onChange: {
            Task { @MainActor [weak self, weak windowScene] in
                guard let windowScene else { return }
                self?.followTitle(windowScene)
            }
        }
    }

    func sceneDidDisconnect(_ scene: UIScene) {
        model?.notes.flush()
        model?.scheduleSave(now: true)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        model?.willEnterForeground()
        LocalAlerts.endBackground()
        if let app = model?.app {
            app.wakeAll()
            Task { await PushRegistrar.shared.registerIfAuthorized() }
        }
    }

    /// Away from the front, the system's notifications tell what changes, not the window's nudges.
    func sceneWillResignActive(_ scene: UIScene) {
        model?.leftFront()
    }

    /// Back in front: nudges held meanwhile show, unless a notification already told them;
    /// alerts for the sessions on screen are read, and "needs you" alerts answered meanwhile
    /// (on another device) go.
    func sceneDidBecomeActive(_ scene: UIScene) {
        ClientLog.shared.event("app", ["phase": .string("active")])
        guard let model else { return }
        var shown = Set(model.workspace.visibleKeys)
        if case .session(let key) = model.route { shown.insert(key) }
        let away = model.awaySince
        Task {
            if let away {
                let told = await AlertJanitor.told(since: away, origin: model.account?.origin, in: model.app)
                model.backInFront(since: away, told: told)
            }
            await AlertJanitor.sweep(model.app, seen: shown)
        }
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        ClientLog.shared.event("app", ["phase": .string("background")])
        if let leaving = model?.didEnterBackground() {
            // The time to finish: a draft typed just before leaving is saved to the host, not
            // cut off when the app is suspended mid-request.
            let held = Held()
            held.task = UIApplication.shared.beginBackgroundTask(withName: "Saving drafts") { held.end() }
            Task { @MainActor in
                await leaving.value
                held.end()
            }
        }
        if let app = model?.app { LocalAlerts.keepWatching(app) }
    }

    /// One stretch of background time, given back once.
    private final class Held: @unchecked Sendable {
        var task = UIBackgroundTaskIdentifier.invalid

        @MainActor func end() {
            guard task != .invalid else { return }
            UIApplication.shared.endBackgroundTask(task)
            task = .invalid
        }
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

    /// An `agenthub:` link (the web app's "Open in Agent House", another window's, a shortcut's)
    /// or one of your hosts' web links.
    private func handle(_ url: URL) {
        guard let link = AppLink(url: url) else { return }
        model?.follow(link)
    }

    /// Goes to a link in this window: picks the account that serves its host, then the place.
    func open(_ link: DeepLink, origin: String?) {
        guard let model else { return }
        let app = model.app
        if let origin { model.useAccount(origin) }
        else if let host = link.host, let account = app.accounts.first(where: { $0.hostname == host || $0.hub.hosts.contains { $0.name == host } }) {
            model.useAccount(account.origin)
        }
        // Through `go`: a notification that launched the app waits for the window's own state.
        // The account's name for its host, which it keeps: the hub's is only known once its
        // state has come, and a notification that launched the app came before it, so its own
        // sessions read as "host/uid", a session on no host (ended, nothing to answer).
        switch link {
        case .session:
            if let key = link.sessionKey(localHost: model.account?.hostname) { model.go(Place(.session(key))) }
        case .review(_, let route):
            model.go(Place(.review(route)))
        case .inbox:
            model.go(Place(.inbox))
        }
    }

    /// Words that couldn't be sent from a notification, waiting in the session's composer.
    static func draft(_ text: String, into key: String) {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let target = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        guard let session = (target?.delegate as? SceneDelegate)?.model?.session(key), session.composer.text.isEmpty else { return }
        session.composer.text = text
    }

    /// The share sheet for a link, over whatever this window shows (a popover from its top
    /// edge on an iPad).
    private static func share(_ url: URL, from window: UIWindow?) {
        guard var top = window?.rootViewController else { return }
        while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.maxX - 60, y: top.view.safeAreaInsets.top + 8, width: 1, height: 1)
            popover.permittedArrowDirections = .up
        }
        top.present(sheet, animated: true)
    }

    /// Another window, opening at `link` (or wherever a new window starts) on `origin`'s host.
    static func newWindow(_ link: DeepLink?, origin: String?) {
        let activity = NSUserActivity(activityType: activityType)
        var info: [String: Any] = ["newWindow": true]
        if let link { info["link"] = link.url.absoluteString }
        if let origin { info["origin"] = origin }
        activity.userInfo = info
        let options = UIWindowScene.ActivationRequestOptions()
        options.preferredPresentationStyle = .standard
        UIApplication.shared.requestSceneSessionActivation(nil, userActivity: activity, options: options) { _ in }
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
        config.text = "Agent House couldn’t start"
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
