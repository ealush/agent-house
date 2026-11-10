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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pickingPhotos: [PhotosPickerItem] = []
    @State private var choosingPhotos = false
    @State private var takingPhoto = false
    @State private var importingFiles = false
    @State private var suggestionIndex = 0
    /// The settings chips are out, floating over the box (a swipe up, or the grabber).
    @State private var trayOpen = false
    /// How wide Send (or Queue, Run, Stop) is in the box's corner: the text wraps short of it.
    @State private var sendWidth: CGFloat = 0
    @Namespace private var glass

    /// The session has settings to show: a live agent's model, effort and permissions.
    private var hasTray: Bool { !session.isShell && session.isLive && session.launch.preset != nil }
    /// Out only while nothing else floats there: suggestions take the spot while you type one.
    private var showsTray: Bool { trayOpen && hasTray && composer.suggestions.isEmpty }

    var body: some View {
        VStack(spacing: 8) {
            QueueTrayView(queue: session.queue, composer: composer, working: session.working, hardwareKeyboard: scene.hardwareKeyboard)
            if !composer.suggestions.isEmpty {
                SuggestionList(items: composer.suggestions, index: suggestionIndex) { composer.accept($0) }
            }
            if let from = composer.drafts.from {
                Label("Continued from \(from)", systemImage: "arrow.turn.down.right")
                    .font(.ah(.caption2)).foregroundStyle(theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            // One slim glass field and the attach button beside it, as Messages has them; the
            // settings chips wait folded away until a swipe up brings them out above the box.
            GlassEffectContainer(spacing: 10) {
                VStack(alignment: .leading, spacing: 8) {
                    if showsTray {
                        tray.transition(reduceMotion ? .opacity : .move(edge: .bottom).combined(with: .opacity))
                    } else if hasTray, session.launch.mode?.dangerous == true, composer.suggestions.isEmpty {
                        // Approvals off is never tucked away: its chip stays out, in red.
                        LaunchChips(session: session, scene: scene, onlyRisky: true)
                            .transition(.opacity)
                    }
                    HStack(alignment: .bottom, spacing: 8) {
                        attachMenu
                        field
                    }
                }
            }
            .gesture(ComposerSwipe { swiped($0) })
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
                // Said and done: the settings fold back out of the way.
                if trayOpen { withAnimation(.snappy(duration: 0.25)) { trayOpen = false } }
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
                                Image(systemName: "doc.fill").font(.ah(.title3)).foregroundStyle(theme.muted)
                                Text(file.name).font(.ah(.caption2)).foregroundStyle(.primary).lineLimit(2)
                            }
                            .padding(8)
                            .frame(width: 112, height: 64, alignment: .topLeading)
                            .background(theme.tile)
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
                                // The glyph is small; the finger's target isn't.
                                .touchTarget()
                        }
                        .buttonStyle(.ahPress)
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

    /// A swipe up brings the settings out; a swipe down folds them, or puts the keyboard away.
    private func swiped(_ direction: ComposerSwipe.Direction) {
        switch direction {
        case .up:
            guard hasTray, !trayOpen else { return }
            Haptics.selection()
            withAnimation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.78)) { trayOpen = true }
        case .down:
            if trayOpen {
                Haptics.selection()
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { trayOpen = false }
            } else if !scene.hardwareKeyboard {
                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
            }
        }
    }

    /// The box: what you attach above the text, and Send inside it at the last line's end.
    private var field: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !composer.attachments.isEmpty { attachments.padding(.top, 2) }
            // The text wraps short of Send, which sits in the box's corner (as Messages has it):
            // beside it in a row, the box was measured at one width and laid out at another,
            // and a long message lost its first line.
            ComposerTextField(composer: composer, session: session, scene: scene, suggestionIndex: $suggestionIndex, trailingRoom: sendWidth > 0 ? sendWidth + 4 : 0)
                .frame(minHeight: 32)
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .overlay(alignment: .bottomTrailing) {
            ZStack { sendButton }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { sendWidth = $0 }
                .animation(.snappy(duration: 0.22), value: composer.showsStop(working: session.working))
                .animation(.snappy(duration: 0.22), value: session.isShell || (session.working && composer.canSend))
                .animation(.snappy(duration: 0.22), value: composer.isEmpty)
                .padding(6)
        }
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .glassEffectID("field", in: glass)
        .overlay(alignment: .top) { grabber }
        .accessibilityAction(named: trayOpen ? "Hide session settings" : "Show session settings") {
            withAnimation(.snappy(duration: 0.25)) { trayOpen.toggle() }
        }
    }

    /// What waits folded above the box: the settings in force, and the two ways into
    /// suggestions a finger otherwise has to know about (/ for a command, @ for a file).
    private var tray: some View {
        HStack(spacing: 8) {
            LaunchChips(session: session, scene: scene)
            Spacer(minLength: 4)
            // A command is the whole message, so / starts an empty box only.
            if composer.text.isEmpty { trigger("/", label: "Insert a command") }
            trigger("@", label: "Mention a file")
        }
    }

    private func trigger(_ mark: String, label: String) -> some View {
        Button {
            Haptics.selection()
            composer.insert(mark)
            scene.requestFocus(.composer(session.key))
        } label: {
            Text(mark)
                .font(.ahMono(.body).weight(.semibold))
                .foregroundStyle(theme.text2)
                .frame(width: 36, height: 36)
                .glassEffect(.regular.interactive(), in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    /// The tell that settings wait above: a sheet's grabber along the box's top edge, which a
    /// tap opens too. Inside the box, not over it: past the bar's edge it drew but took no touch.
    @ViewBuilder
    private var grabber: some View {
        if hasTray && !showsTray && composer.suggestions.isEmpty {
            Button {
                swiped(.up)
            } label: {
                Capsule().fill(theme.muted.opacity(0.5)).frame(width: 28, height: 4)
                    .padding(.top, 5)
                    .frame(width: 72, height: 12, alignment: .top)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .transition(.opacity)
            .accessibilityLabel("Show session settings")
            .accessibilityHint("Model, effort, permissions, commands and files")
        }
    }

    private var attachMenu: some View {
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
                Image(systemName: "plus")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(theme.text2)
                    .frame(width: 44, height: 44)
                    .glassEffect(.regular.interactive(), in: Circle())
                    .glassEffectID("attach", in: glass)
            }
            // In the order written, wherever the menu opens: the library first.
            .menuOrder(.fixed)
            .tint(.primary)
            .accessibilityLabel("Attach")
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
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            .accessibilityLabel("Stop the turn")
        } else if (session.isShell && !composer.isEmpty) || (session.working && composer.canSend) {
            // While it works a message waits its turn: the button says so, and holding it (or
            // ⌘Return) sends now instead.
            let queues = !session.isShell
            Button {
                composer.submit(working: session.working)
            } label: {
                // Send's pink, its height and its place, with the word for what it does.
                Text(queues ? "Queue" : "Run")
                    .font(.ah(.subheadline).weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 13)
                    .frame(height: 32)
                    .background(theme.accentStrong, in: Capsule())
                    .opacity(composer.canSend ? 1 : 0.45)
                    .touchTarget()
            }
            .buttonStyle(.ahPress)
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
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
        } else if !composer.isEmpty {
            // Folded away while there's nothing to send: it comes up with the first letter.
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
            .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
            .disabled(!composer.canSend)
            .accessibilityLabel("Send")
        }
    }

    private func pasteImage() {
        guard let image = UIPasteboard.general.image, let data = image.pngData() else { return }
        Task { await composer.attach(name: "paste.png", data: data, image: true, thumbnail: data) }
    }
}

/// A vertical flick anywhere on the composer, the text box included. UIKit's, so it runs beside
/// the text view's own gestures (a tap still places the caret), and steps aside when the text is
/// long enough to scroll, so the drag scrolls it.
struct ComposerSwipe: UIGestureRecognizerRepresentable {
    enum Direction { case up, down }
    let swiped: (Direction) -> Void

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        pan.cancelsTouchesInView = false
        return pan
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        guard pan.state == .ended else { return }
        let moved = pan.translation(in: pan.view)
        let speed = pan.velocity(in: pan.view)
        guard abs(moved.y) > abs(moved.x) else { return }
        if moved.y < -16 || speed.y < -500 {
            swiped(.up)
        } else if moved.y > 16 || speed.y > 500 {
            swiped(.down)
        }
    }

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    @MainActor
    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizer(_ gesture: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer, let view = pan.view else { return true }
            let speed = pan.velocity(in: view)
            guard abs(speed.y) > abs(speed.x) else { return false }
            var hit = view.hitTest(pan.location(in: view), with: nil)
            while let current = hit, !(current is ComposerTextView) { hit = current.superview }
            if let text = hit as? ComposerTextView, text.contentSize.height > text.bounds.height + 1 { return false }
            return true
        }
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
    /// Only a dangerous permission mode, if that's what's in force: the one setting that stays
    /// out when the rest fold away.
    var onlyRisky = false
    @Environment(\.theme) private var theme

    /// How much each chip says: its value (or that it's the default), its value or just what
    /// it sets, or only symbols. The roomiest that fits the box wins.
    enum Density { case full, compact, symbols }

    var body: some View {
        if session.launch.preset != nil {
            ViewThatFits(in: .horizontal) {
                chips(.full)
                chips(.compact)
                // Past that the row scrolls: three bare symbols said nothing anyone could read.
                ScrollView(.horizontal) {
                    // Glass of its own: a chip cut off at the scroll's edge still has its whole
                    // shape, and in the composer's glass it ran into the button beyond.
                    GlassEffectContainer {
                        chips(.compact)
                            // Room inside the scroll for the glass's own shadow, which it clips.
                            .padding(.vertical, 4)
                            .padding(.trailing, 12)
                    }
                }
                .scrollIndicators(.hidden)
                .mask {
                    HStack(spacing: 0) {
                        Rectangle()
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 18)
                    }
                }
                .padding(.vertical, -4)
            }
        }
    }

    @ViewBuilder
    private func chips(_ density: Density) -> some View {
        let launch = session.launch
        if let preset = launch.preset {
            HStack(spacing: 8) {
                if !onlyRisky, !(preset.models ?? []).isEmpty || preset.modelArgs != nil || preset.settingsCommands?.model != nil {
                    chip("Model", "cpu", launch.modelLabel, fallback: "Default model", density) { scene.sheet = .modelPicker(session.key) }
                }
                if !onlyRisky, !launch.levels.isEmpty || preset.settingsCommands?.effort != nil {
                    chip("Effort", "gauge.with.dots.needle.50percent", launch.effort.map(\.capitalized), fallback: "Default effort", density) { scene.sheet = .effortPicker(session.key) }
                }
                if let modes = preset.modes, modes.count > 1, !onlyRisky || launch.mode?.dangerous == true {
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
        // A setting at its default reads as unset (muted), not as a value like the mode beside it.
        return Button(action: action) { chipLabel(name, symbol, shown, spoken: value ?? fallback, danger: false, labelled: density == .full, unset: value == nil) }.buttonStyle(.plain).hoverEffect(.highlight)
    }

    /// ah's setting chip: a quiet label and the value in force ("Model Opus 5.5"); the label
    /// drops first, then the value, leaving the symbol.
    private func chipLabel(_ name: String, _ symbol: String, _ value: String?, spoken: String, danger: Bool, labelled: Bool = true, unset: Bool = false) -> some View {
        HStack(spacing: 4) {
            if value == nil { Image(systemName: symbol).imageScale(.small).foregroundStyle(theme.muted) }
            if labelled, value != nil { Text(name).foregroundStyle(theme.muted) }
            if let value {
                if danger { Image(systemName: "exclamationmark.triangle.fill").imageScale(.small).foregroundStyle(theme.danger) }
                Text(value).foregroundStyle(danger ? theme.danger : unset ? theme.muted : theme.text).lineLimit(1)
            }
        }
        .font(.ah(.footnote).weight(.medium))
        .padding(.horizontal, value == nil ? 10 : 12)
        .frame(minWidth: 36, minHeight: 36)
        // Glass like the box they float over, so they read as part of it, out for a moment.
        .glassEffect(danger ? .regular.tint(theme.danger.opacity(0.22)).interactive() : .regular.interactive(), in: Capsule())
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
    // A finger's worth on a phone (34 was a pointer's), still seven rows before it scrolls.
    private static let rowHeight: CGFloat = 40

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
                            // Concentric with the list's corners: its radius less the inset.
                            .background(i == index ? theme.accent.opacity(0.16) : .clear, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .id(i)
                    }
                }
                .padding(6)
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(CGFloat(shown.count) * (Self.rowHeight + 1) + 12, 7 * (Self.rowHeight + 1) + 12))
            .onChange(of: index) { _, i in proxy.scrollTo(i) }
        }
        // The composer's glass and its corners, so the list reads as the box opening upward.
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
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
    /// Room kept clear at the end of each line for the button in the box's corner.
    var trailingRoom: CGFloat = 0
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
        if view.textContainerInset.right != 2 + trailingRoom {
            view.textContainerInset.right = 2 + trailingRoom
            view.setNeedsLayout()
        }
        if (view.autocapitalizationType == .none) != composer.isShell {
            setTraits(view)
            if view.isFirstResponder { view.reloadInputViews() }
        }
        if view.text != composer.text {
            view.text = composer.text
            view.invalidateIntrinsicContentSize()
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
        let width = proposal.width ?? (uiView.bounds.width > 0 ? uiView.bounds.width : 320)
        let line = uiView.font?.lineHeight ?? 20
        // Measured from the text itself: the view's own answer came from its last layout, so a
        // box emptied after a long message stayed that tall around a word.
        let inset = uiView.textContainerInset
        let lines = width - inset.left - inset.right - uiView.textContainer.lineFragmentPadding * 2
        let text = uiView.attributedText ?? NSAttributedString()
        var height = text.boundingRect(with: CGSize(width: max(lines, 1), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).height
        // A new line just begun counts before anything is typed on it.
        if text.string.hasSuffix("\n") { height += line }
        height = ceil(max(height, line)) + inset.top + inset.bottom
        return CGSize(width: width, height: min(max(height, 32), line * 8 + 12))
    }

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    @MainActor
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: ComposerTextField
        var handledFocus = 0

        init(parent: ComposerTextField) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            // SwiftUI measures the box again only when told: a line more or less is a new size.
            textView.invalidateIntrinsicContentSize()
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
        // The box grows a line after the text does, and the caret's scroll from the line before
        // stayed, cutting off the first line; once it all fits, it sits at the top.
        if contentSize.height <= bounds.height + 0.5, contentOffset.y != -adjustedContentInset.top {
            contentOffset.y = -adjustedContentInset.top
        }
        placeholderLabel.frame = CGRect(x: textContainerInset.left + 5, y: textContainerInset.top, width: bounds.width - textContainerInset.left - textContainerInset.right - 10, height: placeholderLabel.font.lineHeight)
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
                                if hardwareKeyboard { Text("↵").foregroundStyle(theme.accent.opacity(0.7)) }
                            }
                            .font(.ah(.caption).weight(.semibold))
                        }
                        // The accent's tint, not its fill: Queue below is the one filled pink
                        // control, and two of them side by side asked for the same glance.
                        .buttonStyle(.bordered)
                        .tint(theme.accent)
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
            // The composer's glass, warmed with the accent: these are yours, waiting their turn.
            .glassEffect(.regular.tint(theme.accent.opacity(0.06)), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.items.map(\.id))
            .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: queue.sending)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Queued messages")
        }
    }

    private func queueGlyph(_ symbol: String) -> some View {
        Image(systemName: symbol).frame(width: 34, height: 34).contentShape(Rectangle())
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
                // Glyph-sized to look at, finger-sized to hit: they sat 14 points apart on 16.
                HStack(spacing: 2) {
                    Button { Haptics.threshold(); Task { await queue.steer(item) } } label: { queueGlyph("bolt") }
                        .accessibilityLabel("Send now")
                        .accessibilityHint("Stops the current turn and sends this now")
                    Button { Task { if let text = await queue.edit(item) { composer.compose(text) } } } label: { queueGlyph("pencil") }
                        .accessibilityLabel("Edit")
                    Button(role: .destructive) { Task { await queue.cancel(item) } } label: { queueGlyph("xmark") }
                        .accessibilityLabel("Cancel")
                }
                .buttonStyle(.ahPress)
                .font(.ah(.callout))
                .foregroundStyle(theme.muted)
            }
        }
        // As tall while it sends as with its buttons; the last glyph's room is the margin.
        .frame(minHeight: 34)
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .padding(.vertical, 3)
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
