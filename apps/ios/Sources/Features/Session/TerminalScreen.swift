import SwiftTerm
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// A session's real terminal: SwiftTerm's emulator fed by a WebSocket to a tmux viewer of
/// its own, so this device looks independently of every other. Keys go out only on a live
/// socket; while it reconnects the screen says so instead of swallowing them.
struct TerminalScreen: View {
    let session: SessionModel
    @Bindable var scene: SceneModel
    var attached = false
    /// Told the terminal's controller as it changes (a new attach, gone in the background):
    /// the attached panel's Send to Chat reads its selection.
    var onController: ((TerminalController?) -> Void)? = nil
    @State private var controller: TerminalController?
    @State private var ctrl = false
    @State private var alt = false
    @State private var shift = false
    @State private var dropping = false
    /// The question you chose to answer in the terminal itself: its card stays aside until another comes.
    @State private var setAside: String?
    /// Bumped to attach afresh (back from the background).
    @State private var attachment = 0
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .top) {
                if let controller {
                    TerminalViewRepresentable(controller: controller, scene: scene, sessionKey: session.key, sticky: StickyModifiers(ctrl: $ctrl, alt: $alt, shift: $shift), attached: attached)
                        // A view of its own per controller: kept, the last session's frozen
                        // screen stayed up, taking the keys, while the new one wasn't drawn.
                        .id(ObjectIdentifier(controller))
                        // A little breathing room inside the terminal's own background.
                        .padding(.horizontal, 10)
                        .padding(.top, 6)
                        .ignoresSafeArea(.container, edges: .bottom)
                }
                if let controller {
                    TerminalStatusOverlay(controller: controller, session: session)
                }
                if dropping {
                    Label("Drop to upload, and type its path", systemImage: "arrow.down.doc")
                        .font(.ah(.callout).weight(.medium))
                        .padding(.horizontal, 14).padding(.vertical, 10)
                        .background(.thinMaterial, in: Capsule())
                        .padding(.top, 16)
                }
            }
            // Files dropped from Files, Photos or Finder upload to the host, and their paths are
            // typed in (`apps/server/web/TerminalSurface.tsx`).
            .onDrop(of: [.fileURL, .image, .data], isTargeted: $dropping) { providers in
                controller?.upload(providers)
                return controller != nil
            }
            // Over the terminal it answers in, the card can be put aside (a sign-in that wants its
            // code pasted into the terminal, a screen it reads wrong): it's back for the next question.
            if !attached, session.waiting, let ask = session.row?.dto.ask, setAside != (session.row?.dto.askId ?? ask.text) {
                AskPanelView(target: AskTarget(session: session), keyboard: AskKeyboard(scene: scene, key: session.key, leave: .terminal(session.key)), onReply: { scene.requestFocus(.terminal(session.key)) }, onUseTerminal: {
                    setAside = session.row?.dto.askId ?? ask.text
                    scene.requestFocus(.terminal(session.key))
                })
                    .padding(10)
            }
            if scene.app.preferences.showsKeyBar(hardwareKeyboard: scene.hardwareKeyboard) {
                KeyBar(ctrl: $ctrl, alt: $alt, shift: $shift, hideKeyboard: controller?.hasKeyboard == true ? { controller?.view.endEditing(true) } : nil) { bytes in
                    controller?.send(bytes)
                } paste: {
                    controller?.paste()
                }
            }
        }
        .background(Color(uiColor: UIColor(hex: theme.palette.terminal.background)))
        .task(id: "\(session.key)#\(attached)#\(attachment)") {
            let made = TerminalController(session: session, fontSize: scene.app.preferences.terminalFontSize, palette: theme.palette.terminal, attached: attached)
            // The one before (another session's, in the same pane) detaches: left running, its
            // socket stayed open and counted this device as watching that session.
            controller?.stop()
            controller = made
            onController?(made)
            made.start()
        }
        .onDisappear {
            controller?.stop()
            onController?(nil)
        }
        // An attached terminal counts as this device looking (ah's viewers): its window going
        // to the background detaches it, so what happens meanwhile isn't taken as seen; coming
        // back reattaches. This window's, not the app's: on an iPad another window can stay up.
        .onChange(of: scene.inBackground) { _, away in
            if away {
                controller?.stop()
                controller = nil
                onController?(nil)
            } else if controller == nil {
                attachment += 1
            }
        }
        .onChange(of: theme.palette.terminal) { _, palette in controller?.apply(palette) }
        .onChange(of: scene.app.preferences.terminalFontSize) { _, size in controller?.setFontSize(size) }
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
    let isCompanion: Bool
    let view: AppTerminalView
    private let connection: TerminalConnection
    private(set) var status: Status = .connecting
    /// The terminal has the keyboard (the key bar offers to put an on-screen one away).
    var hasKeyboard = false
    private var events: Task<Void, Never>?
    private var lastSize: (cols: Int, rows: Int) = (0, 0)
    /// Attached before: the next attach starts the screen afresh.
    private var attached = false

    enum Status: Equatable {
        case connecting
        case live
        case reconnecting(String)
        case ended(TerminalEnd)
    }

    init(session: SessionModel, fontSize: Double, palette: TerminalPalette, attached: Bool = false) {
        self.session = session
        self.isCompanion = attached
        view = AppTerminalView(frame: .zero, font: AhType.terminalFont(fontSize))
        let hub = session.hub
        let key = session.key
        let api = session.api
        let ref = session.ref
        connection = TerminalConnection(api: session.api, columns: 80, rows: 24) {
            if attached { return try await api.attachedTerminal(ref).terminal?.id }
            return await MainActor.run { hub.row(key)?.dto.id }
        }
        super.init()
        view.terminalDelegate = self
        // One key row, the app's (`KeyBar`), not SwiftTerm's own as well.
        view.inputAccessoryView = nil
        view.optionAsMetaKey = true
        view.allowMouseReporting = true
        view.isScrollEnabled = false
        apply(palette)
        view.controller = self
        view.accessibilityLabel = "\(attached ? "Attached terminal" : "Terminal") for \(session.title)"
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
                    // A clean slate for the new attach's repaint, as the web's terminal does: a
                    // stream cut mid-sequence (or old modes) garbled its first screen.
                    if self.attached { self.view.feed(byteArray: [0x1b, 0x63][...]) }
                    self.attached = true
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
            if !delivered {
                await MainActor.run {
                    // Ended stays ended: nothing reconnects it, so "Reconnecting…" never resolved.
                    if case .ended? = self?.status { return }
                    self?.status = .reconnecting("Not connected: that key wasn’t sent")
                }
            }
        }
    }

    /// What's selected in the terminal now, if anything.
    var selection: String? {
        let text = view.getSelection() ?? ""
        return text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
    }

    /// Paste as the application asked for it: SwiftTerm brackets it when the app turned
    /// bracketed paste on, and hands the bytes back through `send(source:data:)`. Images (a
    /// screenshot) upload instead, and their paths are typed in.
    func paste() {
        view.paste(nil)
    }

    func setFontSize(_ size: Double) {
        guard abs(view.font.pointSize - size) > 0.1 else { return }
        view.font = AhType.terminalFont(size)
    }

    /// Uploads to the host, then types the paths (quoted when they need it) where the cursor is.
    func upload(files: [(name: String, data: Data)]) {
        guard !files.isEmpty else { return }
        let api = session.api
        Task { [weak self] in
            do {
                var paths: [String] = []
                for file in files { paths.append(try await api.upload(name: file.name, data: file.data)) }
                self?.send(Uploads.typed(paths))
                _ = self?.view.becomeFirstResponder()
            } catch {
                self?.session.notify("Couldn’t upload: \(APIError.wrap(error).message)", tone: .error)
            }
        }
    }

    /// Dropped items: each one's file (or image) data, under its own name, in the order dropped.
    func upload(_ providers: [NSItemProvider]) {
        let group = DispatchGroup()
        let collected = DroppedFiles()
        for (index, provider) in providers.enumerated() {
            let type = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true } ?? UTType.data.identifier
            let name = provider.suggestedName
            group.enter()
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                defer { group.leave() }
                guard let url, let data = try? Data(contentsOf: url) else { return }
                let file = name.map { n in url.pathExtension.isEmpty || n.hasSuffix(".\(url.pathExtension)") ? n : "\(n).\(url.pathExtension)" } ?? url.lastPathComponent
                collected.add(index, file, data)
            }
        }
        group.notify(queue: .main) { [weak self] in
            MainActor.assumeIsolated { self?.upload(files: collected.inOrder) }
        }
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
    var attached = false
    private var focusTarget: SceneModel.FocusTarget? { sessionKey.map { attached ? .attachedTerminal($0) : .terminal($0) } }
    var sticky: StickyModifiers?
    private var panRemainder: CGFloat = 0

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became {
            controller?.hasKeyboard = true
            scene?.keyScope = .terminal
            if let focusTarget { scene?.didFocus(focusTarget) }
        }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { controller?.hasKeyboard = false }
        if resigned, scene?.keyScope == .terminal { scene?.keyScope = .app }
        if resigned, let focusTarget { scene?.didBlur(focusTarget) }
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
        scrollPan = pan
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched(_:)))
        addGestureRecognizer(pinch)
        // A tap on a terminal that hasn't the keyboard takes it. SwiftTerm otherwise sends a
        // program that tracks the mouse (tmux does) the click instead, and a phone could never
        // type into it; the next tap reaches the program as usual.
        let focus = UITapGestureRecognizer(target: self, action: #selector(focusTapped))
        addGestureRecognizer(focus)
        focusTap = focus
        for other in gestureRecognizers ?? [] where other !== focus {
            if let tap = other as? UITapGestureRecognizer, tap.numberOfTapsRequired == 1 { tap.require(toFail: focus) }
        }
    }

    private weak var scrollPan: UIPanGestureRecognizer?
    private weak var focusTap: UITapGestureRecognizer?

    /// The focusing tap only while the terminal hasn't the keyboard; touch scrolling only while
    /// nothing is selected (a drag then extends the selection, SwiftTerm's own).
    override func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
        if gesture === focusTap { return !isFirstResponder }
        if gesture === scrollPan { return (getSelection() ?? "").isEmpty }
        return super.gestureRecognizerShouldBegin(gesture)
    }

    @objc private func focusTapped() {
        _ = becomeFirstResponder()
    }

    /// A flick keeps scrolling and slows down, like any scroll view (`apps/server/web/Terminal.tsx`).
    private var momentum: Task<Void, Never>?

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        if pan.state == .began { momentum?.cancel() }
        let dy = pan.translation(in: self).y
        pan.setTranslation(.zero, in: self)
        scrollBy(dy, at: pan.location(in: self))
        if pan.state == .ended {
            let velocity = pan.velocity(in: self).y
            let point = pan.location(in: self)
            momentum = Task { @MainActor [weak self] in
                var speed = velocity
                while abs(speed) > 120, !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(16))
                    speed *= 0.94
                    self?.scrollBy(speed * 0.016, at: point)
                }
                self?.panRemainder = 0
            }
        }
    }

    private func scrollBy(_ distance: CGFloat, at point: CGPoint) {
        let lineHeight = font.lineHeight
        let dy = distance + panRemainder
        let lines = Int(dy / lineHeight)
        panRemainder = dy - CGFloat(lines) * lineHeight
        guard lines != 0 else { return }
        let column = max(1, Int(point.x / max(1, font.pointSize * 0.6)) + 1)
        let row = max(1, Int(point.y / max(1, lineHeight)) + 1)
        // Finger down moves the text down: older output, a positive line count.
        controller?.scroll(lines: lines, column: column, row: row)
    }

    @objc private func pinched(_ pinch: UIPinchGestureRecognizer) {
        guard pinch.state == .changed || pinch.state == .ended else { return }
        let size = TerminalTextSize.clamped(font.pointSize * pinch.scale)
        if abs(size - font.pointSize) >= 1 {
            pinch.scale = 1
            font = AhType.terminalFont(size)
        }
        // Kept for this device: every terminal opens at the size you pinched to.
        if pinch.state == .ended { scene?.app.preferences.terminalFontSize = font.pointSize }
    }

    /// A pasted image (a screenshot) uploads and its path is typed in; text pastes as text.
    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        if !board.hasStrings, board.hasImages, let images = board.images, !images.isEmpty {
            controller?.upload(files: images.enumerated().compactMap { index, image in
                image.pngData().map { (name: images.count == 1 ? "paste.png" : "paste-\(index + 1).png", data: $0) }
            })
            return
        }
        super.paste(sender)
    }

}

