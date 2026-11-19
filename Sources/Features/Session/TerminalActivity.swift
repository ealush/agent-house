import SwiftUI
import UIKit

/// The attached terminal's glyph, with a green dot while a command runs in it (`busy`).
struct TerminalActivityGlyph: View {
    let terminal: AttachedTerminalDTO
    var font: Font = .ah(.caption2)
    /// The glyph's own ink when nothing runs (a row's, on its selection).
    var idle: AnyShapeStyle? = nil
    @Environment(\.theme) private var theme

    var body: some View {
        Image(systemName: "terminal")
            .font(font)
            .foregroundStyle(idle ?? AnyShapeStyle(theme.muted))
            // A badge on the glyph's corner, as an app icon's is.
            .overlay(alignment: .topTrailing) {
                if terminal.busy { ActiveDot().offset(x: 2, y: -2) }
            }
            .accessibilityElement()
            .accessibilityLabel(terminal.busy ? "Attached terminal running \(terminal.command)" : "Terminal attached")
    }
}

/// The green dot that says a terminal is running something.
struct ActiveDot: View {
    var size: CGFloat = 6
    @Environment(\.theme) private var theme

    var body: some View {
        Circle()
            .fill(theme.done)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

enum TerminalGlyph {
    /// A menu row's image: the panel's glyph, with the green dot at its corner while the
    /// terminal runs a command. Drawn as it is (a menu tints a plain symbol one color).
    @MainActor
    static func menuImage(_ symbol: String, active: Bool) -> UIImage? {
        guard let glyph = UIImage(systemName: symbol) else { return nil }
        guard active else { return glyph }
        let traits = UITraitCollection.current
        let ink = UIColor.label.resolvedColor(with: traits)
        let dot = UIColor.systemGreen.resolvedColor(with: traits)
        let size = glyph.size
        let d = max(5, size.height * 0.38)
        let canvas = CGSize(width: size.width + d * 0.3, height: size.height + d * 0.3)
        let image = UIGraphicsImageRenderer(size: canvas).image { _ in
            glyph.withTintColor(ink).draw(at: CGPoint(x: 0, y: d * 0.3))
            let ring = CGRect(x: canvas.width - d - 1, y: 0, width: d + 1, height: d + 1)
            UIColor.systemBackground.resolvedColor(with: traits).setFill()
            UIBezierPath(ovalIn: ring).fill()
            dot.setFill()
            UIBezierPath(ovalIn: ring.insetBy(dx: 1, dy: 1)).fill()
        }
        return image.withRenderingMode(.alwaysOriginal)
    }

    /// What a panel row says under its title: the command the terminal runs.
    @MainActor
    static func subtitle(_ panel: SceneSnapshot.Panel, _ session: SessionModel) -> String? {
        guard panel == .terminal, let terminal = session.row?.dto.terminal, terminal.busy else { return nil }
        return "Running \(terminal.command)"
    }

    @MainActor
    static func panelImage(_ panel: SceneSnapshot.Panel, _ session: SessionModel) -> UIImage? {
        menuImage(panel.symbol, active: panel == .terminal && session.row?.dto.terminal?.busy == true)
    }
}

/// A panel as a menu names it: Terminal shows its dot and what it runs.
struct PanelLabel: View {
    let panel: SceneSnapshot.Panel
    let session: SessionModel

    var body: some View {
        if let subtitle = TerminalGlyph.subtitle(panel, session), let image = TerminalGlyph.panelImage(panel, session) {
            Label {
                Text(panel.title)
                Text(subtitle)
            } icon: {
                Image(uiImage: image).renderingMode(.original)
            }
        } else {
            Label(panel.title, systemImage: panel.symbol)
        }
    }
}

/// The panels button's glyph, with the green dot while the attached terminal runs a command:
/// seen without opening the menu.
struct PanelsGlyphDot: ViewModifier {
    let session: SessionModel

    func body(content: Content) -> some View {
        content.overlay(alignment: .topTrailing) {
            if session.row?.dto.terminal?.busy == true { ActiveDot(size: 5).offset(x: -4, y: 4).allowsHitTesting(false) }
        }
    }
}

/// Send to Chat (and Copy): the attached terminal's last command with its output, what's
/// selected in it, or its screen, into the session's box to say what it's about. The menu is
/// made as it opens, from the host's text of that moment.
struct TerminalChatMenu: UIViewRepresentable {
    let session: SessionModel
    let scene: SceneModel
    /// The terminal on screen, for its selection.
    let controller: TerminalController?
    let tint: UIColor

    func makeUIView(context: Context) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: "text.bubble")
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8)
        let button = UIButton(configuration: config)
        button.showsMenuAsPrimaryAction = true
        button.accessibilityLabel = "Send to Chat"
        button.accessibilityIdentifier = "terminal-send-to-chat"
        button.setContentHuggingPriority(.required, for: .horizontal)
        button.menu = UIMenu(children: [
            UIDeferredMenuElement.uncached { [coordinator = context.coordinator] done in
                coordinator.items(done)
            },
        ])
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        button.tintColor = tint
        context.coordinator.parent = self
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator {
        var parent: TerminalChatMenu

        init(parent: TerminalChatMenu) { self.parent = parent }

        func items(_ done: @escaping ([UIMenuElement]) -> Void) {
            let (session, scene) = (parent.session, parent.scene)
            let selection = parent.controller?.selection
            guard scene.terminalChat(session) else {
                // An older host can't read its terminal back: only what's selected here goes.
                done(menus(last: nil, screen: nil, selection: selection, note: "Last command and screen need a newer ah on the host"))
                return
            }
            Task { @MainActor in
                do {
                    let text = try await session.api.terminalText(session.ref)
                    done(self.menus(last: text.last, screen: text.screen, selection: selection, note: nil))
                } catch {
                    done(self.menus(last: nil, screen: nil, selection: selection, note: "Couldn’t read the terminal: \(APIError.wrap(error).message)"))
                }
            }
        }

        private func menus(last: LastCommandDTO?, screen: String?, selection: String?, note: String?) -> [UIMenuElement] {
            let (session, scene) = (parent.session, parent.scene)
            let screen = screen.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
            // Each as the message quotes it (fenced) and as the clipboard takes it (plain).
            let texts: [(title: String, subtitle: String?, symbol: String, what: String, block: String?, plain: String?)] = [
                ("Last Command and Its Output", last.map(TerminalQuote.title) ?? (note == nil ? "None yet" : nil), "apple.terminal", "the last command", last.map(TerminalQuote.lastCommand), last.map(TerminalQuote.plain)),
                ("Selection", selection == nil ? "Nothing selected" : nil, "selection.pin.in.out", "the selection", selection.map { TerminalQuote.fenced($0) }, selection),
                ("What’s on Screen", nil, "rectangle.dashed", "the screen", screen.map { TerminalQuote.fenced($0) }, screen),
            ]
            func actions(plain: Bool, _ use: @escaping (String, String) -> Void) -> [UIMenuElement] {
                texts.map { text in
                    let value = plain ? text.plain : text.block
                    return UIAction(title: text.title, subtitle: text.subtitle, image: UIImage(systemName: text.symbol), attributes: value == nil ? .disabled : []) { _ in
                        guard let value else { return }
                        Haptics.tap()
                        use(value, text.what)
                    }
                }
            }
            var menus: [UIMenuElement] = []
            if scene.terminalSendsToChat(session) {
                menus.append(UIMenu(title: "Send to Chat", options: .displayInline, children: actions(plain: false) { block, what in scene.addToMessage(block, in: session, what: what) }))
            }
            menus.append(UIMenu(title: "Copy", options: .displayInline, children: actions(plain: true) { text, what in scene.copy(text, say: what) }))
            if let note { menus.append(UIAction(title: note, attributes: .disabled) { _ in }) }
            return menus
        }
    }
}
