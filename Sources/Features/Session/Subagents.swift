import SwiftUI

// Subagents: the agents a session's agent spawned, shown as sessions of their own under it
// (ah's docs/spec/16-subagents.md, docs/native/SUBAGENTS.md). The chip above the box says
// what's there and what's working; its browser lists the tree; a child opens in the same
// session screen as any session, read-only, with its way back to its parent.

/// The Subagents chip, one of the chips over the box (`SettingChipLabel`): "Subagents",
/// "3 active", "4 done". Counts every level below the session.
struct SubagentsChip: View {
    let session: SessionModel
    let scene: SceneModel
    /// Where it is on screen: the iPad's popover points at the chip that was tapped, not at
    /// another pane's, or a folded one's last place.
    @State private var frame: CGRect = .zero

    var body: some View {
        let label = SubagentChip.label(session.subagentSummary)
        Button {
            Haptics.selection()
            scene.subagentsAnchor = frame
            scene.showSubagents(session.key)
        } label: {
            // "Subagents 3 active", its name quiet beside the count, as a setting chip reads; with none yet, the name alone.
            SettingChipLabel(name: "Subagents", symbol: SubagentGlyph.symbol, value: label.value ?? "Subagents", spoken: String(label.accessibility.dropFirst("Subagents, ".count)), labelled: label.value != nil, unset: label.tone == .none) {
                // Working now: a still dot in the working color, as a row's status is. Nothing beats.
                if label.tone == .active { SubagentActiveDot().offset(x: 3, y: -2) }
            }
        }
        .buttonStyle(.plain)
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
        .accessibilityIdentifier("subagents-chip")
        .accessibilityHint("Shows the agents it spawned")
        // The count changes in place; the chip doesn't move or resize with each change.
        .animation(nil, value: label)
    }
}

enum SubagentGlyph {
    static let symbol = "point.3.filled.connected.trianglepath.dotted"
}

private struct SubagentActiveDot: View {
    @Environment(\.theme) private var theme
    var body: some View {
        Circle().fill(theme.run).frame(width: 6, height: 6).accessibilityHidden(true)
    }
}

/// The chip on its own over the box while the settings are folded away, so a session with
/// subagents says so at a glance. Chip-sized: the transcript around it still takes touches.
struct SubagentsChipFloat: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    static func shows(_ session: SessionModel) -> Bool {
        session.acceptsInput && session.hasSubagentsEntry && session.subagentSummary.total > 0
            && !session.composer.trayOpen && session.composer.suggestions.isEmpty && !DictationCard.shows(session.dictation, in: session.composer)
    }

    var body: some View {
        let shows = Self.shows(session)
        ZStack {
            if shows {
                SubagentsChip(session: session, scene: scene)
                    .padding(.vertical, 4)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.92, anchor: .bottomLeading)))
            }
        }
        .animation(ComposerFloat.motion(opening: shows, reduceMotion: reduceMotion), value: shows)
    }
}

// MARK: The browser

/// The tree of a session's subagents: each one's name, state and what it's doing, nested under
/// the one that spawned it. A row opens the child where sessions open.
struct SubagentsSheet: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        let model = session.subagents
        NavigationStack {
            content(model)
                .navigationTitle("Subagents")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    // The window's one modal is closed through its state, as every sheet is.
                    ToolbarItem(placement: .confirmationAction) { Button("Done") { scene.sheet = nil }.keyboardShortcut(.cancelAction) }
                }
                .safeAreaInset(edge: .top, spacing: 0) { header(model) }
        }
        .task { await model.load() }
        .tint(theme.accent)
    }

    @ViewBuilder
    private func content(_ model: SubagentsModel) -> some View {
        let rows = model.rows
        switch model.phase {
        case .idle, .loading where model.tree == nil:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unsupported:
            ContentUnavailableView("No Subagents Here", systemImage: SubagentGlyph.symbol, description: Text("This agent’s host can’t read the agents it spawns."))
        case .failed(let message) where model.tree == nil:
            ContentUnavailableView {
                Label("Couldn’t Load Subagents", systemImage: "exclamationmark.triangle")
            } description: {
                Text(message)
            } actions: {
                Button("Try Again") { Task { await model.load() } }
            }
        default:
            if rows.isEmpty {
                ContentUnavailableView("No Subagents Yet", systemImage: SubagentGlyph.symbol, description: Text(emptyWords))
            } else {
                List {
                    Section {
                        ForEach(rows) { row in
                            SubagentRowView(row: row, offline: offline, model: model, open: { open(row.node) }, beside: scene.narrow ? nil : { beside(row.node) })
                        }
                    } footer: {
                        if case .failed(let message) = model.phase { Text("Not updated: \(message)") }
                    }
                }
                .listStyle(.insetGrouped)
                .accessibilityIdentifier("subagents-list")
            }
        }
    }

    /// The session they're under, and how many are working: what the chip said, in full.
    @ViewBuilder
    private func header(_ model: SubagentsModel) -> some View {
        let summary = SubagentTree.summary(of: model.tree?.selfRef, in: model.tree?.nodes ?? [])
        if summary.total > 0 {
            HStack(spacing: 8) {
                Text(session.title).lineLimit(1).foregroundStyle(theme.text2)
                Spacer(minLength: 8)
                Text(SubagentChip.label(summary).value ?? "")
                    .monospacedDigit()
                    .foregroundStyle(summary.active > 0 ? theme.run : theme.muted)
                if let note = offline { Text("· \(note)").foregroundStyle(theme.limited) }
            }
            .font(.ah(.footnote))
            .padding(.horizontal, 20)
            .padding(.vertical, 8)
            .accessibilityElement(children: .combine)
        }
    }

    /// The host is out of reach: what's shown is what it last said, not now.
    private var offline: String? { scene.connectionNote(session.key) }

    private var emptyWords: String {
        let agent = session.launch.preset?.name ?? session.history?.dto.harness.capitalized ?? "the agent"
        return session.isSubagent ? "It hasn’t spawned agents of its own." : "When \(agent) hands work to subagents, they show here, and stay once they’re done."
    }

    private func open(_ node: SubagentNodeDTO) {
        scene.openSubagent(node, from: session)
    }

    private func beside(_ node: SubagentNodeDTO) {
        scene.openSubagentBeside(node, from: session)
    }
}