struct TerminalViewRepresentable: UIViewRepresentable {
    let controller: TerminalController
    let scene: SceneModel
    let sessionKey: String
    let sticky: StickyModifiers
    var attached = false

    func makeUIView(context: Context) -> AppTerminalView {
        let view = controller.view
        view.scene = scene
        view.sessionKey = sessionKey
        view.attached = attached
        view.sticky = sticky
        view.installTouchScrolling()
        return view
    }

    func updateUIView(_ view: AppTerminalView, context: Context) {
        view.sticky = sticky
        if let request = scene.focusRequest, request.nonce != context.coordinator.handled {
            context.coordinator.handled = request.nonce
            if request.target == (attached ? .attachedTerminal(sessionKey) : .terminal(sessionKey)), request.isFresh(forBoxMadeAt: context.coordinator.made) {
                DispatchQueue.main.async { _ = view.becomeFirstResponder() }
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var handled = 0
        /// When this terminal was made: a focus request from long before isn't for it.
        let made = Date()
    }
}

private struct TerminalStatusOverlay: View {
    let controller: TerminalController
    let session: SessionModel
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        // Each state comes and goes in a short fade, not between two frames.
        ZStack(alignment: .top) { state.transition(.opacity) }
            .animation(reduceMotion ? nil : .smooth(duration: 0.2), value: controller.status)
    }

    @ViewBuilder
    private var state: some View {
        switch controller.status {
        case .live:
            EmptyView()
        case .connecting:
            // Only when attaching takes a while: a quick one showed it for a frame.
            Label("Attaching…", systemImage: "bolt.horizontal").font(.ah(.caption)).padding(8).background(.thinMaterial, in: Capsule()).padding(.top, 8)
                .afterABeat()
        case .reconnecting(let reason):
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Reconnecting. Keys typed now aren’t sent.").font(.ah(.caption))
                Button("Retry") { controller.reconnect() }.font(.ah(.caption)).buttonStyle(.bordered)
            }
            .padding(8)
            .background(.thinMaterial, in: Capsule())
            .padding(.top, 8)
            .accessibilityLabel("Terminal reconnecting. \(reason)")
        case .ended(let end):
            Banner(text: end == .signedOut ? "Signed out: this terminal closed." : controller.isCompanion ? "The attached terminal has stopped. Reopen its panel to start a shell." : "This session isn’t running any more.", tone: .warning)
                .padding()
        }
    }
}

