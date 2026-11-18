import SwiftUI
import UniformTypeIdentifiers

/// The iPad sidebar, as ah's design system draws it: one floating glass panel over the ground
/// holding its own head (the wordmark, the host, its menus), Search or jump, the pages, every
/// session in the web's order and groups, and New session.
struct SidebarView: View {
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme

    private func newSessionLabel(keys: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "plus")
            Text("New Session").font(.ah(.callout).weight(.medium)).lineLimit(1)
            Spacer(minLength: 4)
            if keys, scene.hardwareKeyboard, let chord = scene.app.keyBindings.hint("new-session") { Keycaps(chord) }
        }
    }

    var body: some View {
        if let hub = scene.hub {
            VStack(spacing: 0) {
                head(hub)
                Button { scene.perform("switcher") } label: {
                    HStack(spacing: 8) {
                        // Part of the button's name, not a control of its own: read out alone,
                        // it said "Search" as if it opened the Search page.
                        Image(systemName: "magnifyingglass").foregroundStyle(theme.faint).accessibilityHidden(true)
                        Text("Search or jump to").foregroundStyle(theme.muted)
                        Spacer(minLength: 4)
                        if scene.hardwareKeyboard, let chord = scene.app.keyBindings.hint("switcher") { Keycaps(chord) }
                    }
                    .font(.ah(.subheadline))
                    .padding(.horizontal, 12)
                    .frame(minHeight: 38)
                    .background(theme.sunken, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.line, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .padding(.horizontal, 12)
                .padding(.bottom, 4)
                SessionListView(scene: scene, hub: hub, selection: scene.workspace.focusedKey, showsPages: true)
                    .scrollContentBackground(.hidden)
                // New session, and beside it a new note (a session of its own kind).
                HStack(spacing: 8) {
                    Button { scene.perform("new-session") } label: {
                        // On one line: its keys go first when the sidebar is too narrow for them.
                        ViewThatFits(in: .horizontal) {
                            newSessionLabel(keys: true)
                            newSessionLabel(keys: false)
                        }
                        .foregroundStyle(theme.text)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 40)
                        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.lineStrong, lineWidth: 1))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    Button { scene.perform("new-note") } label: {
                        Image(systemName: "square.and.pencil")
                            .font(.ah(.callout).weight(.medium))
                            .foregroundStyle(theme.text)
                            .frame(width: 40, height: 40)
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(theme.lineStrong, lineWidth: 1))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .accessibilityLabel("New Note")
                    .help("New Note")
                }
                .padding(.horizontal, 12)
                .padding(.bottom, 12)
            }
            .background {
                // Glass that floats over the ground: tinted, blurred, with a lit rim.
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(theme.glassTint)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(LinearGradient(colors: [.white.opacity(0.22), .white.opacity(0.04), .white.opacity(0.1)], startPoint: .topLeading, endPoint: .bottomTrailing), lineWidth: 1))
                    .shadow(color: theme.shadow, radius: 20, y: 10)
            }
            .padding(8)
            .background(theme.background.ignoresSafeArea())
            // The keyboard is for the panes; the sidebar keeps its height under it.
            .ignoresSafeArea(.keyboard)
        }
    }

    private func head(_ hub: HubStore) -> some View {
        HStack(spacing: 8) {
            AhWordmark()
            if let host = hub.hostname {
                HStack(spacing: 5) {
                    Circle().fill(hub.phase == .live ? theme.done : theme.limited).frame(width: 7, height: 7)
                    Text(host).font(.ah(.caption)).foregroundStyle(theme.text2).lineLimit(1)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(theme.text.opacity(0.06), in: Capsule())
                // As the name does: grown with the text only as far as the bar has room for,
                // or at the largest sizes the host pushed the menu and the sidebar button
                // against the panel's edge.
                .dynamicTypeSize(...DynamicTypeSize.xLarge)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Host \(host)\(hub.phase == .live ? "" : ", reconnecting")")
            }
            Spacer(minLength: 4)
            // Their 32 points inside the label, where touches land: outside it, only the glyph
            // (18 by 6 for the ellipsis) took a tap.
            MoreMenu(scene: scene, settings: true, square: 32)
                .labelStyle(.iconOnly)
                .tint(.primary)
            Button { scene.perform("toggle-sidebar") } label: {
                Image(systemName: "sidebar.left").frame(width: 32, height: 32).contentShape(Rectangle())
            }
                .buttonStyle(.plain)
                .foregroundStyle(theme.muted)
                .accessibilityLabel("Hide Sidebar")
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 10)
    }
}