/// One subagent in the browser: indented under its parent, its name and state, what it's
/// doing (or did last), and for how long.
private struct SubagentRowView: View {
    let row: SubagentTree.Row
    let offline: String?
    let model: SubagentsModel
    let open: () -> Void
    let beside: (() -> Void)?
    @Environment(\.theme) private var theme
    @ScaledMetric(relativeTo: .body) private var indent: CGFloat = 18

    var body: some View {
        let node = row.node
        HStack(alignment: .top, spacing: 8) {
            if row.children > 0 {
                Button {
                    if row.expanded { model.collapsed.insert(node.ref) } else { model.collapsed.remove(node.ref) }
                } label: {
                    Image(systemName: "chevron.right")
                        .font(.ah(.caption).weight(.semibold))
                        .rotationEffect(.degrees(row.expanded ? 90 : 0))
                        .foregroundStyle(theme.muted)
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(row.expanded ? "Collapse \(node.name)" : "Expand \(node.name)")
            } else {
                Color.clear.frame(width: 22, height: 22)
            }
            Button(action: open) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        SubagentStateBadge(state: node.state, stale: offline != nil)
                        Text(node.name).font(.ah(.body).weight(.medium)).foregroundStyle(theme.text).lineLimit(2)
                        Spacer(minLength: 4)
                        TimelineView(.periodic(from: .now, by: node.state.isActive ? 1 : 3600)) { context in
                            if let time = SubagentChip.duration(node, now: context.date) {
                                Text(time).font(.ah(.caption)).monospacedDigit().foregroundStyle(theme.faint)
                            }
                        }
                    }
                    if let activity = node.activity {
                        Text(activity).font(.ah(.footnote)).foregroundStyle(theme.muted).lineLimit(2)
                    }
                    HStack(spacing: 6) {
                        Text(SubagentChip.word(node.state)).foregroundStyle(stateColor(node.state))
                        if let role = node.role { Text("· \(role)").foregroundStyle(theme.faint) }
                        if node.background { Text("· background").foregroundStyle(theme.faint) }
                        if row.children > 0 { Text("· \(row.children) nested\(row.activeBelow > 0 ? ", \(row.activeBelow) active" : "")").foregroundStyle(theme.faint) }
                    }
                    .font(.ah(.caption))
                    .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(spoken)
            .accessibilityHint("Opens its conversation")
            .accessibilityAddTraits(.isButton)
        }
        .padding(.leading, CGFloat(min(row.level, 6)) * indent)
        .accessibilityIdentifier("subagent:\(node.name)")
        .contextMenu {
            Button("Open", systemImage: "arrow.up.right", action: open)
            if let beside { Button("Open Beside This One", systemImage: "rectangle.split.2x1", action: beside) }
        }
    }

    private var spoken: String {
        let node = row.node
        var parts = [node.name, SubagentChip.word(node.state)]
        if row.level > 0 { parts.append("nested, level \(row.level + 1)") }
        if let activity = node.activity { parts.append(activity) }
        if row.children > 0 { parts.append("\(row.children) nested") }
        if offline != nil { parts.append("as last known") }
        return parts.joined(separator: ", ")
    }

    private func stateColor(_ state: SubagentNodeDTO.State) -> Color {
        switch state {
        case .running, .waiting: return theme.run
        case .completed: return theme.done
        case .failed: return theme.danger
        case .canceled, .unknown: return theme.muted
        }
    }
}

