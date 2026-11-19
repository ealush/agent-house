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
    @State private var screenWidth: CGFloat = 1000
    /// This screen put the sidebar away to make room for a panel, and brings it back after.
    @State private var hidSidebarForPanel = false
    /// The conversation's least width beside a panel; past it, the sidebar makes way.
    static let roomBesidePanel: CGFloat = 460

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
                // The conversation and the terminal change places through a short fade: the
                // switch cut from one to the other. Soft at both edges, said outright: left to the
                // system, a phone drew the hard edge, an opaque band with a hairline in a tint the
                // transcript doesn't have.
                ZStack { surface }
                    .animation(.smooth(duration: 0.18), value: session.surface)
                    .scrollEdgeEffectStyle(.soft, for: .vertical)
            }
            if !narrow, let panel = session.panel {
                Divider()
                // Its comment box and fields stay above the keyboard, as the conversation's does.
                AboveKeyboard {
                    NavigationStack {
                        PanelView(panel: panel, session: session, scene: scene)
                            .modifier(PanelChrome(panel: panel, session: session, scene: scene))
                    }
                }
                .ignoresSafeArea(.container, edges: .bottom)
                .frame(width: max(280, min(640, panelWidth - CGFloat(scene.panelWidthDelta))))
                .transition(reduceMotion ? .opacity : .move(edge: .trailing))
            }
        }
        // A panel slides in as it slides out (opened from the menu, it cut in), the
        // conversation making room beside it; Reduce Motion keeps it short.
        .animation(narrow ? nil : (reduceMotion ? Animation.smooth(duration: 0.12) : Animation.snappy(duration: 0.25)), value: session.panel != nil)
        // SwiftUI doesn't move this screen for the keyboard: the conversation stands on it by
        // itself (`ConversationController`, UIKit's keyboard layout guide), and the terminal and a
        // side panel through `AboveKeyboard`, each by as much as the keyboard covers it (in a
        // split, this pane's share). The hosting controllers leave the keyboard out of SwiftUI's
        // safe area (a phone's `SessionHostController`, an iPad's detail column here at its root).
        .ignoresSafeArea(.keyboard)
        // Under the keyboard and the bars too: the keyboard's rounded corners showed the
        // window's black over a terminal that stops at the keyboard.
        .background { theme.surface.ignoresSafeArea() }
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
            open: { path in await preview(path) },
            kept: session.files))
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
        // One tap for what changed: it asks (a question that ends a turn isn't also "done"),
        // or it finished. Not when you stopped it, and not when the session went away.
        .onChange(of: session.row?.dto.status) { old, new in
            // Said aloud too: with VoiceOver on, the pill changing colour said nothing.
            if new == .waiting {
                Haptics.warning()
                AccessibilityNotification.Announcement("\(session.title) needs you").post()
            } else if old == .busy, let new, new != .busy, !session.composer.stoppedLately {
                Haptics.success()
                AccessibilityNotification.Announcement("\(session.title) finished").post()
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// A host path or an inline picture in Quick Look: the session's copy when it has one (an
    /// attachment's tile fetched it for its thumbnail), else fetched now.
    private func preview(_ source: String) async {
        guard let url = await session.files.local(source) else {
            let name = source.hasPrefix("data:") ? "the picture" : Uploads.stripTimestamp((source as NSString).lastPathComponent)
            session.notify("Couldn’t open \(name)", tone: .error)
            return
        }
        previewURL = url
    }

    @ViewBuilder
    private var surface: some View {
        if session.surface == .gui && session.hasGUI {
            // One per session, as the terminal is: a pane switched to another kept the last one's
            // place in its conversation (scrolled back there, this one opened scrolled back too).
            // Under the bars and the home indicator: the transcript runs on beneath them, and the
            // controller keeps its rows and the dock clear of them.
            ConversationSurface(session: session, scene: scene, paneFocused: paneFocused, narrow: narrow) { path in
                await preview(path)
            }
            .ignoresSafeArea(.container)
            .id(session.key)
            .transition(.opacity)
        } else if session.isLive {
            // One per session: a pane switched to another kept the last one's terminal.
            AboveKeyboard { TerminalScreen(session: session, scene: scene) }
                .ignoresSafeArea(.container, edges: .bottom)
                .id(session.key)
                .transition(.opacity)
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
                        PanelLabel(panel: other, session: session)
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
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
                        .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                        .layoutPriority(1)
                        .accessibilityAddTraits(.isHeader)
                }
                if let note = scene.connectionNote(session.key) {
                    // Its status is as of the last word from the host: say that instead.
                    Label(note, systemImage: "wifi.slash")
                        .font(.ah(.caption).weight(.semibold))
                        .foregroundStyle(theme.danger)
                        .labelStyle(.titleAndIcon)
                        .fixedSize()
                        .transition(.opacity)
                } else if let row = session.row {
                    StatusPill(word: row.word, compact: tight).fixedSize()
                }
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
                            Image(systemName: other == .terminal ? "terminal" : "text.bubble")
                                .contentTransition(.symbolEffect(.replace))
                                .headerGlyph()
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel(other == .terminal ? "Agent Terminal" : "Messages")
                    } else {
                        Picker("View", selection: Binding(get: { session.surface }, set: { scene.setSurface($0, for: session.key) })) {
                            Image(systemName: "text.bubble").accessibilityLabel("Messages").tag(SceneSnapshot.Surface.gui)
                            Image(systemName: "terminal").accessibilityLabel("Agent Terminal").tag(SceneSnapshot.Surface.terminal)
                        }
                        .pickerStyle(.segmented)
                        .frame(width: 96)
                    }
                }
                PermissionShield(session: session, scene: scene)
                    .transition(.scale.combined(with: .opacity))
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
                    if let continued = row.dto.continued {
                        // Where its conversation came from (another agent, or a fork): its
                        // whole family, and the way back to the original.
                        Button {
                            scene.sheet = .lineage(session.key)
                        } label: {
                            Label(ContinueWords.origin(continued) { id in scene.hub?.presets(host: row.isLocal ? nil : row.host).first { $0.id == id }?.name ?? id }, systemImage: "arrow.turn.down.right").lineLimit(1)
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(theme.faint)
                        .accessibilityHint("Show where this conversation came from")
                    }
                }
                .font(.ah(.caption))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        // The shield arrives and leaves, and the view switch turns its glyph over, in place.
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: session.launch.warning != nil)
        .animation(reduceMotion ? nil : .snappy(duration: 0.18), value: session.surface)
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
struct PaneDragHandle: ViewModifier {
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
            // The open one checked, as a menu marks what's on, its glyph kept (a checkmark
            // stood in for it).
            ForEach(SceneSnapshot.Panel.allCases.filter { $0.applies(to: session) }) { panel in
                Toggle(isOn: Binding(get: { session.panel == panel }, set: { session.panel = $0 ? panel : nil })) {
                    PanelLabel(panel: panel, session: session)
                }
            }
        } label: {
            Image(systemName: "sidebar.right").headerGlyph().modifier(PanelsGlyphDot(session: session))
        }
        .accessibilityLabel("Panels")
    }
}

