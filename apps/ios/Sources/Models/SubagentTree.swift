import Foundation

/// The subagents browser's rows, the chip's words and a child's way back up, worked out from
/// the host's tree (`SubagentTreeDTO`) and nothing else: pure, so `swift test` covers it.
enum SubagentTree {
    struct Row: Identifiable, Equatable, Sendable {
        let node: SubagentNodeDTO
        /// 0 for a child of the tree's top as shown, 1 for its child…
        let level: Int
        /// Its own children (direct), and how many of all below it are active.
        let children: Int
        let activeBelow: Int
        let expanded: Bool
        var id: String { node.ref }
    }

    /// The nodes under `top` (a child's ref, or nil for the whole tree), as rows: each one's
    /// children follow it while it's expanded. The host's order is kept (parents first,
    /// siblings as spawned).
    static func rows(_ nodes: [SubagentNodeDTO], under top: String? = nil, collapsed: Set<String> = []) -> [Row] {
        let kids = childrenByParent(nodes)
        let active = activeBelow(nodes)
        var out: [Row] = []
        var seen = Set<String>()
        func walk(_ parent: String, _ level: Int) {
            for n in kids[parent] ?? [] where seen.insert(n.ref).inserted {
                let open = !collapsed.contains(n.ref)
                out.append(Row(node: n, level: level, children: kids[n.ref]?.count ?? 0, activeBelow: active[n.ref] ?? 0, expanded: open))
                if open { walk(n.ref, level + 1) }
            }
        }
        if let top { walk(top, 0) } else { for root in roots(nodes) { walk(root, 0) } }
        return out
    }

    /// The refs children hang from that aren't children themselves: the tree's root (and,
    /// from an odd host, any parent it didn't send).
    private static func roots(_ nodes: [SubagentNodeDTO]) -> [String] {
        let refs = Set(nodes.map(\.ref))
        var out: [String] = []
        for n in nodes where !refs.contains(n.parentRef) && !out.contains(n.parentRef) { out.append(n.parentRef) }
        return out
    }

    static func childrenByParent(_ nodes: [SubagentNodeDTO]) -> [String: [SubagentNodeDTO]] {
        var kids: [String: [SubagentNodeDTO]] = [:]
        for n in nodes where n.parentRef != n.ref { kids[n.parentRef, default: []].append(n) }
        return kids
    }

    /// How many active nodes are below each one.
    static func activeBelow(_ nodes: [SubagentNodeDTO]) -> [String: Int] {
        let parent = Dictionary(nodes.map { ($0.ref, $0.parentRef) }, uniquingKeysWith: { a, _ in a })
        var counts: [String: Int] = [:]
        for n in nodes where n.state.isActive {
            var seen: Set<String> = [n.ref]
            var p = parent[n.ref]
            while let ref = p, seen.insert(ref).inserted {
                counts[ref, default: 0] += 1
                p = parent[ref]
            }
        }
        return counts
    }

    /// Every node below `ref` (or all of them, for nil).
    static func descendants(of ref: String?, in nodes: [SubagentNodeDTO]) -> [SubagentNodeDTO] {
        guard let ref else { return nodes }
        let kids = childrenByParent(nodes)
        var out: [SubagentNodeDTO] = []
        var queue = kids[ref] ?? []
        var seen: Set<String> = [ref]
        while !queue.isEmpty {
            let n = queue.removeFirst()
            guard seen.insert(n.ref).inserted else { continue }
            out.append(n)
            queue += kids[n.ref] ?? []
        }
        return out
    }

    /// A summary as a row carries one, of the nodes below `ref` (nil: all).
    static func summary(of ref: String?, in nodes: [SubagentNodeDTO]) -> SubagentSummaryDTO {
        let below = descendants(of: ref, in: nodes)
        return SubagentSummaryDTO(
            total: below.count,
            active: below.filter { $0.state.isActive }.count,
            completed: below.filter { $0.state == .completed }.count,
            failed: below.filter { $0.state == .failed || $0.state == .canceled }.count,
            rev: "")
    }

