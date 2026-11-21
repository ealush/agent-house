import GameController
import SwiftUI
import UIKit

/// A window's theme: the device's appearance choice, with the host's Omarchy colors fetched
/// when that's the choice and refetched when the host's theme changes.
@MainActor
@Observable
final class ThemeModel {
    private(set) var omarchy: OmarchyTheme?
    @ObservationIgnored private var stamp: OmarchyStampDTO?
    @ObservationIgnored private var fetching: Task<Void, Never>?
    @ObservationIgnored private var failedAt: Date?

    func theme(_ appearance: DevicePreferences.Appearance) -> Theme { Theme.resolve(appearance, omarchy: omarchy) }

    func follow(_ hub: HubStore?, appearance: DevicePreferences.Appearance) {
        guard appearance == .omarchy, let hub else { return }
        let current = hub.hub.state?.omarchy
        // Once per change of the host's theme, and one at a time: asked on every pass while
        // the first answer was on its way (or after one failed), each pass sent another.
        guard current != stamp || (omarchy == nil && fetching == nil && failedAt.map { Date().timeIntervalSince($0) > 30 } ?? true) else { return }
        stamp = current
        fetching?.cancel()
        fetching = Task { [weak self] in
            let fetched = try? await hub.api.omarchyTheme()
            guard let self, !Task.isCancelled else { return }
            fetching = nil
            // A failed fetch keeps the colors there were.
            if let fetched { omarchy = fetched; failedAt = nil } else { failedAt = Date() }
        }
    }
}

/// Every hosted SwiftUI root gets the window's theme and tint.
struct Themed<Content: View>: View {
    let app: AppModel
    let theme: ThemeModel
    @ViewBuilder let content: Content

    var body: some View {
        let resolved = theme.theme(app.preferences.appearance)
        content
            .environment(\.theme, resolved)
            .tint(resolved.accent)
            // ah's face for every Text that doesn't name its own: unset, a row's title, a
            // reply's prose and an answer's choices drew in SF Pro beside Rubik subtitles.
            .font(.ah(.body))
    }
}

/// The root of a window. Chooses setup, sign-in or the app; presents every sheet and
/// floating panel from `SceneModel` state (one at a time, so they never fight); answers the
/// menu bar's key commands through the responder chain; and routes app-scope keys,
/// submaps and which-key while modifiers are held.
@MainActor
final class SceneRootController: UIViewController, UIAdaptivePresentationControllerDelegate {
    let scene: SceneModel
    let theme = ThemeModel()

    private enum Phase: Equatable { case setup, signIn(String), main(String) }
    private enum Modal: Equatable { case sheet(SceneModel.Sheet), palette, switcher, shortcuts }

    private var phase: Phase?
    private var content: UIViewController?
    private var overlay: UIHostingController<Themed<OverlayLayer>>?
    private var shownModal: Modal?
    private weak var modalController: UIViewController?
    private var whichKeyTask: Task<Void, Never>?
    private var advertised: Handoff?
    /// The theme last put on the window, and the window it went on.
    private var appliedTheme: Theme?
    private weak var themedWindow: UIWindow?

    init(scene: SceneModel) {
        self.scene = scene
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("SceneRootController is created in code") }

    func host<V: View>(_ view: V) -> UIHostingController<Themed<V>> {
        UIHostingController(rootView: Themed(app: scene.app, theme: theme) { view })
    }

