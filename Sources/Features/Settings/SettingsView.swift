import SwiftUI
import UIKit

/// Settings: the nine sections of the web's Settings, plus this device's accounts. A split on
/// iPad, a push list on iPhone.
struct SettingsView: View {
    let scene: SceneModel
    @State var section: SettingsSection?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        NavigationSplitView {
            List(selection: $section) {
                Section("This device") {
                    NavigationLink(value: SettingsSection.security) { Label("Hosts and security", systemImage: "lock.shield") }
                }
                Section("Agent Hub") {
                    ForEach(SettingsSection.allCases.filter { $0 != .security }, id: \.self) { s in
                        NavigationLink(value: s) {
                            VStack(alignment: .leading, spacing: 2) {
                                Label(s.title, systemImage: s.symbol)
                                Text(s.summary).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        } detail: {
            NavigationStack {
                if let section, let account = scene.account {
                    SettingsDetail(section: section, scene: scene, account: account)
                } else if scene.account == nil {
                    EmptyState(symbol: "server.rack", title: "No host yet", message: "Add a host to manage its settings.")
                } else {
                    EmptyState(symbol: "gearshape", title: "Pick a section", message: "")
                }
            }
        }
        .onAppear { if section == nil && sizeClass == .regular { section = .security } }
    }
}

private struct SettingsDetail: View {
    let section: SettingsSection
    let scene: SceneModel
    let account: AccountSession

    var body: some View {
        Group {
            switch section {
            case .security: SecuritySection(scene: scene, account: account)
            case .appearance: AppearanceSection(app: scene.app)
            case .shortcuts: ShortcutsSection(app: scene.app)
            case .notifications: NotificationsSection(app: scene.app, api: account.api)
            case .agents: AgentsSection(model: AgentsSettings(api: account.api))
            case .subscriptions: SubscriptionsSection(model: SubscriptionsSettings(api: account.api))
            case .environment: EnvironmentSection(model: EnvironmentSettings(api: account.api))
            case .search: SearchSection(model: SearchSettings(api: account.api))
            case .system: SystemSection(model: SystemSettings(api: account.api), scene: scene)
            }
        }
        .navigationTitle(section == .security ? "Hosts and security" : section.title)
        .id("\(account.origin)|\(section.rawValue)")
    }
}

// MARK: Security

private struct SecuritySection: View {
    let scene: SceneModel
    let account: AccountSession
    @State private var model: SecuritySettings
    @State private var confirmRemove = false
    @State private var confirmOthers = false
    @Environment(\.theme) private var theme

    init(scene: SceneModel, account: AccountSession) {
        self.scene = scene
        self.account = account
        _model = State(initialValue: SecuritySettings(api: account.api))
    }

    var body: some View {
        Form {
            if let error = model.error { Banner(text: error, tone: .error) }
            if let notice = model.notice { Banner(text: notice) }
            Section("Hosts on this device") {
                ForEach(scene.app.accounts) { other in
                    Button {
                        scene.useAccount(other.origin)
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(other.hostname).foregroundStyle(theme.text)
                                Text(other.origin).font(.caption.monospaced()).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            if other.origin == account.origin { Image(systemName: "checkmark").foregroundStyle(theme.brand) }
                            Text(statusWord(other.status)).font(.caption).foregroundStyle(theme.muted)
                        }
                    }
                }
                Button("Add a host…", systemImage: "plus") { scene.sheet = .setup }
            }
            Section {
                LabeledContent("Enrolled as", value: account.account.label)
                LabeledContent("Device ID", value: String(account.account.deviceId.prefix(12)))
                Button("Lock now", systemImage: "lock") { Task { await account.lock() } }
                Button("Remove this device from \(account.hostname)…", systemImage: "trash", role: .destructive) { confirmRemove = true }
            } header: {
                Text("This device on \(account.hostname)")
            } footer: {
                Text("Locking ends this sign-in; Face ID signs back in. Removing ends every sign-in from this device and deletes its key.")
            }
            Section {
                if let code = model.code {
                    HStack {
                        Text(code.code).font(.system(.title, design: .monospaced).weight(.semibold)).textSelection(.enabled)
                        Spacer()
                        Button("Copy") { UIPasteboard.general.string = code.code }
                    }
                    Text("Valid for \(code.ttlMinutes) minutes, once.").font(.caption).foregroundStyle(theme.muted)
                }
                Button(model.code == nil ? "Issue a setup code" : "Issue a new code", systemImage: "number") { Task { await model.newCode() } }
            } header: {
                Text("Add another device")
            } footer: {
                Text("Enter the code in the new device’s app (or on its sign-in page). Codes come only from a device that’s already signed in.")
            }
            if let overview = model.overview {
                Section("Signed in") {
                    ForEach(overview.sessions) { signIn in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(signIn.label + (signIn.current ? " (this one)" : ""))
                                Text("\(signIn.via) · last seen \(Elapsed.format(Date(timeIntervalSince1970: signIn.lastSeenAt / 1000), now: .now))").font(.caption).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            if !signIn.current { Button("Sign out") { Task { await model.revoke(signIn) } }.buttonStyle(.borderless) }
                        }
                    }
                    Button("Sign out every other device", role: .destructive) { confirmOthers = true }
                }
                if let devices = overview.devices, !devices.isEmpty {
                    Section("Enrolled devices") {
                        ForEach(devices) { device in
                            HStack {
                                Text(device.label + (device.current ? " (this one)" : ""))
                                Spacer()
                                if !device.current { Button("Remove", role: .destructive) { Task { await model.removeDevice(device) } }.buttonStyle(.borderless) }
                            }
                        }
                    }
                }
                if !overview.passkeys.isEmpty {
                    Section("Passkeys (web)") {
                        ForEach(overview.passkeys) { passkey in
                            HStack {
                                Text(passkey.label)
                                Spacer()
                                Button("Remove", role: .destructive) { Task { await model.removePasskey(passkey) } }.buttonStyle(.borderless)
                            }
                        }
                    }
                }
                if !overview.tokens.isEmpty {
                    Section("API tokens") {
                        ForEach(overview.tokens) { token in
                            HStack {
                                Text(token.name)
                                Spacer()
                                Button("Revoke", role: .destructive) { Task { await model.removeToken(token) } }.buttonStyle(.borderless)
                            }
                        }
                    }
                }
                Section {
                    LabeledContent("Master password", value: overview.password ? "Set" : "Not set")
                    LabeledContent("Sign-ins last", value: "\(Int(overview.maxDays)) days, or \(Int(overview.idleHours)) hours idle")
                } header: {
                    Text("Host policy")
                } footer: {
                    Text("The master password is set or removed on the host itself (`ah auth password`).")
                }
                Section("Activity") {
                    ForEach(Array(model.activity.prefix(60).enumerated()), id: \.offset) { _, row in
                        VStack(alignment: .leading, spacing: 2) {
                            HStack { Text(row.event).font(.callout); Spacer(); Text(row.at).font(.caption2).foregroundStyle(theme.faint) }
                            if !row.detail.isEmpty { Text(row.detail).font(.caption).foregroundStyle(theme.muted).lineLimit(2) }
                        }
                    }
                }
            }
            Section {
                Button("Clear prompt history", role: .destructive) { Task { await model.clearPrompts() } }
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .confirmationDialog("Remove this device?", isPresented: $confirmRemove, titleVisibility: .visible) {
            Button("Remove", role: .destructive) {
                Task {
                    do { try await account.removeDevice() } catch { scene.toast(APIError.wrap(error).message, error: true) }
                }
            }
        } message: {
            Text("Every sign-in from this device ends and its key is deleted. You’ll need a new setup code to add it back.")
        }
        .confirmationDialog("Sign out every other device?", isPresented: $confirmOthers, titleVisibility: .visible) {
            Button("Sign out others", role: .destructive) { Task { await model.signOutOthers() } }
        }
    }

    private func statusWord(_ status: AccountSession.Status) -> String {
        switch status {
        case .signedIn: return "Signed in"
        case .signingIn: return "Signing in…"
        case .needsSignIn: return "Locked"
        case .unenrolled: return "Removed"
        }
    }
}

// MARK: Appearance

private struct AppearanceSection: View {
    @Bindable var app: AppModel

    var body: some View {
        Form {
            Picker("Appearance", selection: $app.preferences.appearance) {
                ForEach(DevicePreferences.Appearance.allCases, id: \.self) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
            Section("Reading") {
                Toggle("Hide tool steps in transcripts", isOn: $app.preferences.stepsHidden)
                Picker("Group the Inbox by", selection: $app.preferences.inboxGrouping) {
                    Text("Status").tag(DevicePreferences.InboxGrouping.status)
                    Text("Project").tag(DevicePreferences.InboxGrouping.project)
                    Text("Host").tag(DevicePreferences.InboxGrouping.host)
                }
            }
            Section("Terminal") {
                Stepper("Font size \(Int(app.preferences.terminalFontSize))", value: $app.preferences.terminalFontSize, in: 9...24, step: 1)
                Toggle("Show the key bar", isOn: $app.preferences.keyBarVisible)
            }
            Section {
                TextField("Device name", text: Binding(get: { app.preferences.deviceName ?? "" }, set: { app.preferences.deviceName = $0.isEmpty ? nil : $0 }), prompt: Text(app.services.device.name))
            } header: {
                Text("This device’s name")
            } footer: {
                Text("What other devices see when this one has a session open.")
            }
        }
    }
}

// MARK: Shortcuts

private struct ShortcutsSection: View {
    @Bindable var app: AppModel
    @State private var query = ""
    @State private var recording: CommandID?
    @State private var error: String?
    @State private var confirmReset = false
    @Environment(\.theme) private var theme

    var body: some View {
        List {
            if let error { Banner(text: error, tone: .error) }
            ForEach([CommandGroup.navigate, .session, .workspace], id: \.self) { group in
                Section(group.rawValue) {
                    ForEach(CommandCatalog.all.filter { $0.group == group && matches($0) }) { command in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(command.label)
                                Text(command.detail).font(.caption).foregroundStyle(theme.muted).lineLimit(2)
                            }
                            Spacer()
                            if recording == command.id {
                                ChordRecorder { chord in
                                    recording = nil
                                    guard let chord else { return }
                                    error = app.keyBindings.set(command.id, chord)
                                }
                                .frame(width: 140, height: 30)
                            } else {
                                let chords = app.keyBindings.chords(command.id)
                                Button {
                                    error = nil
                                    recording = command.id
                                } label: {
                                    if chords.isEmpty { Text("Set").font(.caption) } else { Keycaps(chords[0]) }
                                }
                                .buttonStyle(.borderless)
                            }
                        }
                        .swipeActions {
                            Button("Reset") { app.keyBindings.reset(command.id) }
                            Button("Clear", role: .destructive) { error = app.keyBindings.set(command.id, nil) }
                        }
                    }
                }
            }
            Section {
                Button("Reset every shortcut", role: .destructive) { confirmReset = true }
            } footer: {
                Text("A shortcut needs ⌘, ⌃ or ⌥, and never takes a key a text box or the terminal needs.")
            }
        }
        .searchable(text: $query)
        .onChange(of: app.keyBindings) { _, _ in UIMenuSystem.main.setNeedsRebuild() }
        .confirmationDialog("Reset every shortcut to its default?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset all", role: .destructive) { app.keyBindings.resetAll() }
        }
    }

    private func matches(_ c: Command) -> Bool {
        query.isEmpty || c.label.localizedCaseInsensitiveContains(query) || c.terms.contains { $0.localizedCaseInsensitiveContains(query) }
    }
}

/// Captures the next chord from a hardware keyboard (Escape cancels).
struct ChordRecorder: UIViewRepresentable {
    let done: (Chord?) -> Void

    func makeUIView(context: Context) -> RecorderView {
        let view = RecorderView()
        view.done = done
        DispatchQueue.main.async { view.becomeFirstResponder() }
        return view
    }

    func updateUIView(_ view: RecorderView, context: Context) { view.done = done }

    final class RecorderView: UILabel {
        var done: (Chord?) -> Void = { _ in }

        override init(frame: CGRect) {
            super.init(frame: frame)
            text = "Press a shortcut…"
            font = .preferredFont(forTextStyle: .caption1)
            textAlignment = .center
            isUserInteractionEnabled = true
            layer.cornerRadius = 6
            layer.borderWidth = 1
            layer.borderColor = UIColor.tintColor.cgColor
            accessibilityLabel = "Press a shortcut, or Escape to cancel"
        }

        required init?(coder: NSCoder) { fatalError() }

        override var canBecomeFirstResponder: Bool { true }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            guard let key = presses.first?.key else { return super.pressesBegan(presses, with: event) }
            let press = KeyPress(key)
            if KeyPress.modifierUsages.contains(press.hidUsage) { return }
            if press.key == "Escape" && press.modifiers.isEmpty {
                done(nil)
                return
            }
            done(press.chord)
        }
    }
}

// MARK: Notifications

private struct NotificationsSection: View {
    @Bindable var app: AppModel
    @State private var model: NotificationSettings
    private let push = PushRegistrar.shared
    @Environment(\.theme) private var theme

