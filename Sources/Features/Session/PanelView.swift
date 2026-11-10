import QuickLook
import SwiftUI
import UniformTypeIdentifiers
import WebKit

/// A session's side panel: diff, files, chat, queue, snapshots, preview, stack.
struct PanelView: View {
    let panel: SceneSnapshot.Panel
    let session: SessionModel
    let scene: SceneModel

    var body: some View {
        switch panel {
        case .diff: DiffPanel(model: DiffModel(api: session.api, uid: session.ref), session: session, scene: scene)
        case .files: FilesPanel(model: FilesModel(api: session.api), session: session, scene: scene)
        case .chat: ChatPanel(model: SideChatModel(api: session.api, uid: session.ref), session: session, scene: scene)
        case .queue: QueuePanel(session: session)
        case .snapshots: SnapshotsPanel(model: SnapshotsModel(api: session.api, uid: session.ref), session: session, scene: scene)
        case .preview: PreviewPanel(model: PreviewModel(api: session.api, uid: session.ref), session: session)
        case .stack: StackPanel(session: session, scene: scene)
        }
    }
}

// MARK: Diff

private struct DiffPanel: View {
    @State var model: DiffModel
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var commenting: (file: String, line: DiffLine)?
    @State private var comment = ""
    @State private var cursor = DiffCursor(files: [])
    @FocusState private var listFocused: Bool
    @FocusState private var commentFocused: Bool
    private static let maxLines = 400

    private var commentable: Bool { !session.isShell }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                Group {
                if let changes = model.changes {
                    Section {
                        HStack {
                            Label(changes.branch, systemImage: "arrow.triangle.branch")
                            Spacer()
                            Text("+\(model.totals.add)").foregroundStyle(theme.done)
                            Text("−\(model.totals.del)").foregroundStyle(theme.danger)
                        }
                        .font(.ah(.callout).monospacedDigit())
                        if changes.truncated { Text("The diff is long; showing the start.").font(.ah(.caption)).foregroundStyle(theme.limited) }
                        if commentable {
                            Text(scene.hardwareKeyboard ? "↑↓ walk the lines; Return comments for the agent." : "Tap a line to comment for the agent.").font(.ah(.caption)).foregroundStyle(theme.muted)
                        }
                    }
                    if model.files.isEmpty && model.untracked.isEmpty {
                        Text("No uncommitted changes.").foregroundStyle(theme.muted)
                    }
                    ForEach(Array(model.files.enumerated()), id: \.element.id) { fileIndex, file in
                        Section {
                            DiffLinesView(lines: file.lines, maxLines: Self.maxLines, onLine: { line in open(file.path, line) },
                                          cursor: cursor.current?.file == fileIndex ? cursor.current?.line : nil, idPrefix: "f\(fileIndex)")
                                .listRowInsets(EdgeInsets())
                        } header: {
                            HStack {
                                Text(file.path).font(.ahMono(.caption)).lineLimit(1).truncationMode(.head)
                                Spacer()
                                Text("+\(file.additions) −\(file.deletions)").font(.ah(.caption2).monospacedDigit())
                            }
                        }
                    }
                    if !model.untracked.isEmpty {
                        Section("New files") {
                            ForEach(model.untracked, id: \.path) { Text($0.path).font(.ahMono(.caption)) }
                        }
                    }
                } else if let error = model.error {
                    Banner(text: error, tone: .error)
                } else {
                    ProgressView()
                }
                }
                // The theme's raised rows on the panel's surface, not the system's grey.
                .ahRow()
            }
            .listStyle(.insetGrouped)
            .focusable(commentable && commenting == nil)
            .focused($listFocused)
            .onKeyPress(phases: .down) { press in
                guard commenting == nil else { return .ignored }
                switch press.key {
                case .downArrow, KeyEquivalent("j"): cursor.move(1)
                case .upArrow, KeyEquivalent("k"): cursor.move(-1)
                case .home: cursor.home()
                case .end: cursor.end()
                case .return, .space:
                    guard let at = cursor.current, model.files.indices.contains(at.file) else { return .ignored }
                    let file = model.files[at.file]
                    open(file.path, file.lines[at.line])
                    return .handled
                case .escape:
                    guard cursor.current != nil else { return .ignored }
                    cursor.clear()
                    return .handled
                default:
                    return .ignored
                }
                if let at = cursor.current { withAnimation(.snappy(duration: 0.12)) { proxy.scrollTo("f\(at.file):\(at.line)", anchor: .center) } }
                return .handled
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let target = commenting { commentBox(target) }
        }
        .task {
            await model.load()
            model.watch()
        }
        .onChange(of: model.files) { _, files in cursor.update(files: files.map(\.lines), maxLines: Self.maxLines) }
        .onDisappear { model.stop() }
        .refreshable { await model.load() }
    }

    private func open(_ file: String, _ line: DiffLine) {
        guard commentable, line.kind != .hunk, line.kind != .file else { return }
        commenting = (file, line)
        comment = ""
        commentFocused = true
    }

    private func cancel() {
        commenting = nil
        comment = ""
        listFocused = true
    }

    private func send() {
        guard let target = commenting, !comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let text = comment
        cancel()
        Task {
            if let result = await model.send(comment: text, file: target.file, line: target.line) {
                scene.toast(result.outcome == .queued ? "Queued for the agent" : "Sent to the agent")
            }
        }
    }

    /// Commenting on a line: ⌘↵ / ⌃↵ sends, Esc cancels and puts the keyboard back on the line.
    private func commentBox(_ target: (file: String, line: DiffLine)) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(target.file)\(target.line.number.map { ":\($0)" } ?? "")\(target.line.kind == .del ? " (removed line)" : "")")
                .font(.ahMono(.caption)).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.head)
            Text(target.line.text.trimmingCharacters(in: .whitespaces)).font(.ahMono(.caption)).lineLimit(2)
            TextField("Comment for the agent…", text: $comment, axis: .vertical)
                .lineLimit(2...6)
                .textFieldStyle(.roundedBorder)
                .focused($commentFocused)
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.command) || press.modifiers.contains(.control) else { return .ignored }
                    send()
                    return .handled
                }
                .onKeyPress(.escape) {
                    cancel()
                    return .handled
                }
            HStack {
                Text(scene.hardwareKeyboard ? "⌘↵ sends · esc cancels" : "").font(.ah(.caption2)).foregroundStyle(theme.faint)
                Spacer()
                Button("Cancel", action: cancel).buttonStyle(.bordered)
                Button("Send to agent", action: send)
                    .buttonStyle(.borderedProminent)
                    .tint(theme.accentStrong)
                    .disabled(comment.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .controlSize(.small)
        }
        .padding(12)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
        .padding(10)
    }
}

