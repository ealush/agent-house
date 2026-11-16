import SwiftUI

/// The Inbox (`../ah/web/Inbox.tsx`): who needs you first, with one-tap safe answers; then
/// review alerts, what's working, and what's idle or done.
struct InboxView: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let inbox = hub.inbox(narrow: scene.narrow)
        List {
            Section {
                ConnectionBanner(phase: hub.phase, lastUpdated: hub.lastUpdated, cached: hub.showingCached) { hub.resync() }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            } header: {
                AhLargeTitle(title: "Inbox", tagline: hub.awaitingState ? "Asking your host…" : inbox.summary).textCase(nil)
            }
            // Another device's place, not this one's from an earlier launch (window ids are
            // per launch, so the name tells this device apart too). Told apart by what the
            // host was sent as well (this launch's client and the system's name): with a name
            // of its own set here, this device's own session was offered back to it.
            if let focus = hub.focus, focus.client != scene.device.client, focus.client != scene.app.services.device.client, focus.device != scene.device.name, focus.device != scene.app.services.device.name, let row = hub.row(focus.key), Date().timeIntervalSince1970 * 1000 - focus.at < 15 * 60_000 {
                Section {
                    Button {
                        scene.open(row.key)
                    } label: {
                        Label("Continue “\(row.title)” from \(focus.device)", systemImage: "arrow.turn.down.right")
                    }
                    .ahRow()
                }
            }
            if inbox.waiting.isEmpty && inbox.reviews.isEmpty && inbox.running.isEmpty && !hub.rows.isEmpty {
                Section {
                    HStack(spacing: 12) {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.ah(.title2))
                            .foregroundStyle(theme.done)
                            .symbolEffect(.bounce, value: inbox.rest.count)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("All caught up").font(.ah(.headline))
                            Text("Nothing needs you, and nothing’s running.").font(.ah(.callout)).foregroundStyle(theme.muted)
                        }
                    }
                    .padding(.vertical, 6)
                    .ahRow()
                }
            }
            if !inbox.waiting.isEmpty || !inbox.reviews.isEmpty {
                Section {
                    ForEach(inbox.waiting) { row in
                        AskCard(row: row, scene: scene, hub: hub)
                    }
                    ForEach(inbox.reviews, id: \.self) { alert in
                        // On the theme's card, as the cards around it are (it drew the system's grey).
                        ReviewAlertRow(alert: alert) { scene.openReview(ReviewRoute(stack: alert.stackId, pr: alert.pr)) }
                            .ahRow()
                    }
                } header: {
                    AhSectionHeader(title: "Needs you", count: inbox.waiting.count + inbox.reviews.count)
                }
            }
            // Grouped by project or host, as the setting asks (on a wide screen, as the web's
            // Inbox does; a phone keeps to status). What needs you stays on top either way.
            if !scene.narrow, scene.app.preferences.inboxGrouping != .status {
                let groups = SessionOrdering.sections(hub.rows.filter { $0.dto.status != .waiting }, multiHost: scene.app.preferences.inboxGrouping == .host)
                ForEach(groups, id: \.id) { group in
                    Section {
                        ForEach(group.rows) { row in
                            SessionRowView(row: row, multiHost: hub.multiHost && scene.app.preferences.inboxGrouping != .host) { scene.open(row.key) }
                                .contextMenu { SessionRowMenu(row: row, scene: scene, hub: hub) }
                                .sessionSwipes(row: row, scene: scene, hub: hub)
                                .ahRow()
                        }
                    } header: {
                        AhSectionHeader(title: group.id, count: group.rows.count)
                    }
                }
            } else {
            if !inbox.running.isEmpty {
                Section {
                    ForEach(inbox.running) { row in
                        SessionRowView(row: row, multiHost: hub.multiHost) { scene.open(row.key) }
                            .contextMenu { SessionRowMenu(row: row, scene: scene, hub: hub) }
                            .sessionSwipes(row: row, scene: scene, hub: hub)
                            .ahRow()
                    }
                } header: {
                    AhSectionHeader(title: "Working", count: inbox.running.count)
                }
            }
            if !inbox.rest.isEmpty {
                Section {
                    ForEach(inbox.rest) { row in
                        SessionRowView(row: row, multiHost: hub.multiHost) { scene.open(row.key) }
                            .contextMenu { SessionRowMenu(row: row, scene: scene, hub: hub) }
                            .sessionSwipes(row: row, scene: scene, hub: hub)
                            .ahRow()
                    }
                } header: {
                    AhSectionHeader(title: "Idle and done", count: inbox.rest.count)
                }
            }
            }
            if hub.awaitingState {
                // The host hasn't answered yet (a cold launch, with no list kept from last
                // time): rows on their way, not "No sessions running".
                Section {
                    ForEach(0..<3, id: \.self) { index in SessionRowPlaceholder(title: [0.62, 0.45, 0.7][index]).ahRow() }
                }
            } else if hub.rows.isEmpty {
                Section {
                    EmptyState(symbol: "tray", title: "No Sessions Running", message: "Start one, or pick up where you left off.", action: ("New Session", { scene.perform("new-session") }))
                        .listRowBackground(Color.clear)
                }
                let recent = Array(hub.history.prefix(3))
                if !recent.isEmpty {
                    Section {
                        ForEach(recent) { item in HistoryRowView(item: item, scene: scene, hub: hub).ahRow() }
                    } header: {
                        AhSectionHeader(title: "Recent conversations")
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        // A session that's answered, starts or finishes moves to its section with a spring,
        // and the card that asked folds away, instead of the list cutting to its new order.
        .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: inbox.order)
        // …and the connection's banner comes and goes the same way.
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: hub.phase)
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: hub.awaitingState)
        .refreshable { await hub.resyncAndWait() }
        .ahPage("Inbox")
        .toolbar {
            // Bar glyphs in the label color; only the primary action (New) carries the tint, in
            // a glass of its own, as iOS 26 bars do.
            ToolbarItem(placement: .primaryAction) {
                // A phone has a Search tab, and no sidebar: its Inbox, the first page, holds
                // what the sidebar's bar would.
                if scene.narrow {
                    MoreMenu(scene: scene).tint(.primary)
                } else {
                    Button { scene.perform("go-search") } label: { Image(systemName: "magnifyingglass") }.accessibilityLabel("Search").tint(.primary)
                }
            }
            ToolbarSpacer(.fixed, placement: .primaryAction)
            ToolbarItem(placement: .primaryAction) {
                // ah's one light circle: New (ink on a light ground).
                Button { scene.perform("new-session") } label: { Image(systemName: "plus").foregroundStyle(theme.background) }
                    .buttonStyle(.glassProminent)
                    .tint(theme.text)
                    .accessibilityLabel("New Session")
            }
            if scene.narrow {
                ToolbarItem(placement: .topBarLeading) {
                    Button { scene.perform("go-settings") } label: { Image(systemName: "gearshape") }.accessibilityLabel("Settings").tint(.primary)
                }
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                scene.open(row.key)
            } label: {
                HStack(spacing: 10) {
                    AgentMark(agent: row.dto.agent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).font(.ah(.headline)).foregroundStyle(theme.text).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                        Text([hub.multiHost ? row.host : nil, row.dto.project].compactMap { $0 }.joined(separator: " · ")).font(.ah(.caption)).foregroundStyle(theme.muted)
                        if typeSize.isAccessibilitySize { Elapsed(seconds: row.dto.activity).font(.ah(.caption)).foregroundStyle(theme.faint) }
                    }
                    Spacer()
                    if !typeSize.isAccessibilitySize { Elapsed(seconds: row.dto.activity).font(.ah(.caption)).foregroundStyle(theme.faint) }
                }
                // The whole line opens it: a tap between the title and the time did nothing.
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .hoverEffect(.highlight)
            if let ask = row.dto.ask {
                if AskParts.isForm(ask) {
                    // The form below says the question; the card only says what this is.
                    Text(AskParts.kindLabel(ask.kind)).font(.ah(.subheadline).weight(.semibold)).foregroundStyle(theme.accent)
                } else {
                    AskSummaryView(parts: AskParts(ask, detail: row.dto.detail), showTerminalText: false)
                }
            }
            AskPanelView(target: AskTarget(row: row, hub: hub) { text, error in scene.toast(text, error: error) }, compact: true, onReply: {
                scene.open(row.key)
                scene.requestFocus(.composer(row.key))
            })
        }
        .padding(.vertical, 6)
        // ah's AskCard: what needs you is the one pink-edged thing on the page.
        .listRowBackground(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(theme.accentTint).overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(theme.accentLine, lineWidth: 1)))
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
                Image(systemName: "checkmark.seal").foregroundStyle(theme.brand).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.ah(.subheadline).weight(.semibold))
                    Text("\(alert.stackTitle) · #\(alert.pr) \(alert.title)").font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
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
    /// In a list that selects (the sidebar): the list opens it, and the row is plain content,
    /// so a selected row in a focused list gets the list's white-on-accent treatment.
    var selectable = false
    let open: () -> Void
    @Environment(\.theme) private var theme
    /// Increased when the row is selected in a focused list (filled with the accent).
    @Environment(\.backgroundProminence) private var prominence
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if selectable {
            content.contentShape(Rectangle())
                .accessibilityElement(children: .combine)
                .accessibilityLabel(spoken)
                .accessibilityIdentifier("session:\(row.title)")
                .accessibilityAddTraits(.isButton)
        } else {
            Button(action: open) { content.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .hoverEffect(.highlight)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(spoken)
                .accessibilityIdentifier("session:\(row.title)")
        }
    }

    /// Everything the row shows, in the order it matters: name, status, what's said, then
    /// pinned, queued, a terminal, a fork, and when (the label replaced all of those).
    private var spoken: String {
        var parts = ["\(row.title), \(row.word.rawValue)"]
        if !detail.isEmpty { parts.append(detail) }
        if row.dto.pinned { parts.append("Pinned") }
        if row.dto.queued > 0 { parts.append("\(row.dto.queued) queued") }
        if let terminal = row.dto.terminal { parts.append(terminal.busy ? "Attached terminal active" : "Terminal attached") }
        if let fork = row.dto.fork { parts.append(fork.parentTitle.isEmpty ? "\(fork.forks) fork\(fork.forks == 1 ? "" : "s")" : "Fork of \(fork.parentTitle)") }
        parts.append(Elapsed.format(Date(timeIntervalSince1970: row.dto.activity), now: .now))
        return parts.joined(separator: ". ")
    }

    @ViewBuilder
    private var content: some View {
        // At accessibility text sizes the status goes under the title, so the title keeps the
        // row's width instead of a few letters.
        let stacked = typeSize.isAccessibilitySize
        let onAccent = prominence == .increased
        // A status in words ("needs you") on the sidebar's narrow row goes on the line under
        // the title: beside it, it left the title a few letters ("Rotate…").
        let wordsUnder = dense && !stacked && row.word.asksForAttention
        if dense || stacked {
            HStack(spacing: 10) {
                AgentMark(agent: row.dto.agent)
                VStack(alignment: .leading, spacing: 2) {
                    titleLine(onAccent: onAccent)
                    if wordsUnder {
                        HStack(alignment: .center, spacing: 6) {
                            Text(AskParts.keepingPaths(detail)).font(.ah(.caption)).foregroundStyle(secondary(onAccent)).lineLimit(1)
                            Spacer(minLength: 4)
                            status(onAccent: onAccent, compact: false).fixedSize()
                        }
                    } else {
                        Text(AskParts.keepingPaths(detail)).font(.ah(.caption)).foregroundStyle(secondary(onAccent)).lineLimit(stacked ? 2 : 1)
                    }
                    if stacked { status(onAccent: onAccent, compact: false) }
                }
                // The title takes the room first; the status keeps its own size beside it.
                .layoutPriority(1)
                Spacer(minLength: 4)
                if !stacked && !wordsUnder { status(onAccent: onAccent, compact: dense && !row.word.asksForAttention).fixedSize() }
            }
        } else {
            // A page's row, with room: a larger mark, the title with when it last moved
            // beside it, and under them what it's doing with its status at the line's end.
            // Idle says nothing, so a list at rest is names and places, and what's working
            // or waiting stands out of it.
            HStack(spacing: 12) {
                AgentMark(agent: row.dto.agent, size: 32)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        titleLine(onAccent: onAccent)
                        Spacer(minLength: 6)
                        Elapsed(seconds: row.dto.activity, short: true)
                            .font(.ah(.caption).monospacedDigit())
                            .foregroundStyle(onAccent ? .white.opacity(0.8) : theme.faint)
                    }
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        // Two lines, as a chat list shows a conversation's last message.
                        Text(detail.isEmpty ? " " : AskParts.keepingPaths(detail)).font(.ah(.footnote)).foregroundStyle(onAccent ? .white.opacity(0.8) : theme.muted).lineLimit(2)
                        Spacer(minLength: 6)
                        if row.dto.queued > 0 {
                            Text("\(row.dto.queued) queued").font(.ah(.caption2)).foregroundStyle(onAccent ? .white.opacity(0.8) : theme.faint).contentTransition(.numericText(value: Double(row.dto.queued)))
                        }
                        if row.word != .idle { StatusPill(word: row.word) }
                    }
                }
            }
            .padding(.vertical, 3)
        }
    }

    private func titleLine(onAccent: Bool) -> some View {
        HStack(spacing: 6) {
            if row.dto.pinned { Image(systemName: "pin.fill").font(.ah(.caption2)).foregroundStyle(tertiary(onAccent)) }
            Text(row.title).font(dense ? Font.ah(.body) : Font.ah(.body).weight(.medium)).foregroundStyle(primary(onAccent)).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
            if let terminal = row.dto.terminal {
                Image(systemName: "terminal")
                    .font(.ah(.caption2))
                    .foregroundStyle(terminal.busy ? AnyShapeStyle(theme.danger) : tertiary(onAccent))
                    .accessibilityLabel(terminal.busy ? "Attached terminal active" : "Terminal attached")
            }
            if let fork = row.dto.fork {
                // A fork (or a session others were forked from): its lineage at a glance.
                HStack(spacing: 2) {
                    Image(systemName: "arrow.branch")
                    if fork.forks > 0 { Text("\(fork.forks)") }
                }
                .font(.ah(.caption2).weight(.semibold))
                .foregroundStyle(tertiary(onAccent))
                .accessibilityLabel(fork.parentTitle.isEmpty ? "\(fork.forks) forks" : "Fork of \(fork.parentTitle)")
            }
        }
    }

    // In the sidebar the list draws the selection, and its fill isn't always reported as
    // increased prominence: the system's own styles there go white on it, as the pages'
    // rows above do, where the theme's grey stayed grey on pink.
    private func primary(_ onAccent: Bool) -> AnyShapeStyle {
        onAccent ? AnyShapeStyle(.white) : selectable ? AnyShapeStyle(.primary) : AnyShapeStyle(theme.text)
    }

    private func secondary(_ onAccent: Bool) -> AnyShapeStyle {
        onAccent ? AnyShapeStyle(.white.opacity(0.8)) : selectable ? AnyShapeStyle(.secondary) : AnyShapeStyle(theme.muted)
    }

    private func tertiary(_ onAccent: Bool) -> AnyShapeStyle {
        onAccent ? AnyShapeStyle(.white.opacity(0.8)) : selectable ? AnyShapeStyle(.tertiary) : AnyShapeStyle(theme.faint)
    }

    private func status(onAccent: Bool, compact: Bool) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            StatusPill(word: row.word, compact: compact)
            if row.dto.queued > 0 { Text("\(row.dto.queued) queued").font(.ah(.caption2)).foregroundStyle(onAccent ? .white.opacity(0.8) : theme.faint).contentTransition(.numericText(value: Double(row.dto.queued))) }
        }
    }

    /// Where it is (host, project) and the last thing said in it (`SessionSnippet`).
    private var detail: String {
        [multiHost ? row.host : nil, row.dto.project, SessionSnippet.line(row.dto)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// A block's header in the sidebar: its project (or host), which folds the block when
/// tapped, a button to start a session there, and a menu to move the block. Dragging a
/// header onto another moves it there.
private struct GroupHeader: View {
    let scene: SceneModel
    let hub: HubStore
    let section: SessionOrdering.Section
    let first: Bool
    let last: Bool
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var targeted = false

    private var collapsed: Bool { scene.isGroupCollapsed(section.id) }
    private var waiting: Int { section.rows.filter { $0.dto.status == .waiting }.count }

    private var newHere: SceneModel.NewSessionContext {
        if hub.multiHost {
            let host = section.rows.first.flatMap { $0.isLocal ? nil : $0.host }
            return SceneModel.NewSessionContext(host: host)
        }
        return SceneModel.NewSessionContext(cwd: section.rows.first?.dto.projectPath, host: section.rows.first.flatMap { $0.isLocal ? nil : $0.host })
    }

    var body: some View {
        HStack(spacing: 6) {
            // The name folds the block, as Finder's sidebar groups fold on theirs: a chevron
            // turns down when open, along when closed, and a closed block says how many it holds.
            Button {
                withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) { scene.toggleGroup(section.id) }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: "chevron.down")
                        .font(.ah(.caption2).weight(.bold))
                        .foregroundStyle(theme.faint)
                        .rotationEffect(.degrees(collapsed ? -90 : 0))
                    // ah's SectionHeader overline: the project in small tracked capitals.
                    Text(section.id.uppercased())
                        .font(.ah(.caption).weight(.semibold))
                        .tracking(1)
                        .foregroundStyle(theme.muted)
                        .lineLimit(1)
                    if collapsed {
                        Text("\(section.rows.count)")
                            .font(.ah(.caption2).weight(.semibold))
                            .foregroundStyle(waiting > 0 ? theme.accent : theme.faint)
                            .monospacedDigit()
                    }
                }
                .frame(minHeight: 32)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(section.id)
            .accessibilityValue(collapsed ? "Collapsed, \(section.rows.count) sessions\(waiting > 0 ? ", \(waiting) need you" : "")" : "Expanded")
            .accessibilityHint(collapsed ? "Shows its sessions" : "Hides its sessions")
            .accessibilityIdentifier("group:\(section.id)")
            Spacer(minLength: 4)
            // Tap: a new session here. Hold: move the block (a sidebar header takes no
            // context menu of its own).
            Menu {
                Button("New Session Here", systemImage: "plus") { scene.beginNewSession(newHere) }
                Divider()
                Button("Move Up", systemImage: "arrow.up") { withAnimation(.snappy) { scene.moveGroup(section.id, by: -1) } }.disabled(first)
                Button("Move Down", systemImage: "arrow.down") { withAnimation(.snappy) { scene.moveGroup(section.id, by: 1) } }.disabled(last)
            } label: {
                // A finger's worth to hit (it was the 12-point glyph), its glyph where it was.
                Image(systemName: "plus")
                    .font(.ah(.caption).weight(.semibold))
                    // The glyph at the trailing edge, in line with the rows' statuses; the
                    // target reaches inward.
                    .frame(width: 44, height: 32, alignment: .trailing)
                    .contentShape(Rectangle())
            } primaryAction: {
                scene.beginNewSession(newHere)
            }
            .menuStyle(.button)
            .buttonStyle(.borderless)
            // Secondary, like a section header's own controls; the tint is for New in the bar.
            .tint(.secondary)
            .accessibilityLabel("New Session in \(section.id)")
            .accessibilityHint("Hold for more")
            .padding(.trailing, -16)
        }
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
    /// The iPad sidebar: the pages lead the list as rows of their own, as Mail's mailboxes do.
    var showsPages = false
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// "Focus the session list" (⌃⇧0) puts the keyboard here.
    @FocusState private var listFocused: Bool

    private static let pages: [(title: String, symbol: String, route: SceneSnapshot.Route)] = [
        ("Inbox", "tray", .inbox),
        ("History", "clock.arrow.circlepath", .history),
        ("Review", "checkmark.rectangle.stack", .review(ReviewRoute())),
        ("Search", "magnifyingglass", .search),
    ]

    /// A page row's tag; session rows are tagged with their key.
    private static func tag(_ route: SceneSnapshot.Route) -> String { "page:\(route.page)" }

    private var selected: String? {
        if showsPages, scene.workspace.layout == nil, scene.route.page != "session" { return Self.tag(scene.route) }
        return selection
    }

    var body: some View {
        let sections = scene.sidebarSections
        List(selection: Binding(get: { selected }, set: { tag in
            guard let tag else { return }
            if let page = Self.pages.first(where: { Self.tag($0.route) == tag }) { scene.show(page.route) } else { scene.open(tag) }
        })) {
            if scene.narrow && !showsPages {
                // Under the page's title, as the Inbox has it: above it, the banner pushed the
                // title down the screen.
                Section {
                    ConnectionBanner(phase: hub.phase, lastUpdated: hub.lastUpdated, cached: hub.showingCached) { hub.resync() }
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                } header: { AhLargeTitle(title: "Sessions", tagline: hub.awaitingState ? "Asking your host…" : hub.inbox(narrow: true).summary).textCase(nil) }
            } else {
                ConnectionBanner(phase: hub.phase, lastUpdated: hub.lastUpdated, cached: hub.showingCached) { hub.resync() }
                    .listRowBackground(Color.clear)
            }
            if showsPages {
                Section {
                    ForEach(Self.pages, id: \.title) { page in
                        let waiting = page.route.page == "inbox" ? hub.rows.filter { $0.dto.status == .waiting }.count + hub.reviewAlerts.count : 0
                        // Icons rest muted; the current page's in the accent (ah's nav item).
                        Label { Text(page.title).font(.ah(.callout)) } icon: { Image(systemName: page.symbol).foregroundStyle(Self.tag(page.route) == selected ? theme.accent : theme.muted) }
                            .badge(waiting)
                            .tag(Self.tag(page.route))
                            .accessibilityLabel(waiting > 0 ? "\(page.title), \(waiting) need you" : page.title)
                    }
                }
            }
            ForEach(sections) { section in
                // The latest-active list is one block with no header: nothing to fold or move.
                let recent = section.id == SessionOrdering.recentSection
                Section {
                    // A folded block keeps its header alone, so the blocks below it come up.
                    if recent || !scene.isGroupCollapsed(section.id) {
                        ForEach(section.rows) { row in
                            SessionRowView(row: row, multiHost: false, dense: !scene.narrow, selectable: !scene.narrow) { scene.open(row.key) }
                                .tag(row.key)
                                .draggable(SessionDrag(key: row.key))
                                .contextMenu { SessionRowMenu(row: row, scene: scene, hub: hub) }
                                .sessionSwipes(row: row, scene: scene, hub: hub)
                                .ahRow(!showsPages)
                        }
                        // Latest active first is its own order: no dragging a row elsewhere.
                        .onMove(perform: recent ? nil : { (from: IndexSet, to: Int) in move(section: section, from: from, to: to) })
                    }
                } header: {
                    if !recent {
                        GroupHeader(scene: scene, hub: hub, section: section, first: section.id == sections.first?.id, last: section.id == sections.last?.id)
                    }
                }
            }
            if hub.awaitingState {
                ForEach(0..<3, id: \.self) { index in SessionRowPlaceholder(title: [0.62, 0.45, 0.7][index]).ahRow(!showsPages) }
            } else if hub.rows.isEmpty {
                EmptyState(symbol: "terminal", title: "No Sessions", message: "The sessions you start show up here, grouped by project.", action: ("New Session", { scene.perform("new-session") }))
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.sidebar)
        // A session that starts, ends or changes project goes to its place, as the Inbox's
        // do, instead of the list cutting to its new order.
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: sections.map { $0.rows.map(\.key) })
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: hub.phase)
        .refreshable { await hub.resyncAndWait() }
        .toolbar {
            // A phone's Sessions page offers New like the Inbox and Review do (each project's
            // own plus starts one there).
            if scene.narrow && !showsPages {
                ToolbarItem(placement: .primaryAction) {
                    Button { scene.perform("new-session") } label: { Image(systemName: "plus").foregroundStyle(theme.background) }
                        .buttonStyle(.glassProminent)
                        .tint(theme.text)
                        .accessibilityLabel("New Session")
                }
            }
        }
        .focused($listFocused)
        .onChange(of: scene.focusRequest) { _, request in if request?.target == .sidebar { listFocused = true } }
    }

    private func move(section: SessionOrdering.Section, from: IndexSet, to: Int) {
        guard let index = from.first else { return }
        let dragged = section.rows[index]
        let target = to >= section.rows.count ? section.rows.last! : section.rows[to]
        let orders = SessionOrdering.movedOrders(section.rows, dragged: dragged.key, target: target.key, after: to >= section.rows.count)
        // Every row's new place at once, then the list: one after another, a long project's
        // drag waited out a round trip per row before the order settled.
        Task {
            let writes = orders.map { key, order in
                Task { @MainActor in try? await hub.client(forKey: key).order(SessionKey(key)?.uid ?? key, order) }
            }
            for write in writes { _ = await write.value }
            hub.refresh()
        }
    }
}