    init(app: AppModel, api: APIClient) {
        self.app = app
        _model = State(initialValue: NotificationSettings(api: api))
    }

    var body: some View {
        Form {
            if let error = model.error ?? push.lastError { Banner(text: error, tone: .error) }
            if let status = model.status, !status.configured {
                Banner(text: "This host has no APNs key configured, so it can’t notify this device yet. Its owner adds one under `apns` in the host’s config.", tone: .warning)
            }
            if push.authorization == .denied {
                Banner(text: "Notifications are off for Agent Hub in iOS Settings.", tone: .warning, action: ("Open Settings", {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                }))
            }
            Section {
                Toggle("Notify this device", isOn: Binding(get: { app.preferences.notifications.enabled }, set: { on in
                    app.preferences.notifications.enabled = on
                    Task {
                        if on { _ = await push.enable() }
                        await push.sync(app)
                        await model.load()
                    }
                }))
                Toggle("When a session needs you", isOn: binding(\.needsYou)).disabled(!app.preferences.notifications.enabled)
                Toggle("When a session finishes", isOn: binding(\.finished)).disabled(!app.preferences.notifications.enabled)
                Toggle("Hide what it says on the lock screen", isOn: binding(\.privatePreview)).disabled(!app.preferences.notifications.enabled)
            } footer: {
                Text("Approve and Deny appear on a notification only for a plain permission prompt, and need the device unlocked. The icon badge counts sessions waiting on you.")
            }
            if let registration = model.status?.registration {
                Section("Registered with this host") {
                    LabeledContent("Environment", value: registration.environment)
                    LabeledContent("Preview", value: registration.preview)
                    LabeledContent("Since", value: Elapsed.format(Date(timeIntervalSince1970: registration.at / 1000), now: .now))
                }
            }
        }
        .task {
            await push.refreshAuthorization()
            await model.load()
        }
    }