/// ah's wordmark: the prompt mark and "ah" with its pink full stop.
struct AhWordmark: View {
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 7) {
            // The prompt mark: a white ">_" on ah's pink.
            // A logo: its glyph keeps the tile's size (scaled with the text, it spilled out of
            // the 26-point tile as "…").
            Text(">_")
                .font(.custom(AhType.mono, fixedSize: 12).weight(.bold))
                .foregroundStyle(theme.accentInk)
                .frame(width: 26, height: 26)
                .background(theme.accentStrong, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            (Text("ah").foregroundStyle(theme.text) + Text(".").foregroundStyle(theme.brand))
                .font(.custom(AhType.ui, size: 22, relativeTo: .title3).weight(.bold))
        }
        // The name grows a little with the text, not past where the sidebar's bar has room.
        .dynamicTypeSize(...DynamicTypeSize.xLarge)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("ah")
    }
}

/// What has no button of its own: a new project, worktrees, every command, the keys, and (in
/// the sidebar) Settings.
struct MoreMenu: View {
    let scene: SceneModel
    /// Where Settings has no button of its own (the iPad sidebar's bar, which keeps its title room).
    var settings = false
    /// A square to take touches in, where the label isn't a bar's (which sizes its own).
    var square: CGFloat? = nil

    var body: some View {
        Menu {
            if settings {
                Button("Settings…", systemImage: "gearshape") { scene.perform("go-settings") }
                Divider()
            }
            Button("New Project…", systemImage: "folder.badge.plus") { scene.perform("new-project") }
            Button("Worktrees…", systemImage: "arrow.triangle.branch") { scene.perform("worktrees") }
            Divider()
            Button("All Commands…", systemImage: "command") { scene.perform("command-palette") }
            if scene.hardwareKeyboard {
                Button("Keyboard Shortcuts", systemImage: "keyboard") { scene.perform("show-shortcuts") }
            }
        } label: {
            if let square {
                Label("More", systemImage: "ellipsis").frame(width: square, height: square).contentShape(Rectangle())
            } else {
                Label("More", systemImage: "ellipsis")
            }
        }
        .menuOrder(.fixed)
    }
}

extension SceneSnapshot.Route {
    /// Which top-level page this is (sessions count as their own page).
    var page: String {
        switch self {
        case .inbox: return "inbox"
        case .sessions: return "sessions"
        case .history: return "history"
        case .search: return "search"
        case .review: return "review"
        case .settings: return "settings"
        case .worktrees: return "worktrees"
        case .session: return "session"
        }
    }
}

/// A top-level page by route, for the iPad detail and each iPhone tab's root.
struct PageView: View {
    @Bindable var scene: SceneModel
    let route: SceneSnapshot.Route
    @State private var review: ReviewModel?
    @State private var search: SearchModel?
    @Environment(\.theme) private var theme

    /// Pages sit on the theme's background like sessions and the sidebar do (in dark mode
    /// the system's pure black stood apart from them).
    var body: some View {
        page
            .scrollContentBackground(.hidden)
            .background(theme.background.ignoresSafeArea())
    }

    @ViewBuilder
    private var page: some View {
        if let hub = scene.hub {
            switch route {
            case .inbox, .settings, .worktrees, .session:
                InboxView(scene: scene, hub: hub)
            case .sessions:
                SessionListView(scene: scene, hub: hub, selection: nil).ahPage("Sessions")
            case .history:
                HistoryView(scene: scene, hub: hub).ahPage("History")
            case .search:
                if let search { SearchView(scene: scene, model: search) } else { Color.clear.onAppear { search = SearchModel(api: hub.api) } }
            case .review(let target):
                if let review {
                    if target.stack != nil {
                        StackCockpitView(scene: scene, model: review, route: target)
                    } else {
                        // A phone's Review tab keeps the list as its root; the scene's path pushes
                        // the stack and its layers. Declared here, it stands while they're up.
                        ReviewHomeView(scene: scene, model: review)
                            .navigationDestination(for: ReviewRoute.self) { target in
                                Group {
                                    if target.pr == nil {
                                        StackCockpitView(scene: scene, model: review, route: target)
                                    } else {
                                        LayerPage(scene: scene, model: review, route: target)
                                    }
                                }
                                .scrollContentBackground(.hidden)
                                .background(theme.background.ignoresSafeArea())
                            }
                    }
                } else {
                    Color.clear.onAppear { review = ReviewModel(api: hub.api) }
                }
            }
        } else {
            ProgressView()
        }
    }
}

