import SwiftUI

/// A layer's architecture (`ArchitectureOverview`): what it touches, a before/after picture of
/// the dependencies it changes, and what it adds, uses, reaches and tests, each claim with the
/// lines it stands on. Tapping a line goes to it in the diff below. Read from the diff at the
/// head the page shows; no model writes any of it, and nothing here marks anything reviewed.
struct ArchitectureSection: View {
    let overview: ArchitectureOverview
    let stale: Bool
    let currentHead: String?
    let reload: () -> Void
    let show: (ArchitectureOverview.Evidence) -> Void
    @State private var after = true
    @State private var picked: String?
    @State private var zoom: CGFloat = 1
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Read from this layer’s diff at \(short(overview.head)): names, imports and lines, not a model’s summary. “Likely” marks a reading worth checking.")
                .font(.ah(.caption)).foregroundStyle(theme.faint)
            if stale {
                Banner(text: "The layer moved on to \(short(currentHead)) since this was read at \(short(overview.head)).", tone: .warning, action: ("Read Again", reload))
            }
            components
            if !overview.edges.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    HStack {
                        Text("Dependencies").font(.ah(.subheadline).weight(.semibold))
                        Spacer()
                        Button { zoom = max(0.5, zoom - 0.25) } label: { Image(systemName: "minus.magnifyingglass") }
                            .keyboardShortcut("-", modifiers: .command)
                            .accessibilityLabel("Zoom out")
                        Button { zoom = min(2, zoom + 0.25) } label: { Image(systemName: "plus.magnifyingglass") }
                            .keyboardShortcut("=", modifiers: .command)
                            .accessibilityLabel("Zoom in")
                        Picker("Show", selection: $after) {
                            Text("Before").tag(false)
                            Text("After").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .frame(maxWidth: 160)
                    }
                    .buttonStyle(.borderless)
                    DependencyDiagram(overview: overview, after: after, picked: $picked, zoom: $zoom)
                    legend
                }
            }
            claims
            if overview.unread > 0 {
                Text("\(overview.unread) file\(overview.unread == 1 ? "" : "s") the diff doesn’t show line by line (binary or too large) aren’t read here.")
                    .font(.ah(.caption)).foregroundStyle(theme.muted)
            }
        }
    }

    private func short(_ sha: String?) -> String { sha.map { String($0.prefix(7)) } ?? "—" }

    // MARK: What it touches

    private var components: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(overview.components) { c in
                    HStack(spacing: 6) {
                        Image(systemName: icon(c.role)).foregroundStyle(theme.muted)
                        Text(c.id).font(.ahMono(.caption)).foregroundStyle(theme.text)
                        Text("+\(c.additions) −\(c.deletions)").font(.ah(.caption2).monospacedDigit()).foregroundStyle(theme.faint)
                    }
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(theme.tile, in: Capsule())
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("\(c.id), \(c.role.rawValue), \(c.files.count) file\(c.files.count == 1 ? "" : "s"), \(c.additions) added, \(c.deletions) removed")
                }
            }
        }
        .scrollClipDisabled()
    }

    private func icon(_ role: ArchitectureOverview.Component.Role) -> String {
        switch role {
        case .source: return "chevron.left.forwardslash.chevron.right"
        case .tests: return "checkmark.seal"
        case .docs: return "doc.text"
        case .config: return "gearshape"
        case .migrations: return "cylinder.split.1x2"
        case .assets: return "photo"
        }
    }

    private var legend: some View {
        HStack(spacing: 14) {
            legendItem(color: theme.done, dashed: false, "Added")
            legendItem(color: theme.danger, dashed: true, "Removed")
            legendItem(color: theme.faint, dashed: false, "Unchanged")
        }
        .font(.ah(.caption2))
        .foregroundStyle(theme.muted)
        .accessibilityHidden(true)
    }

    private func legendItem(color: Color, dashed: Bool, _ title: String) -> some View {
        HStack(spacing: 5) {
            Path { p in p.move(to: .init(x: 0, y: 4)); p.addLine(to: .init(x: 18, y: 4)) }
                .stroke(color, style: StrokeStyle(lineWidth: 2, dash: dashed ? [4, 3] : []))
                .frame(width: 18, height: 8)
            Text(title)
        }
    }

    // MARK: What it does

    @ViewBuilder
    private var claims: some View {
        let groups: [(String, String, [ArchitectureOverview.Claim])] = [
            ("Entry points", "door.left.hand.open", overview.claims(.entryPoint)),
            ("Interfaces", "puzzlepiece.extension", overview.claims(.interfaceAdded, .interfaceRemoved)),
            ("Across files", "arrow.left.arrow.right", overview.claims(.uses, .staleUse)),
            ("Reaches out", "network", overview.claims(.boundary)),
            ("Tests", "checkmark.seal", overview.claims(.testsChanged, .untested)),
        ]
        let shown = groups.filter { !$0.2.isEmpty }
        if shown.isEmpty {
            Text("Nothing in this diff changes how its parts depend on each other.").font(.ah(.callout)).foregroundStyle(theme.muted)
        }
        ForEach(shown, id: \.0) { title, symbol, items in
            VStack(alignment: .leading, spacing: 8) {
                Label(title, systemImage: symbol).font(.ah(.subheadline).weight(.semibold))
                ForEach(items.filter { picked == nil || $0.evidence.contains { $0.path == picked } }) { claim in
                    ClaimRow(claim: claim, show: show)
                }
            }
        }
        if picked != nil {
            Button("Show every file", systemImage: "line.3.horizontal.decrease.circle") { picked = nil }
                .font(.ah(.caption)).buttonStyle(.borderless)
        }
    }
}

