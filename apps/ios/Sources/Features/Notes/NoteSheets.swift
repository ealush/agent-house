import SwiftUI
import UIKit

// The sheets a note opens: hand it to a session (sent, or put in its box), save it as a file
// in a project, file it under a project, and choose between two versions of it.

private func closeButton(_ scene: SceneModel) -> some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) { Button(role: .cancel) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
}

/// Folders as the host names them: "~/code/x" read against its home, so one folder is one
/// project however it was written.
enum NoteProjects {
    static func normalize(_ path: String, home: String) -> String {
        guard !home.isEmpty else { return path }
        if path == "~" { return home }
        if path.hasPrefix("~/") { return home + path.dropFirst(1) }
        return path
    }

    /// The projects this window knows on `host` (nil: the hub): its sessions', its history's.
    @MainActor
    static func known(_ scene: SceneModel, host: String?) -> [String] {
        guard let hub = scene.hub else { return [] }
        let name = host ?? hub.hostname ?? ""
        let home = hub.state(host: host)?.home ?? ""
        var paths = hub.rows.filter { $0.host == name }.map(\.dto.projectPath)
        paths += hub.history.filter { $0.host == name }.map(\.dto.cwd)
        var seen = Set<String>(), out: [String] = []
        for p in paths.map({ normalize($0, home: home) }) where !p.isEmpty && p != home && seen.insert(p).inserted { out.append(p) }
        return out
    }

    /// Hosts a note's project can be on: the hub and the peers that are up.
    @MainActor
    static func hosts(_ scene: SceneModel) -> [String] {
        guard let hub = scene.hub, let me = hub.hostname else { return [] }
        return [me] + hub.hosts.filter { !$0.isSelf && $0.online }.map(\.name)
    }
}

// MARK: Send or put in a box

struct NoteSendSheet: View {
    let scene: SceneModel
    let id: String
    let insert: Bool
    @Environment(\.theme) private var theme
    @State private var target: String?
    @State private var asFile = false
    @State private var busy = false
    @State private var outcome: NoteHandoff.Outcome?
    @State private var record: NoteHandoffRecord?
    @State private var askCombine = false
    /// The draft found in the chosen box, asked about before the note goes in with it.
    @State private var found = ""
    /// The host couldn't say what the chosen box holds: only an explicit Replace goes on.
    @State private var draftUnknown = false
    /// Sending again a hand-off whose arrival nobody can confirm: asked first.
    @State private var askResend = false

    private var note: Note? { scene.notes.note(id) }

    private var destinations: [NoteHandoff.Destination] {
        guard let hub = scene.hub else { return [] }
        let live = scene.sidebarOrder.filter { $0.dto.agent != nil }.map {
            NoteHandoff.Destination(key: $0.key, ref: $0.dto.uid, title: $0.title, host: $0.isLocal ? nil : $0.host, live: true)
        }
        guard !insert else { return live }
        let ended = hub.history.filter { $0.dto.harness != "shell" }.prefix(12).map {
            NoteHandoff.Destination(key: $0.id, ref: $0.dto.ref, title: $0.dto.title, host: $0.isLocal ? nil : $0.host, live: false)
        }
        return live + ended
    }

    private func reachable(_ d: NoteHandoff.Destination) -> Bool {
        guard let hub = scene.hub, hub.phase.isUsable else { return false }
        guard let host = d.host else { return true }
        return hub.hosts.contains { $0.name == host && $0.online }
    }

