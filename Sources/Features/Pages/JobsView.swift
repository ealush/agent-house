import SwiftUI

/// Jobs (`../ah/web/JobsView.tsx`): agent work the host runs on its own, on a schedule, after
/// other work, or when a session settles; what needs your decision first, then what may not
/// have arrived, then every job. A job opens on its runs and its actions.
struct JobsView: View {
    @State var model: JobsModel
    let scene: SceneModel
    let hub: HubStore
    @State private var editing: JobEditing?
    @State private var cancelling: JobDTO?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    var body: some View {
        let state = hub.jobs ?? JobsStateDTO()
        NavigationStack {
            List {
                Group {
                    if let error = model.error {
                        Banner(text: error, tone: .error, action: model.loaded ? ("OK", { model.clearError() }) : ("Retry", { Task { await model.load() } }))
                            .formBanner()
                    }
                    if !state.waiting.isEmpty {
                        Section {
                            ForEach(state.waiting, id: \.runId) { decision in JobDecisionCard(decision: decision, model: model) }
                        } header: {
                            AhSectionHeader(title: "Needs your decision", count: state.waiting.count)
                        }
                    }
                    if !state.uncertain.isEmpty {
                        Section {
                            ForEach(state.uncertain, id: \.runId) { run in uncertainRow(run) }
                        } header: {
                            AhSectionHeader(title: "Not sure it arrived", count: state.uncertain.count)
                        } footer: {
                            Text("The host stopped while delivering these. Check the session, then send again or leave it.")
                        }
                    }
                    if !model.loaded && model.error == nil {
                        ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear).afterABeat(.milliseconds(300))
                    } else if model.loaded && model.jobs.isEmpty {
                        EmptyState(symbol: "calendar.badge.clock", title: "No Jobs", message: "A job starts an agent or messages a session at a time, every morning, or after another job. It runs on the host, with this app closed.", action: ("New Job", { editing = JobEditing(job: nil) }))
                            .listRowBackground(Color.clear)
                    }
                    if !model.jobs.isEmpty {
                        Section {
                            ForEach(model.jobs) { job in
                                NavigationLink(value: job.id) { JobRow(job: job, jobs: model.jobs, presets: presets) }
                                    .swipeActions(edge: .trailing) { swipes(job) }
                                    .contextMenu { menu(job) }
                            }
                        } header: {
                            AhSectionHeader(title: "Jobs", count: model.jobs.count)
                        }
                    }
                }
                .ahRow()
            }
            .ahFormGround()
            .navigationTitle("Jobs")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { id in
                JobDetailView(model: model, id: id, scene: scene, hub: hub, edit: { editing = JobEditing(job: $0) }, cancel: { cancelling = $0 })
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = JobEditing(job: nil) } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New Job")
                }
            }
            .task { await model.load() }
            // The stream carries the summary; the list follows it.
            .onChange(of: hub.jobs) { _, _ in Task { await model.load() } }
            .refreshable { await model.load() }
            .sheet(item: $editing) { e in
                JobEditor(model: model, hub: hub, job: e.job) { saved in
                    editing = nil
                    scene.toast(e.job == nil ? "Added “\(saved.name)”" : "Saved “\(saved.name)”")
                }
            }
            .confirmationDialog("Cancel “\(cancelling?.name ?? "")”?", isPresented: Binding(get: { cancelling != nil }, set: { if !$0 { cancelling = nil } }), titleVisibility: .visible, presenting: cancelling) { job in
                Button("Cancel Job", role: .destructive) { Task { _ = await model.act(job.id, .cancel) } }
                Button("Keep It", role: .cancel) {}
            } message: { _ in
                Text("It won't run again, and runs waiting their turn are cancelled. A run already talking to an agent finishes.")
            }
        }
    }

    private var presets: [PresetDTO] { hub.shownState?.presets ?? [] }

    private func uncertainRow(_ run: JobsStateDTO.Uncertain) -> some View {
        HStack(spacing: 12) {
            Image(systemName: "questionmark.circle").foregroundStyle(theme.limited).accessibilityHidden(true)
            Text(run.name).font(.ah(.callout)).frame(maxWidth: .infinity, alignment: .leading)
            Button("Send Again") { Task { _ = await model.resolve(run: run.runId, resend: true) } }
                .buttonStyle(.bordered).controlSize(.small)
            Button("Leave It") { Task { _ = await model.resolve(run: run.runId, resend: false) } }
                .buttonStyle(.borderless).controlSize(.small)
        }
        .disabled(model.busy.contains(run.runId))
    }

    @ViewBuilder
    private func swipes(_ job: JobDTO) -> some View {
        let verbs = JobsModel.verbs(for: job.state)
        if verbs.contains(.run) {
            Button { Task { _ = await model.act(job.id, .run) } } label: { Image(systemName: "play.fill") }.accessibilityLabel("Run Now").tint(theme.run)
        }
        if verbs.contains(.resume) {
            Button { Task { _ = await model.act(job.id, .resume) } } label: { Image(systemName: "playpause.fill") }.accessibilityLabel("Resume").tint(theme.done)
        } else if verbs.contains(.pause) {
            Button { Task { _ = await model.act(job.id, .pause) } } label: { Image(systemName: "pause.fill") }.accessibilityLabel("Pause").tint(theme.limited)
        }
    }

    @ViewBuilder
    private func menu(_ job: JobDTO) -> some View {
        JobActions(job: job, model: model, edit: { editing = JobEditing(job: $0) }, cancel: { cancelling = $0 })
    }
}