/// A session's long-press menu, the same wherever its row is (sidebar, Sessions, Inbox).
struct SessionRowMenu: View {
    let row: SessionRow
    let scene: SceneModel
    let hub: HubStore

    var body: some View {
        Button("Open", systemImage: "arrow.up.right") { scene.open(row.key) }
        if hub.state(host: row.isLocal ? nil : row.host)?.supports("attachedTerminal") == true {
            Button("Terminal", systemImage: "terminal") {
                scene.open(row.key)
                scene.session(row.key)?.panel = .terminal
            }
        }
        if !scene.narrow {
            Button("Open as New Pane", systemImage: "rectangle.split.2x1") { scene.run(.openAsPane(row.key)) }
        }
        if scene.openWindow != nil {
            Button("Open in New Window", systemImage: "macwindow.badge.plus") { scene.openInNewWindow(row.key) }
        }
        Button(row.dto.pinned ? "Unpin" : "Pin", systemImage: row.dto.pinned ? "pin.slash" : "pin") { SessionPin.toggle(row, scene: scene, hub: hub) }
        if row.dto.agent != nil && row.dto.feed != nil {
            Button("Continue in Another Agent…", systemImage: CommandCatalog.icon("continue-in")) { scene.sheet = .continueIn(key: row.key, preset: nil) }
        }
        Divider()
        Button("Terminate…", systemImage: "xmark.octagon", role: .destructive) { scene.sheet = .confirmTerminate(row.key) }
    }
}

