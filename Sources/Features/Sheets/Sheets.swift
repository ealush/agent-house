import SwiftUI
import UIKit

/// Every sheet a window presents, by `SceneModel.sheet`. The UIKit root presents this in one
/// `UIHostingController` so sheets survive pane changes and rotate with the window.
struct SceneSheet: View {
    let sheet: SceneModel.Sheet
    @Bindable var scene: SceneModel

    var body: some View {
        switch sheet {
        case .setup: SetupView(app: scene.app) { session in scene.useAccount(session.origin); scene.sheet = nil }
        case .newSession(let context): NewSessionSheet(scene: scene, context: context)
        case .fork(let key): sessionSheet(key) { ForkSheet(scene: scene, session: $0) }
        case .forks(let key): sessionSheet(key) { ForksSheet(scene: scene, session: $0) }
        case .sendTo(let key): sessionSheet(key) { SendToSheet(scene: scene, session: $0) }
        case .continueIn(let key, let preset): sessionSheet(key) { ContinueSheet(scene: scene, session: $0, preset: preset) }
        case .lineage(let key): sessionSheet(key) { LineageSheet(scene: scene, session: $0) }
        case .branch(let key): sessionSheet(key) { BranchSheet(scene: scene, session: $0) }
        case .worktrees: if let hub = scene.hub { WorktreesView(model: WorktreesModel(api: hub.api), scene: scene) }
        case .settings(let section): SettingsView(scene: scene, section: section.flatMap(SettingsSection.init(rawValue:)))
        // Asked as system alerts (`SceneRootController.terminateAlert`, `planAlert`); a sheet
        // only when the session went while it was being asked.
        case .confirmTerminate(let key), .confirmPlan(let key, _): sessionSheet(key) { _ in EmptyView() }
        case .scrollback(_, let text): ScrollbackSheet(text: text)
        case .modelPicker(let key): sessionSheet(key) { LaunchPickerSheet(scene: scene, session: $0, setting: .model) }
        case .effortPicker(let key): sessionSheet(key) { LaunchPickerSheet(scene: scene, session: $0, setting: .effort) }
        case .sessionMenu(let key): sessionSheet(key) { SessionMenuSheet(scene: scene, session: $0) }
        case .draft(let key): sessionSheet(key) { DraftSheet(scene: scene, session: $0) }
        case .noteSend(let id, let insert): NoteSendSheet(scene: scene, id: id, insert: insert)
        case .noteSaveFile(let id): NoteSaveFileSheet(scene: scene, id: id)
        case .noteProject(let id): NoteProjectSheet(scene: scene, id: id)
        case .noteCompare(let id): NoteCompareSheet(scene: scene, id: id)
        // Asked as a system alert (`SceneRootController.noteDeleteAlert`); this only when it went meanwhile.
        case .noteDelete: EmptyState(symbol: "note.text", title: "That Note Is Gone", message: "It was deleted while this was opening.")
        case .subagents(let key): sessionSheet(key) { SubagentsSheet(session: $0, scene: scene) }
        }
    }

    @ViewBuilder
    private func sessionSheet<Content: View>(_ key: String, @ViewBuilder _ content: (SessionModel) -> Content) -> some View {
        if let session = scene.session(key) {
            content(session)
        } else {
            NavigationStack {
                EmptyState(symbol: "questionmark.square.dashed", title: "That Session Is Gone", message: "It ended or moved while this was opening.")
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) } }
            }
        }
    }
}

// MARK: New session

struct NewSessionSheet: View {
    let scene: SceneModel
    let context: SceneModel.NewSessionContext
    @Environment(\.theme) private var theme
    @State private var host: String?
    @State private var presetID = ""
    @State private var cwd = ""
    @State private var dirState: DirState?
    @State private var gitInit = true
    @State private var worktree = false
    @State private var resume = false
    @State private var mode = "default"
    @State private var model: String?
    @State private var effort: String?
    /// The effort picked with each model while this sheet is open, by "preset|model".
    @State private var picked: [String: String] = [:]
    /// "Skip startup confirmations": the host answers the agent's folder-trust prompt.
    @State private var trust = false
    @State private var label = ""
    /// "Other model version", for agents that take any model id.
    @State private var customModel = ""
    /// The tmux session it goes into; `newTmux` names a new one.
    @State private var tmuxSession: String?
    @State private var newTmux = ""
    @State private var extraArgs = ""
    @State private var prompt = ""
    @State private var projects: [String] = []
    @State private var busy = false
    @State private var error: String?
    /// Where new projects go on this host (the folder field's "New folder" starts there).
    @State private var root: String?
    @State private var browsing = false
    @FocusState private var promptFocused: Bool
    @FocusState private var folderFocused: Bool
    /// The folder as text to edit; otherwise it reads as a path with its folder picked out.
    @State private var editingFolder = false

    private var hub: HubStore? { scene.hub }
    private var presets: [PresetDTO] {
        let all = hub?.presets(host: host).filter(\.offered) ?? []
        let recent = scene.app.preferences.recentAgents
        return all.sorted { a, b in (recent.firstIndex(of: a.id) ?? 99, a.isShell ? 1 : 0) < (recent.firstIndex(of: b.id) ?? 99, b.isShell ? 1 : 0) }
    }
    private var preset: PresetDTO? { presets.first { $0.id == presetID } }