/// The Review tab on a phone: the list, under the scene's path.
struct ReviewTab: View {
    @Bindable var scene: SceneModel
    let route: SceneSnapshot.Route

    var body: some View {
        NavigationStack(path: $scene.reviewPath) { PageView(scene: scene, route: route) }
    }
}

/// The iPad detail: the split's panes, or one session, or a page.
struct DetailView: View {
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// What fills the detail: the panes, one session, or a page.
    private var kind: Int {
        if scene.workspace.layout != nil { return 0 }
        if case .session(let key) = scene.route { return key == SceneModel.newSessionKey ? 3 : 1 }
        return 2
    }

    var body: some View {
        ZStack {
            if scene.workspace.layout != nil {
                WorkspaceView(scene: scene).transition(.opacity)
            } else if case .session(let key) = scene.route, key == SceneModel.newSessionKey {
                // New session, where the session it starts will be.
                NewSessionPane(scene: scene).id(scene.newSessionCount).modifier(AhPanel()).transition(.opacity)
            } else if case .session(let key) = scene.route, NoteKey.isNote(key) {
                // A note, where a session would be: its own editor, no transcript or terminal.
                NoteScreen(scene: scene, key: key).id(key).modifier(AhPanel()).transition(.opacity)
            } else if case .session(let key) = scene.route, let session = scene.session(key) {
                SingleSessionView(scene: scene, session: session).transition(.opacity)
            } else {
                NavigationStack { PageView(scene: scene, route: scene.route) }.modifier(AhPanel()).transition(.opacity)
            }
            if scene.workspace.scratchVisible, let key = scene.workspace.scratchKey, let session = scene.session(key) {
                ScratchpadView(scene: scene, session: session)
            }
        }
        // A page gives way to a session (or the panes) through a short fade, where it cut.
        // Only the kind of thing changing does it: one session to the next stays in place.
        .animation(.smooth(duration: 0.18), value: kind)
        // A session's screen stands above the keyboard by itself (UIKit's keyboard layout guide:
        // `ConversationController`, `AboveKeyboard`), and SwiftUI lets the keyboard go only at the
        // root of what's hosted, which in the split is here: left to the column as well, the box
        // rose twice, a keyboard's height of nothing under it. Pages (and New session) keep the
        // column's own room for it, SwiftUI's.
        .ignoresSafeArea(.keyboard, edges: kind == 0 || kind == 1 ? .all : [])
        // The scratchpad drops in from the top and goes back up: its transition was written,
        // and nothing ever ran it.
        .animation(reduceMotion ? .smooth(duration: 0.15) : .snappy(duration: 0.28), value: scene.workspace.scratchVisible)
        .background(theme.background)
    }
}

/// One session filling the detail: drop another session (or drag the sidebar's) on an edge
/// to split beside it.
private struct SingleSessionView: View {
    let scene: SceneModel
    let session: SessionModel
    @State private var zone: LayoutNode.Drop?

    var body: some View {
        GeometryReader { proxy in
            SessionScreen(session: session, scene: scene)
                .overlay { if let zone, zone != .center { DropZoneHighlight(zone: zone) } }
                .onDrop(of: [.agentHubSession], delegate: PaneDrop(scene: scene, path: nil, size: proxy.size, zone: $zone))
                .modifier(AhPanel())
        }
    }
}

/// The scratchpad (⌃`): one shell floating over everything; hiding it leaves it running.
private struct ScratchpadView: View {
    let scene: SceneModel
    let session: SessionModel
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                // "Shell": a note is something else (`NoteScreen`), and the two must not read alike.
                Label("Scratchpad Shell", systemImage: "terminal").font(.ah(.caption).weight(.semibold))
                Spacer()
                Button { Task { await scene.toggleScratchpad() } } label: { Image(systemName: "chevron.down") }.accessibilityLabel("Hide the scratchpad")
            }
            .padding(10)
            AboveKeyboard { TerminalScreen(session: session, scene: scene) }
        }
        .background(theme.background, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(theme.faint.opacity(0.4)))
        .padding(.horizontal, 40)
        .padding(.vertical, 60)
        .shadow(radius: 30)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}

/// Panes laid out flat from the layout's boxes, so a session's view (and its terminal)
/// survives the tree changing around it; seams drag to resize. Maximized, or in a window too
/// small for every pane to have room, it shows the focused pane alone (the others stay alive
/// underneath) with a strip to switch between them.
struct WorkspaceView: View {
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static let minimumPane = CGSize(width: WorkspaceModel.minimumPane.width, height: WorkspaceModel.minimumPane.height)
    /// Panes are cards with a gutter between them, as iPadOS tiles windows.
    private let gap: CGFloat = 10
    private let stripHeight: CGFloat = 36