    var body: some View {
        NavigationStack {
            List {
                if let outcome {
                    Section {
                        OutcomeRow(outcome: outcome)
                        if case .uncertain = outcome, hostKeepsNotes {
                            Button("Send It Again…", role: .destructive) { askResend = true }
                                .accessibilityIdentifier("note-send-again")
                        }
                    }
                }
                Section {
                    let all = destinations
                    if all.isEmpty {
                        Text(insert ? "No sessions running. Start one from the note instead." : "No sessions to send to. Start one from the note instead.")
                            .foregroundStyle(theme.muted)
                    }
                    ForEach(all, id: \.key) { d in
                        Button { target = d.key; outcome = nil; record = nil } label: {
                            HStack(spacing: 10) {
                                AgentMark(agent: scene.hub?.row(d.key)?.dto.agent ?? scene.hub?.history.first { $0.id == d.key }?.dto.harness, size: 22)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(d.title).font(.ah(.body)).foregroundStyle(theme.text).lineLimit(1)
                                    Text(detail(d)).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                                }
                                Spacer()
                                if target == d.key { Image(systemName: "checkmark").foregroundStyle(theme.accent) }
                            }
                        }
                        .accessibilityAddTraits(target == d.key ? .isSelected : [])
                    }
                } header: {
                    Text(insert ? "Which Session’s Box" : "Send To")
                } footer: {
                    Text(insert ? "The whole note goes into the box for you to edit and send. The note stays as it is." : "Sent as a message: in now if the agent is idle, queued if it’s working, resumed first if it ended. The note stays as it is.")
                }
                if !insert {
                    Section {
                        Toggle("Send as a Markdown File", isOn: $asFile)
                    } footer: {
                        Text("The agent gets the note as an attached .md file instead of a message.")
                    }
                }
            }
            .navigationTitle(insert ? "Put in a Box" : "Send Note")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                closeButton(scene)
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Sending…" : actionTitle) { go() }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(busy || target == nil || note == nil)
                        .buttonStyle(.glassProminent)
                        .accessibilityIdentifier("note-send-confirm")
                }
            }
            .confirmationDialog(draftUnknown ? "That box may have a draft in it" : "That box has a draft in it", isPresented: $askCombine, titleVisibility: .visible) {
                if draftUnknown {
                    // Nothing known to put the note beside: adding would be replacing.
                    Button("Ask Again") { go() }
                    Button("Replace Whatever’s There", role: .destructive) { finishInsert(.replace) }
                } else {
                    Button("Add the Note Below It") { finishInsert(.below) }
                    Button("Add the Note Above It") { finishInsert(.above) }
                    Button("Replace the Draft", role: .destructive) { finishInsert(.replace) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text(draftUnknown ? "The host couldn’t say what’s in it. Asking again is safe; replacing loses any draft there." : "“\(found.prefix(80))\(found.count > 80 ? "…" : "")”. Nothing is lost unless you replace it.")
            }
            .confirmationDialog("It may already be in that session", isPresented: $askResend, titleVisibility: .visible) {
                Button("Send Again", role: .destructive) { perform(resend: true) }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Nobody could confirm the last send arrived. Look in the session first; sending again may give the agent the note twice.")
            }
            .onAppear(perform: preselect)
        }
    }

    private var actionTitle: String {
        if insert { return "Put in Box" }
        switch outcome {
        case .uncertain: return hostKeepsNotes ? "Check Again" : "Try Again"
        case .failed: return "Try Again"
        default: return "Send"
        }
    }

    private func detail(_ d: NoteHandoff.Destination) -> String {
        var parts: [String] = []
        if let row = scene.hub?.row(d.key) { parts.append(row.word.rawValue); parts.append(row.dto.project) } else { parts.append("Ended: resumes to take it") }
        if let host = d.host { parts.append(host) }
        if !reachable(d) { parts.append("offline") }
        return parts.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var hostKeepsNotes: Bool {
        guard let target, let d = destinations.first(where: { $0.key == target }) else { return false }
        return scene.hub?.state(host: d.host)?.supports("notes") ?? false
    }

    /// The note's project's session first, else the one in front. A send of this note that
    /// was never confirmed (the answer lost, the app closed meanwhile) comes back first, to
    /// ask about by its id rather than send again.
    private func preselect() {
        guard target == nil else { return }
        let all = destinations
        if !insert, let open = (try? scene.notes.repository.handoffs(noteId: id))?.first(where: { $0.state == .sending || $0.state == .uncertain }),
           all.contains(where: { $0.key == open.targetKey }) {
            target = open.targetKey
            record = open
            outcome = .uncertain("an earlier send of this note wasn’t confirmed")
            return
        }
        if let project = note?.project, let match = all.first(where: { d in
            scene.hub?.row(d.key).map { $0.dto.projectPath == project.path && $0.host == project.host } ?? false
        }) {
            target = match.key
        } else {
            target = all.first?.key
        }
        if let note, note.markdown.utf16.count > NoteHandoff.maxText { asFile = true }
    }

    private func go() {
        guard let target, let d = destinations.first(where: { $0.key == target }) else { return }
        if insert {
            busy = true
            let key = d.key
            Task {
                let draft = await scene.existingDraft(key)
                busy = false
                // Another box chosen meanwhile: this answer was about the other one.
                guard target == key else { return }
                found = draft ?? ""
                draftUnknown = draft == nil
                if let draft, draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { finishInsert(.replace) } else { askCombine = true }
            }
            return
        }
        // A host without the hand-off ledger can't say whether an unconfirmed send arrived:
        // trying again sends again, so it's asked first.
        if case .uncertain = outcome, !hostKeepsNotes {
            askResend = true
            return
        }
        perform(resend: false)
    }

    /// The hand-off to ask about again (its id, its text): the one not yet known to have
    /// arrived, to the same session, while it still says what the note says (or it's
    /// unconfirmed, which is about what went then). A host with the ledger answers it from
    /// what happened, and sends a failed one again under the same id.
    private func reusable(_ d: NoteHandoff.Destination) -> NoteHandoffRecord? {
        guard let record, record.targetKey == d.key, !(outcome?.arrived ?? false) else { return nil }
        if record.state == .uncertain || record.state == .sending { return record }
        return record.version == note?.version && !asFile ? record : nil
    }

    private func perform(resend: Bool) {
        guard let target, let d = destinations.first(where: { $0.key == target }) else { return }
        guard let hub = scene.hub, let origin = scene.accountOrigin else { return }
        let keeps = hub.state(host: d.host)?.supports("notes") ?? false
        busy = true
        // Without the ledger every send is a new one; with it, the same id unless sent anew.
        let retrying = keeps ? reusable(d) : nil
        Task {
            let (result, kept) = await NoteHandoff.send(id, to: d, notes: scene.notes, api: hub.client(host: d.host), hostKeepsNotes: keeps,
                                                        reachable: reachable(d), asFile: asFile, retrying: retrying, resend: resend && keeps, origin: origin)
            busy = false
            outcome = result
            record = kept
            if result == .tooLong { asFile = true }
            if result.arrived {
                scene.toast(result.sentence)
                scene.sheet = nil
            }
        }
    }

    private func finishInsert(_ combine: SceneModel.Combine) {
        guard let target else { return }
        scene.sheet = nil
        scene.insertNote(id, into: target, draft: found, combine: combine)
    }
}

