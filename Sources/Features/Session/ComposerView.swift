import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// The message bar under a GUI session (`../ah/web/Composer.tsx`): text, attachments, the
/// model/effort/permission chips, recall, attach, and Send — or Stop while the agent works.
struct ComposerView: View {
    @Bindable var session: SessionModel
    @Bindable var composer: ComposerModel
    @Bindable var scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var pickingPhotos: [PhotosPickerItem] = []
    @State private var importingFiles = false
    @State private var suggestionIndex = 0

    var body: some View {
        VStack(spacing: 6) {
            QueueTrayView(queue: session.queue, composer: composer, working: session.working, hardwareKeyboard: scene.hardwareKeyboard)
            if !composer.suggestions.isEmpty {
                SuggestionList(items: composer.suggestions, index: suggestionIndex) { composer.accept($0) }
            }
            if let from = composer.drafts.from {
                Label("Continued from \(from)", systemImage: "arrow.turn.down.right")
                    .font(.caption2).foregroundStyle(theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !composer.attachments.isEmpty { attachments }
            VStack(spacing: 8) {
                ComposerTextField(composer: composer, session: session, scene: scene, suggestionIndex: $suggestionIndex)
                    .frame(minHeight: 36)
                tools
            }
            .padding(10)
            .background(theme.raised, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        }
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .onChange(of: composer.text) { _, _ in
            suggestionIndex = 0
            composer.updateSuggestions()
        }
        .onChange(of: pickingPhotos) { _, items in
            guard !items.isEmpty else { return }
            pickingPhotos = []
            for item in items {
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        await composer.attach(name: "photo.jpg", data: data, image: true, thumbnail: data)
                    }
                }
            }
        }
        .fileImporter(isPresented: $importingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                Task {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { return }
                    let image = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) ?? false
                    await composer.attach(name: url.lastPathComponent, data: data, image: image, thumbnail: image ? data : nil)
                }
            }
        }
        .onChange(of: composer.events.count) { _, count in if count > 0 { deliverEvents() } }
    }

    private func deliverEvents() {
        for event in composer.takeEvents() {
            switch event {
            case .sent(let result):
                Haptics.tap()
                if result.outcome == .queued && result.starting == true { scene.toast("Your message goes in once the agent is ready") }
                if result.resumed { scene.toast("Resumed the session") }
                session.stateChanged()
            case .failed(let message):
                Haptics.failure()
                scene.toast(message, error: true)
            case .interrupted:
                scene.toast("Interrupted")
            case .notice(let text):
                scene.toast(text)
            }
        }
    }

    private var attachments: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(composer.attachments) { file in
                    ZStack(alignment: .topTrailing) {
                        Group {
                            if file.image, let data = file.thumbnail, let image = UIImage(data: data) {
                                Image(uiImage: image).resizable().scaledToFill().frame(width: 56, height: 56).clipped()
                            } else {
                                Label(file.name, systemImage: "doc").font(.caption).lineLimit(1).padding(8).frame(height: 56)
                            }
                        }
                        .background(theme.raised)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay { if file.path == nil { ProgressView() } }
                        Button {
                            composer.removeAttachment(file.id)
                        } label: {
                            Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .accessibilityLabel("Remove \(file.name)")
                        .offset(x: 6, y: -6)
                    }
                    .accessibilityLabel(file.path == nil ? "Uploading \(file.name)" : file.name)
                }
            }
            .padding(.top, 6)
        }
    }

    private var tools: some View {
        HStack(spacing: 6) {
            if !session.isShell && session.isLive { LaunchChips(session: session, scene: scene) }
            Spacer(minLength: 0)
            Button {
                composer.recall(1)
            } label: {
                Image(systemName: "clock.arrow.circlepath")
            }
            .accessibilityLabel("Previous messages")
            .buttonStyle(.borderless)
            Menu {
                PhotosPicker(selection: $pickingPhotos, matching: .images) { Label("Photos", systemImage: "photo") }
                Button("Files…", systemImage: "folder") { importingFiles = true }
                Button("Paste image", systemImage: "doc.on.clipboard") { pasteImage() }
                    .disabled(!UIPasteboard.general.hasImages)
            } label: {
                Image(systemName: "paperclip")
            }
            .accessibilityLabel("Attach")
            if composer.showsStop(working: session.working) {
                Button {
                    Task { await composer.stop() }
                } label: {
                    Image(systemName: "stop.fill")
                        .frame(width: 34, height: 34)
                        .background(theme.danger.opacity(0.9), in: Circle())
                        .foregroundStyle(.white)
                }
                .accessibilityLabel("Stop the turn")
            } else {
                // While it works a message waits its turn: the button says so, and holding it
                // (or ⌘Return) sends now instead.
                let queues = session.working && !session.isShell
                Button {
                    composer.submit(working: session.working)
                } label: {
                    Group {
                        if session.isShell { Text("Run").font(.callout.weight(.semibold)).padding(.horizontal, 10) }
                        else if queues {
                            HStack(spacing: 4) {
                                Image(systemName: "text.line.last.and.arrowtriangle.forward")
                                Text("Queue")
                            }
                            .font(.callout.weight(.semibold))
                            .padding(.horizontal, 10)
                        } else { Image(systemName: "arrow.up").font(.callout.weight(.bold)) }
                    }
                    .frame(minWidth: 34, minHeight: 34)
                    .background(composer.canSend ? theme.accentStrong : theme.faint.opacity(0.3), in: Capsule())
                    .foregroundStyle(.white)
                    .contentTransition(.symbolEffect(.replace))
                }
                .disabled(!composer.canSend)
                .contextMenu {
                    if queues && composer.canSend {
                        Button("Send Now (Stops the Turn)", systemImage: "bolt.fill") {
                            Haptics.threshold()
                            composer.submit(working: true, steer: true)
                        }
                    }
                }
                .animation(.snappy(duration: 0.2), value: queues)
                .accessibilityLabel(session.isShell ? "Run" : queues ? "Queue" : "Send")
                .accessibilityHint(queues ? "Sends when this turn ends. Hold to send now." : "")
            }
        }
        .font(.body)
    }

    private func pasteImage() {
        guard let image = UIPasteboard.general.image, let data = image.pngData() else { return }
        Task { await composer.attach(name: "paste.png", data: data, image: true, thumbnail: data) }
    }
}