    private struct Entry: Identifiable {
        let id: String
        let tile: LayoutNode.Tile
        let index: Int
    }

    /// Stable view identity: a session's pane keeps its view as the tree changes; choosers
    /// and duplicate viewers of one session get their own.
    private func identified(_ tiles: [LayoutNode.Tile]) -> [Entry] {
        var seen: [String: Int] = [:]
        return tiles.enumerated().map { index, tile in
            if LayoutNode.isPick(tile.sessionKey) { return Entry(id: "pick@" + LayoutNode.encode(tile.path), tile: tile, index: index) }
            let n = seen[tile.sessionKey, default: 0]
            seen[tile.sessionKey] = n + 1
            return Entry(id: n == 0 ? tile.sessionKey : "\(tile.sessionKey)#\(n)", tile: tile, index: index)
        }
    }

    var body: some View {
        let workspace = scene.workspace
        let geometry = workspace.layout?.tiles() ?? (tiles: [], seams: [])
        let focused = workspace.focusPath
        GeometryReader { proxy in
            let size = proxy.size
            let fits = workspace.layout?.fits(width: size.width, height: size.height, minWidth: Self.minimumPane.width, minHeight: Self.minimumPane.height) ?? true
            let _ = workspace.canvas = (Double(size.width), Double(size.height))
            let single = workspace.zoom || !fits
            let top: CGFloat = single && !workspace.zoom ? stripHeight : 0
            let entries = identified(geometry.tiles)
            ZStack(alignment: .topLeading) {
                ForEach(entries) { entry in
                    let tile = entry.tile
                    let index = entry.index
                    let isFocused = tile.path == focused
                    let hidden = single && !isFocused
                    let box = single && isFocused ? LayoutNode.Box(x: 0, y: 0, w: 1, h: 1) : tile.box
                    let frame = CGSize(width: max(0, box.w * size.width - gap), height: max(0, box.h * (size.height - top) - gap))
                    PaneView(scene: scene, tile: tile, focused: isFocused, index: index, count: entries.count, size: frame)
                        .frame(width: frame.width, height: frame.height)
                        .offset(x: box.x * size.width + gap / 2, y: top + box.y * (size.height - top) + gap / 2)
                        .opacity(hidden ? 0 : 1)
                        .allowsHitTesting(!hidden)
                        .accessibilityHidden(hidden)
                        .transition(reduceMotion ? .opacity : .scale(scale: 0.97).combined(with: .opacity))
                }
                if !single {
                    ForEach(geometry.seams, id: \.path) { seam in
                        SeamHandle(scene: scene, seam: seam, size: size)
                    }
                }
                if single && !workspace.zoom {
                    PaneStrip(scene: scene, tiles: geometry.tiles, focused: focused)
                        .frame(width: size.width, height: stripHeight)
                }
                // A maximized session says so in its own header; an empty chooser has none.
                if workspace.zoom, entries.first(where: { $0.tile.path == focused }).map({ LayoutNode.isPick($0.tile.sessionKey) }) ?? false {
                    ZoomBadge(scene: scene, count: entries.count, index: entries.firstIndex { $0.tile.path == focused } ?? 0)
                        .frame(width: size.width, alignment: .topTrailing)
                }
            }
        }
        // ah's ground behind the panels.
        .background(theme.background)
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: geometry.tiles.map(\.box))
        .animation(reduceMotion ? nil : .snappy(duration: 0.22), value: workspace.zoom)
        .animation(reduceMotion ? nil : .snappy(duration: 0.15), value: focused)
    }
}

private struct PaneView: View {
    let scene: SceneModel
    let tile: LayoutNode.Tile
    let focused: Bool
    let index: Int
    let count: Int
    let size: CGSize
    @State private var zone: LayoutNode.Drop?
    @Environment(\.theme) private var theme
    static let corner: CGFloat = 16