private struct OutcomeRow: View {
    let outcome: NoteHandoff.Outcome
    @Environment(\.theme) private var theme

    var body: some View {
        Label(outcome.sentence, systemImage: outcome.arrived ? "checkmark.circle" : "exclamationmark.triangle")
            .foregroundStyle(outcome.arrived ? theme.text : theme.danger)
            .font(.ah(.callout))
            .accessibilityIdentifier("note-send-outcome")
    }
}

// MARK: Save as file

struct NoteSaveFileSheet: View {
    let scene: SceneModel
    let id: String
    @Environment(\.theme) private var theme
    @State private var host: String?
    @State private var folder = ""
    @State private var path = "SPEC.md"
    @State private var busy = false
    @State private var error: String?
    @State private var exists: (name: String, suggestion: String?)?
    @State private var suggestions: [String] = []

    private var note: Note? { scene.notes.note(id) }
    private var hostName: String { host ?? scene.hub?.hostname ?? "" }
    private var keepsNotes: Bool { scene.hub?.state(host: host)?.supports("notes") ?? false }

    var body: some View {
        NavigationStack {
            Form {
                Section("Where") {
                    let hosts = NoteProjects.hosts(scene)
                    if hosts.count > 1 {
                        Picker("Host", selection: Binding(get: { hostName }, set: { host = $0 == scene.hub?.hostname ? nil : $0; folder = "" })) {
                            ForEach(hosts, id: \.self) { Text($0).tag($0) }
                        }
                    }
                    TextField("Space folder", text: $folder)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.ah(.body).monospaced())
                        .accessibilityIdentifier("note-save-folder")
                    if !suggestions.isEmpty {
                        Menu("Spaces") {
                            ForEach(suggestions, id: \.self) { p in Button(p) { folder = p } }
                        }
                    }
                    TextField("File", text: $path)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.ah(.body).monospaced())
                        .accessibilityIdentifier("note-save-path")
                    HStack {
                        ForEach(["SPEC.md", "PLAN.md", "notes/\(NoteFiles.fileName(for: note ?? Note()))"], id: \.self) { p in
                            Button(p.count > 18 ? "notes/…" : p) { path = p }.buttonStyle(.bordered).font(.ah(.caption))
                        }
                    }
                }
                Section {
                    if let problem = problem {
                        Text(problem).foregroundStyle(theme.danger)
                    } else {
                        Text(folder.hasSuffix("/") ? folder + path : folder + "/" + path).font(.ah(.caption).monospaced()).foregroundStyle(theme.muted)
                    }
                    if let error { Text(error).foregroundStyle(theme.danger) }
                } footer: {
                    Text("A copy of the note as it is now. Later changes to the note don’t change the file, and changes to the file don’t come back.")
                }
                if let past = note?.exports, !past.isEmpty {
                    Section("Saved Before") {
                        ForEach(past.prefix(5), id: \.path) { e in
                            Button {
                                host = e.host == scene.hub?.hostname ? nil : e.host
                                fill(from: e.path)
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(e.path).font(.ah(.caption).monospaced()).lineLimit(2)
                                    Text("\(e.host) · \(Date(timeIntervalSince1970: e.at).formatted(.relative(presentation: .named)))").font(.ah(.caption2)).foregroundStyle(theme.muted)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Save as File")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                closeButton(scene)
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "Saving…" : "Save") { Task { await save(replace: false) } }
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(busy || problem != nil)
                        .buttonStyle(.glassProminent)
                        .accessibilityIdentifier("note-save-confirm")
                }
            }
            .alert(exists.map { "\($0.name) already exists" } ?? "", isPresented: Binding(get: { exists != nil }, set: { if !$0 { exists = nil } })) {
                Button("Replace It", role: .destructive) { Task { await save(replace: true) } }
                if let other = exists?.suggestion { Button("Save as \(other)") { path = other; Task { await save(replace: false) } } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Replacing it overwrites the file in the Space.")
            }
            .task { load() }
        }
    }

    private var problem: String? {
        if !keepsNotes { return "\(hostName) needs an update before notes can be saved there." }
        if !(scene.hub?.phase.isUsable ?? false) { return "Your host can’t be reached. The note is kept here; save it when you’re back online." }
        let dir = folder.trimmingCharacters(in: .whitespaces)
        if dir.isEmpty { return "Choose the Space's folder." }
        if !(dir.hasPrefix("/") || dir.hasPrefix("~")) { return "The folder is a full path (/… or ~/…)." }
        return NoteFiles.problem(path)
    }

    private func load() {
        guard folder.isEmpty else { return }
        if let project = note?.project, NoteProjects.hosts(scene).contains(project.host) {
            host = project.host == scene.hub?.hostname ? nil : project.host
            folder = project.path
        }
        suggestions = NoteProjects.known(scene, host: host)
        if folder.isEmpty { folder = suggestions.first ?? "" }
        // Saved before into this project: the same name again, by default.
        if let last = note?.exports.first(where: { $0.path.hasPrefix(folder + "/") }) { path = String(last.path.dropFirst(folder.count + 1)) }
    }

    private func fill(from full: String) {
        guard let slash = full.range(of: "/", options: .backwards) else { return }
        let known = NoteProjects.known(scene, host: host).sorted { $0.count > $1.count }
        if let project = known.first(where: { full.hasPrefix($0 + "/") }) {
            folder = project
            path = String(full.dropFirst(project.count + 1))
        } else {
            folder = String(full[..<slash.lowerBound])
            path = String(full[slash.upperBound...])
        }
    }

    private func save(replace: Bool) async {
        guard let hub = scene.hub else { return }
        scene.notes.flushText(id)
        guard let note else { return }
        busy = true
        error = nil
        defer { busy = false }
        let body = NoteExportBody(dir: folder.trimmingCharacters(in: .whitespaces), path: path.trimmingCharacters(in: .whitespaces), markdown: note.markdown, replace: replace,
                                  noteId: note.syncOrigin == nil ? nil : note.id, revision: note.version)
        do {
            switch try await hub.client(host: host).exportNote(body) {
            case .ok(let saved):
                scene.notes.recordExport(id, NoteExportDTO(host: hostName, path: saved.path, revision: note.version, at: Date().timeIntervalSince1970))
                scene.sheet = nil
                scene.toast(saved.replaced ? "Replaced \(saved.path). The note stays the original." : "Saved a copy at \(saved.path). The note stays the original.")
            case .refused(let refusal):
                if refusal.code == "file_exists" {
                    exists = (name: (path as NSString).lastPathComponent, suggestion: refusal.suggestion)
                } else {
                    error = refusal.error
                }
            }
        } catch {
            self.error = APIError.wrap(error).message
        }
    }
}

// MARK: Project

struct NoteProjectSheet: View {
    let scene: SceneModel
    let id: String
    @Environment(\.theme) private var theme
    @State private var custom = ""
    @State private var customHost: String?