    var body: some View {
        NavigationStack {
            AhForm {
                if let error { Banner(text: error, tone: .error) }
                if let hub, hub.multiHost {
                    Picker("Host", selection: $host) {
                        ForEach(hub.hosts, id: \.name) { h in
                            Text(h.name + (h.online ? "" : " (offline)")).tag(h.isSelf ? String?.none : Optional(h.name))
                        }
                    }
                    .onChange(of: host) { _, next in
                        // Each host has its own tmux sessions.
                        let tmux = LaunchState.tmuxChoices(sessions: hub.state(host: next)?.sessions ?? [], defaultSession: hub.state(host: next)?.defaultSession ?? "")
                        tmuxSession = tmux.initial
                        newTmux = tmux.initial == nil ? (hub.state(host: next)?.defaultSession ?? "") : ""
                        // And its own projects: the last host's chips filled in its paths.
                        projects = []
                        Task {
                            let listed = (try? await hub.client(host: next).projects()) ?? []
                            if host == next { projects = listed }
                        }
                    }
                }
                Section("Agent") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(presets, id: \.id) { p in
                                Button {
                                    presetID = p.id
                                    applyDefaults(p)
                                } label: {
                                    HStack(spacing: 6) {
                                        AgentMark(agent: p.isShell ? nil : p.id, size: 20)
                                        Text(p.name)
                                    }
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(presetID == p.id ? theme.accentStrong.opacity(0.2) : theme.raised, in: Capsule())
                                    .overlay(Capsule().stroke(presetID == p.id ? theme.accentStrong : .clear))
                                }
                                .buttonStyle(.plain)
                                .hoverEffect(.highlight)
                                .accessibilityAddTraits(presetID == p.id ? .isSelected : [])
                            }
                        }
                    }
                }
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: dirState == .new ? "folder.badge.plus" : "folder").foregroundStyle(theme.accent)
                        if editingFolder || cwd.isEmpty {
                            TextField("~/code/project", text: $cwd)
                                .font(.ahMono(.body))
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .focused($folderFocused)
                                .onSubmit { Task { await checkDir() } }
                                .onChange(of: folderFocused) { _, focused in if !focused { editingFolder = false } }
                        } else {
                            Button(action: editFolder) { PathLabel(path: cwd) }
                                .buttonStyle(.plain)
                                .hoverEffect(.highlight)
                                .accessibilityLabel("Folder \(cwd)")
                                .accessibilityHint("Edit the path")
                        }
                        Button {
                            browsing = true
                        } label: {
                            // A folder to browse, not "more".
                            Image(systemName: "folder")
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Browse folders on the host")
                    }
                    if !projects.isEmpty || root != nil {
                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 6) {
                                ForEach(projects.prefix(6), id: \.self) { path in
                                    projectChip((path as NSString).lastPathComponent, systemImage: "folder", on: cwd == path) { cwd = path }
                                        .help(path)
                                }
                                if let root {
                                    projectChip("New Folder", systemImage: "plus", on: dirState == .new) {
                                        cwd = root.hasSuffix("/") ? root : root + "/"
                                        editFolder()
                                    }
                                }
                            }
                            .padding(.vertical, 2)
                        }
                    }
                    if let problem = dirProblem {
                        Label(problem, systemImage: "exclamationmark.triangle.fill").font(.ah(.caption)).foregroundStyle(theme.danger)
                    } else if dirState == .new {
                        let folder = cwd.trimmingCharacters(in: .whitespaces)
                        Label {
                            Text("Creates **\((folder as NSString).lastPathComponent)** in \((folder as NSString).deletingLastPathComponent)")
                        } icon: {
                            Image(systemName: "sparkles")
                        }
                        .font(.ah(.callout))
                        Toggle("Initialize a git repository", isOn: $gitInit)
                    } else if preset?.isShell == false {
                        Toggle(isOn: $worktree) {
                            Label {
                                Text("Its own worktree")
                                Text("A new branch in a checkout of its own, so it never collides with other agents here.")
                            } icon: {
                                Image(systemName: "square.on.square.dashed")
                            }
                        }
                    }
                } header: {
                    Text("Where")
                }
                if let preset, !preset.isShell, LaunchOptionRows.offersChoices(preset) || preset.trust != nil {
                    Section("How") {
                        if LaunchOptionRows.offersChoices(preset) {
                            LaunchOptionRows(preset: preset, mode: $mode, model: $model, customModel: $customModel, effort: $effort)
                        }
                        if preset.trust != nil {
                            Toggle(isOn: $trust) {
                                Label {
                                    Text("Skip startup confirmations")
                                    Text("When \(preset.name) asks whether to trust a new folder, Agent House says yes for you.")
                                } icon: {
                                    Image(systemName: "checkmark.shield")
                                }
                            }
                        }
                    }
                }
                Section {
                    TextField(preset?.isShell == true ? "First command (optional)" : "First message (optional)", text: $prompt, axis: .vertical)
                        .lineLimit(2...8)
                        .focused($promptFocused)
                    if let file = context.attachment, preset?.isShell != true {
                        Label("\(file.name) attached", systemImage: "doc.text").font(.ah(.callout)).foregroundStyle(theme.muted)
                    }
                }
                Section("More") {
                    TextField("Name (optional)", text: $label)
                    Picker("tmux session", selection: $tmuxSession) {
                        ForEach(hub?.state(host: host)?.sessions ?? [], id: \.self) { Text($0).tag(Optional($0)) }
                        Text("New…").tag(String?.none)
                    }
                    if tmuxSession == nil {
                        TextField("New tmux session name", text: $newTmux).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    if preset?.resume != nil { Toggle("Resume its last conversation here", isOn: $resume) }
                    TextField("Extra arguments", text: $extraArgs).font(.ahMono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            .navigationTitle(context.project ? "New Project" : "New Session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Starting…" : "Start") { Task { await start() } }
                        .disabled(busy || preset == nil || cwd.trimmingCharacters(in: .whitespaces).isEmpty || dirProblem != nil || (tmuxSession == nil && newTmux.trimmingCharacters(in: .whitespaces).isEmpty))
                        .keyboardShortcut(.return, modifiers: .command)
                        .buttonStyle(.glassProminent)
                }
            }
            // Each model brings its own effort: the one picked with it here, else the one it
            // last started with.
            .onChange(of: model) { _, next in
                guard let preset else { return }
                var chosen = scene.app.preferences.launchMemory[preset.id]?.effortsByModel ?? [:]
                if let here = picked["\(preset.id)|\(next ?? "default")"] { chosen[next ?? "default"] = here }
                effort = LaunchState.effort(for: next, preset: preset, chosen: chosen, current: effort)
            }
            .onChange(of: effort) { _, next in picked["\(presetID)|\(model ?? "default")"] = next ?? "default" }
            .task(id: "\(host ?? "")|\(cwd)") {
                // Say what the folder is while it's typed (after a pause), not only on Start.
                try? await Task.sleep(for: .milliseconds(cwd.isEmpty ? 0 : 300))
                guard !Task.isCancelled, !cwd.trimmingCharacters(in: .whitespaces).isEmpty else { return }
                await checkDir()
            }
            .sheet(isPresented: $browsing) {
                if let hub {
                    FolderPicker(api: hub.client(host: host), start: cwd.isEmpty ? nil : cwd) { picked in cwd = picked }
                }
            }
            .task {
                host = context.host
                cwd = context.cwd ?? (context.project ? "" : (LaunchState.newestProject(hub?.rows.filter { $0.isLocal == (context.host == nil) } ?? []) ?? "~"))
                let tmux = LaunchState.tmuxChoices(sessions: hub?.state(host: host)?.sessions ?? [], defaultSession: hub?.state(host: host)?.defaultSession ?? "")
                tmuxSession = tmux.initial
                if tmux.initial == nil { newTmux = hub?.state(host: host)?.defaultSession ?? "" }
                if let first = context.preset.flatMap({ id in presets.first { $0.id == id } }) ?? presets.first {
                    presetID = first.id
                    applyDefaults(first)
                }
                if let p = context.prompt { prompt = p }
                if let name = context.label, label.isEmpty { label = name }
                projects = (try? await hub?.client(host: host).projects()) ?? []
            }
        }
    }

    private var dirProblem: String? {
        switch dirState {
        case .file: return "That’s a file, not a folder."
        case .missing: return "No such folder. A new one goes inside a folder that exists."
        case .outside: return "Agent House creates folders only inside the browsable folders (files.roots in the config)."
        default: return nil
        }
    }

    /// Each agent comes back as it was last started from here (a dangerous mode never does).
    private func applyDefaults(_ p: PresetDTO) {
        let last = LaunchState.remembered(scene.app.preferences.launchMemory[p.id], preset: p)
        mode = last.mode
        let listed = last.model.map { id in (p.models ?? []).contains { $0.id == id } } ?? true
        model = listed ? last.model : p.defaultModel
        customModel = listed ? "" : (last.model ?? "")
        effort = last.effort
        trust = p.trust != nil && scene.app.preferences.launchMemory[p.id]?.trust == true
        resume = false
    }

    private func editFolder() {
        editingFolder = true
        // The field appears in this update; focus it once it's there.
        DispatchQueue.main.async { folderFocused = true }
    }

    private func checkDir() async {
        guard let hub else { return }
        let status = try? await hub.client(host: host).dir(cwd.trimmingCharacters(in: .whitespaces))
        dirState = status?.state
        if let status { root = status.root }
    }

    private func projectChip(_ title: String, systemImage: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.ah(.callout))
                .lineLimit(1)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(on ? theme.accentStrong.opacity(0.18) : theme.raised, in: Capsule())
                .overlay(Capsule().stroke(on ? theme.accentStrong : .clear))
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private func start() async {
        guard let hub, let preset else { return }
        busy = true
        defer { busy = false }
        if dirState == nil {
            await checkDir()
            // A path that means a new folder says so before anything is created.
            if dirState == .new || dirProblem != nil { return }
        }
        let create = dirState == .new
        let chosenModel = LaunchState.chosenModel(listed: model, typed: customModel, preset: preset)
        let chosenEffort = effort != nil && (effort != preset.defaultEffort || chosenModel != nil) ? effort : nil
        let request = NewSessionRequest(
            preset: preset.id, cwd: cwd.trimmingCharacters(in: .whitespaces), session: tmuxSession ?? newTmux.trimmingCharacters(in: .whitespaces), label: label,
            resume: resume && preset.resume != nil, worktree: worktree && !create, create: create ? true : nil, git: create ? gitInit : nil,
            mode: mode == "default" ? nil : mode, model: chosenModel, effort: chosenEffort,
            extraArgs: extraArgs.trimmingCharacters(in: .whitespaces).isEmpty ? nil : extraArgs.trimmingCharacters(in: .whitespaces),
            trust: preset.trust != nil && trust ? true : nil)
        // A note attached: uploaded to the host it starts on, its path leading the first
        // message, as the box sends a file (`ComposerModel.submit`).
        var first = prompt
        if let file = context.attachment, preset.isShell == false {
            do {
                let path = try await hub.client(host: host).upload(name: file.name, data: file.data)
                first = ([Uploads.shellQuote(path)] + (prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [prompt])).joined(separator: " ")
            } catch {
                scene.toast("Couldn’t attach \(file.name): \(APIError.wrap(error).message)", error: true)
                return
            }
        }
        if await scene.start(request, host: host, prompt: first, intoPane: context.intoPane) != nil {
            if !preset.isShell {
                scene.app.preferences.launchMemory[preset.id] = LaunchState.remembering(
                    scene.app.preferences.launchMemory[preset.id], mode: mode, model: chosenModel ?? model, effort: effort, trust: preset.trust != nil ? trust : nil)
            }
            scene.sheet = nil
        }
    }
}

