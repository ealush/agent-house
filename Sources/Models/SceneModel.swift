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
    var route: SceneSnapshot.Route = .inbox {
        didSet {
            guard case .review(let target) = route else { return }
            let path = Self.reviewPath(to: target)
            if path != reviewPath { reviewPath = path }
        }
    }
    /// On a phone, what's pushed over the Review tab's list: a stack, then one of its layers.
    /// It outlives the route, so a session opened from a stack comes back to that stack.
    var reviewPath: [ReviewRoute] = [] {
        didSet {
            guard case .review(let target) = route, Self.reviewPath(to: target) != reviewPath else { return }
            route = .review(reviewPath.last ?? ReviewRoute())
        }
    }
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
    /// Where a phone's composer starts on screen (window points), while one shows: toasts
    /// sit above it, not over it.
    var composerTop: Double?
    /// The middle of that composer across (window points): toasts centre over it, on an iPad
    /// beside the sidebar rather than in the middle of the whole window.
    var composerMidX: Double?
    /// The phone's tab bar's top (window points) while it shows; none while a sheet is up.
    var tabBarTop: Double?
    /// Whether a sheet covers the window (its own bottom is the screen's then).
    var sheetUp = false
    /// Toasts sit above this: the tab bar or the composer, whichever is higher. Read where
    /// toasts draw, so a composer that moves (the keyboard, a new screen) moves them at once.
    var toastFloor: Double? {
        sheetUp ? nil : [tabBarTop, composerTop].compactMap { $0 }.min()
    }
    /// The newest which-key overlay, while modifiers are held.
    var whichKey: [CommandMatcher.WhichKeyRow] = []
    /// The first key of a two-key chord, waiting for the second.
    private(set) var pendingChord: Chord?
    /// Set by the platform layer.
    var clipboard: (String) -> Void = { _ in }
    /// The clipboard's text, read only when you ask to open a link from it.
    var pasteboard: () -> String? = { nil }
    /// The system's share sheet, for a link (set by the window).
    var share: (URL) -> Void = { _ in }
    /// Opens another window (at a link, signed in to an origin); nil where there's only one
    /// window (iPhone).
    var openWindow: ((DeepLink?, String?) -> Void)?
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
    /// What last took the keyboard, and when (`rootTookKeyboard`).
    @ObservationIgnored private var lastTook: (target: FocusTarget, at: Date)?
    /// When the window's root last took it.
    @ObservationIgnored private var rootTook: Date?
    @ObservationIgnored private var restored = false
    @ObservationIgnored private var pendingRestore: SceneSnapshot?
    /// A link's place that arrived before the window's own state was back.
    @ObservationIgnored private var pendingPlace: Place?
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

    @ObservationIgnored private var watchedHub: ObjectIdentifier?

    /// Every change to a host's session list reaches `notice`, as it happens (a view's
    /// update pass can fold several changes into one and miss a working → done). Started
    /// once a host is signed in (and again for another host).
    func watchSessionsIfNeeded() {
        guard let hub, ObjectIdentifier(hub) != watchedHub else { return }
        watchedHub = ObjectIdentifier(hub)
        watchSessions(hub)
    }

    private func watchSessions(_ hub: HubStore) {
        guard watchedHub == ObjectIdentifier(hub) else { return }
        let rows = withObservationTracking { hub.rows } onChange: { [weak self, weak hub] in
            Task { @MainActor in if let hub { self?.watchSessions(hub) } }
        }
        notice(rows, live: !hub.showingCached)
    }

    // MARK: Presentation

    enum Sheet: Equatable, Identifiable, Sendable {
        case setup
        case newSession(NewSessionContext)
        case fork(String)
        case forks(String)
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
        /// Continue in Another Agent; `preset` picks the agent to start with.
        case continueIn(key: String, preset: String?)
        /// A conversation's family across agents (`features.portable`).
        case lineage(String)
        /// The composer's draft in a larger editor (a long message).
        case draft(String)
        /// A note's hand-off: send it to a session, or put it in a session's box (by note id).
        case noteSend(String, insert: Bool)
        /// Save a note into a project as a file.
        case noteSaveFile(String)
        /// Choose the project a note is filed under.
        case noteProject(String)
        /// The host's version of a note beside this device's, to choose between.
        case noteCompare(String)
        /// Asked as a system alert: delete a note everywhere.
        case noteDelete(String)

        var id: String {
            switch self {
            case .setup: return "setup"
            case .newSession: return "new"
            case .fork(let k): return "fork:\(k)"
            case .forks(let k): return "forks:\(k)"
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
            case .continueIn(let k, let p): return "continue:\(k):\(p ?? "")"
            case .lineage(let k): return "lineage:\(k)"
            case .draft(let k): return "draft:\(k)"
            case .noteSend(let k, let insert): return "note-send:\(k):\(insert)"
            case .noteSaveFile(let k): return "note-save:\(k)"
            case .noteProject(let k): return "note-project:\(k)"
            case .noteCompare(let k): return "note-compare:\(k)"
            case .noteDelete(let k): return "note-delete:\(k)"
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
        /// A name to start with (a note's title), still yours to change.
        var label: String?
        /// A file attached to the first message (a note as Markdown).
        var attachment: Attachment?

        struct Attachment: Equatable, Sendable {
            var name: String
            var data: Data
        }
    }

    /// The note whose title is being edited (rename), by id.
    var renamingNote: String?

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
        case attachedTerminal(String)
        case ask(String)
        case sidebar
        case page
        case messages(String)
        case latest(String)
        case rename(String)
        /// An empty pane's session search.
        case chooser(LayoutNode.Path)
        /// Scroll a transcript to this turn (a search hit), loading older pages as needed.
        case turn(String, Int)

        /// The session this target is in, if any.
        var sessionKey: String? {
            switch self {
            case .composer(let k), .terminal(let k), .attachedTerminal(let k), .ask(let k), .messages(let k), .latest(let k), .rename(let k), .turn(let k, _): return k
            case .sidebar, .page, .chooser: return nil
            }
        }
    }

    struct FocusRequest: Equatable, Sendable {
        let target: FocusTarget
        let nonce: Int
        /// When it was asked for.
        var at = Date()

        /// How long a request stays new to a box made after it: long enough for the screen it
        /// opened to come in, not so long that opening the session later raises the keyboard.
        static let freshness: TimeInterval = 2

        /// Whether a box made at `made` acts on it. A screen is made again each time it's
        /// opened (a phone pushes a session anew), and its box took the last request for
        /// itself as new however old it was: one asked for once (the keyboard put back on
        /// launch, a tap on / or @) raised the keyboard every time the session opened.
        func isFresh(forBoxMadeAt made: Date, now: Date = Date()) -> Bool {
            at >= made || now.timeIntervalSince(at) < Self.freshness
        }
    }

    struct Toast: Equatable, Identifiable, Sendable {
        let id: Int
        let text: String
        let isError: Bool
    }

    /// A session you're not looking at that just started needing you, or just finished.
    struct Nudge: Equatable, Identifiable, Sendable {
        enum Kind: Sendable { case needsYou, finished }
        let id: Int
        let key: String
        let title: String
        let agent: String?
        let kind: Kind
    }

    /// At most three, newest last.
    private(set) var nudges: [Nudge] = []
    @ObservationIgnored private var seenWords: [String: StatusWord] = [:]
    @ObservationIgnored private var nudgeID = 0

    /// Fed every change to the session list: a session off screen that turns to needing you,
    /// or from working to done, gets a nudge with a way to it. The first look at a list
    /// nudges nothing (that's the Inbox's job), and a nudge leaves once its session is on
    /// screen or (needing you) was answered elsewhere. A list read from the cache at launch
    /// isn't a look: what changed since it was sealed is the Inbox's to show, not a nudge's.
    func notice(_ rows: [SessionRow], live: Bool = true) {
        guard live else {
            seenWords = [:]
            return
        }
        var now: [String: StatusWord] = [:]
        for row in rows {
            now[row.key] = row.word
            guard let before = seenWords[row.key], before != row.word, !shows(row.key) else { continue }
            let kind: Nudge.Kind? = row.word == .needsYou ? .needsYou : (row.word == .done && before == .working ? .finished : nil)
            guard let kind else { continue }
            nudges.removeAll { $0.key == row.key }
            nudgeID += 1
            nudges.append(Nudge(id: nudgeID, key: row.key, title: row.title, agent: row.dto.agent, kind: kind))
            if nudges.count > 3 { nudges.removeFirst(nudges.count - 3) }
        }
        let stale = nudges.filter { shows($0.key) || now[$0.key] == nil || ($0.kind == .needsYou && now[$0.key] != .needsYou) }
        if !stale.isEmpty { nudges.removeAll { n in stale.contains { $0.id == n.id } } }
        seenWords = now
    }

    /// The session is in front in this window: its route, or one of its visible panes.
    func shows(_ key: String) -> Bool {
        if case .session(let open) = route, open == key { return true }
        return workspace.visibleKeys.contains(key)
    }

    func openNudge(_ nudge: Nudge) {
        dismissNudge(nudge.id)
        open(nudge.key)
    }

    func dismissNudge(_ id: Int) { nudges.removeAll { $0.id == id } }

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
    func didFocus(_ target: FocusTarget, now: Date = Date()) {
        lastTook = (target, now)
        rootTook = nil
        // UIKit gives the keyboard back to whatever had it when a modal went up; if focus was
        // asked for elsewhere meanwhile (a split from the palette), ask again so that wins.
        if let delivering, now < delivering.until {
            if delivering.target != target {
                currentFocus = target
                focusNonce += 1
                focusRequest = FocusRequest(target: delivering.target, nonce: focusNonce)
                return
            }
            self.delivering = nil
        }
        currentFocus = target
        if case .chooser(let path) = target, workspace.layout?.node(at: path) != nil, workspace.focusPath != path {
            workspace.focus(path)
            scheduleSave()
            return
        }
        guard let key = target.sessionKey else { return }
        switch target {
        case .composer, .terminal, .attachedTerminal: focusMemory[key] = target
        default: break
        }
        if let layout = workspace.layout, workspace.focusedKey != key, let leaf = layout.leaves().first(where: { $0.sessionKey == key }) {
            workspace.focus(leaf.path)
            scheduleSave()
        }
    }

    func didBlur(_ target: FocusTarget) {
        if currentFocus == target { currentFocus = nil }
        recoverFromRebuild()
    }

    /// The window's root took the keyboard. When a box had taken it only a moment before and
    /// nothing has it now, the box's view was rebuilt under it (a split view rebuilds its
    /// column as a page's navigation stack goes), and the keyboard goes back to it, once.
    /// UIKit tells the root before the box says it lost the keyboard, so whichever of the two
    /// comes second does it.
    func rootTookKeyboard(now: Date = Date()) {
        rootTook = now
        recoverFromRebuild()
    }

    private func recoverFromRebuild() {
        // Only with a keyboard attached, as every move of the keyboard is: on touch alone, a
        // box going quiet is the on-screen keyboard put away, and stays so.
        guard hardwareKeyboard, !modalShown, currentFocus == nil, let last = lastTook, let root = rootTook,
              root >= last.at, root.timeIntervalSince(last.at) < Self.rebuildWindow else { return }
        lastTook = nil
        rootTook = nil
        requestFocus(last.target)
    }

    /// How soon after a box takes the keyboard losing it to the root counts as a rebuild: the
    /// column goes once the page's fade has run, about half a second on.
    nonisolated static let rebuildWindow: TimeInterval = 1.5

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
        let model = session(key)
        // A waiting session's answer controls come first in the GUI, as Reply does.
        if let model, model.surface == .gui, let ask = answerFocus(model) { return ask }
        if let remembered = focusMemory[key] {
            if case .attachedTerminal = remembered {
                if model?.panel == .terminal { return remembered }
            } else { return remembered }
        }
        guard let model else { return .composer(key) }
        return model.surface == .gui && model.hasGUI ? .composer(key) : .terminal(key)
    }

    /// The answer controls of a session waiting on you, when it shows some.
    func answerFocus(_ model: SessionModel) -> FocusTarget? {
        model.waiting && model.row?.dto.ask != nil ? .ask(model.key) : nil
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
        let zoom: Bool
    }

    private var focusSpot: FocusSpot {
        FocusSpot(route: route, layout: workspace.layout, path: workspace.focusPath, key: workspace.focusedKey ?? workspace.selected, zoom: workspace.zoom)
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
        if after.layout != before.layout || after.zoom != before.zoom || after.route != before.route { suppressHover() }
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
    /// Where focus stood when a modal went up: a command run from it that moved panes or pages
    /// keeps the keyboard from going back to the old spot.
    @ObservationIgnored private var spotAtModal: FocusSpot?
    /// Focus handed out as a modal closed, for a moment: see `didFocus`.
    @ObservationIgnored private var delivering: (target: FocusTarget, until: Date)?

    func modalWillPresent() {
        guard !modalShown else { return }
        modalShown = true
        focusBeforeModal = currentFocus
        nonceAtModal = focusNonce
        spotAtModal = focusSpot
    }

    /// Everything presented is gone: deliver focus asked for meanwhile, or put the keyboard
    /// back where it was.
    func modalDidDismiss() {
        guard modalShown else { return }
        modalShown = false
        let back = focusBeforeModal
        focusBeforeModal = nil
        defer { spotAtModal = nil }
        if let deferred = deferredFocus {
            deferredFocus = nil
            focusNonce += 1
            focusRequest = FocusRequest(target: deferred, nonce: focusNonce)
            delivering = (deferred, Date().addingTimeInterval(0.5))
        } else if focusNonce == nonceAtModal, spotAtModal == nil || spotAtModal == focusSpot, let back {
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

    /// This window's host, or, once that's removed from this device, the first one left: a
    /// window on a removed host went to Setup, with hosts still paired.
    var account: AccountSession? { app.account(origin: accountOrigin) ?? app.accounts.first }
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
    /// What a session's host connection says in place of its status while it isn't live: the
    /// last state is all there is ("Offline"), or live updates are catching up
    /// ("Reconnecting"). Inside a session nothing said so; only the lists had the banner.
    func connectionNote(_ key: String) -> String? {
        guard let hub else { return nil }
        if let host = SessionKey(key)?.host, let peer = hub.hosts.first(where: { !$0.isSelf && $0.name == host }) {
            return peer.online ? nil : "Offline"
        }
        switch hub.phase {
        case .offline: return "Offline"
        case .polling: return "Reconnecting"
        default: return nil
        }
    }

    func session(_ key: String) -> SessionModel? {
        if let existing = sessions[key] { return existing }
        // New session's place, before there's a session in it; a note has no host session at all.
        guard key != Self.newSessionKey, !NoteKey.isNote(key) else { return nil }
        guard let hub, let account else { return nil }
        let surface = app.services.preferences.surface(origin: account.origin, sessionKey: key) ?? .gui
        let model = SessionModel(key: key, hub: hub, outbox: app.outbox, surface: surface)
        let cacheKey = "\(key)"
        model.feedCache = SessionModel.FeedCache(
            load: { [weak account] in account?.cachedReader(SessionModel.FeedCache.Entry.self, kind: .feed, key: cacheKey) },
            store: { [weak account] entry in account?.cacheSoon(entry, kind: .feed, key: cacheKey) })
        sessions[key] = model
        Task { await model.open() }
        return model
    }

    var focusedSession: SessionModel? { workspace.focusedKey.flatMap(session) }

    /// A session's model only if this window already has it (nothing opened for asking).
    func sessionIfOpen(_ key: String) -> SessionModel? { sessions[key] }

    /// The window's name in Stage Manager, the app switcher and the Mac's Window menu: the
    /// session in front, else the page.
    var windowTitle: String {
        if workspace.layout != nil {
            guard let key = workspace.focusedKey else { return "New Pane" }
            if let title = noteTitle(key) { return title }
            return hub?.row(key)?.title ?? "Session"
        }
        switch route {
        case .session(let key): return noteTitle(key) ?? hub?.row(key)?.title ?? hub?.history.first { $0.id == key }?.dto.title ?? "Session"
        case .inbox: return "Inbox"
        case .sessions: return "Sessions"
        case .history: return "History"
        case .search: return "Search"
        case .review: return "Review"
        case .settings: return "Settings"
        case .worktrees: return "Worktrees"
        }
    }

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

    /// Also on leaving signed-in (signed out, locked, removed): what was open read through a
    /// sign-in that's gone, and a transcript's stream ends for good on the host's refusal.
    /// Kept, signing back in showed every pane "Connecting…" until the app went away and came
    /// back; made again, each opens.
    func closeAllSessions() {
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
        return sidebarSections.flatMap(\.rows)
    }

    /// The sidebar's blocks, in the order this device keeps.
    var sidebarSections: [SessionOrdering.Section] {
        guard let hub else { return [] }
        return SessionOrdering.sections(hub.rows, multiHost: hub.multiHost, saved: app.preferences.groupOrder.saved(multiHost: hub.multiHost), sort: app.preferences.sessionSort)
    }

    /// A block dragged onto another (or moved up or down a step): saved on this device.
    func moveGroup(_ id: String, to target: String, after: Bool) {
        guard let hub else { return }
        let visible = sidebarSections.map(\.id)
        var order = app.preferences.groupOrder
        let saved = order.saved(multiHost: hub.multiHost)
        order.set(SessionOrdering.saveGroupMove(visible: visible, saved: saved, from: id, to: target, after: after), multiHost: hub.multiHost)
        app.preferences.groupOrder = order
    }

    /// A block folded in the sidebar: its header stays, its rows don't.
    func isGroupCollapsed(_ id: String) -> Bool { app.preferences.collapsedGroups.contains(id) }

    /// Fold or unfold a block (its header tapped): saved on this device.
    func toggleGroup(_ id: String) {
        var folded = app.preferences.collapsedGroups
        if let at = folded.firstIndex(of: id) { folded.remove(at: at) } else { folded.append(id) }
        app.preferences.collapsedGroups = folded
    }

    func moveGroup(_ id: String, by step: Int) {
        let ids = sidebarSections.map(\.id)
        guard let at = ids.firstIndex(of: id) else { return }
        let to = at + step
        guard ids.indices.contains(to) else { return }
        moveGroup(id, to: ids[to], after: step > 0)
    }

    /// Open a session: in a split it replaces the focused pane, on a phone it pushes.
    func open(_ key: String) {
        overtakeRestore()
        // Made now, not when its screen first draws: the transcript, draft and queue are on
        // their way while the screen comes in. A new one says it's in focus as it opens.
        let opened = sessions[key] != nil
        _ = session(key)
        following {
            workspace.open(key)
            if workspace.layout == nil { route = .session(key) }
        }
        if opened, let hub, hub.row(key) != nil { Task { try? await hub.client(forKey: key).focus(key: key) } }
        app.didShowSessions?([key])
        pruneSessions()
        scheduleSave()
    }

    /// A session in a window of its own, beside this one.
    func openInNewWindow(_ key: String) {
        guard let row = hub?.row(key) else { return }
        openWindow?(.session(host: row.isLocal ? nil : row.host, uid: row.uid), account?.origin)
    }

    /// A page (Inbox, History, Review…): leaves the split.
    func show(_ page: SceneSnapshot.Route) {
        overtakeRestore()
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

    private static func reviewPath(to target: ReviewRoute) -> [ReviewRoute] {
        guard let stack = target.stack else { return [] }
        return [ReviewRoute(stack: stack)] + (target.pr == nil ? [] : [ReviewRoute(stack: stack, pr: target.pr)])
    }

    /// Where a phone's tab opens to: Review's keeps the stack or layer you left it on.
    func tabRoute(_ page: SceneSnapshot.Route) -> SceneSnapshot.Route {
        guard case .review = page else { return page }
        return .review(reviewPath.last ?? ReviewRoute())
    }

    // MARK: Restoration

    func snapshot() -> SceneSnapshot {
        var placement: SceneSnapshot.SessionPlacement?
        let key: String? = {
            if case .session(let k) = route { return k }
            return workspace.focusedKey
        }()
        if let key, let model = sessions[key] {
            placement = SceneSnapshot.SessionPlacement(key: key, surface: model.chosenSurface, panel: model.panel, scroll: scrollAnchors[key], composerFocused: composerFocused == key)
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

    /// Load this window's journal (or the newest window's, for a brand-new one, when
    /// `copyingNewest`) and apply it once the host's state arrives.
    func restore(copyingNewest: Bool = true) {
        let journal = app.services.scenes
        #if DEBUG
        // UI tours start every window from scratch (TourUITests passes it).
        if ProcessInfo.processInfo.arguments.contains("-AHFreshWindow") {
            restored = true
            return
        }
        #endif
        let stored = (try? journal.load(sceneID: sceneID)) ?? (copyingNewest ? (try? journal.mostRecent()) : nil).flatMap { latest -> SceneSnapshot? in
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
        watchSessionsIfNeeded()
        guard let pending = pendingRestore, let hub else { return }
        // Notes are on this device: a window of notes (and pages) comes back without the host.
        guard hub.hub.state != nil || Self.onlyNotes(pending) else { return }
        pendingRestore = nil
        let notes = app.notes
        let outcome = RestorationReconciler.reconcile(pending) { key in
            guard NoteKey.isNote(key) else { return hub.presence(of: key) }
            return NoteKey.id(notes.current(key)).flatMap { notes.note($0) } != nil ? .live : .gone
        }
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
        if let place = pendingPlace {
            pendingPlace = nil
            go(place)
        }
    }

    var isRestored: Bool { restored }

    /// You went somewhere before the restore could apply (the host out of reach at launch,
    /// the cached list in front of you): where you went wins. Applied later, it took the
    /// window back to where it had been, and nothing was saved until then.
    private func overtakeRestore() {
        guard !restored, pendingRestore != nil else { return }
        pendingRestore = nil
        restored = true
    }

    /// Write the journal soon (coalesces a burst of changes); `now` on backgrounding.
    func scheduleSave(now: Bool = false) {
        guard restored else { return }
        saveTask?.cancel()
        let snapshot = snapshot()
        let journal = app.services.scenes
        if now {
            Self.journaling.sync { try? journal.save(snapshot) }
            return
        }
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            // Off the main thread: the database takes one write at a time, and one of a
            // transcript's sealed pages (megabytes) held a save here, and the scroll or
            // keyboard it was saving for, until it was done.
            Self.journaling.async { try? journal.save(snapshot) }
        }
    }

    /// Every window's journal writes, in the order asked.
    private static let journaling = DispatchQueue(label: "dev.ealush.ah.native.scene-journal", qos: .utility)

    /// This window is in the background (another of the app's may not be).
    private(set) var inBackground = false

    /// Done once every session here has stopped reading and saved its draft.
    @discardableResult
    func didEnterBackground() -> Task<Void, Never> {
        inBackground = true
        scheduleSave(now: true)
        hub?.saveCache(force: true)
        let leaving = sessions.values.map { model in Task { await model.background() } }
        return Task { for task in leaving { await task.value } }
    }

    func willEnterForeground() {
        inBackground = false
        for model in sessions.values { Task { await model.foreground() } }
    }

    // MARK: Keyboard

    /// A hardware key press from wherever focus is. True when a command took it.
    func handle(_ press: KeyPress, scope: KeyScope, field: FieldState = FieldState()) -> Bool {
        let scope = effectiveScope(scope)
        // Esc closes a sheet even when nothing in it has the keyboard (its Cancel button's
        // shortcut only answers from inside it).
        if modalShown, sheet != nil, pendingChord == nil, press.key == "Escape", press.modifiers.isEmpty {
            sheet = nil
            return true
        }
        if let lead = pendingChord, scope != .ask, let next = press.chord {
            finishChord(lead, next, scope: scope)
            return true
        }
        if workspace.submap != nil, scope != .ask {
            following {
                switch workspace.submapKey(press.key ?? "", shift: press.modifiers.contains(.shift), alt: press.modifiers.contains(.option)) {
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
        case .newSession: beginNewSession(NewSessionContext())
        case .scratchpad: Task { await toggleScratchpad() }
        }
    }

    // MARK: Commands

    /// Whether a command can run right now in this window (the palette lists only these).
    func isAvailable(_ id: CommandID) -> Bool {
        // A link names its own host: it can open before this window has one.
        guard hub != nil else { return ["go-settings", "show-shortcuts", "command-palette", "open-link"].contains(id.rawValue) }
        let ws = workspace
        let s = focusedSession
        let row = s?.row
        let live = row != nil
        // As the screen shows it: held through a scan that missed the agent.
        let agent = s.map { $0.isLive && !$0.isShell } ?? false
        let gui = s?.surface == .gui && (s?.hasGUI ?? false)
        if let answer = noteAvailability(id) { return answer }
        if id.rawValue.hasPrefix("panel-"), let panel = SceneSnapshot.Panel(rawValue: String(id.rawValue.dropFirst(6))) {
            return s.map { panel.applies(to: $0) } ?? false
        }
        switch id.rawValue {
        case "go-to-session", "focus-follows-pointer": return true
        case "new-window": return openWindow != nil
        case "open-in-new-window": return openWindow != nil && live
        case "split-left", "split-above": return !narrow && (ws.focusedKey != nil || ws.chooserFocused)
        case "balance-panes", "focus-pane-next", "focus-pane-prev", "swap-pane-left", "swap-pane-right", "swap-pane-up", "swap-pane-down": return ws.splitOpen
        case "command-palette", "switcher", "new-session", "new-project", "cycle-prev", "cycle-next", "go-inbox", "go-history", "go-review",
             "go-search", "go-settings", "worktrees", "show-shortcuts", "reload-page", "focus-sidebar", "scratchpad":
            return true
        case "toggle-sidebar": return !narrow
        case "focus-main", "reply", "session-menu", "toggle-panel", "copy-attach": return s != nil
        case "copy-link", "share-link": return accountOrigin != nil
        case "open-link": return true
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
        case "switch-branch": return row?.dto.branch != nil
        case "rename": return live || focusedNoteID != nil
        case "pin", "terminate", "scrollback": return live
        case "fork": return agent || (s?.history != nil && s?.isShell == false)
        case "send-to": return s.map { $0.isLive && $0.hasGUI } ?? false
        case "continue-in": return s.map { $0.hasGUI && !$0.isShell } ?? false
        case "conversation-lineage": return s.map { !$0.isShell && portable($0) } ?? false
        case "toggle-keys": return s?.surface == .terminal || s?.panel == .terminal
        case "terminal-text-bigger", "terminal-text-smaller", "terminal-text-reset": return s?.surface == .terminal || s?.panel == .terminal || workspace.scratchVisible
        default: return false
        }
    }

    /// A menu key command may run: the command is available and, for a key press, its chord
    /// means this command where the keyboard is now (a menu click passes no chord).
    func allowsMenuCommand(_ id: CommandID, chord: Chord?) -> Bool {
        if pendingChord != nil, chord != nil { return true }
        guard isAvailable(id) else { return false }
        guard let chord else {
            // Chosen from the menu bar: behind a sheet, only what works over one.
            return !modalShown || CommandCatalog.all.first { $0.id == id }?.scopes.contains(.dialog) == true
        }
        return CommandMatcher.match(chord, scope: effectiveScope(keyScope), bindings: app.keyBindings, field: fieldState) == id
    }

    /// Behind a sheet, the palette or the switcher, a key reaches only the commands that work
    /// over a dialog (the switcher, Settings): a page must not change under an open sheet.
    private func effectiveScope(_ scope: KeyScope) -> KeyScope {
        modalShown && scope != .ask ? .dialog : scope
    }

    /// Run a command: the same path for its key, the palette, the menu bar, a pane's menu
    /// and any button for it. The keyboard follows wherever it moves the focus.
    func perform(_ id: CommandID) {
        guard isAvailable(id) else { return }
        following { execute(id) }
        scheduleSave()
    }

    private func execute(_ id: CommandID) {
        if executeNote(id) { return }
        let s = focusedSession
        let key = workspace.focusedKey
        switch id.rawValue {
        case "command-palette": palette = palette == nil ? PaletteState() : nil
        case "go-to-session": palette = PaletteState(path: ["go", "sessions"])
        case "new-window": openWindow?(nil, account?.origin)
        case "open-in-new-window": if let key { openInNewWindow(key) }
        case "copy-link": copyLink(to: place)
        case "share-link": shareLink(to: place)
        case "open-link":
            guard let text = pasteboard(), let link = AppLink(text: text) else {
                toast("There’s no link on the clipboard", error: true)
                return
            }
            follow(link)
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
        case "focus-follows-pointer":
            app.preferences.focusFollowsPointer.toggle()
            toast(app.preferences.focusFollowsPointer ? "Focus follows the pointer" : "Focus stays until you click")
        case "switcher": switcher = switcher == nil ? SwitcherState() : nil
        case "new-session": beginNewSession(NewSessionContext(cwd: s?.row?.dto.projectPath, host: s?.row.map { $0.isLocal ? nil : $0.host } ?? nil))
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
            for model in sessions.values { Task { await model.foreground(reconnect: true) } }
            toast("Reconnecting…")
        case "focus-sidebar":
            if narrow { show(.sessions) } else { workspace.sidebarVisible = true }
            requestFocus(.sidebar)
        case "focus-main":
            guard let s else { return }
            requestFocus(s.surface == .gui && s.hasGUI ? .composer(s.key) : .terminal(s.key))
        case "reply":
            // Waiting on you: its answer controls first (digits pick), else the input.
            guard let s else { return }
            requestFocus(answerFocus(s) ?? (s.surface == .gui && s.hasGUI ? .composer(s.key) : .terminal(s.key)))
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
        // In focus mode, this session's steps shown or not; otherwise every transcript's folded.
        case "toggle-steps":
            if app.preferences.focusMode, let session = focusedSession { session.stepsShown.toggle() } else { app.preferences.stepsHidden.toggle() }
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
            if let id = focusedNoteID {
                renamingNote = id
                return
            }
            guard let s, let key else { return }
            s.renaming = s.title
            requestFocus(.rename(key))
        case "fork": if let key { sheet = .fork(key) }
        case "send-to": if let key { sheet = .sendTo(key) }
        case "continue-in": if let key { sheet = .continueIn(key: key, preset: nil) }
        case "conversation-lineage": if let key { sheet = .lineage(key) }
        case "pin": Task { await s?.togglePin() }
        case "panel-diff": togglePanel(.diff)
        case "panel-files": togglePanel(.files)
        case "panel-chat": togglePanel(.chat)
        case "panel-queue": togglePanel(.queue)
        case "panel-snapshots": togglePanel(.snapshots)
        case "panel-preview": togglePanel(.preview)
        case "panel-stack": togglePanel(.stack)
        case "panel-terminal": togglePanel(.terminal)
        case "session-menu": if let key { sheet = .sessionMenu(key) }
        case "scrollback":
            guard let s, let key else { return }
            Task { if let text = await s.scrollback() { sheet = .scrollback(key: key, text: text) } }
        case "copy-attach":
            guard let s else { return }
            clipboard(s.attachCommand)
            toast("Copied “\(s.attachCommand)”")
        case "toggle-keys": app.preferences.keyBar = app.preferences.showsKeyBar(hardwareKeyboard: hardwareKeyboard) ? .off : .on
        case "terminal-text-bigger": app.preferences.terminalFontSize = TerminalTextSize.step(app.preferences.terminalFontSize, by: 1)
        case "terminal-text-smaller": app.preferences.terminalFontSize = TerminalTextSize.step(app.preferences.terminalFontSize, by: -1)
        case "terminal-text-reset": app.preferences.terminalFontSize = TerminalTextSize.standard
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

    // MARK: Handoff

    /// This window's place for Handoff: the focused session (in a split, its focused pane)
    /// or the page. Nil until signed in.
    var handoff: Handoff? {
        guard let account, account.status == .signedIn, let hub else { return nil }
        if let key = workspace.focusedKey ?? { if case .session(let k) = route { return k } else { return nil } }() {
            let title = key == Self.newSessionKey ? "New Session" : noteTitle(key) ?? hub.slot(key).row?.title ?? hub.history.first { $0.id == key }?.dto.title ?? "Session"
            return Handoff(origin: account.origin, route: .session(key), title: title)
        }
        let titles: [String: String] = ["sessions": "Sessions", "history": "History", "search": "Search", "settings": "Settings"]
        let hash = Handoff.hash(route)
        return Handoff(origin: account.origin, route: route, title: hash.hasPrefix("review") ? "Review" : titles[hash] ?? "Inbox")
    }

    /// Another of your devices handed this place over: the same host's account, then the
    /// place. False (and says why) when this device isn't set up for that host.
    @discardableResult
    func continueHandoff(_ handoff: Handoff) -> Bool {
        guard app.account(origin: handoff.origin) != nil else {
            toast("Set up \(URL(string: handoff.origin)?.host ?? handoff.origin) on this device to continue there.", error: true)
            return false
        }
        useAccount(handoff.origin)
        go(Place(handoff.route))
        return true
    }

    // MARK: Links

    /// A link from outside (opened, pasted, handed over): the account that serves its host,
    /// then its place. A host this device hasn't set up says so.
    @discardableResult
    func follow(_ link: AppLink) -> Bool {
        let accounts = app.accounts.map { AppLink.Account(origin: $0.origin, hostname: $0.hostname, peers: $0.hub.hosts.map(\.name)) }
        guard let (origin, place) = link.resolve(accounts, preferred: accountOrigin) else {
            let name = link.origin.flatMap { URL(string: $0)?.host } ?? link.host ?? "that host"
            toast("Set up \(name) on this device to open its links.", error: true)
            return false
        }
        useAccount(origin)
        go(place)
        return true
    }

    /// Where a link typed or pasted into a search field points, to offer it as a row: nil for
    /// text that isn't one, or a web address that names no place in ah.
    func pastedLink(_ text: String) -> (link: AppLink, summary: String)? {
        guard let link = AppLink(text: text), link.origin == nil || link.place.route != .inbox else { return nil }
        var title: String?
        if case .session(let key) = link.place.route { title = hub?.row(key)?.title }
        return (link, link.place.summary(title: title))
    }

    /// Goes to a place: a page, a Settings section, a review, or a session with its view, its
    /// panel and a message brought into sight. Until the window's own state is back it waits,
    /// or the restore would land on top of it.
    func go(_ place: Place) {
        guard restored else {
            pendingPlace = place
            return
        }
        switch place.route {
        case .session(let key):
            open(key)
            guard let session = session(key) else { return }
            if let surface = place.surface ?? (place.message != nil ? .gui : nil) { setSurface(surface, for: key) }
            if let panel = place.panel { session.panel = panel }
            if let seq = place.message { session.pendingMessage = seq }
        case .review(let target):
            openReview(target)
        case .settings(let section):
            sheet = .settings(section)
        default:
            show(place.route)
        }
    }

    /// The web link to a place on this window's host: what Copy Link copies.
    func link(to place: Place) -> URL? {
        accountOrigin.flatMap { AppLink.webURL(origin: $0, place: place) }
    }

    func copyLink(to place: Place) {
        guard let url = link(to: place) else { return }
        copy(url.absoluteString, say: place.message != nil ? "a link to the message" : "the link")
    }

    /// Copies text and says what was copied ("Copied the path"). The same wherever something
    /// is copied: from a menu, which has closed by then, nothing else showed it had worked.
    func copy(_ text: String, say what: String) {
        clipboard(text)
        toast("Copied \(what)")
    }

    func shareLink(to place: Place) {
        guard let url = link(to: place) else { return }
        share(url)
    }

    /// Where this window is, as a place a link can name (the focused session with its view).
    var place: Place {
        var key: String?
        if case .session(let shown) = route { key = shown } else if workspace.layout != nil { key = workspace.focusedKey }
        if let key, let session = sessions[key] {
            return Place(.session(key), surface: session.surface == .terminal ? .terminal : nil, panel: session.panel)
        }
        return Place(route)
    }

    // MARK: Switcher and search results

    /// Resume an ended or saved conversation from History and open it.
    func resume(_ item: HistoryRow) async {
        guard let hub else { return }
        let host = item.isLocal ? nil : item.host
        do {
            let result = try await hub.client(host: host).resume(item.dto.ref)
            hub.refresh(host: host)
            open(host.map { "\($0)/\(result.uid)" } ?? result.uid)
        } catch {
            toast("Couldn’t resume: \(APIError.wrap(error).message)", error: true)
        }
    }

    /// Open a match inside a conversation at its turn: the live session when it's running
    /// (a side chat opens its Chat panel), otherwise the ended record, which reads without
    /// resuming anything.
    func openHit(_ hit: SearchHit) {
        switcher = nil
        guard let hub else { return }
        let local = hit.host == hub.hostname
        let seq = hit.kind == "transcript" ? hit.excerpts.first?.seq : nil
        let live = hub.rows.first { row in
            (local ? row.isLocal : row.host == hit.host) && (hit.uid.map { row.uid == $0 } ?? (hit.harnessId != nil && row.dto.harnessId == hit.harnessId))
        }
        if let row = live {
            open(row.key)
            if hit.kind == "chat" {
                session(row.key)?.panel = .chat
            } else if let seq {
                setSurface(.gui, for: row.key)
                requestFocus(.turn(row.key, seq))
            }
            return
        }
        guard let ref = hit.ref else {
            toast(hit.kind == "chat" ? "That side chat’s session has ended; its chats are under Past chats." : "Session not found.", error: hit.kind != "chat")
            return
        }
        let key = local ? ref : "\(hit.host)/\(ref)"
        open(key)
        if let seq { requestFocus(.turn(key, seq)) }
    }

    /// Search's full page, with this text.
    func showAllResults(_ text: String) {
        switcher = nil
        search = SearchQuery(q: text)
        show(.search)
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
            return sidebarOrder.map { row in
                let here = visible.contains(row.key)
                var choices = [PaletteNode(key: "go", label: here ? "Focus its pane" : "Switch to it", icon: "arrow.right.circle", action: .openSession(row.key))]
                if !narrow && !here { choices.append(PaletteNode(key: "pane", label: "Open as a new pane", icon: "plus.rectangle.on.rectangle", detail: "Beside the focused pane", action: .openAsPane(row.key))) }
                let host = hub.multiHost ? row.host : nil
                let detail = [row.word.rawValue, row.dto.project, row.dto.branch, host, here ? "on screen" : nil].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                return PaletteNode(key: "session:\(row.key)", label: row.title, agent: row.dto.agent, detail: detail, terms: [row.dto.branch, row.host].compactMap { $0 }, action: .openSession(row.key), children: choices)
            } + notes.summaries.map { note in
                let here = visible.contains(note.key)
                var choices = [PaletteNode(key: "go", label: here ? "Focus its pane" : "Open it", icon: "arrow.right.circle", action: .openSession(note.key))]
                if !narrow && !here { choices.append(PaletteNode(key: "pane", label: "Open as a new pane", icon: "plus.rectangle.on.rectangle", detail: "Beside the focused pane", action: .openAsPane(note.key))) }
                let detail = ["Note", note.project?.name, here ? "on screen" : nil].compactMap { $0 }.joined(separator: " · ")
                return PaletteNode(key: "session:\(note.key)", label: note.title, icon: "note.text", detail: detail, terms: ["note", "scratchpad", note.project?.host].compactMap { $0 }, action: .openSession(note.key), children: choices)
            }
        case .tiles:
            let visible = Set(workspace.visibleKeys)
            return sidebarOrder.filter { !visible.contains($0.key) }.map { row in
                PaletteNode(key: "tile:\(row.key)", label: row.title, agent: row.dto.agent, detail: [row.word.rawValue, row.dto.project].joined(separator: " · "), action: .openAsPane(row.key))
            } + notes.summaries.filter { !visible.contains($0.key) }.map { note in
                PaletteNode(key: "tile:\(note.key)", label: note.title, icon: "note.text", detail: ["Note", note.project?.name].compactMap { $0 }.joined(separator: " · "), action: .openAsPane(note.key))
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
                PaletteNode(key: level, label: LaunchState.effortName(level), icon: "gauge", detail: [level == launch.effort ? "current" : "", LaunchState.effortHints[level] ?? ""].filter { !$0.isEmpty }.joined(separator: " · "), terms: [level], action: .switchEffort(level))
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
            guard let s, s.hasGUI, !s.isShell else { return [] }
            // The agents on the session's own host, not the account's.
            let host = SessionKey(s.key)?.host
            let own = s.row?.dto.agent ?? s.history?.dto.harness
            return hub.presets(host: host).filter { $0.offered && !$0.isShell }.map { p in
                PaletteNode(key: "continue:\(p.id)", label: p.id == own ? "\(p.name) (fork or resume)" : p.name, agent: p.id, detail: portable(s) ? "See what carries over to \(p.name), then continue there" : "Start \(p.name) with this conversation’s text as its first message", action: .continueIn(preset: p.id))
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
        case .openLink(let text): if let link = AppLink(text: text) { follow(link) }
        }
    }

    /// A plan that needs a confirmation goes through a sheet; the rest run now.
    /// `session`: the one the plan was made for, from a control that knows it (a pane
    /// header's), so a split's other pane, if it has the focus, isn't the one changed.
    func applyPlan(_ plan: LaunchState.Plan?, to session: SessionModel? = nil) {
        guard let plan, let s = session ?? focusedSession else { return }
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

    // MARK: New session

    /// The route of a session not started yet: New session, in the place a session has, so
    /// it becomes the session where it is once the first message starts it.
    nonisolated static let newSessionKey = "new"

    /// What the new session on screen was opened with (nil: as last time).
    private(set) var newSession: NewSessionContext?
    /// Bumped each time one opens, so each starts afresh.
    private(set) var newSessionCount = 0

    /// New session, in a session's place: what it starts with above the box it's started from.
    /// The pane chooser's (it fills that pane) and a new project's (which is mostly the folder)
    /// stay the sheet, as does one asked for with the workspace split.
    func beginNewSession(_ context: NewSessionContext) {
        if context.intoPane != nil || context.project || workspace.layout != nil {
            sheet = .newSession(context)
            return
        }
        newSession = context
        newSessionCount += 1
        route = .session(Self.newSessionKey)
        scheduleSave()
    }

    /// The new session started as `key`: it's on screen now, where New session was.
    func newSessionStarted(_ key: String) {
        newSession = nil
        open(key)
    }

    /// Asks the host for a session; its key, or nil having said why not.
    func create(_ request: NewSessionRequest, host: String? = nil) async -> String? {
        guard let hub else { return nil }
        do {
            let created = try await hub.client(host: host).create(request)
            hub.refresh(host: host)
            app.preferences.noteAgent(request.preset)
            return host.flatMap { $0 == hub.hostname ? nil : $0 }.map { "\($0)/\(created.uid)" } ?? created.uid
        } catch {
            toast("Couldn’t start it: \(APIError.wrap(error).message)", error: true)
            return nil
        }
    }

    /// The session's host carries conversations between agents itself (`features.portable`).
    func portable(_ session: SessionModel) -> Bool {
        hub?.state(host: SessionKey(session.key)?.host)?.supports("portable") ?? false
    }

    func attachedTerminal(_ session: SessionModel) -> Bool {
        hub?.state(host: SessionKey(session.key)?.host)?.supports("attachedTerminal") ?? false
    }

    /// Start a session and open it once the host lists it.
    @discardableResult
    func start(_ request: NewSessionRequest, host: String? = nil, prompt: String? = nil, intoPane: LayoutNode.Path? = nil) async -> String? {
        guard let hub else { return nil }
        let api = hub.client(host: host)
        let created: CreatedWindow
        do {
            created = try await api.create(request)
        } catch {
            toast("Couldn’t start it: \(APIError.wrap(error).message)", error: true)
            return nil
        }
        let key = host.flatMap { $0 == hub.hostname ? nil : $0 }.map { "\($0)/\(created.uid)" } ?? created.uid
        hub.refresh(host: host)
        // Started either way: a prompt that didn't go says so, and the session still opens.
        // Reported as not started, the sheet stayed and a second Start made a second session.
        if let prompt, !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            do {
                let result = try await api.send(created.uid, text: prompt)
                toast(result.outcome == .queued ? "Your prompt goes in once it’s ready" : "Sent your prompt")
            } catch {
                toast("Started, but your prompt didn’t go: \(APIError.wrap(error).message)", error: true)
            }
        }
        app.preferences.noteAgent(request.preset)
        if let intoPane { workspace.fill(intoPane, with: key) } else { open(key) }
        scheduleSave()
        return key
    }

    /// A new shell in an empty pane (the chooser's New Shell): in the project, tmux session and
    /// host of the nearest pane's session, as the web's pane picker does.
    func newShell(into path: LayoutNode.Path) async {
        guard let hub else { return }
        let near = workspace.layout?.leaves().map(\.sessionKey).filter { !LayoutNode.isPick($0) }.compactMap { hub.row($0) }.first
        let request = NewSessionRequest(preset: "shell", cwd: near?.dto.projectPath ?? "~", session: near?.dto.session ?? hub.hub.state?.defaultSession ?? "", label: "")
        _ = await start(request, host: near.flatMap { $0.isLocal ? nil : $0.host }, intoPane: path)
    }

    /// A snippet always goes to its owner's companion shell; the host checks readiness.
    func runInShell(_ snippet: String, from session: SessionModel) async {
        let command = ShellRun.command(snippet)
        guard !command.isEmpty, attachedTerminal(session) else { return }
        session.panel = .terminal
        scheduleSave()
        do {
            _ = try await session.api.openTerminal(session.ref, command: command)
            session.hub.refresh(host: SessionKey(session.key)?.host)
            if hardwareKeyboard { requestFocus(.attachedTerminal(session.key)) }
        } catch {
            toast("Couldn’t run it: \(APIError.wrap(error).message)", error: true)
        }
    }

    /// Terminate after the confirmation sheet.
    func terminate(_ key: String) async {
        guard let s = session(key) else { return }
        if await s.terminate() {
            if workspace.layout != nil, let path = workspace.layout?.leaves().first(where: { $0.sessionKey == key })?.path {
                workspace.focus(path)
                workspace.closePane()
            } else if route == .session(key) {
                // Only the session on screen closes: one ended from the sidebar left you where you were.
                closeSession()
            }
            toast("Terminated “\(s.title)”. It stays in History.")
        } else if let failure = s.notices.last, failure.tone == .error {
            // Said here: its notice was the session's, and a row's session isn't on screen.
            toast(failure.text, error: true)
        }
        pruneSessions()
        scheduleSave()
    }
}

/// The settings sections: the web's nine (`../ah/web/settingsMenu.ts`) and Voice, the app's
/// own for now (`../ah/docs/spec/14-voice.md`).
enum SettingsSection: String, CaseIterable, Sendable {
    case security, appearance, shortcuts, notifications, agents, subscriptions, voice, environment, search, system

    var title: String {
        switch self {
        case .security: return "Security"
        case .appearance: return "Appearance"
        case .shortcuts: return "Shortcuts"
        case .notifications: return "Notifications"
        case .agents: return "Agents"
        case .subscriptions: return "Subscriptions"
        case .voice: return "Voice"
        case .environment: return "Environment"
        case .search: return "Search"
        case .system: return "System"
        }
    }

    var summary: String {
        switch self {
        case .security: return "Devices, setup codes, sign-in activity"
        case .appearance: return "System, dark, light or Omarchy"
        case .shortcuts: return "Every keyboard command and its binding"
        case .notifications: return "Needs you and finished, on this device"
        case .agents: return "The agents New session offers"
        case .subscriptions: return "Model providers for side chat and review"
        case .voice: return "Dictation: who hears you, and how it’s tidied"
        case .environment: return "Variables every session starts with"
        case .search: return "The full-text index"
        case .system: return "Hooks, launcher, restart, rebuild, uploads"
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
        case .voice: return "mic"
        case .environment: return "list.bullet.indent"
        case .search: return "magnifyingglass"
        case .system: return "gearshape.2"
        }
    }
}

extension SceneSnapshot.Panel {
    /// Whether this session has this panel: Diff and Stack need a branch, Queue and Snapshots
    /// an agent (a shell has neither).
    @MainActor
    func applies(to session: SessionModel) -> Bool {
        switch self {
        case .diff, .stack: return session.row?.dto.branch != nil
        case .queue, .snapshots: return session.isLive && !session.isShell
        case .files, .chat, .preview: return true
        case .terminal:
            guard session.row != nil || session.history?.dto.kind == .ended else { return false }
            return session.hub.state(host: SessionKey(session.key)?.host)?.supports("attachedTerminal") ?? false
        }
    }
}
