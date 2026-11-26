import SwiftUI

/// The Inbox (`apps/server/web/Inbox.tsx`): who needs you first, with one-tap safe answers; then
/// review alerts, what's working, and what's idle or done. Its search field, over the title and
/// out of sight until the list is pulled down, opens every session and History in their place,
/// and what was said in them.
struct InboxView: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    @Bindable var search: SearchModel
    @FocusState private var searchFocused: Bool
    /// Where the search field is on screen (a list's rows don't see its named spaces), so a tap
    /// anywhere else folds the keyboard.
    @State private var searchFrame: CGRect = .null
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// "Focus the session list" (⌃⇧0) on a phone, whose session list this is.
    @FocusState private var listFocused: Bool
    /// Answers the host's job decisions from their cards.
    @State private var jobs: JobsModel?
    /// The notes instead of the sessions: a tap apart, so a note isn't under every session.
    @State private var showsNotes = false
    /// Space Portal state (Chief adoption, its wakes, promoting a note).
    @State private var portal = SpacePortalModel()
    /// Whether the search is folded away (not to be tapped or read out), and how far its row is
    /// tucked under the bar (0: all of it shows): kept where a scroll's every frame changes
    /// nothing drawn. The fold itself is drawn as the list scrolls (`FoldingSearch`).
    @State private var fold = SearchFold()
    @State private var scrolled = InboxScrolled()
    @State private var searchRow: CGFloat = 52
    /// Where the bar ends over the list: the search folds as it goes under it.
    @State private var barEnd: CGFloat = 0
    /// Whether the list is long enough to scroll its search all the way out of sight.
    @State private var canTuck = false
    /// The search is to be tucked away once the list has its size (on arrival, a new Space).
    @State private var tuckPending = true

    var body: some View {
        let project = scene.shownInboxProject
        let inbox = hub.inbox(narrow: scene.narrow, project: project)
        let rows = project.map { p in hub.rows.filter { p.holds($0) } } ?? hub.rows
        let notes = project.map { p in hub.notes(scene.notes.summaries, in: p) } ?? scene.notes.summaries
        // "Not in a Space" is a filter, not a Space: no portal of its own.
        let space = project.flatMap { $0.isOutside ? nil : $0 }
        // A job's decision is the host's, not a project's: shown whatever the Inbox is narrowed to.
        let decisions = hub.jobDecisions
        // Sessions or notes, when there are notes to show (a Space can always have one).
        let switches = space != nil || !notes.isEmpty
        let showingNotes = showsNotes && switches
        ScrollViewReader { proxy in
        List {
            Section {
                // Over the title, out of sight until the list is pulled down, as a chat app keeps
                // its search. Tapped, it opens: every session and History, then what was said. It
                // stays open (a session opened from it comes back to it) until Cancel.
                // Going up under the bar, it folds away (smaller, blurred, then gone): tucked, it
                // showed through the bar's glass whole.
                FoldingSearch(fold: fold, height: searchRow, barEnd: barEnd) {
                    AhSearchField(text: $search.query.q, prompt: "Sessions, history, what was said", focused: $searchFocused, onCancel: scene.searchOpen ? { closeSearch() } : nil)
                        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                            searchFrame = frame
                            if searchRow != frame.height + 8 { searchRow = frame.height + 8 }
                        }
                }
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                    .id(InboxScroll.search)
                // Sessions or notes on the title's line.
                HStack(spacing: 12) {
                    InboxTitle(scene: scene, hub: hub, project: project, summary: hub.awaitingState ? "Asking your host…" : inbox.summary)
                    if switches && !scene.searchOpen {
                        InboxListSwitch(showsNotes: $showsNotes, sessions: rows.count, notes: notes.count)
                            .transition(.opacity)
                    }
                }
                // Room over it: tucked, it rests clear of the bar's soft edge, which blurred it.
                .listRowInsets(EdgeInsets(top: 14, leading: 16, bottom: 0, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
                .id(InboxScroll.title)
                ConnectionBanner(phase: hub.phase, lastUpdated: hub.lastUpdated, cached: hub.showingCached) { hub.resync() }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            if scene.searchOpen {
                SearchResults(scene: scene, model: search, project: project)
            } else {
                if showingNotes {
                    if let space {
                        SpaceNotesContent(scene: scene, hub: hub, project: space, portal: portal, notes: notes)
                    } else {
                        Section {
                            ForEach(notes) { note in NoteListRow(note: note, scene: scene, showsProject: project == nil) }
                        } header: {
                            AhSectionHeader(title: "Notes", count: notes.count)
                        }
                    }
                } else {
                if let space {
                    SpaceChiefStrip(scene: scene, hub: hub, project: space, portal: portal)
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
                if !inbox.waiting.isEmpty || !inbox.reviews.isEmpty || !decisions.isEmpty {
                    Section {
                        ForEach(inbox.waiting) { row in
                            AskCard(row: row, scene: scene, hub: hub)
                        }
                        if let jobs {
                            ForEach(decisions, id: \.runId) { decision in JobDecisionCard(decision: decision, model: jobs) }
                        }
                        ForEach(inbox.reviews, id: \.self) { alert in
                            // On the theme's card, as the cards around it are (it drew the system's grey).
                            ReviewAlertRow(alert: alert) { scene.openReview(ReviewRoute(stack: alert.stackId, pr: alert.pr)) }
                                .ahRow()
                        }
                    } header: {
                        AhSectionHeader(title: "Needs you", count: inbox.waiting.count + inbox.reviews.count + decisions.count)
                    }
                }
                // In the session list's blocks, as the setting asks: what a phone's Sessions tab
                // was, here instead of a page of its own. What needs you stays on top either way.
                if scene.app.preferences.inboxGrouping == .project {
                    SessionBlocks(scene: scene, hub: hub, sections: project.map { p in scene.sidebarSections.compactMap { section in
                        let mine = section.rows.filter { p.holds($0) }
                        return mine.isEmpty ? nil : SessionOrdering.Section(id: section.id, rows: mine)
                    } } ?? scene.sidebarSections, notes: [], leavesOutWaiting: true)
                } else {
                if !inbox.running.isEmpty {
                    Section {
                        ForEach(inbox.running) { row in
                            SessionRowView(row: row, multiHost: hub.multiHost, shownSpace: space?.name) { scene.open(row.key) }
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
                            SessionRowView(row: row, multiHost: hub.multiHost, shownSpace: space?.name) { scene.open(row.key) }
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
                } else if rows.isEmpty {
                    Section {
                        EmptyState(symbol: "tray", title: project.map { $0.isOutside ? "Nothing Running Outside a Space" : "Nothing Running in \($0.name)" } ?? "No Sessions Running", message: "Start one, or pick up where you left off.", action: ("New Session", { scene.perform("new-session") }))
                            .listRowBackground(Color.clear)
                    }
                    let recent = Array((project.map { p in hub.history.filter { p.holds($0) } } ?? hub.history).prefix(3))
                    if !recent.isEmpty {
                        Section {
                            ForEach(recent) { item in HistoryRowView(item: item, scene: scene, hub: hub).ahRow() }
                        } header: {
                            AhSectionHeader(title: "Recent conversations")
                        }
                    }
                }
                }
            }
        }
        .listStyle(.insetGrouped)
        // Sections a short step apart: the grouped list's own gap kept the first session a
        // screen's third down.
        .listSectionSpacing(12)
        // The search right under the bar: the grouped list's gap over its first section stood
        // between them.
        .contentMargins(.top, 0, for: .scrollContent)
        // The search tucked away: let go part way, it comes all the way out or goes back up.
        // A list that fits on the screen keeps it in sight: there's nothing to make room for.
        .onScrollGeometryChange(for: InboxScrollTop.self) { geometry in
            InboxScrollTop(tucked: geometry.contentOffset.y + geometry.contentInsets.top, travel: geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom - geometry.containerSize.height, barEnd: geometry.contentInsets.top)
        } action: { _, top in
            // Every frame of a scroll: only what changes is set, so nothing's drawn again for it.
            scrolled.tucked = top.tucked
            if barEnd != top.barEnd { barEnd = top.barEnd }
            let folded = top.tucked > searchRow / 2
            if fold.hidden != folded { fold.hidden = folded }
            if canTuck != (top.travel >= searchRow) { canTuck = top.travel >= searchRow }
            // Tucked on arrival, again as the list fills in, until it is (asked once, while the
            // list was still coming, it went part way and stayed there, faded). Not once the
            // list is touched, nor while a search is open (a launch back into one).
            if tuckPending, scene.searchOpen { tuckPending = false }
            if tuckPending, top.tucked >= searchRow - 1 { tuckPending = false }
            if tuckPending, top.travel >= searchRow, !scrolled.tucking { tuck(proxy, tries: 5) }
        }
        .onScrollPhaseChange { _, phase in
            if phase == .interacting { tuckPending = false }
            let tucked = scrolled.tucked
            guard phase == .idle, !scene.searchOpen, tucked > 1, tucked < searchRow - 1 else { return }
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.25)) {
                proxy.scrollTo(canTuck && tucked >= searchRow / 2 ? InboxScroll.title : InboxScroll.search, anchor: .top)
            }
        }
        // The notes' New Note, where a chat keeps its box: over the tab bar, out of the list.
        .safeAreaBar(edge: .bottom, spacing: 0) {
            if showingNotes && !scene.searchOpen {
                NoteComposerBar(scene: scene, hub: hub, space: space)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onChange(of: project) { tuckPending = true }
        .focused($listFocused)
        .onChange(of: scene.focusRequest) { _, request in
            if scene.narrow, request?.target == .sidebar { listFocused = true }
            if request?.target == .search {
                proxy.scrollTo(InboxScroll.search, anchor: .top)
                searchFocused = true
            }
        }
        }
        // A session that's answered, starts or finishes moves to its section with a spring,
        // and the card that asked folds away, instead of the list cutting to its new order.
        .animation(reduceMotion ? nil : .snappy(duration: 0.35), value: inbox.order)
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: scene.app.preferences.inboxGrouping)
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: scene.searchOpen)
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: scene.inboxProject)
        .animation(reduceMotion ? nil : .snappy(duration: 0.25), value: showsNotes)
        .scrollDismissesKeyboard(.immediately)
        // A tap outside the search field folds the keyboard too, as scrolling does: the search
        // and what it found stay, the whole screen to scroll them. Cancel still closes it.
        .simultaneousGesture(SpatialTapGesture(coordinateSpace: .global).onEnded { tap in
            if searchFocused, !searchFrame.contains(tap.location) { searchFocused = false }
        })
        // …and the connection's banner comes and goes the same way.
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: hub.phase)
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: hub.awaitingState)
        .refreshable { await hub.resyncAndWait() }
        .onChange(of: searchFocused) { _, focused in if focused { scene.searchOpen = true } }
        .onChange(of: search.query) { _, query in
            // A query from elsewhere (the switcher's See All Results) keeps to the chosen project too.
            let term = searchTerm(project)
            if query.project != term { search.query.project = term; return }
            scene.search = query
            scene.scheduleSave()
            search.search()
        }
        // What the index finds, the chosen project's too.
        .onChange(of: project, initial: true) { _, project in
            portal.reset()
            showsNotes = false
            let term = searchTerm(project)
            if search.query.project != term { search.query.project = term }
        }
        .onAppear {
            if jobs == nil { jobs = JobsModel(api: hub.api) }
            if let saved = scene.search, search.query.q.isEmpty, saved != search.query { search.query = saved }
            // Asked for by name (⌘F, a link) on its way here.
            if scene.searchOpen, scene.focusRequest?.target == .search { searchFocused = true }
        }
        // "See all results for …" from the switcher, with the search already open on another
        // query: it shows the new one (this page's own changes come back the same, and stop).
        .onChange(of: scene.search) { _, asked in
            if let asked, asked != search.query { search.query = asked }
        }
        .ahPage(project?.title ?? "Inbox")
        .toolbar {
            // Bar glyphs in the label color; only the primary action (New) carries the tint, in
            // a glass of its own, as iOS 26 bars do.
            // The shown Space's Files, Tasks, Knowledge, Chief and settings: one button, beside More.
            if let space {
                ToolbarItem(placement: .primaryAction) {
                    SpaceMenu(scene: scene, hub: hub, project: space).tint(.primary)
                }
            }
            ToolbarItem(placement: .primaryAction) {
                // A phone has a Search tab, and no sidebar: its Inbox, the first page, holds
                // what the sidebar's bar would.
                if scene.narrow {
                    MoreMenu(scene: scene, inbox: true).tint(.primary)
                } else {
                    Menu { InboxGroupingPicker(scene: scene) } label: { Image(systemName: "rectangle.3.group") }
                        .accessibilityLabel("Group By")
                        .menuOrder(.fixed)
                        .tint(.primary)
                }
            }
            // A phone's Inbox offers a new note beside New: it has no sidebar to start one from.
            if scene.narrow {
                ToolbarItem(placement: .primaryAction) {
                    Button { scene.perform("new-note") } label: { Text("Note") }
                        .accessibilityLabel("New Note")
                        .tint(.primary)
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

/// The Inbox's title, and beside it a small chevron: a menu of the Spaces worked in (running
/// now or in History) and the plain ones, to show one Space's sessions only, or all of them
/// again; then New Space (docs/spec/17-spaces.md). Narrowed, the title is the Space's name (its
/// settings are the Space menu's, in the bar).
struct InboxTitle: View {
    let scene: SceneModel
    let hub: HubStore
    /// The project shown, when one is (and still is one to show).
    let project: InboxProject?
    let summary: String
    @Environment(\.theme) private var theme

    /// Only hosts that work out each session's Space (`spaces` 3) are listed; an older one keeps
    /// the menu it had (its projects too, and "All Spaces").
    private var placing: Bool { !hub.placingHosts.isEmpty }

    /// A Space's entry: its name (and host, with more than one), its projects' names beneath.
    @ViewBuilder
    private func spaceLabel(_ choice: InboxProject) -> some View {
        let projects = (hub.spaces.space(choice)?.projects ?? []).map(SpacePlacement.name)
        Label {
            Text(hub.multiHost ? "\(choice.name) — \(choice.host)" : choice.name)
            if !projects.isEmpty { Text(projects.joined(separator: ", ")) }
        } icon: {
            Image(systemName: "square.stack.3d.up")
        }
    }

    var body: some View {
        let menu = hub.inboxMenu
        let selection = Binding(get: { project }, set: { scene.inboxProject = $0 })
        let title = Menu {
            Picker("Show", selection: selection) {
                Label(placing ? "All Sessions" : "All Spaces", systemImage: "square.stack").tag(InboxProject?.none)
            }
            if !menu.spaces.isEmpty {
                Section("Spaces") {
                    Picker("Spaces", selection: selection) {
                        ForEach(menu.spaces, id: \.self) { choice in spaceLabel(choice).tag(Optional(choice)) }
                    }
                }
            }
            // An older host's projects; a `spaces` 3 host lists none (they attach to Spaces).
            if !menu.projects.isEmpty {
                Section("Projects") {
                    Picker("Projects", selection: selection) {
                        ForEach(menu.projects, id: \.self) { choice in
                            Label(hub.multiHost ? "\(choice.name) — \(choice.host)" : choice.name, systemImage: "folder").tag(Optional(choice))
                        }
                    }
                }
            }
            if menu.outside {
                Section {
                    Picker(InboxProject.outsideTitle, selection: selection) {
                        Label(InboxProject.outsideTitle, systemImage: "tray").tag(Optional(InboxProject.outside))
                    }
                }
            }
            // The shown Space's settings and Chief are its own menu's, in the bar.
            if hub.state(host: nil)?.supports("spaces") == true {
                Section {
                    Button("New Space…", systemImage: "plus") { scene.sheet = .newSpace }
                }
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                (Text(project?.title ?? "Inbox").foregroundStyle(theme.text) + Text(".").foregroundStyle(theme.brand))
                    .font(.ah(.largeTitle))
                    .tracking(-0.6)
                    // A long project name shrinks a little, then ends in "…", on one line.
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .truncationMode(.middle)
                // Small, beside the title, as a title that opens a menu has it; in the accent
                // while it narrows the Inbox.
                Image(systemName: "chevron.down")
                    .font(.ah(.headline).weight(.bold))
                    .foregroundStyle(project == nil ? theme.muted : theme.accent)
            }
            .contentShape(Rectangle())
        }
        .menuOrder(.fixed)
        .buttonStyle(.plain)
        .accessibilityLabel(project.map { "\($0.title), the Inbox narrowed to it" } ?? (placing ? "Inbox, all sessions" : "Inbox, all Spaces"))
        .accessibilityHint("Shows one Space's sessions, or makes a new Space")
        .accessibilityIdentifier("inbox-project")
        .accessibilityAddTraits(.isHeader)
        let said = Text(summary).font(.custom(AhType.ui, size: 15, relativeTo: .subheadline)).foregroundStyle(theme.text2)
            .contentTransition(.numericText())
        // Beside the title while both fit on its line, under it when they don't: a line of
        // its own pushed the sessions down for a few words.
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                title
                if !summary.isEmpty { said.lineLimit(1) }
            }
            VStack(alignment: .leading, spacing: 2) {
                title
                if !summary.isEmpty { said }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 2)
        .padding(.bottom, 2)
    }
}

/// Sessions or notes, on the title's line: what the list shows. A Space's notes were after its
/// every session; now they're a tap away, each side a glyph and its count (their words had a
/// line of their own under the search).
struct InboxListSwitch: View {
    @Binding var showsNotes: Bool
    let sessions: Int
    let notes: Int
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(spacing: 2) {
            segment("Sessions", symbol: "rectangle.stack", count: sessions, on: !showsNotes, id: "inbox-show-sessions") { showsNotes = false }
            segment("Notes", symbol: "note.text", count: notes, on: showsNotes, id: "inbox-show-notes") { showsNotes = true }
        }
        .padding(3)
        .frame(minHeight: 44)
        .background(theme.tile, in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("inbox-list-switch")
    }

    private func segment(_ title: String, symbol: String, count: Int, on: Bool, id: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol).imageScale(.small)
                if count > 0 {
                    Text("\(count)")
                        .font(.ah(.footnote).weight(.semibold).monospacedDigit())
                        .contentTransition(.numericText())
                }
            }
            .padding(.horizontal, 10)
            .frame(maxHeight: .infinity)
            .foregroundStyle(on ? .white : theme.text2)
            .background(on ? theme.accent : .clear, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel(count > 0 ? "\(title), \(count)" : title)
        .accessibilityAddTraits(on ? [.isSelected] : [])
        .accessibilityIdentifier(id)
    }
}

/// The Inbox's rows a scroll goes to: the search over the title, and the title (the search
/// tucked away above it).
private enum InboxScroll: Hashable { case search, title }

/// Whether the Inbox's search is folded away: read by the search alone, and set only as it
/// folds or comes back, not on every frame of a scroll.
@Observable @MainActor
final class SearchFold {
    var hidden = false
}

/// How far the Inbox's search is tucked under the bar, as of the last frame: for letting go
/// part way. Not observed: nothing is drawn from it.
@MainActor
final class InboxScrolled {
    var tucked: CGFloat = 0
    /// A tuck asked for and not yet made: one at a time, as the list fills in.
    var tucking = false
}

/// The search, folding away as it goes up under the bar: smaller toward its foot, blurred, and
/// gone by the time half of it is under (the bar's glass showed it through, whole). Drawn from
/// where it is as the list scrolls (`visualEffect`), not by drawing the row again: that ran
/// at a few frames a second.
private struct FoldingSearch<Content: View>: View {
    let fold: SearchFold
    let height: CGFloat
    let barEnd: CGFloat
    @ViewBuilder let content: Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .visualEffect { [height, barEnd, reduceMotion] effect, proxy in
                // Its row's top inset (4) over the bar's end: how much of it is under.
                let under = barEnd + 4 - proxy.frame(in: .scrollView(axis: .vertical)).minY
                let folded = min(max(under / max(height, 1), 0), 1)
                return effect
                    .scaleEffect(reduceMotion ? 1 : 1 - 0.3 * folded, anchor: .bottom)
                    .blur(radius: reduceMotion ? 0 : 6 * folded)
                    .opacity(1 - min(1, folded * 2))
            }
            .allowsHitTesting(!fold.hidden)
            .accessibilityHidden(fold.hidden)
    }
}

/// How far the search is tucked under the bar, and how far the list can scroll in all.
private struct InboxScrollTop: Equatable {
    var tucked: CGFloat
    var travel: CGFloat
    var barEnd: CGFloat
}

extension InboxView {
    /// The search tucked away: the title to the top, then looked at again a moment later, as
    /// the list's rows take their real heights (it scrolled to their estimates, and stopped
    /// part way with nothing more to move it).
    fileprivate func tuck(_ proxy: ScrollViewProxy, tries: Int) {
        scrolled.tucking = true
        DispatchQueue.main.async {
            guard tuckPending else { scrolled.tucking = false; return }
            proxy.scrollTo(InboxScroll.title, anchor: .top)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                scrolled.tucking = false
                if tuckPending, scrolled.tucked < searchRow - 1, tries > 1 { tuck(proxy, tries: tries - 1) }
            }
        }
    }

    /// Cancel: the words go, the keyboard goes down, and what needs you is back.
    fileprivate func closeSearch() {
        search.query.q = ""
        searchFocused = false
        scene.searchOpen = false
    }

    /// What content search narrows to: an older host's project by its path. A `spaces` 3 Space
    /// spans projects, and "Not in a Space" is none, so their search asks everywhere (the lists
    /// of sessions and History beside it are narrowed all the same).
    fileprivate func searchTerm(_ project: InboxProject?) -> String? {
        guard let project, !project.isOutside, !hub.placesSpaces(host: project.host == hub.hostname ? nil : project.host) else { return nil }
        return project.searchTerm(hub.rows)
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
                        if typeSize.isAccessibilitySize { Elapsed(seconds: row.lastActive).font(.ah(.caption)).foregroundStyle(theme.faint) }
                    }
                    Spacer()
                    if !typeSize.isAccessibilitySize { Elapsed(seconds: row.lastActive).font(.ah(.caption)).foregroundStyle(theme.faint) }
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
    /// The Space the list is narrowed to: its rows say their project, not the Space again.
    var shownSpace: String? = nil
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
        if row.dto.supervision?.role == .chief { parts.append("Chief of Staff") }
        if !detail.isEmpty { parts.append(detail) }
        if row.dto.pinned { parts.append("Pinned") }
        if row.dto.queued > 0 { parts.append("\(row.dto.queued) queued") }
        if let terminal = row.dto.terminal { parts.append(terminal.busy ? "Attached terminal running \(terminal.command)" : "Terminal attached") }
        if let fork = row.dto.fork { parts.append(fork.parentTitle.isEmpty ? "\(fork.forks) fork\(fork.forks == 1 ? "" : "s")" : "Fork of \(fork.parentTitle)") }
        parts.append(Elapsed.format(Date(timeIntervalSince1970: row.lastActive), now: .now))
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
                        Elapsed(seconds: row.lastActive, short: true)
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
            // The one session that reaches down to others: a small crown by its name, and no
            // more. Its workers are sessions like any other.
            if row.dto.supervision?.role == .chief {
                Image(systemName: "crown.fill")
                    .font(.ah(.caption2))
                    .foregroundStyle(onAccent ? .white : theme.accent)
                    .accessibilityLabel("Chief of Staff")
            }
            if let terminal = row.dto.terminal {
                TerminalActivityGlyph(terminal: terminal, idle: tertiary(onAccent))
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

    /// Where it is (host, Space/project) and the last thing said in it (`SessionSnippet`).
    private var detail: String {
        // The Space it's in and its project (the project alone inside that Space's list, or
        // for one in no Space).
        let spaceLabel: String = {
            let project = row.dto.project
            guard let s = row.spaceName, s != shownSpace else { return project }
            return s == project || project.isEmpty ? s : "\(s) · \(project)"
        }()
        return [multiHost ? row.host : nil, spaceLabel, SessionSnippet.line(row.dto)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
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
        let lead = section.rows.first
        // A `spaces` 3 host's block is a Space (or none): a new session here is in it.
        let space: String? = lead.flatMap { $0.hostPlacesSpaces ? ($0.spaceName ?? "") : nil }
        return SceneModel.NewSessionContext(cwd: lead?.dto.projectPath, host: lead.flatMap { $0.isLocal ? nil : $0.host }, spaceName: space)
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
                if !hub.multiHost, let lead = section.rows.first {
                    if lead.hostPlacesSpaces && lead.spaceName == nil {
                        Button("Show \(InboxProject.outsideTitle)", systemImage: "tray") { scene.openSpace(.outside) }
                    } else {
                        Button("Open Space Portal", systemImage: "square.grid.2x2") {
                            scene.openSpace(InboxProject(host: lead.host, name: section.id))
                        }
                    }
                }
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

/// The iPad sidebar's session list: the pages, then the sessions' blocks as `SessionBlocks`
/// draws them, with pin, rename and terminate at hand.
struct SessionListView: View {
    @Bindable var scene: SceneModel
    let hub: HubStore
    var selection: String?
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// "Focus the session list" (⌃⇧0) puts the keyboard here.
    @FocusState private var listFocused: Bool

    /// The pages lead the list as rows of their own, as Mail's mailboxes do.
    private static let pages: [(title: String, symbol: String, route: SceneSnapshot.Route)] = [
        ("Inbox", "tray", .inbox),
        ("Review", "checkmark.rectangle.stack", .review(ReviewRoute())),
    ]

    /// A page row's tag; session rows are tagged with their key.
    private static func tag(_ route: SceneSnapshot.Route) -> String { "page:\(route.page)" }

    private var selected: String? {
        if scene.workspace.layout == nil, scene.route.page != "session" { return Self.tag(scene.route) }
        return selection
    }

    var body: some View {
        let sections = scene.sidebarSections
        List(selection: Binding(get: { selected }, set: { tag in
            guard let tag else { return }
            if let page = Self.pages.first(where: { Self.tag($0.route) == tag }) { scene.show(page.route) } else { scene.open(tag) }
        })) {
            ConnectionBanner(phase: hub.phase, lastUpdated: hub.lastUpdated, cached: hub.showingCached) { hub.resync() }
                .listRowBackground(Color.clear)
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
            SessionBlocks(scene: scene, hub: hub, sections: sections, sidebar: true)
            if hub.awaitingState {
                ForEach(0..<3, id: \.self) { index in SessionRowPlaceholder(title: [0.62, 0.45, 0.7][index]).ahRow(false) }
            } else if hub.rows.isEmpty && scene.notes.summaries.isEmpty {
                EmptyState(symbol: "terminal", title: "No Sessions", message: "The sessions you start show up here, grouped by Space.", action: ("New Session", { scene.perform("new-session") }))
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.sidebar)
        // A session that starts, ends or changes project goes to its place, as the Inbox's
        // do, instead of the list cutting to its new order.
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: sections.map { $0.rows.map(\.key) })
        .animation(reduceMotion ? nil : .snappy(duration: 0.3), value: hub.phase)
        .refreshable { await hub.resyncAndWait() }
        .focused($listFocused)
        .onChange(of: scene.focusRequest) { _, request in if request?.target == .sidebar { listFocused = true } }
    }
}

/// How the Inbox is grouped: by status, or in the session list's blocks (per project, or per
/// host when there's more than one). In its bar, where a phone, with no Sessions tab, looks.
struct InboxGroupingPicker: View {
    let scene: SceneModel

    var body: some View {
        Picker("Group By", selection: Binding(get: { scene.app.preferences.inboxGrouping }, set: { scene.app.preferences.inboxGrouping = $0 })) {
            Label("Status", systemImage: "circle.lefthalf.filled").tag(DevicePreferences.InboxGrouping.status)
            Label(scene.hub?.multiHost == true ? "Host" : "Space", systemImage: "folder").tag(DevicePreferences.InboxGrouping.project)
        }
    }
}

/// The sessions in their blocks, per project (or per host), in the order this device keeps:
/// each block's header folds it, starts a session there and moves it; rows drag into a new
/// order; a project's notes sit under its sessions. The iPad sidebar lists these, and the
/// Inbox does when it's grouped by project (it was a phone's Sessions tab).
struct SessionBlocks: View {
    let scene: SceneModel
    let hub: HubStore
    let sections: [SessionOrdering.Section]
    /// The iPad sidebar: dense, selectable rows on its glass.
    var sidebar = false
    /// The notes to place among the blocks (the Inbox's, narrowed to its project); every note by default.
    var notes: [NotesModel.Summary]? = nil
    /// Sessions that need you are left out: the Inbox has them on top, as cards.
    var leavesOutWaiting = false
    @Environment(\.theme) private var theme

    var body: some View {
        // A block whose every session needs you would be a header with nothing under it.
        let sections = leavesOutWaiting ? sections.filter { $0.rows.contains { $0.dto.status != .waiting } } : sections
        let notes = NoteGrouping.place(notes ?? scene.notes.summaries, sections: sections, multiHost: hub.multiHost)
        ForEach(sections) { section in
            // The latest-active list is one block with no header: nothing to fold or move.
            let recent = section.id == SessionOrdering.recentSection
            let rows = leavesOutWaiting ? section.rows.filter { $0.dto.status != .waiting } : section.rows
            Section {
                // A folded block keeps its header alone, so the blocks below it come up.
                if recent || !scene.isGroupCollapsed(section.id) {
                    ForEach(rows) { row in
                        SessionRowView(row: row, multiHost: false, dense: sidebar, selectable: sidebar) { scene.open(row.key) }
                            .tag(row.key)
                            .draggable(SessionDrag(key: row.key))
                            .contextMenu { SessionRowMenu(row: row, scene: scene, hub: hub) }
                            .sessionSwipes(row: row, scene: scene, hub: hub)
                            .ahRow(!sidebar)
                    }
                    // Latest active first is its own order: no dragging a row elsewhere.
                    .onMove(perform: recent ? nil : { (from: IndexSet, to: Int) in move(section: section, shown: rows, from: from, to: to) })
                    // The project's notes, under its sessions, as if they were in its folder.
                    ForEach(notes.inSections[section.id] ?? []) { note in noteRow(note, showsProject: hub.multiHost) }
                }
            } header: {
                if !recent {
                    GroupHeader(scene: scene, hub: hub, section: section, first: section.id == sections.first?.id, last: section.id == sections.last?.id)
                }
            }
        }
        ForEach(notes.groups, id: \.id) { group in
            Section {
                ForEach(group.notes) { note in noteRow(note, showsProject: group.id.hasPrefix("notes:host:")) }
            } header: {
                if sidebar {
                    Label(group.title, systemImage: group.id == NoteGrouping.unfiled ? "note.text" : "folder")
                        .font(.ah(.caption).weight(.semibold))
                        .foregroundStyle(theme.muted)
                        .textCase(nil)
                        .accessibilityAddTraits(.isHeader)
                } else {
                    // On a page, headed as the page's other sections are.
                    AhSectionHeader(title: group.title, count: group.notes.count)
                }
            }
        }
    }

    private func noteRow(_ note: NotesModel.Summary, showsProject: Bool) -> some View {
        NoteListRow(note: note, scene: scene, showsProject: showsProject, sidebar: sidebar)
    }

    /// `shown` is the block as drawn (the Inbox leaves out who needs you); the new order is
    /// worked out over the whole block, so the rows left out keep their places.
    private func move(section: SessionOrdering.Section, shown: [SessionRow], from: IndexSet, to: Int) {
        guard let index = from.first, let last = shown.last else { return }
        let dragged = shown[index]
        let target = to >= shown.count ? last : shown[to]
        let orders = SessionOrdering.movedOrders(section.rows, dragged: dragged.key, target: target.key, after: to >= shown.count)
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

/// A note in a session list: opens it, drags into a pane, deletes with a swipe.
struct NoteListRow: View {
    let note: NotesModel.Summary
    let scene: SceneModel
    var showsProject: Bool
    var sidebar = false
    @Environment(\.theme) private var theme

    var body: some View {
        NoteRowView(note: note, dense: sidebar, showsProject: showsProject) { scene.open(note.key) }
            .tag(note.key)
            .draggable(SessionDrag(key: note.key))
            .contextMenu { NoteRowMenu(note: note, scene: scene) }
            .swipeActions(edge: .trailing) {
                Button { scene.sheet = .noteDelete(note.id) } label: { Image(systemName: "trash") }.tint(theme.danger).accessibilityLabel("Delete")
            }
            .ahRow(!sidebar)
    }
}

/// A session's long-press menu, the same wherever its row is (sidebar, Inbox, Search).
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
        // To paste into another session's box, as the session's own menu has it.
        if scene.link(to: Place(.session(row.key))) != nil {
            Button("Copy Link", systemImage: "link") { scene.copyLink(to: Place(.session(row.key))) }
        }
        if row.dto.agent != nil && row.dto.feed != nil {
            Button("Continue in Another Agent…", systemImage: CommandCatalog.icon("continue-in")) { scene.sheet = .continueIn(key: row.key, preset: nil) }
        }
        if hub.placesSpaces(host: row.isLocal ? nil : row.host) {
            MoveToSpaceMenu(row: row, scene: scene, hub: hub)
        } else if hub.state(host: row.isLocal ? nil : row.host)?.supports("spaces", version: 2) == true {
            let hostSpaces = hub.inboxChoices.filter { $0.host == row.host }
            if !hostSpaces.isEmpty {
                Menu("Move to Space", systemImage: "folder.badge.plus") {
                    ForEach(hostSpaces, id: \.self) { sp in
                        let current = (row.dto.space ?? row.dto.project) == sp.name
                        Button {
                            let api = hub.client(host: row.isLocal ? nil : row.host)
                            Task {
                                do {
                                    _ = try await api.setSessionSpace(row.uid, space: sp.name)
                                    hub.refresh(host: row.isLocal ? nil : row.host)
                                    scene.toast("Moved to \(sp.name)")
                                } catch {
                                    scene.toast(APIError.wrap(error).message, error: true)
                                }
                            }
                        } label: {
                            Label(sp.name, systemImage: current ? "checkmark" : "folder")
                        }
                    }
                    if row.dto.space != nil {
                        Divider()
                        Button("Reset to Folder Default") {
                            let api = hub.client(host: row.isLocal ? nil : row.host)
                            Task {
                                do {
                                    _ = try await api.setSessionSpace(row.uid, space: nil)
                                    hub.refresh(host: row.isLocal ? nil : row.host)
                                    scene.toast("Reset Space to folder default")
                                } catch {
                                    scene.toast(APIError.wrap(error).message, error: true)
                                }
                            }
                        }
                    }
                }
            }
        }
        if hub.state(host: row.isLocal ? nil : row.host)?.supports("supervision") == true {
            let spaceName = row.spaceName ?? ""
            let hostChiefs = hub.rows.filter {
                $0.host == row.host && $0.uid != row.uid && $0.dto.supervision?.role == .chief
                    && ($0.dto.supervision?.space == nil || $0.dto.supervision?.space == spaceName)
            }
            Menu("Supervision", systemImage: "crown") {
                if row.dto.supervision?.role != .chief && row.dto.agent != nil {
                    Button("Promote to Chief of Staff", systemImage: "crown.fill") {
                        let api = hub.client(host: row.isLocal ? nil : row.host)
                        Task {
                            do {
                                _ = try await api.setSupervision(
                                    row.uid,
                                    patch: SupervisionPatch(role: .set(.chief), managedBy: .clear, space: spaceName.isEmpty ? .keep : .set(spaceName))
                                )
                                hub.refresh(host: row.isLocal ? nil : row.host)
                                scene.toast("\(row.title) is now Chief of Staff")
                            } catch {
                                scene.toast(APIError.wrap(error).message, error: true)
                            }
                        }
                    }
                }
                if !hostChiefs.isEmpty && row.dto.supervision?.role != .chief {
                    ForEach(hostChiefs) { chief in
                        Button("Assign to \(chief.title)", systemImage: "person.badge.shield.checkmark") {
                            let api = hub.client(host: row.isLocal ? nil : row.host)
                            Task {
                                do {
                                    _ = try await api.setSupervision(
                                        row.uid,
                                        patch: SupervisionPatch(role: .set(.worker), managedBy: .set(chief.uid), muteAlerts: .set(true))
                                    )
                                    hub.refresh(host: row.isLocal ? nil : row.host)
                                    scene.toast("Assigned to \(chief.title)")
                                } catch {
                                    scene.toast(APIError.wrap(error).message, error: true)
                                }
                            }
                        }
                    }
                }
                if row.dto.supervision?.managedBy != nil || row.dto.supervision?.role != nil {
                    Divider()
                    Button("Release from Supervision", systemImage: "person.crop.circle.badge.minus") {
                        let api = hub.client(host: row.isLocal ? nil : row.host)
                        Task {
                            do {
                                _ = try await api.setSupervision(
                                    row.uid,
                                    patch: SupervisionPatch(role: .clear, managedBy: .clear, space: .clear, muteAlerts: .clear)
                                )
                                hub.refresh(host: row.isLocal ? nil : row.host)
                                scene.toast("Released \(row.title)")
                            } catch {
                                scene.toast(APIError.wrap(error).message, error: true)
                            }
                        }
                    }
                }
            }
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

/// Move to Space… on a `spaces` 3 host (SPC-6, SPC-8): any of its Spaces, back to its project's
/// (when that project is attached to one it isn't in now), or none; a check by the one it's in.
struct MoveToSpaceMenu: View {
    let row: SessionRow
    let scene: SceneModel
    let hub: HubStore

    private var hostParam: String? { row.isLocal ? nil : row.host }

    var body: some View {
        let spaces = hub.spaces.list(host: row.host)?.spaces.filter { $0.kind == .space } ?? []
        let home = hub.state(host: hostParam)?.home
        let projectSpace = SpacePlacement.attachedSpace(folder: row.dto.projectPath, spaces: spaces, home: home)
        let current = row.spaceName
        Menu("Move to Space", systemImage: "square.stack.3d.up") {
            Section(current.map { "In \($0)" } ?? "In no Space") {
                ForEach(spaces) { space in
                    Button { move(to: space.name, said: "Moved to \(space.name)") } label: {
                        Label(space.name, systemImage: current == space.name ? "checkmark" : "square.stack.3d.up")
                    }
                    .disabled(current == space.name)
                }
            }
            Section {
                if let projectSpace, current != projectSpace {
                    Button { move(to: nil, said: "Back in \(projectSpace), its project’s Space") } label: {
                        Label("Its Project’s Space (\(projectSpace))", systemImage: "arrow.uturn.backward")
                    }
                }
                Button { move(to: "", said: "Not in a Space") } label: {
                    Label("No Space", systemImage: current == nil ? "checkmark" : "tray")
                }
                .disabled(current == nil)
            }
        }
        .accessibilityIdentifier("move-to-space")
    }

    /// `space`: a Space's name; `""` none; nil back to its project's (PUT /api/sessions/:uid/space).
    private func move(to space: String?, said: String) {
        let api = hub.client(host: hostParam)
        Task {
            do {
                _ = try await api.setSessionSpace(row.uid, space: space)
                hub.refresh(host: hostParam)
                scene.toast(said)
            } catch {
                scene.toast(APIError.wrap(error).message, error: true)
            }
        }
    }
}

/// A past conversation (ended, or found on the host): resume, fork, hide. In Search, and in
/// an empty Inbox's recent ones.
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

/// The Inbox's search: every session, running and past (History lives here), narrowed as
/// words are typed, then what was said, full text, in every conversation and side chat on
/// every host. Rows of the Inbox's list, in place of what needs you while the search is open.
struct SearchResults: View {
    let scene: SceneModel
    @Bindable var model: SearchModel
    /// The Inbox's one project, when its chevron chose one: the lists keep to it too.
    var project: InboxProject? = nil
    @Environment(\.theme) private var theme
    /// "You" / "Agent" beside an excerpt, as wide as the text size makes them.
    @ScaledMetric(relativeTo: .caption2) private var speakerWidth: CGFloat = 38
    /// The whole of History under what's typed, not only its first rows.
    @State private var allHistory = false

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
            // Where the words are looked for (what the bar's scopes did on Search's own page).
            Menu {
                Picker("Look in", selection: $model.query.scopeOrAll) {
                    Text("Everything").tag("all")
                    Text("Transcripts").tag("transcripts")
                    Text("Side chats").tag("chats")
                }
            } label: {
                filterChip(model.query.scopeOrAll == "transcripts" ? "Transcripts" : model.query.scopeOrAll == "chats" ? "Side chats" : "Everything", symbol: "text.magnifyingglass", on: model.query.scope != nil)
            }
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

    /// A past conversation's rows shown while words are typed, before Show All: what the
    /// index found stays in sight under them.
    private static let historyWhileTyping = 5

    /// One thing the index found: where it was said, and the lines that matched.
    private func hitRow(_ hit: SearchHit) -> some View {
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

    var body: some View {
        let typed = model.query.q.trimmingCharacters(in: .whitespacesAndNewlines)
        // Every session, running or past (History lives here), as the words and chips narrow them.
        let live = scene.hub.map { hub in HistoryFilter.live(hub.rows.filter { project?.holds($0) ?? true }, model.query) } ?? []
        let past = scene.hub.map { hub in HistoryFilter.past(hub.history.filter { project?.holds($0) ?? true }, model.query) } ?? []
        let shownPast = typed.isEmpty || allHistory ? past : Array(past.prefix(Self.historyWhileTyping))
        let found = model.response?.results ?? []
        Group {
            // Who said it, when, where: in the page, always in reach (in the bar they hid behind
            // the search field). When and where narrow the lists too; who said it, what was said.
            filters
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                .listRowSeparator(.hidden)
                // New words: History's first rows again, not all of it.
                .onChange(of: model.query.q) { _, _ in allHistory = false }
            // Up top, where the eye is: under a page of the last query's results it went unseen.
            if let error = model.error { Banner(text: error, tone: .error, action: ("Retry", { model.search(debounce: .zero) })).listRowBackground(Color.clear) }
            if let hub = scene.hub, !live.isEmpty {
                Section {
                    ForEach(live) { row in
                        SessionRowView(row: row, multiHost: hub.multiHost) { scene.open(row.key) }
                            .contextMenu { SessionRowMenu(row: row, scene: scene, hub: hub) }
                            .sessionSwipes(row: row, scene: scene, hub: hub)
                            .ahRow()
                    }
                } header: {
                    AhSectionHeader(title: "Sessions", count: live.count)
                }
            }
            // Notes are this device's: found here, offline too.
            let notes = typed.isEmpty ? [] : scene.notes.search(typed, limit: 8)
            if !notes.isEmpty {
                Section {
                    ForEach(notes) { note in
                        NoteRowView(note: note, showsProject: true) { scene.goTo(note.key) }
                            .ahRow()
                    }
                } header: {
                    AhSectionHeader(title: "Notes", count: notes.count)
                }
            }
            if let hub = scene.hub, !past.isEmpty {
                if typed.isEmpty {
                    // Nothing typed: the whole of History, a day at a time.
                    ForEach(HistoryFilter.byDay(shownPast), id: \.day) { day in
                        Section {
                            ForEach(day.rows) { item in HistoryRowView(item: item, scene: scene, hub: hub).ahRow() }
                        } header: {
                            AhSectionHeader(title: "History · \(day.day)", count: day.rows.count)
                        }
                    }
                } else {
                    Section {
                        ForEach(shownPast) { item in HistoryRowView(item: item, scene: scene, hub: hub).ahRow() }
                        if shownPast.count < past.count {
                            Button("Show All \(past.count)") { allHistory = true }.ahRow()
                        }
                    } header: {
                        AhSectionHeader(title: "History", count: past.count)
                    }
                }
            }
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
                if !found.isEmpty {
                    Section {
                        ForEach(Array(found.enumerated()), id: \.offset) { _, hit in hitRow(hit) }
                        if found.count < response.total {
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
                    } header: {
                        AhSectionHeader(title: "Said in Conversations", count: response.total)
                    }
                }
                if found.isEmpty && live.isEmpty && past.isEmpty && notes.isEmpty && response.enabled && !model.searching {
                    EmptyState(symbol: "magnifyingglass", title: "No Results", message: "No session is called “\(typed)”, and nothing said it. Try fewer or different words.")
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            } else if model.searching && live.isEmpty && past.isEmpty {
                ProgressView().frame(maxWidth: .infinity).padding(.top, 24).listRowBackground(Color.clear)
            }
            if typed.isEmpty && live.isEmpty && past.isEmpty {
                if scene.hub?.awaitingState == true {
                    // Still asking the host: not "nothing yet" for the second that takes.
                    ProgressView().frame(maxWidth: .infinity).padding(.top, 24).listRowBackground(Color.clear)
                } else {
                    EmptyState(symbol: "text.magnifyingglass", title: "Nothing to Search Yet", message: "Sessions you start, past conversations and what was said in them, on every host, are found here.")
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            }
        }
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