    var body: some View {
        Group {
            if LayoutNode.isPick(tile.sessionKey) {
                ChooserPane(scene: scene, path: tile.path)
            } else if NoteKey.isNote(tile.sessionKey) {
                NoteScreen(scene: scene, key: tile.sessionKey, compactHeader: tile.box.w < 0.5 || tile.box.h < 0.5, paneFocused: focused, pane: tile.path)
            } else if let session = scene.session(tile.sessionKey) {
                SessionScreen(session: session, scene: scene, paneFocused: focused, compactHeader: tile.box.w < 0.5 || tile.box.h < 0.5, pane: tile.path)
            } else {
                // Two ways on, by touch as by keys: it said "pick another" with nothing to pick with.
                ContentUnavailableView {
                    Label("Session Ended", systemImage: "questionmark.square.dashed")
                } description: {
                    Text("Choose another session for this pane, or close it.")
                } actions: {
                    Button("Choose a Session") {
                        scene.workspace.focus(tile.path)
                        scene.perform("replace-pane")
                    }
                    .buttonStyle(.bordered)
                    Button("Close Pane") {
                        scene.workspace.focus(tile.path)
                        scene.perform("close-pane")
                    }
                }
            }
        }
        .background(theme.surface)
        .overlay { if let zone { DropZoneHighlight(zone: zone) } }
        .clipShape(RoundedRectangle(cornerRadius: Self.corner, style: .continuous))
        // The focused pane wears a tint ring; the rest a hairline.
        .overlay {
            RoundedRectangle(cornerRadius: Self.corner, style: .continuous)
                .strokeBorder(focused ? theme.accentStrong.opacity(0.9) : theme.line, lineWidth: focused ? 1.5 : 0.5)
                .allowsHitTesting(false)
        }
        .simultaneousGesture(TapGesture().onEnded { Task { await scene.tapPane(tile.path) } })
        .onContinuousHover { phase in
            if case .active = phase { scene.hoverFocus(tile.path) }
        }
        .onDrop(of: [.agentHubSession], delegate: PaneDrop(scene: scene, path: tile.path, size: size, zone: $zone))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Pane \(index + 1) of \(count)\(focused ? ", focused" : "")")
    }
}

/// Where a dragged session or pane would land: an edge splits beside, the center replaces
/// (a session) or swaps (a pane).
private struct DropZoneHighlight: View {
    let zone: LayoutNode.Drop
    @Environment(\.theme) private var theme

    var body: some View {
        GeometryReader { proxy in
            let w = proxy.size.width, h = proxy.size.height
            let rect: CGRect = {
                switch zone {
                case .left: return CGRect(x: 0, y: 0, width: w / 2, height: h)
                case .right: return CGRect(x: w / 2, y: 0, width: w / 2, height: h)
                case .top: return CGRect(x: 0, y: 0, width: w, height: h / 2)
                case .bottom: return CGRect(x: 0, y: h / 2, width: w, height: h / 2)
                case .center: return CGRect(x: 0, y: 0, width: w, height: h)
                }
            }()
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(theme.accentStrong.opacity(0.18))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(theme.accentStrong, style: StrokeStyle(lineWidth: 2, dash: [6, 4])))
                .frame(width: rect.width - 8, height: rect.height - 8)
                .offset(x: rect.minX + 4, y: rect.minY + 4)
        }
        .allowsHitTesting(false)
        .animation(.snappy(duration: 0.12), value: zone)
    }
}

/// Drops onto a pane: plain text is a session key (from the sidebar) or an encoded pane path.
struct PaneDrop: DropDelegate {
    let scene: SceneModel
    /// Nil for the single view (no split yet).
    let path: LayoutNode.Path?
    let size: CGSize
    @Binding var zone: LayoutNode.Drop?

    func validateDrop(info: DropInfo) -> Bool { info.hasItemsConforming(to: [.agentHubSession]) }

    func dropEntered(info: DropInfo) {
        scene.workspace.dragging = true
        zone = Self.zone(info.location, size)
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        zone = Self.zone(info.location, size)
        return DropProposal(operation: .move)
    }

    func dropExited(info: DropInfo) {
        zone = nil
        scene.workspace.dragging = false
    }

    func performDrop(info: DropInfo) -> Bool {
        let target = zone ?? .center
        zone = nil
        scene.workspace.dragging = false
        guard let provider = info.itemProviders(for: [.agentHubSession]).first else { return false }
        let path = path
        let scene = scene
        _ = provider.loadDataRepresentation(forTypeIdentifier: UTType.agentHubSession.identifier) { data, _ in
            guard let data, let drag = try? JSONDecoder().decode(SessionDrag.self, from: data) else { return }
            Task { @MainActor in scene.dropText(drag.key, onto: path, where: target) }
        }
        return true
    }