// MARK: Files

private struct FilesPanel: View {
    @State var model: FilesModel
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var selection: String?
    @State private var previewURL: URL?
    @State private var reading: FileText?
    @State private var sharing: URL?
    @State private var importing = false
    @State private var newFolder: String?
    @State private var dropping = false
    @FocusState private var listFocused: Bool

    /// The session's own folder: where Files opens, and what inserted paths are relative to.
    private var cwd: String? { session.row?.dto.cwd ?? session.history?.dto.cwd }

    var body: some View {
        List(selection: $selection) {
            if let listing = model.listing {
                if listing.entries.isEmpty {
                    Text("Empty folder. Drop files here to upload them.")
                        .font(.ah(.callout))
                        .foregroundStyle(theme.muted)
                        .listRowBackground(Color.clear)
                }
                ForEach(listing.entries, id: \.name) { entry in
                    row(entry)
                        .tag(entry.name)
                        // On the panel's surface, its hairlines the theme's (a plain list's
                        // rows drew the system's black).
                        .listRowBackground(Color.clear)
                        .listRowSeparatorTint(theme.line)
                }
            } else if model.error == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            if let error = model.error { Banner(text: error, tone: .error).listRowBackground(Color.clear) }
            ForEach(model.uploading, id: \.self) { name in
                Label("Uploading \(name)…", systemImage: "arrow.up.circle").foregroundStyle(theme.muted)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .focused($listFocused)
        .safeAreaInset(edge: .top, spacing: 0) { pathBar }
        .overlay {
            if dropping {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(theme.accent, style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .background(theme.accent.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .overlay {
                        Label("Drop to upload into \(model.listing.map { ($0.path as NSString).lastPathComponent } ?? "this folder")", systemImage: "arrow.down.doc")
                            .font(.ah(.callout).weight(.semibold))
                            .foregroundStyle(theme.accent)
                    }
                    .padding(8)
                    .allowsHitTesting(false)
            }
        }
        .onDrop(of: [.fileURL, .item], isTargeted: $dropping) { providers in
            upload(providers)
            return true
        }
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Menu {
                    Button("Upload Files…", systemImage: "square.and.arrow.up") { importing = true }
                    Button("New Folder…", systemImage: "folder.badge.plus") { newFolder = "" }
                    Divider()
                    Toggle(isOn: $model.showHidden) { Label("Show Hidden Files", systemImage: "eye") }
                    if let path = model.listing?.path {
                        Divider()
                        Button("Mention This Folder", systemImage: "at") { insert(path) }
                        Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
                    }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .tint(.primary)
                .accessibilityLabel("Folder actions")
            }
        }
        .task { await model.open(cwd) }
        .onChange(of: model.showHidden) { _, _ in Task { await model.reload() } }
        .onChange(of: model.listing?.path) { _, _ in selection = nil }
        .refreshable { await model.reload() }
        .onKeyPress(.return) {
            guard let selection, let entry = model.listing?.entries.first(where: { $0.name == selection }) else { return .ignored }
            Task { await open(entry) }
            return .handled
        }
        .onKeyPress(.upArrow, phases: .down) { press in
            guard press.modifiers.contains(.command) else { return .ignored }
            Task { await model.up() }
            return .handled
        }
        .quickLookPreview($previewURL)
        .sheet(item: $reading) { file in
            FileTextSheet(file: file, insert: { insert(file.path) })
        }
        .sheet(item: Binding(get: { sharing.map(SharedFile.init) }, set: { sharing = $0?.url })) { shared in
            ActivitySheet(items: [shared.url])
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                Task {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    if let data = try? Data(contentsOf: url) { await model.upload(name: url.lastPathComponent, data: data) }
                }
            }
        }
        .alert("New folder", isPresented: Binding(get: { newFolder != nil }, set: { if !$0 { newFolder = nil } })) {
            TextField("Name", text: Binding(get: { newFolder ?? "" }, set: { newFolder = $0 }))
            Button("Create") { let name = newFolder ?? ""; newFolder = nil; Task { await model.makeFolder(name) } }
            Button("Cancel", role: .cancel) { newFolder = nil }
        }
    }

    // MARK: Path bar

    /// Where you are: the folder's name, relative to the session's folder when inside it,
    /// opening a menu of every folder above (as Files and Finder do), with the way up and
    /// back to the session's folder beside it.
    private var pathBar: some View {
        let path = model.listing?.path ?? cwd ?? "/"
        let crumbs = FilesModel.crumbs(path)
        return HStack(spacing: 10) {
            Button { Task { await model.up() } } label: { Image(systemName: "chevron.up") }
                .disabled(model.listing?.parent == nil)
                .accessibilityLabel("Enclosing folder")
            Menu {
                ForEach(Array(crumbs.dropLast().reversed().enumerated()), id: \.offset) { _, crumb in
                    Button { Task { await model.open(crumb.path) } } label: {
                        Label {
                            Text(crumb.name)
                            Text(crumb.path)
                        } icon: {
                            Image(systemName: crumb.path == cwd ? "house" : "folder")
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "folder.fill").foregroundStyle(theme.accent)
                    Text(cwd.map { FilesModel.relative(path, to: $0) == "." ? (path as NSString).lastPathComponent : FilesModel.relative(path, to: $0) } ?? path)
                        .font(.ah(.callout).weight(.semibold))
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Image(systemName: "chevron.down").font(.ah(.caption2).weight(.semibold)).foregroundStyle(theme.faint)
                }
            }
            .accessibilityLabel("Folder \(path)")
            Spacer(minLength: 0)
            Menu {
                if let cwd { Button("Session Folder", systemImage: "house") { Task { await model.open(cwd) } } }
                if let roots = model.listing?.roots, !roots.isEmpty {
                    Section("Folders you can browse") {
                        ForEach(roots, id: \.self) { root in Button(root, systemImage: "folder") { Task { await model.open(root) } } }
                    }
                }
            } label: {
                Image(systemName: "house")
            } primaryAction: {
                if let cwd { Task { await model.open(cwd) } }
            }
            .accessibilityLabel("Session folder")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
    }

    // MARK: Rows

    private func row(_ entry: FsEntry) -> some View {
        let kind = FilesModel.Kind(entry)
        let path = model.child(entry)
        return HStack(spacing: 10) {
            Image(systemName: kind.symbol)
                .font(.ah(.body))
                .foregroundStyle(kind == .folder ? theme.accent : theme.muted)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.name).lineLimit(1).truncationMode(.middle)
                Text(detail(entry)).font(.ah(.caption)).foregroundStyle(theme.faint).lineLimit(1)
            }
            Spacer(minLength: 4)
            // The composer's own mention mark: this puts @path in the message.
            Button { insert(path) } label: { Image(systemName: "at.circle") }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.muted)
                .help("Mention in the message")
                .accessibilityLabel("Mention \(entry.name) in the message")
            if entry.type == .dir {
                Image(systemName: "chevron.right").font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.faint)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { Task { await open(entry) } }
        .draggable(FilesModel.mention(path, shell: session.isShell, cwd: cwd).trimmingCharacters(in: .whitespaces))
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button { insert(path) } label: { Label("Mention", systemImage: "at") }.tint(theme.accent)
        }
        .swipeActions(edge: .leading) {
            if entry.type == .file {
                Button { Task { await share(entry) } } label: { Label("Share", systemImage: "square.and.arrow.up") }.tint(theme.chart)
            }
        }
        .contextMenu {
            Button(entry.type == .dir ? "Open" : "Preview", systemImage: entry.type == .dir ? "folder" : "eye") { Task { await open(entry) } }
            Button("Mention in Message", systemImage: "at") { insert(path) }
            Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
            if entry.type == .file {
                Button("Share or Save…", systemImage: "square.and.arrow.up") { Task { await share(entry) } }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Mention in message") { insert(path) }
        .accessibilityIdentifier("file:\(entry.name)")
    }

    private func detail(_ entry: FsEntry) -> String {
        let when = Date(timeIntervalSince1970: entry.mtime / (entry.mtime > 1e11 ? 1000 : 1))
        let age = when.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        guard entry.type == .file else { return age }
        return "\(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file)) · \(age)"
    }

    // MARK: Actions

    private func insert(_ path: String) {
        session.composer.insert(FilesModel.mention(path, shell: session.isShell, cwd: cwd))
        scene.requestFocus(.composer(session.key))
        Haptics.tap()
    }

    private func open(_ entry: FsEntry) async {
        let path = model.child(entry)
        if entry.type == .dir {
            await model.open(path)
            return
        }
        let kind = FilesModel.Kind(entry)
        if entry.size > Double(FilesModel.previewLimit) && kind != .image && kind != .pdf {
            await share(entry)
            return
        }
        guard let data = await model.data(path) else { return }
        if kind != .image, kind != .pdf, kind != .media, let text = FilesModel.text(data) {
            reading = FileText(path: path, text: text, kind: kind)
            return
        }
        previewURL = temporaryCopy(data, named: entry.name)
    }

    private func share(_ entry: FsEntry) async {
        guard let data = await model.data(model.child(entry)) else { return }
        sharing = temporaryCopy(data, named: entry.name)
    }

    private func temporaryCopy(_ data: Data, named name: String) -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return (try? data.write(to: url, options: [.completeFileProtection])) == nil ? nil : url
    }

    /// Files dropped from another app (Files, Photos, a Mac's Finder) upload into this folder.
    private func upload(_ providers: [NSItemProvider]) {
        for provider in providers {
            let type = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .data) == true } ?? UTType.data.identifier
            let name = provider.suggestedName
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                guard let url, let data = try? Data(contentsOf: url) else { return }
                let file = name.map { n in url.pathExtension.isEmpty || n.hasSuffix(".\(url.pathExtension)") ? n : "\(n).\(url.pathExtension)" } ?? url.lastPathComponent
                Task { @MainActor in await model.upload(name: file, data: data) }
            }
        }
    }
}

