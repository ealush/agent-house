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
                if let changes = model.changes {
                    Section {
                        HStack {
                            Label(changes.branch, systemImage: "arrow.triangle.branch")
                            Spacer()
                            Text("+\(model.totals.add)").foregroundStyle(theme.done)
                            Text("−\(model.totals.del)").foregroundStyle(theme.danger)
                        }
                        .font(.callout.monospacedDigit())
                        if changes.truncated { Text("The diff is long; showing the start.").font(.caption).foregroundStyle(theme.limited) }
                        if commentable {
                            Text(scene.hardwareKeyboard ? "↑↓ walk the lines; Return comments for the agent." : "Tap a line to comment for the agent.").font(.caption).foregroundStyle(theme.muted)
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
                                Text(file.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                                Spacer()
                                Text("+\(file.additions) −\(file.deletions)").font(.caption2.monospacedDigit())
                            }
                        }
                    }
                    if !model.untracked.isEmpty {
                        Section("New files") {
                            ForEach(model.untracked, id: \.path) { Text($0.path).font(.caption.monospaced()) }
                        }
                    }
                } else if let error = model.error {
                    Banner(text: error, tone: .error)
                } else {
                    ProgressView()
                }
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
                .font(.caption.monospaced()).foregroundStyle(theme.muted).lineLimit(1).truncationMode(.head)
            Text(target.line.text.trimmingCharacters(in: .whitespaces)).font(.caption.monospaced()).lineLimit(2)
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
                Text(scene.hardwareKeyboard ? "⌘↵ sends · esc cancels" : "").font(.caption2).foregroundStyle(theme.faint)
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
                        .font(.callout)
                        .foregroundStyle(theme.muted)
                        .listRowBackground(Color.clear)
                }
                ForEach(listing.entries, id: \.name) { entry in
                    row(entry)
                        .tag(entry.name)
                }
            } else if model.error == nil {
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            }
            if let error = model.error { Banner(text: error, tone: .error).listRowBackground(Color.clear) }
            ForEach(model.uploading, id: \.self) { name in
                Label("Uploading \(name)…", systemImage: "arrow.up.circle").foregroundStyle(theme.muted)
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
                            .font(.callout.weight(.semibold))
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
                        Button("Insert This Folder", systemImage: "text.insert") { insert(path) }
                        Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
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
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(theme.faint)
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
                .font(.body)
                .foregroundStyle(kind == .folder ? theme.accent : theme.muted)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(entry.name).lineLimit(1).truncationMode(.middle)
                Text(detail(entry)).font(.caption).foregroundStyle(theme.faint).lineLimit(1)
            }
            Spacer(minLength: 4)
            Button { insert(path) } label: { Image(systemName: "text.insert") }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.muted)
                .accessibilityLabel("Insert \(entry.name) in the message")
            if entry.type == .dir {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(theme.faint)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { Task { await open(entry) } }
        .draggable(FilesModel.mention(path, shell: session.isShell, cwd: cwd).trimmingCharacters(in: .whitespaces))
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button { insert(path) } label: { Label("Insert", systemImage: "text.insert") }.tint(theme.accent)
        }
        .swipeActions(edge: .leading) {
            if entry.type == .file {
                Button { Task { await share(entry) } } label: { Label("Share", systemImage: "square.and.arrow.up") }.tint(.blue)
            }
        }
        .contextMenu {
            Button(entry.type == .dir ? "Open" : "Preview", systemImage: entry.type == .dir ? "folder" : "eye") { Task { await open(entry) } }
            Button("Insert in Message", systemImage: "text.insert") { insert(path) }
            Button("Copy Path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
            if entry.type == .file {
                Button("Share or Save…", systemImage: "square.and.arrow.up") { Task { await share(entry) } }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Insert in message") { insert(path) }
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

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                let lines = file.text.split(separator: "\n", omittingEmptySubsequences: false)
                let width = String(lines.count).count
                Text(lines.enumerated().map { index, line in
                    AttributedString(String(index + 1).leftPadded(to: width) + "  ", attributes: AttributeContainer().foregroundColor(theme.faint))
                        + AttributedString(String(line) + "\n")
                }.reduce(AttributedString(), +))
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle((file.path as NSString).lastPathComponent)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItemGroup(placement: .primaryAction) {
                    Button { UIPasteboard.general.string = file.text } label: { Image(systemName: "doc.on.doc") }.accessibilityLabel("Copy")
                    Button {
                        insert()
                        dismiss()
                    } label: {
                        Label("Insert", systemImage: "text.insert")
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
                Text("Side chat").font(.caption.weight(.semibold)).foregroundStyle(theme.muted)
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
                        Text(model.activeSubscription?.name ?? "Model").font(.caption)
                    }
                }
                TextField("Ask about this work", text: $draft, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(send)
                Button(action: send) { Image(systemName: "arrow.up.circle.fill").font(.title2) }
                    .disabled(draft.trimmingCharacters(in: .whitespaces).isEmpty || model.sending)
            }
            .padding(10)
            .background(.bar)
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
                                Text(Elapsed.format(Date(timeIntervalSince1970: chat.lastAt / 1000), now: .now)).font(.caption).foregroundStyle(theme.faint)
                            }
                            Text(chat.preview).font(.caption).foregroundStyle(theme.muted).lineLimit(2)
                        }
                    }
                }
                if chats.isEmpty && error == nil { Text("No side chats yet.").foregroundStyle(theme.muted) }
            }
            .searchable(text: $query)
            .navigationTitle("Past chats")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
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
                Text("Nothing queued. Messages you send while the agent works wait here.").foregroundStyle(theme.muted)
            }
            ForEach(session.queue.items) { item in
                VStack(alignment: .leading, spacing: 4) {
                    Text(Uploads.summary(item.text)).lineLimit(4)
                    Elapsed(seconds: item.at).font(.caption).foregroundStyle(theme.faint)
                }
                .swipeActions(edge: .leading) {
                    Button("Send now") { Task { await session.queue.steer(item) } }.tint(.orange)
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

    var body: some View {
        List {
            if let list = model.list {
                Section {
                    Toggle("Snapshot every turn", isOn: Binding(get: { list.enabled }, set: { on in Task { await model.setEnabled(on) } }))
                        .disabled(!list.available)
                    if !list.available { Text("Snapshots need a git repository.").font(.caption).foregroundStyle(theme.muted) }
                    if list.partial { Text("Some files were too large to keep.").font(.caption).foregroundStyle(theme.limited) }
                }
                ForEach(list.snapshots.reversed()) { snap in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Text(snap.kind == "safety" ? "Safety copy" : "Turn \(snap.turn)").font(.subheadline.weight(.semibold))
                            Spacer()
                            Elapsed(seconds: snap.createdAt / 1000).font(.caption).foregroundStyle(theme.faint)
                        }
                        if !snap.promptExcerpt.isEmpty { Text(snap.promptExcerpt).font(.caption).foregroundStyle(theme.muted).lineLimit(2) }
                        Text("\(snap.filesChanged) files · +\(snap.insertions) −\(snap.deletions)").font(.caption2.monospacedDigit()).foregroundStyle(theme.faint)
                    }
                    .swipeActions {
                        Button("Restore") { confirming = snap }.tint(.orange)
                    }
                    .contextMenu { Button("Restore files to before this turn", systemImage: "clock.arrow.circlepath") { confirming = snap } }
                }
            } else if let error = model.error {
                Banner(text: error, tone: .error)
            } else {
                ProgressView()
            }
        }
        .task { await model.load() }
        .confirmationDialog("Restore the files to before turn \(confirming?.turn ?? 0)?", isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }), titleVisibility: .visible) {
            Button("Restore", role: .destructive) { restore(interrupt: false) }
            if session.working { Button("Stop the agent and restore", role: .destructive) { restore(interrupt: true) } }
        } message: {
            Text("A safety snapshot of the current files is taken first, so this can be undone.")
        }
    }

    private func restore(interrupt: Bool) {
        guard let snap = confirming else { return }
        confirming = nil
        Task {
            if let result = await model.restore(turn: snap.turn, interrupt: interrupt) {
                scene.toast("Restored to before turn \(result.restored.turn). Safety copy kept as turn \(result.safety.turn).")
            }
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

    var body: some View {
        VStack(spacing: 0) {
            if let info = model.info {
                if let preview = info.preview, let url = PreviewModel.url(origin: session.api.origin, port: preview.port) {
                    HStack {
                        Text("Port \(preview.target) via \(preview.port)").font(.caption.monospaced())
                        Spacer()
                        Button("Stop") { Task { await model.stop() } }.buttonStyle(.bordered).controlSize(.small)
                    }
                    .padding(8)
                    if let cookie {
                        PreviewWebView(url: url, cookie: cookie, hubHost: session.api.origin.host ?? "")
                    } else {
                        ProgressView().task { cookie = try? await session.api.previewSession() }
                    }
                } else if info.live {
                    List {
                        Section("Listening ports in this session") {
                            if info.ports.isEmpty { Text("No dev server is listening yet.").foregroundStyle(theme.muted) }
                            ForEach(info.ports, id: \.self) { port in
                                Button("Preview port \(port)") { Task { await model.start(port) } }
                            }
                        }
                    }
                } else {
                    EmptyState(symbol: "safari", title: "Not running", message: "Previews need the session running.")
                }
            } else if let error = model.error {
                Banner(text: error, tone: .error).padding()
            } else {
                ProgressView()
            }
        }
        .task { await model.load() }
    }
}

private struct PreviewWebView: UIViewRepresentable {
    let url: URL
    let cookie: PreviewCookie
    let hubHost: String

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsBackForwardNavigationGestures = true
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
                }
                Section("Bottom to top, onto \(stack.trunk)") {
                    ForEach(stack.branches, id: \.branch) { branch in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Image(systemName: branch.current ? "largecircle.fill.circle" : "circle").foregroundStyle(branch.current ? theme.accent : theme.faint)
                                Text(branch.branch).font(.callout.monospaced())
                                Spacer()
                                if let layer = branch.layer { Text(layer.status.word).font(.caption).foregroundStyle(theme.muted) }
                            }
                            if let pr = branch.pr {
                                Link("#\(pr.number) \(pr.title)", destination: URL(string: pr.url) ?? URL(string: "https://github.com")!)
                                    .font(.caption)
                                Text(LayerConfidence.checksLabel(pr.checks)).font(.caption2).foregroundStyle(theme.faint)
                            }
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