    /// The nearest edge within a quarter of the pane, else the center.
    static func zone(_ point: CGPoint, _ size: CGSize) -> LayoutNode.Drop {
        guard size.width > 0, size.height > 0 else { return .center }
        let x = point.x / size.width, y = point.y / size.height
        let edges: [(LayoutNode.Drop, CGFloat)] = [(.left, x), (.right, 1 - x), (.top, y), (.bottom, 1 - y)]
        let nearest = edges.min { $0.1 < $1.1 }!
        return nearest.1 < 0.25 ? nearest.0 : .center
    }
}

/// One pane at a time (a window too small for the layout): every pane as a tab.
private struct PaneStrip: View {
    let scene: SceneModel
    let tiles: [LayoutNode.Tile]
    let focused: LayoutNode.Path?
    @Environment(\.theme) private var theme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(tiles, id: \.path) { tile in
                    let active = tile.path == focused
                    let row = scene.hub?.row(tile.sessionKey)
                    Button {
                        Task { await scene.tapPane(tile.path) }
                    } label: {
                        HStack(spacing: 6) {
                            if let row { StatusPill(word: row.word, compact: true) }
                            if NoteKey.isNote(tile.sessionKey) { Image(systemName: "note.text").font(.ah(.caption)) }
                            Text(LayoutNode.isPick(tile.sessionKey) ? "Empty pane" : (scene.noteTitle(tile.sessionKey) ?? row?.title ?? scene.session(tile.sessionKey)?.title ?? "Session"))
                                .font(.ah(.caption).weight(active ? .semibold : .regular))
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(active ? theme.accentStrong.opacity(0.2) : theme.raised, in: Capsule())
                        .foregroundStyle(active ? theme.text : theme.muted)
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .accessibilityAddTraits(active ? .isSelected : [])
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
        }
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("This window is too small for \(tiles.count) panes side by side, so they show one at a time")
    }
}

/// Maximized: which pane this is, and the way back.
private struct ZoomBadge: View {
    let scene: SceneModel
    let count: Int
    let index: Int
    @Environment(\.theme) private var theme

