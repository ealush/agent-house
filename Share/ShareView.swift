import QuickLookThumbnailing
import SwiftUI

/// The share sheet: what's being sent, an optional note, where it goes (a session, or a new
/// one in a project), and then exactly what happened. Minimal: no transcript, no settings.
struct ShareView: View {
    @Bindable var model: ShareModel
    let skipped: [String]
    let finish: (Bool) -> Void
    @State private var search = ""
    @State private var newAgent: String?
    @State private var newProject: String?
    @FocusState private var noteFocused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if !model.items.isEmpty || !skipped.isEmpty {
                    Section { shared } footer: {
                        if !skipped.isEmpty { Text("\(skipped.joined(separator: ", ")) couldn’t be read, and won’t be sent.") }
                    }
                }
                Section {
                    TextField("Add a message (optional)", text: $model.note, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($noteFocused)
                        .disabled(model.busy)
                        .accessibilityIdentifier("share-note")
                }
                if model.accounts.count > 1 {
                    Section {
                        Picker("Host", selection: Binding(get: { model.account?.origin }, set: { origin in model.account = model.accounts.first { $0.origin == origin } })) {
                            ForEach(model.accounts) { account in
                                Text(account.expired ? "\(account.name) (sign in again)" : account.name).tag(Optional(account.origin))
                            }
                        }
                        .disabled(model.busy)
                    }
                }
                outcome
                destinations
            }
            .navigationTitle("Agent Hub")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isSent ? "Done" : "Cancel") { finish(isSent) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if case .unsure = model.phase {
                        Button("Send Again") { Task { await model.sendAgain() } }
                    } else if !isSent {
                        Button(model.busy ? "Sending…" : "Send") { Task { await send() } }
                            .disabled(!model.canSend)
                            .fontWeight(.semibold)
                    }
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "Find a session")
        }
    }

    private var isSent: Bool { if case .sent = model.phase { return true } else { return false } }

    private func send() async {
        noteFocused = false
        await model.send()
        if case .sent = model.phase {
            // Long enough to read that it went, then out of the way.
            try? await Task.sleep(for: .seconds(1.2))
            finish(true)
        }
    }

    // MARK: What's shared

    @ViewBuilder
    private var shared: some View {
        ForEach(Array(model.items.enumerated()), id: \.offset) { _, item in
            switch item {
            case .link(let url):
                Label { Text(url.absoluteString).lineLimit(2).font(.callout) } icon: { Image(systemName: "link") }
            case .text(let text):
                Label { Text(text).lineLimit(4).font(.callout) } icon: { Image(systemName: "text.quote") }
            case .file(let file):
                HStack(spacing: 12) {
                    Thumbnail(file: file).frame(width: 44, height: 44)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(file.name).lineLimit(1).font(.callout)
                        Text(ByteCountFormatter.string(fromByteCount: file.bytes, countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    // MARK: Where it went

    @ViewBuilder
    private var outcome: some View {
        switch model.phase {
        case .choosing:
            EmptyView()
        case .uploading(let done, let of, let fraction):
            Section {
                ProgressView(value: (Double(done) + fraction) / Double(max(1, of))) {
                    Text(of == 1 ? "Uploading…" : "Uploading \(done + 1) of \(of)…").font(.callout)
                }
            }
        case .sending:
            Section { HStack { ProgressView(); Text("Sending…").font(.callout) } }
        case .sent(let queued):
            Section {
                Label(queued ? "It goes in as soon as the agent is ready." : "Sent.", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            }
        case .failed(let why):
            Section { Label(why, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.callout) }
        case .unsure(let why):
            Section { Label(why, systemImage: "questionmark.circle.fill").foregroundStyle(.orange).font(.callout) }
        }
    }

    // MARK: Where it goes

    @ViewBuilder
    private var destinations: some View {
        if let error = model.loadError {
            Section { Label(error, systemImage: "exclamationmark.triangle").font(.callout) }
        } else if model.accounts.isEmpty {
            Section { Label("Agent Hub isn’t signed in to a host on this device. Open Agent Hub to pair it with one.", systemImage: "person.crop.circle.badge.questionmark").font(.callout) }
        } else if model.loading {
            Section { HStack { ProgressView(); Text("Finding your sessions…").font(.callout).foregroundStyle(.secondary) } }
        } else {
            Section("New session") {
                if model.agents.isEmpty {
                    Text("This host has no agent to start.").foregroundStyle(.secondary)
                } else {
                    Picker("Agent", selection: Binding(get: { newAgent ?? model.agents.first?.id }, set: { newAgent = $0; pickNew() })) {
                        ForEach(model.agents, id: \.id) { Text($0.name).tag(Optional($0.id)) }
                    }
                    Picker("In", selection: Binding(get: { newProject ?? model.projects.first?.path }, set: { newProject = $0; pickNew() })) {
                        ForEach(model.projects, id: \.path) { Text($0.name).tag(Optional($0.path)) }
                    }
                    Button { pickNew() } label: {
                        HStack {
                            Label("Start a new session with it", systemImage: "plus.bubble")
                            Spacer()
                            if case .new = model.destination { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                    }
                }
            }
            .disabled(model.busy)
            Section("Sessions") {
                let shown = model.sessions.filter { search.isEmpty || $0.title.localizedCaseInsensitiveContains(search) || $0.project.localizedCaseInsensitiveContains(search) }
                if shown.isEmpty { Text(search.isEmpty ? "No sessions running on this host." : "No session matches.").foregroundStyle(.secondary) }
                ForEach(shown) { session in
                    Button { model.destination = .session(session) } label: {
                        HStack(spacing: 12) {
                            mark(session.agent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.title).lineLimit(1).foregroundStyle(.primary)
                                Text([session.host, session.project, word(session.status)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer()
                            if case .session(let chosen) = model.destination, chosen.id == session.id { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits({ if case .session(let chosen) = model.destination, chosen.id == session.id { return .isSelected } else { return [] } }())
                }
            }
            .disabled(model.busy)
        }
    }

    private func pickNew() {
        guard let agent = newAgent ?? model.agents.first?.id, let cwd = newProject ?? model.projects.first?.path else { return }
        model.destination = .new(host: nil, preset: agent, cwd: cwd)
    }

    private func word(_ status: SessionDTO.Status) -> String {
        switch status {
        case .busy: return "working"
        case .waiting: return "needs you"
        case .idle, .attention: return ""
        }
    }

    @ViewBuilder
    private func mark(_ agent: String?) -> some View {
        let shape = RoundedRectangle(cornerRadius: 7, style: .continuous)
        Group {
            if let agent, let key = AgentLogo.key(agent) {
                if AgentLogo.tiles.contains(key) {
                    Image("Agents/\(key)").resizable().scaledToFill().clipShape(shape)
                } else {
                    Image("Agents/\(key)").resizable().scaledToFit().padding(5).background(.fill.tertiary, in: shape)
                }
            } else {
                Image(systemName: agent == nil ? "terminal" : "sparkles").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity).background(.fill.tertiary, in: shape)
            }
        }
        .frame(width: 26, height: 26)
        .accessibilityHidden(true)
    }
}

/// A file's thumbnail, made by Quick Look from the file on disk (never a full decode).
private struct Thumbnail: View {
    let file: StagedFile
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Image(systemName: file.kind == .movie ? "film" : file.kind == .image ? "photo" : "doc").foregroundStyle(.secondary)
            }
        }
        .frame(width: 44, height: 44)
        .background(.fill.tertiary)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .task {
            let request = QLThumbnailGenerator.Request(fileAt: file.url, size: CGSize(width: 88, height: 88), scale: 2, representationTypes: .thumbnail)
            image = try? await QLThumbnailGenerator.shared.generateBestRepresentation(for: request).uiImage
        }
    }
}