/// A dangerous permission mode in force: a red shield whose menu says what it means, and the
/// modes to switch to, each with what it lets the agent do. The phone's navigation bar has
/// the same as a UIMenu (`SessionHostController`).
struct PermissionShield: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        let launch = session.launch
        if session.isLive, !session.isShell, let warning = launch.warning, let modes = launch.preset?.modes {
            Menu {
                Section(warning) {
                    ForEach(modes, id: \.id) { mode in
                        // A toggle, since a picker's option shows only its first line.
                        Toggle(isOn: Binding(get: { mode.id == launch.mode?.id }, set: { _ in
                            if mode.id != launch.mode?.id { scene.applyPlan(session.planMode(mode.id), to: session) }
                        })) {
                            Text(mode.name)
                            if let detail = mode.description { Text(detail) }
                        }
                    }
                }
                Section { Text(launch.footer(.mode)) }
            } label: {
                Image(systemName: "exclamationmark.shield.fill").foregroundStyle(theme.danger).headerGlyph()
            }
            .menuOrder(.fixed)
            .accessibilityLabel("Permissions, \(launch.mode?.name ?? "")")
            .accessibilityHint(warning)
        }
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
                        if action.active, let image = TerminalGlyph.menuImage(action.symbol, active: true) {
                            Button(role: action.destructive ? .destructive : nil, action: action.run) {
                                Label {
                                    Text(action.title)
                                    if let subtitle = action.subtitle { Text(subtitle) }
                                } icon: {
                                    Image(uiImage: image).renderingMode(.original)
                                }
                            }
                        } else {
                            Button(action.title, systemImage: action.symbol, role: action.destructive ? .destructive : nil, action: action.run)
                        }
                    }
                }
            }
        } label: {
            // The bars' "more" glyph, as the phone's session bar and every page's has it.
            Image(systemName: "ellipsis").headerGlyph()
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
    /// Under the title: what it's doing (the attached terminal's running command).
    var subtitle: String? = nil
    /// The green dot on its glyph: the attached terminal runs a command.
    var active = false
    let run: @MainActor () -> Void

    var id: String { title }

    @MainActor
    static func sections(_ session: SessionModel, _ scene: SceneModel) -> [[SessionAction]] {
        guard session.isLive else {
            // A shell has no conversation to fork, so it isn't offered.
            return [[
                SessionAction(title: "Resume", symbol: "play") { Task { if let key = await session.resume() { scene.open(key) } } },
                session.isShell ? nil : SessionAction(title: "Fork…", symbol: CommandCatalog.icon("fork")) { scene.sheet = .fork(session.key) },
                session.isShell ? nil : SessionAction(title: "Continue in Another Agent…", symbol: CommandCatalog.icon("continue-in")) { scene.sheet = .continueIn(key: session.key, preset: nil) },
                session.isShell || !scene.portable(session) ? nil : SessionAction(title: "Conversation Lineage", symbol: CommandCatalog.icon("conversation-lineage")) { scene.sheet = .lineage(session.key) },
                SessionAction(title: session.history?.dto.pinned == true ? "Unpin" : "Pin", symbol: session.history?.dto.pinned == true ? "pin.slash" : "pin") { Task { await session.togglePin() } },
                SessionAction(title: "Copy Link", symbol: "link") { scene.copyLink(to: Place(.session(session.key))) },
            ].compactMap { $0 }]
        }
        let pinned = session.row?.dto.pinned == true
        var work: [SessionAction] = []
        if scene.attachedTerminal(session) {
            work.append(SessionAction(title: "Terminal", symbol: "terminal", subtitle: TerminalGlyph.subtitle(.terminal, session), active: session.row?.dto.terminal?.busy == true) { session.panel = .terminal })
        }
        if session.row?.dto.branch != nil { work.append(SessionAction(title: "Switch Branch…", symbol: CommandCatalog.icon("switch-branch")) { scene.sheet = .branch(session.key) }) }
        if !session.isShell { work.append(SessionAction(title: "Fork…", symbol: CommandCatalog.icon("fork")) { scene.sheet = .fork(session.key) }) }
        if session.row?.dto.fork != nil { work.append(SessionAction(title: "Forks…", symbol: "square.on.square") { scene.sheet = .forks(session.key) }) }
        if !session.isShell && session.hasGUI { work.append(SessionAction(title: "Continue in Another Agent…", symbol: CommandCatalog.icon("continue-in")) { scene.sheet = .continueIn(key: session.key, preset: nil) }) }
        if !session.isShell && scene.portable(session) { work.append(SessionAction(title: "Conversation Lineage", symbol: CommandCatalog.icon("conversation-lineage")) { scene.sheet = .lineage(session.key) }) }
        if session.isLive && session.hasGUI { work.append(SessionAction(title: "Send To…", symbol: CommandCatalog.icon("send-to")) { scene.sheet = .sendTo(session.key) }) }
        if let queued = session.row?.dto.queued, queued > 0 {
            work.append(SessionAction(title: "Send Queued Now (\(queued))", symbol: CommandCatalog.icon("send-now")) { scene.perform("send-now") })
        }
        var view: [SessionAction] = []
        if session.surface == .gui {
            let hidden = scene.app.preferences.focusMode ? !session.stepsShown : scene.app.preferences.stepsHidden
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
            Image(systemName: "moon.zzz").foregroundStyle(theme.muted).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text("This session has ended").font(.ah(.subheadline).weight(.semibold))
                // A message resumes it only where there's a composer to send one from.
                Text(session.surface == .gui && session.hasGUI ? "Resume it to continue, or just send a message: that resumes it first." : "Resume starts it again in the same folder.")
                    .font(.ah(.caption)).foregroundStyle(theme.muted)
            }
            Spacer()
            // Says it's on its way while the host starts it again (a few seconds for an
            // agent), and takes no second tap: one did, and two sessions resumed.
            let resuming = session.busy.contains("resume")
            Button {
                Task { if let key = await session.resume() { scene.open(key) } }
            } label: {
                ZStack {
                    Text("Resume").opacity(resuming ? 0 : 1)
                    if resuming { ProgressView().controlSize(.small).tint(theme.accentInk) }
                }
            }
            .buttonStyle(.borderedProminent)
            .tint(theme.accentStrong)
            .disabled(resuming)
            .accessibilityLabel(resuming ? "Resuming" : "Resume")
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
                    .task {
                        try? await Task.sleep(for: .seconds(notice.tone == .error ? 6 : 3))
                        session.dismiss(notice.id)
                    }
                    .onTapGesture { session.dismiss(notice.id) }
                    .accessibilityAddTraits(.isStaticText)
                    // Spoken as it comes, as the window's toasts are; it's gone in seconds.
                    .onAppear { AccessibilityNotification.Announcement(notice.text).post() }
            }
        }
        .padding(.top, 60)
        .animation(reduceMotion ? .smooth(duration: 0.2) : .spring(duration: 0.35, bounce: 0.2), value: session.notices.map(\.id))
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

extension View {
    /// A pane header's glyph button, big enough for a finger on an iPad: the bare glyph was
    /// a 22 by 17 point target.
    func headerGlyph() -> some View {
        // Drawn in 30 points, hit in the 44 a finger needs.
        frame(minWidth: 30, minHeight: 30).contentShape(Rectangle()).touchTarget()
    }
}
