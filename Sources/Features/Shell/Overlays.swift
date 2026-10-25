import SwiftUI

/// The command palette (⇧⌘P): everything you can do right now, by category, with each
/// binding as keycaps on its row and sessions in the same search. Typing searches the whole
/// tree; ↑↓ move, ↵ runs, → opens a category or a session's choices, ← / ⌫ go back, ⌘↵
/// opens a session as a new pane, Esc steps out. An empty palette starts with Recent.
struct PaletteView: View {
    @Bindable var scene: SceneModel
    @State private var selection = 0
    @State private var forward = true
    @FocusState private var focused: Bool
    @Environment(\.theme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Item: Identifiable {
        let id: String
        let node: PaletteNode
        let trail: [PaletteNode]
        /// Shown above the first row of a section.
        let section: String?
    }

    private var tree: PaletteNode { scene.paletteTree() }
    private var query: String { scene.palette?.query ?? "" }
    private var path: [String] { scene.palette?.path ?? [] }

    /// The category (or session) walked into, by the path of keys.
    private func scope(_ tree: PaletteNode) -> (node: PaletteNode, trail: [PaletteNode]) {
        var node = tree
        var trail: [PaletteNode] = []
        for key in path {
            guard let next = node.children?.first(where: { $0.key == key }) else { break }
            trail.append(next)
            node = next
        }
        return (node, trail)
    }

    private func items(_ tree: PaletteNode) -> [Item] {
        let (node, _) = scope(tree)
        if !query.trimmingCharacters(in: .whitespaces).isEmpty {
            return PaletteTree.search(node, query, recent: scene.app.preferences.recentPalette).prefix(80).map { hit in
                Item(id: (hit.trail.map(\.key) + [hit.node.key]).joined(separator: "/"), node: hit.node, trail: hit.trail, section: nil)
            }
        }
        let children = (node.children ?? []).enumerated().map { index, child in
            Item(id: child.key, node: child, trail: [], section: path.isEmpty && index == 0 ? "All commands" : nil)
        }
        guard path.isEmpty else { return children }
        let recent = scene.recentPaletteRows().enumerated().map { index, row in
            Item(id: "recent/" + row.key, node: row, trail: [], section: index == 0 ? "Recent" : nil)
        }
        return recent.isEmpty ? children.map { Item(id: $0.id, node: $0.node, trail: [], section: nil) } : recent + children
    }

    var body: some View {
        let tree = tree
        let scope = scope(tree)
        let items = items(tree)
        VStack(spacing: 0) {
            header(scope.trail, items)
            Divider().overlay(theme.faint.opacity(0.25))
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            if let section = item.section {
                                Text(section.uppercased())
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(theme.faint)
                                    .padding(.horizontal, 18)
                                    .padding(.top, index == 0 ? 6 : 12)
                                    .padding(.bottom, 4)
                                    .accessibilityAddTraits(.isHeader)
                            }
                            PaletteRow(node: item.node, trail: item.trail, selected: index == selection, bindings: scene.app.keyBindings)
                                .id(item.id)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    selection = index
                                    activate(items)
                                }
                                .onHover { inside in if inside { selection = index } }
                        }
                        if items.isEmpty {
                            Text(query.isEmpty ? "Nothing here can run right now" : "Nothing matches “\(query)”")
                                .foregroundStyle(theme.muted)
                                .frame(maxWidth: .infinity)
                                .padding(28)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .id(path.joined(separator: "/"))
                .transition(reduceMotion ? .opacity : .push(from: forward ? .trailing : .leading))
                .onChange(of: selection) { _, new in
                    if items.indices.contains(new) { proxy.scrollTo(items[new].id, anchor: nil) }
                }
            }
            .frame(maxHeight: 440)
            .clipped()
            Divider().overlay(theme.faint.opacity(0.25))
            footer(items)
        }
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.28), radius: 30, y: 16)
        .frame(maxWidth: 640)
        .padding(.horizontal, 16)
        .onAppear { focused = true }
        .task { await scene.openPalette() }
        .onChange(of: items.count) { _, count in if selection >= count { selection = max(0, count - 1) } }
    }

    private func header(_ trail: [PaletteNode], _ items: [Item]) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(theme.faint)
            ForEach(trail) { crumb in
                Text(crumb.label)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(theme.raised, in: Capsule())
                    .onTapGesture { goBack(to: trail.firstIndex(of: crumb) ?? 0) }
            }
            TextField(trail.isEmpty ? "Search commands and sessions" : "Search \(trail.last!.label)", text: Binding(get: { query }, set: { scene.palette?.query = $0; selection = 0 }))
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit { activate(items) }
                .onKeyPress(.upArrow) { move(-1, items.count); return .handled }
                .onKeyPress(.downArrow) { move(1, items.count); return .handled }
                .onKeyPress(.rightArrow) { enter(items) ? .handled : .ignored }
                .onKeyPress(.leftArrow) {
                    guard query.isEmpty, !path.isEmpty else { return .ignored }
                    back()
                    return .handled
                }
                .onKeyPress(.escape) { back(); return .handled }
                .onKeyPress(.delete) {
                    guard query.isEmpty, !path.isEmpty else { return .ignored }
                    back()
                    return .handled
                }
                // A hardware Return is handled here, not left to onSubmit: once a field has a
                // Return handler, a press it ignores doesn't reach submit.
                .onKeyPress(.return, phases: .down) { press in
                    if press.modifiers.contains(.command), items.indices.contains(selection), case .openSession(let key) = items[selection].node.action {
                        scene.run(.openAsPane(key))
                    } else {
                        activate(items)
                    }
                    return .handled
                }
                .accessibilityLabel("Command palette")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
    }

    private func footer(_ items: [Item]) -> some View {
        let selected = items.indices.contains(selection) ? items[selection].node : nil
        return HStack(spacing: 14) {
            hint(["↑", "↓"], "move")
            hint(["↵"], selected?.isCategory == true ? "open" : "run")
            if selected?.isCategory == true || selected?.hasChoices == true { hint(["→"], selected?.hasChoices == true ? "more" : "open") }
            if case .openSession? = selected?.action, !scene.narrow { hint(["⌘", "↵"], "as a pane") }
            if !path.isEmpty { hint(["←"], "back") }
            Spacer()
            hint(["esc"], path.isEmpty && query.isEmpty ? "close" : "back")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .font(.caption)
        .foregroundStyle(theme.muted)
        .accessibilityHidden(true)
    }

    private func hint(_ keys: [String], _ label: String) -> some View {
        HStack(spacing: 4) {
            Keycaps(parts: keys)
            Text(label)
        }
    }

    private func move(_ by: Int, _ count: Int) {
        guard count > 0 else { return }
        selection = (selection + by + count) % count
    }

    private func walk(_ change: () -> Void, forward isForward: Bool) {
        forward = isForward
        if reduceMotion { change() } else { withAnimation(.snappy(duration: 0.18)) { change() } }
        selection = 0
    }

    private func back() {
        if !query.isEmpty {
            scene.palette?.query = ""
            selection = 0
        } else if !path.isEmpty {
            walk({ scene.palette?.path.removeLast() }, forward: false)
        } else {
            scene.palette = nil
        }
    }

    private func goBack(to index: Int) {
        walk({ scene.palette?.path = Array(path.prefix(index + 1)) }, forward: false)
    }

    /// → on a category or a session: walk into it. False when the row has nothing inside.
    private func enter(_ items: [Item]) -> Bool {
        guard items.indices.contains(selection) else { return false }
        let item = items[selection]
        guard item.node.isCategory || item.node.hasChoices else { return false }
        let keys = item.trail.map(\.key) + [item.node.key]
        walk({
            scene.palette?.path += keys
            scene.palette?.query = ""
        }, forward: true)
        return true
    }

    private func activate(_ items: [Item]) {
        guard items.indices.contains(selection) else { return }
        let item = items[selection]
        if item.node.isCategory {
            _ = enter(items)
        } else if let action = item.node.action {
            scene.run(action)
        }
    }
}