// MARK: Folder picker

/// A path with its last folder picked out: the parents fade and give way first.
private struct PathLabel: View {
    let path: String
    @Environment(\.theme) private var theme

    var body: some View {
        let trimmed = path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
        let name = (trimmed as NSString).lastPathComponent
        let parent = (trimmed as NSString).deletingLastPathComponent
        // The parents give way a whole folder at a time ("…/files/"), never mid-word
        // ("…ate/tmp/"): the longest that fits beside the name.
        let folders = parent.split(separator: "/").map(String.init)
        let tails = folders.indices.map { start in "…/" + folders[start...].joined(separator: "/") + "/" }.dropFirst()
        ViewThatFits(in: .horizontal) {
            row(parent.isEmpty ? nil : parent == "/" ? "/" : parent + "/", name)
            ForEach(Array(tails), id: \.self) { tail in row(tail, name) }
            row(parent.isEmpty ? nil : "…/", name)
        }
        .contentShape(Rectangle())
    }

    private func row(_ parent: String?, _ name: String) -> some View {
        HStack(spacing: 0) {
            if let parent { Text(parent).foregroundStyle(theme.muted).lineLimit(1).fixedSize() }
            Text(name).fontWeight(.semibold).foregroundStyle(theme.text).lineLimit(1)
            Spacer(minLength: 0)
        }
    }
}

