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
                    NavigationLink(value: SettingsSection.security) { SettingsRowLabel(section: .security, title: "Hosts and security") }
                }
                .ahRow(sizeClass == .compact)
                Section("Agent Hub") {
                    ForEach(SettingsSection.allCases.filter { $0 != .security }, id: \.self) { s in
                        NavigationLink(value: s) { SettingsRowLabel(section: s, title: s.title) }
                            .contextMenu { LinkButtons(place: Place(.settings(s.rawValue)), scene: scene) }
                    }
                }
                .ahRow(sizeClass == .compact)
            }
            .settingsListGround(sizeClass == .compact)
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button(role: .close) { dismiss() }.keyboardShortcut(.cancelAction).tint(.primary) } }
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

private extension View {
    /// A phone's Settings list is a page on the ground; an iPad's stays the sidebar's glass.
    @ViewBuilder func settingsListGround(_ on: Bool) -> some View {
        if on { ahFormGround() } else { self }
    }
}

/// A section in Settings' list, as iOS Settings draws one: its symbol white on a colored
/// tile, its name, and what's in it.
private struct SettingsRowLabel: View {
    let section: SettingsSection
    let title: String
    @Environment(\.theme) private var theme
    @Environment(\.dynamicTypeSize) private var typeSize
    /// The tile grows with the text, as Settings' own do.
    @ScaledMetric(relativeTo: .body) private var tile: CGFloat = 30

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: section.tileSymbol)
                .font(.system(size: tile / 2, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: tile, height: tile)
                .background(section.tile.gradient, in: RoundedRectangle(cornerRadius: tile * 0.23, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                // Whole at the largest sizes, where one line kept two words of it.
                Text(section.summary).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(typeSize.isAccessibilitySize ? 4 : 1)
            }
        }
        .padding(.vertical, 2)
    }
}

private extension SettingsSection {
    /// Its symbol, filled where there's a filled one (white on a tile reads better solid).
    var tileSymbol: String {
        switch self {
        case .security: return "lock.shield.fill"
        case .notifications: return "bell.badge.fill"
        case .agents: return "person.2.fill"
        case .subscriptions: return "key.fill"
        case .system: return "gearshape.2.fill"
        default: return symbol
        }
    }

