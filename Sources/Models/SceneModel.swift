import Foundation
import Observation

/// One window (UIKit scene): where it is, what it shows, what's presented over it, and how
/// every keyboard command applies here. Each iPad window has its own; they share the app's
/// accounts and live state, never their navigation.
@MainActor
@Observable
final class SceneModel {
    let sceneID: String
    let app: AppModel
    /// This window as other devices see it: one page per window, like a browser tab.
    let device: DeviceDescriptor
    let workspace = WorkspaceModel()

    private(set) var accountOrigin: String?
    var route: SceneSnapshot.Route = .inbox
    /// Compact width (iPhone, narrow Stage Manager): tabs and pushes instead of a sidebar and panes.
    var narrow = false
    var historyFilter = ""
    var search: SearchQuery?
    var sheet: Sheet?
    var palette: PaletteState?
    var switcher: SwitcherState?
    var showingShortcuts = false
    private(set) var focusRequest: FocusRequest?
    private(set) var toasts: [Toast] = []
    /// The newest which-key overlay, while modifiers are held.
    var whichKey: [CommandMatcher.WhichKeyRow] = []
    /// The first key of a two-key chord, waiting for the second.
    private(set) var pendingChord: Chord?
    /// Set by the platform layer.
    var clipboard: (String) -> Void = { _ in }
    /// Where the keyboard is now, set by the focused responder (a composer, a terminal). The
    /// menu's key commands match through it, so they never take a key that responder owns.
    @ObservationIgnored var keyScope: KeyScope = .app
    @ObservationIgnored var fieldState = FieldState()
    /// A hardware keyboard is attached (set by the platform). Navigation moves the keyboard
    /// focus only then: on touch alone, focusing a text box would raise the software keyboard.
    var hardwareKeyboard = false

    @ObservationIgnored private var sessions: [String: SessionModel] = [:]
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var toastID = 0
    @ObservationIgnored private var focusNonce = 0
    @ObservationIgnored private var restored = false
    @ObservationIgnored private var pendingRestore: SceneSnapshot?
    @ObservationIgnored private var panelDelta: Double = 0
    /// Where the keyboard is now (a composer or terminal), as the responders report it.
    @ObservationIgnored private(set) var currentFocus: FocusTarget?
    /// Per session, where the keyboard was last: its composer or its terminal.
    @ObservationIgnored private var focusMemory: [String: FocusTarget] = [:]
    @ObservationIgnored private var modalShown = false
    @ObservationIgnored private var focusBeforeModal: FocusTarget?
    @ObservationIgnored private var nonceAtModal = 0
    @ObservationIgnored private var deferredFocus: FocusTarget?
    @ObservationIgnored private var hoverQuietUntil = Date.distantPast
    @ObservationIgnored private var chordTimeout: Task<Void, Never>?

    init(sceneID: String, app: AppModel, client: String = DeviceDescriptor.newClientID()) {
        self.sceneID = sceneID
        self.app = app
        device = DeviceDescriptor(name: app.deviceName, client: client)
        accountOrigin = app.accounts.first?.origin
    }

    // MARK: Presentation

    enum Sheet: Equatable, Identifiable, Sendable {
        case setup
        case newSession(NewSessionContext)
        case fork(String)
        case sendTo(String)
        case branch(String)
        case worktrees
        case settings(String?)
        case confirmTerminate(String)
        case confirmPlan(key: String, plan: LaunchState.Plan)
        case scrollback(key: String, text: String)
        case modelPicker(String)
        case effortPicker(String)
        case sessionMenu(String)
        case continueIn(key: String, preset: String)

        var id: String {
            switch self {
            case .setup: return "setup"
            case .newSession: return "new"
            case .fork(let k): return "fork:\(k)"
            case .sendTo(let k): return "send:\(k)"
            case .branch(let k): return "branch:\(k)"
            case .worktrees: return "worktrees"
            case .settings(let s): return "settings:\(s ?? "")"
            case .confirmTerminate(let k): return "terminate:\(k)"
            case .confirmPlan(let k, _): return "plan:\(k)"
            case .scrollback(let k, _): return "scrollback:\(k)"
            case .modelPicker(let k): return "model:\(k)"
            case .effortPicker(let k): return "effort:\(k)"
            case .sessionMenu(let k): return "menu:\(k)"
            case .continueIn(let k, let p): return "continue:\(k):\(p)"
            }
        }
    }

    struct NewSessionContext: Equatable, Sendable {
        var project = false
        var cwd: String?
        var host: String?
        var prompt: String?
        var preset: String?
        /// Fill this chooser pane with what starts, instead of navigating.
        var intoPane: LayoutNode.Path?
    }

    struct PaletteState: Equatable, Sendable {
        /// Keys of the categories walked into.
        var path: [String] = []
        var query = ""
    }

    struct SwitcherState: Equatable, Sendable {
        var query = ""
        /// Open the pick as a new pane beside the focused one.
        var asTile = false
        /// Fill this chooser pane.
        var intoPane: LayoutNode.Path?
    }

    enum FocusTarget: Equatable, Sendable {
        case composer(String)
        case terminal(String)
        case ask(String)
        case sidebar
        case page
        case messages(String)
        case latest(String)
        case rename(String)
        /// An empty pane's session search.
        case chooser(LayoutNode.Path)

        /// The session this target is in, if any.
        var sessionKey: String? {
            switch self {
            case .composer(let k), .terminal(let k), .ask(let k), .messages(let k), .latest(let k), .rename(let k): return k
            case .sidebar, .page, .chooser: return nil
            }
        }
    }

    struct FocusRequest: Equatable, Sendable {
        let target: FocusTarget
        let nonce: Int
    }

    struct Toast: Equatable, Identifiable, Sendable {
        let id: Int
        let text: String
        let isError: Bool
    }

    /// Ask a responder to take the keyboard. While a sheet or the palette is up, the request
    /// waits and is delivered once it's gone, so nothing behind it steals the keyboard.
    func requestFocus(_ target: FocusTarget) {
        focusNonce += 1
        if modalShown {
            deferredFocus = target
        } else {
            focusRequest = FocusRequest(target: target, nonce: focusNonce)
        }
    }