/// The host's folders, one level at a time, to pick where something starts.
struct FolderPicker: View {
    let api: APIClient
    let start: String?
    let pick: (String) -> Void
    @State private var model: FilesModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    init(api: APIClient, start: String?, pick: @escaping (String) -> Void) {
        self.api = api
        self.start = start
        self.pick = pick
        _model = State(initialValue: FilesModel(api: api))
    }

    var body: some View {
        NavigationStack {
            List {
                if let listing = model.listing {
                    if let parent = listing.parent {
                        Button { Task { await model.open(parent) } } label: {
                            Label((parent as NSString).lastPathComponent.isEmpty ? "/" : (parent as NSString).lastPathComponent, systemImage: "arrow.turn.left.up")
                        }
                    }
                    ForEach(listing.entries.filter { $0.type == .dir }, id: \.name) { entry in
                        Button { Task { await model.open(model.child(entry)) } } label: {
                            HStack {
                                Label {
                                    Text(entry.name).foregroundStyle(theme.text)
                                } icon: {
                                    Image(systemName: "folder.fill").foregroundStyle(theme.accent)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.faint)
                            }
                        }
                    }
                    if !listing.entries.contains(where: { $0.type == .dir }) {
                        Text("No folders inside.").foregroundStyle(theme.muted)
                    }
                } else if let error = model.error {
                    Banner(text: error, tone: .error)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(model.listing.map { ($0.path as NSString).lastPathComponent } ?? "Folders")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Choose") {
                        if let path = model.listing?.path { pick(path) }
                        dismiss()
                    }.keyboardShortcut(.return, modifiers: .command)
                    .disabled(model.listing == nil)
                        .buttonStyle(.glassProminent)
                }
            }
            .task {
                await model.open(start)
                if model.listing == nil { await model.open(nil) }
            }
        }
    }
}

// MARK: Forks

/// A session's fork family: the conversation they grew from and every line forked from it,
/// with how far each has gone, to open one or put two side by side.
struct ForksSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @State private var changed: [String: Int] = [:]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    private var lines: [ForkFamily.Line] {
        guard let row = session.row else { return [] }
        return ForkFamily.lines(of: row, rows: session.hub.rows, history: session.hub.history)
    }

    var body: some View {
        NavigationStack {
            List {
                if lines.isEmpty {
                    ContentUnavailableView("No Forks", systemImage: "arrow.branch", description: Text("Fork this session to try another approach on its own branch."))
                }
                ForEach(lines) { line in
                    HStack(spacing: 12) {
                        Image(systemName: line.isRoot ? "circle.circle" : "arrow.branch")
                            .foregroundStyle(line.isCurrent ? theme.accent : theme.muted)
                            .frame(width: 22)
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(line.title).font(.ah(.body).weight(line.isCurrent ? .semibold : .regular)).lineLimit(1)
                                if line.isCurrent { Text("this one").font(.ah(.caption2).weight(.semibold)).foregroundStyle(theme.accent) }
                            }
                            Text(detail(line)).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if let word = line.word { StatusPill(word: word, compact: true) }
                        if let key = line.key, !line.isCurrent {
                            Menu {
                                Button("Open", systemImage: "arrow.right.circle") { open(key) }
                                if !scene.narrow { Button("Open Beside This One", systemImage: "rectangle.split.2x1") { beside(key) } }
                            } label: {
                                Text("Open").font(.ah(.callout).weight(.semibold))
                            } primaryAction: {
                                open(key)
                            }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .controlSize(.small)
                        } else if line.key == nil {
                            Text("ended").font(.ah(.caption)).foregroundStyle(theme.faint)
                        }
                    }
                    .padding(.vertical, 3)
                    .ahRow()
                }
            }
            .ahFormGround()
            .navigationTitle("Forks")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss(); scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .primaryAction) {
                    if session.isLive { Button("Fork…", systemImage: "arrow.branch") { scene.sheet = .fork(session.key) } }
                }
            }
            .task { await loadChanges() }
        }
    }

    private func detail(_ line: ForkFamily.Line) -> String {
        var parts: [String] = []
        if line.isRoot { parts.append("where it started") }
        if let branch = line.branch { parts.append(branch) }
        if let count = changed[line.uid] { parts.append(count == 0 ? "no changes" : "\(count) file\(count == 1 ? "" : "s") changed") }
        return parts.joined(separator: " · ")
    }

    /// Each line's uncommitted files, as they come in: all asked at once (one after another,
    /// a family of five waited out five round trips for its last count).
    private func loadChanges() async {
        let hub = session.hub
        var counts: [(uid: String, count: Task<Int?, Never>)] = []
        for line in lines {
            guard let key = line.key else { continue }
            let uid = line.uid
            counts.append((uid, Task { @MainActor () -> Int? in
                guard let changes = try? await hub.client(forKey: key).changes(uid) else { return nil }
                return changes.files.count
            }))
        }
        for (uid, count) in counts {
            if let count = await count.value { changed[uid] = count }
        }
    }

    private func open(_ key: String) {
        scene.sheet = nil
        scene.open(key)
    }

    private func beside(_ key: String) {
        scene.sheet = nil
        scene.run(.openAsPane(key))
    }
}

// MARK: Fork