/// The job being edited (nil: a new one), as a sheet's item.
struct JobEditing: Identifiable {
    let job: JobDTO?
    var id: String { job?.id ?? "new" }
}

/// A job's actions, as a menu's buttons: Run Now, Pause or Resume, Edit, Cancel.
struct JobActions: View {
    let job: JobDTO
    let model: JobsModel
    let edit: (JobDTO) -> Void
    let cancel: (JobDTO) -> Void
    /// A menu's divider before Cancel (a list's rows have their own separators).
    var divided = true

    var body: some View {
        let verbs = JobsModel.verbs(for: job.state)
        if verbs.contains(.run) { Button("Run Now", systemImage: "play") { Task { _ = await model.act(job.id, .run) } } }
        if verbs.contains(.resume) { Button("Resume", systemImage: "playpause") { Task { _ = await model.act(job.id, .resume) } } }
        if verbs.contains(.pause) { Button("Pause", systemImage: "pause") { Task { _ = await model.act(job.id, .pause) } } }
        if JobsModel.editable(job) { Button("Edit…", systemImage: "pencil") { edit(job) } }
        if verbs.contains(.cancel) {
            if divided { Divider() }
            Button("Cancel Job…", systemImage: "xmark.circle", role: .destructive) { cancel(job) }
        }
    }
}

/// A job in the list: its name, when and what, its next run, and its state.
struct JobRow: View {
    let job: JobDTO
    let jobs: [JobDTO]
    let presets: [PresetDTO]
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).foregroundStyle(tint).frame(width: 22).padding(.top, 2).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(job.name).font(.ah(.headline)).foregroundStyle(theme.text).lineLimit(2)
                Text("\(JobsModel.triggerWords(job.trigger, jobs: jobs)) · \(JobsModel.actionWords(job.action, presets: presets))")
                    .font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(2)
                if let next = job.nextRunAt, job.state == "scheduled" {
                    Text("Next \(JobsModel.when(next))").font(.ah(.caption)).foregroundStyle(theme.faint)
                } else if let last = job.lastRun {
                    Text("Last: \(JobsModel.runWord(last.state).lowercased())\(last.startedAt.map { ", \(JobsModel.ago($0))" } ?? "")").font(.ah(.caption)).foregroundStyle(theme.faint)
                }
            }
            Spacer(minLength: 4)
            StatusTag(text: JobsModel.stateWord(job.state), color: tint)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var symbol: String {
        switch job.action {
        case .launch: return "play.circle"
        case .send: return "arrow.up.message"
        case .decide: return "flag"
        case .unknown: return "questionmark.circle"
        }
    }

    private var tint: Color {
        switch job.state {
        case "waiting": return theme.accent
        case "failed": return theme.danger
        case "paused": return theme.limited
        case "done", "cancelled": return theme.faint
        default: return theme.run
        }
    }
}

