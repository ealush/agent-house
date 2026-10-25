import SwiftTerm
import SwiftUI
import UIKit

/// A session's real terminal: SwiftTerm's emulator fed by a WebSocket to a tmux viewer of
/// its own, so this device looks independently of every other. Keys go out only on a live
/// socket; while it reconnects the screen says so instead of swallowing them.
struct TerminalScreen: View {
    let session: SessionModel
    @Bindable var scene: SceneModel
    @State private var controller: TerminalController?
    @State private var ctrl = false
    @State private var alt = false
    @State private var shift = false
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if let controller {
                    TerminalViewRepresentable(controller: controller, scene: scene, sessionKey: session.key, sticky: StickyModifiers(ctrl: $ctrl, alt: $alt, shift: $shift))
                        // A little breathing room inside the terminal's own background.
                        .padding(.horizontal, 10)
                        .padding(.top, 6)
                        .ignoresSafeArea(.container, edges: .bottom)
                }
                if let controller {
                    TerminalStatusOverlay(controller: controller, session: session)
                }
            }
            if session.waiting, session.row?.dto.ask != nil {
                AskPanelView(target: AskTarget(session: session), keyboard: AskKeyboard(scene: scene, key: session.key, leave: .terminal(session.key)), onReply: { scene.requestFocus(.terminal(session.key)) })
                    .padding(10)
            }
            if scene.app.preferences.showsKeyBar(hardwareKeyboard: scene.hardwareKeyboard) {
                KeyBar(ctrl: $ctrl, alt: $alt, shift: $shift) { bytes in
                    controller?.send(bytes)
                } paste: {
                    controller?.paste()
                }
            }
        }
        .background(Color(uiColor: UIColor(hex: theme.palette.terminal.background)))
        .task(id: session.key) {
            let made = TerminalController(session: session, fontSize: scene.app.preferences.terminalFontSize, palette: theme.palette.terminal)
            controller = made
            made.start()
        }
        .onDisappear { controller?.stop() }
        .onChange(of: theme.palette.terminal) { _, palette in controller?.apply(palette) }
    }
}

struct StickyModifiers {
    @Binding var ctrl: Bool
    @Binding var alt: Bool
    @Binding var shift: Bool
}

/// Owns the emulator view and the connection, and turns one into the other.
@MainActor
@Observable
final class TerminalController: NSObject, TerminalViewDelegate {
    let session: SessionModel
    let view: AppTerminalView
    private let connection: TerminalConnection
    private(set) var status: Status = .connecting
    private var events: Task<Void, Never>?
    private var lastSize: (cols: Int, rows: Int) = (0, 0)

    enum Status: Equatable {
        case connecting
        case live
        case reconnecting(String)
        case ended(TerminalEnd)
    }