private struct PaletteRow: View {
    let node: PaletteNode
    let trail: [PaletteNode]
    let selected: Bool
    let bindings: KeyBindings
    @Environment(\.theme) private var theme

    private var sessionKey: String? {
        if case .openSession(let key) = node.action { return key }
        return nil
    }

    var body: some View {
        HStack(spacing: 12) {
            if sessionKey != nil || node.agent != nil {
                AgentMark(agent: node.agent, size: 22)
            } else {
                Image(systemName: node.icon ?? (node.isCategory ? "folder" : "command"))
                    .symbolRenderingMode(.hierarchical)
                    .font(.body)
                    .frame(width: 22)
                    .foregroundStyle(selected ? theme.accent : theme.muted)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    ForEach(trail) { crumb in
                        Text(crumb.label).foregroundStyle(theme.faint)
                        Image(systemName: "chevron.compact.right").font(.caption2).foregroundStyle(theme.faint)
                    }
                    Text(node.label).foregroundStyle(theme.text)
                }
                .font(.body)
                .lineLimit(1)
                if let detail = node.detail, !detail.isEmpty {
                    Text(detail).font(.caption).foregroundStyle(theme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            trailing
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background {
            if selected {
                RoundedRectangle(cornerRadius: 9, style: .continuous).fill(theme.accentStrong.opacity(0.16))
                    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(theme.accentStrong.opacity(0.35), lineWidth: 0.5))
            }
        }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
        .accessibilityHint(node.isCategory ? "Opens \(node.label)" : sessionKey != nil ? "Session" : "")
    }

    @ViewBuilder private var trailing: some View {
        if node.isCategory {
            HStack(spacing: 6) {
                Text("\(node.leafCount)").font(.caption.monospacedDigit()).foregroundStyle(theme.faint)
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(theme.faint)
            }
        } else if sessionKey != nil {
            HStack(spacing: 6) {
                Text("Session")
                    .font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(theme.raised, in: Capsule())
                    .foregroundStyle(theme.muted)
                if node.hasChoices { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(theme.faint) }
            }
        } else if case .command(let id) = node.action, let chord = bindings.hint(id) {
            Keycaps(chord)
        }
    }
}

/// The session switcher (⌘K, `web/Switcher.tsx`): live sessions first; once you type,
/// History and matches inside conversations too. Tokens scope it: `h:claude s:waiting
/// p:vest m:opus in:chats role:user`. ↵ opens or resumes, ⌘↵ / ⌃↵ opens a live session as
/// a new pane, Esc closes.
struct SwitcherView: View {
    @Bindable var scene: SceneModel
    @State private var selection = 0
    @State private var content: SwitcherContent?
    @FocusState private var focused: Bool
    @Environment(\.theme) private var theme

    private enum Row: Identifiable {
        case live(SessionRow)
        case past(HistoryRow)
        case hit(SearchHit)

        var id: String {
            switch self {
            case .live(let row): return "live:" + row.key
            case .past(let row): return "past:" + row.id
            case .hit(let hit): return "hit:\(hit.host):\(hit.kind):\(hit.ref ?? hit.uid ?? hit.title)"
            }
        }
    }

    private var query: String { scene.switcher?.query ?? "" }
    private var tile: Bool { scene.switcher?.asTile == true || scene.switcher?.intoPane != nil }

    private func rows() -> (live: [SessionRow], past: [HistoryRow], hits: [SearchHit]) {
        guard let hub = scene.hub else { return ([], [], []) }
        let parsed = SwitcherSearch.parse(query)
        let order = scene.sidebarOrder.map(\.key)
        let found = SwitcherSearch.results(live: hub.rows, order: order, history: tile ? [] : hub.history, parsed)
        return (found.live, found.past, tile ? [] : (content?.hits ?? []))
    }

    var body: some View {
        let found = rows()
        let all: [Row] = found.live.map(Row.live) + found.past.map(Row.past) + found.hits.map(Row.hit)
        let text = SwitcherSearch.parse(query).text.trimmingCharacters(in: .whitespaces)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(theme.faint)
                TextField(tile ? "Open as a new pane…" : scene.hardwareKeyboard ? "Jump, resume, or search conversations…  h:claude p:vest in:chats" : "Jump, resume or search…",
                          text: Binding(get: { query }, set: { scene.switcher?.query = $0; selection = 0; content?.update($0) }))
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { choose(all, split: false) }
                    .onKeyPress(.upArrow) { if !all.isEmpty { selection = (selection - 1 + all.count) % all.count }; return .handled }
                    .onKeyPress(.downArrow) { if !all.isEmpty { selection = (selection + 1) % all.count }; return .handled }
                    .onKeyPress(.escape) { scene.switcher = nil; return .handled }
                    .onKeyPress(.return, phases: .down) { press in
                        // Handled here for a hardware Return; onSubmit stays for the on-screen key.
                        choose(all, split: press.modifiers.contains(.command) || press.modifiers.contains(.control))
                        return .handled
                    }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 13)
            Divider().overlay(theme.faint.opacity(0.25))
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(Array(all.enumerated()), id: \.element.id) { index, row in
                            if let head = heading(row, index: index, found: found) {
                                Text(head.uppercased()).font(.caption2.weight(.semibold)).foregroundStyle(theme.faint)
                                    .padding(.horizontal, 18).padding(.top, index == 0 ? 6 : 12).padding(.bottom, 4)
                                    .accessibilityAddTraits(.isHeader)
                            }
                            if case .hit = row, index == found.live.count + found.past.count, let note = content?.note {
                                Text(note).font(.caption).foregroundStyle(theme.muted).padding(.horizontal, 18)
                            }
                            SwitcherRow(row: display(row), selected: index == selection, multiHost: scene.hub?.multiHost == true)
                                .id(row.id)
                                .contentShape(Rectangle())
                                .onTapGesture { selection = index; choose(all, split: false) }
                                .onHover { if $0 { selection = index } }
                        }
                        if found.hits.isEmpty, let note = content?.note, !tile {
                            Text(note).font(.caption).foregroundStyle(theme.muted).padding(.horizontal, 18).padding(.vertical, 8)
                        }
                        if all.isEmpty {
                            Text("Nothing matches. Try h:claude or p:ah.").foregroundStyle(theme.muted).frame(maxWidth: .infinity).padding(24)
                        }
                        if text.count >= 2, !tile {
                            Button {
                                scene.showAllResults(text)
                            } label: {
                                Label("See all results for “\(text)”", systemImage: "arrow.right").font(.callout)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(theme.accent)
                            .padding(.horizontal, 18)
                            .padding(.vertical, 10)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .onChange(of: selection) { _, new in if all.indices.contains(new) { proxy.scrollTo(all[new].id) } }
            }
            .frame(maxHeight: 440)
            Divider().overlay(theme.faint.opacity(0.25))
            HStack(spacing: 14) {
                HStack(spacing: 4) { Keycaps(parts: ["↑", "↓"]); Text("move") }
                HStack(spacing: 4) { Keycaps(parts: ["↵"]); Text(tile ? "open as a new pane" : "open or resume") }
                if !tile && !scene.narrow { HStack(spacing: 4) { Keycaps(parts: ["⌘", "↵"]); Text("as a new pane") } }
                Spacer()
                HStack(spacing: 4) { Keycaps(parts: ["esc"]); Text("close") }
            }
            .font(.caption)
            .foregroundStyle(theme.muted)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .accessibilityHidden(true)
        }
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .shadow(color: .black.opacity(0.28), radius: 30, y: 16)
        .frame(maxWidth: 600)
        .padding(.horizontal, 16)
        .onAppear {
            focused = true
            if content == nil, let api = scene.hub?.api {
                content = SwitcherContent { query in try await api.search(query, allHosts: true) }
                content?.update(query)
            }
        }
    }

    private func display(_ row: Row) -> SwitcherViewRow {
        switch row {
        case .live(let r):
            return SwitcherViewRow(agent: r.dto.agent, title: r.title, fork: r.dto.fork != nil, host: r.host, detail: [r.dto.project, r.dto.branch ?? ""], status: r.word)
        case .past(let h):
            return SwitcherViewRow(agent: h.dto.harness == "shell" ? nil : h.dto.harness, title: h.dto.title, fork: h.dto.fork != nil, host: h.host,
                                   detail: [h.dto.project, Elapsed.format(Date(timeIntervalSince1970: h.dto.at), now: .now)], tag: "Resume")
        case .hit(let hit):
            let date = hit.at > 0 ? Date(timeIntervalSince1970: hit.at / 1000).formatted(.dateTime.month(.abbreviated).day()) : ""
            return SwitcherViewRow(agent: hit.harness, title: hit.title, host: hit.host,
                                   detail: [hit.kind == "chat" ? "side chat" : (hit.harness ?? ""), date, "\(hit.matches) match\(hit.matches == 1 ? "" : "es")"],
                                   snippet: hit.excerpts.first?.snippet)
        }
    }

    private func heading(_ row: Row, index: Int, found: (live: [SessionRow], past: [HistoryRow], hits: [SearchHit])) -> String? {
        switch row {
        case .live: return index == 0 && !found.past.isEmpty ? "Sessions" : nil
        case .past: return index == found.live.count ? "History" : nil
        case .hit: return index == found.live.count + found.past.count ? "In conversations" : nil
        }
    }

    private func choose(_ all: [Row], split: Bool) {
        guard all.indices.contains(selection) else { return }
        switch all[selection] {
        case .live(let row):
            if split && !scene.narrow && scene.switcher?.intoPane == nil {
                scene.switcher?.asTile = true
            }
            scene.pick(row.key)
        case .past(let item):
            scene.switcher = nil
            Task { await scene.resume(item) }
        case .hit(let hit):
            scene.openHit(hit)
        }
    }
}

private struct SwitcherRow: View {
    let row: SwitcherViewRow
    let selected: Bool
    let multiHost: Bool
    @Environment(\.theme) private var theme

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AgentMark(agent: row.agent, size: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(row.title + (row.fork ? " ⑂" : "")).font(.callout).lineLimit(1).foregroundStyle(theme.text)
                Text(row.subtitle(multiHost)).font(.caption).foregroundStyle(theme.muted).lineLimit(1)
                if let snippet = row.snippet { HighlightedSnippet(snippet: snippet) }
            }
            Spacer(minLength: 8)
            if let word = row.status {
                StatusPill(word: word, compact: true)
            } else if let tag = row.tag {
                Text(tag).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2).background(theme.raised, in: Capsule()).foregroundStyle(theme.muted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background {
            if selected { RoundedRectangle(cornerRadius: 9, style: .continuous).fill(theme.accentStrong.opacity(0.16)) }
        }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
    }
}

/// What a switcher row shows, whatever it came from.
struct SwitcherViewRow {
    var agent: String?
    var title: String
    var fork = false
    var host: String?
    var detail: [String]
    var status: StatusWord?
    var tag: String?
    var snippet: String?