struct ForkSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @State private var info: ForkInfo?
    /// Why the fork couldn't be prepared, when it couldn't.
    @State private var unready: String?
    @State private var name = ""
    @State private var prompt = ""
    @State private var busy = false
    @State private var mode = "default"
    @State private var model: String?
    @State private var customModel = ""
    @State private var effort: String?
    @Environment(\.theme) private var theme

    private var preset: PresetDTO? { session.row.flatMap { session.hub.preset(for: $0) } }

    var body: some View {
        NavigationStack {
            AhForm {
                if let info {
                    if !info.canFork {
                        Banner(text: info.reason ?? "This session can’t be forked.", tone: .error)
                    } else {
                        Section {
                            TextField("Name", text: $name)
                            TextField("First message for the fork (optional)", text: $prompt, axis: .vertical).lineLimit(2...6)
                        } footer: {
                            // The agent's name ("Claude Code"), not its id ("claude").
                            Text("A new \(preset?.name ?? info.harness) session with this conversation, in its own worktree off \(info.branch ?? "the current branch")\(info.head.map { " at \($0.prefix(7))" } ?? "").")
                        }
                        if let preset, !preset.isShell, LaunchOptionRows.offersChoices(preset) {
                            Section {
                                LaunchOptionRows(preset: preset, mode: $mode, model: $model, customModel: $customModel, effort: $effort)
                            } header: {
                                Text("How it runs")
                            } footer: {
                                Text("As the original does, unless you change it here.")
                            }
                        }
                        if info.dirty > 0 { Label("\(info.dirty) uncommitted change\(info.dirty == 1 ? "" : "s") stay here; the fork starts from the last commit.", systemImage: "exclamationmark.triangle").foregroundStyle(theme.limited) }
                        if info.busy { Label("It’s mid-turn: the fork gets the conversation up to now.", systemImage: "clock").foregroundStyle(theme.muted) }
                        if info.dangerous { Label("It runs with permission checks off, like this one.", systemImage: "exclamationmark.shield").foregroundStyle(theme.danger) }
                    }
                } else if let unready {
                    Banner(text: unready, tone: .error)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Fork “\(session.title)”")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Forking…" : "Fork") {
                        busy = true
                        Task {
                            let picked = preset.map { LaunchState.chosenModel(listed: model, typed: customModel, preset: $0) ?? model } ?? model
                            let request = LaunchState.forkRequest(name: name, prompt: prompt, mode: mode, modes: preset?.modes?.count ?? 0, inherited: (info?.model, info?.effort), picked: (picked, effort))
                            if let result = await session.fork(request) {
                                let host = SessionKey(session.key)?.host
                                scene.sheet = nil
                                scene.open(host.map { "\($0)/\(result.uid)" } ?? result.uid)
                                scene.toast("Forked onto \(result.branch)")
                            } else if let failure = session.notices.last, failure.tone == .error {
                                // Said here: the session's own notices show only on its screen.
                                scene.toast(failure.text, error: true)
                            }
                            busy = false
                        }
                    }.keyboardShortcut(.return, modifiers: .command)
                    .disabled(busy || info?.canFork != true)
                        .buttonStyle(.glassProminent)
                }
            }
            .task {
                info = await session.forkInfo()
                // Couldn't ask (offline, an old record): said, not a spinner that never stops.
                if info == nil { unready = session.notices.last?.text ?? "Couldn’t prepare the fork." }
                name = info?.suggestedName ?? ""
                mode = info?.mode ?? "default"
                model = info?.model
                effort = info?.effort
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: Launch options

/// How an agent runs: permission mode, model (listed or typed) and reasoning effort, as the
/// agent offers them. New session and Fork both use it.
struct LaunchOptionRows: View {
    let preset: PresetDTO
    @Binding var mode: String
    @Binding var model: String?
    @Binding var customModel: String
    @Binding var effort: String?
    @Environment(\.theme) private var theme

    /// Whether the agent offers anything to choose (a section with nothing in it is noise).
    static func offersChoices(_ preset: PresetDTO) -> Bool {
        (preset.modes?.count ?? 0) > 1 || !(preset.models ?? []).isEmpty || LaunchState.takesCustomModel(preset) || preset.effort != nil
    }

    var body: some View {
        if let modes = preset.modes, modes.count > 1 {
            Picker(selection: $mode) {
                Text("Default").tag("default")
                ForEach(modes, id: \.id) { m in
                    if m.dangerous == true {
                        Label(m.name, systemImage: "exclamationmark.shield").tag(m.id)
                    } else {
                        Text(m.name).tag(m.id)
                    }
                }
            } label: {
                Label("Permissions", systemImage: "lock.shield")
            }
            if let chosen = modes.first(where: { $0.id == mode }), chosen.dangerous == true {
                Label(chosen.description ?? "Runs without asking before it acts.", systemImage: "exclamationmark.triangle.fill")
                    .font(.ah(.caption))
                    .foregroundStyle(theme.danger)
            }
        }
        if let models = preset.models, !models.isEmpty {
            Picker(selection: $model) {
                Text("Default\(preset.defaultModel.map { " · \($0)" } ?? "")").tag(String?.none)
                ForEach(models, id: \.id) { m in Text(m.name).tag(Optional(m.id)) }
            } label: {
                Label("Model", systemImage: "cpu")
            }
            .disabled(LaunchState.chosenModel(listed: nil, typed: customModel, preset: preset) != nil)
        }
        if LaunchState.takesCustomModel(preset) {
            TextField("Other model version (optional)", text: $customModel)
                .font(.ahMono(.body))
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            if !customModel.trimmingCharacters(in: .whitespaces).isEmpty && !LaunchState.isValidModelID(customModel.trimmingCharacters(in: .whitespaces)) {
                Text("A model id is letters, digits and . _ : / @ -, starting with a letter or digit.").font(.ah(.caption)).foregroundStyle(theme.danger)
            }
        }
        let levels = LaunchState.levels(preset, model: model)
        if !levels.isEmpty {
            Picker(selection: $effort) {
                Text("Default\(preset.defaultEffort.map { " · \($0)" } ?? "")").tag(String?.none)
                ForEach(levels, id: \.self) { Text($0.capitalized).tag(Optional($0)) }
            } label: {
                Label("Effort", systemImage: "gauge.with.dots.needle.33percent")
            }
        }
    }
}

// MARK: Send to / Continue in

struct SendToSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @State private var text = ""
    @State private var loading = true
    @State private var subscriptions: [Subscription] = []
    @State private var subscription: String?
    @State private var target: String?
    @State private var busy = false
    @State private var error: String?
    @Environment(\.theme) private var theme

    private var others: [SessionRow] { (scene.hub?.rows ?? []).filter { $0.key != session.key } }
    /// Never a shell by default: a reply's lines would run as commands.
    private var preferred: SessionRow? {
        let agents = others.filter { $0.dto.agent != nil }
        return agents.first { $0.host == session.row?.host && $0.dto.project == session.row?.dto.project } ?? agents.first
    }

    var body: some View {
        NavigationStack {
            AhForm {
                if let error { Banner(text: error, tone: .error) }
                Section {
                    Picker("To", selection: $target) {
                        ForEach(others, id: \.key) { row in
                            Text("\(row.title)\(row.dto.agent == nil ? " (shell)" : "")\(scene.hub?.multiHost == true ? " · \(row.host)" : "")").tag(Optional(row.key))
                        }
                        Text("A new session").tag(String?.none)
                    }
                    if !subscriptions.isEmpty {
                        Picker("Summary by", selection: $subscription) {
                            Text("No summary").tag(String?.none)
                            ForEach(subscriptions) { s in Text(s.name).tag(Optional(s.id)) }
                        }
                        .onChange(of: subscription) { _, _ in Task { await draft() } }
                    } else if !loading {
                        Text("No chat subscription yet, so there’s no summary. Add one under Settings → Subscriptions.").font(.ah(.caption)).foregroundStyle(theme.muted)
                    }
                } footer: {
                    Text("A summary of this session, then its latest reply. A busy session queues it until the agent is free.")
                }
                Section {
                    if loading { ProgressView("Reading the session…") }
                    TextEditor(text: $text).frame(minHeight: 220).font(.ah(.callout))
                }
            }
            // An ellipsis is for the menu item that opens this, not the title of what it opened.
            .navigationTitle("Send To")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Sending…" : "Send") { Task { await send() } }.keyboardShortcut(.return, modifiers: .command)
                        .disabled(busy || loading || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .buttonStyle(.glassProminent)
                }
            }
            .task {
                target = preferred?.key
                subscriptions = (try? await session.api.subscriptions()) ?? []
                subscription = (subscriptions.first { $0.isDefault } ?? subscriptions.first)?.id
                await draft()
            }
        }
    }

    private func draft() async {
        loading = true
        text = await session.handoff(summarize: subscription != nil, subscription: subscription) ?? text
        loading = false
    }

    private func send() async {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let hub = scene.hub else { return }
        guard let target, let row = hub.row(target) else {
            scene.sheet = nil
            scene.beginNewSession(SceneModel.NewSessionContext(cwd: session.row?.dto.projectPath, host: session.row.flatMap { $0.isLocal ? nil : $0.host }, prompt: body))
            return
        }
        busy = true
        do {
            let result = try await hub.client(forKey: target).send(row.dto.uid, text: body)
            scene.toast(result.outcome == .queued ? "Queued for “\(row.title)”" : "Sent to “\(row.title)”")
            scene.sheet = nil
        } catch {
            self.error = APIError.wrap(error).message
        }
        busy = false
    }
}