    // MARK: Keyboard focus

    /// A composer or terminal took the keyboard. Its session remembers that spot, and its
    /// pane becomes the focused one, so the pane that looks focused is the one getting keys.
    func didFocus(_ target: FocusTarget) {
        currentFocus = target
        guard let key = target.sessionKey else { return }
        switch target {
        case .composer, .terminal: focusMemory[key] = target
        default: break
        }
        if let layout = workspace.layout, workspace.focusedKey != key, let leaf = layout.leaves().first(where: { $0.sessionKey == key }) {
            workspace.focus(leaf.path)
            scheduleSave()
        }
    }

    func didBlur(_ target: FocusTarget) {
        if currentFocus == target { currentFocus = nil }
    }

    /// Where the keyboard belongs in what the window shows: a chooser's search, the
    /// focused session's remembered spot (its composer in the GUI, else its terminal), or the page.
    var contentFocusTarget: FocusTarget {
        if workspace.chooserFocused, let path = workspace.focusPath { return .chooser(path) }
        let key: String? = {
            if let key = workspace.focusedKey { return key }
            if case .session(let key) = route { return key }
            return nil
        }()
        guard let key else { return .page }
        if let remembered = focusMemory[key] { return remembered }
        guard let model = session(key) else { return .composer(key) }
        return model.surface == .gui && model.hasGUI ? .composer(key) : .terminal(key)
    }

    /// Put the keyboard where it belongs now (with a hardware keyboard only).
    func focusContent() {
        guard hardwareKeyboard else { return }
        requestFocus(contentFocusTarget)
    }

    /// What decides where focus goes: the page, the panes and which one is focused, what's
    /// in it, the workspace and zoom.
    private struct FocusSpot: Equatable {
        let route: SceneSnapshot.Route
        let layout: LayoutNode?
        let path: LayoutNode.Path?
        let key: String?
        let workspace: Int
        let zoom: Bool
    }

    private var focusSpot: FocusSpot {
        FocusSpot(route: route, layout: workspace.layout, path: workspace.focusPath, key: workspace.focusedKey ?? workspace.selected, workspace: workspace.currentWorkspace, zoom: workspace.zoom)
    }

    /// Deliberate navigation carries the keyboard with it: run `change`; if the focused pane
    /// or what it shows changed and nothing asked for focus meanwhile, the keyboard goes to the
    /// new pane's spot. A layout change also quiets hover briefly, so a pane sliding under a
    /// still pointer doesn't take the focus.
    private func following(_ change: () -> Void) {
        let before = focusSpot
        let nonce = focusNonce
        change()
        let after = focusSpot
        guard after != before else { return }
        if after.layout != before.layout || after.zoom != before.zoom || after.workspace != before.workspace || after.route != before.route { suppressHover() }
        if focusNonce == nonce { focusContent() }
    }

    /// A pane was tapped or clicked: it's focused. If the tap didn't land in a text box or
    /// terminal of its own, the keyboard follows once the tap settles.
    func tapPane(_ path: LayoutNode.Path) async {
        guard workspace.layout?.node(at: path) != nil else { return }
        workspace.focus(path)
        scheduleSave()
        await Task.yield()
        if workspace.focusPath == path, currentFocus?.sessionKey != workspace.focusedKey || workspace.chooserFocused { focusContent() }
    }

    // MARK: Hover focus

    func suppressHover(for seconds: Double = 0.35, now: Date = Date()) {
        hoverQuietUntil = now.addingTimeInterval(seconds)
    }

    /// The pointer settled over a pane: with focus-follows-pointer on, it becomes the focused
    /// pane and takes the keyboard. Never while a divider or pane is dragged, a sheet, the
    /// palette or the scratchpad is over the panes, in pane or resize mode, while maximized,
    /// or just after the layout moved under a still pointer.
    @discardableResult
    func hoverFocus(_ path: LayoutNode.Path, now: Date = Date()) -> Bool {
        guard app.preferences.focusFollowsPointer, !modalShown, sheet == nil, palette == nil, switcher == nil, !showingShortcuts,
              !workspace.dragging, !workspace.scratchVisible, workspace.submap == nil, !workspace.zoom, now >= hoverQuietUntil,
              let layout = workspace.layout, layout.node(at: path) != nil, workspace.focusPath != path else { return false }
        following { workspace.focus(path) }
        scheduleSave()
        return true
    }

    // MARK: Presented over the window

    /// A sheet, the palette, the switcher or the shortcut table is about to cover the window.
    func modalWillPresent() {
        guard !modalShown else { return }
        modalShown = true
        focusBeforeModal = currentFocus
        nonceAtModal = focusNonce
    }

    /// Everything presented is gone: deliver focus asked for meanwhile, or put the keyboard
    /// back where it was.
    func modalDidDismiss() {
        guard modalShown else { return }
        modalShown = false
        let back = focusBeforeModal
        focusBeforeModal = nil
        if let deferred = deferredFocus {
            deferredFocus = nil
            focusNonce += 1
            focusRequest = FocusRequest(target: deferred, nonce: focusNonce)
        } else if focusNonce == nonceAtModal, let back {
            focusNonce += 1
            focusRequest = FocusRequest(target: back, nonce: focusNonce)
        }
    }

    func toast(_ text: String, error: Bool = false) {
        toastID += 1
        toasts.append(Toast(id: toastID, text: text, isError: error))
        if toasts.count > 4 { toasts.removeFirst(toasts.count - 4) }
    }

    func dismissToast(_ id: Int) { toasts.removeAll { $0.id == id } }

    // MARK: Accounts

    var account: AccountSession? { app.account(origin: accountOrigin) }
    var hub: HubStore? { account?.status == .signedIn ? account?.hub : nil }

    func useAccount(_ origin: String) {
        guard origin != accountOrigin else { return }
        closeAllSessions()
        accountOrigin = origin
        workspace.leaveSplit()
        route = .inbox
        scheduleSave()
    }

    // MARK: Sessions on screen