/// The on-screen key row (`apps/server/web/KeyBar.tsx`): Esc, Tab, ⇧Tab, arrows, sticky Ctrl/Alt/Shift, paste.
struct KeyBar: View {
    @Binding var ctrl: Bool
    @Binding var alt: Bool
    @Binding var shift: Bool
    /// Puts the on-screen keyboard away; nil while the terminal hasn't the keyboard.
    var hideKeyboard: (() -> Void)? = nil
    let send: (String) -> Void
    let paste: () -> Void
    @Environment(\.theme) private var theme

    /// The terminal's own ground and ink: the bar is part of it, not a light strip under a
    /// dark terminal.
    private var ground: SwiftUI.Color { SwiftUI.Color(uiColor: UIColor(hex: theme.palette.terminal.background)) }
    private var ink: SwiftUI.Color { SwiftUI.Color(uiColor: UIColor(hex: theme.palette.terminal.foreground)) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(TerminalKeys.bar, id: \.label) { key in
                    // Quiet, as the system keyboard is (its key haptics are the person's to turn
                    // on); the sticky modifiers, which hold a state, still tick.
                    Button(key.label) {
                        send(TerminalKeys.applyModifiers(key.bytes, ctrl: ctrl, alt: alt, shift: shift))
                        ctrl = false
                        alt = false
                        shift = false
                    }
                    .accessibilityLabel(key.name)
                    .buttonStyle(KeyCapStyle(on: false, ink: ink))
                }
                Toggle("ctrl", isOn: $ctrl).toggleStyle(KeyToggleStyle(ink: ink)).accessibilityLabel("Control for the next key")
                Toggle("alt", isOn: $alt).toggleStyle(KeyToggleStyle(ink: ink)).accessibilityLabel("Option for the next key")
                Toggle("shift", isOn: $shift).toggleStyle(KeyToggleStyle(ink: ink)).accessibilityLabel("Shift for the next key")
                Button {
                    paste()
                } label: {
                    Image(systemName: "doc.on.clipboard")
                }
                .accessibilityLabel("Paste")
                .buttonStyle(KeyCapStyle(on: false, ink: ink))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
        // Always in reach at the end, however far the keys scroll.
        .safeAreaInset(edge: .trailing, spacing: 0) {
            if let hideKeyboard {
                Button(action: hideKeyboard) {
                    Image(systemName: "keyboard.chevron.compact.down")
                }
                .accessibilityLabel("Hide keyboard")
                .buttonStyle(KeyCapStyle(on: false, ink: ink))
                .padding(.trailing, 10)
                .padding(.leading, 4)
                .padding(.vertical, 6)
                // On the bar's own ground, the keys fading in under it: bare, the keys scrolled
                // on beside it and a half key showed at the edge.
                .background(ground)
                .background(alignment: .leading) {
                    LinearGradient(colors: [ground.opacity(0), ground], startPoint: .leading, endPoint: .trailing)
                        .frame(width: 24)
                        .offset(x: -24)
                        .allowsHitTesting(false)
                }
            }
        }
        .background(ground)
    }
}