    private var current: NoteProject? { scene.notes.note(id)?.project }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    row(title: "None", detail: "Listed with your other notes", chosen: current == nil) { choose(nil) }
                } footer: {
                    Text("A note filed under a Space shows with its sessions and starts new sessions there. Nothing is written into the folder.")
                }
                ForEach(NoteProjects.hosts(scene), id: \.self) { host in
                    let isHub = host == scene.hub?.hostname
                    let known = NoteProjects.known(scene, host: isHub ? nil : host)
                    if !known.isEmpty {
                        Section(host) {
                            ForEach(known, id: \.self) { path in
                                let project = NoteProject(origin: scene.accountOrigin, host: host, path: path)
                                row(title: project.name, detail: path, chosen: current?.host == host && current?.path == path) { choose(project) }
                            }
                        }
                    }
                }
                if let current, !NoteProjects.known(scene, host: current.host == scene.hub?.hostname ? nil : current.host).contains(current.path) {
                    Section("Now") {
                        row(title: current.name, detail: "\(current.host) · \(current.path)", chosen: true) {}
                    }
                }
                Section("Another Folder") {
                    TextField("/path/to/project", text: $custom)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.ah(.body).monospaced())
                        .onSubmit(useCustom)
                    Button("Use This Folder", action: useCustom).disabled(!custom.hasPrefix("/") && !custom.hasPrefix("~"))
                }
            }
            .navigationTitle("Space")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { closeButton(scene) }
        }
    }

    private func row(title: String, detail: String, chosen: Bool, pick: @escaping () -> Void) -> some View {
        Button(action: pick) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).foregroundStyle(theme.text)
                    Text(detail).font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                }
                Spacer()
                if chosen { Image(systemName: "checkmark").foregroundStyle(theme.accent) }
            }
        }
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }

    private func useCustom() {
        let path = custom.trimmingCharacters(in: .whitespaces)
        guard path.hasPrefix("/") || path.hasPrefix("~"), let hub = scene.hub, let host = hub.hostname else { return }
        let home = hub.state(host: nil)?.home ?? ""
        choose(NoteProject(origin: scene.accountOrigin, host: host, path: NoteProjects.normalize(path, home: home)))
    }

    private func choose(_ project: NoteProject?) {
        scene.notes.setProject(id, project)
        scene.sheet = nil
    }
}

