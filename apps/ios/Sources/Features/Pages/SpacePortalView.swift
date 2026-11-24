import SwiftUI
import UniformTypeIdentifiers

// Space Portal (`apps/server/web/SpacePortal.tsx`, `docs/spec/17-spaces.md`):
// Choosing a Space turns the Inbox into a portal for that Space — its own Chief(s) of Staff,
// Space-scoped Notes, Space Files & Artifacts, Space Tasks ledger, and (for plain Spaces)
// inline Preferences & Memory.

/// Compact portal header + adaptive pill tab bar shown under the search bar when narrowed to a Space.
struct SpacePortalHeaderSection: View {
    let scene: SceneModel
    let hub: HubStore
    let project: InboxProject
    let portal: SpacePortalModel
    let sessionCount: Int
    let noteCount: Int
    @Binding var tab: SpacePortalTab
    @State private var showingContext = false
    @Environment(\.theme) private var theme

    private var hostParam: String? { project.host == hub.hostname ? nil : project.host }
    private var hostState: HubStateDTO? { hub.state(host: hostParam) }
    private var space: SpaceDTO? { hub.spaces.space(project) }
    private var supportsSupervision: Bool { hostState?.supports("supervision") == true }
    private var supportsFleet: Bool { hostState?.supports("fleet") == true }
    private var supportsSpaceContext: Bool { hostState?.supports("spaces", version: 2) == true }
    private var spacePath: String? {
        SpacePortalLogic.resolveSpacePath(project: project, space: space, rows: hub.rows, history: hub.history, home: hostState?.home)
    }
    private var chiefs: [SessionRow] {
        SpacePortalLogic.chiefsInSpace(hub.rows, spaceName: project.name, spacePath: spacePath, host: project.host, home: hostState?.home)
    }
    private var tabs: [SpacePortalTab] {
        SpacePortalTab.tabs(
            plain: space?.kind == .space,
            hasFolder: (space?.path ?? spacePath) != nil,
            supportsSpaceContext: supportsSpaceContext,
            supportsFleet: supportsFleet
        )
    }
    private var displayPath: String? {
        (space?.path ?? spacePath).map(LaunchState.canonicalProjectPath)
    }
    private var extraRoots: [String] {
        var seen = Set<String>()
        return (space?.roots ?? [])
            .map(LaunchState.canonicalProjectPath)
            .filter { $0 != displayPath && seen.insert($0).inserted }
    }
    private var openTaskCount: Int {
        portal.tasks.filter { $0.status != .done && $0.status != .cancelled }.count
    }

    private func badgeCount(for item: SpacePortalTab) -> Int? {
        switch item {
        case .sessions: sessionCount > 0 ? sessionCount : nil
        case .notes: noteCount > 0 ? noteCount : nil
        case .tasks: openTaskCount > 0 ? openTaskCount : nil
        case .files, .memory: nil
        }
    }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center, spacing: 8) {
                    if let kind = space?.kind {
                        Text(kind.label)
                            .font(.ah(.caption2).weight(.semibold))
                            .foregroundStyle(theme.accent)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(theme.accentTint, in: Capsule())
                    }
                    if let path = displayPath {
                        Text(path)
                            .font(.ahMono(.caption))
                            .foregroundStyle(theme.muted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    Spacer(minLength: 4)
                    if supportsSupervision {
                        Button {
                            scene.sheet = .startChief(project)
                        } label: {
                            Label(chiefs.isEmpty ? "Start Chief" : "+ Chief", systemImage: "crown.fill")
                                .font(.ah(.caption).weight(.semibold))
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .tint(theme.accent)
                        .accessibilityIdentifier("space-start-chief")
                    }
                    if supportsSpaceContext || space?.kind == .space {
                        Button {
                            showingContext = true
                        } label: {
                            Image(systemName: "doc.text.magnifyingglass")
                                .font(.ah(.callout))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel("Inspect Space Context")
                        .accessibilityIdentifier("space-context-button")
                    }
                    if (space?.path ?? spacePath) != nil {
                        Button {
                            createNoteInSpace()
                        } label: {
                            Image(systemName: "square.and.pencil")
                                .font(.ah(.callout))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel("New Note in \(project.name)")
                        .accessibilityIdentifier("space-new-note")
                    }
                    if space != nil {
                        Button {
                            scene.sheet = .spaceSettings(project)
                        } label: {
                            Image(systemName: "gearshape")
                                .font(.ah(.callout))
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .accessibilityLabel("Space Settings")
                        .accessibilityIdentifier("space-settings-button")
                    }
                }
                if !extraRoots.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(extraRoots, id: \.self) { root in
                                Text("+\((root as NSString).lastPathComponent)")
                                    .font(.ahMono(.caption2))
                                    .foregroundStyle(theme.muted)
                                    .padding(.horizontal, 7)
                                    .padding(.vertical, 2)
                                    .background(theme.raised, in: Capsule())
                            }
                        }
                    }
                }
                // Scrollable pill strip so all 5 tabs stay crisp & untruncated on iPhone, iPad, and Mac.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(tabs) { item in
                            let selected = tab == item
                            let count = badgeCount(for: item)
                            Button {
                                withAnimation(.snappy(duration: 0.2)) { tab = item }
                            } label: {
                                HStack(spacing: 5) {
                                    Image(systemName: item.symbol)
                                        .imageScale(.small)
                                    Text(item.label)
                                        .font(.ah(.caption).weight(selected ? .semibold : .medium))
                                        .lineLimit(1)
                                    if let count {
                                        Text("\(count)")
                                            .font(.ah(.caption2).weight(.semibold).monospacedDigit())
                                            .foregroundStyle(selected ? .white.opacity(0.9) : theme.muted)
                                    }
                                }
                                .padding(.horizontal, 11)
                                .padding(.vertical, 6)
                                .foregroundStyle(selected ? .white : theme.text)
                                .background(selected ? theme.accent : theme.raised, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .hoverEffect(.highlight)
                            .accessibilityAddTraits(selected ? [.isSelected] : [])
                            .accessibilityIdentifier("space-tab-\(item.rawValue)")
                        }
                    }
                    .padding(.vertical, 1)
                }
                .accessibilityIdentifier("space-portal-tabs")
            }
            .padding(.vertical, 4)
            .ahRow()
        }
        .task(id: "\(project.host)/\(project.name)/\(hostState?.fleet?.revision ?? 0)/\(supportsFleet)") {
            guard supportsFleet else { return }
            await portal.loadTasks(api: hub.client(host: hostParam), space: project.name)
        }
        .sheet(isPresented: $showingContext) {
            SpaceContextSheet(scene: scene, api: hub.client(host: hostParam), spaceName: project.name, portal: portal)
        }
    }

    private func createNoteInSpace() {
        let noteProject: NoteProject? = spacePath.map {
            NoteProject(origin: scene.accountOrigin, host: project.host, path: $0)
        }
        scene.newNote(project: .some(noteProject))
    }
}

