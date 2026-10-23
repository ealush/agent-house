import Foundation

/// Where a window was, so it reopens exactly there. Navigation and layout metadata only:
/// never credentials, draft text, titles or transcript content. Versioned; a newer
/// version than this build understands is refused rather than erased.
struct SceneSnapshot: Codable, Equatable, Sendable {
    static let currentVersion = 2

    var version: Int
    var sceneID: String
    /// The host this window shows (an account's origin), nil before setup.
    var hostOrigin: String?
    var route: Route
    /// The open session (iPhone push, iPad single pane), with its view state.
    var session: SessionPlacement?
    /// iPad tiling: workspaces 1–9 for this window, and which pane has focus.
    var workspaces: Workspaces
    var focusedPane: LayoutNode.Path?
    var maximized: Bool
    var sidebarVisible: Bool
    var scratchpadVisible: Bool
    var historyFilter: String
    var search: SearchQuery?
    /// Milliseconds since the epoch.
    var savedAt: Double

    init(sceneID: String, hostOrigin: String?, route: Route = .inbox, session: SessionPlacement? = nil, workspaces: Workspaces = Workspaces(), focusedPane: LayoutNode.Path? = nil, maximized: Bool = false, sidebarVisible: Bool = true, scratchpadVisible: Bool = false, historyFilter: String = "", search: SearchQuery? = nil, savedAt: Double = Date().timeIntervalSince1970 * 1000) {
        version = Self.currentVersion
        self.sceneID = sceneID
        self.hostOrigin = hostOrigin
        self.route = route
        self.session = session
        self.workspaces = workspaces
        self.focusedPane = focusedPane
        self.maximized = maximized
        self.sidebarVisible = sidebarVisible
        self.scratchpadVisible = scratchpadVisible
        self.historyFilter = historyFilter
        self.search = search
        self.savedAt = savedAt
    }

    enum Route: Codable, Equatable, Sendable, Hashable {
        case inbox
        case sessions
        case history
        case search
        case review(ReviewRoute)
        case settings(String?)
        case worktrees
        /// A session full screen (phone), by its key ("uid" or "host/uid").
        case session(String)
    }

    struct SessionPlacement: Codable, Equatable, Sendable, Hashable {
        var key: String
        var surface: Surface
        var panel: Panel?
        /// The transcript entry at the top of the screen, and how far into it.
        var scroll: ScrollAnchor?
        /// The composer had focus: give it back so the first keystroke lands there.
        var composerFocused: Bool

        init(key: String, surface: Surface, panel: Panel? = nil, scroll: ScrollAnchor? = nil, composerFocused: Bool = false) {
            self.key = key
            self.surface = surface
            self.panel = panel
            self.scroll = scroll
            self.composerFocused = composerFocused
        }
    }

    enum Surface: String, Codable, Sendable, Hashable { case gui, terminal }

    enum Panel: String, Codable, Sendable, Hashable, CaseIterable {
        case diff, files, chat, queue, snapshots, preview, stack

        var command: CommandID { CommandID(rawValue: "panel-\(rawValue)") }
        var title: String {
            switch self {
            case .diff: return "Diff"
            case .files: return "Files"
            case .chat: return "Chat"
            case .queue: return "Queue"
            case .snapshots: return "Snapshots"
            case .preview: return "Preview"
            case .stack: return "Stack"
            }
        }
        var symbol: String {
            switch self {
            case .diff: return "plusminus"
            case .files: return "folder"
            case .chat: return "bubble.left.and.text.bubble.right"
            case .queue: return "list.bullet.rectangle"
            case .snapshots: return "clock.arrow.circlepath"
            case .preview: return "safari"
            case .stack: return "square.stack.3d.up"
            }
        }
    }

    struct ScrollAnchor: Codable, Equatable, Sendable, Hashable {
        /// Feed `seq` of the topmost visible block; nil means "at the newest message".
        var seq: Int?
        var offset: Double
    }

    // MARK: Decoding older versions