    func subtitle(_ multiHost: Bool) -> String {
        ((multiHost ? [host].compactMap { $0 } : []) + detail).filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

/// Every command and its shortcuts (⌘/), searchable by name or keys; edits live in
/// Settings → Shortcuts. Dimmed rows can't run in this window right now.
struct ShortcutsView: View {
    let scene: SceneModel
    @State private var query = ""
    @Environment(\.theme) private var theme

    var body: some View {
        let bindings = scene.app.keyBindings
        let found = KeymapSearch.commands(query, bindings: bindings).filter { !bindings.chords($0.id).isEmpty }
        NavigationStack {
            List {
                ForEach([CommandGroup.navigate, .session, .workspace], id: \.self) { group in
                    let commands = found.filter { $0.group == group }
                    if !commands.isEmpty {
                        Section(group.rawValue) {
                            ForEach(commands) { c in
                                HStack(spacing: 10) {
                                    Image(systemName: CommandCatalog.icon(c.id)).frame(width: 22).foregroundStyle(theme.muted)
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(c.label).foregroundStyle(scene.isAvailable(c.id) ? theme.text : theme.faint)
                                        Text(CommandCatalog.whenLabel(c.id)).font(.caption2).foregroundStyle(theme.faint)
                                    }
                                    Spacer()
                                    HStack(spacing: 6) {
                                        // Alternatives, not one long chord: "or" between them.
                                        ForEach(Array(bindings.chords(c.id).enumerated()), id: \.offset) { i, chord in
                                            if i > 0 { Text("or").font(.caption2).foregroundStyle(theme.faint) }
                                            Keycaps(chord)
                                        }
                                    }
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                }
            }
            .searchable(text: $query, prompt: "Name or keys, like “ctrl shift p”")
            .navigationTitle("Keyboard shortcuts")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { scene.showingShortcuts = false } }
                ToolbarItem(placement: .primaryAction) { Button("Edit…") { scene.showingShortcuts = false; scene.sheet = .settings(SettingsSection.shortcuts.rawValue) } }
            }
        }
    }
}

/// Held modifiers show what one more key does (which-key), after a short pause; while a
/// two-key chord waits, what the second key can be.
struct WhichKeyHUD: View {
    let rows: [CommandMatcher.WhichKeyRow]
    /// The first key of a chord in progress, as "⌃K".
    var pending: String?
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let pending {
                HStack(spacing: 6) {
                    Text(pending).font(.callout.monospaced().weight(.bold)).foregroundStyle(theme.accent)
                    Text("then…").font(.callout).foregroundStyle(theme.muted)
                    Spacer()
                    Text("esc cancels").font(.caption).foregroundStyle(theme.faint)
                }
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 12)], alignment: .leading, spacing: 6) {
                ForEach(rows, id: \.id.rawValue) { row in
                    HStack(spacing: 8) {
                        Text(row.key).font(.callout.monospaced().weight(.semibold)).frame(minWidth: 24).padding(.horizontal, 6).padding(.vertical, 2).background(theme.raised, in: RoundedRectangle(cornerRadius: 5))
                        Text(row.label).font(.callout).lineLimit(1)
                    }
                }
            }
        }
        .padding(16)
        .background(theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.2), radius: 20, y: 8)
        .frame(maxWidth: 760)
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(pending.map { "\($0) pressed, waiting for the second key" } ?? "Available shortcuts")
    }
}