    /// A modal's host, which says when it's gone (`ModalHost`).
    private func modalHost<V: View>(_ view: V) -> ModalHost<Themed<V>> {
        ModalHost(rootView: Themed(app: scene.app, theme: theme) { view })
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        // The overlay (toasts, nudges, which-key) is a window of its own over this one, once
        // there's a scene to put it in: inside this view, every sheet covered it, and a toast
        // a sheet asked for never showed.
        let targets = OverlayTargets()
        let overlay = host(OverlayLayer(scene: scene, targets: targets))
        overlay.view.backgroundColor = .clear
        overlayTargets = targets
        self.overlay = overlay
        scene.narrow = traitCollection.horizontalSizeClass == .compact
        registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (self: Self, _: UITraitCollection) in
            self.scene.narrow = self.traitCollection.horizontalSizeClass == .compact
        }
        // Navigation moves the keyboard focus only while a hardware keyboard is attached.
        scene.hardwareKeyboard = Self.hasHardwareKeyboard
        for name in [Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardsChanged), name: name, object: nil)
        }
    }

    @objc private func keyboardsChanged() {
        scene.hardwareKeyboard = Self.hasHardwareKeyboard
    }

    private static var hasHardwareKeyboard: Bool {
        #if DEBUG
        // UI tours on a simulator, which always has its Mac's keyboard: a phone in the hand has none.
        if ProcessInfo.processInfo.arguments.contains("-AHTouchOnly") { return false }
        #endif
        return GCKeyboard.coalesced != nil
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        installOverlayWindow()
        becomeFirstResponder()
        setNeedsUpdateProperties()
    }

    private var overlayTargets: OverlayTargets?
    private var overlayWindow: OverlayWindow?

    /// Over this scene's window, under the keyboard: it never takes the keyboard, and every
    /// touch not on one of its cards goes through to the window beneath.
    private func installOverlayWindow() {
        guard overlayWindow == nil, let windowScene = view.window?.windowScene, let overlay, let overlayTargets else { return }
        let window = OverlayWindow(windowScene: windowScene, targets: overlayTargets)
        window.windowLevel = (view.window?.windowLevel ?? .normal) + 1
        window.backgroundColor = .clear
        window.rootViewController = overlay
        window.isHidden = false
        overlayWindow = window
        syncOverlayWindow()
    }

    /// What a toast must clear at the bottom: the phone's tab bar while it shows, the
    /// composer while one does; a sheet's own bottom is the screen's.
    private func placeToasts() {
        let sheetUp = presentedViewController != nil
        if scene.sheetUp != sheetUp { scene.sheetUp = sheetUp }
        guard let window = view.window else { return }
        let top = children.lazy.compactMap { ($0 as? MainSplitController)?.visibleTabBarTop(in: window) }.first
        if scene.tabBarTop != top { scene.tabBarTop = top }
    }

    private func syncOverlayWindow() {
        guard let overlayWindow else { return }
        let appearance = scene.app.preferences.appearance
        overlayWindow.overrideUserInterfaceStyle = theme.theme(appearance).interfaceStyle
        overlayWindow.tintColor = theme.theme(appearance).uiAccent
    }

    // MARK: State → UIKit (iOS 26 observation tracking)

    override func updateProperties() {
        super.updateProperties()
        let next = currentPhase()
        if next != phase {
            phase = next
            install(controller(for: next))
            if case .main(let origin) = next {
                // Its host removed: over to the one left, its sessions closed with the old one.
                if let was = scene.accountOrigin, was != origin { scene.useAccount(origin) }
            } else {
                scene.closeAllSessions()
            }
        }
        // Sheets belong to the app; setup and sign-in are whole screens of their own.
        if case .main = next { syncModal(allowed: true) } else { syncModal(allowed: false) }
        let appearance = scene.app.preferences.appearance
        theme.follow(scene.hub, appearance: appearance)
        // Only when the theme changed: this pass runs on every tick of the host's state, and a
        // window's tint set again is passed down to every view in it.
        let current = theme.theme(appearance)
        if current != appliedTheme || view.window !== themedWindow {
            // A palette picked while the window shows (Settings → Appearance, or the host's
            // Omarchy theme changing) crosses over as one picture: SwiftUI's colors eased while
            // the bars, materials and tab bar cut.
            let changing = appliedTheme != nil && view.window != nil && view.window === themedWindow
            appliedTheme = current
            themedWindow = view.window
            let apply = { [self] in
                view.window?.overrideUserInterfaceStyle = current.interfaceStyle
                // UIKit's own controls (the tab bar's selection) take the theme's accent, not the asset's pink.
                view.window?.tintColor = current.uiAccent
                // What shows where nothing's drawn (around the keyboard's corners, under a terminal)
                // is the theme's ground, not the system's black.
                view.backgroundColor = current.uiBackground
            }
            if changing, let window = view.window {
                UIView.transition(with: window, duration: 0.3, options: [.transitionCrossDissolve, .allowUserInteraction], animations: apply)
            } else {
                apply()
            }
            syncOverlayWindow()
        }
        if !scene.toasts.isEmpty { placeToasts() }
        if case .main = next { scene.reconcileIfReady() }
        advertise(scene.handoff)
    }

    /// Handoff: this window's place, offered to your other devices (and, without the app,
    /// as the host's web page). Only the origin and the web hash travel.
    private func advertise(_ handoff: Handoff?) {
        guard handoff != advertised else { return }
        advertised = handoff
        guard let windowScene = view.window?.windowScene else { return }
        guard let handoff else {
            windowScene.userActivity?.invalidate()
            windowScene.userActivity = nil
            return
        }
        let activity = NSUserActivity(activityType: Handoff.activityType)
        activity.title = handoff.title
        activity.userInfo = handoff.userInfo
        activity.webpageURL = handoff.webpageURL
        activity.isEligibleForHandoff = true
        activity.isEligibleForSearch = false
        activity.isEligibleForPrediction = false
        windowScene.userActivity?.invalidate()
        windowScene.userActivity = activity
        activity.becomeCurrent()
    }

    private func currentPhase() -> Phase {
        guard let account = scene.account else { return .setup }
        if account.status == .signedIn { return .main(account.origin) }
        return .signIn(account.origin)
    }

    private func controller(for phase: Phase) -> UIViewController {
        switch phase {
        case .setup:
            return host(SetupView(app: scene.app) { [scene] session in scene.useAccount(session.origin) })
        case .signIn:
            guard let account = scene.account else { return UIViewController() }
            return host(SignInView(account: account, app: scene.app) { [scene] in
                Task {
                    await scene.app.pairAgain(account)
                    // With other hosts still here the window shows one of them: Setup comes up
                    // as a sheet instead of taking the window.
                    if !scene.app.accounts.isEmpty { scene.sheet = .setup }
                }
            })
        case .main:
            return MainSplitController(root: self)
        }
    }

    private func install(_ next: UIViewController) {
        let old = content
        addChild(next)
        next.view.frame = view.bounds
        next.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(next.view)
        next.didMove(toParent: self)
        content = next
        if let old {
            old.willMove(toParent: nil)
            UIView.transition(with: view, duration: 0.25, options: .transitionCrossDissolve) {
                old.view.removeFromSuperview()
            } completion: { _ in old.removeFromParent() }
        }
    }

    // MARK: Presentation

    private var wantedModal: Modal? {
        if let sheet = scene.sheet { return .sheet(sheet) }
        if scene.palette != nil { return .palette }
        if scene.switcher != nil { return .switcher }
        if scene.showingShortcuts { return .shortcuts }
        return nil
    }

    /// One modal at a time, from window state. The window hears when one covers it and when
    /// all are gone, so the keyboard goes back where it was (or where a command sent it).
    private func syncModal(allowed: Bool) {
        let wanted: Modal? = allowed ? wantedModal : nil
        guard wanted != shownModal else { return }
        shownModal = wanted
        if wanted != nil { scene.modalWillPresent() }
        let present = { [weak self] in
            guard let self else { return }
            guard let wanted, self.shownModal == wanted else {
                if self.shownModal == nil {
                    self.scene.modalDidDismiss()
                    // Read again once it's gone: a toast a palette command raised came while it
                    // was still going, took the sheet to be up, and sat on the composer.
                    self.placeToasts()
                }
                return
            }
            let controller = self.makeModal(wanted)
            // An alert reports from its buttons (it can't be swiped away), and its presentation
            // controller is its own.
            if !(controller is UIAlertController) { controller.presentationController?.delegate = self }
            (controller as? any ModalReporting)?.dismissed = { [weak self, weak controller] in
                guard let self, let controller else { return }
                self.modalGone(controller)
            }
            self.modalController = controller
            self.topPresenter().present(controller, animated: true)
        }
        if let current = modalController, current.presentingViewController != nil {
            modalController = nil
            current.dismiss(animated: true) { present() }
        } else {
            present()
        }
    }

    private func makeModal(_ modal: Modal) -> UIViewController {
        switch modal {
        // A confirmation is asked as iOS asks one: a system alert, which needs no anchor (it's
        // asked from swipes, menus and keys), reads at every text size, and keeps the safe
        // choice where the system puts it.
        case .sheet(.confirmTerminate(let key)) where scene.session(key) != nil:
            return terminateAlert(scene.session(key)!)
        case .sheet(.confirmPlan(let key, let plan)) where scene.session(key) != nil && confirmsAsAlert(plan):
            return planAlert(plan, session: scene.session(key)!)
        case .sheet(.noteDelete(let id)) where scene.notes.note(id) != nil:
            return noteDeleteAlert(id)
        case .sheet(let sheet):
            let controller = modalHost(SceneSheet(sheet: sheet, scene: scene))
            switch sheet {
            case .confirmTerminate, .confirmPlan:
                controller.modalPresentationStyle = .formSheet
                controller.sheetPresentationController?.detents = [.medium()]
            case .modelPicker, .effortPicker, .sessionMenu, .fork, .forks, .branch, .lineage:
                controller.modalPresentationStyle = .formSheet
                controller.sheetPresentationController?.detents = [.medium(), .large()]
                controller.sheetPresentationController?.prefersGrabberVisible = true
            case .settings, .worktrees:
                controller.modalPresentationStyle = .pageSheet
            case .setup:
                controller.modalPresentationStyle = .formSheet
                controller.isModalInPresentation = scene.app.accounts.isEmpty
            case .newSession, .sendTo, .continueIn, .scrollback, .draft, .noteSend, .noteSaveFile, .noteCompare:
                controller.modalPresentationStyle = .formSheet
                controller.sheetPresentationController?.detents = [.large()]
            case .noteProject, .noteDelete:
                controller.modalPresentationStyle = .formSheet
                controller.sheetPresentationController?.detents = [.medium(), .large()]
                controller.sheetPresentationController?.prefersGrabberVisible = true
            case .subagents:
                // On a wide window, pointing at the chip it came from, the size of what it lists;
                // on a phone (or a narrow window), a sheet that starts at half height.
                if !scene.narrow, let anchor = scene.subagentsAnchor, anchor.width > 0 {
                    controller.modalPresentationStyle = .popover
                    controller.preferredContentSize = CGSize(width: 420, height: 520)
                    if let popover = controller.popoverPresentationController {
                        popover.sourceView = view
                        popover.sourceRect = view.convert(anchor, from: nil)
                        popover.permittedArrowDirections = [.down, .up]
                    }
                } else {
                    controller.modalPresentationStyle = .formSheet
                    controller.sheetPresentationController?.detents = [.medium(), .large()]
                    controller.sheetPresentationController?.prefersGrabberVisible = true
                }
            }
            return controller
        case .palette:
            return floating(PaletteView(scene: scene)) { [scene] in scene.palette = nil }
        case .switcher:
            return floating(SwitcherView(scene: scene)) { [scene] in scene.switcher = nil }
        case .shortcuts:
            let controller = modalHost(ShortcutsView(scene: scene))
            controller.modalPresentationStyle = .formSheet
            return controller
        }
    }

    /// Deleting a note is for good on every device it syncs to: asked as iOS asks it.
    private func noteDeleteAlert(_ id: String) -> UIViewController {
        let title = scene.notes.summary(id)?.title ?? "this note"
        let synced = scene.notes.note(id)?.syncOrigin != nil
        let alert = UIAlertController(title: "Delete “\(title)”?", message: synced ? "It’s deleted on every device it syncs to. Files you saved from it stay." : "It’s only on this device, so it’s gone for good. Files you saved from it stay.", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self, weak alert] _ in self?.alertGone(alert) })
        alert.addAction(UIAlertAction(title: "Delete", style: .destructive) { [weak self, weak alert] _ in
            self?.alertGone(alert)
            self?.scene.deleteNote(id)
        })
        return alert
    }

    private func terminateAlert(_ session: SessionModel) -> UIViewController {
        var lines: [String] = []
        if session.working { lines.append("It’s in the middle of a turn.") }
        lines.append("Its process stops now. The conversation stays in History and can be resumed.")
        if session.row?.dto.terminal != nil { lines.append("Its attached terminal and anything running in it stop too.") }
        let alert = UIAlertController(title: "Terminate “\(session.title)”?", message: lines.joined(separator: " "), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self, weak alert] _ in self?.alertGone(alert) })
        alert.addAction(UIAlertAction(title: "Terminate", style: .destructive) { [weak self, weak alert, scene, key = session.key] _ in
            self?.alertGone(alert)
            Task { await scene.terminate(key) }
        })
        return alert
    }

    private func confirmsAsAlert(_ plan: LaunchState.Plan) -> Bool {
        switch plan {
        case .relaunch, .switchMode: return true
        default: return false
        }
    }

    private func planAlert(_ plan: LaunchState.Plan, session: SessionModel) -> UIViewController {
        let title: String, message: String, verb: String, dangerous: Bool
        switch plan {
        case .relaunch(_, let asked, let body, let off):
            title = asked
            message = off ? body + " Permission checks are off in the new session." : body
            verb = "Relaunch"
            dangerous = off
        case .switchMode(let id, _):
            title = "Turn Off Permission Checks?"
            message = "“\(session.launch.preset?.modes?.first { $0.id == id }?.name ?? id)” lets the agent run commands and edit files without asking."
            verb = "Turn Off Checks"
            dangerous = true
        default:
            preconditionFailure("only relaunches and mode switches are confirmed")
        }
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self, weak alert] _ in self?.alertGone(alert) })
        let go = UIAlertAction(title: verb, style: dangerous ? .destructive : .default) { [weak self, weak alert, scene] _ in
            self?.alertGone(alert)
            Task { await scene.runPlan(plan, on: session) }
        }
        alert.addAction(go)
        // Return relaunches; turning the checks off is never the default.
        if !dangerous { alert.preferredAction = go }
        return alert
    }

    /// An alert's button was pressed: the alert goes by itself, and the window's state follows.
    private func alertGone(_ alert: UIAlertController?) {
        if let alert { modalGone(alert) }
    }

    /// The palette and switcher: over everything, dimmed, a tap outside closes.
    private func floating<V: View>(_ view: V, close: @escaping () -> Void) -> UIViewController {
        let panel = FloatingPanel(close: close) { view }
        let controller = modalHost(panel)
        controller.view.backgroundColor = .clear
        controller.modalPresentationStyle = .overFullScreen
        controller.modalTransitionStyle = .crossDissolve
        return controller
    }

    private func topPresenter() -> UIViewController {
        var top: UIViewController = self
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }

    /// Swiped away: the state follows.
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        modalGone(presentationController.presentedViewController)
    }

    /// The modal on screen went, by a swipe or from inside (a sheet's Close is SwiftUI's
    /// `dismiss`, which UIKit doesn't report as it does a swipe): the window's state follows.
    /// Left as it was, the window still had the sheet up, and asking for it again was asking
    /// for what it already had: Settings, once closed with its ✕, wouldn't open until the app
    /// was quit. One the window put away itself isn't `modalController` any more.
    private func modalGone(_ controller: UIViewController) {
        guard controller === modalController else { return }
        modalController = nil
        switch shownModal {
        case .sheet: scene.sheet = nil
        case .palette: scene.palette = nil
        case .switcher: scene.switcher = nil
        case .shortcuts: scene.showingShortcuts = false
        case nil: break
        }
        shownModal = nil
        scene.modalDidDismiss()
        placeToasts()
    }

    // MARK: Keyboard

    override var canBecomeFirstResponder: Bool { true }
    /// UIKit hands the root the keyboard when the view that had it leaves the window, which
    /// a split view does to its whole column when a page's navigation stack goes (a page
    /// giving way to New session or a session): the box that had just taken the keyboard lost
    /// it a moment later. The scene asks for it back.
    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { scene.rootTookKeyboard() }
        return became
    }

    /// Every menu-bar and ⌘-hold command lands here through the responder chain.
    @objc func runKeyCommand(_ sender: UICommand) {
        guard let raw = sender.propertyList as? String else { return }
        Haptics.selection()
        scene.runMenuCommand(CommandID(rawValue: raw), chord: (sender as? UIKeyCommand).flatMap(Chord.init(keyCommand:)))
    }

    /// The first key of a two-key chord, from its hidden menu key command.
    @objc func startChord(_ sender: UIKeyCommand) {
        guard let lead = Chord(keyCommand: sender) else { return }
        scene.beginChord(lead)
    }

    /// Disabled (so the key passes on to the focused text box or terminal) unless the
    /// command is available and its chord means it where the keyboard is now.
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(runKeyCommand(_:)) {
            guard phase.map({ if case .main = $0 { return true } else { return false } }) == true,
                  let command = sender as? UICommand, let raw = command.propertyList as? String else { return false }
            let chord = (sender as? UIKeyCommand).flatMap(Chord.init(keyCommand:))
            return scene.allowsMenuCommand(CommandID(rawValue: raw), chord: chord)
        }
        if action == #selector(startChord(_:)) {
            guard case .main = phase, scene.pendingChord == nil, let command = sender as? UIKeyCommand, let lead = Chord(keyCommand: command) else { return false }
            return CommandMatcher.startsSequence(lead, scope: scene.keyScope, bindings: scene.app.keyBindings)
        }
        return super.canPerformAction(action, withSender: sender)
    }

    /// App-scope keys no focused responder took: submaps, workspace digits, Escape.
    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        guard case .main = phase, scene.keyScope == .app else { return super.pressesBegan(presses, with: event) }
        var rest = Set<UIPress>()
        for press in presses {
            guard let key = press.key else { rest.insert(press); continue }
            let keyPress = KeyPress(key)
            if keyPress.isModifierOnly || !scene.handle(keyPress, scope: .app) { rest.insert(press) }
        }
        if !rest.isEmpty { super.pressesBegan(rest, with: event) }
    }

    /// Every hardware key event in the window, seen before any responder (the terminal and
    /// text fields keep the presses they handle, releases included).
    ///
    /// Which-key: two or more modifiers pressed and then held still for a moment show what one
    /// more key does. Only a modifier going down arms it; any other key, or a modifier coming
    /// up, puts it away (after a chord the modifiers are often still held, and the legend
    /// would only get in the way).
    func sawKeys(_ event: UIPressesEvent) {
        let presses = event.allPresses.filter { $0.key != nil }
        // Esc cancels the sheet in front, wherever the keyboard is: with nothing in the sheet
        // focused, neither its Cancel button nor the scene would ever hear it.
        if scene.sheet != nil, scene.palette == nil, scene.switcher == nil,
           presses.contains(where: { $0.phase == .began && $0.key?.keyCode == .keyboardEscape && $0.key?.modifierFlags.intersection([.command, .control, .alternate, .shift]).isEmpty == true }) {
            scene.sheet = nil
        }
        let isModifier = { (press: UIPress) in KeyPress.modifierUsages.contains(press.key!.keyCode.rawValue) }
        let armed = presses.contains { $0.phase == .began && isModifier($0) } && !presses.contains { $0.phase == .began && !isModifier($0) }
        whichKeyTask?.cancel()
        if !scene.whichKey.isEmpty { scene.updateWhichKey(ctrl: false, alt: false, shift: false, meta: false) }
        guard armed else { return }
        var flags = event.modifierFlags
        for press in presses where press.phase == .ended || press.phase == .cancelled {
            flags.subtract(press.key!.modifierFlags)
        }
        let ctrl = flags.contains(.control), alt = flags.contains(.alternate), shift = flags.contains(.shift), meta = flags.contains(.command)
        guard [ctrl, alt, shift, meta].filter({ $0 }).count >= 2 else { return }
        whichKeyTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            self?.scene.updateWhichKey(ctrl: ctrl, alt: alt, shift: shift, meta: meta)
        }
    }
}