// MARK: Branch

struct BranchSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @State private var model: DiffModel
    @State private var query = ""
    @Environment(\.theme) private var theme

    init(scene: SceneModel, session: SessionModel) {
        self.scene = scene
        self.session = session
        _model = State(initialValue: DiffModel(api: session.api, uid: session.ref))
    }

    @State private var held: BranchList.Branch?
    @FocusState private var searching: Bool

    /// Current first, then by name, filtered by what's typed.
    private func rows(_ list: BranchList) -> [BranchList.Branch] {
        list.branches
            .filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
            .sorted { $0.current != $1.current ? $0.current : $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private var created: String? {
        let name = query.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty, model.branches?.branches.contains(where: { $0.name == name }) == false else { return nil }
        return name
    }

    var body: some View {
        NavigationStack {
            List {
                Group {
                if let error = model.error { Banner(text: error, tone: .error) }
                if let branches = model.branches {
                    let rows = rows(branches)
                    if let number = model.pull?.number, let link = model.pull?.url.flatMap(URL.init(string:)) {
                        Link(destination: link) {
                            Label("Pull request #\(number)", systemImage: "arrow.triangle.pull")
                        }
                    }
                    if let created {
                        Button { switchTo(created) } label: {
                            Label("Create “\(created)”", systemImage: "plus.circle.fill")
                        }
                    }
                    Section {
                        ForEach(rows, id: \.name) { b in
                            Button {
                                if b.current { return }
                                if b.worktree != nil { held = b } else { switchTo(b.name) }
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: b.remote ? "cloud" : "arrow.triangle.branch")
                                        .foregroundStyle(b.current ? theme.accent : theme.muted)
                                        .frame(width: 20)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(b.name).font(.ahMono(.callout)).foregroundStyle(b.worktree != nil && !b.current ? theme.muted : theme.text)
                                        if b.current, branches.dirty > 0 {
                                            Text("\(branches.dirty) uncommitted change\(branches.dirty == 1 ? "" : "s")").font(.ah(.caption)).foregroundStyle(theme.limited)
                                        } else if let tree = b.worktree, !b.current {
                                            Text("Checked out in \((tree as NSString).lastPathComponent)").font(.ah(.caption)).foregroundStyle(theme.faint)
                                        } else if b.remote {
                                            Text("Remote · checks out with tracking").font(.ah(.caption)).foregroundStyle(theme.faint)
                                        }
                                    }
                                    Spacer()
                                    if b.current { Image(systemName: "checkmark").foregroundStyle(theme.accent).fontWeight(.semibold) }
                                    if model.switching == b.name { ProgressView().controlSize(.small) }
                                }
                            }
                            .accessibilityIdentifier("branch:\(b.name)")
                        }
                    } footer: {
                        if branches.dirty > 0 {
                            Text("Uncommitted changes come along to the branch you switch to.")
                        }
                    }
                    if rows.isEmpty && created == nil {
                        Text("No branches yet. Type a name to create one.").foregroundStyle(theme.muted)
                    }
                } else if model.error != nil {
                    // The banner above says why: a way to ask again, not a spinner that never stops.
                    Button("Try Again", systemImage: "arrow.clockwise") { Task { await model.loadBranches() } }
                } else {
                    ProgressView()
                }
                }
                .ahRow()
            }
            .ahFormGround()
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Find or create a branch")
            .searchFocused($searching)
            .onAppear { searching = true }
            .onSubmit(of: .search) {
                if let first = model.branches.map(rows)?.first(where: { !$0.current && $0.worktree == nil }), created == nil { switchTo(first.name) } else if let created { switchTo(created) }
            }
            .navigationTitle("Switch Branch")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) } }
            .task { await model.loadBranches() }
            .alert("“\(held?.name ?? "")” is checked out elsewhere", isPresented: Binding(get: { held != nil }, set: { if !$0 { held = nil } })) {
                Button("OK", role: .cancel) { held = nil }
            } message: {
                Text("Git won’t check out one branch in two places. It’s in the worktree at \(held?.worktree ?? ""). Open that worktree’s session, or remove the worktree (the branch is kept) to free it.")
            }
        }
    }

    private func switchTo(_ name: String) {
        Task {
            if await model.switchBranch(name) {
                scene.toast("Switched to \(name)")
                scene.sheet = nil
            }
        }
    }
}

