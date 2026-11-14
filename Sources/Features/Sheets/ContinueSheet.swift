import SwiftUI

/// Continue in Another Agent: where this conversation goes next (another agent, or a fork of
/// this one), how (here, or a branch in its own worktree), and, before anything starts, what
/// the host says carries over and what doesn't. A host with `features.portable` carries it
/// itself (`ContinueModel`); an older one gets the text hand-off, which says so.
struct ContinueSheet: View {
    let scene: SceneModel
    let session: SessionModel
    let preset: String?

    var body: some View {
        if let hub = scene.hub, hub.state(host: hostParam)?.supports("portable") == true {
            PortableContinue(scene: scene, session: session, model: ContinueModel(
                source: .init(ref: session.ref, title: session.title, agent: agent, host: hostParam),
                api: session.api,
                presets: hub.presets(host: hostParam),
                preset: preset))
        } else {
            HandoffContinue(scene: scene, session: session, preset: preset)
        }
    }

    /// The host the session is on, as the hub names it (nil for its own).
    private var hostParam: String? {
        if let row = session.row { return row.isLocal ? nil : row.host }
        if let history = session.history { return history.isLocal ? nil : history.host }
        return SessionKey(session.key)?.host
    }

    private var agent: String? { session.row?.dto.agent ?? session.history.map(\.dto.harness).flatMap { $0 == "shell" ? nil : $0 } }
}