/// The overlay's window: touches go through to the app's window everywhere the overlay has
/// nothing to touch. Most SwiftUI content (a plain button's glyph, a card's drag) has no view
/// of its own: UIKit's hit test lands on the hosting view there as it does on empty overlay,
/// so the overlay says where its touchable things are.
private final class OverlayWindow: UIWindow {
    private let targets: OverlayTargets

    init(windowScene: UIWindowScene, targets: OverlayTargets) {
        self.targets = targets
        super.init(windowScene: windowScene)
    }

    required init?(coder: NSCoder) { fatalError() }

    /// The keyboard stays with the app's window beneath.
    override var canBecomeKey: Bool { false }

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        guard let hit = super.hitTest(point, with: event), hit !== self,
              let hosted = rootViewController?.view, hit.isDescendant(of: hosted) else { return nil }
        // A view of the overlay's own (a control UIKit draws) takes it; the hosting view only
        // where a card is.
        guard hit === hosted else { return hit }
        return targets.contains(convert(point, to: hosted)) ? hit : nil
    }
}

/// Dimmed backdrop and a panel near the top, like Spotlight.
struct FloatingPanel<Content: View>: View {
    let close: () -> Void
    @ViewBuilder let content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        ZStack(alignment: .top) {
            Color.black.opacity(0.25).ignoresSafeArea().onTapGesture(perform: close).accessibilityHidden(true)
            // The panel settles into place as the dim fades in, as Spotlight's does, rather
            // than only dissolving with it.
            content
                .padding(.top, 70)
                .scaleEffect(shown || reduceMotion ? 1 : 0.96, anchor: .top)
                .offset(y: shown || reduceMotion ? 0 : -8)
        }
        .onAppear {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { shown = true }
        }
    }
}