    /// The nodes from the top of the tree down to `ref`'s parent (not the root conversation itself).
    static func ancestors(of ref: String, in nodes: [SubagentNodeDTO]) -> [SubagentNodeDTO] {
        let byRef = Dictionary(nodes.map { ($0.ref, $0) }, uniquingKeysWith: { a, _ in a })
        var out: [SubagentNodeDTO] = []
        var seen: Set<String> = [ref]
        var p = byRef[ref]?.parentRef
        while let r = p, let n = byRef[r], seen.insert(r).inserted {
            out.insert(n, at: 0)
            p = n.parentRef
        }
        return out
    }

    /// The key a child's parent opens by: another child's, or the root conversation's (its live
    /// window while it runs, else its ref, which history and the feed take).
    static func parentKey(of node: SubagentNodeDTO, root: SubagentTreeDTO.Root, host: String?) -> String {
        if node.parentRef != root.ref { return SubagentKey(host: host, ref: node.parentRef).description }
        return rootKey(root, host: host)
    }

    /// The root conversation's key: its live window while it runs, else its history entry's.
    static func rootKey(_ root: SubagentTreeDTO.Root, host: String?) -> String {
        let ref = root.uid ?? root.ref
        return host.map { "\($0)/\(ref)" } ?? ref
    }
}

/// The Subagents chip's words: what's there, and what's working now. Counts cover every
/// level below the session (nested children too), as its browser shows them.
enum SubagentChip {
    enum Tone: Equatable, Sendable { case none, active, done, failed }

    struct Label: Equatable, Sendable {
        /// After "Subagents": "3 active", "4 done", "2 done · 1 failed"; nil with none yet.
        let value: String?
        let tone: Tone
        /// What VoiceOver reads: "Subagents, 3 active of 5".
        let accessibility: String
    }

    static func label(_ s: SubagentSummaryDTO) -> Label {
        guard s.total > 0 else { return Label(value: nil, tone: .none, accessibility: "Subagents, none yet") }
        if s.active > 0 {
            return Label(value: "\(s.active) active", tone: .active, accessibility: "Subagents, \(s.active) active of \(s.total)")
        }
        let done = s.completed
        let others = s.total - s.completed - s.failed
        var parts: [String] = []
        if done > 0 { parts.append("\(done) done") }
        if s.failed > 0 { parts.append("\(s.failed) failed") }
        // Neither finished nor running as far as the host can tell (their parent ended): counted, not called done.
        if parts.isEmpty || others > 0 { parts.append(others > 0 && !parts.isEmpty ? "\(others) stopped" : "\(s.total)") }
        let value = parts.joined(separator: " · ")
        return Label(value: value, tone: s.failed > 0 ? .failed : .done, accessibility: "Subagents, \(value.replacingOccurrences(of: " · ", with: ", "))")
    }

    /// A line of what it's doing, as words: an agent's last message often opens with Markdown
    /// ("## Report: **Sources read:** `…`"), which a one-line row shows as marks.
    static func plain(_ text: String) -> String {
        var t = text.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "").replacingOccurrences(of: "`", with: "")
        while let r = t.range(of: #"(^|\s)#{1,6}\s"#, options: .regularExpression) { t.replaceSubrange(r, with: t[r].first?.isWhitespace == true ? " " : "") }
        return t.trimmingCharacters(in: .whitespaces)
    }

    /// A state in words, for a row and VoiceOver.
    static func word(_ state: SubagentNodeDTO.State) -> String {
        switch state {
        case .running: return "Running"
        case .waiting: return "Waiting on its subagents"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .canceled: return "Canceled"
        case .unknown: return "Stopped"
        }
    }

    /// How long it ran (or has run so far), "42s", "3m", "1h 5m"; nil without a start.
    static func duration(_ node: SubagentNodeDTO, now: Date) -> String? {
        guard node.startedAt > 0 else { return nil }
        let end = node.endedAt ?? (node.state.isActive ? now.timeIntervalSince1970 : node.updatedAt)
        let s = max(0, Int(end - node.startedAt))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m" }
        return "\(s / 3600)h \(s % 3600 / 60)m"
    }
}
