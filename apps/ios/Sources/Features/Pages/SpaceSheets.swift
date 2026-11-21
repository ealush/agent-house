import SwiftUI

// Spaces (docs/spec/17-spaces.md, SPC-6; `web/SpaceDialogs.tsx`, `web/SpacesSettings.tsx`):
// a new plain Space from the Inbox's title, a Space's settings (preferences and memory for
// a plain Space, and Remove, said before it's done), and Settings → Spaces to restore.

private func closeButton(_ scene: SceneModel) -> some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
}

/// New Space: a name, and optionally the preferences every agent in it reads. On the hub.
struct NewSpaceSheet: View {
    let scene: SceneModel
    @State private var name = ""
    @State private var preferences = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var nameFocused: Bool
    @Environment(\.theme) private var theme

    private var root: String { scene.hub.flatMap { hub in hub.hostname.flatMap { hub.spaces.list(host: $0)?.root } } ?? "~/spaces" }

    var body: some View {
        NavigationStack {
            Form {
                if let error { Banner(text: error, tone: .error).formBanner() }
                Section {
                    TextField("Trips", text: $name)
                        .focused($nameFocused)
                        .textInputAutocapitalization(.words)
                        .submitLabel(.done)
                        .accessibilityLabel("Name")
                        .accessibilityIdentifier("space-name")
                } header: {
                    Text("Name")
                } footer: {
                    Text("A place for conversations about one thing, with no repository behind it. Every agent you start in it reads the same preferences and keeps one shared memory. It’s a folder in \(root).")
                }
                Section {
                    TextEditor(text: $preferences)
                        .font(.ahMono(.callout))
                        .frame(minHeight: 120)
                        .accessibilityLabel("Preferences")
                        .accessibilityIdentifier("space-preferences")
                } header: {
                    Text("Preferences")
                } footer: {
                    Text("What it’s for and how agents should work here. Leave it empty for a starting text you can change later.")
                }
            }
            .navigationTitle("New Space")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                closeButton(scene)
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { Task { await create() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespaces).isEmpty)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("space-create")
                }
            }
            .onAppear { nameFocused = true }
        }
    }

    private func create() async {
        guard let hub = scene.hub, let host = hub.hostname else { return }
        busy = true
        defer { busy = false }
        do {
            let made = try await hub.api.createSpace(name.trimmingCharacters(in: .whitespaces), preferences: preferences)
            hub.spaces.reload(host: host, client: hub.api)
            scene.inboxProject = InboxProject(host: host, name: made.name)
            scene.sheet = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
    }
}

/// A Space's settings: what it is, its preferences and memory (a plain Space), and Remove.
struct SpaceSettingsSheet: View {
    let scene: SceneModel
    let project: InboxProject
    @State private var model: SpaceSettingsModel?
    @State private var opened: String?
    @State private var drafts: [String: String] = [:]
    @State private var newFile = ""
    @State private var asking: SpaceDTO?
    @State private var deleting: String?
    @Environment(\.theme) private var theme

    private var space: SpaceDTO? { scene.hub?.spaces.space(project) }