/// A session's row swiped, wherever it is: right pins it (or unpins), left terminates it,
/// through the same confirmation the menu's Terminate… asks for.
struct SessionSwipes: ViewModifier {
    let row: SessionRow
    let scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .leading) {
                Button {
                    SessionPin.toggle(row, scene: scene, hub: hub)
                } label: {
                    Image(systemName: row.dto.pinned ? "pin.slash" : "pin")
                }
                .accessibilityLabel(row.dto.pinned ? "Unpin" : "Pin")
                .tint(theme.swipe(\.limited))
            }
            .swipeActions(edge: .trailing) {
                // A glyph alone: given a title too, the system draws the action as a wide pill
                // with the word beneath, and the glyph looked stretched in it. Red by tint, not
                // role: a destructive action swiped all the way is taken for the row's deletion,
                // and the list aborts when the row is still there (it is, until the sheet says).
                Button { scene.sheet = .confirmTerminate(row.key) } label: { Image(systemName: "xmark.octagon") }
                    .accessibilityLabel("Terminate")
                    .tint(theme.swipe(\.danger))
            }
    }
}

/// Pin or unpin a session's row, on every device; a host that refuses says so.
@MainActor
enum SessionPin {
    static func toggle(_ row: SessionRow, scene: SceneModel, hub: HubStore) {
        let pinned = !row.dto.pinned
        Task {
            do {
                try await hub.client(forKey: row.key).pin(row.uid, pinned: pinned)
            } catch {
                scene.toast("Couldn’t \(pinned ? "pin" : "unpin") “\(row.title)”: \(APIError.wrap(error).message)", error: true)
            }
            hub.refresh()
        }
    }
}

