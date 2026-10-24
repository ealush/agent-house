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
                .onKeyPress(.return, phases: .down) { press in
                    guard press.modifiers.contains(.command), items.indices.contains(selection), case .openSession(let key) = items[selection].node.action else { return .ignored }
                    scene.run(.openAsPane(key))
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

/// The session switcher (⌘K): every session, newest attention first; typing filters.
struct SwitcherView: View {
    @Bindable var scene: SceneModel
    @State private var selection = 0
    @FocusState private var focused: Bool
    @Environment(\.theme) private var theme

    private var rows: [SessionRow] {
        let all = scene.sidebarOrder
        let q = (scene.switcher?.query ?? "").trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return all }
        return all.map { row in (row, max(CommandMatcher.fuzzy(q, row.title) * 2, CommandMatcher.fuzzy(q, row.dto.project), CommandMatcher.fuzzy(q, row.dto.branch ?? ""))) }
            .filter { $0.1 > 0 }
            .sorted { $0.1 > $1.1 }
            .map(\.0)
    }

    var body: some View {
        let rows = rows
        VStack(spacing: 0) {
            TextField(scene.switcher?.asTile == true ? "Open beside the focused pane" : "Go to a session", text: Binding(get: { scene.switcher?.query ?? "" }, set: { scene.switcher?.query = $0; selection = 0 }))
                .textFieldStyle(.plain)
                .font(.title3)
                .padding(14)
                .focused($focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .onSubmit { if rows.indices.contains(selection) { scene.pick(rows[selection].key) } }
                .onKeyPress(.upArrow) { if !rows.isEmpty { selection = (selection - 1 + rows.count) % rows.count }; return .handled }
                .onKeyPress(.downArrow) { if !rows.isEmpty { selection = (selection + 1) % rows.count }; return .handled }
                .onKeyPress(.escape) { scene.switcher = nil; return .handled }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.key) { index, row in
                            HStack(spacing: 10) {
                                AgentMark(agent: row.dto.agent, size: 22)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(row.title).font(.callout).lineLimit(1)
                                    Text([row.dto.project, row.dto.branch, scene.hub?.multiHost == true ? row.host : nil].compactMap { $0 }.joined(separator: " · "))
                                        .font(.caption).foregroundStyle(theme.muted).lineLimit(1)
                                }
                                Spacer()
                                StatusPill(word: row.word)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(index == selection ? theme.accentStrong.opacity(0.18) : .clear)
                            .contentShape(Rectangle())
                            .onTapGesture { scene.pick(row.key) }
                            .id(index)
                        }
                        if rows.isEmpty { Text("No sessions match").foregroundStyle(theme.muted).padding(24) }
                    }
                }
                .onChange(of: selection) { _, new in proxy.scrollTo(new, anchor: .center) }
            }
            .frame(maxHeight: 420)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .frame(maxWidth: 560)
        .padding(.horizontal, 16)
        .shadow(radius: 30, y: 10)
        .onAppear { focused = true }
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
                                        ForEach(Array(bindings.chords(c.id).enumerated()), id: \.offset) { _, chord in Keycaps(chord) }
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
