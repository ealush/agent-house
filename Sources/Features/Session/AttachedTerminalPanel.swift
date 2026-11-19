import SwiftUI

/// The owner's companion shell, beside the conversation on iPad and in a panel sheet on iPhone.
struct AttachedTerminalPanel: View {
    let session: SessionModel
    let scene: SceneModel
    @State private var opened = false
    @State private var opening = false
    @State private var error: String?
    @State private var confirmingStop = false
    /// The terminal on screen, for Send to Chat's selection.
    @State private var controller: TerminalController?
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let terminal = session.row?.dto.terminal {
                    TerminalActivityGlyph(terminal: terminal, font: .ah(.body))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(terminal.cwd).font(.ahMono(.caption)).lineLimit(1).truncationMode(.middle)
                        if terminal.busy {
                            Text("Running \(terminal.command)").font(.ah(.caption2)).foregroundStyle(theme.done).lineLimit(1)
                        }
                    }
                }
                Spacer()
                if opened {
                    TerminalChatMenu(session: session, scene: scene, controller: controller, tint: UIColor(theme.text2))
                        .fixedSize()
                    Button("Stop Terminal", systemImage: "stop.circle", role: .destructive) { confirmingStop = true }
                        .labelStyle(.iconOnly)
                }
            }
            .padding(10)
            .animation(.smooth(duration: 0.2), value: session.row?.dto.terminal?.busy)
            if let error { Text(error).font(.ah(.callout)).foregroundStyle(theme.danger).padding() }
            if opened {
                TerminalScreen(session: session, scene: scene, attached: true) { controller = $0 }
            } else {
                Spacer()
                Button(opening ? "Opening Terminal…" : "Open Terminal") { Task { await open() } }
                    .disabled(opening)
                Spacer()
            }
        }
        .task(id: session.key) { await open() }
        .onChange(of: session.row?.dto.terminal?.id) { old, new in
            if old != nil && new == nil { opened = false }
        }
        .confirmationDialog("Stop the attached terminal and everything running in it?", isPresented: $confirmingStop, titleVisibility: .visible) {
            Button("Stop Terminal", role: .destructive) {
                Task {
                    do {
                        try await session.api.closeTerminal(session.ref)
                        opened = false
                        session.hub.refresh(host: SessionKey(session.key)?.host)
                    } catch { self.error = APIError.wrap(error).message }
                }
            }
        }
    }

    private func open() async {
        guard !opening else { return }
        opening = true
        error = nil
        defer { opening = false }
        do {
            let result = try await session.api.openTerminal(session.ref)
            guard !Task.isCancelled else { return }
            opened = result.terminal != nil
            session.hub.refresh(host: SessionKey(session.key)?.host)
            if scene.hardwareKeyboard { scene.requestFocus(.attachedTerminal(session.key)) }
        } catch { self.error = APIError.wrap(error).message }
    }
}
