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

    var body: some View {
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
                    if !session.isShell { Text("Tap a line to comment for the agent.").font(.caption).foregroundStyle(theme.muted) }
                }
                if model.files.isEmpty && model.untracked.isEmpty {
                    Text("No uncommitted changes.").foregroundStyle(theme.muted)
                }
                ForEach(model.files) { file in
                    Section {
                        DiffLinesView(lines: file.lines, maxLines: 400, onLine: { line in
                            guard !session.isShell, line.kind != .hunk, line.kind != .file else { return }
                            commenting = (file.path, line)
                        })
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
        .task {
            await model.load()
            model.watch()
        }
        .onDisappear { model.stop() }
        .refreshable { await model.load() }
        .alert("Comment for the agent", isPresented: Binding(get: { commenting != nil }, set: { if !$0 { commenting = nil } })) {
            TextField("What should change here?", text: $comment)
            Button("Send") {
                guard let target = commenting else { return }
                let text = comment
                comment = ""
                commenting = nil
                Task {
                    if let result = await model.send(comment: text, file: target.file, line: target.line) {
                        scene.toast(result.outcome == .queued ? "Queued for the agent" : "Sent to the agent")
                    }
                }
            }
            Button("Cancel", role: .cancel) { comment = "" }
        } message: {
            if let target = commenting {
                Text("\(target.file)\(target.line.number.map { ":\($0)" } ?? "")\n\(target.line.text.trimmingCharacters(in: .whitespaces))")
            }
        }
    }
}

// MARK: Files

private struct FilesPanel: View {
    @State var model: FilesModel
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var previewURL: URL?
    @State private var importing = false
    @State private var newFolder: String?

    var body: some View {
        List {
            if let listing = model.listing {
                Section {
                    if listing.parent != nil {
                        Button { Task { await model.up() } } label: { Label("..", systemImage: "arrow.turn.left.up") }
                    }
                    ForEach(listing.entries, id: \.name) { entry in
                        Button {
                            Task { await open(entry) }
                        } label: {
                            HStack {
                                Image(systemName: entry.type == .dir ? "folder.fill" : "doc").foregroundStyle(entry.type == .dir ? theme.accent : theme.muted)
                                Text(entry.name).lineLimit(1)
                                Spacer()
                                if entry.type == .file { Text(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file)).font(.caption).foregroundStyle(theme.faint) }
                            }
                        }
                        .contextMenu {
                            Button("Insert path in message", systemImage: "text.insert") {
                                session.composer.insert(FilesModel.mention(model.child(entry), shell: session.isShell))
                                scene.requestFocus(.composer(session.key))
                            }
                            Button("Copy path", systemImage: "doc.on.doc") { UIPasteboard.general.string = model.child(entry) }
                            if entry.type == .file {
                                Button("Save to Files…", systemImage: "square.and.arrow.down") { Task { await download(entry) } }
                            }
                        }
                    }
                } header: {
                    Text(listing.path).font(.caption.monospaced()).lineLimit(1).truncationMode(.head)
                }
                if let roots = listing.roots, roots.count > 1 {
                    Section("Roots") {
                        ForEach(roots, id: \.self) { root in Button(root) { Task { await model.open(root) } } }
                    }
                }
            }
            if let error = model.error { Banner(text: error, tone: .error) }
            ForEach(model.uploading, id: \.self) { name in Label("Uploading \(name)…", systemImage: "arrow.up.circle") }
        }
        .toolbar {
            ToolbarItemGroup {
                Toggle(isOn: $model.showHidden) { Image(systemName: "eye") }.accessibilityLabel("Show hidden files")
                Button { importing = true } label: { Image(systemName: "square.and.arrow.up") }.accessibilityLabel("Upload here")
                Button { newFolder = "" } label: { Image(systemName: "folder.badge.plus") }.accessibilityLabel("New folder")
            }
        }
        .task { await model.open(session.row?.dto.cwd) }
        .onChange(of: model.showHidden) { _, _ in Task { await model.reload() } }
        .refreshable { await model.reload() }
        .quickLookPreview($previewURL)
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

    private func open(_ entry: FsEntry) async {
        let path = model.child(entry)
        if entry.type == .dir {
            await model.open(path)
            return
        }
        guard let data = await model.data(path) else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(entry.name)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: [.completeFileProtection])
        previewURL = url
    }

    private func download(_ entry: FsEntry) async {
        await open(entry)
    }
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