    /// Each section's tile, in iOS Settings' palette.
    var tile: Color {
        switch self {
        case .security: return .blue
        case .appearance: return .indigo
        case .shortcuts: return .gray
        case .notifications: return .red
        case .agents: return .orange
        case .subscriptions: return .green
        case .environment: return .teal
        case .search: return .purple
        case .system: return Color(white: 0.45)
        }
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
        // A link straight to this section (the overflow menu), here or in the web app.
        .toolbar {
            ToolbarItemGroup(placement: .secondaryAction) {
                LinkButtons(place: Place(.settings(section == .security ? nil : section.rawValue)), scene: scene)
            }
        }
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
    @State private var naming = false
    @State private var tokenName = ""
    @Environment(\.theme) private var theme

    init(scene: SceneModel, account: AccountSession) {
        self.scene = scene
        self.account = account
        _model = State(initialValue: SecuritySettings(api: account.api))
    }

    var body: some View {
        AhForm {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            if let notice = model.notice { Banner(text: notice).formBanner() }
            Section("Hosts on this device") {
                ForEach(scene.app.accounts) { other in
                    Button {
                        scene.useAccount(other.origin)
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(other.hostname).foregroundStyle(theme.text)
                                Text(other.origin).font(.ahMono(.caption)).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            if other.origin == account.origin { Image(systemName: "checkmark").foregroundStyle(theme.brand) }
                            Text(statusWord(other.status)).font(.ah(.caption)).foregroundStyle(theme.muted)
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
                        Text(code.code).font(.ahMono(.title).weight(.semibold)).textSelection(.enabled)
                        Spacer()
                        Button("Copy") {
                            UIPasteboard.general.string = code.code
                            Haptics.tap()
                            scene.toast("Copied the setup code")
                        }
                    }
                    Text("Valid for \(code.ttlMinutes) minutes, once.").font(.ah(.caption)).foregroundStyle(theme.muted)
                }
                if let address = account.endpoint.address(reported: model.overview?.address) {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Address").font(.ah(.caption)).foregroundStyle(theme.muted)
                            Text(address.host ?? address.absoluteString).textSelection(.enabled)
                        }
                        Spacer()
                        Button("Copy") {
                            UIPasteboard.general.string = address.absoluteString
                            Haptics.tap()
                            scene.toast("Copied the address")
                        }
                    }
                }
                Button(model.code == nil ? "Issue a setup code" : "Issue a new code", systemImage: "number") { Task { await model.newCode() } }
            } header: {
                Text("Add another device")
            } footer: {
                Text("On the new device, open the app (or a browser) at this address and enter the code. Codes come only from a device that’s already signed in.")
            }
            if let overview = model.overview {
                Section("Signed in") {
                    ForEach(overview.sessions) { signIn in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(signIn.label + (signIn.current ? " (this one)" : ""))
                                Text("\(signIn.via) · last seen \(Elapsed.format(Date(timeIntervalSince1970: signIn.lastSeenAt / 1000), now: .now))").font(.ah(.caption)).foregroundStyle(theme.muted)
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
                Section {
                    if let made = model.newToken {
                        NewTokenCard(name: made.name, secret: made.secret, scene: scene) { model.dismissToken() }
                    }
                    ForEach(overview.tokens) { token in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(token.name)
                                Text(tokenUse(token)).font(.ah(.caption)).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            Button("Revoke", role: .destructive) { Task { await model.removeToken(token) } }.buttonStyle(.borderless)
                        }
                    }
                    Button("New token…", systemImage: "key") { naming = true }
                } header: {
                    Text("API tokens")
                } footer: {
                    Text("For scripts and other tools that call this host’s API. A token is shown once, when it’s made.")
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
                            HStack { Text(row.event).font(.ah(.callout)); Spacer(); Text(row.at).font(.ah(.caption2)).foregroundStyle(theme.faint) }
                            if !row.detail.isEmpty { Text(row.detail).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(2) }
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
            Button("Sign Out Others", role: .destructive) { Task { await model.signOutOthers() } }
        }
        .alert("New API Token", isPresented: $naming) {
            TextField("Name, like “backup script”", text: $tokenName)
            Button("Cancel", role: .cancel) { tokenName = "" }
            Button("Make Token") {
                let name = tokenName
                tokenName = ""
                Task { await model.createToken(name: name) }
            }
        } message: {
            Text("Name it for what will use it, so you know what to revoke later.")
        }
        // The secret never outlives this screen.
        .onDisappear { model.dismissToken() }
    }

    private func tokenUse(_ token: AuthOverview.Token) -> String {
        let made = "Made \(Elapsed.format(Date(timeIntervalSince1970: token.createdAt / 1000), now: .now))"
        guard token.lastUsedAt > 0 else { return made + " · never used" }
        return made + " · used \(Elapsed.format(Date(timeIntervalSince1970: token.lastUsedAt / 1000), now: .now))"
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
    @Environment(\.theme) private var theme
    @Environment(\.colorScheme) private var colorScheme

    static func symbol(_ appearance: DevicePreferences.Appearance) -> String {
        switch appearance {
        case .system: return "circle.lefthalf.filled"
        case .dark: return "moon"
        case .light: return "sun.max"
        case .omarchy: return "paintpalette"
        case .palette: return "swatchpalette"
        }
    }

    /// Every look, as a swatch: ah's three and the host's, then the palettes the app carries.
    private var choices: [(DevicePreferences.Appearance, String, ThemePalette)] {
        let own: ThemePalette = colorScheme == .dark ? .dark : .light
        return [
            (.system, "ah", own), (.dark, "ah Dark", .dark), (.light, "ah Light", .light),
            (.omarchy, "Omarchy", app.preferences.appearance == .omarchy ? theme.palette : own),
        ] + BuiltinPalette.all.map { (.palette($0.id), $0.name, $0.palette) }
    }

    var body: some View {
        AhForm {
            // A grid of swatches, each a box on its ground with a line of its text and a dot of
            // its accent: a palette is picked for its look, which a name in a list didn't give.
            Section {
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12, alignment: .top), count: 4), spacing: 16) {
                    ForEach(choices, id: \.0) { appearance, name, palette in
                        Button {
                            withAnimation(.snappy(duration: 0.2)) { app.preferences.appearance = appearance }
                        } label: {
                            VStack(spacing: 6) {
                                PaletteSwatch(palette: palette, symbol: appearance == .omarchy ? "paintpalette" : nil, selected: app.preferences.appearance == appearance, ring: theme.accent)
                                Text(name).font(.ah(.caption)).foregroundStyle(theme.text).multilineTextAlignment(.center).lineLimit(2)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(name)
                        .accessibilityAddTraits(app.preferences.appearance == appearance ? .isSelected : [])
                    }
                }
                .padding(.vertical, 6)
                .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
            } header: {
                Text("Palette")
            } footer: {
                Text("ah follows the device’s look. Omarchy takes the host’s theme and font. Every other palette has its own light or dark look.")
            }
            Section("Reading") {
                Toggle("Hide tool steps in transcripts", isOn: $app.preferences.stepsHidden)
                Picker("Sort sessions", selection: $app.preferences.sessionSort) {
                    Text("By project").tag(DevicePreferences.SessionSort.project)
                    Text("Recent activity").tag(DevicePreferences.SessionSort.recent)
                }
                Picker("Group the Inbox by", selection: $app.preferences.inboxGrouping) {
                    Text("Status").tag(DevicePreferences.InboxGrouping.status)
                    Text("Project").tag(DevicePreferences.InboxGrouping.project)
                    Text("Host").tag(DevicePreferences.InboxGrouping.host)
                }
            }
            Section("Terminal") {
                Stepper("Font size \(Int(app.preferences.terminalFontSize))", value: $app.preferences.terminalFontSize, in: TerminalTextSize.range, step: 1)
                Picker("On-screen keys", selection: $app.preferences.keyBar) {
                    Text("Without a keyboard").tag(DevicePreferences.KeyBarMode.auto)
                    Text("Always").tag(DevicePreferences.KeyBarMode.on)
                    Text("Never").tag(DevicePreferences.KeyBarMode.off)
                }
            }
            Section {
                TextField("Device name", text: Binding(get: { app.preferences.deviceName ?? "" }, set: { app.preferences.deviceName = $0.isEmpty ? nil : $0 }), prompt: Text(app.systemName))
            } header: {
                Text("This device’s name")
            } footer: {
                Text("What other devices see when this one has a session open, from the next time Agent Hub opens.")
            }
        }
    }
}

/// A palette as a tile: its ground, a box of its surface, a line of its text and a dot of its
/// accent (the composer, in miniature). The one in force wears a ring of the accent in force.
private struct PaletteSwatch: View {
    let palette: ThemePalette
    var symbol: String?
    let selected: Bool
    let ring: Color

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color(uiColor: UIColor(hex: palette.background)))
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(uiColor: UIColor(hex: palette.card)))
                .frame(height: 30)
                .padding(.horizontal, 10)
                .overlay {
                    HStack(spacing: 6) {
                        Capsule().fill(Color(uiColor: UIColor(hex: palette.text))).frame(width: 22, height: 4)
                        Circle().fill(Color(uiColor: UIColor(hex: palette.accent))).frame(width: 10, height: 10)
                    }
                }
            if let symbol {
                Image(systemName: symbol).font(.ah(.caption2)).foregroundStyle(Color(uiColor: UIColor(hex: palette.muted)))
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing).padding(6)
            }
        }
        .aspectRatio(1.15, contentMode: .fit)
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .strokeBorder(selected ? ring : Color.primary.opacity(0.12), lineWidth: selected ? 2 : 1)
        }
        .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .hoverEffect(.lift)
    }
}