    private func binding(_ key: WritableKeyPath<DevicePreferences.Notifications, Bool>) -> Binding<Bool> {
        Binding(get: { app.preferences.notifications[keyPath: key] }, set: { value in
            app.preferences.notifications[keyPath: key] = value
            Task { await push.sync(app); await model.load() }
        })
    }
}

// MARK: Agents

private struct AgentsSection: View {
    @State var model: AgentsSettings
    @State private var adding = false
    @State private var name = ""
    @State private var command = ""
    @State private var resume = ""
    @Environment(\.theme) private var theme

    var body: some View {
        Form {
            if let error = model.error { Banner(text: error, tone: .error) }
            if let harnesses = model.harnesses {
                Section {
                    ForEach(harnesses.agents) { agent in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                AgentMark(agent: agent.id, size: 20)
                                Text(agent.name)
                                if let version = agent.version { Text(version).font(.caption.monospaced()).foregroundStyle(theme.muted) }
                                Spacer()
                                Toggle("Offer", isOn: Binding(get: { !agent.hidden }, set: { on in Task { await model.setHidden(agent, !on) } })).labelsHidden()
                            }
                            if !agent.installed { Text("Not installed on the host").font(.caption).foregroundStyle(theme.limited) }
                            ForEach(agent.changes, id: \.self) { change in Text("• \(change)").font(.caption).foregroundStyle(theme.muted) }
                        }
                        .swipeActions { if agent.custom { Button("Remove", role: .destructive) { Task { await model.remove(agent) } } } }
                    }
                } header: {
                    Text("Offered in New session")
                }
                Section {
                    Button(model.checking ? "Checking…" : "Check versions", systemImage: "arrow.clockwise") { Task { await model.check() } }.disabled(model.checking)
                    Button("Add an agent…", systemImage: "plus") { adding = true }
                }
                if !harnesses.suggestions.isEmpty {
                    Section("Found on the host") {
                        ForEach(harnesses.suggestions, id: \.command) { s in
                            Button("Add \(s.name) (\(s.command))") { Task { await model.add(name: s.name, command: s.command, resume: nil) } }
                        }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .task { await model.load() }
        .sheet(isPresented: $adding) {
            NavigationStack {
                Form {
                    TextField("Name", text: $name)
                    TextField("Command", text: $command).font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Resume command (optional)", text: $resume).font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .navigationTitle("Add an agent")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { adding = false } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Add") {
                            Task { await model.add(name: name, command: command, resume: resume.isEmpty ? nil : resume); adding = false }
                        }
                        .disabled(name.isEmpty || command.isEmpty)
                    }
                }
            }
            .presentationDetents([.medium])
        }
    }
}

// MARK: Subscriptions

private struct SubscriptionsSection: View {
    @State var model: SubscriptionsSettings
    @State private var editing: SubscriptionDraft?
    @State private var briefing: String?
    @State private var briefingLoaded = false
    @Environment(\.theme) private var theme