// MARK: Worktrees

struct WorktreesView: View {
    @State var model: WorktreesModel
    let scene: SceneModel
    @State private var removing: WorktreeInfo?
    @State private var confirmingBulk = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            List {
                Group {
                if let error = model.error { Banner(text: error, tone: .error, action: model.loaded ? nil : ("Retry", { Task { await model.load() } })) }
                if !model.results.isEmpty {
                    Section("Just now") {
                        ForEach(model.results, id: \.path) { r in
                            Label((r.path as NSString).lastPathComponent + (r.ok ? " removed" : ": " + (r.error ?? "kept")), systemImage: r.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .font(.ah(.callout))
                                .foregroundStyle(r.ok ? theme.done : theme.danger)
                        }
                    }
                }
                let sections = model.sections
                if !model.loaded && model.error == nil {
                    ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear).afterABeat(.milliseconds(300))
                } else if model.trees.isEmpty && model.error == nil {
                    ContentUnavailableView("No Worktrees", systemImage: "square.on.square.dashed", description: Text("Start a session with “Its own worktree” to give an agent a branch and checkout of its own."))
                }
                if !sections.inUse.isEmpty {
                    Section("In use") { ForEach(sections.inUse) { row($0) } }
                }
                if !sections.free.isEmpty {
                    Section {
                        ForEach(sections.free) { row($0) }
                    } header: {
                        Text("Not in use")
                    } footer: {
                        Text("Removing a worktree deletes its checkout; its branch is kept.")
                    }
                }
                }
                // The theme's ground and cards, like the rest of the app's sheets.
                .ahRow()
            }
            .ahFormGround()
            .navigationTitle("Worktrees")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom, spacing: 0) { if model.cleaningUp { cleanupBar } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if model.cleaningUp { Button(role: .cancel) { model.endCleanup() }.keyboardShortcut(.cancelAction).tint(.primary) } else { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if !model.cleaningUp {
                        Menu {
                            Picker("Sort", selection: $model.bySize) {
                                Label("Recently Active", systemImage: "clock").tag(false)
                                Label("Largest", systemImage: "internaldrive").tag(true)
                            }
                        } label: {
                            Image(systemName: "arrow.up.arrow.down")
                        }
                        .accessibilityLabel("Sort")
                        Button("Clean Up…") { model.startCleanup() }
                            .disabled(model.orphans.isEmpty)
                    }
                }
            }
            .task { await model.watch() }
            .refreshable { await model.load() }
            .confirmationDialog("Remove \(removing?.branch ?? "")?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible, presenting: removing) { tree in
                Button("Remove Worktree", role: .destructive) { Task { await model.remove(tree, force: WorktreesModel.needsForce(tree)) } }
            } message: { tree in
                Text(removeMessage(tree))
            }
            .confirmationDialog("Remove \(model.selected.count) worktree\(model.selected.count == 1 ? "" : "s")?", isPresented: $confirmingBulk, titleVisibility: .visible) {
                Button("Remove \(model.selected.count)", role: .destructive) {
                    Task { await model.removeSelected(forcing: Set(model.trees.filter { model.selected.contains($0.path) && WorktreesModel.needsForce($0) }.map(\.path))) }
                }
            } message: {
                Text("About \(WorktreesModel.size(model.selectedBytes)) comes back. Branches are kept. Each one is checked again first: one that came back into use or changed is skipped and reported.")
            }
        }
    }

    // MARK: Rows

    private func row(_ tree: WorktreeInfo) -> some View {
        let inUse = WorktreesModel.inUse(tree)
        let chosen = model.selected.contains(tree.path)
        return HStack(alignment: .top, spacing: 12) {
            if model.cleaningUp && tree.orphan {
                Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                    .font(.ah(.title3))
                    .foregroundStyle(chosen ? theme.accent : theme.faint)
            } else {
                Image(systemName: "arrow.triangle.branch").foregroundStyle(inUse ? theme.run : theme.muted).frame(width: 22).padding(.top, 2)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(tree.branch).font(.ahMono(.callout)).lineLimit(1).truncationMode(.middle)
                Text("\((tree.repo as NSString).lastPathComponent) · \(size(tree)) · \(age(tree))").font(.ah(.caption)).foregroundStyle(theme.muted)
                HStack(spacing: 6) {
                    if tree.dirty > 0 { StatusTag(text: "\(tree.dirty) uncommitted", color: theme.limited) }
                    if tree.ahead > 0 { StatusTag(text: "\(tree.ahead) unpushed", color: theme.limited) }
                    if tree.orphan { StatusTag(text: "orphaned", color: theme.faint) }
                    ForEach(tree.live, id: \.id) { live in
                        Button { open(live.id) } label: {
                            Label(live.name, systemImage: "arrow.up.right.square").font(.ah(.caption).weight(.semibold)).foregroundStyle(theme.run)
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { if model.cleaningUp && tree.orphan { model.toggle(tree) } }
        .swipeActions(edge: .trailing) {
            if !inUse && !model.cleaningUp {
                // Red by tint, not role: a destructive action swiped all the way is taken for
                // the row's deletion, and the list aborts when the row is still there (it is,
                // until the confirmation says).
                Button { removing = tree } label: { Image(systemName: "trash") }.accessibilityLabel("Remove").tint(theme.swipe(\.danger))
            }
        }
        .contextMenu {
            Button("Open a Shell Here", systemImage: "terminal") { shell(tree) }
            Button("Copy Path", systemImage: "doc.on.doc") { scene.copy(tree.path, say: "the path") }
            if !inUse {
                Divider()
                Button("Remove…", systemImage: "trash", role: .destructive) { removing = tree }
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var cleanupBar: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(model.selected.count) of \(model.orphans.count) orphaned chosen").font(.ah(.callout).weight(.semibold))
                Text("\(WorktreesModel.size(model.selectedBytes)) to reclaim").font(.ah(.caption)).foregroundStyle(theme.muted)
            }
            Spacer()
            // As Terminate: the danger color's words on its tint (white on the light red barely read).
            Button("Remove", role: .destructive) { confirmingBulk = true }
                .fontWeight(.semibold)
                .buttonStyle(.bordered)
                .tint(theme.danger)
                .disabled(model.selected.isEmpty)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    private func size(_ tree: WorktreeInfo) -> String {
        if tree.sizeTooLarge { return "too large to measure" }
        return WorktreesModel.size(tree.sizeBytes) + (tree.sizePartial ? "+" : "")
    }

    private func age(_ tree: WorktreeInfo) -> String {
        let at = ElapsedWords.date(epoch: tree.lastActivityAt)
        return at.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    private func removeMessage(_ tree: WorktreeInfo) -> String {
        var parts: [String] = []
        if tree.dirty > 0 { parts.append("\(tree.dirty) uncommitted change\(tree.dirty == 1 ? "" : "s") will be deleted.") }
        if tree.ahead > 0 { parts.append("\(tree.ahead) commit\(tree.ahead == 1 ? " isn’t" : "s aren’t") pushed anywhere; they stay on the branch.") }
        parts.append("The checkout is removed; the branch is kept.")
        return parts.joined(separator: " ")
    }

    // MARK: Actions

    private func open(_ key: String) {
        dismiss()
        scene.sheet = nil
        scene.open(key)
    }

    private func shell(_ tree: WorktreeInfo) {
        Task {
            let request = NewSessionRequest(preset: "shell", cwd: tree.path, session: scene.hub?.hub.state?.defaultSession ?? "", label: tree.branch)
            if await scene.start(request) != nil { scene.sheet = nil }
        }
    }
}

/// The composer's draft in a larger editor, for a message that has outgrown the box (the
/// box holds eight lines and scrolls past that, where a long message is hard to read over).
/// The same draft: what's typed here is in the box on the way back, and Send is the box's.
struct DraftSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @Environment(\.theme) private var theme
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            TextEditor(text: Binding(get: { session.composer.text }, set: { session.composer.text = $0 }))
                .font(.ah(.body))
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 12)
                .background(theme.surface)
                .focused($focused)
                .onAppear { focused = true }
                .navigationTitle("Message")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(role: .close) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
                    ToolbarItem(placement: .primaryAction) {
                        Button("Send", systemImage: "arrow.up") {
                            if session.composer.submit(working: session.working) { scene.sheet = nil }
                        }
                        .disabled(!session.composer.canSend)
                        .keyboardShortcut(.return, modifiers: .command)
                    }
                }
        }
    }
}

struct ScrollbackSheet: View {
    let text: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    // Leading, and opened at the bottom-left: the end mark sat centered under
                    // the widest line, so opening at it scrolled every line's start off screen.
                    VStack(alignment: .leading, spacing: 0) {
                        Text(text).font(theme.mono).textSelection(.enabled).padding().id("text")
                        Color.clear.frame(width: 1, height: 1).id("end")
                    }
                }
                .background(theme.surface)
                .onAppear { proxy.scrollTo("end", anchor: .bottomLeading) }
            }
            .navigationTitle("Scrollback")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .primaryAction) { ShareLink(item: text) }
            }
        }
    }
}