// MARK: Shortcuts

/// The keymap editor (VS Code's keybindings, made native): search by name, group or keys
/// (typed, or pressed), every shortcut a command has, where it applies, what changed. A
/// shortcut is recorded straight from the keyboard, one key or two; a clash says with what
/// and offers to take the shortcut over. The palette, menu bar and which-key read the same
/// bindings, so a change shows everywhere at once.
private struct ShortcutsSection: View {
    @Bindable var app: AppModel
    @State private var query = ""
    @State private var filter: KeymapSearch.Filter = .all
    @State private var pressed: Chord?
    @State private var recordingSearch = false
    @State private var recording: Recording?
    @State private var problem: Problem?
    @State private var confirmReset = false
    @Environment(\.theme) private var theme

    struct Recording: Equatable {
        let id: CommandID
        /// The shortcut being changed; nil adds one.
        let replacing: Chord?
    }

    struct Problem: Equatable {
        let id: CommandID
        let chord: Chord
        let replacing: Chord?
        let message: String
        /// The command that has it, when taking it over is possible.
        let holder: CommandID?
    }

    var body: some View {
        let commands = pressed.map { KeymapSearch.commands(pressing: $0, bindings: app.keyBindings) } ?? KeymapSearch.commands(query, bindings: app.keyBindings, filter: filter)
        List {
            Group {
            Section {
                // Panes and a pointer are an iPad's and a Mac's: a phone has neither.
                if UIDevice.current.userInterfaceIdiom != .phone {
                    Toggle("Focus follows the pointer", isOn: $app.preferences.focusFollowsPointer)
                }
                Picker("Show", selection: $filter) {
                    Text("All").tag(KeymapSearch.Filter.all)
                    Text("Changed").tag(KeymapSearch.Filter.modified)
                    Text("No shortcut").tag(KeymapSearch.Filter.unbound)
                }
                .pickerStyle(.segmented)
                HStack {
                    if recordingSearch {
                        Text("Press the keys to look up").foregroundStyle(theme.muted)
                        Spacer()
                        ChordRecorder { chord in
                            recordingSearch = false
                            pressed = chord
                        }
                        .frame(width: 170, height: 30)
                    } else if let pressed {
                        Text("Bound to").foregroundStyle(theme.muted)
                        Keycaps(pressed)
                        Spacer()
                        Button("Clear") { self.pressed = nil }
                    } else {
                        Button("Find by pressing keys", systemImage: "keyboard") { recordingSearch = true }
                    }
                }
            } footer: {
                Text(UIDevice.current.userInterfaceIdiom == .phone ? "A shortcut needs ⌃, ⌥ or ⌘; a two-key shortcut’s second key may be bare." : "With a trackpad or mouse, the pane under the pointer takes the keyboard. A shortcut needs ⌃, ⌥ or ⌘; a two-key shortcut’s second key may be bare.")
            }
            if let problem {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        Label(problem.message, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(theme.danger)
                        HStack {
                            if let holder = problem.holder {
                                Button("Use it for \(CommandCatalog.label(problem.id)) instead of \(CommandCatalog.label(holder))") { takeOver(problem) }
                                    .buttonStyle(.borderedProminent)
                                    .tint(theme.accentStrong)
                            }
                            Button("Cancel") { self.problem = nil }.buttonStyle(.bordered)
                        }
                        .controlSize(.small)
                    }
                }
            }
            ForEach([CommandGroup.navigate, .session, .workspace], id: \.self) { group in
                let rows = commands.filter { $0.group == group }
                if !rows.isEmpty {
                    Section(group.rawValue) {
                        ForEach(rows) { command in
                            ShortcutRow(command: command, app: app, recording: $recording) { chord in record(command.id, chord) }
                        }
                    }
                }
            }
            if commands.isEmpty {
                Text(pressed != nil ? "Nothing is bound to those keys." : "No command matches.").foregroundStyle(theme.muted)
            }
            Section {
                Button("Reset every shortcut", role: .destructive) { confirmReset = true }
                    .disabled(app.keyBindings.modified.isEmpty)
            }
            }
            .ahRow()
        }
        .ahFormGround()
        .searchable(text: $query, prompt: "Name, group or keys, like “ctrl shift p”")
        .onChange(of: app.keyBindings) { _, _ in UIMenuSystem.main.setNeedsRebuild() }
        .confirmationDialog("Reset every shortcut to its default?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Reset All", role: .destructive) { app.keyBindings.resetAll() }
        }
    }

    /// A recorder finished: replace the shortcut being changed, or add one.
    private func record(_ id: CommandID, _ chord: Chord?) {
        let replacing = recording?.replacing
        recording = nil
        problem = nil
        guard let chord else { return }
        var bindings = app.keyBindings
        if let replacing { bindings.remove(id, replacing) }
        if let error = bindings.set(id, chord, adding: true) {
            problem = Problem(id: id, chord: chord, replacing: replacing, message: error, holder: bindings.conflict(id, chord))
        } else {
            app.keyBindings = bindings
        }
    }

    private func takeOver(_ problem: Problem) {
        var bindings = app.keyBindings
        if let replacing = problem.replacing { bindings.remove(problem.id, replacing) }
        if bindings.set(problem.id, problem.chord, adding: true, takingOver: true) == nil { app.keyBindings = bindings }
        self.problem = nil
    }
}

