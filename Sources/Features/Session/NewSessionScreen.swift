import SwiftUI
import UIKit

/// What a new session starts with, and its start (`../ah/web/NewSession.tsx`): held by the
/// screen New session is, which is a session's own place, so the session it starts takes over
/// where it is. Each agent comes back as it was last started, and the place as last time.
@MainActor
@Observable
final class NewSessionDraft {
    let scene: SceneModel
    let context: SceneModel.NewSessionContext

    var host: String?
    var presetID = ""
    var cwd = ""
    private(set) var dirState: DirState?
    /// Where new folders go on this host.
    private(set) var root: String?
    var gitInit = true
    var worktree = false
    var resume = false
    var mode = "default"
    private(set) var model: String?
    private(set) var effort: String?
    /// The effort picked with each model while this is open, by "preset|model".
    private var picked: [String: String] = [:]
    var trust = false
    var label = ""
    /// "Other model version", for agents that take any model id.
    var customModel = ""
    /// The tmux session it goes into; `newTmux` names a new one.
    var tmuxSession: String?
    var newTmux = ""
    var extraArgs = ""
    private(set) var projects: [String] = []
    /// The first message, typed in the box.
    var text = ""

    enum Phase { case ready, starting }
    private(set) var phase: Phase = .ready
    /// The first message as it went, shown while the session starts.
    private(set) var sent: String?
    private(set) var error: String?
    private var loaded = false

    init(scene: SceneModel, context: SceneModel.NewSessionContext) {
        self.scene = scene
        self.context = context
    }

    private var hub: HubStore? { scene.hub }

    /// The agents to start, the ones started lately first, a shell last.
    var presets: [PresetDTO] {
        let all = hub?.presets(host: host).filter(\.offered) ?? []
        let recent = scene.app.preferences.recentAgents
        return all.sorted { a, b in (recent.firstIndex(of: a.id) ?? 99, a.isShell ? 1 : 0) < (recent.firstIndex(of: b.id) ?? 99, b.isShell ? 1 : 0) }
    }

    var preset: PresetDTO? { presets.first { $0.id == presetID } }

    /// The folder's last name ("orbit-web"), for chips and titles.
    var folderName: String {
        let trimmed = cwd.trimmingCharacters(in: .whitespaces)
        let path = trimmed.hasSuffix("/") && trimmed.count > 1 ? String(trimmed.dropLast()) : trimmed
        return path.isEmpty ? "No folder" : (path as NSString).lastPathComponent
    }

    var dirProblem: String? {
        switch dirState {
        case .file: return "That’s a file, not a folder."
        case .missing: return "No such folder. A new one goes inside a folder that exists."
        case .outside: return "Agent Hub creates folders only inside the browsable folders (files.roots in the config)."
        default: return nil
        }
    }