/// Chief of Staff strip rendered at the top of the Space Portal's Sessions tab.
struct SpaceChiefStrip: View {
    let scene: SceneModel
    let hub: HubStore
    let project: InboxProject
    let portal: SpacePortalModel
    @State private var quickMessages: [String: String] = [:]
    @State private var sendingChiefUid: String?
    @Environment(\.theme) private var theme

    private var hostParam: String? { project.host == hub.hostname ? nil : project.host }
    private var hostState: HubStateDTO? { hub.state(host: hostParam) }
    private var space: SpaceDTO? { hub.spaces.space(project) }
    private var spacePath: String? {
        SpacePortalLogic.resolveSpacePath(project: project, space: space, rows: hub.rows, history: hub.history, home: hostState?.home)
    }
    private var chiefs: [SessionRow] {
        SpacePortalLogic.chiefsInSpace(hub.rows, spaceName: project.name, spacePath: spacePath, host: project.host, home: hostState?.home)
    }
    private var unmanaged: [SessionRow] {
        SpacePortalLogic.unmanagedInSpace(hub.rows, spaceName: project.name, host: project.host)
    }

    var body: some View {
        if hostState?.supports("supervision") == true {
            Section {
                if let error = portal.error {
                    Banner(text: error, tone: .error).listRowInsets(EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12))
                }
                if chiefs.isEmpty {
                    HStack(spacing: 12) {
                        Image(systemName: "crown")
                            .font(.ah(.title3))
                            .foregroundStyle(theme.accent)
                            .frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("No Chief of Staff yet")
                                .font(.ah(.subheadline).weight(.semibold))
                                .foregroundStyle(theme.text)
                            Text("Start a Chief to coordinate sessions, tasks, and artifacts in \(project.name).")
                                .font(.ah(.caption))
                                .foregroundStyle(theme.muted)
                        }
                        Spacer(minLength: 6)
                        Button("Start") { scene.sheet = .startChief(project) }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .tint(theme.accent)
                            .accessibilityIdentifier("space-chief-banner-start")
                    }
                    .padding(.vertical, 4)
                    .ahRow()
                } else {
                    ForEach(chiefs) { chief in
                        chiefRow(chief)
                    }
                }
            } header: {
                AhSectionHeader(title: chiefs.count > 1 ? "Chiefs of Staff" : "Chief of Staff", count: chiefs.count)
            }
            .task(id: "\(project.host)/\(chiefs.map(\.uid).joined(separator: ","))") {
                await portal.loadChiefWakes(api: hub.client(host: hostParam), chiefUids: chiefs.map(\.uid))
            }
        }
    }

    private func sendQuick(to chief: SessionRow) {
        let text = (quickMessages[chief.uid] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, sendingChiefUid == nil else { return }
        sendingChiefUid = chief.uid
        let api = hub.client(host: hostParam)
        Task {
            defer { sendingChiefUid = nil }
            do {
                _ = try await api.send(chief.uid, text: text, enter: true)
                quickMessages[chief.uid] = ""
                scene.toast("Sent to \(chief.title)")
            } catch {
                scene.toast(APIError.wrap(error).message, error: true)
            }
        }
    }

    private func chiefRow(_ chief: SessionRow) -> some View {
        let workers = SpacePortalLogic.workersOf(hub.rows, chiefUid: chief.uid, host: project.host)
        let scoped = !(chief.dto.supervision?.space ?? "").isEmpty
        let draftBinding = Binding(
            get: { quickMessages[chief.uid] ?? "" },
            set: { quickMessages[chief.uid] = $0 }
        )
        let sending = sendingChiefUid == chief.uid
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    scene.open(chief.key)
                } label: {
                    HStack(spacing: 10) {
                        AgentMark(agent: chief.dto.agent, size: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(chief.title)
                                    .font(.ah(.subheadline).weight(.semibold))
                                    .foregroundStyle(theme.text)
                                    .lineLimit(1)
                                Text(scoped ? "Space" : "Global")
                                    .font(.ah(.caption2).weight(.semibold))
                                    .foregroundStyle(theme.accent)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(theme.accentTint, in: Capsule())
                            }
                            Text("\(workers.count) \(workers.count == 1 ? "worker" : "workers") · \(chief.word.rawValue)")
                                .font(.ah(.caption))
                                .foregroundStyle(theme.muted)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 4)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if !unmanaged.isEmpty {
                    let busy = portal.adoptingChiefUid == chief.uid
                    Button(busy ? "Adopting…" : "Adopt \(unmanaged.count)") {
                        let api = hub.client(host: hostParam)
                        let targets = unmanaged
                        Task {
                            let result = await portal.adoptAll(api: api, chiefUid: chief.uid, sessions: targets)
                            if result.adopted > 0 { hub.refresh(host: hostParam) }
                            if result.adopted > 0 && result.failed == 0 {
                                scene.toast("Adopted \(result.adopted) \(result.adopted == 1 ? "session" : "sessions") under \(chief.title)")
                            } else if result.adopted > 0 && result.failed > 0 {
                                scene.toast("Adopted \(result.adopted) of \(targets.count); \(result.failed) failed", error: true)
                            } else if result.failed > 0 {
                                scene.toast("Could not adopt sessions", error: true)
                            }
                        }
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(portal.adoptingChiefUid != nil)
                    .accessibilityIdentifier("space-adopt-\(chief.uid)")
                }
            }
            if !workers.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(workers) { worker in
                            Button {
                                scene.open(worker.key)
                            } label: {
                                HStack(spacing: 5) {
                                    Circle()
                                        .fill(worker.word == .needsYou ? theme.brand : worker.word == .working ? theme.accent : worker.word == .done ? theme.done : theme.faint)
                                        .frame(width: 6, height: 6)
                                    Text(worker.title)
                                        .font(.ah(.caption).weight(.medium))
                                        .foregroundStyle(theme.text)
                                        .lineLimit(1)
                                    if let sp = worker.dto.space, !sp.isEmpty, sp != worker.dto.project {
                                        Text(worker.dto.project)
                                            .font(.ah(.caption2))
                                            .foregroundStyle(theme.muted)
                                            .lineLimit(1)
                                    }
                                }
                                .padding(.horizontal, 9)
                                .padding(.vertical, 4)
                                .background(theme.raised, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .hoverEffect(.highlight)
                        }
                    }
                }
            }
            let wakes = portal.chiefWakes[chief.uid] ?? []
            if !wakes.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(wakes) { job in
                            let paused = job.state == "paused"
                            let label: String = {
                                if case .session(_, let on) = job.trigger { return "on \(on)" }
                                return job.name
                            }()
                            Button {
                                let api = hub.client(host: hostParam)
                                let ids = chiefs.map(\.uid)
                                Task { await portal.toggleWake(api: api, job: job, chiefUids: ids) }
                            } label: {
                                HStack(spacing: 4) {
                                    Circle()
                                        .fill(paused ? theme.faint : theme.accent)
                                        .frame(width: 5, height: 5)
                                    Text(paused ? "Paused · \(label)" : "Wake · \(label)")
                                        .font(.ah(.caption2).weight(.medium))
                                        .foregroundStyle(paused ? theme.muted : theme.text)
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(theme.raised, in: Capsule())
                            }
                            .buttonStyle(.plain)
                            .disabled(portal.togglingWakeId == job.id)
                            .accessibilityLabel("\(job.name), \(paused ? "paused" : "active")")
                        }
                    }
                }
            }
            HStack(spacing: 8) {
                TextField("Direct \(chief.title)…", text: draftBinding)
                    .font(.ah(.callout))
                    .submitLabel(.send)
                    .onSubmit { sendQuick(to: chief) }
                    .disabled(sending)
                    .accessibilityIdentifier("space-chief-quick-\(chief.uid)")
                Button {
                    sendQuick(to: chief)
                } label: {
                    Image(systemName: sending ? "hourglass" : "arrow.up.circle.fill")
                        .font(.ah(.title3))
                        .foregroundStyle(draftBinding.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? theme.faint : theme.accent)
                }
                .buttonStyle(.plain)
                .disabled(sending || draftBinding.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send to \(chief.title)")
            }
            .padding(.top, 2)
        }
        .padding(.vertical, 4)
        .ahRow()
    }
}