private struct ShortcutRow: View {
    let command: Command
    @Bindable var app: AppModel
    @Binding var recording: ShortcutsSection.Recording?
    let finished: (Chord?) -> Void
    @Environment(\.theme) private var theme
    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        let id = command.id
        // On a phone the keys go under the name: beside it, two chords and their buttons left
        // the name a word wide, and broke "or" over two lines.
        if sizeClass == .compact {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: CommandCatalog.icon(id)).frame(width: 22).foregroundStyle(theme.muted).padding(.top, 2)
                VStack(alignment: .leading, spacing: 8) {
                    labels(id)
                    keys(id)
                }
            }
            .accessibilityElement(children: .contain)
        } else {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: CommandCatalog.icon(id)).frame(width: 22).foregroundStyle(theme.muted)
                labels(id)
                Spacer(minLength: 8)
                keys(id)
            }
            .accessibilityElement(children: .contain)
        }
    }

    private func labels(_ id: CommandID) -> some View {
        let changed = app.keyBindings.isOverridden(id)
        return VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(command.label)
                    if changed {
                        Circle().fill(theme.accent).frame(width: 6, height: 6).accessibilityLabel("Changed")
                    }
                }
                Text(command.detail).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(2)
                Text(CommandCatalog.whenLabel(id)).font(.ah(.caption2)).foregroundStyle(theme.faint)
            }
    }

    @ViewBuilder
    private func keys(_ id: CommandID) -> some View {
        let chords = app.keyBindings.chords(id)
        let changed = app.keyBindings.isOverridden(id)
            if recording?.id == id {
                ChordRecorder(done: finished).frame(width: 170, height: 30)
            } else {
                HStack(spacing: 6) {
                    ForEach(Array(chords.enumerated()), id: \.offset) { i, chord in
                        if i > 0 { Text("or").font(.ah(.caption2)).foregroundStyle(theme.faint) }
                        Menu {
                            Button("Change…", systemImage: "keyboard") { recording = ShortcutsSection.Recording(id: id, replacing: chord) }
                            Button("Remove", systemImage: "minus.circle", role: .destructive) { app.keyBindings.remove(id, chord) }
                        } label: {
                            Keycaps(chord)
                        }
                        .accessibilityLabel("\(chord.formatted()), change or remove")
                    }
                    Button {
                        recording = ShortcutsSection.Recording(id: id, replacing: nil)
                    } label: {
                        Image(systemName: chords.isEmpty ? "plus.circle" : "plus")
                    }
                    .accessibilityLabel(chords.isEmpty ? "Add a shortcut" : "Add another shortcut")
                    if changed {
                        Button {
                            app.keyBindings.reset(id)
                        } label: {
                            Image(systemName: "arrow.uturn.backward")
                        }
                        .accessibilityLabel("Reset to the default")
                    }
                }
                .buttonStyle(.borderless)
                .fixedSize()
            }
    }
}