    init(session: SessionModel, fontSize: Double, palette: TerminalPalette) {
        self.session = session
        view = AppTerminalView(frame: .zero, font: UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular))
        let hub = session.hub
        let key = session.key
        connection = TerminalConnection(api: session.api, columns: 80, rows: 24) {
            await MainActor.run { hub.row(key)?.dto.id }
        }
        super.init()
        view.terminalDelegate = self
        view.optionAsMetaKey = true
        view.allowMouseReporting = true
        view.isScrollEnabled = false
        apply(palette)
        view.controller = self
        view.accessibilityLabel = "Terminal for \(session.title)"
    }

    func apply(_ palette: TerminalPalette) {
        view.nativeBackgroundColor = UIColor(hex: palette.background)
        view.nativeForegroundColor = UIColor(hex: palette.foreground)
        view.caretColor = UIColor(hex: palette.cursor)
        view.selectedTextBackgroundColor = UIColor(hex: palette.selection)
        let colors = palette.ansi.map { hex -> SwiftTerm.Color in
            let c = hexComponents(hex) ?? (1, 1, 1, 1)
            return SwiftTerm.Color(red: UInt16(c.r * 65535), green: UInt16(c.g * 65535), blue: UInt16(c.b * 65535))
        }
        if colors.count == 16 { view.installColors(colors) }
    }

    func start() {
        guard events == nil else { return }
        let stream = connection
        events = Task { [weak self] in
            let updates = await stream.events()
            await stream.start()
            for await event in updates {
                guard let self else { return }
                switch event {
                case .connected:
                    self.status = .live
                    // A fresh viewer redraws at its own size.
                    if self.lastSize.cols > 0 { await stream.resize(columns: self.lastSize.cols, rows: self.lastSize.rows) }
                case .output(let data):
                    self.view.feed(byteArray: [UInt8](data)[...])
                case .disconnected(let reason, _):
                    self.status = .reconnecting(reason)
                case .ended(let end):
                    self.status = .ended(end)
                }
            }
        }
    }

    func stop() {
        events?.cancel()
        events = nil
        let connection = connection
        Task { await connection.stop() }
    }

    func reconnect() {
        let connection = connection
        Task { await connection.reconnect() }
    }

    /// Bytes from the key bar or a hardware key: sent only on a live socket.
    func send(_ text: String) {
        let connection = connection
        Task { [weak self] in
            let delivered = await connection.send(.input(text))
            if !delivered { await MainActor.run { self?.status = .reconnecting("Not connected: that key wasn’t sent") } }
        }
    }

    /// Paste as the application asked for it: SwiftTerm brackets it when the app turned
    /// bracketed paste on, and hands the bytes back through `send(source:data:)`.
    func paste() {
        view.paste(nil)
    }

    /// Touch scrolling scrolls tmux's history by exact lines (`server/terminal.ts scrollLines`).
    func scroll(lines: Int, column: Int, row: Int) {
        let connection = connection
        Task { _ = await connection.send(.scroll(lines: lines, column: column, row: row)) }
    }

    // MARK: TerminalViewDelegate

    nonisolated func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
        MainActor.assumeIsolated {
            lastSize = (newCols, newRows)
            let connection = connection
            Task { await connection.resize(columns: newCols, rows: newRows) }
        }
    }

    nonisolated func setTerminalTitle(source: TerminalView, title: String) {}
    nonisolated func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}

    nonisolated func send(source: TerminalView, data: ArraySlice<UInt8>) {
        let text = String(decoding: data, as: UTF8.self)
        MainActor.assumeIsolated { send(text) }
    }

    nonisolated func scrolled(source: TerminalView, position: Double) {}

    nonisolated func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
        MainActor.assumeIsolated {
            if case .external(let url) = LinkPolicy.classify(link) { UIApplication.shared.open(url) }
        }
    }

    nonisolated func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
}

/// SwiftTerm's view, with the app's keyboard commands taking their keys first and the
/// web's Command/Option arrow conventions (`terminalArrow`) applied.
final class AppTerminalView: TerminalView {
    weak var controller: TerminalController?
    weak var scene: SceneModel?
    /// The session this terminal shows, for the window's focus bookkeeping.
    var sessionKey: String?
    var sticky: StickyModifiers?
    private var panRemainder: CGFloat = 0

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            scene?.keyScope = .terminal
            if let sessionKey { scene?.didFocus(.terminal(sessionKey)) }
        }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned, scene?.keyScope == .terminal { scene?.keyScope = .app }
        if resigned, let sessionKey { scene?.didBlur(.terminal(sessionKey)) }
        return resigned
    }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var rest = Set<UIPress>()
        for press in presses {
            guard let key = press.key else {
                rest.insert(press)
                continue
            }
            let keyPress = KeyPress(key)
            if !keyPress.isModifierOnly, let scene, scene.handle(keyPress, scope: .terminal) { continue }
            if let name = keyPress.key,
               let bytes = TerminalKeys.arrow(name, meta: keyPress.modifiers.contains(.command), alt: keyPress.modifiers.contains(.option), ctrl: keyPress.modifiers.contains(.control), shift: keyPress.modifiers.contains(.shift)) {
                controller?.send(bytes)
                continue
            }
            rest.insert(press)
        }
        if !rest.isEmpty { super.pressesBegan(rest, with: event) }
    }

    /// Sticky modifiers from the key bar apply to the next typed character.
    override func insertText(_ text: String) {
        if let sticky, sticky.ctrl || sticky.alt || sticky.shift {
            let out = TerminalKeys.applyModifiers(text, ctrl: sticky.ctrl, alt: sticky.alt, shift: sticky.shift)
            sticky.ctrl = false
            sticky.alt = false
            sticky.shift = false
            controller?.send(out)
            return
        }
        super.insertText(text)
    }

    func installTouchScrolling() {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.allowedScrollTypesMask = .all
        pan.maximumNumberOfTouches = 1
        addGestureRecognizer(pan)
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        addGestureRecognizer(pinch)
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let lineHeight = font.lineHeight
        let dy = pan.translation(in: self).y + panRemainder
        pan.setTranslation(.zero, in: self)
        let lines = Int(dy / lineHeight)
        panRemainder = dy - CGFloat(lines) * lineHeight
        guard lines != 0 else { return }
        let point = pan.location(in: self)
        let column = max(1, Int(point.x / max(1, font.pointSize * 0.6)) + 1)
        let row = max(1, Int(point.y / max(1, lineHeight)) + 1)
        // Finger down moves the text down: older output, a positive line count.
        controller?.scroll(lines: lines, column: column, row: row)
        if pan.state == .ended { panRemainder = 0 }
    }

    @objc private func pinched(_ pinch: UIPinchGestureRecognizer) {
        guard pinch.state == .changed || pinch.state == .ended else { return }
        let size = min(28, max(8, font.pointSize * pinch.scale))
        pinch.scale = 1
        font = UIFont.monospacedSystemFont(ofSize: size, weight: .regular)
    }
}