    /// The model for a session shown in this window, created (and connected) on first use.
    func session(_ key: String) -> SessionModel? {
        if let existing = sessions[key] { return existing }
        guard let hub, let account else { return nil }
        let surface = app.services.preferences.surface(origin: account.origin, sessionKey: key) ?? .gui
        let model = SessionModel(key: key, hub: hub, outbox: app.outbox, surface: surface)
        let cacheKey = "\(key)"
        model.feedCache = SessionModel.FeedCache(
            load: { [weak account] in account?.cached(SessionModel.FeedCache.Entry.self, kind: .feed, key: cacheKey) },
            store: { [weak account] entry in account?.cache(entry, kind: .feed, key: cacheKey) })
        sessions[key] = model
        Task { await model.open() }
        return model
    }

    var focusedSession: SessionModel? { workspace.focusedKey.flatMap(session) }

    /// Disconnect sessions no longer on screen (their streams and timers stop).
    func pruneSessions() {
        var keep = Set(workspace.visibleKeys)
        if case .session(let key) = route { keep.insert(key) }
        if let scratch = workspace.scratchKey, workspace.scratchVisible { keep.insert(scratch) }
        for (key, model) in sessions where !keep.contains(key) {
            model.close()
            sessions[key] = nil
        }
    }

    private func closeAllSessions() {
        for model in sessions.values { model.close() }
        sessions = [:]
    }

    func setSurface(_ surface: SceneSnapshot.Surface, for key: String) {
        guard let model = session(key) else { return }
        model.surface = surface
        if let origin = accountOrigin { try? app.services.preferences.setSurface(surface, origin: origin, sessionKey: key) }
        scheduleSave()
    }

    // MARK: Navigation

    var sidebarOrder: [SessionRow] {
        guard let hub else { return [] }
        return SessionOrdering.sidebarOrder(hub.rows, multiHost: hub.multiHost)
    }

    /// Open a session: in a split it replaces the focused pane, on a phone it pushes.
    func open(_ key: String) {
        following {
            workspace.open(key)
            if workspace.layout == nil { route = .session(key) }
        }
        if let hub, hub.row(key) != nil { Task { try? await hub.client(forKey: key).focus(key: key) } }
        pruneSessions()
        scheduleSave()
    }

    /// A page (Inbox, History, Review…): leaves the split.
    func show(_ page: SceneSnapshot.Route) {
        workspace.leaveSplit()
        route = page
        pruneSessions()
        scheduleSave()
    }

    /// Back from a session on a phone.
    func closeSession() {
        workspace.open(nil)
        if case .session = route { route = .inbox }
        pruneSessions()
        scheduleSave()
    }

    func openReview(_ target: ReviewRoute) { show(.review(target)) }

    /// On a phone, the stack the Review tab shows over its list (its root is always the
    /// list); going back returns to the list.
    var pushedReview: ReviewRoute? {
        get {
            guard narrow, case .review(let target) = route, target.stack != nil else { return nil }
            return target
        }
        set {
            if let newValue { openReview(newValue) } else if pushedReview != nil { show(.review(ReviewRoute())) }
        }
    }

    // MARK: Restoration

    func snapshot() -> SceneSnapshot {
        var placement: SceneSnapshot.SessionPlacement?
        let key: String? = {
            if case .session(let k) = route { return k }
            return workspace.focusedKey
        }()
        if let key, let model = sessions[key] {
            placement = SceneSnapshot.SessionPlacement(key: key, surface: model.surface, panel: model.panel, scroll: scrollAnchors[key], composerFocused: composerFocused == key)
        } else if let key {
            placement = SceneSnapshot.SessionPlacement(key: key, surface: .gui)
        }
        return SceneSnapshot(
            sceneID: sceneID, hostOrigin: accountOrigin, route: route, session: placement, workspaces: workspace.journalSpaces,
            focusedPane: workspace.focusPath, maximized: workspace.zoom, sidebarVisible: workspace.sidebarVisible,
            scratchpadVisible: workspace.scratchVisible, historyFilter: historyFilter, search: search
        )
    }

    /// Where each session's transcript was scrolled, reported by the view.
    var scrollAnchors: [String: SceneSnapshot.ScrollAnchor] = [:]
    /// The session whose composer has the keyboard, reported by the view.
    var composerFocused: String?

    /// Load this window's journal (or the newest window's, for a brand-new one) and apply it
    /// once the host's state arrives.
    func restore() {
        let journal = app.services.scenes
        let stored = (try? journal.load(sceneID: sceneID)) ?? (try? journal.mostRecent()).flatMap { latest -> SceneSnapshot? in
            var copy = latest
            copy.sceneID = sceneID
            return copy
        }
        guard let stored else {
            // With no host yet the window's root is setup itself; no sheet on top of it.
            restored = true
            return
        }
        if let origin = stored.hostOrigin, app.account(origin: origin) != nil { accountOrigin = origin }
        historyFilter = stored.historyFilter
        search = stored.search
        pendingRestore = stored
        reconcileIfReady()
    }

    /// Called whenever the host's state changes: applies a pending restore once there is state.
    func reconcileIfReady() {
        guard let pending = pendingRestore, let hub, hub.hub.state != nil else { return }
        pendingRestore = nil
        let outcome = RestorationReconciler.reconcile(pending) { hub.presence(of: $0) }
        let snapshot = outcome.snapshot
        route = snapshot.route
        workspace.restore(snapshot)
        if let placement = snapshot.session, let model = session(placement.key) {
            model.surface = placement.surface
            model.panel = placement.panel
            if let scroll = placement.scroll { scrollAnchors[placement.key] = scroll }
            if placement.composerFocused { requestFocus(.composer(placement.key)) }
        }
        for notice in outcome.notices { toast(notice) }
        restored = true
        pruneSessions()
    }

    var isRestored: Bool { restored }