    var canStart: Bool {
        phase == .ready && preset != nil && !cwd.trimmingCharacters(in: .whitespaces).isEmpty && dirProblem == nil
            && (tmuxSession != nil || !newTmux.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    /// Once, when the screen first shows: what it was opened with, else as last time.
    func load() async {
        guard !loaded else { return }
        loaded = true
        let last = scene.app.preferences.lastPlace
        host = context.host ?? (context.cwd == nil ? last?.host : nil)
        if hub?.hosts.contains(where: { !$0.isSelf && $0.name == host && $0.online }) != true { host = nil }
        cwd = context.cwd ?? (last.flatMap { $0.host == host ? $0.cwd : nil })
            ?? LaunchState.newestProject(hub?.rows.filter { $0.isLocal == (host == nil) } ?? []) ?? "~"
        resetTmux()
        if let first = context.preset.flatMap({ id in presets.first { $0.id == id } }) ?? presets.first {
            presetID = first.id
            applyDefaults(first)
        }
        if let prompt = context.prompt { text = prompt }
        await loadProjects()
        await checkDir()
    }

    func choose(preset: PresetDTO) {
        presetID = preset.id
        applyDefaults(preset)
    }

    func choose(host next: String?) {
        guard next != host else { return }
        host = next
        resetTmux()
        projects = []
        if !presets.contains(where: { $0.id == presetID }), let first = presets.first { choose(preset: first) }
        Task { await loadProjects() }
    }

    func choose(folder: String) {
        cwd = folder
        dirState = nil
        Task { await checkDir() }
    }

    /// Each model brings its own effort: the one picked with it here, else the one it last
    /// started with.
    func choose(model next: String?) {
        model = next
        customModel = ""
        guard let preset else { return }
        var chosen = scene.app.preferences.launchMemory[preset.id]?.effortsByModel ?? [:]
        if let here = picked["\(preset.id)|\(next ?? "default")"] { chosen[next ?? "default"] = here }
        effort = LaunchState.effort(for: next, preset: preset, chosen: chosen, current: effort)
    }

    func choose(effort next: String?) {
        effort = next
        picked["\(presetID)|\(model ?? "default")"] = next ?? "default"
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

    private func resetTmux() {
        let state = hub?.state(host: host)
        let tmux = LaunchState.tmuxChoices(sessions: state?.sessions ?? [], defaultSession: state?.defaultSession ?? "")
        tmuxSession = tmux.initial
        newTmux = tmux.initial == nil ? (state?.defaultSession ?? "") : ""
    }

    private func loadProjects() async {
        guard let hub else { return }
        let asked = host
        let listed = (try? await hub.client(host: asked).projects()) ?? []
        if host == asked { projects = listed }
    }

    func checkDir() async {
        guard let hub else { return }
        let path = cwd.trimmingCharacters(in: .whitespaces)
        guard !path.isEmpty else { return }
        let status = try? await hub.client(host: host).dir(path)
        // An answer for a folder since changed is the old one's.
        guard cwd.trimmingCharacters(in: .whitespaces) == path else { return }
        dirState = status?.state
        if let status { root = status.root }
    }

    private func request(_ preset: PresetDTO) -> NewSessionRequest {
        let create = dirState == .new
        let chosenModel = LaunchState.chosenModel(listed: model, typed: customModel, preset: preset)
        let chosenEffort = effort != nil && (effort != preset.defaultEffort || chosenModel != nil) ? effort : nil
        let extra = extraArgs.trimmingCharacters(in: .whitespaces)
        return NewSessionRequest(
            preset: preset.id, cwd: cwd.trimmingCharacters(in: .whitespaces), session: tmuxSession ?? newTmux.trimmingCharacters(in: .whitespaces), label: label,
            resume: resume && preset.resume != nil, worktree: worktree && !create, create: create ? true : nil, git: create ? gitInit : nil,
            mode: mode == "default" ? nil : mode, model: chosenModel, effort: chosenEffort,
            extraArgs: extra.isEmpty ? nil : extra,
            trust: preset.trust != nil && trust ? true : nil)
    }

    /// The first message (or none) starts it: the choices give way, the message stays as the
    /// session's first, and the session takes over this place once the host has it.
    func start(animated: Bool) async {
        guard canStart, let preset else { return }
        if dirState == nil { await checkDir() }
        guard dirProblem == nil else { return }
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : text
        error = nil
        withAnimation(animated ? .smooth(duration: 0.4) : nil) {
            phase = .starting
            sent = message
            text = ""
        }
        guard let key = await scene.create(request(preset), host: host) else {
            // Not started: everything back as it was, the message in the box.
            withAnimation(animated ? .smooth(duration: 0.3) : nil) {
                phase = .ready
                text = message ?? ""
                sent = nil
            }
            return
        }
        if !preset.isShell {
            scene.app.preferences.launchMemory[preset.id] = LaunchState.remembering(
                scene.app.preferences.launchMemory[preset.id], mode: mode, model: LaunchState.chosenModel(listed: model, typed: customModel, preset: preset) ?? model,
                effort: effort, trust: preset.trust != nil ? trust : nil)
        }
        scene.app.preferences.lastPlace = DevicePreferences.Place(host: host, cwd: cwd.trimmingCharacters(in: .whitespaces))
        // Once the host lists it: a session screen with no row yet reads as one that ended.
        for _ in 0..<60 where hub?.row(key) == nil { try? await Task.sleep(for: .milliseconds(100)) }
        // An agent's, once its conversation is being read too: before that its screen is the
        // terminal, which showed for a moment between this and the conversation.
        if !preset.isShell, let session = scene.session(key) {
            for _ in 0..<80 where !session.hasGUI { try? await Task.sleep(for: .milliseconds(100)) }
        }
        if let message, let session = scene.session(key) {
            // Through the session's own box: your message in its conversation, as any is.
            session.composer.text = message
            session.composer.submit(working: false)
        }
        scene.newSessionStarted(key)
    }
}

/// New session, in a session's place: the empty conversation it will be, what it starts with
/// as chips above the box, and the box the first message starts it from. Sending is the
/// start: the chips go, the message stays, and the session takes over here.
struct NewSessionScreen: View {
    @Bindable var draft: NewSessionDraft
    let scene: SceneModel
    /// The title is in a bar of UIKit's own (a phone's push), not a header here.
    var inNavigationBar = false
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .body) private var control: CGFloat = 44
    @ScaledMetric(relativeTo: .body) private var corner: CGFloat = 22
    @ScaledMetric(relativeTo: .body) private var chipHeight: CGFloat = 36
    @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 62
    @FocusState private var focused: Bool
    @State private var choosingFolder = false
    @State private var typingFolder = false
    @State private var typedFolder = ""
    @State private var showingMore = false

    private var agentName: String { draft.preset?.name ?? "the agent" }

    var body: some View {
        VStack(spacing: 0) {
            if !inNavigationBar { header }
            conversation
                .frame(maxHeight: .infinity)
            // The box alone at the bottom, as a session's is: what it starts with is the stage.
            box
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
        }
        .frame(maxWidth: SessionScreen.readableWidth)
        .frame(maxWidth: .infinity)
        // The ground a session's screen has.
        .background(theme.surface)
        .task { await draft.load() }
        .onAppear { if draft.phase == .ready { focused = true } }
        .sheet(isPresented: $showingMore) { NewSessionMore(draft: draft) }
        .sheet(isPresented: $choosingFolder) {
            if let hub = scene.hub {
                FolderPicker(api: hub.client(host: draft.host), start: draft.cwd.isEmpty ? nil : draft.cwd) { draft.choose(folder: $0) }
            }
        }
        .alert("Folder", isPresented: $typingFolder) {
            TextField("~/code/project", text: $typedFolder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Use This Folder") { if !typedFolder.trimmingCharacters(in: .whitespaces).isEmpty { draft.choose(folder: typedFolder.trimmingCharacters(in: .whitespaces)) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("A folder on the host. One that doesn’t exist yet is made when the session starts.")
        }
    }

    // MARK: Header (iPad and Mac)

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                scene.closeSession()
            } label: {
                Image(systemName: "xmark").font(.ah(.body).weight(.semibold)).frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: Circle())
            .accessibilityLabel("Close New Session")
            VStack(alignment: .leading, spacing: 1) {
                Text("New session").font(.ah(.headline))
                Text(place).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    /// Where it starts: the host (with more than one), then the folder.
    var place: String { NewSessionScreen.place(draft) }

    static func place(_ draft: NewSessionDraft) -> String {
        [draft.scene.hub?.multiHost == true ? (draft.host ?? draft.scene.hub?.hostname) : nil, draft.folderName].compactMap { $0 }.joined(separator: " · ")
    }

    // MARK: The conversation it will be

    @ViewBuilder
    private var conversation: some View {
        if let sent = draft.sent {
            // The first message, where it will be in the conversation, while the host starts it.
            VStack(alignment: .trailing, spacing: 10) {
                Spacer(minLength: 0)
                UserBubble(text: sent, pending: "Starting \(agentName)…")
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 12)
            // In once the choices have gone: together, it showed through them.
            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 8)).animation(.smooth(duration: 0.3).delay(0.28)), removal: .opacity))
        } else if draft.phase == .starting {
            VStack(spacing: 10) {
                ProgressView()
                Text("Starting \(agentName)…").font(.ah(.callout)).foregroundStyle(theme.muted)
            }
            .transition(.opacity)
        } else {
            stage
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.97)))
        }
    }

    // MARK: What it starts with

    /// The middle of the screen, where the conversation will be: the agents to start, the
    /// folder it starts in as a line under the one picked, then its settings.
    private var stage: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 26) {
                    if let error = draft.error { Banner(text: error, tone: .error).padding(.horizontal, 20) }
                    agents
                    VStack(spacing: 8) {
                        Text(draft.preset?.name ?? "New session")
                            .font(.ah(.title2).weight(.semibold))
                            .contentTransition(.opacity)
                        folderLine
                        hint
                    }
                    .padding(.horizontal, 24)
                    if let preset = draft.preset { settings(preset) }
                }
                .padding(.vertical, 24)
                // In the middle of the room there is, scrolling once there's less of it (the
                // keyboard up on a small phone).
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    /// Every agent there is to start, as tiles: one tap picks, the one picked is ringed.
    private var agents: some View {
        let tiles = HStack(spacing: 10) {
            ForEach(draft.presets, id: \.id) { p in agentTile(p) }
        }
        return ViewThatFits(in: .horizontal) {
            tiles.padding(.horizontal, 20)
            ScrollViewReader { reader in
                ScrollView(.horizontal) {
                    tiles.padding(.horizontal, 20).padding(.vertical, 2)
                }
                .scrollIndicators(.hidden)
                .onAppear { reader.scrollTo(draft.presetID, anchor: .center) }
                .onChange(of: draft.presetID) { _, id in withAnimation(.smooth) { reader.scrollTo(id, anchor: .center) } }
            }
        }
    }

    private func agentTile(_ p: PresetDTO) -> some View {
        let on = p.id == draft.presetID
        return Button {
            withAnimation(reduceMotion ? nil : .spring(duration: 0.3, bounce: 0.2)) { draft.choose(preset: p) }
        } label: {
            VStack(spacing: 7) {
                AgentMark(agent: p.isShell ? nil : p.id, size: 34)
                    .frame(width: tile, height: tile)
                    .background(on ? theme.accentTint : theme.raised, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(on ? theme.accent : theme.line, lineWidth: on ? 2 : 1))
                    .scaleEffect(on ? 1.04 : 1)
                Text(p.isShell ? "Shell" : p.name)
                    .font(.ah(.caption).weight(on ? .semibold : .regular))
                    .foregroundStyle(on ? theme.text : theme.muted)
                    .lineLimit(1)
            }
            .frame(width: tile + 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.ahPress)
        .id(p.id)
        .accessibilityLabel(p.isShell ? "Shell" : p.name)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    /// Under the agent: what the first message does, or what the folder needs first.
    @ViewBuilder
    private var hint: some View {
        Group {
            if let problem = draft.dirProblem {
                Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(theme.danger)
            } else if draft.dirState == .new {
                Label("Starting makes \(draft.folderName) in \((draft.cwd as NSString).deletingLastPathComponent)", systemImage: "folder.badge.plus")
                    .foregroundStyle(theme.text2)
            } else {
                Text(draft.preset?.isShell == true ? "Your first command starts it." : "Your first message starts it.")
                    .foregroundStyle(theme.muted)
            }
        }
        .font(.ah(.callout))
        .multilineTextAlignment(.center)
    }

    /// Model, effort, permissions and More, centered under the rest (two rows when they
    /// don't fit in one).
    private func settings(_ preset: PresetDTO) -> some View {
        GlassEffectContainer {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    if !preset.isShell { settingChips(preset) }
                    moreChip
                }
                VStack(spacing: 8) {
                    HStack(spacing: 8) { if !preset.isShell { settingChips(preset) } }
                    moreChip
                }
            }
        }
        .padding(.horizontal, 20)
    }

    /// "in orbit-web", the folder's name a menu of the host's projects and the ways to another.
    private var folderLine: some View {
        Menu {
            if !draft.projects.isEmpty {
                Section("Projects") {
                    ForEach(draft.projects.prefix(8), id: \.self) { path in
                        Toggle(isOn: Binding(get: { draft.cwd == path }, set: { _ in draft.choose(folder: path) })) {
                            Text((path as NSString).lastPathComponent)
                            Text((path as NSString).deletingLastPathComponent)
                        }
                    }
                }
            }
            Section {
                Button("Choose a Folder…", systemImage: "folder") { choosingFolder = true }
                Button("Type a Path…", systemImage: "character.cursor.ibeam") {
                    typedFolder = draft.cwd
                    typingFolder = true
                }
                if let root = draft.root {
                    Button("New Folder…", systemImage: "folder.badge.plus") {
                        typedFolder = root.hasSuffix("/") ? root : root + "/"
                        typingFolder = true
                    }
                }
            }
        } label: {
            HStack(spacing: 5) {
                Text("in").foregroundStyle(theme.muted)
                Image(systemName: draft.dirState == .new ? "folder.badge.plus" : "folder")
                    .imageScale(.small)
                    .foregroundStyle(draft.dirProblem != nil ? theme.danger : theme.accent)
                Text(draft.folderName).foregroundStyle(draft.dirProblem != nil ? theme.danger : theme.accent).lineLimit(1)
                Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(theme.muted)
            }
            .font(.ah(.title3).weight(.medium))
            .padding(.horizontal, 12)
            .frame(minHeight: control)
            .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .tint(.primary)
        .accessibilityLabel("Folder, \(draft.folderName)")
    }

    /// Model, effort and permissions, as a running session's chips show them.
    @ViewBuilder
    private func settingChips(_ preset: PresetDTO) -> some View {
        if let models = preset.models, !models.isEmpty {
            let current = models.first { $0.id == draft.model }
            Menu {
                Picker("Model", selection: Binding(get: { draft.model }, set: { draft.choose(model: $0) })) {
                    Text("Default\(preset.defaultModel.map { " · \($0)" } ?? "")").tag(String?.none)
                    ForEach(models, id: \.id) { m in Text(m.name).tag(Optional(m.id)) }
                }
            } label: {
                chip("Model", "cpu", current?.name ?? (draft.customModel.isEmpty ? nil : draft.customModel))
            }
            .menuOrder(.fixed)
            .tint(.primary)
        }
        let levels = LaunchState.levels(preset, model: draft.model)
        if !levels.isEmpty {
            Menu {
                Picker("Effort", selection: Binding(get: { draft.effort }, set: { draft.choose(effort: $0) })) {
                    Text("Default\(preset.defaultEffort.map { " · \(LaunchState.effortName($0))" } ?? "")").tag(String?.none)
                    ForEach(levels, id: \.self) { Text(LaunchState.effortName($0)).tag(Optional($0)) }
                }
            } label: {
                chip("Effort", "gauge.with.dots.needle.50percent", draft.effort.map(LaunchState.effortName))
            }
            .menuOrder(.fixed)
            .tint(.primary)
        }
        if let modes = preset.modes, modes.count > 1 {
            let current = modes.first { $0.id == draft.mode }
            Menu {
                Picker("Permissions", selection: $draft.mode) {
                    Text("Default").tag("default")
                    ForEach(modes, id: \.id) { m in
                        Label(m.name, systemImage: m.dangerous == true ? "exclamationmark.shield" : "hand.raised").tag(m.id)
                    }
                }
            } label: {
                chip("Permissions", current?.dangerous == true ? "exclamationmark.shield.fill" : "lock.shield", current?.name, danger: current?.dangerous == true)
            }
            .menuOrder(.fixed)
            .tint(.primary)
        }
    }

    private var moreChip: some View {
        Button { showingMore = true } label: { chip("More", "slider.horizontal.3", nil, quiet: true) }
            .buttonStyle(.plain)
            .accessibilityLabel("More settings")
    }

    /// A setting's chip: its glyph, a quiet label and the value in force ("Model Opus 5.5"),
    /// glass as a running session's are.
    private func chip(_ name: String, _ symbol: String, _ value: String?, danger: Bool = false, quiet: Bool = false) -> some View {
        HStack(spacing: 4) {
            Image(systemName: symbol).imageScale(.small).foregroundStyle(value == nil ? theme.muted : theme.text2)
            // At its default it says what it sets ("Model"); chosen, the value ("Opus 5.5").
            if quiet || value == nil {
                Text(name).foregroundStyle(theme.muted)
            } else if let value {
                Text(value).foregroundStyle(danger ? theme.danger : theme.text).lineLimit(1)
            }
        }
        .font(.ah(.footnote).weight(.medium))
        .padding(.horizontal, 11)
        .frame(minHeight: chipHeight)
        .glassEffect(danger ? .regular.tint(theme.danger.opacity(0.22)).interactive() : .regular.interactive(), in: Capsule())
        .contentShape(Capsule())
        .hoverEffect(.highlight)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(name), \(value ?? "Default")")
        .accessibilityAddTraits(.isButton)
    }

    // MARK: The box

    private var box: some View {
        let empty = draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HStack(alignment: .bottom, spacing: 6) {
            TextField(draft.preset?.isShell == true ? "First command" : "Message \(agentName)", text: $draft.text, axis: .vertical)
                .font(.ah(.body))
                .lineLimit(1...8)
                .focused($focused)
                // A hardware Return starts the session, as a session's composer sends on it;
                // Shift- or Option-Return starts a new line. Left to the field, the press went
                // on to the sidebar's list, which opened its first session instead.
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.isDisjoint(with: [.shift, .option, .command, .control]) else { return .ignored }
                    if draft.canStart { send() }
                    return .handled
                }
                .textInputAutocapitalization(draft.preset?.isShell == true ? .never : .sentences)
                .autocorrectionDisabled(draft.preset?.isShell == true)
                .padding(.leading, 14)
                .padding(.vertical, 11)
                .disabled(draft.phase != .ready)
                .accessibilityIdentifier("new-session-message")
            if !empty || draft.phase == .starting {
                Button {
                    send()
                } label: {
                    Image(systemName: "arrow.up")
                        .font(.system(size: control * 0.34, weight: .bold))
                        .foregroundStyle(theme.accentInk)
                        .frame(width: control - 12, height: control - 12)
                        .background(theme.accentStrong, in: Circle())
                        .opacity(draft.canStart ? 1 : 0.45)
                        .touchTarget()
                }
                .buttonStyle(.ahPress)
                .disabled(!draft.canStart)
                .padding(6)
                .transition(reduceMotion ? .opacity : .scale(scale: 0.6).combined(with: .opacity))
                .accessibilityLabel("Send")
                .accessibilityHint("Starts \(agentName) with this as its first message")
                .keyboardShortcut(.return, modifiers: .command)
            }
        }
        .frame(minHeight: control)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: corner, style: .continuous))
        // Starting: the light a working session's box has, from the first moment.
        .overlay { ThinkingBorder(corner: corner, active: draft.phase == .starting) }
        .animation(.snappy(duration: 0.22), value: empty)
    }

    private func send() {
        // The keyboard goes down with the choices: what comes next is the conversation.
        focused = false
        Task { await draft.start(animated: !reduceMotion) }
    }
}

