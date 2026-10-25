import SwiftUI
import UniformTypeIdentifiers

/// The iPad sidebar: the pages, then every session in the web's order and groups.
struct SidebarView: View {
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        if let hub = scene.hub {
            VStack(spacing: 0) {
                PageLinks(scene: scene, hub: hub)
                SessionListView(scene: scene, hub: hub, selection: scene.workspace.focusedKey)
                Divider()
                WorkspaceStrip(scene: scene)
            }
            .background(theme.background)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button { scene.perform("new-session") } label: { Label("New session", systemImage: "plus") }
                }
                ToolbarItem(placement: .secondaryAction) {
                    Button { scene.perform("go-settings") } label: { Label("Settings", systemImage: "gearshape") }
                }
            }
            .navigationTitle(hub.hostname ?? "Agent Hub")
        }
    }
}

private struct PageLinks: View {
    let scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme

    var body: some View {
        let waiting = hub.rows.filter { $0.dto.status == .waiting }.count
        HStack(spacing: 4) {
            link("Inbox", "tray", .inbox, badge: waiting + hub.reviewAlerts.count)
            link("History", "clock.arrow.circlepath", .history)
            link("Review", "checkmark.rectangle.stack", .review(ReviewRoute()))
            link("Search", "magnifyingglass", .search)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    private func link(_ title: String, _ symbol: String, _ route: SceneSnapshot.Route, badge: Int = 0) -> some View {
        let active = scene.workspace.layout == nil && scene.route.page == route.page
        return Button {
            scene.show(route)
        } label: {
            VStack(spacing: 2) {
                Image(systemName: symbol).font(.body)
                    .overlay(alignment: .topTrailing) {
                        if badge > 0 {
                            Text("\(badge)").font(.caption2.weight(.bold)).padding(.horizontal, 4).background(theme.brand, in: Capsule()).foregroundStyle(.white).offset(x: 10, y: -6)
                        }
                    }
                Text(title).font(.caption2)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
            .background(active ? theme.accentStrong.opacity(0.18) : .clear, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .foregroundStyle(active ? theme.text : theme.muted)
        .accessibilityLabel(badge > 0 ? "\(title), \(badge) need you" : title)
        .accessibilityAddTraits(active ? .isSelected : [])
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
                InboxView(scene: scene, hub: hub).navigationTitle("Inbox")
            case .sessions:
                SessionListView(scene: scene, hub: hub, selection: nil).navigationTitle("Sessions")
            case .history:
                HistoryView(scene: scene, hub: hub).navigationTitle("History")
            case .search:
                if let search { SearchView(scene: scene, model: search) } else { Color.clear.onAppear { search = SearchModel(api: hub.api) } }
            case .review(let target):
                if let review {
                    if target.stack != nil {
                        StackCockpitView(scene: scene, model: review, route: target)
                    } else {
                        // A phone's Review tab keeps the list as its root and pushes the stack.
                        ReviewHomeView(scene: scene, model: review)
                            .navigationDestination(item: $scene.pushedReview) { target in
                                StackCockpitView(scene: scene, model: review, route: target)
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

/// The iPad detail: the split's panes, or one session, or a page.
struct DetailView: View {
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        ZStack {
            if scene.workspace.layout != nil {
                WorkspaceView(scene: scene)
            } else if case .session(let key) = scene.route, let session = scene.session(key) {
                SingleSessionView(scene: scene, session: session)
            } else {
                NavigationStack { PageView(scene: scene, route: scene.route) }
            }
            if scene.workspace.scratchVisible, let key = scene.workspace.scratchKey, let session = scene.session(key) {
                ScratchpadView(scene: scene, session: session)
            }
        }
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
                Label("Scratchpad", systemImage: "terminal").font(.caption.weight(.semibold))
                Spacer()
                Button { Task { await scene.toggleScratchpad() } } label: { Image(systemName: "chevron.down") }.accessibilityLabel("Hide the scratchpad")
            }
            .padding(10)
            TerminalScreen(session: session, scene: scene)
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
    private let gap: CGFloat = 2
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
                if workspace.zoom {
                    ZoomBadge(scene: scene, count: entries.count, index: entries.firstIndex { $0.tile.path == focused } ?? 0)
                        .frame(width: size.width, alignment: .topTrailing)
                }
            }
        }
        .background(theme.faint.opacity(0.25))
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

    var body: some View {
        Group {
            if LayoutNode.isPick(tile.sessionKey) {
                ChooserPane(scene: scene, path: tile.path)
            } else if let session = scene.session(tile.sessionKey) {
                SessionScreen(session: session, scene: scene, paneFocused: focused, compactHeader: tile.box.w < 0.5 || tile.box.h < 0.5, pane: tile.path)
            } else {
                EmptyState(symbol: "questionmark.square.dashed", title: "Session ended", message: "Pick another for this pane.")
            }
        }
        .background(theme.background)
        .overlay { if let zone { DropZoneHighlight(zone: zone) } }
        .overlay {
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .strokeBorder(focused ? theme.accentStrong : theme.faint.opacity(0.18), lineWidth: focused ? 2 : 0.5)
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
                            Text(LayoutNode.isPick(tile.sessionKey) ? "Empty pane" : (row?.title ?? scene.session(tile.sessionKey)?.title ?? "Session"))
                                .font(.caption.weight(active ? .semibold : .regular))
                                .lineLimit(1)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(active ? theme.accentStrong.opacity(0.2) : theme.raised, in: Capsule())
                        .foregroundStyle(active ? theme.text : theme.muted)
                    }
                    .buttonStyle(.plain)
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
            .font(.caption.weight(.semibold))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(theme.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
            .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
        }
        .buttonStyle(.plain)
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
            item("maximize-pane", title: scene.workspace.zoom ? "Restore layout" : nil)
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
        Menu {
            ForEach(1...9, id: \.self) { n in item(.toWorkspace(n)) }
        } label: { Label("Send to workspace", systemImage: "square.grid.3x3") }
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
private struct ChooserPane: View {
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

    var body: some View {
        let rows = rows
        VStack(spacing: 12) {
            Text("Open in this pane").font(.headline)
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.faint)
                TextField("Search sessions", text: $query)
                    .textFieldStyle(.plain)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onChange(of: query) { _, _ in selection = 0 }
                    .onSubmit { if rows.indices.contains(selection) { scene.fillPane(path, with: rows[selection].key) } }
                    .onKeyPress(.upArrow) { if !rows.isEmpty { selection = (selection - 1 + rows.count) % rows.count }; return .handled }
                    .onKeyPress(.downArrow) { if !rows.isEmpty { selection = (selection + 1) % rows.count }; return .handled }
                    .onKeyPress(.escape) { scene.cancelChooser(path); return .handled }
            }
            .padding(10)
            .background(theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .frame(maxWidth: 420)
            VStack(spacing: 2) {
                ForEach(Array(rows.enumerated()), id: \.element.key) { index, row in
                    HStack(spacing: 10) {
                        AgentMark(agent: row.dto.agent, size: 20)
                        Text(row.title).font(.callout).lineLimit(1)
                        Spacer()
                        StatusPill(word: row.word, compact: true)
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(index == selection ? theme.accentStrong.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .contentShape(Rectangle())
                    .onTapGesture { scene.fillPane(path, with: row.key) }
                    .onHover { if $0 { selection = index } }
                }
            }
            .frame(maxWidth: 420)
            HStack {
                Button("New session") {
                    scene.workspace.focus(path)
                    scene.sheet = .newSession(SceneModel.NewSessionContext(intoPane: path))
                }
                .buttonStyle(.bordered)
                Button("Cancel") { scene.cancelChooser(path) }
            }
            .font(.callout)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { if scene.focusRequest?.target == .chooser(path) || scene.workspace.focusPath == path { focused = true } }
        .onChange(of: scene.focusRequest) { _, request in if request?.target == .chooser(path) { focused = true } }
        .onChange(of: focused) { _, now in if now { scene.didFocus(.chooser(path)) } else { scene.didBlur(.chooser(path)) } }
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

/// Workspaces 1–9 at the foot of the sidebar: the current one, the ones in use, a tap to go.
struct WorkspaceStrip: View {
    let scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        let current = scene.workspace.currentWorkspace
        let occupied = Set(scene.workspace.occupiedWorkspaces)
        HStack(spacing: 3) {
            ForEach(1...9, id: \.self) { n in
                Button {
                    scene.perform(.workspace(n))
                } label: {
                    Text("\(n)")
                        .font(.caption.monospacedDigit().weight(n == current ? .bold : .regular))
                        .frame(maxWidth: .infinity, minHeight: 24)
                        .background(n == current ? theme.accentStrong.opacity(0.25) : occupied.contains(n) ? theme.raised : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                        .foregroundStyle(n == current ? theme.text : occupied.contains(n) ? theme.text2 : theme.faint)
                }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .contextMenu {
                    Button("Send the focused session here", systemImage: "arrow.right.square") { scene.perform(.toWorkspace(n)) }
                        .disabled(!scene.isAvailable(.toWorkspace(n)) || n == current)
                }
                .accessibilityLabel("Workspace \(n)\(n == current ? ", current" : occupied.contains(n) ? ", in use" : "")")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }
}

/// What floats over a window without taking touches: which-key, the submap legend, toasts.
struct OverlayLayer: View {
    let scene: SceneModel

    var body: some View {
        ZStack {
            if !scene.whichKey.isEmpty || scene.pendingChord != nil {
                WhichKeyHUD(rows: scene.whichKey, pending: scene.pendingChord?.formatted()).frame(maxHeight: .infinity, alignment: .bottom).allowsHitTesting(false)
            }
            if let mode = scene.workspace.submap {
                SubmapHUD(mode: mode).frame(maxHeight: .infinity, alignment: .top).allowsHitTesting(false)
            }
            ToastStack(scene: scene).frame(maxHeight: .infinity, alignment: .bottom)
            NudgeStack(scene: scene).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: scene.narrow ? .top : .topTrailing)
        }
    }
}
