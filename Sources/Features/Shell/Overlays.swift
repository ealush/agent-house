import SwiftUI

/// The command palette (⇧⌘P): what you can do right now, by category, with each binding
/// shown on its row. Typing searches the whole tree; ↑↓ move, ⏎ runs, ⌫ on empty goes up.
struct PaletteView: View {
    @Bindable var scene: SceneModel
    @State private var selection = 0
    @FocusState private var focused: Bool
    @Environment(\.theme) private var theme

    private var tree: PaletteNode { scene.paletteTree() }

    /// The category walked into, by the path of keys.
    private var scope: (node: PaletteNode, trail: [PaletteNode]) {
        var node = tree
        var trail: [PaletteNode] = []
        for key in scene.palette?.path ?? [] {
            guard let next = node.children?.first(where: { $0.key == key }) else { break }
            trail.append(next)
            node = next
        }
        return (node, trail)
    }

    private var rows: [(node: PaletteNode, trail: [PaletteNode])] {
        let query = scene.palette?.query ?? ""
        let scope = scope.node
        if query.trimmingCharacters(in: .whitespaces).isEmpty { return (scope.children ?? []).map { ($0, []) } }
        return PaletteTree.search(scope, query).prefix(60).map { ($0.node, $0.trail) }
    }

    var body: some View {
        let rows = rows
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach(scope.trail) { crumb in
                    Text(crumb.label).font(.caption.weight(.semibold)).padding(.horizontal, 8).padding(.vertical, 3).background(theme.raised, in: Capsule())
                }
                TextField(scope.trail.isEmpty ? "Search commands" : "Search \(scope.trail.last!.label)", text: Binding(get: { scene.palette?.query ?? "" }, set: { scene.palette?.query = $0; selection = 0 }))
                    .textFieldStyle(.plain)
                    .font(.title3)
                    .focused($focused)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .onSubmit { activate(rows) }
                    .onKeyPress(.upArrow) { move(-1, rows.count); return .handled }
                    .onKeyPress(.downArrow) { move(1, rows.count); return .handled }
                    .onKeyPress(.escape) { back(); return .handled }
                    .onKeyPress(.delete) {
                        guard (scene.palette?.query ?? "").isEmpty, !(scene.palette?.path.isEmpty ?? true) else { return .ignored }
                        scene.palette?.path.removeLast()
                        selection = 0
                        return .handled
                    }
                    .accessibilityLabel("Command palette")
            }
            .padding(14)
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(rows.enumerated()), id: \.element.node.id) { index, row in
                            PaletteRow(node: row.node, trail: row.trail, selected: index == selection, bindings: scene.app.keyBindings)
                                .id(index)
                                .contentShape(Rectangle())
                                .onTapGesture { selection = index; activate(rows) }
                        }
                        if rows.isEmpty { Text("Nothing matches").foregroundStyle(theme.muted).padding(24) }
                    }
                }
                .onChange(of: selection) { _, new in proxy.scrollTo(new, anchor: .center) }
            }
            .frame(maxHeight: 420)
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .frame(maxWidth: 620)
        .padding(.horizontal, 16)
        .shadow(radius: 30, y: 10)
        .onAppear { focused = true }
        .task { await scene.openPalette() }
    }

    private func move(_ by: Int, _ count: Int) {
        guard count > 0 else { return }
        selection = (selection + by + count) % count
    }

    private func back() {
        if !(scene.palette?.query ?? "").isEmpty { scene.palette?.query = "" }
        else if !(scene.palette?.path.isEmpty ?? true) { scene.palette?.path.removeLast() }
        else { scene.palette = nil }
        selection = 0
    }

    private func activate(_ rows: [(node: PaletteNode, trail: [PaletteNode])]) {
        guard rows.indices.contains(selection) else { return }
        let row = rows[selection]
        if row.node.isCategory {
            scene.palette?.path += row.trail.map(\.key) + [row.node.key]
            scene.palette?.query = ""
            selection = 0
        } else if let action = row.node.action {
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

    var body: some View {
        HStack(spacing: 10) {
            if let agent = node.agent { AgentMark(agent: agent, size: 20) }
            else { Image(systemName: node.icon ?? (node.isCategory ? "folder" : "command")).frame(width: 20).foregroundStyle(theme.muted) }
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    ForEach(trail) { t in Text(t.label + " ›").foregroundStyle(theme.faint) }
                    Text(node.label)
                }
                .font(.callout)
                if let detail = node.detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(theme.muted).lineLimit(1) }
            }
            Spacer()
            if node.isCategory {
                Text("\(node.leafCount)").font(.caption).foregroundStyle(theme.faint)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(theme.faint)
            } else if case .command(let id) = node.action, let chord = bindings.chords(id).first {
                Keycaps(chord)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(selected ? theme.accentStrong.opacity(0.18) : .clear)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? .isSelected : [])
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

/// Every command and its binding (⌘/), searchable; edits live in Settings → Shortcuts.
struct ShortcutsView: View {
    let scene: SceneModel
    @State private var query = ""
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            List {
                ForEach([CommandGroup.navigate, .session, .workspace], id: \.self) { group in
                    let commands = CommandCatalog.all.filter { $0.group == group && (query.isEmpty || $0.label.localizedCaseInsensitiveContains(query)) && !scene.app.keyBindings.chords($0.id).isEmpty }
                    if !commands.isEmpty {
                        Section(group.rawValue) {
                            ForEach(commands) { c in
                                HStack {
                                    Text(c.label).foregroundStyle(scene.isAvailable(c.id) ? theme.text : theme.faint)
                                    Spacer()
                                    Keycaps(scene.app.keyBindings.chords(c.id)[0])
                                }
                            }
                        }
                    }
                }
            }
            .searchable(text: $query)
            .navigationTitle("Keyboard shortcuts")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { scene.showingShortcuts = false } }
                ToolbarItem(placement: .primaryAction) { Button("Edit…") { scene.showingShortcuts = false; scene.sheet = .settings(SettingsSection.shortcuts.rawValue) } }
            }
        }
    }
}