/// A subagent's state as a glyph in its color: working, waiting on its own, done, failed,
/// canceled, or stopped without a word. Still: nothing pulses in a list of many.
struct SubagentStateBadge: View {
    let state: SubagentNodeDTO.State
    /// The host is out of reach: a running one is only "last known running".
    var stale = false
    @Environment(\.theme) private var theme

    var body: some View {
        Image(systemName: symbol)
            .font(.ah(.footnote).weight(.semibold))
            .foregroundStyle(stale && state.isActive ? theme.muted : color)
            .frame(width: 16)
            .accessibilityHidden(true)
    }

    private var symbol: String {
        switch state {
        case .running: return "circle.fill"
        case .waiting: return "hourglass"
        case .completed: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .canceled: return "stop.circle"
        case .unknown: return "circle.dashed"
        }
    }

    private var color: Color {
        switch state {
        case .running, .waiting: return theme.run
        case .completed: return theme.done
        case .failed: return theme.danger
        case .canceled, .unknown: return theme.muted
        }
    }
}

// MARK: A child's own screen

/// Where a subagent's box would be: whose it is, how it's doing, and the way up. Read-only
/// says so in words; there's no box that can't send.
struct SubagentFooter: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme
    @State private var continuing = false

    var body: some View {
        let node = session.subagentNode
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let node { SubagentStateBadge(state: node.state, stale: scene.connectionNote(session.key) != nil) }
                VStack(alignment: .leading, spacing: 1) {
                    Text(stateLine(node)).font(.ah(.footnote).weight(.medium)).foregroundStyle(theme.text)
                    Text(readOnlyLine(node)).font(.ah(.caption)).foregroundStyle(theme.muted)
                }
                .accessibilityElement(children: .combine)
                Spacer(minLength: 8)
                if session.subagents.summary.total > 0 { SubagentsChip(session: session, scene: scene) }
            }
            HStack(spacing: 8) {
                Button {
                    scene.openSubagentParent(of: session)
                } label: {
                    Label(parentTitle.map { "Back to \($0)" } ?? "Back to Parent", systemImage: "arrow.up.left")
                        .lineLimit(1)
                }
                .buttonStyle(.glass)
                .accessibilityIdentifier("subagent-parent")
                .disabled(scene.subagentParentKey(of: session) == nil)
                if node?.capabilities.continue == true {
                    Button {
                        continuing = true
                        Task {
                            if let key = await session.resume() { scene.open(key) }
                            continuing = false
                        }
                    } label: {
                        Label("Continue as Own Session", systemImage: "play")
                    }
                    .buttonStyle(.glass)
                    .disabled(continuing)
                    .accessibilityHint("Starts it as a session of its own, carrying on its conversation")
                }
            }
            .font(.ah(.footnote).weight(.medium))
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("subagent-footer")
    }

    private var parentTitle: String? {
        guard let tree = session.subagents.tree, let node = session.subagentNode else { return nil }
        if node.parentRef == tree.root.ref { return tree.root.title }
        return session.subagents.node(node.parentRef)?.name
    }

    private func stateLine(_ node: SubagentNodeDTO?) -> String {
        guard let node else { return session.subagents.phase == .loading ? "Subagent" : "Subagent · not found on its host" }
        var parts = [SubagentChip.word(node.state)]
        if let role = node.role { parts.append(role) }
        if let time = SubagentChip.duration(node, now: .now) { parts.append(time) }
        return parts.joined(separator: " · ")
    }

    private func readOnlyLine(_ node: SubagentNodeDTO?) -> String {
        if node?.capabilities.continue == true { return "Its parent agent is done with it. It can go on as a session of its own." }
        return "Read only: its parent agent runs it. To steer it, message the parent."
    }
}

/// A subagent's place in the header: whose it is, one tap back up.
struct SubagentCaption: View {
    let session: SessionModel
    let scene: SceneModel
    @Environment(\.theme) private var theme

    var body: some View {
        if let tree = session.subagents.tree, let node = session.subagentNode {
            let ancestors = SubagentTree.ancestors(of: node.ref, in: tree.nodes)
            HStack(spacing: 6) {
                SubagentStateBadge(state: node.state, stale: scene.connectionNote(session.key) != nil)
                Text(SubagentChip.word(node.state)).foregroundStyle(theme.muted)
                Button {
                    scene.openSubagentParent(of: session)
                } label: {
                    Label("Subagent of \(ancestors.last?.name ?? tree.root.title)", systemImage: "arrow.up.left").lineLimit(1)
                }
                .buttonStyle(.borderless)
                .foregroundStyle(theme.faint)
                .accessibilityHint("Opens the agent that spawned it")
                if let role = node.role { Text(role).foregroundStyle(theme.faint).lineLimit(1) }
            }
            .font(.ah(.caption))
        }
    }
}