/// A text file from the host, read in place: monospaced with line numbers, selectable.
private struct FileText: Identifiable {
    let path: String
    let text: String
    let kind: FilesModel.Kind
    var id: String { path }
}

private struct FileTextSheet: View {
    let file: FileText
    let insert: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                let lines = file.text.split(separator: "\n", omittingEmptySubsequences: false)
                let width = String(lines.count).count
                Text(lines.enumerated().map { index, line in
                    AttributedString(String(index + 1).leftPadded(to: width) + "  ", attributes: AttributeContainer().foregroundColor(theme.faint))
                        + AttributedString(String(line) + "\n")
                }.reduce(AttributedString(), +))
                .font(.ahMono(.footnote))
                .textSelection(.enabled)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(theme.surface)
            .navigationTitle((file.path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItemGroup(placement: .primaryAction) {
                    // Says it worked: a check for a moment, and a tap under the finger.
                    Button {
                        UIPasteboard.general.string = file.text
                        Haptics.success()
                        copied = true
                        Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            copied = false
                        }
                    } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc").contentTransition(.symbolEffect(.replace))
                    }
                    .accessibilityLabel(copied ? "Copied" : "Copy")
                    .tint(.primary)
                    Button {
                        insert()
                        dismiss()
                    } label: {
                        Label("Mention", systemImage: "at")
                    }
                }
            }
        }
    }
}