/// The host carries it: pick, preview, start, follow.
private struct PortableContinue: View {
    let scene: SceneModel
    let session: SessionModel
    @State var model: ContinueModel
    @State private var customModel = ""
    @State private var readRecord = false
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            AhForm {
                Section { route } footer: { routeFooter }
                Section("Continue in") { agents }
                Section {
                    Picker("How", selection: $model.intent) {
                        Text("Continue").tag(ContinueModel.Intent.continue)
                        Text("Fork").tag(ContinueModel.Intent.fork)
                    }
                    .pickerStyle(.segmented)
                    Toggle("In its own worktree", isOn: Binding(get: { model.worktree ?? (model.intent == .fork) }, set: { model.worktree = $0 }))
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(model.intent == .fork
                             ? "A fork is a branch of this conversation: the original stays as it is and keeps going."
                             : "Continuing picks up from here. Its own worktree keeps its changes on a new branch, apart from this one’s.")
                        if let chosen = model.chosen, !model.launchOptions, LaunchOptionRows.offersChoices(chosen) {
                            Text("This host starts \(chosen.name) with its default model and effort; change them in the new session once it’s running.")
                        }
                    }
                }
                if let chosen = model.chosen, model.launchOptions, LaunchOptionRows.offersChoices(chosen) {
                    Section("\(chosen.name)’s model") {
                        LaunchOptionRows(preset: chosen, mode: $model.mode, model: $model.model, customModel: $customModel, effort: $model.effort)
                    }
                }
                planSections
                if let operation = model.operation { progress(operation) }
            }
            .navigationTitle("Continue in Another Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(confirmTitle) { go() }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(!model.canStart && model.plan?.strategy != "native-resume")
                        .buttonStyle(.glassProminent)
                }
            }
            // A new plan for each change of what's chosen (a moment's pause, so a few quick
            // taps ask once).
            .task(id: model.request?.planKey) {
                try? await Task.sleep(for: .milliseconds(200))
                guard !Task.isCancelled else { return }
                await model.refresh()
            }
        }
    }

    // MARK: Where from, where to

    /// The agents it can go to, as a row of their marks: the plan below stays in view.
    private var agents: some View {
        ScrollViewReader { proxy in ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(model.destinations, id: \.id) { preset in
                    let selected = preset.id == model.destination
                    Button { model.destination = preset.id } label: {
                        VStack(spacing: 6) {
                            AgentMark(agent: preset.id, size: 36)
                                .padding(4)
                                .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(selected ? theme.accent : .clear, lineWidth: 2))
                            Text(preset.id == model.source.agent ? "\(preset.name) (same)" : preset.name)
                                .font(.ah(.caption).weight(selected ? .semibold : .regular))
                                .foregroundStyle(selected ? theme.text : theme.muted)
                                .lineLimit(1)
                        }
                        .frame(minWidth: 64)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(preset.id == model.source.agent ? "\(preset.name), same agent: resume or fork" : preset.name)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .hoverEffect(.highlight)
                    .id(preset.id)
                }
            }
            .padding(.vertical, 4)
        }
        .scrollClipDisabled()
        .onAppear { if let chosen = model.destination { proxy.scrollTo(chosen, anchor: .center) } }
        }
    }

    private var route: some View {
        HStack(spacing: 10) {
            AgentMark(agent: model.source.agent, size: 30)
            VStack(alignment: .leading, spacing: 1) {
                Text(model.source.title).font(.ah(.body).weight(.medium)).foregroundStyle(theme.text).lineLimit(1)
                Text(agentName(model.source.agent)).font(.ah(.caption)).foregroundStyle(theme.muted)
            }
            Spacer(minLength: 8)
            Image(systemName: "arrow.right").foregroundStyle(theme.faint).accessibilityHidden(true)
            Spacer(minLength: 8)
            AgentMark(agent: model.destination, size: 30)
            Text(model.chosen?.name ?? "—").font(.ah(.body).weight(.medium)).foregroundStyle(theme.text).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("From \(model.source.title) in \(agentName(model.source.agent)) to \(model.chosen?.name ?? "no agent yet")")
    }

    private var routeFooter: some View {
        Text("The original conversation stays as it is. The new session links back to it.")
    }

    // MARK: What the host says

    @ViewBuilder
    private var planSections: some View {
        if let error = model.planError {
            Section { Banner(text: error, tone: .error).formBanner() }
        } else if let plan = model.plan {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Label(ContinueWords.headline(plan.strategy, to: agentName(plan.destination.harness)), systemImage: ContinueWords.isNative(plan.strategy) ? "checkmark.seal" : "doc.text.magnifyingglass")
                        .font(.ah(.body).weight(.semibold))
                        .foregroundStyle(theme.text)
                    Text(ContinueWords.guarantee(plan.strategy, from: agentName(model.source.agent), to: agentName(plan.destination.harness)))
                        .font(.ah(.callout)).foregroundStyle(theme.text2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 2)
                if let blocked = plan.blocked {
                    Banner(text: blocked.message, tone: .warning).formBanner()
                }
            } header: {
                Text("What happens")
            }
            if !plan.transfers.isEmpty {
                Section("Carries over") {
                    ForEach(plan.transfers, id: \.self) { line in
                        Label { Text(line).font(.ah(.callout)) } icon: { Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.done) }
                    }
                    if let stats = plan.stats {
                        Text("\(stats.messages) messages · \(stats.turns) turns · \(stats.toolCalls) tool calls").font(.ah(.caption)).foregroundStyle(theme.muted)
                    }
                }
            }
            if !plan.limitations.isEmpty {
                Section("Doesn’t carry over") {
                    ForEach(plan.limitations, id: \.self) { limit in
                        Label { Text(limit.message).font(.ah(.callout)) } icon: { Image(systemName: "minus.circle").foregroundStyle(theme.muted) }
                    }
                }
            }
            if let handoff = plan.handoff {
                Section {
                    DisclosureGroup(isExpanded: $readRecord) {
                        ScrollView {
                            Text(handoff.preview).font(.ahMono(.caption)).foregroundStyle(theme.text2)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 280)
                    } label: {
                        Text("Read the record").font(.ah(.body))
                    }
                } header: {
                    Text("The record")
                } footer: {
                    Text(handoff.messagesOmitted > 0
                         ? "\(handoff.chars.formatted()) characters: \(handoff.messagesIncluded) messages, \(handoff.messagesOmitted) older ones left out (the full conversation stays on the host)."
                         : "\(handoff.chars.formatted()) characters: all \(handoff.messagesIncluded) messages.")
                }
            }
        } else if model.planning {
            Section { HStack(spacing: 10) { ProgressView(); Text("Asking the host what carries over…").font(.ah(.callout)).foregroundStyle(theme.muted) } }
        }
    }

    // MARK: Under way

    private func progress(_ operation: ContinueOperation) -> some View {
        Section {
            if operation.state == "failed" || operation.state == "cancelled" {
                Banner(text: operation.error ?? model.startError ?? (operation.state == "cancelled" ? "Cancelled. Nothing more will start." : "It didn’t go through."), tone: operation.state == "failed" ? .error : .info).formBanner()
            } else {
                let at = ContinueWords.stepIndex(operation.state) ?? 0
                ForEach(Array(ContinueWords.steps.enumerated()), id: \.offset) { index, step in
                    HStack(spacing: 10) {
                        Group {
                            if index < at || operation.state == "linked" {
                                Image(systemName: "checkmark.circle.fill").foregroundStyle(theme.done)
                            } else if index == at {
                                ProgressView().controlSize(.small)
                            } else {
                                Image(systemName: "circle").foregroundStyle(theme.faint)
                            }
                        }
                        .frame(width: 20)
                        Text(step.label).font(.ah(.callout)).foregroundStyle(index <= at ? theme.text : theme.muted)
                    }
                }
                if let note = model.startError { Text(note).font(.ah(.caption)).foregroundStyle(theme.muted) }
            }
        } header: {
            Text(operation.state == "failed" ? "It didn’t go through" : operation.state == "cancelled" ? "Cancelled" : "Under way")
        }
    }

    private var confirmTitle: String {
        if model.operation?.state == "failed" { return "Try Again" }
        switch model.plan?.strategy {
        case "native-resume": return "Resume"
        default: return model.intent == .fork ? "Fork" : "Continue"
        }
    }

    private func go() {
        // Same agent, continuing: the host resumes it as itself.
        if model.plan?.strategy == "native-resume" {
            Task {
                if let key = await session.resume() {
                    scene.sheet = nil
                    scene.open(key)
                }
            }
            return
        }
        let trimmed = customModel.trimmingCharacters(in: .whitespaces)
        if model.launchOptions, !trimmed.isEmpty, LaunchState.isValidModelID(trimmed) { model.model = trimmed }
        Task {
            guard let uid = await model.start() else { return }
            let host = SessionKey(session.key)?.host
            let key = host.map { "\($0)/\(uid)" } ?? uid
            scene.hub?.refresh(host: host)
            scene.sheet = nil
            scene.open(key)
        }
    }

    private func agentName(_ id: String?) -> String {
        guard let id else { return "Shell" }
        return model.destinations.first { $0.id == id }?.name ?? id
    }
}