/// Model or effort for a live session; what applying it does (switch now, restart) is said up front.
struct LaunchPickerSheet: View {
    let scene: SceneModel
    let session: SessionModel
    let setting: LaunchState.Setting
    @Environment(\.theme) private var theme

    var body: some View {
        let launch = session.launch
        NavigationStack {
            List {
                Section {
                    if setting == .model {
                        ForEach(launch.preset?.models ?? [], id: \.id) { m in
                            row(m.name, detail: m.description, current: m.id == launch.model?.id) { scene.applyPlan(session.plan(model: m.id)) }
                        }
                    } else {
                        ForEach(launch.levels, id: \.self) { level in
                            row(level, detail: LaunchState.effortHints[level], current: level == launch.effort) { scene.applyPlan(session.plan(effort: level)) }
                        }
                    }
                } footer: {
                    Text(launch.footer(setting))
                }
                // The theme's card on its ground, like every other sheet: on the half sheet's
                // pale glass, white names and grey hints washed out.
                .ahRow()
            }
            .ahFormGround()
            .navigationTitle(setting == .model ? "Model" : "Reasoning Effort")
            .navigationBarTitleDisplayMode(.inline)
            // A pick applies at once: there's nothing to cancel, only to close.
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) } }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ title: String, detail: String?, current: Bool, pick: @escaping () -> Void) -> some View {
        Button {
            scene.sheet = nil
            if !current { pick() }
        } label: {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(setting == .effort ? LaunchState.effortName(title) : title).foregroundStyle(theme.text)
                    if let detail, !detail.isEmpty { Text(detail).font(.ah(.caption)).foregroundStyle(theme.muted) }
                }
                Spacer()
                if current { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(.tint) }
            }
            .contentShape(Rectangle())
        }
        .accessibilityAddTraits(current ? .isSelected : [])
    }
}

/// ⌃⌥. on a hardware keyboard: the session menu as a list you can arrow through.
struct SessionMenuSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            List {
                ForEach(items, id: \.id.rawValue) { item in
                    Button {
                        scene.sheet = nil
                        scene.perform(item.id)
                    } label: {
                        HStack {
                            Text(item.label)
                            Spacer()
                            if let chord = scene.app.keyBindings.chords(item.id).first { Keycaps(chord) }
                        }
                    }
                    .foregroundStyle(item.id == "terminate" ? theme.danger : theme.text)
                    .ahRow()
                }
            }
            .ahFormGround()
            .navigationTitle(session.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) } }
        }
        .presentationDetents([.medium, .large])
    }

    private var items: [Command] {
        let ids: [CommandID] = ["rename", "pin", "toggle-view", "pick-model", "pick-effort", "switch-branch", "fork", "continue-in", "conversation-lineage", "send-to", "scrollback", "copy-attach", "copy-last", "panel-terminal", "panel-diff", "panel-files", "panel-chat", "panel-queue", "panel-snapshots", "panel-preview", "panel-stack", "terminate"]
        return ids.compactMap { id in scene.isAvailable(id) ? CommandCatalog.byID[id] : nil }
    }
}