private extension String {
    func leftPadded(to width: Int) -> String { String(repeating: " ", count: max(0, width - count)) + self }
}

private struct SharedFile: Identifiable {
    let url: URL
    var id: URL { url }
}

/// The system share sheet (Save to Files, AirDrop, another app).
private struct ActivitySheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: Side chat

private struct ChatPanel: View {
    @State var model: SideChatModel
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var draft = ""
    @State private var browsing = false

    var body: some View {
        VStack(spacing: 0) {
            // Inline, so it shows in an iPad side panel as well as a phone sheet.
            HStack {
                Text("Side chat").font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.muted)
                Spacer()
                Button { browsing = true } label: { Image(systemName: "clock.arrow.circlepath") }.accessibilityLabel("Past chats")
                Button { Task { await model.clear() } } label: { Image(systemName: "trash") }.accessibilityLabel("Clear the chat")
                    .disabled(model.messages.isEmpty)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 12) {
                    if model.subscriptions.isEmpty {
                        EmptyState(symbol: "key", title: "No chat model yet", message: "Add a subscription in Settings to discuss this work with another model, outside the agent’s context.", action: ("Open Settings", { scene.sheet = .settings(SettingsSection.subscriptions.rawValue) }))
                    } else if model.messages.isEmpty && !model.sending {
                        EmptyState(symbol: "bubble.left.and.text.bubble.right", title: "Ask about this change", message: "A review, an explanation, or a plan. Nothing here reaches the agent unless you send it over.")
                            .padding(.top, 40)
                    }
                    ForEach(Array(model.messages.enumerated()), id: \.offset) { _, message in
                        if message.role == .user {
                            UserBubble(text: message.text)
                        } else {
                            MarkdownView(message.text)
                                .contextMenu {
                                    Button("Send to the agent", systemImage: "paperplane") {
                                        session.composer.text = message.text
                                        scene.requestFocus(.composer(session.key))
                                    }
                                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.text }
                                }
                        }
                    }
                    if model.sending { ProgressView() }
                    if !model.followups.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(model.followups, id: \.self) { followup in
                                Button(followup.title) {
                                    if followup.kind == "session" {
                                        session.composer.text = followup.text
                                        scene.requestFocus(.composer(session.key))
                                    } else {
                                        Task { await model.send(followup.text) }
                                    }
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                    if let error = model.error { Banner(text: error, tone: .error) }
                }
                .padding()
            }
            HStack {
                if model.subscriptions.count > 1 {
                    Menu {
                        ForEach(model.subscriptions) { sub in
                            Button(sub.name) { Task { await model.pick(sub.id) } }
                        }
                    } label: {
                        Text(model.activeSubscription?.name ?? "Model").font(.ah(.caption))
                    }
                }
                // The same box as the session's composer, a size smaller.
                let empty = draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("Ask about this change…", text: $draft, axis: .vertical)
                        .lineLimit(1...6)
                        .onSubmit(send)
                        .padding(.vertical, 7)
                    Button(action: send) {
                        Image(systemName: "arrow.up")
                            .font(.ah(.callout).weight(.bold))
                            .frame(width: 30, height: 30)
                            .background(empty || model.sending ? theme.faint.opacity(0.3) : theme.accentStrong, in: Circle())
                            .foregroundStyle(.white)
                    }
                    .disabled(empty || model.sending)
                    .accessibilityLabel("Ask")
                }
                .padding(.leading, 12)
                .padding(.trailing, 5)
                .padding(.vertical, 3)
                .background(theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .padding(10)
        }
        .task { await model.load() }
        .sheet(isPresented: $browsing) { PastChatsView(api: model.api) }
    }

    private func send() {
        let text = draft
        draft = ""
        Task { await model.send(text) }
    }
}

/// Side chats from every session, searchable; each opens read-only.
private struct PastChatsView: View {
    let api: APIClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme
    @State private var query = ""
    @State private var chats: [ChatSummary] = []
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { Banner(text: error, tone: .error) }
                ForEach(chats) { chat in
                    NavigationLink {
                        PastChatView(api: api, chat: chat)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text(chat.title).lineLimit(1)
                                Spacer()
                                Text(Elapsed.format(Date(timeIntervalSince1970: chat.lastAt / 1000), now: .now)).font(.ah(.caption)).foregroundStyle(theme.faint)
                            }
                            Text(chat.preview).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(2)
                        }
                    }
                    .ahRow()
                }
                if chats.isEmpty && error == nil {
                    EmptyState(symbol: "bubble.left.and.text.bubble.right", title: query.isEmpty ? "No side chats yet" : "Nothing matches", message: "Side chats you’ve had about this session’s changes show here.")
                        .listRowBackground(Color.clear)
                }
            }
            .ahFormGround()
            .searchable(text: $query)
            .navigationTitle("Past chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) } }
            .task(id: query) {
                try? await Task.sleep(for: .milliseconds(250))
                do {
                    chats = try await api.pastChats(query: query.isEmpty ? nil : query)
                    error = nil
                } catch {
                    self.error = APIError.wrap(error).message
                }
            }
        }
    }
}