    var body: some View {
        Form {
            if let error = model.error { Banner(text: error, tone: .error) }
            Section {
                ForEach(model.list) { s in
                    Button {
                        editing = SubscriptionDraft(id: s.id, name: s.name, baseUrl: s.baseUrl, model: s.model, envName: s.envName)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.name).foregroundStyle(theme.text)
                                Text("\(s.model) · \(s.hasKey ? "key \(s.keyHint)" : "no key")").font(.caption).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            if s.isDefault { Text("Default").font(.caption).foregroundStyle(theme.brand) }
                        }
                    }
                    .swipeActions {
                        Button("Remove", role: .destructive) { Task { await model.remove(s) } }
                        if !s.isDefault { Button("Default") { Task { await model.makeDefault(s) } } }
                    }
                }
                Menu {
                    ForEach(SubscriptionsSettings.presets) { p in
                        Button(p.name) { editing = SubscriptionDraft(name: p.name, baseUrl: p.baseUrl, model: p.model, envName: nil) }
                    }
                    Button("Other (OpenAI-compatible)") { editing = SubscriptionDraft(name: "", baseUrl: "", model: "") }
                } label: {
                    Label("Add a provider", systemImage: "plus")
                }
            } footer: {
                Text("Side chat, the reviewer and summaries use these. Keys are stored on the host and only ever shown masked.")
            }
            if briefingLoaded && !model.list.isEmpty {
                Section {
                    Picker("Review briefings", selection: Binding(get: { briefing }, set: { id in
                        briefing = id
                        Task { _ = try? await ReviewAPI(api: model.api).setSummaryModel(id) }
                    })) {
                        Text("The default subscription").tag(String?.none)
                        ForEach(model.list) { s in Text(s.name).tag(Optional(s.id)) }
                    }
                } footer: {
                    Text("Which model writes a layer’s briefing in Review. The reviewer conversation picks its own.")
                }
            }
        }
        .task {
            await model.load()
            briefing = (try? await ReviewAPI(api: model.api).settings())?.summaryId
            briefingLoaded = true
        }
        .sheet(item: Binding(get: { editing.map { IdentifiedDraft(draft: $0) } }, set: { editing = $0?.draft })) { item in
            SubscriptionEditor(model: model, draft: item.draft) { editing = nil }
        }
    }

    struct IdentifiedDraft: Identifiable {
        var draft: SubscriptionDraft
        var id: String { draft.id ?? "new:\(draft.baseUrl)" }
    }
}