extension Chord {
    /// The chord a fired `UIKeyCommand` stands for (the inverse of `keyCommandInput`).
    init?(keyCommand: UIKeyCommand) {
        guard let input = keyCommand.input else { return nil }
        let named: [String: String] = [
            UIKeyCommand.inputUpArrow: "ArrowUp", UIKeyCommand.inputDownArrow: "ArrowDown", UIKeyCommand.inputLeftArrow: "ArrowLeft",
            UIKeyCommand.inputRightArrow: "ArrowRight", UIKeyCommand.inputEscape: "Escape", UIKeyCommand.inputEnd: "End",
            UIKeyCommand.inputHome: "Home", UIKeyCommand.inputPageUp: "PageUp", UIKeyCommand.inputPageDown: "PageDown",
            "\r": "Enter", "\u{8}": "Backspace", "\t": "Tab",
        ]
        let flags = keyCommand.modifierFlags
        self.init(named[input] ?? input, meta: flags.contains(.command), ctrl: flags.contains(.control), alt: flags.contains(.alternate), shift: flags.contains(.shift))
    }
}

// MARK: Split and tabs

/// iPad: sidebar beside the detail (panes, one session, or a page). Compact width (iPhone,
/// narrow Stage Manager windows): a tab bar whose tabs push sessions. Both read the same
/// `SceneModel`, so rotating or resizing keeps the place.
@MainActor
final class MainSplitController: UISplitViewController, UISplitViewControllerDelegate, UINavigationControllerDelegate, UITabBarControllerDelegate {
    private unowned let root: SceneRootController
    private var scene: SceneModel { root.scene }
    private let tabBar = UITabBarController()
    private var navs: [String: UINavigationController] = [:]
    private var awaitingTransition = false
    private static let pages: [(id: String, title: String, symbol: String, route: SceneSnapshot.Route)] = [
        ("inbox", "Inbox", "tray", .inbox),
        ("review", "Review", "checkmark.rectangle.stack", .review(ReviewRoute())),
    ]