private struct PastChatView: View {
    let api: APIClient
    let chat: ChatSummary
    @State private var messages: [ChatMessage] = []

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(Array(messages.enumerated()), id: \.offset) { _, message in
                    if message.role == .user { UserBubble(text: message.text) } else { MarkdownView(message.text) }
                }
            }
            .padding()
        }
        .navigationTitle(chat.title)
        .task { messages = (try? await api.pastChat(chat.uid)) ?? [] }
    }
}

// MARK: Queue

private struct QueuePanel: View {
    let session: SessionModel
    @Environment(\.theme) private var theme

    var body: some View {
        List {
            if session.queue.items.isEmpty {
                EmptyState(symbol: "text.line.last.and.arrowtriangle.forward", title: "Nothing queued", message: "Messages you send while the agent works wait here, in order. Drag to reorder, or send one now to stop the turn and go first.")
                    .listRowBackground(Color.clear)
            }
            ForEach(session.queue.items) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(Uploads.summary(item.text)).lineLimit(4)
                    Elapsed(seconds: item.at).font(.ah(.caption)).foregroundStyle(theme.faint)
                }
                .ahRow()
                .swipeActions(edge: .leading) {
                    Button("Send now") { Task { await session.queue.steer(item) } }.tint(theme.limited)
                }
                .swipeActions(edge: .trailing) {
                    Button("Cancel", role: .destructive) { Task { await session.queue.cancel(item) } }
                    Button("Edit") {
                        Task { if let text = await session.queue.edit(item) { session.composer.compose(text) } }
                    }
                }
            }
            .onMove { from, to in
                guard let index = from.first else { return }
                let item = session.queue.items[index]
                Task { await session.queue.move(item.id, to: to > index ? to - 1 : to) }
            }
            if !session.queue.items.isEmpty {
                Button("Cancel all", role: .destructive) { Task { await session.queue.cancelAll() } }
                    .ahRow()
            }
        }
        .environment(\.editMode, .constant(.active))
        .task { await session.queue.load() }
    }
}

// MARK: Snapshots

private struct SnapshotsPanel: View {
    @State var model: SnapshotsModel
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var confirming: SnapshotInfo?
    @State private var stopFirst: SnapshotInfo?
    /// The last restore, for its Undo.
    @State private var undo: SnapshotRestore?
    /// The row a "Restore Files from Before This…" landed on, lit for a moment.
    @State private var highlight: Int?

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if let list = model.list {
                    intro(list)
                    if let notice = model.notice {
                        Banner(text: notice, tone: .warning, action: ("OK", { model.dismissNotice() }))
                    }
                    if let undo {
                        restoredCard(undo)
                    }
                    if let error = model.error { Banner(text: error, tone: .error) }
                    if !list.available {
                        empty("No git here", "folder.badge.questionmark", "Snapshots need the session’s folder to be a git repository.")
                    } else if list.snapshots.isEmpty {
                        empty("No snapshots yet", "clock.arrow.circlepath", "The files are saved before each turn starts. The next turn takes the first one.")
                    } else {
                        timeline(list)
                        Text("Kept under refs/ah-snapshots, so git gc leaves them alone while they’re listed here.")
                            .font(.ah(.caption2))
                            .foregroundStyle(theme.faint)
                            .padding(.top, 4)
                    }
                } else if let error = model.error {
                    Banner(text: error, tone: .error, action: ("Retry", { Task { await model.load() } }))
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 40)
                }
            }
            .padding(16)
            .animation(.snappy(duration: 0.25), value: model.list)
            .animation(.snappy(duration: 0.25), value: undo)
        }
        .background(theme.background)
        .onChange(of: model.list, initial: true) { _, _ in answerRequest(proxy) }
        .onChange(of: session.restoreRequest) { _, _ in answerRequest(proxy) }
        }
        .task { await model.watch() }
        .alert(confirmTitle, isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), presenting: confirming) { snap in
            Button("Cancel", role: .cancel) {}
            Button("Restore", role: .destructive) { restore(snap, interrupt: false) }
        } message: { snap in
            if let list = model.list { Text(SnapshotsModel.confirmation(snap, in: list).message) }
        }
        .alert("The agent is working", isPresented: Binding(get: { stopFirst != nil }, set: { if !$0 { stopFirst = nil } }), presenting: stopFirst) { snap in
            Button("Cancel", role: .cancel) {}
            Button("Stop and Restore", role: .destructive) { restore(snap, interrupt: true) }
        } message: { _ in
            Text("Stop the current turn and restore now? A safety copy of the files is still taken first.")
        }
    }

    /// Lands on the snapshot taken before the message asked about, and asks to restore it.
    private func answerRequest(_ proxy: ScrollViewProxy) {
        guard let prompt = session.restoreRequest, let list = model.list else { return }
        session.restoreRequest = nil
        guard let snap = SnapshotsModel.match(prompt: prompt, in: list) else {
            scene.toast(list.available ? "No snapshot was taken before that message." : "Snapshots need a git repository.")
            return
        }
        withAnimation(.snappy) { proxy.scrollTo(snap.id, anchor: .center) }
        highlight = snap.id
        confirming = snap
        Task {
            try? await Task.sleep(for: .seconds(2))
            withAnimation(.easeOut(duration: 0.6)) { if highlight == snap.id { highlight = nil } }
        }
    }

    private var confirmTitle: String {
        guard let confirming, let list = model.list else { return "" }
        return SnapshotsModel.confirmation(confirming, in: list).title
    }

    // MARK: Parts

    private func intro(_ list: SnapshotList) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "clock.arrow.circlepath")
                    .font(.ah(.title3).weight(.semibold))
                    .foregroundStyle(theme.accent)
                    .frame(width: 36, height: 36)
                    .background(theme.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Rewind the files").font(.ah(.headline))
                    Text("The files are saved before every turn, with what changed since the one before. Restore one to put them back; what’s there now is saved first.")
                        .font(.ah(.caption))
                        .foregroundStyle(theme.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if list.available {
                Toggle(isOn: Binding(get: { list.enabled }, set: { on in Haptics.selection(); Task { await model.setEnabled(on) } })) {
                    Text("Save before every turn").font(.ah(.subheadline))
                }
                .tint(theme.accent)
            }
            if list.partial && list.available {
                Label("Turns typed straight into the terminal may be missed.", systemImage: "info.circle")
                    .font(.ah(.caption2))
                    .foregroundStyle(theme.faint)
            }
        }
        .padding(14)
        .background(theme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func restoredCard(_ result: SnapshotRestore) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.done).font(.ah(.title3))
            VStack(alignment: .leading, spacing: 1) {
                Text(result.restored.kind == "safety" ? "Safety copy restored" : "Back to before turn \(result.restored.turn)").font(.ah(.subheadline).weight(.semibold))
                Text("What was there is kept as a safety copy.").font(.ah(.caption)).foregroundStyle(theme.muted)
            }
            Spacer(minLength: 8)
            Button("Undo") { restore(result.safety, interrupt: false, isUndo: true) }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model.restoring != nil)
            Button { undo = nil } label: { Image(systemName: "xmark").font(.ah(.caption).weight(.bold)) }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .foregroundStyle(theme.faint)
                .accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(theme.done.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    private func empty(_ title: String, _ icon: String, _ text: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: icon)
        } description: {
            Text(text)
        }
        .padding(.top, 24)
    }

    private func timeline(_ list: SnapshotList) -> some View {
        let rows = SnapshotsModel.timeline(list)
        return VStack(alignment: .leading, spacing: 0) {
            nowRow(list)
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, snap in
                SnapshotRow(
                    snap: snap,
                    currentBranch: list.branch,
                    last: index == rows.count - 1,
                    restoring: model.restoring == snap.turn,
                    busy: model.restoring != nil,
                    restore: { confirming = snap }
                )
                .id(snap.id)
                .background(theme.accent.opacity(highlight == snap.id ? 0.14 : 0), in: RoundedRectangle(cornerRadius: 12, style: .continuous).inset(by: -6))
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
    }

    /// The top of the timeline: the files as they are.
    private func nowRow(_ list: SnapshotList) -> some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                Circle().fill(theme.accent).frame(width: 12, height: 12)
                    .overlay(Circle().stroke(theme.accent.opacity(0.25), lineWidth: 5))
                    .padding(.top, 4)
                Rectangle().fill(theme.faint.opacity(0.35)).frame(width: 2).frame(maxHeight: .infinity)
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text("Now").font(.ah(.subheadline).weight(.semibold))
                if let branch = list.branch {
                    Label(branch, systemImage: "arrow.triangle.branch").font(.ah(.caption)).foregroundStyle(theme.muted)
                }
            }
            .padding(.bottom, 16)
        }
    }

    private func restore(_ snap: SnapshotInfo, interrupt: Bool, isUndo: Bool = false) {
        confirming = nil
        stopFirst = nil
        Task {
            switch await model.restore(turn: snap.turn, interrupt: interrupt) {
            case .restored(let result):
                Haptics.success()
                undo = isUndo ? nil : result
                if isUndo { scene.toast("Undone: the files are back as they were.") }
            case .agentWorking:
                Haptics.warning()
                stopFirst = snap
            case .failed:
                Haptics.failure()
            }
        }
    }
}