/// The model/effort/permission chips: the value in force, and how a change applies.
struct LaunchChips: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        let launch = session.launch
        if let preset = launch.preset {
            HStack(spacing: 6) {
                if !(preset.models ?? []).isEmpty || preset.modelArgs != nil || preset.settingsCommands?.model != nil {
                    chip("Model", "cpu", launch.modelLabel ?? "Default model") { scene.sheet = .modelPicker(session.key) }
                }
                if !launch.levels.isEmpty || preset.settingsCommands?.effort != nil {
                    chip("Effort", "gauge.with.dots.needle.50percent", launch.effort.map(\.capitalized) ?? "Default effort") { scene.sheet = .effortPicker(session.key) }
                }
                if let modes = preset.modes, modes.count > 1 {
                    let current = launch.mode ?? modes.first { $0.id == "default" }
                    Menu {
                        Picker("Permissions", selection: Binding(get: { current?.id ?? "default" }, set: { scene.applyPlan(session.planMode($0)) })) {
                            ForEach(modes, id: \.id) { mode in
                                Label(mode.name, systemImage: mode.dangerous == true ? "exclamationmark.shield" : Self.symbol(mode.id)).tag(mode.id)
                            }
                        }
                        Section { Text(launch.footer(.mode)) }
                    } label: {
                        chipLabel("Permissions", current?.dangerous == true ? "exclamationmark.shield.fill" : "lock.shield", current?.name ?? "Default", danger: current?.dangerous == true)
                    }
                    .menuOrder(.fixed)
                }
            }
        }
    }

    /// Permission modes by what they let the agent do.
    private static func symbol(_ mode: String) -> String {
        switch mode {
        case "plan": return "list.bullet.clipboard"
        case "accept-edits": return "pencil.and.list.clipboard"
        case "auto": return "wand.and.stars"
        default: return "hand.raised"
        }
    }

    private func chip(_ name: String, _ symbol: String, _ value: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { chipLabel(name, symbol, value, danger: false) }.buttonStyle(.plain)
    }

    private func chipLabel(_ name: String, _ symbol: String, _ value: String, danger: Bool) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).foregroundStyle(danger ? theme.danger : theme.faint)
            Text(value).foregroundStyle(danger ? theme.danger : theme.text2).lineLimit(1)
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(theme.surface, in: Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name), \(value)")
        .accessibilityAddTraits(.isButton)
    }
}

private struct SuggestionList: View {
    let items: [CompletionTrigger.Item]
    let index: Int
    let pick: (CompletionTrigger.Item) -> Void
    @Environment(\.theme) private var theme
    private static let rowHeight: CGFloat = 34

