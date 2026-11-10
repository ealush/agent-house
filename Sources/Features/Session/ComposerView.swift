import AVFoundation
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
    @State private var choosingPhotos = false
    @State private var takingPhoto = false
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
                    .font(.ah(.caption2)).foregroundStyle(theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // ah's Composer: one raised card floating over the transcript, what you attach inside
            // it above the text, and the row of controls along its foot.
            VStack(alignment: .leading, spacing: 6) {
                if !composer.attachments.isEmpty { attachments }
                ComposerTextField(composer: composer, session: session, scene: scene, suggestionIndex: $suggestionIndex)
                    .frame(minHeight: 36)
                    .padding(.horizontal, 4)
                tools
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)
            .padding(.bottom, 8)
            .background(theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(theme.lineStrong, lineWidth: 1))
            .shadow(color: theme.shadow, radius: 16, y: 8)
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
                if let ext = Self.videoExtension(item) {
                    composer.attachVideo(name: "video.\(ext)") {
                        guard let video = try await item.loadTransferable(type: LibraryVideo.self) else { throw CocoaError(.fileNoSuchFile) }
                        return (video.file, await video.thumbnail())
                    }
                    continue
                }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self) {
                        // Named for what it is (a HEIC stays a HEIC), so the agent reads it right.
                        let ext = item.supportedContentTypes.first?.preferredFilenameExtension ?? "jpg"
                        await composer.attach(name: "photo.\(ext)", data: data, image: true, thumbnail: data)
                    }
                }
            }
        }
        // Presented from state, not from inside the menu: a PhotosPicker placed in a Menu never
        // opened.
        // `.current`: a video comes as it is, not transcoded first.
        .photosPicker(isPresented: $choosingPhotos, selection: $pickingPhotos, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current, photoLibrary: .shared())
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                guard let data = image.jpegData(compressionQuality: 0.85) else { return }
                Task { await composer.attach(name: "photo.jpg", data: data, image: true, thumbnail: data) }
            }
            .ignoresSafeArea()
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

    /// A picked item's file extension if it's a video (a Live Photo is a photo).
    private static func videoExtension(_ item: PhotosPickerItem) -> String? {
        let types = item.supportedContentTypes
        guard !types.contains(where: { $0.conforms(to: .image) }), let movie = types.first(where: { $0.conforms(to: .movie) }) else { return nil }
        return movie.preferredFilenameExtension ?? "mov"
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
                    Group {
                        if let data = file.thumbnail, let image = UIImage(data: data) {
                            Image(uiImage: image).resizable().scaledToFill().frame(width: 64, height: 64)
                                .overlay(alignment: .bottomLeading) {
                                    if !file.image {
                                        Image(systemName: "play.fill").font(.ah(.caption2)).foregroundStyle(.white).shadow(radius: 2).padding(6)
                                    }
                                }
                        } else {
                            VStack(alignment: .leading, spacing: 4) {
                                Image(systemName: "doc.fill").font(.ah(.title3)).foregroundStyle(.secondary)
                                Text(file.name).font(.ah(.caption2)).foregroundStyle(.primary).lineLimit(2)
                            }
                            .padding(8)
                            .frame(width: 112, height: 64, alignment: .topLeading)
                            .background(.fill.tertiary)
                        }
                    }
                    .overlay { if file.path == nil { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity).background(.black.opacity(0.25)) } }
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(alignment: .topTrailing) {
                        Button {
                            withAnimation(.snappy(duration: 0.2)) { composer.removeAttachment(file.id) }
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.ah(.body))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.55))
                                .padding(3)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(file.name)")
                    }
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(file.path == nil ? "Uploading \(file.name)" : file.name)
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 4)
            .padding(.top, 2)
        }
        .animation(.snappy(duration: 0.25), value: composer.attachments.map(\.id))
    }

    private var tools: some View {
        HStack(spacing: 6) {
            // The value in force for each setting, before Send.
            if !session.isShell && session.isLive { LaunchChips(session: session, scene: scene) }
            Spacer(minLength: 0)
            Menu {
                Section {
                    Button("Photo Library", systemImage: "photo.on.rectangle") { choosingPhotos = true }
                    if CameraPicker.isAvailable { Button("Take Photo", systemImage: "camera") { takingPhoto = true } }
                    Button("Choose Files", systemImage: "folder") { importingFiles = true }
                    if UIPasteboard.general.hasImages { Button("Paste Image", systemImage: "doc.on.clipboard") { pasteImage() } }
                }
                if !composer.recent.isEmpty {
                    // ↑ in an empty box does this from a keyboard.
                    Button("Previous Message", systemImage: "clock.arrow.circlepath") { composer.recall(1) }
                }
            } label: {
                Image(systemName: "paperclip")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(theme.muted)
                    .frame(width: 34, height: 34)
                    .touchTarget()
            }
            // In the order written, wherever the menu opens: the library first.
            .menuOrder(.fixed)
            .tint(.primary)
            .accessibilityLabel("Attach")
            // Send, Queue and Stop trade places with a spring rather than a cut.
            sendButton
                .animation(.snappy(duration: 0.22), value: composer.showsStop(working: session.working))
                .animation(.snappy(duration: 0.22), value: session.isShell || (session.working && composer.canSend))
        }
    }

    @ViewBuilder
    private var sendButton: some View {
        if composer.showsStop(working: session.working) {
            Button {
                Task { await composer.stop() }
            } label: {
                // ah's Stop: an ink circle.
                Image(systemName: "stop.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(theme.background)
                    .frame(width: 32, height: 32)
                    .background(theme.text, in: Circle())
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .transition(.scale(scale: 0.6).combined(with: .opacity))
            .accessibilityLabel("Stop the turn")
        } else if session.isShell || (session.working && composer.canSend) {
            // While it works a message waits its turn: the button says so, and holding it (or
            // ⌘Return) sends now instead.
            let queues = !session.isShell
            Button {
                composer.submit(working: session.working)
            } label: {
                if queues { Label("Queue", systemImage: "text.line.last.and.arrowtriangle.forward") } else { Text("Run") }
            }
            .font(.ah(.subheadline).weight(.semibold))
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .controlSize(.small)
            .tint(theme.accentStrong)
            .disabled(!composer.canSend)
            .contextMenu {
                if queues {
                    Button("Send Now (Stops the Turn)", systemImage: "bolt.fill") {
                        Haptics.threshold()
                        composer.submit(working: true, steer: true)
                    }
                }
            }
            .accessibilityLabel(queues ? "Queue" : "Run")
            .accessibilityHint(queues ? "Sends when this turn ends. Hold to send now." : "")
        } else {
            Button {
                composer.submit(working: session.working)
            } label: {
                // ah's Send: the accent-filled circle, the one pink control.
                Image(systemName: "arrow.up")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(theme.accentStrong, in: Circle())
                    .opacity(composer.canSend ? 1 : 0.45)
                    .animation(.snappy(duration: 0.2), value: composer.canSend)
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
            .transition(.scale(scale: 0.6).combined(with: .opacity))
            .disabled(!composer.canSend)
            .accessibilityLabel("Send")
        }
    }

    private func pasteImage() {
        guard let image = UIPasteboard.general.image, let data = image.pngData() else { return }
        Task { await composer.attach(name: "paste.png", data: data, image: true, thumbnail: data) }
    }
}

/// The camera, for a photo to attach (devices that have one).
struct CameraPicker: UIViewControllerRepresentable {
    let took: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.took(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}

/// The model/effort/permission chips: the value in force, and how a change applies.
struct LaunchChips: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme

    /// How much each chip says: its value (or that it's the default), its value or just what
    /// it sets, or only symbols. The roomiest that fits the box wins.
    enum Density { case full, compact, symbols }

    var body: some View {
        if session.launch.preset != nil {
            ViewThatFits(in: .horizontal) {
                chips(.full)
                chips(.compact)
                chips(.symbols)
            }
        }
    }

    @ViewBuilder
    private func chips(_ density: Density) -> some View {
        let launch = session.launch
        if let preset = launch.preset {
            HStack(spacing: 6) {
                if !(preset.models ?? []).isEmpty || preset.modelArgs != nil || preset.settingsCommands?.model != nil {
                    chip("Model", "cpu", launch.modelLabel, fallback: "Default model", density) { scene.sheet = .modelPicker(session.key) }
                }
                if !launch.levels.isEmpty || preset.settingsCommands?.effort != nil {
                    chip("Effort", "gauge.with.dots.needle.50percent", launch.effort.map(\.capitalized), fallback: "Default effort", density) { scene.sheet = .effortPicker(session.key) }
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
                        // The mode in force always says its name until there's room for nothing else.
                        chipLabel("Permissions", current?.dangerous == true ? "exclamationmark.shield.fill" : "lock.shield", density == .symbols ? nil : current?.name ?? "Default", spoken: current?.name ?? "Default", danger: current?.dangerous == true, labelled: density == .full)
                    }
                    .menuOrder(.fixed)
                    // A menu tints its label with the accent; this chip reads like its neighbors.
                    .tint(.primary)
                }
            }
            .fixedSize()
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

    private func chip(_ name: String, _ symbol: String, _ value: String?, fallback: String, _ density: Density, action: @escaping () -> Void) -> some View {
        // At its default with no room for the label, a chip says what it sets ("Model").
        let shown: String? = density == .symbols ? nil : value ?? (density == .full ? "Default" : name)
        return Button(action: action) { chipLabel(name, symbol, shown, spoken: value ?? fallback, danger: false, labelled: density == .full) }.buttonStyle(.plain).hoverEffect(.highlight)
    }

    /// ah's setting chip: a quiet label and the value in force ("Model Opus 5.5"); the label
    /// drops first, then the value, leaving the symbol.
    private func chipLabel(_ name: String, _ symbol: String, _ value: String?, spoken: String, danger: Bool, labelled: Bool = true) -> some View {
        HStack(spacing: 4) {
            if value == nil { Image(systemName: symbol).imageScale(.small).foregroundStyle(theme.muted) }
            if labelled, value != nil { Text(name).foregroundStyle(theme.muted) }
            if let value {
                if danger { Image(systemName: "exclamationmark.triangle.fill").imageScale(.small).foregroundStyle(theme.danger) }
                Text(value).foregroundStyle(danger ? theme.danger : theme.text).lineLimit(1)
            }
        }
        .font(.ah(.footnote).weight(.medium))
        .padding(.horizontal, value == nil ? 8 : 10)
        .frame(minWidth: 32, minHeight: 30)
        .overlay(Capsule().strokeBorder(theme.lineStrong, lineWidth: 1))
        .contentShape(Capsule())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name), \(spoken)")
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
                                    .font(.ah(.footnote))
                                    .foregroundStyle(i == index ? theme.accent : theme.faint)
                                    .frame(width: 18)
                                Text(item.label).font(.ahMono(.callout)).foregroundStyle(theme.text).lineLimit(1).truncationMode(.middle)
                                if let detail = item.detail {
                                    Text(detail).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                                if i == index { Image(systemName: "return").font(.ah(.caption2)).foregroundStyle(theme.faint) }
                            }
                            .padding(.horizontal, 10)
                            .frame(height: Self.rowHeight)
                            .background(i == index ? theme.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
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
        view.font = AhType.uiFont(.body)
        view.adjustsFontForContentSizeCategory = true
        view.backgroundColor = .clear
        view.textContainerInset = UIEdgeInsets(top: 6, left: 2, bottom: 6, right: 2)
        view.isScrollEnabled = true
        view.returnKeyType = .send
        view.accessibilityIdentifier = "composer"
        view.text = composer.text
        setTraits(view)
        return view
    }

    /// Commands aren't sentences: no capitals, corrections or curly quotes in a shell.
    private func setTraits(_ view: ComposerTextView) {
        let shell = composer.isShell
        view.autocapitalizationType = shell ? .none : .sentences
        view.autocorrectionType = shell ? .no : .default
        view.spellCheckingType = shell ? .no : .default
        view.smartQuotesType = shell ? .no : .default
        view.accessibilityLabel = shell ? "Command" : "Message"
    }

    func updateUIView(_ view: ComposerTextView, context: Context) {
        context.coordinator.parent = self
        if (view.autocapitalizationType == .none) != composer.isShell {
            setTraits(view)
            if view.isFirstResponder { view.reloadInputViews() }
        }
        if view.text != composer.text {
            view.text = composer.text
            let end = view.endOfDocument
            view.selectedTextRange = view.textRange(from: end, to: end)
        }
        view.placeholder = composer.placeholder(working: session.working, queued: session.row?.dto.queued ?? 0, touchOnly: !scene.hardwareKeyboard, agent: session.launch.preset?.name, waiting: session.waiting, ended: !session.isLive)
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
    var placeholder = "" { didSet { if placeholder != oldValue { setNeedsLayout() } } }
    /// The current Return came from a hardware key (handled in pressesBegan).
    fileprivate(set) var isHardwareReturn = false
    private let placeholderLabel = UILabel()

    override init(frame: CGRect, textContainer: NSTextContainer?) {
        super.init(frame: frame, textContainer: textContainer)
        placeholderLabel.font = AhType.uiFont(.body)
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
        // Hints drop from the end, whole, rather than end mid-word in an ellipsis.
        let font = placeholderLabel.font ?? AhType.uiFont(.body)
        placeholderLabel.text = ComposerModel.fitting(placeholder, width: placeholderLabel.frame.width) { ($0 as NSString).size(withAttributes: [.font: font]).width }
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
                        Text("Up next · \(queue.items.count + queue.pendingRows.count)").font(.ah(.footnote).weight(.semibold))
                        Text(working ? "Sent one by one when this turn ends" : "Sending…").font(.ah(.caption2)).foregroundStyle(theme.muted)
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
                            .font(.ah(.caption).weight(.semibold))
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
                        Text(Uploads.summary(pending.text)).font(.ah(.callout)).foregroundStyle(theme.muted).lineLimit(1)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                }
                if let error = queue.error {
                    Label(error, systemImage: "exclamationmark.triangle.fill").font(.ah(.caption)).foregroundStyle(theme.danger).padding(.horizontal, 12).padding(.bottom, 8)
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
                .font(.ah(.caption2).weight(.bold).monospacedDigit())
                .foregroundStyle(theme.accent)
                .frame(width: 20, height: 20)
                .background(theme.accent.opacity(0.12), in: Circle())
            Text(Uploads.summary(item.text)).font(.ah(.callout)).lineLimit(2).frame(maxWidth: .infinity, alignment: .leading)
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
                .font(.ah(.callout))
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

/// A video out of the photo library, as a file of this app's own: too big to load as `Data`.
private struct LibraryVideo: Transferable {
    let file: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: file)
            return LibraryVideo(file: file)
        }
    }

    /// Its first frame for the tile.
    func thumbnail() async -> Data? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 256, height: 256)
        guard let frame = try? await generator.image(at: .zero).image else { return nil }
        return UIImage(cgImage: frame).jpegData(compressionQuality: 0.7)
    }
}