/// Space Portal → Notes tab: notes filed in this Space, one-tap creation, and Promote to Knowledge.
struct SpaceNotesContent: View {
    let scene: SceneModel
    let hub: HubStore
    let project: InboxProject
    let portal: SpacePortalModel
    let notes: [NotesModel.Summary]
    @Environment(\.theme) private var theme

    private var hostParam: String? { project.host == hub.hostname ? nil : project.host }
    private var hostState: HubStateDTO? { hub.state(host: hostParam) }
    private var space: SpaceDTO? { hub.spaces.space(project) }
    private var canPromote: Bool { space?.kind == .space || hostState?.supports("spaces", version: 2) == true }
    private var spacePath: String? {
        SpacePortalLogic.resolveSpacePath(
            project: project,
            space: space,
            rows: hub.rows,
            history: hub.history,
            home: hostState?.home
        )
    }
    private var chiefs: [SessionRow] {
        SpacePortalLogic.chiefsInSpace(hub.rows, spaceName: project.name, spacePath: spacePath, host: project.host, home: hostState?.home)
    }

    var body: some View {
        Section {
            if let error = portal.error {
                Banner(text: error, tone: .error)
            }
            Button {
                let noteProject = spacePath.map { NoteProject(origin: scene.accountOrigin, host: project.host, path: $0) }
                scene.newNote(project: .some(noteProject))
            } label: {
                Label("New Note in \(project.name)", systemImage: "square.and.pencil")
                    .font(.ah(.subheadline).weight(.medium))
            }
            .ahRow()
            .accessibilityIdentifier("space-notes-new")
        }
        if notes.isEmpty {
            Section {
                EmptyState(
                    symbol: "note.text",
                    title: "No Notes in \(project.name)",
                    message: "Create a note here to keep specs, decisions, and prompts attached to this Space."
                )
                .listRowBackground(Color.clear)
            }
        } else {
            Section {
                ForEach(notes) { note in
                    HStack(spacing: 8) {
                        NoteRowView(note: note, dense: false, showsProject: false) { scene.open(note.key) }
                        if chiefs.count == 1, let sole = chiefs.first {
                            Button {
                                sendNoteToChief(note, chief: sole)
                            } label: {
                                Image(systemName: "crown.fill")
                                    .font(.ah(.caption).weight(.semibold))
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityLabel("Send \(note.title) to \(sole.title)")
                        } else if chiefs.count > 1 {
                            Menu {
                                ForEach(chiefs) { chief in
                                    Button(chief.title, systemImage: "crown") {
                                        sendNoteToChief(note, chief: chief)
                                    }
                                }
                            } label: {
                                Image(systemName: "crown.fill")
                                    .font(.ah(.caption).weight(.semibold))
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .accessibilityLabel("Send \(note.title) to Chief")
                        }
                        if canPromote {
                            let busy = portal.promotingNoteId == note.id
                            Button {
                                promote(note)
                            } label: {
                                Image(systemName: busy ? "hourglass" : "brain.head.profile")
                                    .font(.ah(.caption).weight(.semibold))
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(portal.promotingNoteId != nil)
                            .accessibilityLabel("Promote \(note.title) to Space Knowledge")
                            .accessibilityIdentifier("space-note-promote-\(note.id)")
                        }
                    }
                    .tag(note.key)
                    .draggable(SessionDrag(key: note.key))
                    .contextMenu {
                        if canPromote {
                            Button("Promote to Space Knowledge", systemImage: "brain.head.profile") {
                                promote(note)
                            }
                            Divider()
                        }
                        NoteRowMenu(note: note, scene: scene)
                    }
                    .swipeActions(edge: .leading) {
                        if canPromote {
                            Button {
                                promote(note)
                            } label: {
                                Label("Promote", systemImage: "brain.head.profile")
                            }
                            .tint(theme.accent)
                        }
                    }
                    .swipeActions(edge: .trailing) {
                        Button { scene.sheet = .noteDelete(note.id) } label: { Image(systemName: "trash") }
                            .tint(theme.danger)
                            .accessibilityLabel("Delete")
                    }
                    .ahRow()
                }
            } header: {
                AhSectionHeader(title: "Space Notes", count: notes.count)
            }
        }
    }

    private func sendNoteToChief(_ note: NotesModel.Summary, chief: SessionRow) {
        guard let origin = scene.accountOrigin else {
            scene.toast("Not signed in to a host.", error: true)
            return
        }
        let destination = NoteHandoff.Destination(
            key: chief.key,
            ref: chief.uid,
            title: chief.title,
            host: hostParam,
            live: true
        )
        let api = hub.client(host: hostParam)
        let keepsNotes = hostState?.supports("notes") == true
        let asFile = (scene.notes.note(note.id)?.markdown.utf16.count ?? 0) > NoteHandoff.maxText
        Task {
            let (result, _) = await NoteHandoff.send(
                note.id,
                to: destination,
                notes: scene.notes,
                api: api,
                hostKeepsNotes: keepsNotes,
                reachable: true,
                asFile: asFile,
                origin: origin
            )
            if result.arrived {
                scene.notes.recordSession(
                    note.id,
                    NoteSessionDTO(
                        uid: chief.uid,
                        host: hostParam ?? hub.hostname ?? "",
                        title: chief.title,
                        via: "handoff",
                        at: Date().timeIntervalSince1970.rounded(.down)
                    )
                )
            }
            scene.toast(result.arrived ? "Sent \"\(note.title)\" to \(chief.title)" : result.sentence, error: !result.arrived)
        }
    }

    private func promote(_ note: NotesModel.Summary) {
        let markdown = scene.notes.note(note.id)?.markdown ?? ""
        let api = hub.client(host: hostParam)
        Task {
            if let file = await portal.promoteNote(api: api, space: project.name, title: note.title, markdown: markdown, noteId: note.id) {
                scene.toast("Promoted to \(file)")
            } else if let err = portal.error {
                scene.toast(err, error: true)
            }
        }
    }
}

/// Space Portal → Files & Artifacts tab: browse the Space's directory, jump to Space-owned
/// artifacts/ or memory/ (outside git for repos), preview text/media, create folders, or send a
/// file reference to any active Chief in this Space.
struct SpaceFilesContent: View {
    let scene: SceneModel
    let hub: HubStore
    let project: InboxProject
    let portal: SpacePortalModel
    @State private var model: FilesModel?
    @State private var reading: SpaceFileText?
    @State private var previewURL: URL?
    @State private var sharing: URL?
    @State private var newFolder: String?
    @State private var importing = false
    @Environment(\.theme) private var theme

    private var hostParam: String? { project.host == hub.hostname ? nil : project.host }
    private var hostState: HubStateDTO? { hub.state(host: hostParam) }
    private var space: SpaceDTO? { hub.spaces.space(project) }
    private var supportsSpaceContext: Bool { hostState?.supports("spaces", version: 2) == true }
    private var spacePath: String? {
        SpacePortalLogic.resolveSpacePath(project: project, space: space, rows: hub.rows, history: hub.history, home: hostState?.home)
    }
    private var contextPath: String? {
        SpacePortalLogic.resolveContextPath(space: space, spacePath: spacePath, home: hostState?.home)
    }
    private var chiefs: [SessionRow] {
        SpacePortalLogic.chiefsInSpace(hub.rows, spaceName: project.name, spacePath: spacePath, host: project.host, home: hostState?.home)
    }

    var body: some View {
        Group {
            if let rootPath = spacePath ?? contextPath {
                Section {
                    quickJumps(rootPath)
                        .ahRow()
                    if let error = model?.error {
                        Banner(text: error, tone: .error)
                    }
                } header: {
                    AhSectionHeader(title: currentTitle(rootPath: rootPath))
                }
                if let listing = model?.listing {
                    if listing.entries.isEmpty {
                        Section {
                            EmptyState(symbol: "folder", title: "Empty Folder", message: "No files here yet.")
                                .listRowBackground(Color.clear)
                        }
                    } else {
                        Section {
                            ForEach(listing.entries, id: \.name) { entry in
                                fileRow(entry)
                            }
                        } header: {
                            AhSectionHeader(title: "Contents", count: listing.entries.count)
                        }
                    }
                } else if model?.error == nil {
                    Section {
                        ProgressView().frame(maxWidth: .infinity).ahRow()
                    }
                }
            } else {
                Section {
                    EmptyState(symbol: "folder.badge.questionmark", title: "No Folder Path", message: "This Space doesn’t have a folder on the host yet.")
                        .listRowBackground(Color.clear)
                }
            }
        }
        .task(id: "\(project.host)/\(project.name)/\(spacePath ?? contextPath ?? "")") {
            let api = hub.client(host: hostParam)
            let files = FilesModel(api: api)
            model = files
            if let path = spacePath ?? contextPath {
                await files.open(path)
            }
        }
        .quickLook($previewURL)
        .sheet(item: $reading) { file in
            SpaceFilePreviewSheet(file: file, onCopy: { scene.copy(file.path, say: "the path") })
        }
        .sheet(item: Binding(get: { sharing.map(SpaceSharedURL.init) }, set: { sharing = $0?.url })) { shared in
            ActivitySheet(items: [shared.url])
        }
        .alert("New Folder", isPresented: Binding(get: { newFolder != nil }, set: { if !$0 { newFolder = nil } })) {
            TextField("Folder name", text: Binding(get: { newFolder ?? "" }, set: { newFolder = $0 }))
            Button("Create") {
                let name = (newFolder ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                newFolder = nil
                if !name.isEmpty { Task { await model?.makeFolder(name) } }
            }
            Button("Cancel", role: .cancel) { newFolder = nil }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result, let model else { return }
            Task {
                for url in urls {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    if let data = try? Data(contentsOf: url) {
                        await model.upload(name: url.lastPathComponent, data: data)
                    }
                }
                if model.error == nil {
                    scene.toast(urls.count == 1 ? "Uploaded \(urls[0].lastPathComponent)" : "Uploaded \(urls.count) files")
                }
            }
        }
    }

    private func currentTitle(rootPath: String) -> String {
        guard let current = model?.listing?.path else { return project.name }
        if let ctx = contextPath, ctx != rootPath, current == ctx || current.hasPrefix(ctx + "/") {
            let rel = FilesModel.relative(current, to: ctx)
            return rel == "." ? "Space Context/" : "Space Context/\(rel)"
        }
        let rel = FilesModel.relative(current, to: rootPath)
        return rel == "." ? "\(project.name)/" : "\(project.name)/\(rel)"
    }

    private func quickJumps(_ rootPath: String) -> some View {
        let contextBase = contextPath ?? rootPath
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if let parent = model?.listing?.parent, let current = model?.listing?.path,
                   current != rootPath && current != contextPath {
                    Button {
                        Task { await model?.open(parent) }
                    } label: {
                        Label("Up", systemImage: "chevron.up")
                            .font(.ah(.caption).weight(.medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                Button {
                    Task { await model?.open(rootPath) }
                } label: {
                    Label("\(project.name)/", systemImage: "house")
                        .font(.ah(.caption).weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button {
                    let api = hub.client(host: hostParam)
                    Task {
                        let target = await portal.ensureSubfolder(api: api, basePath: contextBase, name: "artifacts")
                        await model?.open(target)
                    }
                } label: {
                    Label("artifacts/", systemImage: "shippingbox")
                        .font(.ah(.caption).weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .accessibilityIdentifier("space-files-artifacts")
                if space?.kind == .space || supportsSpaceContext {
                    Button {
                        let api = hub.client(host: hostParam)
                        Task {
                            let target = await portal.ensureSubfolder(api: api, basePath: contextBase, name: "memory")
                            await model?.open(target)
                        }
                    } label: {
                        Label("memory/", systemImage: "brain.head.profile")
                            .font(.ah(.caption).weight(.medium))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                Button {
                    newFolder = ""
                } label: {
                    Label("New Folder", systemImage: "folder.badge.plus")
                        .font(.ah(.caption).weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                Button {
                    importing = true
                } label: {
                    Label(model?.uploading.isEmpty == false ? "Uploading…" : "Upload", systemImage: "arrow.up.doc")
                        .font(.ah(.caption).weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(model?.uploading.isEmpty == false)
                .accessibilityIdentifier("space-files-upload")
                Button {
                    guard let model else { return }
                    model.showHidden.toggle()
                    Task { await model.reload() }
                } label: {
                    Label(model?.showHidden == true ? "Hide Dotfiles" : "Hidden", systemImage: model?.showHidden == true ? "eye.slash" : "eye")
                        .font(.ah(.caption).weight(.medium))
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            .padding(.vertical, 2)
        }
    }

    private func sendFileToChief(_ chief: SessionRow, path: String) {
        let mention = FilesModel.mention(path, shell: false, cwd: spacePath)
        let api = hub.client(host: hostParam)
        Task {
            do {
                _ = try await api.send(chief.uid, text: "Please inspect \(mention.trimmingCharacters(in: .whitespaces))", enter: true)
                scene.toast("Sent file to \(chief.title)")
            } catch {
                if let s = scene.session(chief.key) {
                    s.composer.insert(mention)
                }
                scene.open(chief.key)
                scene.requestFocus(.composer(chief.key))
            }
        }
    }

    private func fileRow(_ entry: FsEntry) -> some View {
        let kind = FilesModel.Kind(entry)
        let path = model?.child(entry) ?? entry.name
        return Button {
            Task { await open(entry) }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: kind.symbol)
                    .font(.ah(.body))
                    .foregroundStyle(kind == .folder ? theme.accent : theme.muted)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.name)
                        .font(.ah(.subheadline))
                        .foregroundStyle(theme.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(fileDetail(entry))
                        .font(.ah(.caption))
                        .foregroundStyle(theme.faint)
                        .lineLimit(1)
                }
                Spacer(minLength: 4)
                if entry.type == .dir {
                    Image(systemName: "chevron.right")
                        .font(.ah(.caption).weight(.semibold))
                        .foregroundStyle(theme.faint)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(entry.type == .dir ? "Open" : "Preview", systemImage: entry.type == .dir ? "folder" : "eye") {
                Task { await open(entry) }
            }
            Button("Copy Path", systemImage: "doc.on.doc") {
                scene.copy(path, say: "the path")
            }
            if chiefs.count == 1, let chief = chiefs.first {
                Button("Send to \(chief.title)", systemImage: "crown") {
                    sendFileToChief(chief, path: path)
                }
            } else if chiefs.count > 1 {
                Menu("Send to Chief", systemImage: "crown") {
                    ForEach(chiefs) { chief in
                        Button(chief.title) {
                            sendFileToChief(chief, path: path)
                        }
                    }
                }
            }
            if entry.type == .file {
                Button("Share or Save…", systemImage: "square.and.arrow.up") {
                    Task { await share(entry) }
                }
            }
        }
        .ahRow()
    }

    private func fileDetail(_ entry: FsEntry) -> String {
        let when = ElapsedWords.date(epoch: entry.mtime)
        let age = when.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
        guard entry.type == .file else { return age }
        return "\(ByteCountFormatter.string(fromByteCount: Int64(entry.size), countStyle: .file)) · \(age)"
    }

    private func open(_ entry: FsEntry) async {
        guard let model else { return }
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
            reading = SpaceFileText(path: path, text: text)
            return
        }
        previewURL = writeTemp(data, named: entry.name)
    }

    private func share(_ entry: FsEntry) async {
        guard let model, let data = await model.data(model.child(entry)) else { return }
        sharing = writeTemp(data, named: entry.name)
    }

    private func writeTemp(_ data: Data, named name: String) -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent(name)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        return (try? data.write(to: url, options: [.completeFileProtection])) == nil ? nil : url
    }
}

private struct SpaceFileText: Identifiable {
    let id = UUID()
    let path: String
    let text: String
    var name: String { (path as NSString).lastPathComponent }
}

private struct SpaceSharedURL: Identifiable {
    let url: URL
    var id: URL { url }
}

private struct SpaceFilePreviewSheet: View {
    let file: SpaceFileText
    let onCopy: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            ScrollView([.vertical, .horizontal]) {
                Text(file.text)
                    .font(.ahMono(.caption))
                    .foregroundStyle(theme.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(file.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button("Copy Path", systemImage: "doc.on.doc") { onCopy() }
                }
            }
        }
    }
}

/// Space Portal → Tasks tab: durable Space-scoped fleet task ledger (`features.fleet` 1).
struct SpaceTasksContent: View {
    let scene: SceneModel
    let hub: HubStore
    let project: InboxProject
    let portal: SpacePortalModel
    @State private var newTitle = ""
    @State private var newPriority = 2
    @State private var newAssignee = ""
    @State private var adding = false
    @Environment(\.theme) private var theme

    private var hostParam: String? { project.host == hub.hostname ? nil : project.host }
    private var hostState: HubStateDTO? { hub.state(host: hostParam) }
    private var api: APIClient { hub.client(host: hostParam) }
    private var spaceSessions: [SessionRow] { hub.rows.filter { project.holds($0) } }

    var body: some View {
        Group {
            if let error = portal.taskError {
                Section { Banner(text: error, tone: .error) }
            }
            Section {
                HStack(spacing: 8) {
                    TextField("New task in \(project.name)…", text: $newTitle)
                        .submitLabel(.done)
                        .onSubmit { submit() }
                        .accessibilityIdentifier("space-task-title")
                    Button("Add") { submit() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .tint(theme.accent)
                        .disabled(adding || newTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("space-task-add")
                }
                .ahRow()
                HStack(spacing: 12) {
                    Picker("Priority", selection: $newPriority) {
                        Text("P0 Urgent").tag(0)
                        Text("P1 High").tag(1)
                        Text("P2 Normal").tag(2)
                        Text("P3 Low").tag(3)
                    }
                    .pickerStyle(.menu)
                    .font(.ah(.caption))
                    if !spaceSessions.isEmpty {
                        Picker("Assign", selection: $newAssignee) {
                            Text("Unassigned").tag("")
                            ForEach(spaceSessions) { row in
                                Text(row.title).tag(row.uid)
                            }
                        }
                        .pickerStyle(.menu)
                        .font(.ah(.caption))
                    }
                }
                .ahRow()
            } header: {
                AhSectionHeader(title: "Add Task")
            }

            if portal.loadingTasks && portal.tasks.isEmpty {
                Section { ProgressView().frame(maxWidth: .infinity).ahRow() }
            } else if portal.tasks.isEmpty {
                Section {
                    EmptyState(
                        symbol: "checklist",
                        title: "No Tasks in \(project.name)",
                        message: "Add tasks here or ask your Chief of Staff to track deliverables for this Space."
                    )
                    .listRowBackground(Color.clear)
                }
            } else {
                Section {
                    ForEach(portal.tasks) { task in
                        taskRow(task)
                    }
                } header: {
                    AhSectionHeader(title: "Space Tasks", count: portal.tasks.count)
                }
            }
        }
        .task(id: "\(project.host)/\(project.name)/\(hostState?.fleet?.revision ?? 0)") {
            await portal.loadTasks(api: api, space: project.name)
        }
    }

    private func submit() {
        let title = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty, !adding else { return }
        adding = true
        let assignee = newAssignee.isEmpty ? nil : newAssignee
        let priority = newPriority
        Task {
            defer { adding = false }
            if await portal.createTask(api: api, space: project.name, title: title, priority: priority, assignedUid: assignee) {
                newTitle = ""
            }
        }
    }

    private func taskRow(_ task: FleetTaskDTO) -> some View {
        let assigneeTitle = task.assignedUid.flatMap { uid in
            hub.rows.first(where: { $0.host == project.host && $0.uid == uid })?.title ?? uid
        }
        return HStack(alignment: .top, spacing: 10) {
            Menu {
                ForEach(FleetTaskStatus.allCases, id: \.self) { status in
                    Button {
                        Task { await portal.updateTaskStatus(api: api, id: task.id, status: status) }
                    } label: {
                        Label(status.label, systemImage: status.symbol)
                    }
                }
            } label: {
                Image(systemName: task.status.symbol)
                    .font(.ah(.body))
                    .foregroundStyle(statusColor(task.status))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Task status \(task.status.label)")

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(task.title)
                        .font(.ah(.subheadline).weight(.medium))
                        .foregroundStyle(task.status == .done || task.status == .cancelled ? theme.muted : theme.text)
                        .strikethrough(task.status == .done || task.status == .cancelled)
                    Spacer(minLength: 4)
                    Text("P\(task.priority)")
                        .font(.ah(.caption2).weight(.semibold))
                        .foregroundStyle(task.priority <= 1 ? theme.danger : theme.muted)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(theme.raised, in: Capsule())
                }
                if !task.description.isEmpty {
                    Text(task.description)
                        .font(.ah(.caption))
                        .foregroundStyle(theme.muted)
                        .lineLimit(2)
                }
                if let result = task.result, !result.isEmpty {
                    Text(result)
                        .font(.ah(.caption2))
                        .foregroundStyle(theme.text2)
                        .lineLimit(2)
                }
                HStack(spacing: 8) {
                    Text(task.status.label)
                        .font(.ah(.caption2))
                        .foregroundStyle(statusColor(task.status))
                    if let assigneeTitle {
                        let assigneeRow = task.assignedUid.flatMap { uid in hub.rows.first(where: { $0.host == project.host && $0.uid == uid }) }
                        if let assigneeRow {
                            Button {
                                scene.open(assigneeRow.key)
                            } label: {
                                Text("· \(assigneeTitle)")
                                    .font(.ah(.caption2).weight(.medium))
                                    .foregroundStyle(theme.accent)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.plain)
                        } else {
                            Text("· \(assigneeTitle)")
                                .font(.ah(.caption2))
                                .foregroundStyle(theme.muted)
                                .lineLimit(1)
                        }
                    }
                    if let verify = task.lastVerify {
                        Text("· verify: \(verify.ok ? "pass" : "fail")")
                            .font(.ah(.caption2).weight(.medium))
                            .foregroundStyle(verify.ok ? theme.done : theme.danger)
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .contextMenu {
            Menu("Set Status", systemImage: "checklist") {
                ForEach(FleetTaskStatus.allCases, id: \.self) { status in
                    Button {
                        Task { await portal.updateTaskStatus(api: api, id: task.id, status: status) }
                    } label: {
                        Label(status.label, systemImage: status.symbol)
                    }
                }
            }
            if !spaceSessions.isEmpty {
                Menu("Assign to", systemImage: "person") {
                    Button("Unassigned") {
                        Task { await portal.reassignTask(api: api, id: task.id, assignedUid: nil) }
                    }
                    ForEach(spaceSessions) { row in
                        Button(row.title) {
                            Task { await portal.reassignTask(api: api, id: task.id, assignedUid: row.uid) }
                        }
                    }
                }
            }
            Divider()
            Button("Delete", systemImage: "trash", role: .destructive) {
                Task { await portal.deleteTask(api: api, id: task.id) }
            }
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) {
                Task { await portal.deleteTask(api: api, id: task.id) }
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        .ahRow()
    }

    private func statusColor(_ status: FleetTaskStatus) -> Color {
        switch status {
        case .done: theme.done
        case .blocked: theme.danger
        case .inProgress, .inReview: theme.accent
        case .todo, .cancelled: theme.muted
        }
    }
}

/// Space Portal → Knowledge tab: inline Space-owned Preferences (`AGENTS.md`) and `memory/*.md`
/// (stored outside git for Repository/Folder Spaces on `spaces` 2 hosts).
struct SpaceMemoryContent: View {
    let hub: HubStore
    let project: InboxProject
    @State private var model: SpaceSettingsModel?
    @State private var opened: String?
    @State private var drafts: [String: String] = [:]
    @State private var newFile = ""
    @State private var pendingDeleteFile: String?
    @Environment(\.theme) private var theme

    private var hostParam: String? { project.host == hub.hostname ? nil : project.host }
    private var hostState: HubStateDTO? { hub.state(host: hostParam) }
    private var space: SpaceDTO? { hub.spaces.space(project) }
    private var supportsSpaceContext: Bool { hostState?.supports("spaces", version: 2) == true }

    var body: some View {
        Group {
            if let model {
                if let error = model.error {
                    Section { Banner(text: error, tone: .error) }
                }
                Section {
                    TextEditor(text: Binding(get: { model.preferences }, set: { model.preferences = $0 }))
                        .font(.ahMono(.callout))
                        .frame(minHeight: 140)
                        .accessibilityLabel("Space Preferences")
                        .ahRow()
                    Button(model.justSaved ? "Saved" : "Save Preferences") {
                        Task { await model.savePreferences() }
                    }
                    .disabled(model.busy || !model.preferencesChanged)
                    .ahRow()
                } header: {
                    AhSectionHeader(title: "Preferences (AGENTS.md)")
                } footer: {
                    if let ctx = space?.contextPath, ctx != space?.path {
                        Text("Stored in Space-owned context (\(ctx)) so your repository stays clean.")
                            .font(.ah(.caption))
                            .foregroundStyle(theme.muted)
                    }
                }
                Section {
                    if let files = model.memory {
                        ForEach(files) { file in
                            memoryRow(file, model)
                        }
                    } else if model.error == nil {
                        ProgressView().frame(maxWidth: .infinity).ahRow()
                    }
                    HStack {
                        TextField("New memory file, e.g. decisions", text: $newFile)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .onSubmit { addFile(model) }
                        Button("Add") { addFile(model) }
                            .disabled(newFile.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                    .ahRow()
                } header: {
                    AhSectionHeader(title: "Knowledge & Memory (memory/)", count: model.memory?.count ?? 0)
                }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity).ahRow() }
            }
        }
        .task(id: "\(project.host)/\(project.name)/\(space?.kind.rawValue ?? "")/\(supportsSpaceContext)") {
            let m = SpaceSettingsModel(
                api: hub.client(host: hostParam),
                name: project.name,
                kind: space?.kind ?? .space,
                supportsSpaceContext: supportsSpaceContext
            )
            model = m
            await m.load()
        }
        .alert("Delete Memory File?", isPresented: Binding(get: { pendingDeleteFile != nil }, set: { if !$0 { pendingDeleteFile = nil } })) {
            Button("Delete", role: .destructive) {
                let target = pendingDeleteFile
                pendingDeleteFile = nil
                if let target, let model { Task { await model.deleteMemory(target) } }
            }
            Button("Cancel", role: .cancel) { pendingDeleteFile = nil }
        } message: {
            Text("Agents in \(project.name) will stop reading \(pendingDeleteFile ?? "this file"). This can’t be undone.")
        }
    }

    @ViewBuilder
    private func memoryRow(_ file: SpaceMemoryFileDTO, _ model: SpaceSettingsModel) -> some View {
        let isOpen = opened == file.name
        Button {
            withAnimation(.snappy) { opened = isOpen ? nil : file.name }
        } label: {
            HStack {
                Text(file.name).font(.ahMono(.callout)).foregroundStyle(theme.text)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.ah(.caption))
                    .foregroundStyle(theme.muted)
                    .rotationEffect(.degrees(isOpen ? 90 : 0))
            }
        }
        .ahRow()
        if isOpen {
            if file.truncated == true {
                Text("Only the first 256 KB is shown; saving keeps only what’s shown here.")
                    .font(.ah(.caption))
                    .foregroundStyle(theme.brand)
                    .ahRow()
            }
            TextEditor(text: Binding(get: { drafts[file.name] ?? file.text }, set: { drafts[file.name] = $0 }))
                .font(.ahMono(.callout))
                .frame(minHeight: 130)
                .ahRow()
            HStack {
                if file.name != "MEMORY.md" {
                    Button("Delete", role: .destructive) {
                        pendingDeleteFile = file.name
                    }
                    .buttonStyle(.borderless)
                }
                Spacer()
                Button("Save") {
                    Task { if await model.saveMemory(file.name, text: drafts[file.name] ?? file.text) { drafts[file.name] = nil } }
                }
                .buttonStyle(.borderless)
                .disabled(drafts[file.name] == nil || drafts[file.name] == file.text)
            }
            .ahRow()
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
}

/// Sheet to start a Chief of Staff session for a Space (`SceneModel.Sheet.startChief`).
struct StartChiefSheet: View {
    let scene: SceneModel
    let project: InboxProject
    @State private var presetID = ""
    @State private var name = ""
    @State private var scopedToSpace = true
    @State private var adoptUnmanaged = true
    @State private var customInstructions = ""
    @State private var busy = false
    @State private var error: String?
    @Environment(\.theme) private var theme

    private var hub: HubStore? { scene.hub }
    private var hostParam: String? { hub.flatMap { project.host == $0.hostname ? nil : project.host } }
    private var hostState: HubStateDTO? { hub?.state(host: hostParam) }
    private var space: SpaceDTO? { hub?.spaces.space(project) }
    private var spacePath: String {
        guard let hub else { return "~" }
        return SpacePortalLogic.resolveSpacePath(project: project, space: space, rows: hub.rows, history: hub.history, home: hostState?.home) ?? "~"
    }
    private var presets: [PresetDTO] {
        let all = (hub?.presets(host: hostParam) ?? []).filter { $0.offered && !$0.isShell }
        let recent = scene.app.preferences.recentAgents
        return all.sorted { (recent.firstIndex(of: $0.id) ?? 99) < (recent.firstIndex(of: $1.id) ?? 99) }
    }
    private var unmanaged: [SessionRow] {
        hub.map { SpacePortalLogic.unmanagedInSpace($0.rows, spaceName: project.name, host: project.host) } ?? []
    }
    private var spaceSessions: [SessionRow] {
        hub?.rows.filter { project.holds($0) } ?? []
    }

    var body: some View {
        NavigationStack {
            Form {
                if let error { Banner(text: error, tone: .error).formBanner() }
                Section {
                    Picker("Agent", selection: $presetID) {
                        ForEach(presets, id: \.id) { preset in
                            Text(preset.name).tag(preset.id)
                        }
                    }
                    TextField("Chief name", text: $name)
                        .accessibilityIdentifier("chief-name")
                } header: {
                    Text("Chief of Staff")
                } footer: {
                    Text("Starts in \(spacePath) with direct access to the Space’s files, artifacts/, and sessions.")
                }

                Section {
                    Toggle("Scoped to \(project.name)", isOn: $scopedToSpace)
                    if !unmanaged.isEmpty {
                        Toggle("Adopt \(unmanaged.count) unmanaged \(unmanaged.count == 1 ? "session" : "sessions")", isOn: $adoptUnmanaged)
                    }
                } header: {
                    Text("Supervision")
                } footer: {
                    Text(scopedToSpace
                         ? "Control flows strictly downward within \(project.name). You can still run multiple Chiefs in the same Space if needed."
                         : "Host-wide Chief: can supervise sessions across any Space on \(project.host).")
                }

                Section {
                    TextEditor(text: $customInstructions)
                        .font(.ah(.callout))
                        .frame(minHeight: 100)
                        .accessibilityLabel("Initial instructions")
                } header: {
                    Text("Additional Instructions (Optional)")
                } footer: {
                    Text("Sent alongside the Space Chief kickoff brief as the first message.")
                }
            }
            .navigationTitle("Start Chief of Staff")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .cancel) { scene.sheet = nil }
                        .keyboardShortcut(.cancelAction)
                        .tint(.primary)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Starting…" : "Start Chief") { Task { await start() } }
                        .disabled(busy || presetID.isEmpty)
                        .keyboardShortcut(.defaultAction)
                        .accessibilityIdentifier("chief-start-confirm")
                }
            }
            .onAppear {
                if presetID.isEmpty, let first = presets.first { presetID = first.id }
                if name.isEmpty { name = "\(project.name) Chief" }
            }
        }
    }

    private func start() async {
        guard let hub, !presetID.isEmpty, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }

        let state = hostState
        let tmux = LaunchState.tmuxChoices(sessions: state?.sessions ?? [], defaultSession: state?.defaultSession ?? "")
        let tmuxSession = tmux.initial ?? (state?.defaultSession ?? "ah")
        let label = name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "\(project.name) Chief" : name.trimmingCharacters(in: .whitespacesAndNewlines)
        let supervision = SupervisionDTO(
            role: .chief,
            space: scopedToSpace ? project.name : nil
        )
        let req = NewSessionRequest(
            preset: presetID,
            cwd: spacePath,
            session: tmuxSession,
            label: label,
            worktree: false,
            space: project.name,
            supervision: supervision
        )

        guard let key = await scene.create(req, host: hostParam) else {
            error = "Could not start Chief of Staff."
            return
        }

        let chiefUid = key.split(separator: "/").last.map(String.init) ?? key
        let api = hub.client(host: hostParam)
        if adoptUnmanaged && !unmanaged.isEmpty {
            let targets = unmanaged
            let portal = SpacePortalModel()
            let result = await portal.adoptAll(api: api, chiefUid: chiefUid, sessions: targets)
            if result.adopted > 0 { hub.refresh(host: hostParam) }
            if result.failed > 0 {
                scene.toast("Adopted \(result.adopted) of \(targets.count); \(result.failed) failed", error: true)
            }
        }

        let briefText: String = await {
            if state?.supports("spaces", version: 2) == true,
               let serverBrief = try? await api.spaceBrief(project.name, instructions: customInstructions) {
                return serverBrief.brief
            }
            let ctxPath = SpacePortalLogic.resolveContextPath(space: space, spacePath: spacePath, home: state?.home)
            return SpacePortalLogic.buildSpaceChiefBrief(
                spaceName: project.name,
                spacePath: spacePath,
                spaceKind: space?.kind ?? .folder,
                sessions: spaceSessions,
                customInstructions: customInstructions,
                contextPath: ctxPath
            )
        }()

        // Wait briefly for the live session row & GUI, then deliver the kickoff brief.
        for _ in 0..<60 where hub.row(key) == nil { try? await Task.sleep(for: .milliseconds(100)) }
        if let session = scene.session(key) {
            for _ in 0..<80 where !session.hasGUI { try? await Task.sleep(for: .milliseconds(100)) }
            session.composer.text = briefText
            session.composer.submit(working: false)
        } else {
            scene.toast("Chief started, but kickoff brief could not be delivered yet", error: true)
        }
        scene.sheet = nil
        scene.open(key)
    }
}

/// Sheet inspecting the live Space context bundle (`GET /api/spaces/:name/context`) injected into
/// harnesses running inside this Space.
private struct SpaceContextSheet: View {
    let scene: SceneModel
    let api: APIClient
    let spaceName: String
    let portal: SpacePortalModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            Group {
                if portal.loadingContext && portal.context == nil {
                    ProgressView("Loading Space Context…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let error = portal.contextError, portal.context == nil {
                    VStack(spacing: 12) {
                        Banner(text: error, tone: .error)
                        Button("Retry") {
                            Task { await portal.loadContext(api: api, space: spaceName) }
                        }
                        .buttonStyle(.borderedProminent)
                    }
                    .padding()
                } else if let ctx = portal.context {
                    List {
                        if let error = portal.contextError {
                            Section { Banner(text: error, tone: .error) }
                        }
                        Section {
                            LabeledContent("Context Dir") {
                                Text(ctx.contextPath)
                                    .font(.ahMono(.caption))
                                    .foregroundStyle(theme.muted)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .ahRow()
                            LabeledContent("Context File") {
                                Text(ctx.contextFile)
                                    .font(.ahMono(.caption))
                                    .foregroundStyle(theme.muted)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                            }
                            .ahRow()
                            LabeledContent("Artifacts") {
                                Text("\(ctx.artifacts.count)")
                                    .font(.ah(.callout).monospacedDigit())
                                    .foregroundStyle(theme.muted)
                            }
                            .ahRow()
                            if !ctx.roots.isEmpty {
                                LabeledContent("Roots") {
                                    Text(ctx.roots.joined(separator: ", "))
                                        .font(.ahMono(.caption))
                                        .foregroundStyle(theme.muted)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.trailing)
                                }
                                .ahRow()
                            }
                        } header: {
                            AhSectionHeader(title: "Injected Bundle")
                        } footer: {
                            Text("Harnesses launched in \(spaceName) receive this context via AH_SPACE_CONTEXT_FILE, CLI flags, MCP tools, and SessionStart hooks.")
                                .font(.ah(.caption))
                                .foregroundStyle(theme.muted)
                        }
                        Section {
                            ScrollView(.horizontal, showsIndicators: true) {
                                Text(ctx.markdown)
                                    .font(.ahMono(.caption))
                                    .foregroundStyle(theme.text)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 4)
                            }
                            .ahRow()
                        } header: {
                            AhSectionHeader(title: "Rendered Context Markdown")
                        }
                    }
                    .listStyle(.insetGrouped)
                    .scrollContentBackground(.hidden)
                } else {
                    EmptyState(
                        symbol: "doc.text.magnifyingglass",
                        title: "No Space Context Yet",
                        message: "Add preferences, memory entries, or artifacts to populate the harness context bundle."
                    )
                }
            }
            .navigationTitle("\(spaceName) Context")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if let md = portal.context?.markdown, !md.isEmpty {
                        Button("Copy", systemImage: "doc.on.doc") {
                            scene.copy(md, say: "Space context")
                        }
                    }
                    Button("Refresh", systemImage: "arrow.clockwise") {
                        Task { await portal.loadContext(api: api, space: spaceName) }
                    }
                    .disabled(portal.loadingContext)
                }
            }
            .task(id: spaceName) {
                await portal.loadContext(api: api, space: spaceName)
            }
        }
    }
}
