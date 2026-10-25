import SwiftUI

/// One session, in a phone push or an iPad pane: its header, the GUI or the terminal (both
/// views of the same live session; switching never restarts it), the ask, the composer, and
/// its side panel.
struct SessionScreen: View {
    @Bindable var session: SessionModel
    @Bindable var scene: SceneModel
    /// In an iPad pane: the pane is focused (its border, and where keys go).
    var paneFocused = true
    var compactHeader = false
    /// Where this session sits in a split (nil: the single view or a phone).
    var pane: LayoutNode.Path? = nil
    /// Pushed on a phone: the navigation bar carries the title, status and actions, so the
    /// header only shows while renaming.
    var inNavigationBar = false
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var panelWidth: CGFloat = 380

    private var narrow: Bool { sizeClass == .compact || scene.narrow }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                if !inNavigationBar || session.renaming != nil {
                    SessionHeader(session: session, scene: scene, compact: compactHeader, pane: pane, paneFocused: paneFocused)
                }
                if let history = session.history, !session.isLive {
                    EndedBanner(session: session, scene: scene, item: history)
                }
                surface
                if session.surface == .gui && session.hasGUI {
                    if session.waiting, session.row?.dto.ask != nil {
                        AskPanelView(target: AskTarget(session: session), onReply: { scene.requestFocus(.composer(session.key)) }, onUseTerminal: { scene.setSurface(.terminal, for: session.key) })
                            .padding(.horizontal, 12)
                            .padding(.bottom, 6)
                    }
                    ComposerView(session: session, composer: session.composer, scene: scene)
                }
            }
            if !narrow, let panel = session.panel {
                Divider()
                NavigationStack {
                    PanelView(panel: panel, session: session, scene: scene)
                        .modifier(PanelChrome(panel: panel, session: session, scene: scene))
                }
                .frame(width: max(280, min(640, panelWidth - CGFloat(scene.panelWidthDelta))))
                .transition(.move(edge: .trailing))
            }
        }
        .background(theme.background)
        .overlay(alignment: .top) { NoticeStack(session: session) }
        .sheet(item: Binding(get: { narrow ? session.panel : nil }, set: { session.panel = $0 })) { panel in
            NavigationStack {
                PanelView(panel: panel, session: session, scene: scene)
                    .modifier(PanelChrome(panel: panel, session: session, scene: scene, sheet: true))
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: session.row?.dto.queued) { _, _ in session.stateChanged() }
        .onChange(of: session.row?.dto.status) { old, new in
            if old == .busy && new != .busy { Haptics.success() }
            if new == .waiting { Haptics.warning() }
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var surface: some View {
        if session.surface == .gui && session.hasGUI {
            TranscriptView(session: session, scene: scene)
        } else if session.isLive {
            TerminalScreen(session: session, scene: scene)
        } else {
            // An ended session without a transcript: its last screen, read-only.
            EndedScreen(session: session)
        }
    }
}

/// A phone's session bar: the title, what it's doing and where (as the subtitle), and the
/// header's actions as toolbar items.
struct SessionNavigationChrome: ViewModifier {
    @Bindable var session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme

    /// The terminal fills the screen under a see-through bar: over a dark one the bar's title
    /// and buttons have to be light.
    private var overDarkTerminal: Bool {
        // A live terminal only: an ended session shows its last screen on the page's ground.
        session.isLive && !(session.surface == .gui && session.hasGUI) && theme.palette.terminal.isDark
    }

    private var subtitle: String {
        guard let row = session.row else { return session.isLive ? "" : "Ended" }
        return [row.word.rawValue, row.dto.project, row.dto.branch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    func body(content: Content) -> some View {
        content
            .navigationTitle(session.title)
            .navigationSubtitle(subtitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarColorScheme(overDarkTerminal ? .dark : nil, for: .navigationBar)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    if session.isLive && session.hasGUI && !session.isShell {
                        let other: SceneSnapshot.Surface = session.surface == .gui ? .terminal : .gui
                        Button {
                            scene.setSurface(other, for: session.key)
                        } label: {
                            Image(systemName: other == .terminal ? "terminal" : "text.bubble")
                        }
                        .accessibilityLabel(other == .terminal ? "Terminal" : "GUI")
                    }
                    PanelsMenu(session: session)
                    SessionMenu(session: session, scene: scene)
                }
            }
    }
}

/// A panel's bar, beside the session or in a phone sheet: its name, a title menu that
/// switches to any other panel this session offers, and a way out.
private struct PanelChrome: ViewModifier {
    let panel: SceneSnapshot.Panel
    let session: SessionModel
    let scene: SceneModel
    var sheet = false

    func body(content: Content) -> some View {
        content
            .navigationTitle(panel.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarTitleMenu {
                ForEach(SceneSnapshot.Panel.allCases.filter { scene.isAvailable($0.command) }, id: \.self) { other in
                    Button {
                        session.panel = other
                    } label: {
                        Label(other.title, systemImage: other.symbol)
                    }
                    .disabled(other == panel)
                }
            }
            .toolbar {
                ToolbarItem(placement: sheet ? .confirmationAction : .cancellationAction) {
                    if sheet {
                        Button("Done") { session.panel = nil }
                    } else {
                        Button {
                            withAnimation(.snappy(duration: 0.2)) { session.panel = nil }
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel("Close \(panel.title)")
                    }
                }
            }
    }
}

extension SceneSnapshot.Panel: Identifiable {
    var id: String { rawValue }
}

private struct SessionHeader: View {
    @Bindable var session: SessionModel
    let scene: SceneModel
    var compact: Bool
    var pane: LayoutNode.Path?
    var paneFocused = true
    @Environment(\.theme) private var theme
    @FocusState private var renameFocused: Bool
    /// The header's own width: a pane beside a panel, or a quarter of a split, is narrow.
    @State private var width: CGFloat = 1000

    /// Narrow: the status is a dot, the view switch one button, splitting via the menus.
    private var tight: Bool { width < 560 }

    /// The detail column has no navigation bar while it shows sessions, so the leading
    /// header (the single session, or the top-left pane) offers the sidebar back.
    private var showsSidebarButton: Bool {
        guard !scene.narrow, !scene.workspace.sidebarVisible else { return false }
        guard let pane else { return true }
        return pane.allSatisfy { $0 == .first }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if showsSidebarButton {
                    Button {
                        scene.perform("toggle-sidebar")
                    } label: {
                        Image(systemName: "sidebar.left")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Show Sidebar")
                }
                AgentMark(agent: session.row?.dto.agent ?? (session.isShell ? nil : session.history?.dto.harness), size: 24)
                    .modifier(PaneDragHandle(pane: pane))
                if session.renaming != nil {
                    TextField("Name", text: Binding(get: { session.renaming ?? "" }, set: { session.renaming = $0 }))
                        .font(.headline)
                        .textFieldStyle(.roundedBorder)
                        .focused($renameFocused)
                        .onSubmit { Task { await session.commitRename() } }
                        .onKeyPress(.escape) {
                            session.renaming = nil
                            return .handled
                        }
                        .onAppear { renameFocused = true }
                } else {
                    Text(session.title)
                        .font(compact ? .subheadline.weight(.semibold) : .headline)
                        .lineLimit(1)
                        .layoutPriority(1)
                        .accessibilityAddTraits(.isHeader)
                }
                if let row = session.row { StatusPill(word: row.word, compact: tight).fixedSize() }
                Spacer(minLength: 4)
                if session.isLive && session.hasGUI && !session.isShell {
                    if tight {
                        let other: SceneSnapshot.Surface = session.surface == .gui ? .terminal : .gui
                        Button {
                            scene.setSurface(other, for: session.key)
                        } label: {
                            Image(systemName: other == .terminal ? "terminal" : "text.bubble")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(other == .terminal ? "Terminal" : "GUI")
                    } else {
                        Picker("View", selection: Binding(get: { session.surface }, set: { scene.setSurface($0, for: session.key) })) {
                            Image(systemName: "text.bubble").accessibilityLabel("GUI").tag(SceneSnapshot.Surface.gui)
                            Image(systemName: "terminal").accessibilityLabel("Terminal").tag(SceneSnapshot.Surface.terminal)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 96)
                    }
                }
                PanelsMenu(session: session)
                if !scene.narrow && !tight {
                    Menu {
                        PaneMenuItems(scene: scene, path: pane)
                    } label: {
                        Image(systemName: pane == nil ? "rectangle.split.2x1" : "rectangle.split.2x2")
                    }
                    .accessibilityLabel(pane == nil ? "Split" : "Pane")
                }
                SessionMenu(session: session, scene: scene)
            }
            if !compact, let row = session.row {
                HStack(spacing: 8) {
                    Text(row.dto.project).foregroundStyle(theme.muted)
                    if let branch = row.dto.branch {
                        Button {
                            scene.sheet = .branch(session.key)
                        } label: {
                            Label(branch, systemImage: "arrow.triangle.branch").lineLimit(1)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(theme.muted)
                        .disabled(!session.isLive)
                        .accessibilityLabel("Branch \(branch)")
                        .accessibilityHint("Switch branch")
                    }
                    if let launch = row.dto.launch { Text(launch).foregroundStyle(theme.faint).lineLimit(1) }
                    if let limit = row.dto.limit { Label(limit, systemImage: "hourglass").foregroundStyle(theme.limited) }
                    if !session.otherDevices.isEmpty {
                        Label("Also open on \(session.otherDevices.joined(separator: ", "))", systemImage: "rectangle.on.rectangle").foregroundStyle(theme.faint)
                    }
                    if let fork = row.dto.fork {
                        Button {
                            scene.sheet = .forks(session.key)
                        } label: {
                            Label(fork.parentTitle.isEmpty ? "\(fork.forks) fork\(fork.forks == 1 ? "" : "s")" : "Fork of \(fork.parentTitle)", systemImage: "arrow.branch").lineLimit(1)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(theme.faint)
                        .accessibilityHint("Show the fork family")
                    }
                }
                .font(.caption)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .background(.bar)
        .opacity(pane == nil || paneFocused ? 1 : 0.72)
        .contextMenu {
            if !scene.narrow { PaneMenuItems(scene: scene, path: pane) }
        }
    }
}

/// In a split, a session's mark drags its pane onto another (an edge splits beside it,
/// the center swaps them).
private struct PaneDragHandle: ViewModifier {
    let pane: LayoutNode.Path?

    func body(content: Content) -> some View {
        if let pane {
            content.draggable(SessionDrag(key: LayoutNode.encode(pane))).accessibilityHint("Drag onto another pane to move it")
        } else {
            content
        }
    }
}

private struct PanelsMenu: View {
    let session: SessionModel

    var body: some View {
        Menu {
            ForEach(SceneSnapshot.Panel.allCases) { panel in
                Button {
                    session.panel = session.panel == panel ? nil : panel
                } label: {
                    if session.panel == panel { Label(panel.title, systemImage: "checkmark") } else { Label(panel.title, systemImage: panel.symbol) }
                }
            }
        } label: {
            Image(systemName: "sidebar.right")
        }
        .accessibilityLabel("Panels")
    }
}

/// The session menu (⌃⌥.): the session's actions, destructive ones last and confirmed.
struct SessionMenu: View {
    let session: SessionModel
    let scene: SceneModel

    var body: some View {
        Menu {
            if session.isLive {
                Section {
                    Button("Rename", systemImage: "pencil") { scene.perform("rename") }
                    Button(session.row?.dto.pinned == true ? "Unpin" : "Pin", systemImage: session.row?.dto.pinned == true ? "pin.slash" : "pin") { Task { await session.togglePin() } }
                }
                Section {
                    if session.row?.dto.branch != nil { Button("Switch Branch…", systemImage: "arrow.triangle.branch") { scene.sheet = .branch(session.key) } }
                    if !session.isShell { Button("Fork…", systemImage: "arrow.branch") { scene.sheet = .fork(session.key) } }
                    if session.row?.dto.fork != nil { Button("Forks…", systemImage: "arrow.triangle.branch") { scene.sheet = .forks(session.key) } }
                    if session.row?.dto.feed != nil { Button("Send To…", systemImage: "paperplane") { scene.sheet = .sendTo(session.key) } }
                    if let queued = session.row?.dto.queued, queued > 0 {
                        Button("Send Queued Now (\(queued))", systemImage: "arrow.up.to.line") { scene.perform("send-now") }
                    }
                }
                Section {
                    if session.surface == .gui {
                        Button(scene.app.preferences.stepsHidden ? "Show Steps" : "Hide Steps", systemImage: scene.app.preferences.stepsHidden ? "list.bullet.indent" : "list.bullet") { scene.perform("toggle-steps") }
                        Button("Copy Last Reply", systemImage: "doc.on.doc") { scene.perform("copy-last") }
                    }
                    Button("Scrollback as Text", systemImage: "text.alignleft") { scene.perform("scrollback") }
                    Button("Copy Attach Command", systemImage: "terminal") { scene.perform("copy-attach") }
                    Button("All Commands…", systemImage: "command") { scene.perform("command-palette") }
                }
                Button("Terminate…", systemImage: "xmark.octagon", role: .destructive) { scene.sheet = .confirmTerminate(session.key) }
            } else {
                Button("Resume", systemImage: "play") {
                    Task { if let key = await session.resume() { scene.open(key) } }
                }
                Button("Fork…", systemImage: "arrow.branch") { scene.sheet = .fork(session.key) }
                Button(session.history?.dto.pinned == true ? "Unpin" : "Pin", systemImage: "pin") { Task { await session.togglePin() } }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Session menu")
    }
}

/// An ended session stays put with Resume; typing in its composer resumes it and sends.
private struct EndedBanner: View {
    let session: SessionModel
    let scene: SceneModel
    let item: HistoryRow
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "moon.zzz").foregroundStyle(theme.muted)
            VStack(alignment: .leading, spacing: 2) {
                Text("This session has ended").font(.subheadline.weight(.semibold))
                Text("Resume it to continue, or just send a message: that resumes it first.").font(.caption).foregroundStyle(theme.muted)
            }
            Spacer()
            Button("Resume") {
                Task { if let key = await session.resume() { scene.open(key) } }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accentStrong)
        }
        .padding(12)
        .background(theme.raised)
    }
}

/// What a shell or adapter-less session showed last, when it's no longer running.
private struct EndedScreen: View {
    let session: SessionModel
    @State private var text: String?
    @State private var loaded = false
    @Environment(\.theme) private var theme

    var body: some View {
        Group {
            if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                ScrollView {
                    Text(text)
                        .font(theme.mono)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                }
            } else if loaded {
                ContentUnavailableView {
                    Label("This shell has ended", systemImage: "moon.zzz")
                } description: {
                    Text("Its last screen wasn’t kept. Resume starts it again in the same folder.")
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            text = await session.scrollback(quietly: true)
            loaded = true
        }
    }
}

/// The session's own notices (answered, switched, failures), briefly.
private struct NoticeStack: View {
    let session: SessionModel
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 6) {
            ForEach(session.notices) { notice in
                Text(notice.text)
                    .font(.footnote)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(.regularMaterial, in: Capsule())
                    .foregroundStyle(notice.tone == .error ? theme.danger : theme.text)
                    .task {
                        try? await Task.sleep(for: .seconds(notice.tone == .error ? 6 : 3))
                        session.dismiss(notice.id)
                    }
                    .onTapGesture { session.dismiss(notice.id) }
                    .accessibilityAddTraits(.isStaticText)
            }
        }
        .padding(.top, 60)
        .animation(.snappy, value: session.notices.map(\.id))
    }
}
