import SwiftUI

/// The iPad sidebar: the pages, then every session in the web's order and groups.
struct SidebarView: View {
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        if let hub = scene.hub {
            VStack(spacing: 0) {
                PageLinks(scene: scene, hub: hub)
                SessionListView(scene: scene, hub: hub, selection: scene.workspace.focusedKey)
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

    var body: some View {
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
                SessionScreen(session: session, scene: scene)
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
/// survives the tree changing around it; seams drag to resize.
struct WorkspaceView: View {
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        let workspace = scene.workspace
        let geometry = workspace.layout?.tiles() ?? (tiles: [], seams: [])
        let focused = workspace.focusPath
        GeometryReader { proxy in
            let size = proxy.size
            ZStack(alignment: .topLeading) {
                ForEach(geometry.tiles, id: \.sessionKey) { tile in
                    let zoomedOut = workspace.zoom && tile.path != focused
                    let box = workspace.zoom && tile.path == focused ? LayoutNode.Box(x: 0, y: 0, w: 1, h: 1) : tile.box
                    PaneView(scene: scene, tile: tile, focused: tile.path == focused)
                        .frame(width: max(0, box.w * size.width - 2), height: max(0, box.h * size.height - 2))
                        .offset(x: box.x * size.width + 1, y: box.y * size.height + 1)
                        .opacity(zoomedOut ? 0 : 1)
                        .allowsHitTesting(!zoomedOut)
                }
                if !workspace.zoom {
                    ForEach(geometry.seams, id: \.path) { seam in
                        SeamHandle(seam: seam, size: size) { ratio in workspace.setRatio(at: seam.path, ratio) }
                    }
                }
            }
        }
        .coordinateSpace(.named("workspace"))
        .background(theme.faint.opacity(0.25))
        .animation(.snappy(duration: 0.2), value: geometry.tiles.map(\.box))
    }
}

private struct PaneView: View {
    let scene: SceneModel
    let tile: LayoutNode.Tile
    let focused: Bool
    @Environment(\.theme) private var theme

    var body: some View {
        Group {
            if LayoutNode.isPick(tile.sessionKey) {
                ChooserPane(scene: scene, path: tile.path)
            } else if let session = scene.session(tile.sessionKey) {
                SessionScreen(session: session, scene: scene, paneFocused: focused, compactHeader: tile.box.w < 0.5 || tile.box.h < 0.5)
            } else {
                EmptyState(symbol: "questionmark.square.dashed", title: "Session ended", message: "Pick another for this pane.")
            }
        }
        .background(theme.background)
        .overlay(RoundedRectangle(cornerRadius: 2).stroke(focused ? theme.accentStrong : .clear, lineWidth: 2))
        .simultaneousGesture(TapGesture().onEnded { if !focused { scene.workspace.focus(tile.path) } })
        .dropDestination(for: String.self) { keys, _ in
            guard let key = keys.first else { return false }
            scene.workspace.drop(key, onto: tile.path, where: .center)
            return true
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(focused ? "Focused pane" : "Pane")
    }
}

/// An empty pane waiting for a session.
private struct ChooserPane: View {
    let scene: SceneModel
    let path: LayoutNode.Path
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 14) {
            Text("Open in this pane").font(.headline)
            HStack {
                Button("Pick a session") {
                    scene.workspace.focus(path)
                    scene.switcher = SceneModel.SwitcherState(intoPane: path)
                }
                .buttonStyle(.borderedProminent)
                .tint(theme.accentStrong)
                Button("New session") {
                    scene.workspace.focus(path)
                    scene.sheet = .newSession(SceneModel.NewSessionContext(intoPane: path))
                }
                .buttonStyle(.bordered)
            }
            Button("Cancel") { scene.workspace.cancelChooser(path) }.font(.callout)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

private struct SeamHandle: View {
    let seam: LayoutNode.Seam
    let size: CGSize
    let set: (Double) -> Void
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
                dragging = true
                let ratio = seam.row
                    ? (value.location.x / size.width - box.x) / box.w
                    : (value.location.y / size.height - box.y) / box.h
                set(min(0.85, max(0.15, ratio)))
            }.onEnded { _ in dragging = false })
            .accessibilityRepresentation {
                Slider(value: Binding(get: { seam.ratio }, set: set), in: 0.15...0.85) { Text("Pane divider") }
            }
    }
}

/// What floats over a window without taking touches: which-key, the submap legend, toasts.
struct OverlayLayer: View {
    let scene: SceneModel

    var body: some View {
        ZStack {
            if !scene.whichKey.isEmpty {
                WhichKeyHUD(rows: scene.whichKey).frame(maxHeight: .infinity, alignment: .bottom).allowsHitTesting(false)
            }
            if let mode = scene.workspace.submap {
                SubmapHUD(mode: mode).frame(maxHeight: .infinity, alignment: .top).allowsHitTesting(false)
            }
            ToastStack(scene: scene).frame(maxHeight: .infinity, alignment: .bottom)
        }
    }
}
