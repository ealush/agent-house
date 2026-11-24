import Foundation

/// A live session on some host, as every list shows it: its wire data plus where it lives.
struct SessionRow: Equatable, Sendable, Identifiable {
    /// Selection/navigation key: uid on the hub, "host/uid" on a peer.
    let key: String
    /// The host's name (the hub's own hostname for local sessions).
    let host: String
    let isLocal: Bool
    let dto: SessionDTO

    var id: String { key }
    var uid: String { dto.uid }
    var title: String { dto.title }
    var word: StatusWord { StatusWord(dto) }

    /// When it last did something, in epoch seconds: its conversation's last message once read,
    /// else its terminal's last output (`web/sessionOrder.ts` `lastActive`). Tmux's output time
    /// also ticks when an agent's screen merely redraws (a resize, a reattach), which gives every
    /// agent the same time at once; a working one is drawing its work, so that time is its own.
    var lastActive: Double {
        guard dto.status != .busy, let at = dto.reply?.at, at > 0 else { return dto.activity }
        return at / 1000
    }
}

/// An ended or discovered conversation with its host.
struct HistoryRow: Equatable, Sendable, Identifiable {
    let host: String
    let isLocal: Bool
    let dto: HistoryItemDTO
    var id: String { isLocal ? dto.ref : "\(host)/\(dto.ref)" }
}

/// Sidebar and Inbox ordering (`apps/server/web/sessionOrder.ts`, `web/groupOrder.ts`).
enum SessionOrdering {
    /// Sparse key between two neighbors: midpoint, or ±100 at the ends.
    static func orderBetween(_ before: Double?, _ after: Double?) -> Double {
        switch (before, after) {
        case (nil, nil): return 100
        case (nil, let after?): return after - 100
        case (let before?, nil): return before + 100
        case (let before?, let after?): return after - before < 0.001 ? before + 0.5 : (before + after) / 2
        }
    }

    private static func created(_ row: SessionRow) -> Double {
        row.dto.createdAt > 0 ? row.dto.createdAt : .infinity
    }

    /// Inside one pin band: drag keys win; never-arranged rows slot in by opening time.
    private static func arrange(_ rows: [SessionRow]) -> [SessionRow] {
        let ordered = rows.filter { $0.dto.order != nil }.sorted {
            if $0.dto.order! != $1.dto.order! { return $0.dto.order! < $1.dto.order! }
            if created($0) != created($1) { return created($0) < created($1) }
            return $0.key < $1.key
        }
        let fresh = rows.filter { $0.dto.order == nil }.sorted {
            created($0) != created($1) ? created($0) < created($1) : $0.key < $1.key
        }
        var out = ordered
        for row in fresh {
            let at = created(row)
            let index = out.firstIndex { created($0) > at } ?? out.count
            out.insert(row, at: index)
        }
        return out
    }

    /// Pins at the top of their block; status and activity never move a row.
    static func sorted(_ rows: [SessionRow]) -> [SessionRow] {
        arrange(rows.filter { $0.dto.pinned }) + arrange(rows.filter { !$0.dto.pinned })
    }

    struct Section: Equatable, Sendable, Identifiable {
        let id: String
        let rows: [SessionRow]
    }

    /// Opening order, unless the user dragged the blocks (`applyGroupOrder`).
    static func applyGroupOrder(_ opening: [String], saved: [String]) -> [String] {
        guard !saved.isEmpty else { return opening }
        var rank: [String: Int] = [:]
        for (i, id) in saved.enumerated() where rank[id] == nil { rank[id] = i }
        let known = opening.filter { rank[$0] != nil }.sorted { rank[$0]! < rank[$1]! }
        return known + opening.filter { rank[$0] == nil }
    }

    /// Saved block order after a drag; closed blocks keep their place (`saveGroupMove`).
    static func saveGroupMove(visible: [String], saved: [String], from: String, to: String, after: Bool) -> [String] {
        guard from != to else { return saved }
        let current = applyGroupOrder(visible, saved: saved)
        guard current.contains(from), current.contains(to) else { return saved }
        var next = current.filter { $0 != from }
        var index = next.firstIndex(of: to)!
        if after { index += 1 }
        next.insert(from, at: index)
        guard !saved.isEmpty else { return next }
        let visibleSet = Set(next)
        var result = saved
        var slots = result.indices.filter { visibleSet.contains(result[$0]) }
        let known = Set(saved)
        for id in next where !known.contains(id) {
            result.append(id)
            slots.append(result.count - 1)
        }
        for (i, id) in next.enumerated() { result[slots[i]] = id }
        return result
    }