private struct SubscriptionEditor: View {
    let model: SubscriptionsSettings
    @State var draft: SubscriptionDraft
    let close: () -> Void
    @State private var key = ""
    @State private var exportVar = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $draft.name)
                TextField("Base URL", text: $draft.baseUrl).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                Section {
                    SecureField(draft.id == nil ? "API key" : "New API key (leave empty to keep)", text: $key)
                    if let provider = SubscriptionsSettings.provider(for: draft.baseUrl), let url = URL(string: provider.keyURL) {
                        Link("Create a key at \(provider.name)", destination: url)
                    }
                }
                Section("Model") {
                    TextField("Model", text: $draft.model).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if !model.models.isEmpty {
                        Picker("Available", selection: $draft.model) { ForEach(model.models, id: \.self) { Text($0).tag($0) } }
                    }
                    Button("Load the model list") { Task { await model.discoverModels(baseUrl: draft.baseUrl, apiKey: key.isEmpty ? nil : key, id: draft.id) } }
                }
                Section {
                    Toggle("Export the key to new sessions", isOn: Binding(get: { draft.envName != nil }, set: { on in
                        draft.envName = on ? (SubscriptionsSettings.provider(for: draft.baseUrl)?.envName ?? "MODEL_API_KEY") : nil
                    }))
                    if draft.envName != nil {
                        TextField("Variable", text: Binding(get: { draft.envName ?? "" }, set: { draft.envName = $0 })).font(.body.monospaced()).textInputAutocapitalization(.characters)
                    }
                }
            }
            .navigationTitle(draft.id == nil ? "Add a provider" : draft.name)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: close) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        var out = draft
                        out.apiKey = key.isEmpty ? nil : key
                        Task { if await model.save(out) { close() } }
                    }
                    .disabled(draft.name.isEmpty || draft.baseUrl.isEmpty || draft.model.isEmpty)
                }
            }
        }
    }
}