    /// Write the journal soon (coalesces a burst of changes); `now` on backgrounding.
    func scheduleSave(now: Bool = false) {
        guard restored else { return }
        saveTask?.cancel()
        let snapshot = snapshot()
        let journal = app.services.scenes
        if now {
            try? journal.save(snapshot)
            return
        }
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            try? journal.save(snapshot)
        }
    }

    func didEnterBackground() {
        scheduleSave(now: true)
        hub?.saveCache(force: true)
        for model in sessions.values { Task { await model.background() } }
    }

    func willEnterForeground() {
        for model in sessions.values { Task { await model.foreground() } }
    }

    // MARK: Keyboard

    /// A hardware key press from wherever focus is. True when a command took it.
    func handle(_ press: KeyPress, scope: KeyScope, field: FieldState = FieldState()) -> Bool {
        if let lead = pendingChord, scope != .ask, let next = press.chord {
            finishChord(lead, next, scope: scope)
            return true
        }
        if workspace.submap != nil, scope != .ask {
            let digit = KeyPress.digits[press.hidUsage].flatMap(Int.init)
            following {
                switch workspace.submapKey(press.key ?? "", shift: press.modifiers.contains(.shift), alt: press.modifiers.contains(.option), digit: digit) {
                case .handled, .left: break
                case .run(let id): perform(id)
                case .present(let what): present(what)
                }
            }
            scheduleSave()
            return true
        }
        guard let chord = press.chord else { return false }
        if let id = CommandMatcher.match(chord, scope: scope, bindings: app.keyBindings, field: field), isAvailable(id) {
            perform(id)
            return true
        }
        if CommandMatcher.startsSequence(chord, scope: scope, bindings: app.keyBindings) {
            beginChord(chord)
            return true
        }
        return false
    }

    /// The first key of a two-key chord: wait (with a legend of what can follow) up to 2 s.
    func beginChord(_ lead: Chord) {
        pendingChord = lead
        whichKey = CommandMatcher.continuations(after: lead, active: isAvailable, bindings: app.keyBindings)
        chordTimeout?.cancel()
        chordTimeout = Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self, self.pendingChord == lead else { return }
            self.pendingChord = nil
            self.whichKey = []
        }
    }

    /// The second key: run what the pair means, or say it means nothing. Escape cancels.
    private func finishChord(_ lead: Chord, _ next: Chord, scope: KeyScope) {
        pendingChord = nil
        whichKey = []
        chordTimeout?.cancel()
        guard next.key != "Escape" else { return }
        if let id = CommandMatcher.completeSequence(lead, next, scope: scope, bindings: app.keyBindings), isAvailable(id) {
            perform(id)
        } else {
            toast("\(lead.followed(by: next).formatted()) isn’t a shortcut")
        }
    }

    /// A menu-bar key command fired. While a two-key chord waits, its key is the second key.
    func runMenuCommand(_ id: CommandID, chord: Chord?) {
        if let lead = pendingChord, let chord {
            finishChord(lead, chord, scope: keyScope)
            return
        }
        perform(id)
    }

    /// Held modifiers: what one more key does here (which-key).
    func updateWhichKey(ctrl: Bool, alt: Bool, shift: Bool, meta: Bool) {
        let modifiers = [ctrl, alt, shift, meta].filter { $0 }.count
        whichKey = modifiers >= 2 ? CommandMatcher.whichKey(ctrl: ctrl, alt: alt, shift: shift, meta: meta, active: isAvailable, bindings: app.keyBindings) : []
    }

    private func present(_ what: WorkspaceModel.Presentation) {
        switch what {
        case .openTileSwitcher: switcher = SwitcherState(asTile: true)
        case .newSession: sheet = .newSession(NewSessionContext())
        case .scratchpad: Task { await toggleScratchpad() }
        }
    }

    // MARK: Commands

    /// Whether a command can run right now in this window (the palette lists only these).
    func isAvailable(_ id: CommandID) -> Bool {
        guard hub != nil else { return ["go-settings", "show-shortcuts", "command-palette"].contains(id.rawValue) }
        let ws = workspace
        let s = focusedSession
        let row = s?.row
        let live = row != nil
        let agent = row?.dto.agent != nil
        let gui = s?.surface == .gui && (s?.hasGUI ?? false)
        if let n = id.workspaceNumber { return (1...9).contains(n) }
        if id.sendToWorkspaceNumber != nil { return ws.focusedKey != nil }
        switch id.rawValue {
        case "go-to-session", "workspace-next", "workspace-prev", "focus-follows-pointer": return true
        case "split-left", "split-above": return !narrow && (ws.focusedKey != nil || ws.chooserFocused)
        case "balance-panes", "focus-pane-next", "focus-pane-prev", "swap-pane-left", "swap-pane-right", "swap-pane-up", "swap-pane-down": return ws.splitOpen
        case "command-palette", "switcher", "new-session", "new-project", "cycle-prev", "cycle-next", "go-inbox", "go-history", "go-review",
             "go-search", "go-settings", "worktrees", "show-shortcuts", "reload-page", "focus-sidebar", "scratchpad":
            return true
        case "toggle-sidebar": return !narrow
        case "focus-main", "reply", "session-menu", "toggle-panel", "panel-files", "panel-chat", "panel-preview", "copy-attach": return s != nil
        case "focus-pane-left", "focus-pane-right", "focus-pane-up", "focus-pane-down", "move-pane-left", "move-pane-right", "move-pane-up", "move-pane-down", "toggle-split":
            return ws.splitOpen
        case "exit-split": return ws.layout != nil
        case "split-right", "split-below": return !narrow && (ws.focusedKey != nil || ws.chooserFocused)
        case "close-pane": return ws.layout != nil || ws.selected != nil
        case "replace-pane": return ws.focusedKey != nil
        case "open-in-pane": return !narrow && (ws.selected != nil || ws.layout != nil)
        case "resize-left", "resize-right", "resize-mode": return ws.selected != nil || ws.splitOpen
        case "resize-up", "resize-down": return ws.splitOpen
        case "pane-mode": return ws.selected != nil || ws.layout != nil
        case "maximize-pane": return ws.splitOpen && !narrow
        case "toggle-view": return live && (s?.hasGUI ?? false) && !(s?.isShell ?? true)
        case "toggle-steps", "copy-last", "jump-latest", "browse-messages": return gui
        case "approve", "deny": return row?.dto.answerable == true && row?.dto.status == .waiting
        case "interrupt": return row?.dto.status == .busy
        case "send-now": return !(s?.queue.items.isEmpty ?? true) || (row?.dto.queued ?? 0) > 0
        case "clear-queue": return (row?.dto.queued ?? 0) > 0 || !(s?.queue.items.isEmpty ?? true)
        case "pick-model", "pick-effort": return live && agent
        case "switch-branch", "panel-diff": return row?.dto.branch != nil
        case "rename", "pin", "terminate", "scrollback": return live
        case "fork": return agent || s?.history != nil
        case "send-to": return row?.dto.feed != nil
        case "panel-queue", "panel-snapshots": return agent
        case "panel-stack": return row?.dto.branch != nil
        case "toggle-keys": return s?.surface == .terminal
        default: return false
        }
    }

    /// A menu key command may run: the command is available and, for a key press, its chord
    /// means this command where the keyboard is now (a menu click passes no chord).
    func allowsMenuCommand(_ id: CommandID, chord: Chord?) -> Bool {
        if pendingChord != nil, chord != nil { return true }
        guard isAvailable(id) else { return false }
        guard let chord else { return true }
        return CommandMatcher.match(chord, scope: keyScope, bindings: app.keyBindings, field: fieldState) == id
    }

    /// Run a command: the same path for its key, the palette, the menu bar, a pane's menu
    /// and any button for it. The keyboard follows wherever it moves the focus.
    func perform(_ id: CommandID) {
        guard isAvailable(id) else { return }
        following { execute(id) }
        scheduleSave()
    }

    private func execute(_ id: CommandID) {
        if let n = id.workspaceNumber {
            if workspace.switchWorkspace(n) {
                syncRouteToWorkspace()
                if !workspace.sidebarVisible || narrow { toast("Workspace \(n)") }
            }
            return
        }
        if let n = id.sendToWorkspaceNumber {
            if workspace.sendToWorkspace(n) {
                syncRouteToWorkspace()
                toast("Sent to workspace \(n)")
            }
            return
        }
        let s = focusedSession
        let key = workspace.focusedKey
        switch id.rawValue {
        case "command-palette": palette = palette == nil ? PaletteState() : nil
        case "go-to-session": palette = PaletteState(path: ["go", "sessions"])
        case "split-left":
            workspace.split(.horizontal, before: true)
            syncRouteToWorkspace()
        case "split-above":
            workspace.split(.vertical, before: true)
            syncRouteToWorkspace()
        case "balance-panes": workspace.balance()
        case "swap-pane-left": workspace.swapPane(.left)
        case "swap-pane-right": workspace.swapPane(.right)
        case "swap-pane-up": workspace.swapPane(.up)
        case "swap-pane-down": workspace.swapPane(.down)
        case "focus-pane-next": workspace.cycleFocus(1)
        case "focus-pane-prev": workspace.cycleFocus(-1)
        case "workspace-next", "workspace-prev":
            if let n = workspace.stepWorkspace(id.rawValue == "workspace-next" ? 1 : -1) {
                syncRouteToWorkspace()
                if !workspace.sidebarVisible || narrow { toast("Workspace \(n)") }
            }
        case "focus-follows-pointer":
            app.preferences.focusFollowsPointer.toggle()
            toast(app.preferences.focusFollowsPointer ? "Focus follows the pointer" : "Focus stays until you click")
        case "switcher": switcher = switcher == nil ? SwitcherState() : nil
        case "new-session": sheet = .newSession(NewSessionContext(cwd: s?.row?.dto.projectPath, host: s?.row.map { $0.isLocal ? nil : $0.host } ?? nil))
        case "new-project": sheet = .newSession(NewSessionContext(project: true))
        case "toggle-sidebar": workspace.sidebarVisible.toggle()
        case "cycle-prev": cycle(-1)
        case "cycle-next": cycle(1)
        case "go-inbox": show(.inbox)
        case "go-history": show(.history)
        case "go-review": show(.review(ReviewRoute()))
        case "go-search": show(.search)
        case "go-settings": sheet = .settings(nil)
        case "worktrees": sheet = .worktrees
        case "show-shortcuts": showingShortcuts = true
        case "reload-page":
            app.resyncAll()
            for model in sessions.values { Task { await model.foreground() } }
            toast("Reconnecting…")
        case "focus-sidebar":
            if narrow { show(.sessions) } else { workspace.sidebarVisible = true }
            requestFocus(.sidebar)
        case "focus-main", "reply":
            guard let s else { return }
            requestFocus(s.surface == .gui && s.hasGUI ? .composer(s.key) : .terminal(s.key))
        case "focus-pane-left": workspace.focusPane(.left)
        case "focus-pane-right": workspace.focusPane(.right)
        case "focus-pane-up": workspace.focusPane(.up)
        case "focus-pane-down": workspace.focusPane(.down)
        case "move-pane-left": workspace.movePane(.left)
        case "move-pane-right": workspace.movePane(.right)
        case "move-pane-up": workspace.movePane(.up)
        case "move-pane-down": workspace.movePane(.down)
        case "toggle-split": workspace.flip()
        case "exit-split":
            workspace.exitSplit()
            syncRouteToWorkspace()
        case "split-right":
            workspace.split(.horizontal)
            syncRouteToWorkspace()
        case "split-below":
            workspace.split(.vertical)
            syncRouteToWorkspace()
        case "close-pane":
            if workspace.layout != nil { workspace.closePane() } else { workspace.open(nil) }
            syncRouteToWorkspace()
            pruneSessions()
        case "replace-pane":
            if workspace.layout != nil { workspace.replaceWithChooser() } else { switcher = SwitcherState() }
        case "open-in-pane": switcher = SwitcherState(asTile: true)
        case "resize-left": nudge(.left)
        case "resize-right": nudge(.right)
        case "resize-up": nudge(.up)
        case "resize-down": nudge(.down)
        case "resize-mode": workspace.submap = .resize
        case "pane-mode": workspace.submap = .pane
        case "maximize-pane": workspace.zoom.toggle()
        case "scratchpad": Task { await toggleScratchpad() }
        case "toggle-view":
            guard let s, let key else { return }
            setSurface(s.surface == .gui ? .terminal : .gui, for: key)
            requestFocus(s.surface == .gui ? .composer(key) : .terminal(key))
        case "toggle-steps": app.preferences.stepsHidden.toggle()
        case "toggle-panel":
            guard let s else { return }
            s.panel = s.panel == nil ? (lastPanel[s.key] ?? .diff) : nil
            if let p = s.panel { lastPanel[s.key] = p }
        case "approve": Task { await s?.answer(approve: true) }
        case "deny": Task { await s?.answer(approve: false) }
        case "interrupt": Task { await s?.interrupt() }
        case "send-now": _ = s?.sendNextNow()
        case "clear-queue": Task { await s?.clearQueue() }
        case "pick-model":
            guard let s, let key else { return }
            if s.surface == .gui && s.hasGUI { sheet = .modelPicker(key) } else { Task { _ = await s.apply(.terminalPicker(.model)) } }
        case "pick-effort":
            guard let s, let key else { return }
            if s.surface == .gui && s.hasGUI { sheet = .effortPicker(key) } else { Task { _ = await s.apply(.terminalPicker(.effort)) } }
        case "copy-last":
            guard let s else { return }
            Task {
                let text = await s.lastReply()
                if text.isEmpty { toast("No reply to copy yet") } else {
                    clipboard(text)
                    toast("Copied the last reply")
                }
            }
        case "jump-latest": if let key { requestFocus(.latest(key)) }
        case "browse-messages": if let key { requestFocus(.messages(key)) }
        case "switch-branch": if let key { sheet = .branch(key) }
        case "rename":
            guard let s, let key else { return }
            s.renaming = s.title
            requestFocus(.rename(key))
        case "fork": if let key { sheet = .fork(key) }
        case "send-to": if let key { sheet = .sendTo(key) }
        case "pin": Task { await s?.togglePin() }
        case "panel-diff": togglePanel(.diff)
        case "panel-files": togglePanel(.files)
        case "panel-chat": togglePanel(.chat)
        case "panel-queue": togglePanel(.queue)
        case "panel-snapshots": togglePanel(.snapshots)
        case "panel-preview": togglePanel(.preview)
        case "panel-stack": togglePanel(.stack)
        case "session-menu": if let key { sheet = .sessionMenu(key) }
        case "scrollback":
            guard let s, let key else { return }
            Task { if let text = await s.scrollback() { sheet = .scrollback(key: key, text: text) } }
        case "copy-attach":
            guard let s else { return }
            clipboard(s.attachCommand)
            toast("Copied “\(s.attachCommand)”")
        case "toggle-keys": app.preferences.keyBarVisible.toggle()
        case "terminate": if let key { sheet = .confirmTerminate(key) }
        default: break
        }
    }

    @ObservationIgnored private var lastPanel: [String: SceneSnapshot.Panel] = [:]

    private func togglePanel(_ panel: SceneSnapshot.Panel) {
        guard let s = focusedSession else { return }
        s.panel = s.panel == panel ? nil : panel
        if s.panel != nil { lastPanel[s.key] = panel }
    }

    /// Resize the side panel by this much when there's no split (positive narrows it).
    private(set) var panelWidthDelta: Double = 0

    private func nudge(_ dir: LayoutNode.Move) {
        if let delta = workspace.nudge(dir) { panelWidthDelta += delta }
    }

    private func cycle(_ direction: Int) {
        let keys = sidebarOrder.map(\.key)
        let before = workspace.focusedKey
        workspace.cycle(keys, direction)
        if workspace.layout == nil, let key = workspace.selected, key != before { route = .session(key) }
        pruneSessions()
    }

    /// After a workspace change, the route follows what the window shows.
    private func syncRouteToWorkspace() {
        if workspace.layout != nil { return }
        if let key = workspace.selected { route = .session(key) } else if case .session = route { route = .inbox }
        pruneSessions()
    }

    // MARK: Scratchpad

    /// One shell of its own, floating over everything; it keeps running while hidden.
    func toggleScratchpad() async {
        if workspace.scratchVisible {
            workspace.scratchVisible = false
            if let key = workspace.focusedKey { requestFocus(.terminal(key)) }
            scheduleSave()
            return
        }
        guard let hub else { return }
        if workspace.scratchKey == nil || hub.row(workspace.scratchKey!) == nil {
            do {
                let created = try await hub.api.create(NewSessionRequest(preset: "shell", cwd: "~", session: hub.hub.state?.defaultSession ?? "", label: "scratch"))
                workspace.scratchKey = created.uid
                hub.refresh()
            } catch {
                toast("Couldn’t start the scratchpad shell: \(APIError.wrap(error).message)", error: true)
                return
            }
        }
        workspace.scratchVisible = true
        if let key = workspace.scratchKey {
            _ = session(key)
            sessions[key]?.surface = .terminal
            requestFocus(.terminal(key))
        }
        scheduleSave()
    }

    // MARK: Switcher picks

    func pick(_ key: String) {
        let state = switcher
        switcher = nil
        following { place(key, state) }
    }

    private func place(_ key: String, _ state: SwitcherState?) {
        if let path = state?.intoPane {
            workspace.fill(path, with: key)
        } else if state?.asTile == true {
            workspace.openTile(key, wide: true)
            syncRouteToWorkspace()
        } else {
            open(key)
            return
        }
        pruneSessions()
        scheduleSave()
    }

    // MARK: Panes by pointer

    /// Something dropped on a pane (nil: the single view): a session from the sidebar, or
    /// another pane by its encoded path. An edge splits beside it; the center replaces the
    /// pane's session, or swaps two panes.
    func dropText(_ text: String, onto path: LayoutNode.Path?, where zone: LayoutNode.Drop) {
        following {
            if let from = LayoutNode.decodePath(text) {
                guard let path else { return }
                workspace.dropPane(from: from, to: path, where: zone)
            } else if !text.isEmpty {
                workspace.drop(text, onto: path, where: zone)
            }
            syncRouteToWorkspace()
        }
        suppressHover()
        pruneSessions()
        scheduleSave()
    }

    /// An empty pane picked a session.
    func fillPane(_ path: LayoutNode.Path, with key: String) {
        following { workspace.fill(path, with: key) }
        pruneSessions()
        scheduleSave()
    }

    /// An empty pane cancelled: what it replaced comes back, or it closes.
    func cancelChooser(_ path: LayoutNode.Path) {
        following {
            workspace.cancelChooser(path)
            syncRouteToWorkspace()
        }
        pruneSessions()
        scheduleSave()
    }

    // MARK: Palette

    /// Live palette branches for what's on screen now (`palette.ts` providers).
    func provide(_ provider: PaletteProvider) -> [PaletteNode] {
        guard let hub else { return [] }
        let s = focusedSession
        switch provider {
        case .sessions:
            let visible = Set(workspace.visibleKeys)
            let others = (1...9).filter { $0 != workspace.currentWorkspace }
            return sidebarOrder.map { row in
                let here = visible.contains(row.key)
                var choices = [PaletteNode(key: "go", label: here ? "Focus its pane" : "Switch to it", icon: "arrow.right.circle", action: .openSession(row.key))]
                if !narrow && !here { choices.append(PaletteNode(key: "pane", label: "Open as a new pane", icon: "plus.rectangle.on.rectangle", detail: "Beside the focused pane", action: .openAsPane(row.key))) }
                choices.append(PaletteNode(key: "workspace", label: "Move to workspace", icon: "square.grid.3x3", children: others.map { n in
                    PaletteNode(key: "ws\(n)", label: "Workspace \(n)", icon: "\(n).square", detail: workspace.occupiedWorkspaces.contains(n) ? "Beside what’s there" : "Empty", action: .sendSession(row.key, workspace: n))
                }))
                let host = hub.multiHost ? row.host : nil
                let detail = [row.word.rawValue, row.dto.project, row.dto.branch, host, here ? "on screen" : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                return PaletteNode(key: "session:\(row.key)", label: row.title, agent: row.dto.agent, detail: detail, terms: [row.dto.branch, row.host].compactMap { $0 }, action: .openSession(row.key), children: choices)
            }
        case .tiles:
            let visible = Set(workspace.visibleKeys)
            return sidebarOrder.filter { !visible.contains($0.key) }.map { row in
                PaletteNode(key: "tile:\(row.key)", label: row.title, agent: row.dto.agent, detail: [row.word.rawValue, row.dto.project].joined(separator: " · "), action: .openAsPane(row.key))
            }
        case .queue:
            guard let s else { return [] }
            return s.queue.items.map { item in
                PaletteNode(key: "queued:\(item.id)", label: Uploads.summary(item.text), icon: "list.bullet.rectangle", children: [
                    PaletteNode(key: "send", label: "Send now", detail: "Stop the turn and deliver this", action: .sendQueuedNow(uid: s.ref, item: item.id)),
                ])
            }
        case .models:
            guard let s, let preset = s.launch.preset, let models = preset.models, !models.isEmpty, preset.switchModel != nil || preset.modelArgs != nil else { return [] }
            let launch = s.launch
            return [PaletteNode(key: "models", label: "Model", icon: "cpu", detail: "Now \(launch.modelLabel ?? "default")", children: models.map { m in
                PaletteNode(key: m.id, label: m.name, icon: "cpu", detail: [m.id == launch.model?.id ? "current" : "", m.description ?? ""].filter { !$0.isEmpty }.joined(separator: " · "), action: .switchModel(m.id))
            })]
        case .efforts:
            guard let s, let preset = s.launch.preset, !s.launch.levels.isEmpty, preset.switchEffort != nil || preset.effort != nil else { return [] }
            let launch = s.launch
            return [PaletteNode(key: "efforts", label: "Reasoning effort", icon: "gauge", detail: "Now \(launch.effort ?? "default")", children: launch.levels.map { level in
                PaletteNode(key: level, label: level, icon: "gauge", detail: [level == launch.effort ? "current" : "", LaunchState.effortHints[level] ?? ""].filter { !$0.isEmpty }.joined(separator: " · "), action: .switchEffort(level))
            })]
        case .modes:
            guard let s, let modes = s.launch.preset?.modes, modes.count > 1 else { return [] }
            let launch = s.launch
            return [PaletteNode(key: "modes", label: "Permissions", icon: "shield", detail: "Now \(launch.mode?.name ?? "default")", children: modes.map { m in
                PaletteNode(key: m.id, label: (m.dangerous == true ? "⚠ " : "") + m.name, icon: "shield", detail: [m.id == launch.mode?.id ? "current" : "", m.description ?? ""].filter { !$0.isEmpty }.joined(separator: " · "), action: .switchMode(m.id))
            })]
        case .projects:
            let presets = hub.presets(host: nil).filter(\.offered)
            return projectsCache.prefix(30).map { path in
                PaletteNode(key: "project:\(path)", label: path.split(separator: "/").last.map(String.init) ?? path, icon: "folder", detail: path, children: presets.map { p in
                    PaletteNode(key: "run:\(p.id)", label: "New \(p.name)", agent: p.isShell ? nil : p.id, detail: "Starts at once with its defaults", action: .runInProject(path: path, preset: p.id))
                })
            }
        case .agents:
            guard let s, s.row?.dto.feed != nil else { return [] }
            return hub.presets(host: nil).filter { $0.offered && !$0.isShell && $0.id != s.row?.dto.agent }.map { p in
                PaletteNode(key: "continue:\(p.id)", label: p.name, agent: p.id, detail: "Start \(p.name) with this conversation’s summary and last reply", action: .continueIn(preset: p.id))
            }
        case .settings:
            return [
                PaletteNode(key: "reconnect", label: "Reconnect", icon: "arrow.clockwise", detail: "Reconnect to your hosts now", action: .command("reload-page")),
                PaletteNode(key: "pages", label: "Open settings", icon: "gearshape", children: SettingsSection.allCases.map { section in
                    PaletteNode(key: "settings:\(section.rawValue)", label: section.title, detail: section.summary, action: .settings(section.rawValue))
                }),
            ]
        }
    }

    /// Project folders for Run in project, fetched when the palette opens.
    private(set) var projectsCache: [String] = []

    func openPalette() async {
        palette = PaletteState()
        if let hub { projectsCache = (try? await hub.api.projects()) ?? [] }
    }

    func paletteTree() -> PaletteNode {
        PaletteTree.resolve(active: isAvailable, provide: provide)
    }

    /// Run a palette row (after the palette closes).
    func run(_ action: PaletteAction) {
        palette = nil
        if let key = action.recentKey { app.preferences.notePalette(key) }
        following { execute(action) }
    }

    /// Rows the palette ran recently that can still run here.
    func recentPaletteRows() -> [PaletteNode] {
        PaletteTree.recent(paletteTree(), keys: app.preferences.recentPalette)
    }

    /// Go to a session: focus its pane when it's already on screen, otherwise open it.
    func goTo(_ key: String) {
        if let layout = workspace.layout, let leaf = layout.leaves().first(where: { $0.sessionKey == key }) {
            following { workspace.focus(leaf.path) }
            scheduleSave()
        } else {
            open(key)
        }
    }

    private func execute(_ action: PaletteAction) {
        switch action {
        case .command(let id): perform(id)
        case .openSession(let key): goTo(key)
        case .sendSession(let key, let n):
            if workspace.sendSession(key, to: n) {
                syncRouteToWorkspace()
                toast("Moved to workspace \(n)")
            }
        case .openAsPane(let key):
            workspace.openTile(key, wide: true)
            syncRouteToWorkspace()
            scheduleSave()
        case .sendQueuedNow(_, let item):
            guard let s = focusedSession, let queued = s.queue.items.first(where: { $0.id == item }) else { return }
            Task { await s.queue.steer(queued) }
        case .switchModel(let id): applyPlan(focusedSession?.plan(model: id))
        case .switchEffort(let level): applyPlan(focusedSession?.plan(effort: level))
        case .switchMode(let id): applyPlan(focusedSession?.planMode(id))
        case .runInProject(let path, let preset):
            Task { await start(NewSessionRequest(preset: preset, cwd: path, session: hub?.hub.state?.defaultSession ?? "", label: "")) }
        case .continueIn(let preset):
            if let key = workspace.focusedKey { sheet = .continueIn(key: key, preset: preset) }
        case .settings(let section): sheet = .settings(section)
        }
    }

    /// A plan that needs a confirmation goes through a sheet; the rest run now.
    func applyPlan(_ plan: LaunchState.Plan?) {
        guard let plan, let s = focusedSession else { return }
        switch plan {
        case .relaunch(_, _, _, _), .switchMode(_, true):
            sheet = .confirmPlan(key: s.key, plan: plan)
        default:
            Task { await runPlan(plan, on: s) }
        }
    }

    func runPlan(_ plan: LaunchState.Plan, on s: SessionModel) async {
        if let replacement = await s.apply(plan) {
            let host = SessionKey(s.key)?.host
            open(host.map { "\($0)/\(replacement)" } ?? replacement)
        }
    }

    /// Start a session and open it once the host lists it.
    @discardableResult
    func start(_ request: NewSessionRequest, host: String? = nil, prompt: String? = nil, intoPane: LayoutNode.Path? = nil) async -> String? {
        guard let hub else { return nil }
        let api = hub.client(host: host)
        do {
            let created = try await api.create(request)
            let key = host.flatMap { $0 == hub.hostname ? nil : $0 }.map { "\($0)/\(created.uid)" } ?? created.uid
            hub.refresh(host: host)
            if let prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                let result = try await api.send(created.uid, text: prompt)
                toast(result.outcome == .queued ? "Your prompt goes in once it’s ready" : "Sent your prompt")
            }
            app.preferences.noteAgent(request.preset)
            if let intoPane { workspace.fill(intoPane, with: key) } else { open(key) }
            scheduleSave()
            return key
        } catch {
            toast("Couldn’t start it: \(APIError.wrap(error).message)", error: true)
            return nil
        }
    }

    /// Terminate after the confirmation sheet.
    func terminate(_ key: String) async {
        guard let s = session(key) else { return }
        if await s.terminate() {
            if workspace.layout != nil, let path = workspace.layout?.leaves().first(where: { $0.sessionKey == key })?.path {
                workspace.focus(path)
                workspace.closePane()
            } else {
                closeSession()
            }
            toast("Terminated “\(s.title)”. It stays in History.")
        }
        pruneSessions()
        scheduleSave()
    }
}