    var body: some View {
        let shown = Array(items.prefix(12))
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(Array(shown.enumerated()), id: \.offset) { i, item in
                        Button { pick(item) } label: {
                            HStack(spacing: 9) {
                                Image(systemName: symbol(item))
                                    .font(.footnote)
                                    .foregroundStyle(i == index ? theme.accent : theme.faint)
                                    .frame(width: 18)
                                Text(item.label).font(.callout.monospaced()).foregroundStyle(theme.text).lineLimit(1).truncationMode(.middle)
                                if let detail = item.detail {
                                    Text(detail).font(.caption).foregroundStyle(theme.muted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if i == index { Image(systemName: "return").font(.caption2).foregroundStyle(theme.faint) }
                            }
                            .padding(.horizontal, 10)
                            .frame(height: Self.rowHeight)
                            .background(i == index ? theme.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .id(i)
                    }
                }
                .padding(4)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(CGFloat(shown.count) * (Self.rowHeight + 1) + 8, 7 * (Self.rowHeight + 1) + 8))
            .onChange(of: index) { _, i in proxy.scrollTo(i) }
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(theme.faint.opacity(0.3), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.12), radius: 14, y: 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggestions")
    }

    /// A slash command, or a file by its kind.
    private func symbol(_ item: CompletionTrigger.Item) -> String {
        if item.label.hasPrefix("/") { return "command" }
        let name = (item.value as NSString).lastPathComponent
        return FilesModel.Kind(FsEntry(name: name, type: item.value.hasSuffix("/") ? .dir : .file, size: 0, mtime: 0)).symbol
    }
}

/// The text box itself: a UITextView, so Return, Escape, ↑/↓, Tab and every keyboard command
/// land exactly where they should, and dictation, autocorrect and selection keep working.
struct ComposerTextField: UIViewRepresentable {
    let composer: ComposerModel
    let session: SessionModel
    let scene: SceneModel
    @Binding var suggestionIndex: Int
    @Environment(\.theme) private var theme

    func makeUIView(context: Context) -> ComposerTextView {
        let view = ComposerTextView()
        view.delegate = context.coordinator
        view.coordinator = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 6, left: 2, bottom: 6, right: 2)
        view.isScrollEnabled = true
        view.returnKeyType = .send
        view.autocapitalizationType = composer.isShell ? .none : .sentences
        view.autocorrectionType = composer.isShell ? .no : .default
        view.spellCheckingType = composer.isShell ? .no : .default
        view.smartQuotesType = composer.isShell ? .no : .default
        view.accessibilityLabel = composer.isShell ? "Command" : "Message"
        view.accessibilityIdentifier = "composer"
        view.text = composer.text
        return view
    }

    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        if view.text != composer.text {
            view.text = composer.text
            let end = view.endOfDocument
            view.selectedTextRange = view.textRange(from: end, to: end)
        }
        view.placeholder = composer.placeholder(working: session.working, queued: session.row?.dto.queued ?? 0, touchOnly: !scene.hardwareKeyboard)
        view.textColor = UIColor(theme.text)
        if let request = scene.focusRequest, request.nonce != context.coordinator.handledFocus {
            context.coordinator.handledFocus = request.nonce
            if request.target == .composer(session.key) {
                DispatchQueue.main.async { view.becomeFirstResponder() }
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ComposerTextView, context: Context) -> CGSize? {
        let width = proposal.width ?? 320
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let line = uiView.font?.lineHeight ?? 20
        return CGSize(width: width, height: min(max(fitting.height, 36), line * 8 + 12))
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextField
        var handledFocus = 0

        init(parent: ComposerTextField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            parent.scene.fieldState = fieldState(textView)
            parent.composer.text = textView.text
            parent.composer.caret = textView.offset(from: textView.beginningOfDocument, to: textView.selectedTextRange?.start ?? textView.endOfDocument)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.scene.fieldState = fieldState(textView)
            let caret = textView.offset(from: textView.beginningOfDocument, to: textView.selectedTextRange?.start ?? textView.endOfDocument)
            if caret != parent.composer.caret {
                parent.composer.caret = caret
                parent.composer.updateSuggestions()
            }
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.scene.keyScope = .field
            parent.scene.fieldState = fieldState(textView)
            parent.scene.composerFocused = parent.session.key
            parent.scene.didFocus(.composer(parent.session.key))
            parent.scene.scheduleSave()
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.scene.keyScope = .app
            if parent.scene.composerFocused == parent.session.key { parent.scene.composerFocused = nil }
            parent.scene.didBlur(.composer(parent.session.key))
        }

        /// The software keyboard's Send key.
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard text == "\n", (textView as? ComposerTextView)?.isHardwareReturn != true else { return true }
            send()
            return false
        }

        func fieldState(_ textView: UITextView) -> FieldState {
            let selection = textView.selectedTextRange.map {
                textView.offset(from: textView.beginningOfDocument, to: $0.start)..<textView.offset(from: textView.beginningOfDocument, to: $0.end)
            }
            return FieldState(text: textView.text, selection: selection)
        }

        func send() {
            let composer = parent.composer
            if !composer.suggestions.isEmpty {
                composer.accept(composer.suggestions[min(parent.suggestionIndex, composer.suggestions.count - 1)])
                return
            }
            // An empty box steers the next queued message, like its Steer button.
            if composer.isEmpty {
                _ = parent.session.queue.steerFirst()
                return
            }
            composer.submit(working: parent.session.working)
        }

        /// Keys the composer answers itself, after the app's commands had their chance.
        func handle(_ press: KeyPress, in textView: ComposerTextView) -> Bool {
            if parent.scene.handle(press, scope: .field, field: fieldState(textView)) { return true }
            let composer = parent.composer
            let mods = press.modifiers
            switch press.key {
            case "Enter" where mods.isEmpty:
                send()
                return true
            case "Enter" where mods == [.shift]:
                return false
            case "Enter" where mods == [.command] && parent.session.working && !composer.isEmpty && !composer.isShell:
                // ⌘Return while it works: don't queue, send now (the turn stops).
                Haptics.threshold()
                composer.submit(working: true, steer: true)
                return true
            case "Escape":
                if !composer.suggestions.isEmpty {
                    composer.dismissSuggestions()
                    return true
                }
                if composer.isEmpty && parent.session.working && !composer.isShell {
                    Task { await composer.stop() }
                    return true
                }
                return false
            case "Tab" where !composer.suggestions.isEmpty:
                send()
                return true
            case "ArrowUp" where mods.isEmpty:
                if !composer.suggestions.isEmpty {
                    parent.suggestionIndex = (parent.suggestionIndex - 1 + composer.suggestions.count) % composer.suggestions.count
                    return true
                }
                if composer.text.isEmpty || composer.isRecalling {
                    composer.recall(1)
                    return true
                }
                return false
            case "ArrowDown" where mods.isEmpty:
                if !composer.suggestions.isEmpty {
                    parent.suggestionIndex = (parent.suggestionIndex + 1) % composer.suggestions.count
                    return true
                }
                if composer.isRecalling {
                    composer.recall(-1)
                    return true
                }
                return false
            default:
                return false
            }
        }

        func pasteImages(_ images: [UIImage]) {
            for image in images {
                guard let data = image.pngData() else { continue }
                Task { await parent.composer.attach(name: "paste.png", data: data, image: true, thumbnail: data) }
            }
        }
    }
}

/// A UITextView that hands hardware keys to the composer before typing them, and turns a
/// pasted screenshot into an attachment instead of nothing.
final class ComposerTextView: UITextView {
    weak var coordinator: ComposerTextField.Coordinator?
    var placeholder = "" { didSet { placeholderLabel.text = placeholder } }
    /// The current Return came from a hardware key (handled in pressesBegan).
    fileprivate(set) var isHardwareReturn = false
    private let placeholderLabel = UILabel()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.font = .preferredFont(forTextStyle: .body)
        placeholderLabel.adjustsFontForContentSizeCategory = true
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.numberOfLines = 1
        placeholderLabel.isAccessibilityElement = false
        addSubview(placeholderLabel)
        NotificationCenter.default.addObserver(self, selector: #selector(textChanged), name: UITextView.textDidChangeNotification, object: self)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        placeholderLabel.frame = CGRect(x: textContainerInset.left + 5, y: textContainerInset.top, width: bounds.width - 20, height: placeholderLabel.font.lineHeight)
        placeholderLabel.isHidden = !text.isEmpty
    }