/// A host without `features.portable`: the conversation's text, read from its transcript, as
/// the first message of a new session. Said plainly: it's a hand-off, not the agent's memory.
private struct HandoffContinue: View {
    let scene: SceneModel
    let session: SessionModel
    @State var preset: String?
    @State private var text = ""
    @State private var loading = true
    @State private var mode = "default"
    @State private var model: String?
    @State private var customModel = ""
    @State private var effort: String?
    @Environment(\.theme) private var theme

    init(scene: SceneModel, session: SessionModel, preset: String?) {
        self.scene = scene
        self.session = session
        let agent = session.row?.dto.agent
        _preset = State(initialValue: preset ?? Self.presets(scene, session).first { $0.id != agent }?.id)
    }

    private static func presets(_ scene: SceneModel, _ session: SessionModel) -> [PresetDTO] {
        let host = session.row.flatMap { $0.isLocal ? nil : $0.host }
        return (scene.hub?.presets(host: host) ?? []).filter { $0.offered && !$0.isShell }
    }

    var body: some View {
        let presets = Self.presets(scene, session)
        let chosen = presets.first { $0.id == preset }
        NavigationStack {
            AhForm {
                Banner(text: "This host can’t carry a conversation between agents itself yet. Agent Hub starts the agent you pick with this conversation’s text as its first message: a record of what was said, not the other agent’s memory.", tone: .info).formBanner()
                Section("Continue in") {
                    Picker("Agent", selection: $preset) {
                        ForEach(presets, id: \.id) { p in Text(p.name).tag(Optional(p.id)) }
                    }
                }
                if let chosen, LaunchOptionRows.offersChoices(chosen) {
                    Section("\(chosen.name)’s model") {
                        LaunchOptionRows(preset: chosen, mode: $mode, model: $model, customModel: $customModel, effort: $effort)
                    }
                }
                Section {
                    if loading { ProgressView("Reading the conversation…") }
                    TextEditor(text: $text).frame(minHeight: 220).font(.ahMono(.callout))
                } header: {
                    Text("Its first message")
                } footer: {
                    Text("\(chosen?.name ?? "It") starts in the same folder with this as its first message. Nothing is summarized by a model.")
                }
            }
            .navigationTitle("Continue in Another Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Start") { start(chosen) }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(loading || text.isEmpty || chosen == nil)
                        .buttonStyle(.glassProminent)
                }
            }
            .onChange(of: preset) { mode = "default"; model = nil; effort = nil; customModel = "" }
            .task {
                text = await session.continuePrompt() ?? ""
                loading = false
            }
        }
    }

    private func start(_ chosen: PresetDTO?) {
        guard let chosen, let row = session.row else { return }
        let host = row.isLocal ? nil : row.host
        var request = NewSessionRequest(preset: chosen.id, cwd: row.dto.projectPath.isEmpty ? row.dto.cwd : row.dto.projectPath, session: row.dto.session.isEmpty ? (scene.hub?.state(host: host)?.defaultSession ?? "") : row.dto.session, label: "")
        request.mode = mode == "default" ? nil : mode
        request.model = LaunchState.chosenModel(listed: model, typed: customModel, preset: chosen)
        request.effort = effort
        let prompt = text
        scene.sheet = nil
        Task { await scene.start(request, host: host, prompt: prompt) }
    }
}

private extension ContinueRequest {
    /// What a preview depends on (the key aside), for asking again when it changes.
    var planKey: String { [to, intent ?? "", worktree.map { $0 ? "w" : "-" } ?? "", model ?? "", effort ?? "", mode ?? ""].joined(separator: "|") }
}