// MARK: Environment

private struct EnvironmentSection: View {
    @State var model: EnvironmentSettings
    @State private var editing: EnvVarDraft?
    @Environment(\.theme) private var theme

    struct EnvVarDraft: Identifiable {
        var id: String { original ?? "new" }
        var original: String?
        var name: String
        var value: String
        var secret: Bool
    }

    var body: some View {
        Form {
            if let error = model.error { Banner(text: error, tone: .error) }
            if let state = model.state {
                Section {
                    ForEach(state.vars) { v in
                        Button {
                            editing = EnvVarDraft(original: v.name, name: v.name, value: v.value ?? "", secret: v.secret)
                        } label: {
                            HStack {
                                Text(v.name).font(.callout.monospaced()).foregroundStyle(theme.text)
                                Spacer()
                                Text(v.secret ? (v.hint ?? "••••") : (v.value ?? "")).font(.caption.monospaced()).foregroundStyle(theme.muted).lineLimit(1)
                            }
                        }
                        .swipeActions { Button("Remove", role: .destructive) { Task { await model.remove(v) } } }
                    }
                    Button("Add a variable", systemImage: "plus") { editing = EnvVarDraft(name: "", value: "", secret: false) }
                } footer: {
                    Text("Every new session window starts with these. Secret values never come back to this device.")
                }
                if !state.exports.isEmpty {
                    Section("From subscriptions") {
                        ForEach(state.exports, id: \.name) { e in LabeledContent(e.name, value: e.subscription).font(.callout.monospaced()) }
                    }
                }
                if !state.stale.isEmpty {
                    Section("Started before a change") {
                        ForEach(state.stale, id: \.uid) { s in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(s.title)
                                    if let why = s.restart { Text(why).font(.caption).foregroundStyle(theme.muted) }
                                }
                                Spacer()
                                if s.restart == nil {
                                    Button(model.restarting.contains(s.uid) ? "Restarting…" : "Restart") { Task { await model.restart(s.uid) } }
                                        .buttonStyle(.borderless).disabled(model.restarting.contains(s.uid))
                                }
                            }
                        }
                        if model.ready.count > 1 { Button("Restart all \(model.ready.count)") { Task { await model.restartAll() } } }
                    }
                }
            } else {
                ProgressView()
            }
        }
        .task { await model.load() }
        .sheet(item: $editing) { draft in
            EnvEditor(model: model, draft: draft) { editing = nil }
        }
    }
}