// MARK: Two versions

struct NoteCompareSheet: View {
    let scene: SceneModel
    let id: String
    @Environment(\.theme) private var theme
    @State private var side = 0

    var body: some View {
        NavigationStack {
            Group {
                if let note = scene.notes.note(id), let theirs = note.conflict {
                    VStack(spacing: 0) {
                        Picker("Version", selection: $side) {
                            Text("This Device").tag(0)
                            Text(theirs.deleted ? "Deleted" : "Other Device").tag(1)
                        }
                        .pickerStyle(.segmented)
                        .padding()
                        ScrollView {
                            Text(side == 0 ? note.markdown : (theirs.deleted ? "Deleted on another device." : theirs.markdown))
                                .font(.ah(.callout).monospaced())
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding()
                        }
                        VStack(spacing: 8) {
                            Button { resolve(.keepBoth) } label: { Text("Keep Both").frame(maxWidth: .infinity) }.buttonStyle(.glassProminent)
                            HStack {
                                Button { resolve(.keepMine) } label: { Text("Keep This Device’s").frame(maxWidth: .infinity) }.buttonStyle(.glass)
                                Button { resolve(.keepTheirs) } label: { Text(theirs.deleted ? "Let It Go" : "Keep the Other").frame(maxWidth: .infinity) }.buttonStyle(.glass)
                            }
                        }
                        .padding()
                    }
                } else {
                    EmptyState(symbol: "checkmark.circle", title: "Nothing to Choose", message: "This note is in step again.")
                }
            }
            .navigationTitle("Two Versions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { closeButton(scene) }
        }
    }

    private func resolve(_ choice: NotesModel.Resolution) {
        scene.notes.resolve(id, choice)
        scene.sheet = nil
        Task { if let origin = scene.notes.note(id)?.syncOrigin { await scene.notes.sync(origin) } }
    }
}