/// The nine settings sections (`../ah/web/settingsMenu.ts`).
enum SettingsSection: String, CaseIterable, Sendable {
    case security, appearance, shortcuts, notifications, agents, subscriptions, environment, search, system

    var title: String {
        switch self {
        case .security: return "Security"
        case .appearance: return "Appearance"
        case .shortcuts: return "Shortcuts"
        case .notifications: return "Notifications"
        case .agents: return "Agents"
        case .subscriptions: return "Subscriptions"
        case .environment: return "Environment"
        case .search: return "Search"
        case .system: return "System"
        }
    }

    var summary: String {
        switch self {
        case .security: return "This device, signed-in devices, setup codes, activity"
        case .appearance: return "System, dark, light or Omarchy"
        case .shortcuts: return "Every keyboard command and its binding"
        case .notifications: return "Needs you and finished, on this device"
        case .agents: return "Which agents New session offers, and their versions"
        case .subscriptions: return "Model providers for side chat and review"
        case .environment: return "Variables every session starts with"
        case .search: return "The full-text index"
        case .system: return "Hooks, screen rules, restart, uploads"
        }
    }

    var symbol: String {
        switch self {
        case .security: return "lock.shield"
        case .appearance: return "circle.lefthalf.filled"
        case .shortcuts: return "keyboard"
        case .notifications: return "bell.badge"
        case .agents: return "person.2.badge.gearshape"
        case .subscriptions: return "key"
        case .environment: return "list.bullet.indent"
        case .search: return "magnifyingglass"
        case .system: return "gearshape.2"
        }
    }
}