/// Held modifiers show what one more key does (which-key), after a short pause.
struct WhichKeyHUD: View {
    let rows: [CommandMatcher.WhichKeyRow]
    @Environment(\.theme) private var theme

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 200), spacing: 12)], alignment: .leading, spacing: 6) {
            ForEach(rows, id: \.id.rawValue) { row in
                HStack(spacing: 8) {
                    Text(row.key).font(.callout.monospaced().weight(.semibold)).frame(minWidth: 24).padding(.horizontal, 6).padding(.vertical, 2).background(theme.raised, in: RoundedRectangle(cornerRadius: 5))
                    Text(row.label).font(.callout).lineLimit(1)
                }
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .frame(maxWidth: 760)
        .padding(16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Available shortcuts")
    }
}

/// Pane and resize modes: which keys do what until Escape.
struct SubmapHUD: View {
    let mode: WorkspaceModel.Submap
    @Environment(\.theme) private var theme

    var body: some View {
        let keys: [(String, String)] = mode == .pane
            ? [("hjkl / arrows", "Focus"), ("⇧ hjkl", "Move"), ("v", "Split right"), ("s", "Split below"), ("x", "Close"), ("p", "Replace"), ("f", "Zoom"), ("t", "Flip"), ("o", "Open beside"), ("n", "New"), ("r", "Resize"), ("1–9", "Workspace"), ("esc", "Done")]
            : [("hjkl / arrows", "Resize"), ("⇧", "Bigger steps"), ("esc", "Done")]
        HStack(spacing: 14) {
            Text(mode == .pane ? "PANE" : "RESIZE").font(.caption.weight(.heavy)).foregroundStyle(theme.brand)
            ForEach(keys, id: \.0) { k in
                HStack(spacing: 4) {
                    Text(k.0).font(.caption.monospaced().weight(.semibold))
                    Text(k.1).font(.caption).foregroundStyle(theme.muted)
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: Capsule())
        .padding(12)
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