struct TerminalViewRepresentable: UIViewRepresentable {
    let controller: TerminalController
    let scene: SceneModel
    let sessionKey: String
    let sticky: StickyModifiers

    func makeUIView(context: Context) -> AppTerminalView {
        let view = controller.view
        view.scene = scene
        view.sessionKey = sessionKey
        view.sticky = sticky
        view.installTouchScrolling()
        return view
    }

    func updateUIView(_ view: AppTerminalView, context: Context) {
        view.sticky = sticky
        if let request = scene.focusRequest, request.nonce != context.coordinator.handled {
            context.coordinator.handled = request.nonce
            if request.target == .terminal(sessionKey) {
                DispatchQueue.main.async { _ = view.becomeFirstResponder() }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var handled = 0
    }
}

private struct TerminalStatusOverlay: View {
    let controller: TerminalController
    let session: SessionModel
    @Environment(\.theme) private var theme

    var body: some View {
        switch controller.status {
        case .live:
            EmptyView()
        case .connecting:
            Label("Attaching…", systemImage: "bolt.horizontal").font(.caption).padding(8).background(.thinMaterial, in: Capsule()).padding(.top, 8)
        case .reconnecting(let reason):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Reconnecting. Keys typed now aren’t sent.").font(.caption)
                Button("Retry") { controller.reconnect() }.font(.caption).buttonStyle(.bordered)
            }
            .padding(8)
            .background(.thinMaterial, in: Capsule())
            .padding(.top, 8)
            .accessibilityLabel("Terminal reconnecting. \(reason)")
        case .ended(let end):
            Banner(text: end == .signedOut ? "Signed out: this terminal closed." : "This session isn’t running any more.", tone: .warning)
                .padding()
        }
    }
}

/// The on-screen key row (`../ah/web/KeyBar.tsx`): Esc, Tab, ⇧Tab, arrows, sticky Ctrl/Alt/Shift, paste.
struct KeyBar: View {
    @Binding var ctrl: Bool
    @Binding var alt: Bool
    @Binding var shift: Bool
    let send: (String) -> Void
    let paste: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(TerminalKeys.bar, id: \.label) { key in
                    Button(key.label) {
                        Haptics.tap()
                        send(TerminalKeys.applyModifiers(key.bytes, ctrl: ctrl, alt: alt, shift: shift))
                        ctrl = false
                        alt = false
                        shift = false
                    }
                    .accessibilityLabel(key.name)
                    .buttonStyle(KeyCapStyle(on: false))
                }
                Toggle("ctrl", isOn: $ctrl).toggleStyle(KeyToggleStyle()).accessibilityLabel("Control for the next key")
                Toggle("alt", isOn: $alt).toggleStyle(KeyToggleStyle()).accessibilityLabel("Option for the next key")
                Toggle("shift", isOn: $shift).toggleStyle(KeyToggleStyle()).accessibilityLabel("Shift for the next key")
                Button {
                    paste()
                } label: {
                    Image(systemName: "doc.on.clipboard")
                }
                .accessibilityLabel("Paste")
                .buttonStyle(KeyCapStyle(on: false))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        .background(theme.surface)
    }
}

private struct KeyCapStyle: ButtonStyle {
    let on: Bool
    @Environment(\.theme) private var theme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.monospaced())
            .padding(.horizontal, 12)
            .frame(minWidth: 44, minHeight: 36)
            .background(on || configuration.isPressed ? theme.accent.opacity(0.3) : theme.raised, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .foregroundStyle(theme.text)
    }
}

private struct KeyToggleStyle: ToggleStyle {
    @Environment(\.theme) private var theme
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
            Haptics.selection()
        } label: {
            configuration.label
        }
        .buttonStyle(KeyCapStyle(on: configuration.isOn))
        .accessibilityAddTraits(configuration.isOn ? .isSelected : [])
    }
}