/// A scheduled workflow waiting on you: what it asks, what led here, and the two answers.
/// Going ahead runs its follow-up. In Jobs and in the Inbox's "Needs you".
struct JobDecisionCard: View {
    let decision: JobsStateDTO.Waiting
    let model: JobsModel
    @Environment(\.theme) private var theme
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: "flag.fill").foregroundStyle(theme.accent).accessibilityHidden(true)
                Text(decision.title).font(.ah(.headline)).foregroundStyle(theme.text)
            }
            if !decision.body.isEmpty {
                Text(expanded || decision.body.count <= 600 ? decision.body : String(decision.body.prefix(600)) + "…")
                    .font(.ah(.callout)).foregroundStyle(theme.text2)
                    .textSelection(.enabled)
                if decision.body.count > 600 {
                    Button(expanded ? "Show Less" : "Show All") { withAnimation(.snappy) { expanded.toggle() } }
                        .font(.ah(.caption).weight(.semibold)).buttonStyle(.borderless)
                }
            }
            HStack(spacing: 10) {
                // Each answer on one line; the job's name gives way first.
                Button("Go Ahead") { Task { _ = await model.decide(run: decision.runId, approve: true) } }
                    .buttonStyle(.borderedProminent).tint(theme.accentStrong)
                    .lineLimit(1).fixedSize()
                Button("Stop Here") { Task { _ = await model.decide(run: decision.runId, approve: false) } }
                    .buttonStyle(.bordered).tint(.primary)
                    .lineLimit(1).fixedSize()
                Spacer(minLength: 4)
                Text(decision.name).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1).layoutPriority(-1)
            }
            .disabled(model.busy.contains(decision.runId))
        }
        .padding(.vertical, 6)
        // As the Inbox's ask cards: what needs you is the pink-edged thing on the page.
        .listRowBackground(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.accentTint).overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.accentLine, lineWidth: 1)))
        .accessibilityElement(children: .contain)
    }
}