    init(root: SceneRootController) {
        self.root = root
        super.init(style: .doubleColumn)
        delegate = self
        preferredSplitBehavior = .tile
        // The sidebar draws its own floating glass panel over ah's ground (ah's design system).
        primaryBackgroundStyle = .none
        preferredPrimaryColumnWidthFraction = 0.28
        minimumPrimaryColumnWidth = 280
        maximumPrimaryColumnWidth = 380
        setViewController(root.host(SidebarView(scene: root.scene)), for: .primary)
        let detail = root.host(DetailView(scene: root.scene))
        setViewController(detail, for: .secondary)
        // Two tabs: the Inbox (its search holds every session and History) and Review.
        tabBar.tabs = Self.pages.map { page in
            UITab(title: page.title, image: UIImage(systemName: page.symbol), identifier: page.id) { [unowned self] _ in self.nav(for: page.id, route: page.route) }
        }
        tabBar.delegate = self
        tabBar.mode = .tabBar
        setViewController(tabBar, for: .compact)
    }

    required init?(coder: NSCoder) { fatalError() }

    private static func id(of tab: UITab?) -> String? { tab?.identifier }

    private func tab(_ id: String) -> UITab? { tabBar.tab(forIdentifier: id) }

    private func nav(for id: String, route: SceneSnapshot.Route) -> UINavigationController {
        if let existing = navs[id] { return existing }
        let page: UIViewController = id == "review"
            ? root.host(ReviewTab(scene: root.scene, route: route))
            : root.host(NavigationStack { PageView(scene: root.scene, route: route) })
        let nav = UINavigationController(rootViewController: page)
        nav.delegate = self
        nav.setNavigationBarHidden(true, animated: false)
        navs[id] = nav
        return nav
    }

    override func updateProperties() {
        super.updateProperties()
        preferredDisplayMode = scene.workspace.sidebarVisible ? .oneBesideSecondary : .secondaryOnly
        syncDetailBar()
        if let hub = scene.hub {
            let waiting = hub.rows.filter { $0.dto.status == .waiting }.count + hub.reviewAlerts.count
            tabBar.tab(forIdentifier: "inbox")?.badgeValue = waiting > 0 ? "\(waiting)" : nil
        }
        if scene.narrow { syncPhone() }
    }

    /// Sessions and panes bring their own headers; an empty bar above them only wastes
    /// height. Pages keep it for their titles and toolbars. Also run on layout: on restore the
    /// split view wraps the detail in its navigation controller after the first update.
    private func syncDetailBar() {
        // The sidebar's head is its own: no bar above the panel.
        if let nav = viewController(for: .primary)?.navigationController, !nav.isNavigationBarHidden {
            nav.setNavigationBarHidden(true, animated: false)
        }
        let showsSessions: Bool = {
            if scene.workspace.layout != nil { return true }
            if case .session = scene.route { return true }
            return false
        }()
        if let nav = viewController(for: .secondary)?.navigationController, nav.isNavigationBarHidden != showsSessions {
            nav.setNavigationBarHidden(showsSessions, animated: false)
        }
        // A session's header has its own sidebar button; the split's went into the first bar
        // it found below it, a side panel's, beside the panel's close. Pages keep it.
        let button: UISplitViewController.DisplayModeButtonVisibility = showsSessions ? .never : .automatic
        if displayModeButtonVisibility != button { displayModeButtonVisibility = button }
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        syncDetailBar()
    }

