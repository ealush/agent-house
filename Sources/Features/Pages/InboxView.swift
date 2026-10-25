import SwiftUI

/// The Inbox (`../ah/web/Inbox.tsx`): who needs you first, with one-tap safe answers; then
/// review alerts, what's working, and what's idle or done.
struct InboxView: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme

    var body: some View {
        let inbox = hub.inbox(narrow: scene.narrow)
        List {
            Section {
                ConnectionBanner(phase: hub.phase, lastUpdated: hub.lastUpdated, cached: hub.showingCached) { hub.resync() }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            } header: {
                Text(inbox.summary).font(.subheadline).foregroundStyle(theme.muted).textCase(nil)
            }
            if let focus = hub.focus, focus.client != scene.device.client, let row = hub.row(focus.key), Date().timeIntervalSince1970 * 1000 - focus.at < 15 * 60_000 {
                Section {
                    Button {
                        scene.open(row.key)
                    } label: {
                        Label("Continue “\(row.title)” from \(focus.device)", systemImage: "arrow.turn.down.right")
                    }
                }
            }
            if !inbox.waiting.isEmpty || !inbox.reviews.isEmpty {
                Section("Needs you") {
                    ForEach(inbox.waiting) { row in
                        AskCard(row: row, scene: scene, hub: hub)
                    }
                    ForEach(inbox.reviews, id: \.self) { alert in
                        ReviewAlertRow(alert: alert) { scene.openReview(ReviewRoute(stack: alert.stackId, pr: alert.pr)) }
                    }
                }
            }
            if !inbox.running.isEmpty {
                Section("Working") {
                    ForEach(inbox.running) { row in SessionRowView(row: row, multiHost: hub.multiHost) { scene.open(row.key) } }
                }
            }
            if !inbox.rest.isEmpty {
                Section("Idle and done") {
                    ForEach(inbox.rest) { row in SessionRowView(row: row, multiHost: hub.multiHost) { scene.open(row.key) } }
                }
            }
            if hub.rows.isEmpty {
                Section {
                    EmptyState(symbol: "tray", title: "No sessions running", message: "Start one, or pick up where you left off.", action: ("New session", { scene.perform("new-session") }))
                }
                let recent = Array(hub.history.prefix(3))
                if !recent.isEmpty {
                    Section("Recent conversations") {
                        ForEach(recent) { item in HistoryRowView(item: item, scene: scene, hub: hub) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .refreshable { hub.resync() }
        .navigationTitle("Inbox")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                Button { scene.perform("go-search") } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search")
                Button { scene.perform("new-session") } label: { Image(systemName: "plus") }.accessibilityLabel("New session")
            }
        }
    }
}

extension ReviewStateDTO.Alert: Hashable {
    func hash(into hasher: inout Hasher) {
        hasher.combine(stackId)
        hasher.combine(pr)
        hasher.combine(kind)
    }
}

/// A session that needs you: what it asks, and the answer, without opening it.
private struct AskCard: View {
    let row: SessionRow
    let scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                scene.open(row.key)
            } label: {
                HStack(spacing: 10) {
                    AgentMark(agent: row.dto.agent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).font(.headline).foregroundStyle(theme.text).lineLimit(1)
                        Text([hub.multiHost ? row.host : nil, row.dto.project].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(theme.muted)
                    }
                    Spacer()
                    Elapsed(seconds: row.dto.activity).font(.caption).foregroundStyle(theme.faint)
                }
            }
            .buttonStyle(.plain)
            if let ask = row.dto.ask {
                AskSummaryView(parts: AskParts(ask, detail: row.dto.detail), showTerminalText: false)
            }
            AskPanelView(target: AskTarget(row: row, hub: hub) { text, error in scene.toast(text, error: error) }, compact: true, onReply: {
                scene.open(row.key)
                scene.requestFocus(.composer(row.key))
            })
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .contain)
    }
}