/// One job: what it does and when, its actions, and its runs, newest first.
struct JobDetailView: View {
    let model: JobsModel
    let id: String
    let scene: SceneModel
    let hub: HubStore
    let edit: (JobDTO) -> Void
    let cancel: (JobDTO) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        List {
            Group {
                if let job = model.job(id) {
                    Section {
                        LabeledContent("When", value: JobsModel.triggerWords(job.trigger, jobs: model.jobs))
                        LabeledContent("Does", value: JobsModel.actionWords(job.action, presets: hub.shownState?.presets ?? []))
                        if let next = job.nextRunAt, job.state == "scheduled" { LabeledContent("Next run", value: JobsModel.when(next)) }
                        LabeledContent("State", value: JobsModel.stateWord(job.state))
                        LabeledContent("Runs so far", value: "\(job.runCount)")
                    }
                    what(job)
                    if let policy = policyWords(job.policy) {
                        Section("How it runs") { Text(policy).font(.ah(.callout)).foregroundStyle(theme.text2) }
                    }
                    Section {
                        JobActions(job: job, model: model, edit: edit, cancel: cancel, divided: false)
                            .disabled(model.busy.contains(job.id))
                    }
                    Section {
                        if let runs = model.runs[id] {
                            if runs.isEmpty { Text("It hasn't run yet.").foregroundStyle(theme.muted) }
                            ForEach(runs.prefix(30)) { run in runRow(run) }
                        } else {
                            ProgressView().frame(maxWidth: .infinity).afterABeat(.milliseconds(300))
                        }
                    } header: {
                        AhSectionHeader(title: "Runs", count: model.runs[id]?.count)
                    }
                } else {
                    EmptyState(symbol: "calendar.badge.exclamationmark", title: "That Job Is Gone", message: "It was removed on the host.")
                        .listRowBackground(Color.clear)
                }
            }
            .ahRow()
        }
        .ahFormGround()
        .navigationTitle(model.job(id)?.name ?? "Job")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadRuns(id) }
        .onChange(of: hub.jobs) { _, _ in Task { await model.loadRuns(id) } }
        .refreshable { await model.loadRuns(id) }
    }

    @ViewBuilder
    private func what(_ job: JobDTO) -> some View {
        switch job.action {
        case .launch(let launch):
            Section("Starts") { launchRows(launch) }
        case .send(let target, let text):
            Section("Sends to \(sessionName(target))") { Text(text).font(.ah(.callout)).textSelection(.enabled) }
        case .decide(let title, let body, let then):
            Section("Asks you") {
                Text(title).font(.ah(.callout).weight(.semibold))
                if let body, !body.isEmpty { Text(body).font(.ah(.callout)).foregroundStyle(theme.text2) }
            }
            switch then {
            case .launch(let launch): Section("Then starts") { launchRows(launch) }
            case .send(let target, let text): Section("Then sends to \(sessionName(target))") { Text(text).font(.ah(.callout)) }
            case nil: EmptyView()
            }
        case .unknown(let kind):
            Section { Text("A job of a kind this app doesn't know (\(kind)).").foregroundStyle(theme.muted) }
        }
    }

    @ViewBuilder
    private func launchRows(_ launch: JobLaunchDTO) -> some View {
        LabeledContent("Agent", value: hub.shownState?.presets.first { $0.id == launch.preset }?.name ?? launch.preset)
        LabeledContent("Folder") { Text(launch.cwd).font(.ahMono(.caption)).lineLimit(1).truncationMode(.head) }
        if let model = launch.model { LabeledContent("Model", value: model) }
        if let effort = launch.effort { LabeledContent("Effort", value: effort) }
        if launch.worktree == true { LabeledContent("Worktree", value: "Its own") }
        Text(launch.prompt).font(.ah(.callout)).textSelection(.enabled)
    }

    private func runRow(_ run: JobRunDTO) -> some View {
        HStack(alignment: .top, spacing: 10) {
            StatusTag(text: JobsModel.runWord(run.state), color: runTint(run.state)).padding(.top, 2)
            Text(JobsModel.runDetail(run)).font(.ah(.caption)).foregroundStyle(theme.text2).frame(maxWidth: .infinity, alignment: .leading).lineLimit(3)
            if let uid = run.sessionUid, hub.row(uid) != nil || hub.history.contains(where: { $0.id == uid || $0.dto.ref == uid }) {
                Button("Open") { open(uid) }.buttonStyle(.bordered).controlSize(.small)
            }
        }
        .padding(.vertical, 2)
    }

    private func runTint(_ state: String) -> Color {
        switch state {
        case "failed", "uncertain": return theme.danger
        case "waiting": return theme.accent
        case "running", "eligible": return theme.run
        case "succeeded": return theme.done
        default: return theme.faint
        }
    }

    private func sessionName(_ target: String) -> String { hub.row(target)?.title ?? target }

    private func policyWords(_ p: JobPolicyDTO) -> String? {
        var parts: [String] = []
        if let r = p.retries, r > 0 { parts.append("Retries \(r) time\(r == 1 ? "" : "s") if it fails") }
        if let t = p.timeoutSeconds, t > 0 { parts.append("Fails after \(t / 60) minute\(t / 60 == 1 ? "" : "s")") }
        if let m = p.maxRuns, m > 0 { parts.append("Stops after \(m) run\(m == 1 ? "" : "s")") }
        if p.until == "delivered" { parts.append("Done once the agent has the message") }
        if p.notify == true { parts.append("Tells your devices when it finishes") }
        if p.autoRecover == true { parts.append("Keeps the agent going through limits and crashes") }
        if p.allowDangerous == true { parts.append("Allowed a mode that skips permissions") }
        return parts.isEmpty ? nil : parts.joined(separator: ". ") + "."
    }

    private func open(_ uid: String) {
        scene.sheet = nil
        scene.open(uid)
    }
}

// MARK: New and Edit Job

/// A new job, or one to change: what it does, when, and how it runs.
struct JobEditor: View {
    let model: JobsModel
    let hub: HubStore
    let job: JobDTO?
    let done: (JobDTO) -> Void
    @State private var draft = JobDraft()
    @State private var projects: [String] = []
    @State private var saving = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    private var agents: [PresetDTO] {
        (hub.shownState?.presets ?? []).filter { $0.available && $0.hidden != true && !$0.command.isEmpty && $0.id != "shell" }
    }
    private var sessions: [SessionRow] { hub.rows.filter { $0.isLocal && $0.dto.agent != nil } }
    private var preset: PresetDTO? { agents.first { $0.id == draft.preset } }
    private var otherJobs: [JobDTO] { model.jobs.filter { $0.id != job?.id } }