/// One snapshot on the timeline: when, what was asked, and how much changed since the one before.
private struct SnapshotRow: View {
    let snap: SnapshotInfo
    let currentBranch: String?
    let last: Bool
    let restoring: Bool
    let busy: Bool
    let restore: () -> Void
    @Environment(\.theme) private var theme

    private var safety: Bool { snap.kind == "safety" }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(spacing: 0) {
                ZStack {
                    Circle().fill(theme.background).frame(width: 18, height: 18)
                    if safety {
                        Image(systemName: "lifepreserver.fill").font(.system(size: 13)).foregroundStyle(theme.limited)
                    } else {
                        Circle().strokeBorder(theme.muted, lineWidth: 2).frame(width: 12, height: 12)
                    }
                }
                .padding(.top, 2)
                if !last { Rectangle().fill(theme.faint.opacity(0.35)).frame(width: 2).frame(maxHeight: .infinity) }
            }
            .frame(width: 18)
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline) {
                    Text(SnapshotsModel.title(snap)).font(.ah(.subheadline).weight(.semibold))
                    Spacer(minLength: 8)
                    Elapsed(seconds: snap.createdAt).font(.ah(.caption).monospacedDigit()).foregroundStyle(theme.faint)
                }
                if !snap.promptExcerpt.isEmpty {
                    Text(SnapshotsModel.excerpt(snap))
                        .font(.ah(.callout))
                        .foregroundStyle(theme.text2)
                        .lineLimit(3)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(theme.raised, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                HStack(spacing: 8) {
                    Text(SnapshotsModel.stats(snap, oldest: last)).foregroundStyle(theme.muted).lineLimit(1)
                        .help("Since the snapshot before this one")
                    if snap.insertions > 0 { Text("+\(snap.insertions)").foregroundStyle(theme.done) }
                    if snap.deletions > 0 { Text("−\(snap.deletions)").foregroundStyle(theme.danger) }
                    Spacer(minLength: 8)
                    Button(action: restore) {
                        if restoring {
                            ProgressView().controlSize(.mini)
                        } else {
                            Label("Restore", systemImage: "arrow.uturn.backward")
                        }
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .disabled(busy)
                }
                .font(.ah(.caption).monospacedDigit())
                notes
            }
            .padding(.bottom, last ? 0 : 18)
        }
        .contentShape(Rectangle())
        .contextMenu {
            Button(safety ? "Restore This Safety Copy" : "Restore Files to Before Turn \(snap.turn)", systemImage: "arrow.uturn.backward", action: restore)
                .disabled(busy)
            Button("Copy Commit", systemImage: "doc.on.doc") { UIPasteboard.general.string = snap.commit }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Restore", restore)
    }

    @ViewBuilder
    private var notes: some View {
        let otherBranch = !snap.branch.isEmpty && currentBranch != nil && snap.branch != currentBranch
        if otherBranch || !snap.skipped.isEmpty || snap.submodules {
            VStack(alignment: .leading, spacing: 3) {
                if otherBranch { Label("Taken on \(snap.branch)", systemImage: "arrow.triangle.branch").foregroundStyle(theme.limited) }
                if !snap.skipped.isEmpty {
                    Label("\(snap.skipped.count) oversized file\(snap.skipped.count == 1 ? "" : "s") not kept", systemImage: "externaldrive.badge.xmark")
                        .foregroundStyle(theme.faint)
                }
                if snap.submodules { Label("Submodules aren’t included", systemImage: "shippingbox").foregroundStyle(theme.faint) }
            }
            .font(.ah(.caption2))
        }
    }
}