    /// The phone's tab bar's top in the window, while it's on screen (a pushed session hides it).
    func visibleTabBarTop(in window: UIWindow) -> Double? {
        guard isCollapsed || traitCollection.horizontalSizeClass == .compact else { return nil }
        let bar = tabBar.tabBar
        guard bar.window != nil, !bar.isHidden, bar.alpha > 0.01 else { return nil }
        let frame = bar.convert(bar.bounds, to: window)
        guard frame.minY < window.bounds.maxY - 1, frame.height > 0 else { return nil }
        return Double(frame.minY)
    }

    func splitViewController(_ svc: UISplitViewController, willHide column: UISplitViewController.Column) {
        if column == .primary, !scene.narrow, scene.workspace.sidebarVisible { scene.workspace.sidebarVisible = false }
    }

    func splitViewController(_ svc: UISplitViewController, willShow column: UISplitViewController.Column) {
        if column == .primary, !scene.narrow, !scene.workspace.sidebarVisible { scene.workspace.sidebarVisible = true }
    }

    // MARK: Phone

    private var routeTab: String? {
        switch scene.route {
        case .inbox, .settings, .worktrees: return "inbox"
        case .review: return "review"
        case .session: return nil
        }
    }

    private func syncPhone() {
        if let id = routeTab, Self.id(of: tabBar.selectedTab) != id, let tab = tab(id) {
            tabBar.selectedTab = tab
        }
        guard let id = Self.id(of: tabBar.selectedTab), let page = Self.pages.first(where: { $0.id == id }) else { return }
        let nav = nav(for: id, route: page.route)
        // UIKit holds a push back until a running transition (a sheet going away, another
        // push) ends, and the stack doesn't list it till then: pushing on every update meanwhile
        // stacked the same session several deep. Push once, when the stack is still.
        if let transition = nav.transitionCoordinator {
            guard !awaitingTransition else { return }
            awaitingTransition = true
            transition.animate(alongsideTransition: nil) { [weak self] _ in
                self?.awaitingTransition = false
                self?.setNeedsUpdateProperties()
            }
            return
        }
        if case .session(let key) = scene.route {
            if key == SceneModel.newSessionKey {
                // New session, pushed as a session is.
                if let top = nav.topViewController as? NewSessionHostController, top.count == scene.newSessionCount { return }
                let controller = NewSessionHostController(root: root, count: scene.newSessionCount)
                if nav.viewControllers.count > 1 {
                    nav.setViewControllers([nav.viewControllers[0], controller], animated: true)
                } else {
                    nav.pushViewController(controller, animated: true)
                }
                return
            }
            if NoteKey.isNote(key) {
                // A note, pushed as a session is: its own editor.
                if let top = nav.topViewController as? NoteHostController, top.key == key { return }
                let controller = NoteHostController(key: key, root: root)
                if nav.viewControllers.count > 1 {
                    nav.setViewControllers([nav.viewControllers[0], controller], animated: true)
                } else {
                    nav.pushViewController(controller, animated: true)
                }
                return
            }
            if let top = nav.topViewController as? SessionHostController, top.key == key { return }
            // Up from a subagent to a session already under it: back to it, as Back would.
            if let below = nav.viewControllers.dropLast().last(where: { ($0 as? SessionHostController)?.key == key }) {
                nav.popToViewController(below, animated: true)
                trailChanged(nav)
                return
            }
            guard let session = scene.session(key) else { return }
            let controller = SessionHostController(key: key, root: root, session: session)
            if SubagentKey.isSubagent(key), let from = scene.openedFrom[key],
               let below = nav.viewControllers.lastIndex(where: { ($0 as? SessionHostController)?.key == from }) {
                // A subagent over the session it was opened from (pushed, when that's on top), so
                // Back goes up to it; whatever was over that one makes way.
                nav.setViewControllers(Array(nav.viewControllers[...below]) + [controller], animated: true)
                trailChanged(nav)
                return
            }
            if nav.topViewController is NewSessionHostController {
                // The new session started: it takes New session's place, where it is, with
                // no push (the first message is already there as the conversation's).
                nav.setViewControllers([nav.viewControllers[0], controller], animated: false)
            } else if nav.viewControllers.count > 1 {
                nav.setViewControllers([nav.viewControllers[0], controller], animated: true)
            } else {
                nav.pushViewController(controller, animated: true)
            }
        } else if nav.viewControllers.count > 1 {
            nav.popToRootViewController(animated: true)
        }
        trailChanged(nav)
    }

    /// The sessions under the one on top (a parent under its subagent), kept open for Back.
    private func trailChanged(_ nav: UINavigationController) {
        let trail = nav.viewControllers.dropLast().compactMap { ($0 as? SessionHostController)?.key }
        if scene.phoneTrail != trail { scene.phoneTrail = trail }
    }

    /// The tab you're on, tapped again: back to its top, as every iOS tab does (UIKit pops a
    /// pushed page itself; a page's own list didn't scroll, SwiftUI's isn't the one UIKit looks for).
    func tabBarController(_ tabBarController: UITabBarController, shouldSelectTab tab: UITab) -> Bool {
        guard tab === tabBarController.selectedTab, let page = Self.pages.first(where: { $0.id == Self.id(of: tab) }) else { return true }
        let nav = nav(for: page.id, route: page.route)
        if nav.viewControllers.count == 1, let root = nav.viewControllers.first?.view, let list = Self.firstScrollView(in: root) {
            list.setContentOffset(CGPoint(x: list.contentOffset.x, y: -list.adjustedContentInset.top), animated: true)
        }
        return true
    }