    var body: some View {
        NavigationStack {
            AhForm {
                if let error = model.error { Banner(text: error, tone: .error).formBanner() }
                Section {
                    Picker("Does", selection: $draft.kind) {
                        Text("Start an Agent").tag(JobDraft.Kind.launch)
                        Text("Message a Session").tag(JobDraft.Kind.send)
                        Text("Ask Me First").tag(JobDraft.Kind.decide)
                    }
                    TextField("Name", text: $draft.name, prompt: Text(draft.shownName == "Job" ? "Nightly tests" : draft.shownName))
                }
                if draft.kind == .decide {
                    Section {
                        TextField("What to ask you", text: $draft.title, prompt: Text("Deploy to staging?"))
                        TextField("More about it", text: $draft.body, prompt: Text("Optional"), axis: .vertical).lineLimit(2...6)
                        Picker("If you go ahead", selection: $draft.followUp) {
                            Text("Start an Agent").tag(JobDraft.FollowUp.launch)
                            Text("Message a Session").tag(JobDraft.FollowUp.send)
                            Text("Nothing Else").tag(JobDraft.FollowUp.none)
                        }
                    } header: {
                        Text("Your decision")
                    } footer: {
                        Text("It waits in your Inbox until you answer.")
                    }
                }
                if draft.kind == .launch || (draft.kind == .decide && draft.followUp == .launch) { launchSection }
                if draft.kind == .send || (draft.kind == .decide && draft.followUp == .send) { sendSection }
                whenSection
                Section {
                    Stepper(draft.retries == 0 ? "No retries" : "Retry \(draft.retries) time\(draft.retries == 1 ? "" : "s")", value: $draft.retries, in: 0...10)
                    Stepper(draft.timeoutMinutes == 0 ? "No time limit" : "Fails after \(draft.timeoutMinutes) min", value: $draft.timeoutMinutes, in: 0...1440, step: 15)
                    Stepper(draft.maxRuns == 0 ? "Runs every time" : "Stops after \(draft.maxRuns) run\(draft.maxRuns == 1 ? "" : "s")", value: $draft.maxRuns, in: 0...1000)
                    Toggle("Done once the agent has the message", isOn: $draft.untilDelivered)
                    Toggle("Tell my devices when it finishes", isOn: $draft.notify)
                    Toggle("Keep the agent going through limits", isOn: $draft.autoRecover)
                    if dangerousMode { Toggle("Allow a mode that skips permissions", isOn: $draft.allowDangerous) }
                } header: {
                    Text("How it runs")
                }
            }
            .navigationTitle(job == nil ? "New Job" : "Edit Job")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(job == nil ? (draft.when == .now ? "Start" : "Schedule") : "Save") { save() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(draft.missing != nil || saving)
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if let missing = draft.missing {
                    Text(missing).font(.ah(.caption)).foregroundStyle(theme.muted).padding(.vertical, 8).frame(maxWidth: .infinity).background(.bar)
                }
            }
        }
        .onAppear(perform: start)
        .task { projects = (try? await hub.api.projects()) ?? [] }
    }