    var body: some View {
        Button {
            scene.perform("maximize-pane")
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down.right.and.arrow.up.left")
                Text("Maximized · \(index + 1) of \(count)")
                if let chord = scene.app.keyBindings.hint("maximize-pane") { Keycaps(chord) }
            }
            .font(.ah(.caption).weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(theme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .padding(10)
        .accessibilityLabel("Maximized, pane \(index + 1) of \(count). Restore the layout")
    }
}

/// The commands for one pane, the same ones its keys, the palette and the menu bar run:
/// for its context menu and its header's split button. Each focuses the pane first.
struct PaneMenuItems: View {
    let scene: SceneModel
    /// Nil for the single view (splitting starts from it).
    let path: LayoutNode.Path?

    var body: some View {
        Section {
            item("split-right")
            item("split-below")
            item("split-left")
            item("split-above")
        }
        Section {
            item("maximize-pane", title: scene.workspace.zoom ? "Restore Layout" : nil)
            item("balance-panes")
            item("toggle-split")
            item("replace-pane")
            item("open-in-pane")
        }
        if scene.workspace.splitOpen {
            Menu {
                item("swap-pane-left")
                item("swap-pane-right")
                item("swap-pane-up")
                item("swap-pane-down")
            } label: { Label("Swap with…", systemImage: "arrow.left.arrow.right") }
            Menu {
                item("move-pane-left")
                item("move-pane-right")
                item("move-pane-up")
                item("move-pane-down")
            } label: { Label("Move", systemImage: "arrow.up.and.down.and.arrow.left.and.right") }
        }
        Section {
            item("close-pane", role: .destructive)
        }
    }

    @ViewBuilder private func item(_ id: CommandID, title: String? = nil, role: ButtonRole? = nil) -> some View {
        Button(role: role) {
            if let path { scene.workspace.focus(path) }
            scene.perform(id)
        } label: {
            Label(title ?? CommandCatalog.label(id), systemImage: CommandCatalog.icon(id))
            if let chord = scene.app.keyBindings.hint(id) { Text(chord.formatted()) }
        }
        .disabled(!scene.isAvailable(id))
    }
}

/// An empty pane: search for a session right here (it takes the keyboard after a split),
/// start a new one, or cancel.
/// Its list stands above the keyboard in a short pane (`AboveKeyboard`): the panes let go of the
/// column's keyboard room, and the sessions in them stand above it by themselves.
private struct ChooserPane: View {
    let scene: SceneModel
    let path: LayoutNode.Path

    var body: some View {
        AboveKeyboard { ChooserContent(scene: scene, path: path) }
            .ignoresSafeArea(.container, edges: .bottom)
    }
}

private struct ChooserContent: View {
    let scene: SceneModel
    let path: LayoutNode.Path
    @State private var query = ""
    @State private var selection = 0
    @FocusState private var focused: Bool
    @Environment(\.theme) private var theme

    private var rows: [SessionRow] {
        let visible = Set(scene.workspace.visibleKeys)
        let all = scene.sidebarOrder.filter { !visible.contains($0.key) }
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return Array(all.prefix(8)) }
        return all.map { row in (row, max(CommandMatcher.fuzzy(q, row.title) * 2, CommandMatcher.fuzzy(q, row.dto.project), CommandMatcher.fuzzy(q, row.dto.branch ?? ""))) }
            .filter { $0.1 > 0 }
            .sorted { $0.1 > $1.1 }
            .prefix(8)
            .map(\.0)
    }

    /// Notes not on screen, the newest (or those the search finds).
    private var noteRows: [NotesModel.Summary] {
        let visible = Set(scene.workspace.visibleKeys)
        return scene.notes.search(query, limit: 12).filter { !visible.contains($0.key) }.prefix(query.isEmpty ? 3 : 5).map { $0 }
    }

    private var choiceKeys: [String] { rows.map(\.key) + noteRows.map(\.key) }

    var body: some View {
        let rows = rows
        VStack(spacing: 14) {
            Text("Open in This Pane").font(.ah(.headline))
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.muted)
                TextField("Search Sessions", text: $query)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: query) { _, _ in selection = 0 }
                    // The sessions' rows, then the notes': one list for the arrows and Return.
                    .onSubmit { let keys = choiceKeys; if keys.indices.contains(selection) { scene.fillPane(path, with: keys[selection]) } }
                    .onKeyPress(.upArrow) { let n = choiceKeys.count; if n > 0 { selection = (selection - 1 + n) % n }; return .handled }
                    .onKeyPress(.downArrow) { let n = choiceKeys.count; if n > 0 { selection = (selection + 1) % n }; return .handled }
                    .onKeyPress(.escape) { scene.cancelChooser(path); return .handled }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(theme.tile, in: Capsule())
            VStack(spacing: 2) {
                // What the web's pane picker leads with: a shell here, or a new session.
                if query.isEmpty {
                    action("New Shell", "terminal") { Task { await scene.newShell(into: path) } }
                    action("New Session…", "plus") {
                        scene.workspace.focus(path)
                        scene.sheet = .newSession(SceneModel.NewSessionContext(intoPane: path))
                    }
                    action("New Note", "square.and.pencil") { scene.newNote(into: path) }
                    Divider().padding(.vertical, 4)
                }
                ForEach(Array(rows.enumerated()), id: \.element.key) { index, row in
                    HStack(spacing: 10) {
                        AgentMark(agent: row.dto.agent, size: 22)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.title).font(.ah(.callout)).lineLimit(1)
                            Text(row.dto.project).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                        }
                        Spacer()
                        StatusPill(word: row.word, compact: true)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(index == selection ? theme.accentStrong.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .contentShape(Rectangle())
                    .onTapGesture { scene.fillPane(path, with: row.key) }
                    .onHover { if $0 { selection = index } }
                    // One stop a row, which says when it's the one picked.
                    .accessibilityElement(children: .combine)
                    .accessibilityAddTraits(index == selection ? [.isButton, .isSelected] : .isButton)
                }
            }
            let notes = noteRows
            if !notes.isEmpty {
                VStack(spacing: 2) {
                    ForEach(Array(notes.enumerated()), id: \.element.id) { offset, note in
                        let index = rows.count + offset
                        HStack(spacing: 10) {
                            Image(systemName: "note.text").foregroundStyle(theme.accent).frame(width: 22)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(note.title).font(.ah(.callout)).lineLimit(1)
                                Text(note.project?.name ?? "Note").font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                        .background(index == selection ? theme.accentStrong.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .contentShape(Rectangle())
                        .onTapGesture { scene.fillPane(path, with: note.key) }
                        .onHover { if $0 { selection = index } }
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(index == selection ? [.isButton, .isSelected] : .isButton)
                    }
                }
            }
            Button("Cancel", role: .cancel) { scene.cancelChooser(path) }
                .buttonStyle(.borderless)
                .tint(theme.muted)
                .font(.ah(.callout))
        }
        .frame(maxWidth: 420)
        .padding(20)
        .frame(maxWidth: .infinity)
        // Scrolls when it can't fit (the on-screen keyboard up in a short pane), so its title
        // isn't pushed up under the status bar; centered while it fits.
        .wrappedInScrollWhenTall()
        .onAppear { if scene.focusRequest?.target == .chooser(path) || scene.workspace.focusPath == path { focused = true } }
        .onChange(of: scene.focusRequest) { _, request in if request?.target == .chooser(path) { focused = true } }
        .onChange(of: focused) { _, now in if now { scene.didFocus(.chooser(path)) } else { scene.didBlur(.chooser(path)) } }
    }

    private func action(_ title: String, _ symbol: String, run: @escaping () -> Void) -> some View {
        Button(action: run) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.ah(.body)).foregroundStyle(theme.accent).frame(width: 22)
                Text(title).font(.ah(.callout))
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
    }
}

private struct SeamHandle: View {
    let scene: SceneModel
    let seam: LayoutNode.Seam
    let size: CGSize
    @State private var dragging = false
    @Environment(\.theme) private var theme