    /// One block per Space (explicit `space` or project), or per host when more than one machine is online.
    static func sections(_ rows: [SessionRow], multiHost: Bool, saved: [String] = []) -> [Section] {
        var groups: [String: [SessionRow]] = [:]
        var order: [String] = []
        for row in rows {
            let id = multiHost ? row.host : (row.dto.space ?? row.dto.project)
            if groups[id] == nil { order.append(id) }
            groups[id, default: []].append(row)
        }
        func opened(_ id: String) -> Double { groups[id]!.map(created).min() ?? .infinity }
        let byOpening = order.sorted { opened($0) != opened($1) ? opened($0) < opened($1) : $0 < $1 }
        return applyGroupOrder(byOpening, saved: saved).map { Section(id: $0, rows: sorted(groups[$0]!)) }
    }

    /// The one block of the latest-active list: it has no header.
    static let recentSection = ""

    /// Latest active first, as chats: pins on top, then by when each last printed something
    /// (opening time for one that hasn't).
    static func byRecency(_ rows: [SessionRow]) -> [SessionRow] {
        func latest(_ row: SessionRow) -> Double { max(row.lastActive, row.dto.createdAt) }
        func ordered(_ rows: [SessionRow]) -> [SessionRow] {
            rows.sorted { latest($0) != latest($1) ? latest($0) > latest($1) : $0.key < $1.key }
        }
        return ordered(rows.filter { $0.dto.pinned }) + ordered(rows.filter { !$0.dto.pinned })
    }

    /// The sidebar's blocks for `sort`: per project (or host), or one latest-active list.
    static func sections(_ rows: [SessionRow], multiHost: Bool, saved: [String] = [], sort: DevicePreferences.SessionSort) -> [Section] {
        switch sort {
        case .project: return sections(rows, multiHost: multiHost, saved: saved)
        case .recent: return rows.isEmpty ? [] : [Section(id: recentSection, rows: byRecency(rows))]
        }
    }

    /// Sessions in sidebar paint order, top to bottom (what Previous/Next session walks).
    static func sidebarOrder(_ rows: [SessionRow], multiHost: Bool, saved: [String] = []) -> [SessionRow] {
        sections(rows, multiHost: multiHost, saved: saved).flatMap(\.rows)
    }

    /// Order keys to persist so `dragged` lands before/after `target` (`movedSessionOrders`).
    static func movedOrders(_ list: [SessionRow], dragged: String, target: String, after: Bool) -> [(key: String, order: Double)] {
        guard dragged != target, let moving = list.first(where: { $0.key == dragged }), list.contains(where: { $0.key == target }) else { return [] }
        let rest = list.filter { $0.key != dragged }
        var index = rest.firstIndex { $0.key == target }!
        if after { index += 1 }
        var placed = rest
        placed.insert(moving, at: index)
        if list.allSatisfy({ $0.dto.order != nil }) {
            let before = index > 0 ? rest[index - 1].dto.order : nil
            let next = index < rest.count ? rest[index].dto.order : nil
            let order = orderBetween(before, next)
            return order == moving.dto.order ? [] : [(dragged, order)]
        }
        return placed.enumerated().compactMap { i, row in
            let order = Double((i + 1) * 100)
            return row.dto.order == order ? nil : (row.key, order)
        }
    }
}

/// The Inbox's status sections (`apps/server/web/Inbox.tsx`): needs you (plus review alerts),
/// working, then idle and done by most recent activity; pins on top of each.
struct InboxSections: Equatable, Sendable {
    let waiting: [SessionRow]
    let running: [SessionRow]
    let rest: [SessionRow]
    let reviews: [ReviewStateDTO.Alert]
    let summary: String

    init(rows: [SessionRow], reviews: [ReviewStateDTO.Alert], hostsOnline: Int, hostsTotal: Int, narrow: Bool) {
        // Pins on top of each section, as in every other list.
        func pinsFirst(_ rows: [SessionRow]) -> [SessionRow] { rows.filter(\.dto.pinned) + rows.filter { !$0.dto.pinned } }
        waiting = pinsFirst(rows.filter { $0.dto.status == .waiting })
        running = pinsFirst(rows.filter { $0.dto.status == .busy })
        rest = pinsFirst(rows.filter { $0.dto.status == .attention || $0.dto.status == .idle }.sorted { $0.lastActive > $1.lastActive })
        self.reviews = reviews
        let hosts = narrow && hostsTotal > 1 ? "\(hostsOnline) of \(hostsTotal) hosts online. " : ""
        summary = hosts + StatusWord.summary(rows.map(\.word))
    }

    /// The app icon's badge: sessions that need you.
    var badge: Int { waiting.count }

    /// Which session is in which section, in order: what a move between sections changes
    /// (the page animates it, rather than cutting).
    var order: [String] {
        waiting.map { "w \($0.key)" } + running.map { "r \($0.key)" } + rest.map { "i \($0.key)" }
    }
}
