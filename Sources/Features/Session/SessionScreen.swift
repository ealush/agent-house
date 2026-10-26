import OSLog
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
    @State private var previewURL: URL?

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
                // The question and the composer float over the transcript, which scrolls on
                // beneath them (and fades under, at the bar's edge).
                surface
                    .safeAreaBar(edge: .bottom, spacing: 0) {
                        if session.surface == .gui && session.hasGUI {
                            VStack(spacing: 0) {
                                if session.waiting, session.row?.dto.ask != nil {
                                    AskPanelView(target: AskTarget(session: session), keyboard: AskKeyboard(scene: scene, key: session.key, leave: .composer(session.key)), onReply: { scene.requestFocus(.composer(session.key)) }, onUseTerminal: { scene.setSurface(.terminal, for: session.key) })
                                        .padding(.horizontal, 12)
                                        .padding(.bottom, 6)
                                }
                                ComposerView(session: session, composer: session.composer, scene: scene)
                            }
                        }
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
        // Images in the conversation (what you attached, what the agent drew) load from the
        // host, and a host path you tap opens in Quick Look.
        .environment(\.hostFiles, HostFiles(
            load: { [hub = session.hub, key = session.key] path in try? await hub.client(forKey: key).file(path) },
            open: { path in Task { await preview(path) } }))
        .quickLookPreview($previewURL)
        .overlay(alignment: .top) { NoticeStack(session: session) }
        // The agent asks while you're in an empty composer: the keys go to its question
        // (digits pick), and an on-screen keyboard steps aside for the choices.
        .onChange(of: session.surface == .gui && scene.answerFocus(session) != nil) { _, asking in
            Logger(subsystem: "dev.ealush.ah.native", category: "keyboard").debug("asking \(asking, privacy: .public) with the keyboard at \(String(describing: scene.currentFocus), privacy: .public), composer empty \(session.composer.isEmpty, privacy: .public)")
            guard asking, scene.currentFocus == .composer(session.key), session.composer.isEmpty else { return }
            // Not a text input: taking the keyboard puts the on-screen one away too.
            scene.requestFocus(.ask(session.key))
        }
        .sheet(item: Binding(get: { narrow ? session.panel : nil }, set: { session.panel = $0 })) { panel in
            NavigationStack {
                PanelView(panel: panel, session: session, scene: scene)
                    .modifier(PanelChrome(panel: panel, session: session, scene: scene, sheet: true))
            }
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .onChange(of: session.isShell, initial: true) { _, shell in session.composer.isShell = shell }
        .onChange(of: session.hasGUI) { _, _ in session.stateChanged() }
        .onChange(of: session.row?.dto.queued) { _, _ in session.stateChanged() }
        .onChange(of: session.row?.dto.status) { old, new in
            if old == .busy && new != .busy { Haptics.success() }
            if new == .waiting { Haptics.warning() }
        }
        .accessibilityElement(children: .contain)
    }

    private func preview(_ path: String) async {
        guard let data = try? await session.hub.client(forKey: session.key).file(path) else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent((path as NSString).lastPathComponent)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if (try? data.write(to: url, options: [.completeFileProtection])) != nil { previewURL = url }
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
                ForEach(SceneSnapshot.Panel.allCases.filter { $0.applies(to: session) }, id: \.self) { other in
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
                        Button("Done") { session.panel = nil }.keyboardShortcut(.cancelAction)
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
            // Only what this session has: no Diff or Stack without a branch, no Queue or
            // Snapshots in a shell.
            ForEach(SceneSnapshot.Panel.allCases.filter { $0.applies(to: session) }) { panel in
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
            ForEach(Array(SessionAction.sections(session, scene).enumerated()), id: \.offset) { _, section in
                Section {
                    ForEach(section) { action in
                        Button(action.title, systemImage: action.symbol, role: action.destructive ? .destructive : nil, action: action.run)
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("Session menu")
    }
}

/// One entry of the session menu. The iPad header draws them as a SwiftUI menu, the phone's
/// navigation bar as a UIMenu: one list, so the two never drift apart.
struct SessionAction: Identifiable {
    let title: String
    let symbol: String
    var destructive = false
    let run: @MainActor () -> Void

    var id: String { title }

    @MainActor
    static func sections(_ session: SessionModel, _ scene: SceneModel) -> [[SessionAction]] {
        guard session.isLive else {
            return [[
                SessionAction(title: "Resume", symbol: "play") { Task { if let key = await session.resume() { scene.open(key) } } },
                SessionAction(title: "Fork…", symbol: "arrow.branch") { scene.sheet = .fork(session.key) },
                SessionAction(title: session.history?.dto.pinned == true ? "Unpin" : "Pin", symbol: "pin") { Task { await session.togglePin() } },
            ]]
        }
        let pinned = session.row?.dto.pinned == true
        var work: [SessionAction] = []
        if session.row?.dto.branch != nil { work.append(SessionAction(title: "Switch Branch…", symbol: "arrow.triangle.branch") { scene.sheet = .branch(session.key) }) }
        if !session.isShell { work.append(SessionAction(title: "Fork…", symbol: "arrow.branch") { scene.sheet = .fork(session.key) }) }
        if session.row?.dto.fork != nil { work.append(SessionAction(title: "Forks…", symbol: "arrow.triangle.branch") { scene.sheet = .forks(session.key) }) }
        if session.row?.dto.feed != nil { work.append(SessionAction(title: "Send To…", symbol: "paperplane") { scene.sheet = .sendTo(session.key) }) }
        if let queued = session.row?.dto.queued, queued > 0 {
            work.append(SessionAction(title: "Send Queued Now (\(queued))", symbol: "arrow.up.to.line") { scene.perform("send-now") })
        }
        var view: [SessionAction] = []
        if session.surface == .gui {
            let hidden = scene.app.preferences.stepsHidden
            view.append(SessionAction(title: hidden ? "Show Steps" : "Hide Steps", symbol: hidden ? "list.bullet.indent" : "list.bullet") { scene.perform("toggle-steps") })
            view.append(SessionAction(title: "Copy Last Reply", symbol: "doc.on.doc") { scene.perform("copy-last") })
        }
        view.append(SessionAction(title: "Scrollback as Text", symbol: "text.alignleft") { scene.perform("scrollback") })
        view.append(SessionAction(title: "Copy Attach Command", symbol: "terminal") { scene.perform("copy-attach") })
        view.append(SessionAction(title: "All Commands…", symbol: "command") { scene.perform("command-palette") })
        return [
            [
                SessionAction(title: "Rename", symbol: "pencil") { scene.perform("rename") },
                SessionAction(title: pinned ? "Unpin" : "Pin", symbol: pinned ? "pin.slash" : "pin") { Task { await session.togglePin() } },
            ],
            work,
            view,
            [SessionAction(title: "Terminate…", symbol: "xmark.octagon", destructive: true) { scene.sheet = .confirmTerminate(session.key) }],
        ].filter { !$0.isEmpty }
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