    override var text: String! {
        didSet { placeholderLabel.isHidden = !(text ?? "").isEmpty }
    }

    @objc private func textChanged() { placeholderLabel.isHidden = !text.isEmpty }

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandled = Set<UIPress>()
        for press in presses {
            guard let key = press.key else {
                unhandled.insert(press)
                continue
            }
            let keyPress = KeyPress(key)
            isHardwareReturn = keyPress.key == "Enter"
            if !keyPress.isModifierOnly, coordinator?.handle(keyPress, in: self) == true { continue }
            unhandled.insert(press)
        }
        if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
        isHardwareReturn = false
    }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        if board.hasImages, !board.hasStrings, let images = board.images {
            coordinator?.pasteImages(images)
            return
        }
        super.paste(sender)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)) && UIPasteboard.general.hasImages { return true }
        return super.canPerformAction(action, withSender: sender)
    }
}

/// Whether a hardware keyboard is attached: hints name keys only when there are keys.

/// Queued follow-ups above the composer (`../ah/web/QueueTray.tsx`): Send now, Edit, Cancel,
/// drag to reorder; and our own just-queued messages until the host lists them.
struct QueueTrayView: View {
    @Bindable var queue: QueueModel
    let composer: ComposerModel
    var working = false
    var hardwareKeyboard = false
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if !queue.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "text.line.first.and.arrowtriangle.forward").foregroundStyle(theme.accent)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Up next · \(queue.items.count + queue.pendingRows.count)").font(.footnote.weight(.semibold))
                        Text(working ? "Sent one by one when this turn ends" : "Sending…").font(.caption2).foregroundStyle(theme.muted)
                    }
                    Spacer()
                    if let first = queue.items.first, !queue.sending.contains(first.id) {
                        Button {
                            Haptics.threshold()
                            Task { await queue.steer(first) }
                        } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "bolt.fill")
                                Text("Steer now")
                                if hardwareKeyboard { Text("↵").foregroundStyle(.white.opacity(0.75)) }
                            }
                            .font(.caption.weight(.semibold))
                        }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .accessibilityHint("Stops the current turn and sends the first queued message now")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 6)
                ForEach(Array(queue.items.enumerated()), id: \.element.id) { index, item in
                    row(index: index, item: item)
                        .transition(reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .scale(scale: 0.9).combined(with: .opacity)))
                }
                ForEach(queue.pendingRows) { pending in
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.mini).frame(width: 20)
                        Text(Uploads.summary(pending.text)).font(.callout).foregroundStyle(theme.muted).lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                }
                if let error = queue.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill").font(.caption).foregroundStyle(theme.danger).padding(.horizontal, 12).padding(.bottom, 8)
                }
            }
            .padding(.bottom, 4)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(theme.accent.opacity(0.2), lineWidth: 0.5))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.items.map(\.id))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.sending)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Queued messages")
        }
    }

    private func row(index: Int, item: QueueItem) -> some View {
        HStack(spacing: 10) {
            Text("\(index + 1)")
                .font(.caption2.weight(.bold).monospacedDigit())
                .foregroundStyle(theme.accent)
                .frame(width: 20, height: 20)
                .background(theme.accent.opacity(0.12), in: Circle())
            Text(Uploads.summary(item.text)).font(.callout).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
            if queue.sending.contains(item.id) {
                ProgressView().controlSize(.small)
            } else {
                HStack(spacing: 14) {
                    Button { Haptics.threshold(); Task { await queue.steer(item) } } label: { Image(systemName: "bolt") }
                        .accessibilityLabel("Send now")
                        .accessibilityHint("Stops the current turn and sends this now")
                    Button { Task { if let text = await queue.edit(item) { composer.compose(text) } } } label: { Image(systemName: "pencil") }
                        .accessibilityLabel("Edit")
                    Button(role: .destructive) { Task { await queue.cancel(item) } } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Cancel")
                }
                .buttonStyle(.borderless)
                .font(.callout)
                .foregroundStyle(theme.muted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .contextMenu {
            Button("Send Now", systemImage: "bolt") { Task { await queue.steer(item) } }
            Button("Edit", systemImage: "pencil") { Task { if let text = await queue.edit(item) { composer.compose(text) } } }
            if index > 0 { Button("Move Up", systemImage: "arrow.up") { Task { await queue.move(item.id, to: index - 1) } } }
            if index < queue.items.count - 1 { Button("Move Down", systemImage: "arrow.down") { Task { await queue.move(item.id, to: index + 1) } } }
            Divider()
            Button("Cancel", systemImage: "xmark", role: .destructive) { Task { await queue.cancel(item) } }
        }
        .draggable(item.id) {
            Text(Uploads.summary(item.text)).padding(8).background(theme.raised, in: RoundedRectangle(cornerRadius: 10))
        }
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, id != item.id else { return false }
            Task { await queue.move(id, to: index) }
            return true
        }
    }
}