    /// The first vertical scroller under a view, breadth first: a page's list.
    private static func firstScrollView(in view: UIView) -> UIScrollView? {
        var queue = [view]
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let scroll = next as? UIScrollView, scroll.isScrollEnabled, scroll.contentSize.height > scroll.bounds.height { return scroll }
            queue.append(contentsOf: next.subviews)
        }
        return nil
    }

    func tabBarController(_ tabBarController: UITabBarController, didSelectTab selectedTab: UITab, previousTab: UITab?) {
        guard let page = Self.pages.first(where: { $0.id == Self.id(of: selectedTab) }) else { return }
        let nav = nav(for: page.id, route: page.route)
        if let top = nav.topViewController as? SessionHostController {
            scene.open(top.key)
        } else if scene.route != scene.tabRoute(page.route) {
            scene.show(scene.tabRoute(page.route))
        }
    }

    func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
        navigationController.setNavigationBarHidden(viewController === navigationController.viewControllers.first, animated: animated)
    }

    /// Back (button or edge swipe) from a session.
    func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
        // Back from a subagent to the session under it: that one is where you are now.
        // Only one that was under a subagent: a session still landing from an earlier push isn't Back.
        if let shown = viewController as? SessionHostController, scene.phoneTrail.contains(shown.key), case .session(let key) = scene.route, key != shown.key {
            scene.open(shown.key)
        }
        trailChanged(navigationController)
        if viewController === navigationController.viewControllers.first, case .session = scene.route {
            scene.closeSession()
            if let id = Self.id(of: tabBar.selectedTab), let page = Self.pages.first(where: { $0.id == id }) { scene.show(scene.tabRoute(page.route)) }
        }
    }
}