/// Captures a shortcut from a hardware keyboard: one chord, or a second key right after
/// for a two-key chord. Return keeps what's shown, Escape cancels, and a single chord is
/// kept after a short pause.
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
        private var first: Chord?
        private var settle: Task<Void, Never>?

        override init(frame: CGRect) {
            super.init(frame: frame)
            text = "Press a shortcut…"
            font = AhType.uiFont(.caption)
            textAlignment = .center
            isUserInteractionEnabled = true
            layer.cornerRadius = 6
            layer.borderWidth = 1
            layer.borderColor = UIColor.tintColor.cgColor
            accessibilityLabel = "Press a shortcut, or Escape to cancel"
        }

        required init?(coder: NSCoder) { fatalError() }

        override var canBecomeFirstResponder: Bool { true }

        private func finish(_ chord: Chord?) {
            settle?.cancel()
            settle = nil
            first = nil
            done(chord)
        }

        override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
            guard let key = presses.first?.key else { return super.pressesBegan(presses, with: event) }
            let press = KeyPress(key)
            if KeyPress.modifierUsages.contains(press.hidUsage) { return }
            let bare = press.modifiers.isEmpty
            if press.key == "Escape" && bare {
                finish(nil)
                return
            }
            if press.key == "Enter" && bare, let first {
                finish(first)
                return
            }
            guard let chord = press.chord else { return }
            if let first {
                finish(first.followed(by: chord))
                return
            }
            first = chord
            text = chord.formatted() + " …"
            accessibilityValue = chord.formatted()
            settle = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(1400))
                guard !Task.isCancelled, let self, let first = self.first else { return }
                self.finish(first)
            }
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
        AhForm {
            if push.pushUnavailable {
                Banner(text: PushRegistrar.unavailableNote, tone: .info).formBanner()
            } else if let error = model.error ?? push.lastError {
                Banner(text: error, tone: .error).formBanner()
            }
            if !push.pushUnavailable, let status = model.status, !status.configured {
                Banner(text: "This host has no APNs key configured, so it can’t notify this device yet. Its owner adds one under `apns` in the host’s config.", tone: .warning).formBanner()
            }
            if push.authorization == .denied {
                Banner(text: "Notifications are off for Agent Hub in iOS Settings.", tone: .warning, action: ("Open Settings", {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                })).formBanner()
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
                Text("Approve and Deny appear on a notification only for a plain permission prompt; Reply on a session that finished. Both need the device unlocked. The icon badge counts sessions waiting on you.")
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
    @State private var saving = false
    @Environment(\.theme) private var theme

    var body: some View {
        AhForm {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            if let harnesses = model.harnesses {
                Section {
                    ForEach(harnesses.agents) { agent in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                AgentMark(agent: agent.id, size: 20)
                                Text(agent.name)
                                if let version = agent.version { Text(version).font(.ahMono(.caption)).foregroundStyle(theme.muted) }
                                Spacer()
                                Toggle("Offer", isOn: Binding(get: { !agent.hidden }, set: { on in Task { await model.setHidden(agent, !on) } })).labelsHidden()
                            }
                            if !agent.installed { Text("Not installed on the host").font(.ah(.caption)).foregroundStyle(theme.limited) }
                            ForEach(agent.changes, id: \.self) { change in Text("• \(change)").font(.ah(.caption)).foregroundStyle(theme.muted) }
                        }
                        // Red by tint, not role: the row is there until the host has removed it.
                        .swipeActions { if agent.custom { Button("Remove") { Task { await model.remove(agent) } }.tint(theme.danger) } }
                    }
                } header: {
                    Text("Offered in New Session")
                }
                Section {
                    Button(model.checking ? "Checking…" : "Check Versions", systemImage: "arrow.clockwise") { Task { await model.check() } }.disabled(model.checking)
                    Button("Add an Agent…", systemImage: "plus") { adding = true }
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
                AhForm {
                    // Said here: the page's banner is behind this sheet.
                    if let error = model.error { Banner(text: error, tone: .error) }
                    TextField("Name", text: $name)
                    TextField("Command", text: $command).font(.ahMono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Resume command (optional)", text: $resume).font(.ahMono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                .navigationTitle("Add an Agent")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { adding = false }.keyboardShortcut(.cancelAction).tint(.primary) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(saving ? "Adding…" : "Add") {
                            saving = true
                            Task {
                                // Closed only once it's added, and emptied for the next one.
                                if await model.add(name: name, command: command, resume: resume.isEmpty ? nil : resume) {
                                    adding = false
                                    name = ""; command = ""; resume = ""
                                }
                                saving = false
                            }
                        }.keyboardShortcut(.return, modifiers: .command)
                        .disabled(saving || name.isEmpty || command.isEmpty)
                            .buttonStyle(.glassProminent)
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
        AhForm {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            Section {
                ForEach(model.list) { s in
                    Button {
                        editing = SubscriptionDraft(id: s.id, name: s.name, baseUrl: s.baseUrl, model: s.model, envName: s.envName)
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.name).foregroundStyle(theme.text)
                                Text("\(s.model) · \(s.hasKey ? "key \(s.keyHint)" : "no key")").font(.ah(.caption)).foregroundStyle(theme.muted)
                            }
                            Spacer()
                            if s.isDefault { Text("Default").font(.ah(.caption)).foregroundStyle(theme.brand) }
                        }
                    }
                    .swipeActions {
                        Button("Remove") { Task { await model.remove(s) } }.tint(theme.danger)
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
                        // "Default", not "The default subscription": the long one pushed the value onto a line of its own.
                        Text("Default").tag(String?.none)
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
    @State private var saving = false

    var body: some View {
        NavigationStack {
            AhForm {
                // Said here: the section's banner is behind this sheet, so a refused URL or key
                // looked like a Save that did nothing.
                if let error = model.error { Banner(text: error, tone: .error) }
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
                        TextField("Variable", text: Binding(get: { draft.envName ?? "" }, set: { draft.envName = $0 })).font(.ahMono(.body)).textInputAutocapitalization(.characters)
                    }
                }
            }
            .navigationTitle(draft.id == nil ? "Add a Provider" : draft.name)
            .onAppear { model.beginEditing() }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel, action: close).keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") {
                        var out = draft
                        out.apiKey = key.isEmpty ? nil : key
                        // Once: a second tap on a new provider made a second one.
                        saving = true
                        Task {
                            if await model.save(out) { close() }
                            saving = false
                        }
                    }.keyboardShortcut(.return, modifiers: .command)
                    .disabled(saving || draft.name.isEmpty || draft.baseUrl.isEmpty || draft.model.isEmpty)
                        .buttonStyle(.glassProminent)
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
        AhForm {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            if let state = model.state {
                Section {
                    ForEach(state.vars) { v in
                        Button {
                            editing = EnvVarDraft(original: v.name, name: v.name, value: v.value ?? "", secret: v.secret)
                        } label: {
                            HStack {
                                Text(v.name).font(.ahMono(.callout)).foregroundStyle(theme.text)
                                Spacer()
                                Text(v.secret ? (v.hint ?? "••••") : (v.value ?? "")).font(.ahMono(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                            }
                        }
                        .swipeActions { Button("Remove") { Task { await model.remove(v) } }.tint(theme.danger) }
                    }
                    Button("Add a variable", systemImage: "plus") { editing = EnvVarDraft(name: "", value: "", secret: false) }
                } footer: {
                    Text("Every new session window starts with these. Secret values never come back to this device.")
                }
                if !state.exports.isEmpty {
                    Section("From subscriptions") {
                        ForEach(state.exports, id: \.name) { e in LabeledContent(e.name, value: e.subscription).font(.ahMono(.callout)) }
                    }
                }
                if !state.stale.isEmpty {
                    Section("Started before a change") {
                        ForEach(state.stale, id: \.uid) { s in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(s.title)
                                    if let why = s.restart { Text(why).font(.ah(.caption)).foregroundStyle(theme.muted) }
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
            AhForm {
                TextField("NAME", text: $draft.name).font(.ahMono(.body)).textInputAutocapitalization(.characters).autocorrectionDisabled().disabled(draft.original != nil)
                if draft.secret {
                    SecureField(draft.original == nil ? "Value" : "New value (leave empty to keep)", text: $draft.value)
                } else {
                    TextField("Value", text: $draft.value, axis: .vertical).font(.ahMono(.body)).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Toggle("Secret", isOn: $draft.secret)
            }
            .navigationTitle(draft.original ?? "New variable")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .cancel, action: close).keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let value: String? = draft.secret && draft.original != nil && draft.value.isEmpty ? nil : draft.value
                        Task { if await model.save(name: draft.name, value: value, secret: draft.secret) { close() } }
                    }.keyboardShortcut(.return, modifiers: .command)
                    .disabled(draft.name.isEmpty)
                        .buttonStyle(.glassProminent)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

// MARK: Search

private struct SearchSection: View {
    @State var model: SearchSettings
    @State private var confirmOff = false

    var body: some View {
        AhForm {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            if let status = model.status {
                // Off deletes the index, so it asks first (as the web does); on is at once.
                Toggle("Full-text search", isOn: Binding(get: { status.enabled }, set: { on in
                    if on { Task { await model.setEnabled(true) } } else { confirmOff = true }
                }))
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
        .confirmationDialog("Turn Off Search?", isPresented: $confirmOff, titleVisibility: .visible) {
            Button("Turn Off and Delete the Index", role: .destructive) { Task { await model.setEnabled(false) } }
        } message: {
            Text("Searching stops on every device, and turning it on again rebuilds the index from the start.")
        }
        // Kept current while it's open, as the web's page is: a rebuild's counts and its
        // "Building…" moved on without it.
        .task {
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }
}

/// A token's secret, the one time it's shown: copy it, then it's gone.
private struct NewTokenCard: View {
    let name: String
    let secret: String
    let scene: SceneModel
    let done: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("“\(name)” is ready", systemImage: "checkmark.seal.fill")
                .font(.ah(.subheadline).weight(.semibold))
                .foregroundStyle(theme.done)
            Text(secret)
                .font(.ahMono(.callout))
                .textSelection(.enabled)
                .lineLimit(2)
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.sunken, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            Text("Copy it now: it isn’t shown again, and this app doesn’t keep it.").font(.ah(.caption)).foregroundStyle(theme.muted)
            HStack {
                Button("Copy", systemImage: "doc.on.doc") {
                    UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: secret]], options: [.localOnly: true, .expirationDate: Date.now.addingTimeInterval(120)])
                    Haptics.success()
                    scene.toast("Copied. It clears from the clipboard in 2 minutes.")
                }
                .buttonStyle(.borderedProminent)
                // The strong accent, as every filled button: white on the light one barely read.
                .tint(theme.accentStrong)
                Spacer()
                Button("Done", action: done).buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 4)
    }
}

// MARK: System

private struct SystemSection: View {
    @State var model: SystemSettings
    let scene: SceneModel
    @State private var confirmRestart = false
    @State private var confirmUploads = false
    @State private var confirmRebuild = false
    @Environment(\.theme) private var theme

    var body: some View {
        AhForm {
            if let error = model.error { Banner(text: error, tone: .error).formBanner() }
            if let notice = model.notice { Banner(text: notice).formBanner() }
            if let hooks = model.hooks {
                Section {
                    LabeledContent("Claude", value: "\(hooks.claude.wired) of \(hooks.claude.of) hooks")
                    LabeledContent("Codex", value: hooks.codex.wired ? "Wired" : hooks.codex.otherNotify ? "Another notify program is set" : "Not wired")
                    let wired = hooks.claude.wired == hooks.claude.of && hooks.codex.wired
                    Button(wired ? "Remove the hooks" : "Install the hooks") { Task { await model.setHooks(install: !wired) } }
                    ForEach(model.messages, id: \.self) { Text($0).font(.ah(.caption)).foregroundStyle(theme.muted) }
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
                                if let last = a.last { Text("Last miss: \(last.ask)").font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(2) }
                            }
                        }
                        Button("Reset the audit") { Task { await model.resetAudit() } }
                    }
                }
            }
            if let desktop = model.desktop {
                Section {
                    LabeledContent("In the app launcher", value: desktop.installed ? "Yes" : "No")
                    Button(desktop.installed ? "Remove from the launcher" : "Add to the launcher", systemImage: desktop.installed ? "minus.circle" : "plus.app") {
                        Task { await model.setDesktop(install: !desktop.installed) }
                    }
                    ForEach(model.desktopMessages, id: \.self) { Text($0).font(.ah(.caption)).foregroundStyle(theme.muted) }
                    VStack(alignment: .leading, spacing: 6) {
                        HStack {
                            Text("Hyprland shortcut").font(.ah(.subheadline))
                            Spacer()
                            Button("Copy") {
                                UIPasteboard.general.string = desktop.bind
                                Haptics.tap()
                                scene.toast("Copied the binding")
                            }
                            .buttonStyle(.borderless)
                        }
                        Text(desktop.bind)
                            .font(.ahMono(.caption))
                            .foregroundStyle(theme.text2)
                            .textSelection(.enabled)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(theme.sunken, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }
                } header: {
                    Text("Desktop")
                } footer: {
                    Text(desktop.omarchy
                        ? "On the host’s Omarchy desktop, Agent Hub opens \(desktop.url) in its own window from SUPER+SPACE. Paste the shortcut into ~/.config/hypr/bindings.conf to open it with SUPER+ALT+A."
                        : "On the host’s desktop, Agent Hub opens \(desktop.url) from the app launcher. The shortcut is for Hyprland’s bindings.conf.")
                }
            }
            Section {
                Button("Clear uploaded files…", role: .destructive) { confirmUploads = true }
                Button("Restart Agent Hub…", role: .destructive) { confirmRestart = true }
                Button(role: .destructive) {
                    confirmRebuild = true
                } label: {
                    HStack {
                        Text(model.rebuilding ? "Building…" : "Rebuild and restart…")
                        if model.rebuilding { Spacer(); ProgressView() }
                    }
                }
                .disabled(model.rebuilding)
                if let log = model.buildLog {
                    VStack(alignment: .leading, spacing: 6) {
                        Label("The build failed; nothing was restarted.", systemImage: "exclamationmark.triangle.fill")
                            .font(.ah(.subheadline))
                            .foregroundStyle(theme.danger)
                        ScrollView(.horizontal) {
                            Text(log).font(.ahMono(.caption2)).foregroundStyle(theme.text2).textSelection(.enabled)
                        }
                        .frame(maxHeight: 180)
                    }
                }
            } header: {
                Text("Host")
            } footer: {
                Text("Rebuild clears the host’s web build, builds it again from its checkout, then restarts. Sessions keep running through both.")
            }
            Section("This app") {
                LabeledContent("Version", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—")
                LabeledContent("Build", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—")
            }
        }
        .task { await model.load() }
        .alert("Restart Agent Hub?", isPresented: $confirmRestart) {
            Button("Cancel", role: .cancel) {}
            Button("Restart", role: .destructive) { Task { await model.restartServer() } }
        } message: {
            Text("Sessions keep running in tmux; every device reconnects in a moment.")
        }
        .alert("Rebuild and restart Agent Hub?", isPresented: $confirmRebuild) {
            Button("Cancel", role: .cancel) {}
            Button("Rebuild and Restart", role: .destructive) { Task { await model.rebuild() } }
        } message: {
            Text("The web build is cleared and built again from the host’s checkout, which can take a few minutes. If it fails, nothing restarts and the build’s output shows here.")
        }
        .alert("Clear uploaded files?", isPresented: $confirmUploads) {
            Button("Cancel", role: .cancel) {}
            Button("Clear", role: .destructive) { Task { await model.clearUploads() } }
        } message: {
            Text("Files sent to agents are deleted from the host. Sessions that still reference them won’t find them.")
        }
    }
}