extension View {
    func sessionSwipes(row: SessionRow, scene: SceneModel, hub: HubStore) -> some View { modifier(SessionSwipes(row: row, scene: scene, hub: hub)) }
}

/// History: ended and discovered conversations; resume, fork, hide.
struct HistoryView: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme

    var body: some View {
        let rows = hub.history.filter { HistoryFilter.matches($0, scene.historyFilter) }
        let days = HistoryFilter.byDay(rows)
        List {
            Section {
                AhSearchField(text: $scene.historyFilter, prompt: "Filter by title, project, agent")
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            } header: {
                AhLargeTitle(title: "History", tagline: rows.isEmpty ? nil : "\(rows.count) conversation\(rows.count == 1 ? "" : "s") to pick up.").textCase(nil)
            }
            if rows.isEmpty && hub.awaitingState {
                // Still asking the host: not "No history yet" for the second that takes.
                ProgressView().frame(maxWidth: .infinity).listRowBackground(Color.clear)
            } else if rows.isEmpty {
                EmptyState(symbol: scene.historyFilter.isEmpty ? "clock" : "magnifyingglass", title: scene.historyFilter.isEmpty ? "No History Yet" : "No Results", message: scene.historyFilter.isEmpty ? "Ended and past conversations appear here." : "No conversation in History matches “\(scene.historyFilter.trimmingCharacters(in: .whitespaces))”.")
                    .listRowBackground(Color.clear)
            }
            ForEach(days, id: \.day) { day in
                Section {
                    ForEach(day.rows) { item in HistoryRowView(item: item, scene: scene, hub: hub).ahRow() }
                } header: {
                    AhSectionHeader(title: day.day, count: day.rows.count)
                }
            }
        }
        .scrollDismissesKeyboard(.immediately)
        // History is the host's list too: pulled, it asks again, as the Inbox does.
        .refreshable { await hub.resyncAndWait() }
        .onChange(of: scene.historyFilter) { _, _ in scene.scheduleSave() }
        .navigationTitle("History")
    }
}