private struct EnvEditor: View {
    let model: EnvironmentSettings
    @State var draft: EnvironmentSection.EnvVarDraft
    let close: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                TextField("NAME", text: $draft.name).font(.body.monospaced()).textInputAutocapitalization(.characters).autocorrectionDisabled().disabled(draft.original != nil)
                if draft.secret {
                    SecureField(draft.original == nil ? "Value" : "New value (leave empty to keep)", text: $draft.value)
                } else {
                    TextField("Value", text: $draft.value, axis: .vertical).font(.body.monospaced()).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Toggle("Secret", isOn: $draft.secret)
            }
            .navigationTitle(draft.original ?? "New variable")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: close) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let value: String? = draft.secret && draft.original != nil && draft.value.isEmpty ? nil : draft.value
                        Task { if await model.save(name: draft.name, value: value, secret: draft.secret) { close() } }
                    }
                    .disabled(draft.name.isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: Search

private struct SearchSection: View {
    @State var model: SearchSettings

    var body: some View {
        Form {
            if let error = model.error { Banner(text: error, tone: .error) }
            if let status = model.status {
                Toggle("Full-text search", isOn: Binding(get: { status.enabled }, set: { on in Task { await model.setEnabled(on) } }))
                Section("Index") {
                    LabeledContent("Transcripts", value: "\(status.sourcesIndexed) of \(status.sourcesKnown)")
                    LabeledContent("Entries", value: "\(status.entries)")
                    LabeledContent("Side chats", value: "\(status.chatEntries)")
                    if status.lastBuiltAt > 0 { LabeledContent("Built", value: Elapsed.format(Date(timeIntervalSince1970: status.lastBuiltAt / 1000), now: .now)) }
                    Button(status.building ? "Building…" : "Rebuild the index") { Task { await model.rebuild() } }.disabled(status.building || !status.enabled)
                }
            } else {
                ProgressView()
            }
        }
        .task { await model.load() }
    }
}

// MARK: System

private struct SystemSection: View {
    @State var model: SystemSettings
    let scene: SceneModel
    @State private var confirmRestart = false
    @State private var confirmUploads = false
    @Environment(\.theme) private var theme

    var body: some View {
        Form {
            if let error = model.error { Banner(text: error, tone: .error) }
            if let notice = model.notice { Banner(text: notice) }
            if let hooks = model.hooks {
                Section {
                    LabeledContent("Claude", value: "\(hooks.claude.wired) of \(hooks.claude.of) hooks")
                    LabeledContent("Codex", value: hooks.codex.wired ? "Wired" : hooks.codex.otherNotify ? "Another notify program is set" : "Not wired")
                    let wired = hooks.claude.wired == hooks.claude.of && hooks.codex.wired
                    Button(wired ? "Remove the hooks" : "Install the hooks") { Task { await model.setHooks(install: !wired) } }
                    ForEach(model.messages, id: \.self) { Text($0).font(.caption).foregroundStyle(theme.muted) }
                } header: {
                    Text("Agent hooks")
                } footer: {
                    Text("Hooks tell Agent Hub the moment an agent needs you or finishes, instead of reading its screen.")
                }
                if let audit = hooks.audit, !audit.isEmpty {
                    Section("Screen rules") {
                        ForEach(audit.keys.sorted(), id: \.self) { agent in
                            let a = audit[agent]!
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(agent): \(a.missed) missed of \(a.checked)")
                                if let last = a.last { Text("Last miss: \(last.ask)").font(.caption).foregroundStyle(theme.muted).lineLimit(2) }
                            }
                        }
                        Button("Reset the audit") { Task { await model.resetAudit() } }
                    }
                }
            }
            Section("Host") {
                Button("Clear uploaded files…", role: .destructive) { confirmUploads = true }
                Button("Restart Agent Hub…", role: .destructive) { confirmRestart = true }
            }
            Section("This app") {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                LabeledContent("Build", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—")
            }
        }
        .task { await model.load() }
        .confirmationDialog("Restart Agent Hub?", isPresented: $confirmRestart, titleVisibility: .visible) {
            Button("Restart", role: .destructive) { Task { await model.restartServer() } }
        } message: {
            Text("Sessions keep running in tmux; every device reconnects in a moment.")
        }
        .confirmationDialog("Clear uploaded files?", isPresented: $confirmUploads, titleVisibility: .visible) {
            Button("Clear", role: .destructive) { Task { await model.clearUploads() } }
        } message: {
            Text("Files sent to agents are deleted from the host. Sessions that still reference them won’t find them.")
        }
    }
}