private struct ClaimRow: View {
    let claim: ArchitectureOverview.Claim
    let show: (ArchitectureOverview.Evidence) -> Void
    @Environment(\.theme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(claim.text).font(.ah(.callout)).foregroundStyle(theme.text).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 4)
                Text(claim.certainty == .inDiff ? "In the diff" : "Likely")
                    .font(.ah(.caption2).weight(.semibold))
                    .foregroundStyle(claim.certainty == .inDiff ? theme.done : theme.limited)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background((claim.certainty == .inDiff ? theme.done : theme.limited).opacity(0.14), in: Capsule())
            }
            if !claim.evidence.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(claim.evidence, id: \.self) { e in
                            Button { show(e) } label: {
                                HStack(spacing: 4) {
                                    Text(e.side == .added ? "+" : e.side == .removed ? "−" : "·").foregroundStyle(e.side == .added ? theme.done : e.side == .removed ? theme.danger : theme.faint)
                                    Text(e.label)
                                }
                                .font(.ahMono(.caption2))
                                .padding(.horizontal, 8).padding(.vertical, 4)
                                .background(theme.tile, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                            }
                            .buttonStyle(.plain)
                            .hoverEffect(.highlight)
                            .accessibilityLabel("Go to \(e.label), \(e.side.rawValue): \(e.text)")
                        }
                    }
                }
                .scrollClipDisabled()
            }
        }
        .padding(10)
        .background(theme.sunken.opacity(0.5), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The dependencies the layer changes, as boxes and arrows: from what imports (left) to what
/// it uses (right). Pinch (or the header's buttons, ⌘±) to zoom; a box shows only its own claims below.
private struct DependencyDiagram: View {
    let overview: ArchitectureOverview
    let after: Bool
    @Binding var picked: String?
    @Binding var zoom: CGFloat
    @GestureState private var pinch: CGFloat = 1
    @Environment(\.theme) private var theme

    private static let size = CGSize(width: 150, height: 44)
    private static let gap = CGSize(width: 56, height: 16)

    var body: some View {
        let graph = overview.graph(after: after)
        let spots = DiagramLayout.layout(nodes: graph.nodes.map(\.id), edges: graph.edges.map { ($0.from, $0.to) })
        let columns = (spots.values.map(\.column).max() ?? 0) + 1
        let rows = (spots.values.map(\.row).max() ?? 0) + 1
        let canvas = CGSize(width: CGFloat(columns) * (Self.size.width + Self.gap.width) - Self.gap.width + 16, height: CGFloat(rows) * (Self.size.height + Self.gap.height) - Self.gap.height + 16)
        let scale = min(2, max(0.5, zoom * pinch))
        let frame = { (id: String) -> CGRect? in Self.rect(spots[id]) }
        ScrollView([.horizontal, .vertical], showsIndicators: true) {
            ZStack(alignment: .topLeading) {
                Canvas { context, _ in
                    for edge in graph.edges {
                        guard let a = frame(edge.from), let b = frame(edge.to) else { continue }
                        let start = CGPoint(x: a.maxX, y: a.midY)
                        let end = CGPoint(x: b.minX, y: b.midY)
                        var path = Path()
                        path.move(to: start)
                        path.addCurve(to: end, control1: CGPoint(x: start.x + 30, y: start.y), control2: CGPoint(x: end.x - 30, y: end.y))
                        let color: Color = edge.change == .added ? theme.done : edge.change == .removed ? theme.danger : theme.faint
                        let dim = picked != nil && edge.from != picked && edge.to != picked
                        context.stroke(path, with: .color(color.opacity(dim ? 0.25 : 1)), style: StrokeStyle(lineWidth: 2, lineCap: .round, dash: edge.change == .removed ? [5, 4] : []))
                        var head = Path()
                        head.move(to: end)
                        head.addLine(to: CGPoint(x: end.x - 7, y: end.y - 4))
                        head.addLine(to: CGPoint(x: end.x - 7, y: end.y + 4))
                        head.closeSubpath()
                        context.fill(head, with: .color(color.opacity(dim ? 0.25 : 1)))
                    }
                }
                .frame(width: canvas.width, height: canvas.height)
                ForEach(graph.nodes) { node in
                    if let rect = frame(node.id) {
                        Button { picked = picked == node.id ? nil : node.id } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(node.label).font(.ahMono(.caption).weight(node.changed ? .semibold : .regular)).lineLimit(1).truncationMode(.middle)
                                Text(node.changed ? node.component : "used, not changed").font(.ah(.caption2)).foregroundStyle(theme.faint).lineLimit(1)
                            }
                            .padding(.horizontal, 8)
                            .frame(width: rect.width, height: rect.height, alignment: .leading)
                            .background(node.changed ? theme.raised : theme.tile, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(picked == node.id ? theme.accent : node.changed ? theme.text.opacity(0.18) : .clear, lineWidth: picked == node.id ? 2 : 1))
                            .opacity(picked != nil && picked != node.id && !graph.edges.contains { ($0.from == picked && $0.to == node.id) || ($0.to == picked && $0.from == node.id) } ? 0.4 : 1)
                        }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .offset(x: rect.minX, y: rect.minY)
                    }
                }
            }
            .frame(width: canvas.width, height: canvas.height, alignment: .topLeading)
            .scaleEffect(scale, anchor: .topLeading)
            .frame(width: canvas.width * scale, height: canvas.height * scale, alignment: .topLeading)
        }
        .frame(maxHeight: min(360, canvas.height * scale + 24))
        .background(theme.sunken.opacity(0.4), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .gesture(MagnifyGesture().updating($pinch) { value, state, _ in state = value.magnification }.onEnded { value in zoom = min(2, max(0.5, zoom * value.magnification)) })
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Self.spoken(graph.edges, nodes: graph.nodes))
    }

    /// Where a laid-out node's box goes.
    static func rect(_ spot: DiagramLayout.Spot?) -> CGRect? {
        spot.map { CGRect(x: 8 + CGFloat($0.column) * (size.width + gap.width), y: 8 + CGFloat($0.row) * (size.height + gap.height), width: size.width, height: size.height) }
    }

    /// The picture in words: who now uses what, who stopped.
    static func spoken(_ edges: [ArchitectureOverview.Edge], nodes: [ArchitectureOverview.Node]) -> String {
        let names = Dictionary(nodes.map { ($0.id, $0.label) }, uniquingKeysWith: { a, _ in a })
        return "Dependencies: " + edges.map { e in "\(names[e.from] ?? e.from) \(e.change == .added ? "now uses" : e.change == .removed ? "no longer uses" : "uses") \(names[e.to] ?? e.to)" }.joined(separator: "; ")
    }
}