    private var launchSection: some View {
        Section {
            Picker("Agent", selection: $draft.preset) {
                ForEach(agents, id: \.id) { Text($0.name).tag($0.id) }
            }
            .onChange(of: draft.preset) { _, _ in draft.model = nil; draft.effort = nil; draft.mode = nil }
            HStack {
                TextField("Folder", text: $draft.cwd, prompt: Text("~/code/project"))
                    .font(.ahMono(.callout))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !projects.isEmpty {
                    Menu {
                        ForEach(projects.prefix(20), id: \.self) { path in Button((path as NSString).lastPathComponent) { draft.cwd = path } }
                    } label: { Image(systemName: "folder") }
                        .accessibilityLabel("Projects")
                }
            }
            TextField("What to ask", text: $draft.prompt, prompt: Text("Run the test suite and fix what fails."), axis: .vertical).lineLimit(3...10)
            if let models = preset?.models, !models.isEmpty {
                Picker("Model", selection: $draft.model) {
                    Text("Default").tag(String?.none)
                    ForEach(models, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                }
            }
            if let efforts = efforts, !efforts.isEmpty {
                Picker("Effort", selection: $draft.effort) {
                    Text("Default").tag(String?.none)
                    ForEach(efforts, id: \.self) { Text($0.capitalized).tag(Optional($0)) }
                }
            }
            if let modes = preset?.modes, !modes.isEmpty {
                Picker("Permissions", selection: $draft.mode) {
                    Text("Default").tag(String?.none)
                    ForEach(modes, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                }
            }
            Toggle("Its own worktree", isOn: $draft.worktree)
        } header: {
            Text(draft.kind == .decide ? "Then start" : "Start")
        }
    }

    private var sendSection: some View {
        Section {
            Picker("Session", selection: $draft.target) {
                Text("Choose…").tag("")
                ForEach(sessions) { Text($0.title).tag($0.uid) }
                if !draft.target.isEmpty && !sessions.contains(where: { $0.uid == draft.target }) { Text(draft.target).tag(draft.target) }
            }
            TextField("Message", text: $draft.text, prompt: Text("Pull main and rerun the checks."), axis: .vertical).lineLimit(2...8)
        } header: {
            Text(draft.kind == .decide ? "Then send" : "Send")
        }
    }

    private var whenSection: some View {
        Section {
            Picker("When", selection: $draft.when) {
                if job == nil { Text("Now").tag(JobDraft.When.now) }
                Text("At a Time").tag(JobDraft.When.at)
                Text("Every Day").tag(JobDraft.When.daily)
                Text("Weekdays").tag(JobDraft.When.weekdays)
                Text("On a Schedule").tag(JobDraft.When.cron)
                if !otherJobs.isEmpty || draft.when == .after { Text("After Another Job").tag(JobDraft.When.after) }
                if !sessions.isEmpty || draft.when == .session { Text("When a Session Settles").tag(JobDraft.When.session) }
                Text("Only When I Run It").tag(JobDraft.When.manual)
            }
            switch draft.when {
            case .at:
                DatePicker("Date", selection: $draft.at, in: Date()..., displayedComponents: [.date, .hourAndMinute])
            case .daily, .weekdays:
                DatePicker("Time", selection: timeOfDay, displayedComponents: .hourAndMinute)
            case .cron:
                TextField("Schedule", text: $draft.cronExpr, prompt: Text("0 9 * * 1-5"))
                    .font(.ahMono(.callout))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            case .after:
                Picker("After", selection: $draft.afterJob) {
                    Text("Choose…").tag("")
                    ForEach(otherJobs) { Text($0.name).tag($0.id) }
                }
                Picker("When it", selection: $draft.afterOn) {
                    Text("Succeeds").tag("success")
                    Text("Fails").tag("failure")
                    Text("Ends Either Way").tag("any")
                }
            case .session:
                Picker("Session", selection: $draft.sessionUid) {
                    Text("Choose…").tag("")
                    ForEach(sessions) { Text($0.title).tag($0.uid) }
                }
                Picker("When it", selection: $draft.sessionOn) {
                    Text("Finishes a Turn").tag("idle")
                    Text("Ends").tag("ended")
                }
            case .now, .manual:
                EmptyView()
            }
        } header: {
            Text("When")
        } footer: {
            switch draft.when {
            case .cron: Text("Minute, hour, day of the month, month, day of the week, in \(draft.timeZone).")
            case .daily, .weekdays: Text("In \(draft.timeZone).")
            case .now: Text("Once, right away.")
            default: EmptyView()
            }
        }
    }

    private var efforts: [String]? {
        if let model = draft.model, let m = preset?.models?.first(where: { $0.id == model }), let e = m.efforts { return e }
        return preset?.effort?.levels
    }

    private var dangerousMode: Bool {
        guard let mode = draft.mode else { return draft.allowDangerous }
        return preset?.modes?.first { $0.id == mode }?.dangerous == true || draft.allowDangerous
    }

    private var timeOfDay: Binding<Date> {
        Binding {
            Calendar.current.date(bySettingHour: draft.hour, minute: draft.minute, second: 0, of: Date()) ?? Date()
        } set: { date in
            let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
            draft.hour = parts.hour ?? 9
            draft.minute = parts.minute ?? 0
        }
    }

    private func start() {
        model.clearError()
        if let job, let existing = JobDraft(job) {
            draft = existing
            return
        }
        // A new job: the first agent, in the folder an agent works in now (or home).
        let cwd = hub.rows.first { $0.isLocal && $0.dto.agent != nil }?.dto.cwd ?? hub.shownState?.home ?? "~"
        draft = JobDraft(preset: agents.first?.id ?? "", cwd: cwd)
    }

    private func save() {
        saving = true
        Task {
            let result: JobDTO? = if let job { await model.update(job.id, draft) } else { await model.create(draft) }
            if let result { done(result) }
            saving = false
        }
    }
}