    private enum CodingKeys: String, CodingKey {
        case version, sceneID, hostOrigin, route, session, workspaces, focusedPane, maximized, sidebarVisible, scratchpadVisible, historyFilter, search, savedAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decode(Int.self, forKey: .version)
        sceneID = try c.decode(String.self, forKey: .sceneID)
        hostOrigin = try c.decodeIfPresent(String.self, forKey: .hostOrigin)
        // v1 carried only the host: everything else opens at its default.
        route = try c.decodeIfPresent(Route.self, forKey: .route) ?? .inbox
        session = try c.decodeIfPresent(SessionPlacement.self, forKey: .session)
        workspaces = try c.decodeIfPresent(Workspaces.self, forKey: .workspaces) ?? Workspaces()
        focusedPane = try c.decodeIfPresent(LayoutNode.Path.self, forKey: .focusedPane)
        maximized = try c.decodeIfPresent(Bool.self, forKey: .maximized) ?? false
        sidebarVisible = try c.decodeIfPresent(Bool.self, forKey: .sidebarVisible) ?? true
        scratchpadVisible = try c.decodeIfPresent(Bool.self, forKey: .scratchpadVisible) ?? false
        historyFilter = try c.decodeIfPresent(String.self, forKey: .historyFilter) ?? ""
        search = try c.decodeIfPresent(SearchQuery.self, forKey: .search)
        savedAt = try c.decodeIfPresent(Double.self, forKey: .savedAt) ?? 0
    }

    /// An older journal entry brought up to this version; nil for a future one.
    func upgraded() -> SceneSnapshot? {
        guard version <= Self.currentVersion else { return nil }
        var next = self
        next.version = Self.currentVersion
        return next
    }
}

/// Fits a restored window onto what the host has now: sessions that ended reopen as their
/// ended record (resume in place), sessions that are gone fall back to the Inbox, and panes
/// whose session vanished ask what goes there instead. Never resurrects live state.
enum RestorationReconciler {
    struct Outcome: Equatable, Sendable {
        var snapshot: SceneSnapshot
        /// Shown once: what couldn't come back ("“Fix login” has ended").
        var notices: [String]
    }

    enum Presence: Equatable, Sendable {
        case live
        /// Ended but kept: reopen its record (ref) so Resume is one tap.
        case ended(ref: String, title: String)
        case gone
    }

    /// `presence` answers for a session key on the current state of every host.
    static func reconcile(_ snapshot: SceneSnapshot, presence: (String) -> Presence) -> Outcome {
        var out = snapshot
        var notices: [String] = []

        if let placement = snapshot.session {
            switch presence(placement.key) {
            case .live: break
            case .ended(let ref, let title):
                // Keep the place; the session view shows its ended record with Resume.
                out.session = SceneSnapshot.SessionPlacement(key: ref, surface: .gui, panel: nil, scroll: placement.scroll, composerFocused: false)
                if case .session = out.route { out.route = .session(ref) }
                notices.append("“\(title)” has ended. Resume it to continue.")
            case .gone:
                out.session = nil
                if case .session = out.route { out.route = .inbox }
                notices.append("The session you had open is no longer on this host.")
            }
        }

        var lost = 0
        for (n, slot) in snapshot.workspaces.slots {
            var next = slot
            if let layout = slot.layout {
                next.layout = layout.mapKeys { key in
                    if LayoutNode.isPick(key) { return key }
                    switch presence(key) {
                    case .live: return key
                    case .ended(let ref, _): return ref
                    case .gone:
                        lost += 1
                        return LayoutNode.pickKey()
                    }
                }
            }
            if let selected = slot.selected {
                switch presence(selected) {
                case .live: break
                case .ended(let ref, _): next.selected = ref
                case .gone:
                    lost += 1
                    next.selected = nil
                }
            }
            out.workspaces.slots[n] = next
        }
        if lost > 0 { notices.append(lost == 1 ? "A pane’s session is gone; choose what goes there." : "\(lost) panes’ sessions are gone; choose what goes there.") }
        if let pane = out.focusedPane, let layout = out.workspaces.slots[out.workspaces.current]?.layout, layout.node(at: pane) == nil {
            out.focusedPane = layout.leaves().first?.path
        }
        return Outcome(snapshot: out, notices: notices)
    }
}