struct HistoryRowView: View {
    let item: HistoryRow
    let scene: SceneModel
    let hub: HubStore
    @Environment(\.theme) private var theme
    @Environment(\.dynamicTypeSize) private var typeSize
    /// A resume on its way: a second swipe or menu tap waits for it, not a second session.
    @State private var resuming = false

    var body: some View {
        Button {
            scene.open(item.id)
        } label: {
            HStack(spacing: 10) {
                AgentMark(agent: item.dto.harness == "shell" ? nil : item.dto.harness, size: typeSize.isAccessibilitySize ? 22 : 28)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        if item.dto.pinned { Image(systemName: "pin.fill").font(.ah(.caption2)).foregroundStyle(theme.faint) }
                        Text(item.dto.title).lineLimit(typeSize.isAccessibilitySize ? 3 : 1).foregroundStyle(theme.text)
                    }
                    Text([hub.multiHost ? item.host : nil, item.dto.project, item.dto.fork.map { "fork of \($0.parentTitle)" }, item.dto.continued.map { c in "↪\u{FE0E} from \(hub.presets(host: item.isLocal ? nil : item.host).first { $0.id == c.fromHarness }?.name ?? c.fromHarness)" }].compactMap { $0 }.joined(separator: " · "))
                        .font(.ah(.caption)).foregroundStyle(theme.muted).lineLimit(1)
                    if typeSize.isAccessibilitySize { Elapsed(seconds: item.dto.at).font(.ah(.caption)).foregroundStyle(theme.faint) }
                }
                Spacer()
                if !typeSize.isAccessibilitySize { Elapsed(seconds: item.dto.at, short: true).font(.ah(.caption).monospacedDigit()).foregroundStyle(theme.faint) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .swipeActions(edge: .leading) {
            Button { resume() } label: { Image(systemName: "play.fill") }.accessibilityLabel("Resume").tint(theme.swipe(\.done))
        }
        .swipeActions(edge: .trailing) {
            // Red by tint, not role, as a session's Terminate is: the row stays until the
            // host's list comes back without it.
            Button { hide() } label: { Image(systemName: "eye.slash") }.accessibilityLabel("Hide")
            .tint(theme.swipe(\.danger))
        }
        .contextMenu {
            Button("Resume", systemImage: "play") { resume() }
            if item.dto.harness != "shell" {
                Button("Fork…", systemImage: "arrow.branch") { scene.sheet = .fork(item.id) }
                Button("Continue in Another Agent…", systemImage: CommandCatalog.icon("continue-in")) { scene.sheet = .continueIn(key: item.id, preset: nil) }
            }
            Button("Hide from History", systemImage: "eye.slash", role: .destructive) { hide() }
        }
    }

    private func resume() {
        guard !resuming else { return }
        resuming = true
        Task {
            defer { resuming = false }
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

    /// Out of History on every device; a host that refuses says so, instead of the row
    /// staying with nothing said.
    private func hide() {
        Task {
            do {
                try await hub.client(host: item.isLocal ? nil : item.host).forget(item.dto.ref)
            } catch {
                scene.toast("Couldn’t hide “\(item.dto.title)”: \(APIError.wrap(error).message)", error: true)
            }
            hub.refresh(host: item.isLocal ? nil : item.host)
        }
    }
}

/// Full-text search over every conversation and side chat, on every host.
struct SearchView: View {
    @Bindable var scene: SceneModel
    @State var model: SearchModel
    @Environment(\.theme) private var theme
    /// "You" / "Agent" beside an excerpt, as wide as the text size makes them.
    @ScaledMetric(relativeTo: .caption2) private var speakerWidth: CGFloat = 38
    /// Coming to Search means typing: the field takes the keyboard when it's empty.
    @FocusState private var fieldFocused: Bool

    /// Where and when: the project (the folder's name), how long ago, and the host when
    /// there's more than one.
    private func searchMeta(_ hit: SearchHit, live: SessionRow?) -> String {
        let project = live?.dto.project ?? (hit.cwd as NSString).lastPathComponent
        let when = hit.at > 0 ? Date(timeIntervalSince1970: hit.at / 1000).formatted(.relative(presentation: .named)) : nil
        let host = (scene.hub?.multiHost ?? false) ? hit.host : nil
        return [project, when, host].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// The filters as chips: each says what it's set to, in the accent once it narrows. They
    /// keep their words whole and scroll sideways when they run out of room (large type cut
    /// them to "Anyo…" and "Any ti…").
    private var filters: some View {
        ScrollView(.horizontal, showsIndicators: false) { filterChips }
            .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
    }

    private var filterChips: some View {
        HStack(spacing: 8) {
            Menu {
                Picker("Who said it", selection: $model.query.role) {
                    Text("Anyone").tag(String?.none)
                    Text("You").tag(Optional("user"))
                    Text("The agent").tag(Optional("assistant"))
                }
            } label: {
                filterChip(model.query.role == "user" ? "You" : model.query.role == "assistant" ? "The agent" : "Anyone", symbol: "person.2", on: model.query.role != nil)
            }
            Menu {
                Picker("When", selection: Binding(get: { SearchSince(from: model.query.from) }, set: { model.query.from = $0.from })) {
                    ForEach(SearchSince.allCases, id: \.self) { Text($0.label).tag($0) }
                }
            } label: {
                filterChip(SearchSince(from: model.query.from).label, symbol: "calendar", on: model.query.from != nil)
            }
            if let hub = scene.hub, hub.multiHost {
                Menu {
                    Picker("Host", selection: $model.query.host) {
                        Text("Every host").tag(String?.none)
                        ForEach(hub.hosts, id: \.name) { Text($0.name).tag(Optional($0.name)) }
                    }
                } label: {
                    filterChip(model.query.host ?? "Every host", symbol: "server.rack", on: model.query.host != nil)
                }
            }
            // A new query on its way while the last one's answers still show: they stayed
            // up with nothing to say they were about to change.
            if model.searching {
                ProgressView().controlSize(.small).afterABeat(.milliseconds(250)).accessibilityLabel("Searching")
            }
        }
        .menuOrder(.fixed)
    }

    private func filterChip(_ title: String, symbol: String, on: Bool) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).imageScale(.small)
            Text(title).lineLimit(1)
            Image(systemName: "chevron.down").font(.ah(.caption2).weight(.semibold))
        }
        .font(.ah(.footnote).weight(.medium))
        .foregroundStyle(on ? theme.accent : theme.text2)
        .padding(.horizontal, 12)
        .frame(minHeight: 32)
        .background(on ? theme.accentTint : theme.tile, in: Capsule())
        .overlay(Capsule().strokeBorder(on ? theme.accentLine : theme.line, lineWidth: 1))
        .contentShape(Capsule())
        .fixedSize()
    }

    var body: some View {
        List {
            // Who said it, when, where: in the page, always in reach (in the bar they hid behind
            // the search field, which has the keyboard from the moment Search opens).
            filters
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)
            // Up top, where the eye is: under a page of the last query's results it went unseen.
            if let error = model.error { Banner(text: error, tone: .error, action: ("Retry", { model.search(debounce: .zero) })).listRowBackground(Color.clear) }
            if let response = model.response {
                if !response.enabled {
                    Banner(text: "Search is off on this host. Turn it on in Settings → Search.", tone: .warning)
                        .listRowBackground(Color.clear)
                } else if response.building {
                    Banner(text: "The index is still building; results may be incomplete.", tone: .info)
                        .listRowBackground(Color.clear)
                }
                ForEach(response.notes, id: \.self) { note in
                    Banner(text: "\(note.host): \(note.error)", tone: .warning)
                        .listRowBackground(Color.clear)
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
                                    Text(live?.title ?? hit.title).font(.ah(.subheadline).weight(.semibold)).lineLimit(1)
                                    if hit.kind == "chat" { Text("side chat").font(.ah(.caption2).weight(.semibold)).foregroundStyle(theme.muted) }
                                    Spacer()
                                    Text("\(hit.matches) match\(hit.matches == 1 ? "" : "es")").font(.ah(.caption)).foregroundStyle(theme.faint)
                                }
                                ForEach(Array(hit.excerpts.prefix(2).enumerated()), id: \.offset) { _, excerpt in
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(excerpt.role == "user" ? "You" : "Agent").font(.ah(.caption2).weight(.semibold)).foregroundStyle(theme.faint).frame(width: speakerWidth, alignment: .leading)
                                        HighlightedSnippet(snippet: excerpt.snippet, lines: 3)
                                    }
                                }
                                Text(searchMeta(hit, live: live)).font(.ah(.caption2)).foregroundStyle(theme.faint).lineLimit(1)
                            }
                        }
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .hoverEffect(.highlight)
                    .ahRow()
                }
                if response.results.count < response.total {
                    Button {
                        Task { await model.more() }
                    } label: {
                        // On its way, said where the tap was.
                        HStack(spacing: 8) {
                            Text("More Results")
                            if model.loadingMore { ProgressView().controlSize(.small) }
                        }
                    }
                    .disabled(model.loadingMore)
                    .ahRow()
                }
                if response.results.isEmpty && response.enabled && !model.searching {
                    EmptyState(symbol: "magnifyingglass", title: "No Results", message: "Nothing said “\(model.query.q.trimmingCharacters(in: .whitespaces))”. Try fewer or different words.")
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            } else if model.searching {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 24).listRowBackground(Color.clear)
            } else if model.query.q.trimmingCharacters(in: .whitespaces).isEmpty {
                // Before a word is typed: what this searches, not a blank page.
                EmptyState(symbol: "text.magnifyingglass", title: "Search Every Conversation", message: "What you and your agents said, in transcripts and side chats, on every host.")
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
        }
        // The chips sit under the field and its scopes as one set of controls, not a
        // grouped list's first section away.
        .contentMargins(.top, 6, for: .scrollContent)
        .searchable(text: $model.query.q, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search")
        .searchFocused($fieldFocused)
        .searchScopes($model.query.scopeOrAll) {
            Text("All").tag("all")
            Text("Transcripts").tag("transcripts")
            Text("Side chats").tag("chats")
        }
        .onChange(of: model.query) { _, query in
            scene.search = query
            scene.scheduleSave()
            model.search()
        }
        .onAppear {
            if let saved = scene.search, model.query.q.isEmpty { model.query = saved }
            if model.query.q.isEmpty { fieldFocused = true }
        }
        // "See all results for …" from the switcher, with the page already open on another
        // query: it shows the new one (this page's own changes come back the same, and stop).
        .onChange(of: scene.search) { _, asked in
            if let asked, asked != model.query { model.query = asked }
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