private struct KeyCapStyle: ButtonStyle {
    let on: Bool
    /// The terminal's ink: the caps are a tint of it on its ground.
    let ink: SwiftUI.Color
    @Environment(\.theme) private var theme
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.ahMono(.callout))
            .padding(.horizontal, 12)
            .frame(minWidth: 44, minHeight: 36)
            .background(on || configuration.isPressed ? theme.accent.opacity(0.35) : ink.opacity(0.1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .foregroundStyle(ink)
            // The cap stays 36 high (the bar's 6-point gutters make it a 48-point strip); the
            // touch takes the gutter too, so a key is a finger's 44.
            .contentShape(Rectangle().inset(by: -4))
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

private struct KeyToggleStyle: ToggleStyle {
    let ink: SwiftUI.Color
    func makeBody(configuration: Configuration) -> some View {
        Button {
            configuration.isOn.toggle()
            Haptics.selection()
        } label: {
            configuration.label
        }
        .buttonStyle(KeyCapStyle(on: configuration.isOn, ink: ink))
        // A switch that holds for the next key: VoiceOver says on or off, not "selected".
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(configuration.isOn ? "On" : "Off")
    }
}

/// Files read from dropped items as they arrive, on whatever queue each lands.
private final class DroppedFiles: @unchecked Sendable {
    private let lock = NSLock()
    private var files: [(index: Int, name: String, data: Data)] = []

    func add(_ index: Int, _ name: String, _ data: Data) {
        lock.lock()
        files.append((index, name, data))
        lock.unlock()
    }

    var inOrder: [(name: String, data: Data)] {
        lock.lock()
        defer { lock.unlock() }
        return files.sorted { $0.index < $1.index }.map { (name: $0.name, data: $0.data) }
    }
}