/// A session pushed on a phone tab. Its bar is UIKit's own (title, subtitle and items set on
/// the navigation item), so it slides in and out with the push; a SwiftUI toolbar is only
/// filled in once the push has landed, and its buttons faded in late and vanished on Back.
@MainActor
final class SessionHostController: UIHostingController<Themed<SessionPage>> {
    let key: String
    private let session: SessionModel
    private unowned let scene: SceneModel
    private let theme: ThemeModel
    /// The one button in the bar: the terminal, the panels and search are the first row of
    /// its menu, three glyphs with their words, where as buttons of their own they took the
    /// title's room (which read "Composer chi…" with three of them beside it).
    private lazy var menuItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [
        UIDeferredMenuElement.uncached { [weak self] done in done((self?.quickActions() ?? []) + (self?.sessionActions() ?? [])) },
    ]))
    /// A dangerous permission mode in force, beside the menu: a red shield whose menu says what
    /// it means and switches to a safer mode (`PermissionShield` on the iPad).
    private lazy var shieldItem = UIBarButtonItem(image: UIImage(systemName: "exclamationmark.shield.fill"), menu: nil)
    /// Direct jump to this session's linked review (when one exists on the hub).
    private lazy var reviewItem = UIBarButtonItem(image: UIImage(systemName: "square.stack.3d.up"), primaryAction: UIAction { [weak self] _ in
        guard let self else { return }
        Haptics.selection()
        let branch = session.row?.dto.branch
        let project = session.row?.dto.project
        Task { @MainActor [weak self] in
            guard let self else { return }
            let opened = await scene.openReview(forSession: session.ref, branch: branch, project: project)
            if !opened, session.row?.dto.branch != nil { session.panel = .stack }
        }
    })

    init(key: String, root: SceneRootController, session: SessionModel) {
        self.key = key
        self.session = session
        self.scene = root.scene
        self.theme = root.theme
        super.init(rootView: Themed(app: root.scene.app, theme: root.theme) { SessionPage(session: session, scene: root.scene) })
        // The session's conversation and terminal stand on the keyboard by themselves (UIKit's
        // keyboard layout guide): left in SwiftUI's safe area too, the keyboard moved and shrank
        // the whole screen as well, and the box landed a keyboard's height above it.
        safeAreaRegions = .container
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal
        menuItem.accessibilityLabel = "Session menu"
        reviewItem.accessibilityLabel = "Open Review"
        // A session gets the whole screen: the composer and terminal sit where the tabs were.
        hidesBottomBarWhenPushed = true
        updateBar()
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    override func updateProperties() {
        super.updateProperties()
        updateBar()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        updateBar()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        navigationController?.navigationBar.overrideUserInterfaceStyle = .unspecified
    }

    /// What the bar says follows the session: its name, what it's doing and where, and the
    /// way to the other view.
    private func updateBar() {
        // Set only when they change: the bar lays itself out again for each one.
        if navigationItem.title != session.title { navigationItem.title = session.title }
        let subtitle = attributedSubtitle
        if navigationItem.attributedSubtitle != subtitle { navigationItem.attributedSubtitle = subtitle }
        let current = theme.theme(scene.app.preferences.appearance)
        let launch = session.launch
        let warning = session.isLive && !session.isShell ? launch.warning : nil
        if let warning {
            shieldItem.tintColor = current.uiDanger
            if shieldItem.menu?.title != warning {
                shieldItem.menu = UIMenu(title: warning, children: [
                    UIDeferredMenuElement.uncached { [weak self] done in done(self?.permissionActions() ?? []) },
                ])
            }
            shieldItem.accessibilityLabel = "Permissions, \(launch.mode?.name ?? "")"
            shieldItem.accessibilityHint = warning
        }
        let isLocalSession = session.row?.isLocal ?? session.history?.isLocal ?? false
        let reviewMatch = isLocalSession ? scene.hub?.reviewLink(for: session.ref, branch: session.row?.dto.branch, project: session.row?.dto.project ?? session.history?.dto.project) : nil
        if let reviewMatch {
            reviewItem.tintColor = reviewMatch.readyToMerge ? UIColor(current.done) : reviewMatch.needsYou > 0 || reviewMatch.status == "rereview" ? UIColor(current.brand) : UIColor(current.accent)
            reviewItem.accessibilityLabel = reviewMatch.label
        }
        var items: [UIBarButtonItem] = [menuItem]
        if reviewMatch != nil { items.append(reviewItem) }
        if warning != nil { items.append(shieldItem) }
        // The shield and review button join the menu's glass cleanly.
        if navigationItem.rightBarButtonItems != items { navigationItem.setRightBarButtonItems(items, animated: isViewLoaded && view.window != nil) }
        // The live terminal fills the screen under a see-through bar: over a dark one its title
        // and buttons go light.
        let overDarkTerminal = session.isLive && !(session.surface == .gui && session.hasGUI) && current.palette.terminal.isDark
        if isViewLoaded, view.window != nil {
            navigationController?.navigationBar.overrideUserInterfaceStyle = overDarkTerminal ? .dark : .unspecified
        }
    }

    /// What it's doing, in its status color (working, needs you, done) as on its row, then
    /// where: the word was the same grey as the folder after it.
    private var attributedSubtitle: AttributedString {
        if session.isSubagent {
            // Whose it is and how it's doing: the way up is Back (or the bar below the conversation).
            guard let node = session.subagentNode else { return AttributedString("Subagent") }
            let parent = session.subagents.tree.map { tree in node.parentRef == tree.root.ref ? tree.root.title : session.subagents.node(node.parentRef)?.name ?? tree.root.title } ?? ""
            return AttributedString(parent.isEmpty ? SubagentChip.word(node.state) : "\(SubagentChip.word(node.state)) · Subagent of \(parent)")
        }
        guard let row = session.row else { return AttributedString(session.isLive ? "" : "Ended") }
        var word = AttributedString(row.word.label)
        if let note = scene.connectionNote(session.key) {
            // Its status is as of the last word from the host: say that instead.
            word = AttributedString(note)
            word.uiKit.foregroundColor = theme.theme(scene.app.preferences.appearance).uiDanger
        } else if let color = theme.theme(scene.app.preferences.appearance).uiStatus(row.word) {
            word.uiKit.foregroundColor = color
        }
        // Where its conversation came from, when another agent handed it over: "↪ Claude Code".
        let origin = row.dto.continued.map { c in "↪\u{FE0E} " + (scene.hub?.presets(host: row.isLocal ? nil : row.host).first { $0.id == c.fromHarness }?.name ?? c.fromHarness) }
        let place = [row.dto.project, row.dto.branch, origin].compactMap { $0 }.filter { !$0.isEmpty }
        return place.isEmpty ? word : word + AttributedString(" · " + place.joined(separator: " · "))
    }

    /// The menu's first row, in the medium size (a glyph over its word): the other view of the
    /// session, Review (when applicable), and search; then its panels, where the composer's chips don't have them.
    private func quickActions() -> [UIMenuElement] {
        var row: [UIMenuElement] = []
        if session.isLive && session.hasGUI && !session.isShell {
            let other: SceneSnapshot.Surface = session.surface == .gui ? .terminal : .gui
            row.append(UIAction(title: other == .terminal ? "Agent Terminal" : "Messages", image: UIImage(systemName: other == .terminal ? "terminal" : "text.bubble")) { [weak self] _ in
                guard let self else { return }
                scene.setSurface(other, for: session.key)
            })
        }
        let isLocalSession = session.row?.isLocal ?? session.history?.isLocal ?? false
        let project = session.row?.dto.project ?? session.history?.dto.project
        if isLocalSession, (session.row?.dto.branch != nil || scene.hub?.reviewLink(for: session.ref, branch: session.row?.dto.branch, project: project) != nil), !session.isSubagent {
            let match = scene.hub?.reviewLink(for: session.ref, branch: session.row?.dto.branch, project: project)
            row.append(UIAction(title: match != nil ? "Open Review" : "Review", image: UIImage(systemName: "square.stack.3d.up")) { [weak self] _ in
                guard let self else { return }
                let branch = session.row?.dto.branch
                Task { [weak self] in
                    guard let self else { return }
                    let opened = await scene.openReview(forSession: session.ref, branch: branch, project: project)
                    if !opened, session.row?.dto.branch != nil { session.panel = .stack }
                }
            })
        }
        row.append(UIAction(title: "Search", image: UIImage(systemName: "magnifyingglass")) { [weak self] _ in self?.scene.perform("go-search") })
        let menu = UIMenu(options: .displayInline, children: row)
        menu.preferredElementSize = .medium
        // A live agent's conversation has its panels as a button among the composer's chips
        // (`ComposerFloat`). Anywhere else (a shell, the terminal, an ended session) they're a
        // section here: as a menu in this row they opened a second menu over this one, askew.
        let panels = panelActions()
        let onChips = ComposerFloat.hasTray(session) && session.surface == .gui && session.hasGUI
        guard !panels.isEmpty, !onChips else { return [menu] }
        return [menu, UIMenu(title: "Panels", options: .displayInline, children: panels)]
    }

    private func panelActions() -> [UIMenuElement] {
        // Only what this session has: no Diff or Stack without a branch, no Queue or Snapshots
        // in a shell.
        SceneSnapshot.Panel.allCases.filter { $0.applies(to: session) }.map { panel in
            UIAction(title: panel.title, subtitle: TerminalGlyph.subtitle(panel, session), image: TerminalGlyph.panelImage(panel, session), state: session.panel == panel ? .on : .off) { [weak self] _ in
                guard let self else { return }
                session.panel = session.panel == panel ? nil : panel
            }
        }
    }

    /// The shield's menu: each permission mode with what it lets the agent do, the one in
    /// force checked, and how a change applies.
    private func permissionActions() -> [UIMenuElement] {
        let launch = session.launch
        let modes = (launch.preset?.modes ?? []).map { mode in
            UIAction(title: mode.name, subtitle: mode.description, state: mode.id == launch.mode?.id ? .on : .off) { [weak self] _ in
                guard let self, mode.id != session.launch.mode?.id else { return }
                scene.applyPlan(session.planMode(mode.id), to: session)
            }
        }
        let footer = UIAction(title: launch.footer(.mode), attributes: .disabled) { _ in }
        return [UIMenu(options: .displayInline, children: modes), UIMenu(options: .displayInline, children: [footer])]
    }

    private func sessionActions() -> [UIMenuElement] {
        SessionAction.sections(session, scene).map { section in
            UIMenu(options: .displayInline, children: section.map { action in
                UIAction(title: action.title, subtitle: action.subtitle, image: TerminalGlyph.menuImage(action.symbol, active: action.active), attributes: action.destructive ? .destructive : []) { _ in action.run() }
            })
        }
    }
}

struct SessionPage: View {
    let session: SessionModel
    let scene: SceneModel

    var body: some View {
        SessionScreen(session: session, scene: scene, compactHeader: true, inNavigationBar: true)
    }
}

/// A modal that says when it's gone, however it went.
@MainActor
protocol ModalReporting: AnyObject {
    var dismissed: (() -> Void)? { get set }
}

/// The host of a modal the window shows (a sheet, the palette, the switcher, shortcuts).
final class ModalHost<Content: View>: UIHostingController<Content>, ModalReporting {
    var dismissed: (() -> Void)?

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        // Gone, not just covered by something it presented in turn.
        if isBeingDismissed || presentingViewController == nil { dismissed?() }
    }
}