// MARK: Preview

/// A dev server through ah's authenticated proxy, in a web view whose cookies live only in
/// memory and which can't navigate anywhere but the preview's own origin.
private struct PreviewPanel: View {
    @State var model: PreviewModel
    let session: SessionModel
    @Environment(\.theme) private var theme
    @State private var cookie: PreviewCookie?
    @State private var browser = PreviewBrowser()
    @State private var typed = ""
    @FocusState private var portFocused: Bool

    var body: some View {
        Group {
            if let info = model.info {
                if let preview = info.preview, let url = PreviewModel.url(origin: session.api.origin, port: preview.port) {
                    live(preview, url: url, others: info.ports.filter { $0 != preview.target })
                } else {
                    picker(info)
                }
            } else if let error = model.error {
                ContentUnavailableView("Can’t reach the preview", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { await model.watch() }
    }

    // MARK: Live

    private func live(_ preview: PreviewDTO, url: URL, others: [Int]) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 14) {
                Button { browser.view?.goBack() } label: { Image(systemName: "chevron.backward") }
                    .disabled(!browser.canGoBack)
                    .accessibilityLabel("Back")
                Button { browser.view?.goForward() } label: { Image(systemName: "chevron.forward") }
                    .disabled(!browser.canGoForward)
                    .accessibilityLabel("Forward")
                Menu {
                    Section("Previewing localhost:\(preview.target) through ah") {
                        ForEach(others, id: \.self) { port in
                            Button("Switch to localhost:\(String(port))", systemImage: "arrow.left.arrow.right") { Task { await model.start(port) } }
                        }
                        Button("Stop the Preview", systemImage: "stop.circle", role: .destructive) { Task { await model.stop() } }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "lock.fill").font(.ah(.caption2)).foregroundStyle(theme.faint)
                        Text(browser.title.isEmpty ? "localhost:\(String(preview.target))" : browser.title)
                            .font(.ah(.callout))
                            .lineLimit(1)
                            .foregroundStyle(theme.text)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(theme.raised, in: Capsule())
                }
                .accessibilityLabel("Preview of localhost:\(preview.target)")
                Button {
                    if browser.loading { browser.view?.stopLoading() } else { browser.view?.reload() }
                } label: {
                    Image(systemName: browser.loading ? "xmark" : "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: .command)
                .accessibilityLabel(browser.loading ? "Stop loading" : "Reload")
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(.bar)
            .overlay(alignment: .bottom) {
                if browser.loading {
                    ProgressView(value: browser.progress).progressViewStyle(.linear).tint(theme.accent).frame(height: 2)
                } else {
                    Divider()
                }
            }
            if let cookie {
                PreviewWebView(url: url, cookie: cookie, hubHost: session.api.origin.host ?? "", browser: browser)
                    .id(preview.port * 100_000 + preview.target)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .task { cookie = try? await session.api.previewSession() }
            }
        }
    }

    // MARK: Choosing a port

    private func picker(_ info: PreviewInfo) -> some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "safari")
                    .font(.system(size: 40, weight: .light))
                    .foregroundStyle(theme.accent)
                    .padding(.top, 36)
                VStack(spacing: 6) {
                    Text("Preview a dev server").font(.ah(.headline))
                    Text("Storybook, Vite, Next… running in this session. It runs on the host and shows here, through ah’s sign-in.")
                        .font(.ah(.callout))
                        .foregroundStyle(theme.muted)
                        .multilineTextAlignment(.center)
                }
                if !info.live {
                    Label("The session isn’t running.", systemImage: "moon.zzz").foregroundStyle(theme.muted)
                } else {
                    if info.ports.isEmpty {
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Waiting for something in this session to listen on a port…").font(.ah(.callout)).foregroundStyle(theme.muted)
                        }
                    } else {
                        VStack(spacing: 8) {
                            ForEach(info.ports, id: \.self) { port in
                                Button {
                                    Task { await model.start(port) }
                                } label: {
                                    HStack {
                                        Image(systemName: "network")
                                        Text("localhost:\(String(port))").font(.ah(.body).monospacedDigit())
                                        Spacer()
                                        Image(systemName: "arrow.right.circle.fill").foregroundStyle(theme.accent)
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 11)
                                    .background(theme.raised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                                }
                                .buttonStyle(.plain)
                                .hoverEffect(.highlight)
                                .accessibilityIdentifier("preview:\(port)")
                            }
                        }
                    }
                    HStack(spacing: 8) {
                        TextField("Another port", text: $typed)
                            .keyboardType(.numberPad)
                            .focused($portFocused)
                            .font(.ah(.body).monospacedDigit())
                            .padding(.horizontal, 12)
                            .padding(.vertical, 9)
                            .background(theme.raised, in: Capsule())
                            .onSubmit(startTyped)
                        // The field's height and shape, the accent's fill: unset, a disabled
                        // prominent button was a black slab beside a rounded field.
                        let ready = PreviewModel.port(typed) != nil && !model.busy
                        Button(action: startTyped) {
                            Text("Preview").fontWeight(.semibold).padding(.horizontal, 16).padding(.vertical, 9)
                                .foregroundStyle(ready ? Color.white : theme.faint)
                                .background(ready ? theme.accentStrong : theme.raised, in: Capsule())
                        }
                        .buttonStyle(.ahPress)
                        .disabled(!ready)
                        .animation(.snappy(duration: 0.2), value: ready)
                    }
                }
                if let error = model.error { Banner(text: error, tone: .error) }
            }
            .padding(.horizontal, 20)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
    }

