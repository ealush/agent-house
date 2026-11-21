import SwiftUI

/// A conversation's family across agents (`GET /api/portable/conversations/:ref/lineage`):
/// every conversation it came from or went on to, in order, each with how it was carried
/// (resumed, forked, handed over as a record) and a way back to it.
struct LineageSheet: View {
    let scene: SceneModel
    let session: SessionModel
    @State private var lineage: PortableLineage?
    @State private var error: String?
    @Environment(\.theme) private var theme

    var body: some View {
        NavigationStack {
            Group {
                if let lineage {
                    List {
                        Section {
                            ForEach(Self.ordered(lineage)) { node in
                                row(node, in: lineage)
                            }
                        } footer: {
                            Text("Each conversation stays its own agent’s: a record handed over is a reconstruction, never the other agent’s memory.")
                        }
                    }
                } else if let error {
                    EmptyState(symbol: "exclamationmark.triangle", title: "Couldn’t Read Its Lineage", message: error)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("Conversation Lineage")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(role: .close) { scene.sheet = nil }.keyboardShortcut(.cancelAction).tint(.primary) }
                ToolbarItem(placement: .primaryAction) {
                    Button("Continue in Another Agent…", systemImage: CommandCatalog.icon("continue-in")) { scene.sheet = .continueIn(key: session.key, preset: nil) }
                }
            }
            .task {
                do { lineage = try await session.api.lineage(session.ref) } catch { self.error = APIError.wrap(error).message }
            }
        }
    }

    private func row(_ node: PortableLineage.Node, in lineage: PortableLineage) -> some View {
        let incoming = lineage.edges.first { $0.childId == node.conversationId }
        return Button { open(node) } label: {
            HStack(alignment: .top, spacing: 12) {
                AgentMark(agent: node.harness, size: 28)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(node.title).font(.ah(.body).weight(node.current ? .semibold : .regular)).foregroundStyle(theme.text).lineLimit(2)
                        if node.current { Text("This one").font(.ah(.caption2).weight(.semibold)).foregroundStyle(theme.accent) }
                    }
                    Text([node.harnessName ?? node.harness, node.host].compactMap { $0 }.joined(separator: " · ")).font(.ah(.caption)).foregroundStyle(theme.muted)
                    if let incoming {
                        Label(Self.how(incoming), systemImage: incoming.strategy == "context-handoff" ? "doc.text" : "arrow.triangle.branch")
                            .font(.ah(.caption)).foregroundStyle(theme.text2)
                    }
                }
                Spacer(minLength: 0)
                if openable(node) { Image(systemName: "chevron.right").font(.ah(.caption)).foregroundStyle(theme.faint) }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // The one you're in isn't dimmed; it just has nowhere to go.
        .disabled(!openable(node) && !node.current)
        .hoverEffect(.highlight)
    }

    /// How a conversation came from its parent, in a few words.
    static func how(_ edge: PortableLineage.Edge) -> String {
        let from = edge.fromName ?? "another agent"
        switch edge.strategy {
        case "native-resume": return "Resumed from \(from)"
        case "native-fork": return "Forked from \(from)"
        case "ancestor-fork": return "Back from \(from), with a record of what happened there"
        case "context-handoff": return "Handed over from \(from) as a record"
        case "transfer": return "Moved from another host"
        default: return "Continued from \(from)"
        }
    }

    /// Root first, then each conversation after the one it came from.
    static func ordered(_ lineage: PortableLineage) -> [PortableLineage.Node] {
        var out: [PortableLineage.Node] = []
        var seen = Set<String>()
        func visit(_ id: String) {
            guard !seen.contains(id), let node = lineage.nodes.first(where: { $0.conversationId == id }) else { return }
            seen.insert(id)
            out.append(node)
            for edge in lineage.edges.filter({ $0.parentId == id }).sorted(by: { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }) {
                if let child = edge.childId { visit(child) }
            }
        }
        if let root = lineage.root { visit(root) }
        for node in lineage.nodes where !seen.contains(node.conversationId) { visit(node.conversationId) }
        return out
    }

    private func key(for node: PortableLineage.Node) -> String? {
        let host = SessionKey(session.key)?.host
        guard let hub = scene.hub else { return nil }
        for uid in node.uids {
            let key = host.map { "\($0)/\(uid)" } ?? uid
            if hub.row(key) != nil || hub.history.contains(where: { $0.id == key || $0.dto.ref == uid }) { return key }
        }
        return nil
    }

    private func openable(_ node: PortableLineage.Node) -> Bool { !node.current && key(for: node) != nil }

    private func open(_ node: PortableLineage.Node) {
        guard let key = key(for: node) else { return }
        scene.sheet = nil
        scene.open(key)
    }
}