private struct ReviewAlertRow: View {
    let alert: ReviewStateDTO.Alert
    let open: () -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.seal").foregroundStyle(theme.brand)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold))
                    Text("\(alert.stackTitle) · #\(alert.pr) \(alert.title)").font(.caption).foregroundStyle(theme.muted).lineLimit(1)
                }
            }
        }
    }

    private var title: String {
        switch alert.kind {
        case .rereview: return "Changed since your review"
        case .nopush: return "The agent finished without pushing"
        case .ready: return "Ready to merge"
        case .restack: return "Needs a restack"
        }
    }
}

/// A session in a list: its status, title, what it's doing, where it is.
struct SessionRowView: View {
    let row: SessionRow
    let multiHost: Bool
    /// The sidebar: titles get the room, and only a status that needs you takes words.
    var dense = false
    let open: () -> Void
    @Environment(\.theme) private var theme
    /// Increased when the row is selected in a focused list (filled with the accent).
    @Environment(\.backgroundProminence) private var prominence

    var body: some View {
        let onAccent = prominence == .increased
        Button(action: open) {
            HStack(spacing: 10) {
                AgentMark(agent: row.dto.agent)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        if row.dto.pinned { Image(systemName: "pin.fill").font(.caption2).foregroundStyle(onAccent ? .white.opacity(0.8) : theme.faint) }
                        Text(row.title).foregroundStyle(onAccent ? .white : theme.text).lineLimit(1)
                        if let fork = row.dto.fork {
                            // A fork (or a session others were forked from): its lineage at a glance.
                            HStack(spacing: 2) {
                                Image(systemName: "arrow.branch")
                                if fork.forks > 0 { Text("\(fork.forks)") }
                            }
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(onAccent ? .white.opacity(0.8) : theme.faint)
                            .accessibilityLabel(fork.parentTitle.isEmpty ? "\(fork.forks) forks" : "Fork of \(fork.parentTitle)")
                        }
                    }
                    Text(detail).font(.caption).foregroundStyle(onAccent ? .white.opacity(0.8) : theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 2) {
                    StatusPill(word: row.word, compact: dense && !row.word.asksForAttention)
                    if row.dto.queued > 0 { Text("\(row.dto.queued) queued").font(.caption2).foregroundStyle(onAccent ? .white.opacity(0.8) : theme.faint) }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(row.title), \(row.word.rawValue). \(detail)")
        .accessibilityIdentifier("session:\(row.title)")
    }

    private var detail: String {
        [multiHost ? row.host : nil, row.dto.project, row.dto.limit ?? row.dto.detail].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// A block's header in the sidebar: its project (or host), a button to start a session
/// there, and a menu to move the block. Dragging a header onto another moves it there.
private struct GroupHeader: View {
    let scene: SceneModel
    let hub: HubStore
    let section: SessionOrdering.Section
    let first: Bool
    let last: Bool
    @Environment(\.theme) private var theme
    @State private var targeted = false

    private var newHere: SceneModel.NewSessionContext {
        if hub.multiHost {
            let host = section.rows.first.flatMap { $0.isLocal ? nil : $0.host }
            return SceneModel.NewSessionContext(host: host)
        }
        return SceneModel.NewSessionContext(cwd: section.rows.first?.dto.projectPath, host: section.rows.first.flatMap { $0.isLocal ? nil : $0.host })
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(section.id)
                .lineLimit(1)
            Spacer(minLength: 4)
            // Tap: a new session here. Hold: move the block (a sidebar header takes no
            // context menu of its own).
            Menu {
                Button("New Session Here", systemImage: "plus") { scene.sheet = .newSession(newHere) }
                Divider()
                Button("Move Up", systemImage: "arrow.up") { withAnimation(.snappy) { scene.moveGroup(section.id, by: -1) } }.disabled(first)
                Button("Move Down", systemImage: "arrow.down") { withAnimation(.snappy) { scene.moveGroup(section.id, by: 1) } }.disabled(last)
            } label: {
                Image(systemName: "plus")
                    .font(.caption.weight(.semibold))
            } primaryAction: {
                scene.sheet = .newSession(newHere)
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            .accessibilityLabel("New session in \(section.id)")
            .accessibilityHint("Hold for more")
        }
        .padding(.vertical, 2)
        .overlay(alignment: .top) {
            if targeted { Rectangle().fill(theme.accent).frame(height: 2).offset(y: -4) }
        }
        .contentShape(Rectangle())
        .draggable(GroupDrag(id: section.id)) {
            Label(section.id, systemImage: "folder").padding(8).background(.regularMaterial, in: Capsule())
        }
        .dropDestination(for: GroupDrag.self) { items, _ in
            guard let dragged = items.first, dragged.id != section.id else { return false }
            withAnimation(.snappy) { scene.moveGroup(dragged.id, to: section.id, after: false) }
            return true
        } isTargeted: { targeted = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The session list, grouped as the sidebar groups it, with pin, rename and terminate at hand.
struct SessionListView: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    var selection: String?
    @Environment(\.theme) private var theme
    /// "Focus the session list" (⌃⇧0) puts the keyboard here.
    @FocusState private var listFocused: Bool

    var body: some View {
        let sections = scene.sidebarSections
        List(selection: Binding(get: { selection }, set: { if let key = $0 { scene.open(key) } })) {
            ConnectionBanner(phase: hub.phase, lastUpdated: hub.lastUpdated, cached: hub.showingCached) { hub.resync() }
                .listRowBackground(Color.clear)
            ForEach(sections) { section in
                Section {
                    ForEach(section.rows) { row in
                        SessionRowView(row: row, multiHost: false, dense: !scene.narrow) { scene.open(row.key) }
                            .tag(row.key)
                            .draggable(SessionDrag(key: row.key))
                            .contextMenu { rowMenu(row) }
                            .swipeActions(edge: .trailing) {
                                Button(row.dto.pinned ? "Unpin" : "Pin") {
                                    Task { try? await hub.client(forKey: row.key).pin(row.uid, pinned: !row.dto.pinned); hub.refresh() }
                                }
                                .tint(.orange)
                            }
                    }
                    .onMove { from, to in move(section: section, from: from, to: to) }
                } header: {
                    GroupHeader(scene: scene, hub: hub, section: section, first: section.id == sections.first?.id, last: section.id == sections.last?.id)
                }
            }
            if hub.rows.isEmpty {
                EmptyState(symbol: "terminal", title: "No sessions", message: "Start one with New session.", action: ("New session", { scene.perform("new-session") }))
            }
        }
        .listStyle(.sidebar)
        .refreshable { hub.resync() }
        .focused($listFocused)
        .onChange(of: scene.focusRequest) { _, request in if request?.target == .sidebar { listFocused = true } }
    }

    @ViewBuilder
    private func rowMenu(_ row: SessionRow) -> some View {
        Button("Open", systemImage: "arrow.up.right") { scene.open(row.key) }
        if !scene.narrow {
            Button("Open as a new pane", systemImage: "rectangle.split.2x1") { scene.run(.openAsPane(row.key)) }
        }
        Button(row.dto.pinned ? "Unpin" : "Pin", systemImage: "pin") {
            Task { try? await hub.client(forKey: row.key).pin(row.uid, pinned: !row.dto.pinned); hub.refresh() }
        }
        Menu("Send to workspace") {
            ForEach(1...9, id: \.self) { n in
                Button("Workspace \(n)") {
                    scene.open(row.key)
                    scene.perform(.toWorkspace(n))
                }
            }
        }
        Divider()
        Button("Terminate…", systemImage: "xmark.octagon", role: .destructive) { scene.sheet = .confirmTerminate(row.key) }
    }

    private func move(section: SessionOrdering.Section, from: IndexSet, to: Int) {
        guard let index = from.first else { return }
        let dragged = section.rows[index]
        let target = to >= section.rows.count ? section.rows.last! : section.rows[to]
        let orders = SessionOrdering.movedOrders(section.rows, dragged: dragged.key, target: target.key, after: to >= section.rows.count)
        Task {
            for (key, order) in orders {
                try? await hub.client(forKey: key).order(SessionKey(key)?.uid ?? key, order)
            }
            hub.refresh()
        }
    }
}

/// History: ended and discovered conversations; resume, fork, hide.
struct HistoryView: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme

    var body: some View {
        let rows = hub.history.filter { HistoryFilter.matches($0, scene.historyFilter) }
        let days = Dictionary(grouping: rows) { HistoryFilter.dayLabel($0.dto.at) }
        let order = rows.reduce(into: [String]()) { labels, row in
            let label = HistoryFilter.dayLabel(row.dto.at)
            if labels.last != label && !labels.contains(label) { labels.append(label) }
        }
        List {
            if rows.isEmpty {
                EmptyState(symbol: "clock", title: scene.historyFilter.isEmpty ? "No history yet" : "Nothing matches", message: "Ended and past conversations appear here.")
            }
            ForEach(order, id: \.self) { day in
                Section(day) {
                    ForEach(days[day] ?? []) { item in HistoryRowView(item: item, scene: scene, hub: hub) }
                }
            }
        }
        .searchable(text: $scene.historyFilter, prompt: "Filter by title, project, agent")
        .onChange(of: scene.historyFilter) { _, _ in scene.scheduleSave() }
        .navigationTitle("History")
    }
}

struct HistoryRowView: View {
    let item: HistoryRow
    let scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme

    var body: some View {
        Button {
            scene.open(item.id)
        } label: {
            HStack(spacing: 10) {
                AgentMark(agent: item.dto.harness == "shell" ? nil : item.dto.harness)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        if item.dto.pinned { Image(systemName: "pin.fill").font(.caption2) }
                        Text(item.dto.title).lineLimit(1).foregroundStyle(theme.text)
                    }
                    Text([hub.multiHost ? item.host : nil, item.dto.project, item.dto.fork.map { "fork of \($0.parentTitle)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(theme.muted).lineLimit(1)
                }
                Spacer()
                Elapsed(seconds: item.dto.at).font(.caption).foregroundStyle(theme.faint)
            }
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .leading) {
            Button("Resume") { resume() }.tint(.green)
        }
        .swipeActions(edge: .trailing) {
            Button("Hide", role: .destructive) {
                Task {
                    try? await hub.client(host: item.isLocal ? nil : item.host).forget(item.dto.ref)
                    hub.refresh(host: item.isLocal ? nil : item.host)
                }
            }
        }
        .contextMenu {
            Button("Resume", systemImage: "play") { resume() }
            Button("Fork…", systemImage: "arrow.triangle.branch") { scene.sheet = .fork(item.id) }
            Button("Hide from History", systemImage: "eye.slash", role: .destructive) {
                Task {
                    try? await hub.client(host: item.isLocal ? nil : item.host).forget(item.dto.ref)
                    hub.refresh(host: item.isLocal ? nil : item.host)
                }
            }
        }
    }

    private func resume() {
        Task {
            let api = hub.client(host: item.isLocal ? nil : item.host)
            do {
                let result = try await api.resume(item.dto.ref)
                hub.refresh(host: item.isLocal ? nil : item.host)
                scene.open(item.isLocal ? result.uid : "\(item.host)/\(result.uid)")
            } catch {
                scene.toast("Couldn’t resume: \(APIError.wrap(error).message)", error: true)
            }
        }
    }
}

/// Full-text search over every conversation and side chat, on every host.
struct SearchView: View {
    @Bindable var scene: SceneModel
    @State var model: SearchModel
    @Environment(\.theme) private var theme

    /// Where and when: the project (the folder's name), how long ago, and the host when
    /// there's more than one.
    private func searchMeta(_ hit: SearchHit, live: SessionRow?) -> String {
        let project = live?.dto.project ?? (hit.cwd as NSString).lastPathComponent
        let when = hit.at > 0 ? Date(timeIntervalSince1970: hit.at / 1000).formatted(.relative(presentation: .named)) : nil
        let host = (scene.hub?.multiHost ?? false) ? hit.host : nil
        return [project, when, host].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        List {
            if let response = model.response {
                if !response.enabled {
                    Banner(text: "Search is off on this host. Turn it on in Settings → Search.", tone: .warning)
                } else if response.building {
                    Banner(text: "The index is still building; results may be incomplete.", tone: .info)
                }
                ForEach(response.notes, id: \.self) { note in
                    Banner(text: "\(note.host): \(note.error)", tone: .warning)
                }
                ForEach(Array(response.results.enumerated()), id: \.offset) { _, hit in
                    Button {
                        scene.openHit(hit)
                    } label: {
                        let live = hit.uid.flatMap { uid in scene.hub?.rows.first { $0.uid == uid } }
                        HStack(alignment: .top, spacing: 12) {
                            AgentMark(agent: hit.kind == "chat" ? nil : hit.harness, size: 26)
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(alignment: .firstTextBaseline) {
                                    Text(live?.title ?? hit.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                                    if hit.kind == "chat" { Text("side chat").font(.caption2.weight(.semibold)).foregroundStyle(theme.muted) }
                                    Spacer()
                                    Text("\(hit.matches) match\(hit.matches == 1 ? "" : "es")").font(.caption).foregroundStyle(theme.faint)
                                }
                                ForEach(Array(hit.excerpts.prefix(2).enumerated()), id: \.offset) { _, excerpt in
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(excerpt.role == "user" ? "You" : "Agent").font(.caption2.weight(.semibold)).foregroundStyle(theme.faint).frame(width: 38, alignment: .leading)
                                        HighlightedSnippet(snippet: excerpt.snippet, lines: 3)
                                    }
                                }
                                Text(searchMeta(hit, live: live)).font(.caption2).foregroundStyle(theme.faint).lineLimit(1)
                            }
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if response.results.count < response.total {
                    Button("More results") { Task { await model.more() } }
                }
                if response.results.isEmpty && response.enabled {
                    Text("No matches.").foregroundStyle(theme.muted)
                }
            } else if model.searching {
                ProgressView()
            }
            if let error = model.error { Banner(text: error, tone: .error) }
        }
        .searchable(text: $model.query.q, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search every conversation")
        .searchScopes($model.query.scopeOrAll) {
            Text("All").tag("all")
            Text("Transcripts").tag("transcripts")
            Text("Side chats").tag("chats")
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Picker("Who said it", selection: $model.query.role) {
                        Text("Anyone").tag(String?.none)
                        Text("You").tag(Optional("user"))
                        Text("The agent").tag(Optional("assistant"))
                    }
                    Picker("When", selection: Binding(get: { SearchSince(from: model.query.from) }, set: { model.query.from = $0.from })) {
                        ForEach(SearchSince.allCases, id: \.self) { Text($0.label).tag($0) }
                    }
                    if let hub = scene.hub, hub.multiHost {
                        Picker("Host", selection: $model.query.host) {
                            Text("Every host").tag(String?.none)
                            ForEach(hub.hosts, id: \.name) { Text($0.name).tag(Optional($0.name)) }
                        }
                    }
                } label: {
                    Label("Filters", systemImage: model.query.role != nil || model.query.from != nil || model.query.host != nil ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
                }
            }
        }
        .onChange(of: model.query) { _, query in
            scene.search = query
            scene.scheduleSave()
            model.search()
        }
        .onAppear {
            if let saved = scene.search, model.query.q.isEmpty { model.query = saved }
        }
        .navigationTitle("Search")
    }
}

/// Time filters, as milliseconds-since-epoch lower bounds.
private enum SearchSince: Hashable, CaseIterable {
    case any, day, week, month

    init(from: Double?) {
        guard let from else { self = .any; return }
        let age = Date().timeIntervalSince1970 * 1000 - from
        self = age <= 86_400_000 * 1.5 ? .day : age <= 86_400_000 * 8 ? .week : .month
    }

    var from: Double? {
        let day = 86_400_000.0
        let now = Date().timeIntervalSince1970 * 1000
        switch self {
        case .any: return nil
        case .day: return now - day
        case .week: return now - 7 * day
        case .month: return now - 30 * day
        }
    }

    var label: String {
        switch self {
        case .any: return "Any time"
        case .day: return "Past day"
        case .week: return "Past week"
        case .month: return "Past month"
        }
    }
}

extension SearchQuery {
    /// The scope picker's value: "all" when unset.
    var scopeOrAll: String {
        get { scope ?? "all" }
        set { scope = newValue == "all" ? nil : newValue }
    }
}