/// Pane and resize modes: which keys do what until Escape (the model's own legend).
struct SubmapHUD: View {
    let mode: WorkspaceModel.Submap
    @Environment(\.theme) private var theme

    var body: some View {
        let keys = WorkspaceModel.submapKeys[mode] ?? []
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 14) {
                Text(mode == .pane ? "PANE" : "RESIZE").font(.caption.weight(.heavy)).foregroundStyle(theme.brand)
                ForEach(Array(keys.enumerated()), id: \.offset) { _, entry in
                    HStack(spacing: 4) {
                        Keycaps(parts: entry.keys)
                        Text(entry.label).font(.caption).foregroundStyle(theme.muted)
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
        }
        .background(theme.surface, in: Capsule())
        .overlay(Capsule().strokeBorder(theme.faint.opacity(0.35), lineWidth: 0.5))
        .shadow(color: .black.opacity(0.18), radius: 16, y: 6)
        .frame(maxWidth: 900)
        .fixedSize(horizontal: false, vertical: true)
        .padding(12)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(mode == .pane ? "Pane mode" : "Resize mode")
    }
}

/// Brief window-level messages, newest last.
struct ToastStack: View {
    let scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(spacing: 6) {
            ForEach(scene.toasts) { toast in
                Text(toast.text)
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(.regularMaterial, in: Capsule())
                    .foregroundStyle(toast.isError ? theme.danger : theme.text)
                    .onTapGesture { scene.dismissToast(toast.id) }
                    .task {
                        try? await Task.sleep(for: .seconds(toast.isError ? 6 : 3))
                        scene.dismissToast(toast.id)
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .accessibilityAddTraits(.updatesFrequently)
            }
        }
        .padding(.bottom, 24)
        .animation(.snappy, value: scene.toasts.map(\.id))
        .onChange(of: scene.toasts.last?.id) { _, _ in
            if let last = scene.toasts.last { UIAccessibility.post(notification: .announcement, argument: last.text) }
        }
    }
}
