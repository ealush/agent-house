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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var panelWidth: CGFloat = 380
    @State private var previewURL: URL?
    /// The screen's height and the question's: a long question scrolls inside a panel of at
    /// most a little over half the screen, so the conversation and its bar stay in view.
    @State private var screenHeight: CGFloat = 800
    @State private var screenWidth: CGFloat = 1000
    /// This screen put the sidebar away to make room for a panel, and brings it back after.
    @State private var hidSidebarForPanel = false
    /// The conversation's least width beside a panel; past it, the sidebar makes way.
    static let roomBesidePanel: CGFloat = 460
    @State private var askHeight: CGFloat = 0
    /// How tall the bar under the transcript is: what opens out of the composer floats just
    /// above it.
    @State private var barHeight: CGFloat = 0

    private var narrow: Bool { sizeClass == .compact || scene.narrow }
    /// How wide the conversation and its composer grow on a big screen: past this, lines get
    /// too long to read.
    static let readableWidth: CGFloat = 860

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                if !inNavigationBar {
                    SessionHeader(session: session, scene: scene, compact: compactHeader, pane: pane, paneFocused: paneFocused)
                }
                // Live first: History is read off the whole hub, and asking it of a live session
                // drew the screen again on every tick of every host.
                if !session.isLive, let history = session.history {
                    EndedBanner(session: session, scene: scene, item: history)
                }
                // The question and the composer float over the transcript, which scrolls on
                // beneath them (and fades under, at the bar's edge). Soft at both edges, said
                // outright: left to the system, a phone drew the hard edge, an opaque band
                // with a hairline in a tint the transcript doesn't have.
                // The conversation and the terminal change places through a short fade: the
                // switch cut from one to the other.
                ZStack { surface }
                    .animation(.smooth(duration: 0.18), value: session.surface)
                    .scrollEdgeEffectStyle(.soft, for: .vertical)
                    .safeAreaBar(edge: .bottom, spacing: 0) {
                        if session.surface == .gui && session.hasGUI {
                            VStack(spacing: 0) {
                                if session.waiting, session.row?.dto.ask != nil {
                                    ScrollView {
                                        AskPanelView(target: AskTarget(session: session), keyboard: AskKeyboard(scene: scene, key: session.key, leave: .composer(session.key)), onReply: { scene.requestFocus(.composer(session.key)) }, onUseTerminal: { scene.setSurface(.terminal, for: session.key) })
                                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { askHeight = $0 }
                                    }
                                    .scrollBounceBehavior(.basedOnSize)
                                    .scrollIndicators(.automatic)
                                    // A drag puts the keyboard away: the choices come back into view.
                                    .scrollDismissesKeyboard(.immediately)
                                    .frame(height: min(askHeight, screenHeight * 0.55))
                                    .padding(.horizontal, 12)
                                    .padding(.bottom, 6)
                                    // Rises out of the composer when the agent asks, and folds back
                                    // into it once answered, rather than cutting in and out.
                                    .transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                                }
                                ComposerView(session: session, composer: session.composer, scene: scene)
                            }
                            .animation(reduceMotion ? nil : .snappy(duration: 0.32), value: session.waiting && session.row?.dto.ask != nil)
                            // Toasts sit above the composer (and the keyboard under it): a phone's,
                            // or the focused pane's on a big screen.
                            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                                if narrow || paneFocused {
                                    scene.composerTop = Double(frame.minY)
                                    scene.composerMidX = Double(frame.midX)
                                }
                            }
                            .onChange(of: paneFocused) { _, focused in
                                if !focused && !narrow {
                                    scene.composerTop = nil
                                    scene.composerMidX = nil
                                }
                            }
                            .onDisappear {
                                if narrow || paneFocused {
                                    scene.composerTop = nil
                                    scene.composerMidX = nil
                                }
                            }
                            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { barHeight = $0 }
                            .frame(maxWidth: Self.readableWidth)
                            .frame(maxWidth: .infinity)
                        }
                    }
            }
            // Over the transcript, above the bar and outside it (a view past the bar's edge
            // draws but takes no touch).
            .overlay(alignment: .bottom) {
                if session.surface == .gui && session.hasGUI {
                    ComposerFloat(session: session, composer: session.composer, scene: scene)
                        .frame(maxWidth: Self.readableWidth)
                        .frame(maxWidth: .infinity)
                        .padding(.bottom, barHeight)
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
        // A panel slides in as it slides out (opened from the menu, it cut in), the
        // conversation making room beside it; Reduce Motion keeps it short.
        .animation(narrow ? nil : (reduceMotion ? Animation.smooth(duration: 0.12) : Animation.snappy(duration: 0.25)), value: session.panel != nil)
        // Above the keyboard by where the keyboard is, not by the keyboard safe area: the bar
        // sits in the transcript's inset, which UIKit moves with the keyboard, while the safe
        // area settles only afterwards, so what floats over the bar sat still as the bar went
        // down and then jumped after it. Ignored here at the screen's root, which is where
        // SwiftUI honours that: asked of the float alone, it was still placed by the safe
        // area, and rose twice as far.
        // As far as the keyboard covers this screen, which in a split is this pane's share.
        .modifier(KeyboardRoom())
        .ignoresSafeArea(.keyboard)
        // Under the keyboard and the bars too: the keyboard's rounded corners showed the
        // window's black over a terminal that stops at the keyboard.
        .background { theme.surface.ignoresSafeArea() }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { screenHeight = $0 }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { screenWidth = $0 }
        // A panel beside the conversation in an iPad's portrait left it a column a few words
        // wide, with the sidebar beside it: the sidebar makes way while the panel is out.
        .onChange(of: session.panel != nil) { _, open in
            guard !narrow, pane == nil else { return }
            if open, scene.workspace.sidebarVisible, screenWidth - max(280, min(640, panelWidth - CGFloat(scene.panelWidthDelta))) < Self.roomBesidePanel {
                scene.workspace.sidebarVisible = false
                hidSidebarForPanel = true
            } else if !open, hidSidebarForPanel {
                hidSidebarForPanel = false
                scene.workspace.sidebarVisible = true
            }
        }
        // Images in the conversation (what you attached, what the agent drew) load from the
        // host, and a host path you tap opens in Quick Look.
        .environment(\.hostFiles, HostFiles(
            load: { [hub = session.hub, key = session.key] path in try? await hub.client(forKey: key).file(path) },
            open: { path in Task { await preview(path) } }))
        .quickLookPreview($previewURL)
        // A phone renames as iOS does, in an alert with the name selected: a header of its own
        // under the bar repeated the bar's buttons around a bare field.
        .alert("Rename Session", isPresented: Binding(get: { inNavigationBar && session.renaming != nil }, set: { if !$0 { session.renaming = nil } })) {
            RenameAlertFields(session: session)
        }
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
            // One per session, as the terminal is: a pane switched to another kept the last one's
            // place in its conversation (scrolled back there, this one opened scrolled back too).
            TranscriptView(session: session, scene: scene).id(session.key).transition(.opacity)
        } else if session.isLive {
            // One per session: a pane switched to another kept the last one's terminal.
            TerminalScreen(session: session, scene: scene).id(session.key).transition(.opacity)
        } else {
            // An ended session without a transcript: its last screen, read-only.
            EndedScreen(session: session).transition(.opacity)
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
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        content
            // The theme's surface, like the session beside it: unset, the panel's stack and
            // its lists drew the system's black.
            .scrollContentBackground(.hidden)
            .background(theme.surface)
            .containerBackground(theme.surface, for: .navigation)
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
                // Leading, as every sheet's close in the app: the confirmation slot drew it
                // prominent (a filled disc), and trailing it sat inside the panel's own menu.
                ToolbarItem(placement: .cancellationAction) {
                    Group {
                        if sheet {
                            Button(role: .close) { session.panel = nil }.keyboardShortcut(.cancelAction)
                        } else {
                            Button(role: .close) {
                                withAnimation(.snappy(duration: 0.2)) { session.panel = nil }
                            }
                            .accessibilityLabel("Close \(panel.title)")
                        }
                    }
                    // A bar glyph in the label color, as every other bar's is; the accent is
                    // for the one primary action.
                    .tint(.primary)
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
                        Image(systemName: "sidebar.left").headerGlyph()
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Show Sidebar")
                }
                AgentMark(agent: session.row.map { $0.dto.agent } ?? (session.isShell ? nil : session.history?.dto.harness), size: 24)
                    .modifier(PaneDragHandle(pane: pane))
                if session.renaming != nil {
                    TextField("Name", text: Binding(get: { session.renaming ?? "" }, set: { session.renaming = $0 }))
                        .font(.ah(.headline))
                        // The theme's field, not the system's black rounded box.
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(theme.tile, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(theme.accent.opacity(0.6), lineWidth: 1))
                        .focused($renameFocused)
                        .onSubmit { Task { await session.commitRename() } }
                        .onKeyPress(.escape) {
                            session.renaming = nil
                            return .handled
                        }
                        .onAppear { renameFocused = true }
                } else {
                    Text(session.title)
                        .font(compact ? .ah(.subheadline).weight(.semibold) : .ah(.headline))
                        .lineLimit(1)
                        .layoutPriority(1)
                        .accessibilityAddTraits(.isHeader)
                }
                if let row = session.row { StatusPill(word: row.word, compact: tight).fixedSize() }
                if let pane, scene.workspace.zoom, let leaves = scene.workspace.layout?.leaves(), let index = leaves.firstIndex(where: { $0.path == pane }) {
                    // Maximized: which pane of how many, and the way back to the split.
                    Button {
                        scene.perform("maximize-pane")
                    } label: {
                        Label("\(index + 1) of \(leaves.count)", systemImage: "arrow.down.right.and.arrow.up.left")
                            .font(.ah(.caption).weight(.semibold))
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(theme.tile, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .fixedSize()
                    .hoverEffect(.highlight)
                    .accessibilityLabel("Maximized, pane \(index + 1) of \(leaves.count). Restore the layout")
                }
                Spacer(minLength: 4)
                if session.isLive && session.hasGUI && !session.isShell {
                    if tight {
                        let other: SceneSnapshot.Surface = session.surface == .gui ? .terminal : .gui
                        Button {
                            scene.setSurface(other, for: session.key)
                        } label: {
                            Image(systemName: other == .terminal ? "terminal" : "text.bubble").headerGlyph()
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(other == .terminal ? "Terminal" : "Messages")
                    } else {
                        Picker("View", selection: Binding(get: { session.surface }, set: { scene.setSurface($0, for: session.key) })) {
                            Image(systemName: "text.bubble").accessibilityLabel("Messages").tag(SceneSnapshot.Surface.gui)
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
                        Image(systemName: pane == nil ? "rectangle.split.2x1" : "rectangle.split.2x2").headerGlyph()
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
                .font(.ah(.caption))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        // Glyphs in the label color, as a bar's are; status and branch keep their own.
        .tint(.primary)
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
            Image(systemName: "sidebar.right").headerGlyph()
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
            Image(systemName: "ellipsis.circle").headerGlyph()
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
            // A shell has no conversation to fork, so it isn't offered.
            return [[
                SessionAction(title: "Resume", symbol: "play") { Task { if let key = await session.resume() { scene.open(key) } } },
                session.isShell ? nil : SessionAction(title: "Fork…", symbol: CommandCatalog.icon("fork")) { scene.sheet = .fork(session.key) },
                SessionAction(title: session.history?.dto.pinned == true ? "Unpin" : "Pin", symbol: session.history?.dto.pinned == true ? "pin.slash" : "pin") { Task { await session.togglePin() } },
                SessionAction(title: "Copy Link", symbol: "link") { scene.copyLink(to: Place(.session(session.key))) },
            ].compactMap { $0 }]
        }
        let pinned = session.row?.dto.pinned == true
        var work: [SessionAction] = []
        if session.row?.dto.branch != nil { work.append(SessionAction(title: "Switch Branch…", symbol: CommandCatalog.icon("switch-branch")) { scene.sheet = .branch(session.key) }) }
        if !session.isShell { work.append(SessionAction(title: "Fork…", symbol: CommandCatalog.icon("fork")) { scene.sheet = .fork(session.key) }) }
        if session.row?.dto.fork != nil { work.append(SessionAction(title: "Forks…", symbol: "arrow.triangle.branch") { scene.sheet = .forks(session.key) }) }
        if session.isLive && session.hasGUI { work.append(SessionAction(title: "Send To…", symbol: CommandCatalog.icon("send-to")) { scene.sheet = .sendTo(session.key) }) }
        if let queued = session.row?.dto.queued, queued > 0 {
            work.append(SessionAction(title: "Send Queued Now (\(queued))", symbol: CommandCatalog.icon("send-now")) { scene.perform("send-now") })
        }
        var view: [SessionAction] = []
        if session.surface == .gui {
            let hidden = scene.app.preferences.stepsHidden
            view.append(SessionAction(title: hidden ? "Show Steps" : "Hide Steps", symbol: hidden ? "list.bullet.indent" : "list.bullet") { scene.perform("toggle-steps") })
            view.append(SessionAction(title: "Copy Last Reply", symbol: CommandCatalog.icon("copy-last")) { scene.perform("copy-last") })
        }
        view.append(SessionAction(title: "Scrollback as Text", symbol: CommandCatalog.icon("scrollback")) { scene.perform("scrollback") })
        view.append(SessionAction(title: "Copy Attach Command", symbol: CommandCatalog.icon("copy-attach")) { scene.perform("copy-attach") })
        let here = Place(.session(session.key), surface: session.surface == .terminal ? .terminal : nil, panel: session.panel)
        view.append(SessionAction(title: "Copy Link", symbol: "link") { scene.copyLink(to: here) })
        view.append(SessionAction(title: "Share Link…", symbol: "square.and.arrow.up") { scene.shareLink(to: here) })
        view.append(SessionAction(title: "All Commands…", symbol: CommandCatalog.icon("command-palette")) { scene.perform("command-palette") })
        return [
            [
                SessionAction(title: "Rename…", symbol: CommandCatalog.icon("rename")) { scene.perform("rename") },
                SessionAction(title: pinned ? "Unpin" : "Pin", symbol: pinned ? "pin.slash" : "pin") { Task { await session.togglePin() } },
            ],
            work,
            view,
            [SessionAction(title: "Terminate…", symbol: CommandCatalog.icon("terminate"), destructive: true) { scene.sheet = .confirmTerminate(session.key) }],
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
                Text("This session has ended").font(.ah(.subheadline).weight(.semibold))
                // A message resumes it only where there's a composer to send one from.
                Text(session.surface == .gui && session.hasGUI ? "Resume it to continue, or just send a message: that resumes it first." : "Resume starts it again in the same folder.")
                    .font(.ah(.caption)).foregroundStyle(theme.muted)
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
                // The banner above says it ended and how to resume: this only says what's missing.
                ContentUnavailableView {
                    Label("No last screen", systemImage: "rectangle.dashed")
                } description: {
                    Text("What this shell showed wasn’t kept when it ended.")
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
                // As the window's toasts are: an error leads with its glyph, its words in ink.
                HStack(spacing: 8) {
                    if notice.tone == .error {
                        Image(systemName: "exclamationmark.circle.fill").foregroundStyle(theme.danger).accessibilityHidden(true)
                    }
                    Text(notice.text).foregroundStyle(theme.text)
                }
                    .font(.ah(.footnote).weight(.medium))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).strokeBorder(notice.tone == .error ? theme.danger.opacity(0.35) : theme.line, lineWidth: 0.75))
                    .shadow(color: theme.shadow, radius: 12, y: 5)
                    .padding(.horizontal, 16)
                    .transition(.move(edge: .top).combined(with: .opacity))
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

/// The rename alert's field and buttons. The field keeps its own text: the alert clears the
/// session's draft as it closes, before Rename's action has run.
private struct RenameAlertFields: View {
    let session: SessionModel
    @State private var name: String

    init(session: SessionModel) {
        self.session = session
        _name = State(initialValue: session.renaming ?? session.title)
    }

    var body: some View {
        TextField("Name", text: $name)
            .textInputAutocapitalization(.sentences)
            .submitLabel(.done)
        Button("Cancel", role: .cancel) {}
        Button("Rename") {
            let typed = name
            Task { await session.commitRename(typed) }
        }
        .keyboardShortcut(.defaultAction)
    }
}

private extension View {
    /// A pane header's glyph button, big enough for a finger on an iPad: the bare glyph was
    /// a 22 by 17 point target.
    func headerGlyph() -> some View {
        frame(minWidth: 30, minHeight: 30).contentShape(Rectangle())
    }
}