/// The rest of what a new session can start with, behind More: where it runs, its worktree,
/// its tmux session, a name, extra arguments and what it skips. Changes apply as they're made.
struct NewSessionMore: View {
    @Bindable var draft: NewSessionDraft
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            AhForm {
                if let hub = draft.scene.hub, hub.multiHost {
                    Picker("Host", selection: Binding(get: { draft.host }, set: { draft.choose(host: $0) })) {
                        ForEach(hub.hosts, id: \.name) { h in
                            Text(h.name + (h.online ? "" : " (offline)")).tag(h.isSelf ? String?.none : Optional(h.name))
                        }
                    }
                }
                Section {
                    if draft.dirState == .new {
                        Toggle("Initialize a git repository", isOn: $draft.gitInit)
                    } else if draft.preset?.isShell == false {
                        Toggle(isOn: $draft.worktree) {
                            Text("Its own worktree")
                            Text("A new branch in a checkout of its own, so it never collides with other agents here.")
                        }
                    }
                    if draft.preset?.resume != nil { Toggle("Resume its last conversation here", isOn: $draft.resume) }
                    if let preset = draft.preset, preset.trust != nil {
                        Toggle(isOn: $draft.trust) {
                            Text("Skip startup confirmations")
                            Text("When \(preset.name) asks whether to trust a new folder, Agent Hub says yes for you.")
                        }
                    }
                } header: {
                    Text(draft.folderName)
                }
                if let preset = draft.preset, LaunchState.takesCustomModel(preset) {
                    Section("Model") {
                        TextField("Other model version (optional)", text: $draft.customModel)
                            .font(.ahMono(.body))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                }
                Section("More") {
                    TextField("Name (optional)", text: $draft.label)
                    Picker("tmux session", selection: $draft.tmuxSession) {
                        ForEach(draft.scene.hub?.state(host: draft.host)?.sessions ?? [], id: \.self) { Text($0).tag(Optional($0)) }
                        Text("New…").tag(String?.none)
                    }
                    if draft.tmuxSession == nil {
                        TextField("New tmux session name", text: $draft.newTmux).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                    TextField("Extra arguments", text: $draft.extraArgs).font(.ahMono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section {
                    Button("Start Without a Message", systemImage: "play") {
                        dismiss()
                        Task { await draft.start(animated: true) }
                    }
                    .disabled(!draft.canStart)
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() }.keyboardShortcut(.cancelAction) }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// New session on an iPad or a Mac: in the detail, where the session it starts will be.
struct NewSessionPane: View {
    let scene: SceneModel
    @State private var draft: NewSessionDraft

    init(scene: SceneModel) {
        self.scene = scene
        _draft = State(initialValue: NewSessionDraft(scene: scene, context: scene.newSession ?? SceneModel.NewSessionContext()))
    }

    var body: some View {
        NewSessionScreen(draft: draft, scene: scene)
    }
}

/// New session pushed on a phone, as a session is: its bar UIKit's own, its title "New
/// session" over where it starts.
@MainActor
final class NewSessionHostController: UIHostingController<Themed<NewSessionScreen>> {
    let count: Int
    private let draft: NewSessionDraft

    init(root: SceneRootController, count: Int) {
        self.count = count
        let draft = NewSessionDraft(scene: root.scene, context: root.scene.newSession ?? SceneModel.NewSessionContext())
        self.draft = draft
        super.init(rootView: Themed(app: root.scene.app, theme: root.theme) { NewSessionScreen(draft: draft, scene: root.scene, inNavigationBar: true) })
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal
        navigationItem.title = "New session"
        hidesBottomBarWhenPushed = true
    }

    @MainActor required dynamic init?(coder: NSCoder) { fatalError() }

    override func updateProperties() {
        super.updateProperties()
        let subtitle = NewSessionScreen.place(draft)
        if navigationItem.subtitle != subtitle { navigationItem.subtitle = subtitle }
    }
}