    private func startTyped() {
        guard let port = PreviewModel.port(typed) else { return }
        typed = ""
        Task { await model.start(port) }
    }
}

/// The preview's web view as SwiftUI sees it: where it can go and how far it has loaded.
@MainActor
@Observable
private final class PreviewBrowser {
    @ObservationIgnored weak var view: WKWebView?
    var canGoBack = false
    var canGoForward = false
    var loading = false
    var progress = 0.0
    var title = ""
    @ObservationIgnored private var watches: [NSKeyValueObservation] = []

    func attach(_ view: WKWebView) {
        self.view = view
        watches = [
            view.observe(\.canGoBack) { [weak self] v, _ in MainActor.assumeIsolated { self?.canGoBack = v.canGoBack } },
            view.observe(\.canGoForward) { [weak self] v, _ in MainActor.assumeIsolated { self?.canGoForward = v.canGoForward } },
            view.observe(\.isLoading) { [weak self] v, _ in MainActor.assumeIsolated { self?.loading = v.isLoading } },
            view.observe(\.estimatedProgress) { [weak self] v, _ in MainActor.assumeIsolated { self?.progress = v.estimatedProgress } },
            view.observe(\.title) { [weak self] v, _ in MainActor.assumeIsolated { self?.title = v.title ?? "" } },
        ]
    }
}

private struct PreviewWebView: UIViewRepresentable {
    let url: URL
    let cookie: PreviewCookie
    let hubHost: String
    let browser: PreviewBrowser

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
        #if DEBUG
        view.isInspectable = true
        #endif
        browser.attach(view)
        let name = url.scheme == "https" ? cookie.names.https : cookie.names.http
        // Host-only (from the origin URL, no Domain attribute), as a __Host- cookie must be.
        var properties: [HTTPCookiePropertyKey: Any] = [.name: name, .value: cookie.value, .path: "/", .originURL: url, .expires: Date(timeIntervalSince1970: cookie.expiresAt / 1000)]
        if url.scheme == "https" { properties[.secure] = "TRUE" }
        if let made = HTTPCookie(properties: properties) {
            configuration.websiteDataStore.httpCookieStore.setCookie(made) { view.load(URLRequest(url: url)) }
        } else {
            view.load(URLRequest(url: url))
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(preview: url) }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate {
        let preview: URL
        init(preview: URL) { self.preview = preview }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            guard let url = action.request.url else { return .cancel }
            if PreviewModel.allows(url, preview: preview) { return .allow }
            // Links elsewhere open in the browser, never inside the preview.
            if action.navigationType == .linkActivated, case .external(let external) = LinkPolicy.classify(url.absoluteString) {
                _ = await UIApplication.shared.open(external)
            }
            return .cancel
        }
    }
}

// MARK: Stack

/// The stack this session is building: its branches bottom to top, each PR, and Review.
private struct StackPanel: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var stack: SessionStack?
    @State private var error: String?

    var body: some View {
        List {
            if let stack {
                if let review = stack.review {
                    Button {
                        scene.openReview(ReviewRoute(stack: review.id))
                    } label: {
                        Label("Review “\(review.title)”", systemImage: "checkmark.seal")
                    }
                    .ahRow()
                }
                if stack.branches.isEmpty {
                    EmptyState(symbol: "square.stack.3d.up", title: "Not a stack", message: "\(session.row?.dto.branch ?? "This branch") isn’t part of a stack. When the agent stacks branches with gh stack, they show here bottom to top, with their pull requests and checks.")
                        .listRowBackground(Color.clear)
                } else {
                Section("Bottom to top, onto \(stack.trunk)") {
                    ForEach(stack.branches, id: \.branch) { branch in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Image(systemName: branch.current ? "largecircle.fill.circle" : "circle").foregroundStyle(branch.current ? theme.accent : theme.faint)
                                Text(branch.branch).font(.ahMono(.callout))
                                Spacer()
                                if let layer = branch.layer { Text(layer.status.word).font(.ah(.caption)).foregroundStyle(theme.muted) }
                            }
                            if let pr = branch.pr {
                                Link("#\(pr.number) \(pr.title)", destination: URL(string: pr.url) ?? URL(string: "https://github.com")!)
                                    .font(.ah(.caption))
                                Text(LayerConfidence.checksLabel(pr.checks)).font(.ah(.caption2)).foregroundStyle(theme.faint)
                            }
                        }
                        .ahRow()
                    }
                }
                }
            } else if let error {
                Banner(text: error, tone: .error)
            } else {
                ProgressView()
            }
        }
        .task {
            do { stack = try await ReviewAPI(api: session.api).sessionStack(session.ref) } catch { self.error = APIError.wrap(error).message }
        }
    }
}

extension LayerConfidence {
    static func checksLabel(_ checks: Checks) -> String {
        switch checks.outcome {
        case .none: return "No checks reported"
        case .pending: return "Checks running"
        case .failing: return "Failing: \(checks.failing.joined(separator: ", "))"
        case .passing: return "\(checks.pass) checks passed"
        }
    }
}