    var body: some View {
        let box = seam.box
        let thickness: CGFloat = 12
        let x = seam.row ? (box.x + box.w * seam.ratio) * size.width - thickness / 2 : box.x * size.width
        let y = seam.row ? box.y * size.height : (box.y + box.h * seam.ratio) * size.height - thickness / 2
        Rectangle()
            .fill(dragging ? theme.accentStrong.opacity(0.5) : Color.clear)
            .frame(width: seam.row ? thickness : box.w * size.width, height: seam.row ? box.h * size.height : thickness)
            .contentShape(Rectangle())
            .offset(x: x, y: y)
            .hoverEffect(.highlight)
            .gesture(DragGesture(coordinateSpace: .named("workspace")).onChanged { value in
                if !dragging {
                    dragging = true
                    scene.workspace.dragging = true
                }
                let ratio = seam.row
                    ? (value.location.x / size.width - box.x) / box.w
                    : (value.location.y / size.height - box.y) / box.h
                scene.workspace.setRatio(at: seam.path, min(0.85, max(0.15, ratio)))
            }.onEnded { _ in
                dragging = false
                scene.workspace.dragging = false
                scene.suppressHover()
                scene.scheduleSave()
            })
            .accessibilityRepresentation {
                Slider(value: Binding(get: { seam.ratio }, set: { scene.workspace.setRatio(at: seam.path, $0) }), in: 0.15...0.85) { Text("Pane divider") }
            }
    }
}

/// What floats over a window without taking touches, but for its own: which-key, the
/// submap legend, toasts, nudges.
struct OverlayLayer: View {
    let scene: SceneModel
    let targets: OverlayTargets

    var body: some View {
        ZStack {
            if !scene.whichKey.isEmpty || scene.pendingChord != nil {
                WhichKeyHUD(rows: scene.whichKey, pending: scene.pendingChord?.formatted()).frame(maxHeight: .infinity, alignment: .bottom).allowsHitTesting(false)
            }
            if let mode = scene.workspace.submap {
                SubmapHUD(mode: mode).frame(maxHeight: .infinity, alignment: .top).allowsHitTesting(false)
            }
            // Above the tab bar or the composer, not over them (the overlay is a window of its
            // own and doesn't know what's under it; the scene says where they start).
            GeometryReader { geometry in
                let lift = scene.toastFloor.map { max(0, geometry.frame(in: .global).maxY - $0 - 12) } ?? 0
                // Over the composer they sit above, across as well as up.
                let shift = scene.sheetUp ? 0 : scene.composerMidX.map { $0 - geometry.frame(in: .global).midX } ?? 0
                ToastStack(scene: scene, targets: targets)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .padding(.bottom, lift)
                    .offset(x: shift)
                    .animation(.snappy(duration: 0.25), value: lift)
            }
            NudgeStack(scene: scene, targets: targets).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: scene.narrow ? .top : .topTrailing)
        }
    }
}

private extension View {
    /// Centered in the space while it fits; scrolling from the top once it doesn't. One view
    /// either way: swapping between a fitting and a scrolling copy (ViewThatFits) tore down a
    /// focused field mid keyboard animation, and UIKit crashed on it.
    func wrappedInScrollWhenTall() -> some View { modifier(ScrollWhenTall()) }
}

private struct ScrollWhenTall: ViewModifier {
    @State private var height: CGFloat = 0

    func body(content: Content) -> some View {
        ScrollView {
            content.frame(minHeight: height)
        }
        .scrollBounceBehavior(.basedOnSize)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
    }
}
