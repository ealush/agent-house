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
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var panelWidth: CGFloat = 380

    private var narrow: Bool { sizeClass == .compact || scene.narrow }

    var body: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
                SessionHeader(session: session, scene: scene, compact: compactHeader)
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
                PanelView(panel: panel, session: session, scene: scene)
                    .frame(width: max(280, min(640, panelWidth - CGFloat(scene.panelWidthDelta))))
                    .transition(.move(edge: .trailing))
            }
        }
        .background(theme.background)
        .overlay(alignment: .top) { NoticeStack(session: session) }
        .sheet(item: Binding(get: { narrow ? session.panel : nil }, set: { session.panel = $0 })) { panel in
            NavigationStack {
                PanelView(panel: panel, session: session, scene: scene)
                    .navigationTitle(panel.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { session.panel = nil } } }
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

extension SceneSnapshot.Panel: Identifiable {
    var id: String { rawValue }
}

private struct SessionHeader: View {
    @Bindable var session: SessionModel
    let scene: SceneModel
    var compact: Bool
    @Environment(\.theme) private var theme
    @FocusState private var renameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                AgentMark(agent: session.row?.dto.agent ?? (session.isShell ? nil : session.history?.dto.harness), size: 24)
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
                        .accessibilityAddTraits(.isHeader)
                }
                if let row = session.row { StatusPill(word: row.word) }
                Spacer(minLength: 4)
                if session.isLive && session.hasGUI && !session.isShell {
                    Picker("View", selection: Binding(get: { session.surface }, set: { scene.setSurface($0, for: session.key) })) {
                        Image(systemName: "text.bubble").accessibilityLabel("GUI").tag(SceneSnapshot.Surface.gui)
                        Image(systemName: "terminal").accessibilityLabel("Terminal").tag(SceneSnapshot.Surface.terminal)
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 96)
                }
                PanelsMenu(session: session)
                SessionMenu(session: session, scene: scene)
            }
            if !compact, let row = session.row {
                HStack(spacing: 8) {
                    Text(row.dto.project).foregroundStyle(theme.muted)
                    if let branch = row.dto.branch {
                        Label(branch, systemImage: "arrow.triangle.branch").foregroundStyle(theme.muted).lineLimit(1)
                    }
                    if let launch = row.dto.launch { Text(launch).foregroundStyle(theme.faint).lineLimit(1) }
                    if let limit = row.dto.limit { Label(limit, systemImage: "hourglass").foregroundStyle(theme.limited) }
                    if !session.otherDevices.isEmpty {
                        Label("Also open on \(session.otherDevices.joined(separator: ", "))", systemImage: "rectangle.on.rectangle").foregroundStyle(theme.faint)
                    }
                    if let fork = row.dto.fork, !fork.parentTitle.isEmpty {
                        Label("Fork of \(fork.parentTitle)", systemImage: "arrow.triangle.branch").foregroundStyle(theme.faint).lineLimit(1)
                    }
                }
                .font(.caption)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.bar)
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
                Button("Rename", systemImage: "pencil") { scene.perform("rename") }
                Button(session.row?.dto.pinned == true ? "Unpin" : "Pin", systemImage: "pin") { Task { await session.togglePin() } }
                if session.row?.dto.branch != nil { Button("Switch branch…", systemImage: "arrow.triangle.branch") { scene.sheet = .branch(session.key) } }
                if !session.isShell { Button("Fork…", systemImage: "arrow.triangle.branch") { scene.sheet = .fork(session.key) } }
                if session.row?.dto.feed != nil { Button("Send to…", systemImage: "paperplane") { scene.sheet = .sendTo(session.key) } }
                Button("Scrollback as text", systemImage: "text.alignleft") { scene.perform("scrollback") }
                Button("Copy attach command", systemImage: "terminal") { scene.perform("copy-attach") }
                if session.surface == .gui { Button("Copy last reply", systemImage: "doc.on.doc") { scene.perform("copy-last") } }
                Divider()
                Button("Terminate…", systemImage: "xmark.octagon", role: .destructive) { scene.sheet = .confirmTerminate(session.key) }
            } else {
                Button("Resume", systemImage: "play") {
                    Task { if let key = await session.resume() { scene.open(key) } }
                }
                Button("Fork…", systemImage: "arrow.triangle.branch") { scene.sheet = .fork(session.key) }
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
    @Environment(\.theme) private var theme

    var body: some View {
        ScrollView {
            Text(text ?? "No saved screen.")
                .font(theme.mono)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
        }
        .task { text = await session.scrollback() }
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