    var body: some View {
        NavigationStack {
            Group {
                if let space, let model {
                    content(space, model)
                } else {
                    EmptyState(symbol: "square.stack.3d.up.slash", title: "That Space Is Gone", message: "It was removed, or its host isn’t reachable.")
                }
            }
            .navigationTitle(project.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { closeButton(scene) }
        }
        .task(id: space?.kind) {
            guard let hub = scene.hub, let space else { return }
            if model?.kind != space.kind { model = SpaceSettingsModel(api: hub.client(host: project.host), name: project.name, kind: space.kind) }
            await model?.load()
        }
    }

    @ViewBuilder
    private func content(_ space: SpaceDTO, _ model: SpaceSettingsModel) -> some View {
        Form {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            Section {
                LabeledContent("Kind", value: space.kind.label)
                if let path = space.path { LabeledContent("Folder") { Text(path + (space.exists ? "" : " (gone)")).font(.ahMono(.callout)).foregroundStyle(theme.muted) } }
                if scene.hub?.multiHost == true { LabeledContent("Host", value: project.host) }
                LabeledContent("Sessions", value: SpaceWording.counts(space))
            }
            if model.plain {
                Section {
                    TextEditor(text: Binding(get: { model.preferences }, set: { model.preferences = $0 }))
                        .font(.ahMono(.callout))
                        .frame(minHeight: 160)
                        .accessibilityLabel("Preferences")
                        .accessibilityIdentifier("space-settings-preferences")
                    Button(model.justSaved ? "Saved" : "Save Preferences") { Task { await model.savePreferences() } }
                        .disabled(model.busy || !model.preferencesChanged)
                        .accessibilityIdentifier("space-save-preferences")
                } header: {
                    Text("Preferences")
                } footer: {
                    Text("AGENTS.md in the Space: every agent you start here reads it (Claude Code and Gemini through CLAUDE.md and GEMINI.md). A running agent picks up a change in its next conversation.")
                }
                Section {
                    if let files = model.memory {
                        ForEach(files) { file in memoryRow(file, model) }
                    } else if model.error == nil {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    HStack {
                        TextField("New file, like decisions", text: $newFile)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .accessibilityIdentifier("space-new-memory")
                            .onSubmit { addFile(model) }
                        Button("Add") { addFile(model) }.disabled(newFile.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                } header: {
                    Text("Memory")
                } footer: {
                    Text("What agents here keep for the next conversation, in memory/: they read MEMORY.md first.")
                }
            } else {
                Section {
                    Text(space.kind == .repo ? "Agents here read the repository’s own AGENTS.md and CLAUDE.md; Agent House doesn’t write into it." : "A folder sessions ran in. Its own files, if any, are what agents read.")
                        .foregroundStyle(theme.muted)
                }
            }
            Section {
                Button("Remove Space…", role: .destructive) { asking = space }
                    .disabled(space.live > 0 || model.busy)
                    .accessibilityIdentifier("space-remove")
            } footer: {
                Text(space.live > 0 ? "End its \(space.live == 1 ? "session" : "\(space.live) sessions") first." : SpaceWording.removal(kind: space.kind, conversations: space.conversations, path: space.path))
            }
        }
        .confirmingRemoval($asking, title: { "Remove \($0.name)?" }, message: SpaceWording.removal(kind: space.kind, conversations: space.conversations, path: space.path)) { _ in
            Task {
                guard await model.remove(), let hub = scene.hub else { return }
                hub.spaces.reload(host: project.host, client: hub.client(host: project.host))
                hub.refresh(host: project.host)
                scene.inboxProject = nil
                scene.sheet = nil
            }
        }
        .confirmingRemoval($deleting, title: { "Delete \($0)?" }, message: "Agents in this Space stop reading it. It can’t be undone.", verb: "Delete") { file in
            Task { await model.deleteMemory(file) }
        }
    }

    @ViewBuilder
    private func memoryRow(_ file: SpaceMemoryFileDTO, _ model: SpaceSettingsModel) -> some View {
        let open = opened == file.name
        Button {
            withAnimation(.snappy) { opened = open ? nil : file.name }
        } label: {
            HStack(alignment: .firstTextBaseline) {
                Text(file.name).font(.ahMono(.callout)).foregroundStyle(theme.text)
                Text(firstLine(file.text)).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.right").font(.ah(.caption)).foregroundStyle(theme.muted).rotationEffect(.degrees(open ? 90 : 0))
            }
        }
        .accessibilityIdentifier("space-memory-\(file.name)")
        .swipeActions {
            if file.name != "MEMORY.md" {
                Button { deleting = file.name } label: { Image(systemName: "trash") }.accessibilityLabel("Delete").tint(theme.swipe(\.danger))
            }
        }
        if open {
            if file.truncated == true { Text("Only the first 256 KB is shown; saving keeps only what’s here.").font(.ah(.caption)).foregroundStyle(theme.muted) }
            TextEditor(text: Binding(get: { drafts[file.name] ?? file.text }, set: { drafts[file.name] = $0 }))
                .font(.ahMono(.callout))
                .frame(minHeight: 140)
                .accessibilityLabel(file.name)
            HStack {
                if file.name != "MEMORY.md" { Button("Delete", role: .destructive) { deleting = file.name }.buttonStyle(.borderless) }
                Spacer()
                Button("Save") {
                    Task { if await model.saveMemory(file.name, text: drafts[file.name] ?? file.text) { drafts[file.name] = nil } }
                }
                .buttonStyle(.borderless)
                .disabled(drafts[file.name] == nil || drafts[file.name] == file.text)
            }
        }
    }

    private func addFile(_ model: SpaceSettingsModel) {
        let typed = newFile
        Task {
            if let made = await model.addMemory(typed) {
                newFile = ""
                opened = made
            }
        }
    }

    private func firstLine(_ text: String) -> String {
        text.split(separator: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.map { $0.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression) } ?? "Empty"
    }
}

/// Settings → Spaces: the Spaces folder, the plain Spaces, and removed ones to restore.
struct SpacesSection: View {
    @State var model: SpacesSettings
    @Environment(\.theme) private var theme

    var body: some View {
        AhForm {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            if let list = model.list {
                Section {
                    if model.plain.isEmpty {
                        Text("No plain Spaces yet. Make one from the Inbox’s title.").foregroundStyle(theme.muted)
                    } else {
                        ForEach(model.plain) { s in
                            LabeledContent(s.name, value: s.conversations == 1 ? "1 conversation" : "\(s.conversations) conversations")
                        }
                    }
                } header: {
                    Text("Spaces")
                } footer: {
                    Text("A Space is where sessions belong: a repository, a folder, or a plain Space whose agents share its preferences and memory. Plain Spaces are folders in \(list.root) (spaces.root in the host’s config).")
                }
                Section {
                    if list.removed.isEmpty {
                        Text("Nothing removed.").foregroundStyle(theme.muted)
                    } else {
                        ForEach(list.removed) { r in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(r.name)
                                    Text("\(r.kind.label) · \(r.conversations == 1 ? "1 conversation" : "\(r.conversations) conversations")\(r.path.map { " · \($0)" } ?? "")")
                                        .font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                                }
                                Spacer()
                                Button(model.restoring.contains(r.name) ? "Restoring…" : "Restore") { Task { await model.restore(r.name) } }
                                    .buttonStyle(.borderless)
                                    .disabled(model.restoring.contains(r.name))
                                    .accessibilityIdentifier("space-restore-\(r.name)")
                            }
                        }
                    }
                } header: {
                    Text("Removed")
                } footer: {
                    Text("Their conversations are only hidden, and a plain Space’s folder waits in the archive: Restore puts both back.")
                }
            } else if model.error != nil {
                Button("Try Again", systemImage: "arrow.clockwise") { Task { await model.load() } }
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .task { await model.load() }
    }
}
