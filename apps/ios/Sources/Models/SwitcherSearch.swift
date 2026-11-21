import Foundation
import Observation

/// The switcher's search (`apps/server/web/Switcher.tsx`): live sessions, then (once you type)
/// History, then matches inside conversations, with scoped tokens
/// `h:claude s:waiting p:vest m:opus in:chats role:user` and fuzzy free text.
enum SwitcherSearch {
    struct Query: Equatable, Sendable {
        var text = ""
        /// Agent, command or host.
        var host: String?
        var status: String?
        var project: String?
        var model: String?
        /// `transcripts` or `chats` (content search only).
        var scope: String?
        var role: String?

        /// Anything that should bring History in (the empty switcher is for jumping).
        var reachesHistory: Bool { !text.isEmpty || host != nil || project != nil || model != nil }
    }

    /// At most this many sessions and history rows together.
    static let limit = 14

    /// `parseQuery`: scoped tokens become filters (lowercased), the rest is the free text.
    static func parse(_ raw: String) -> Query {
        var query = Query()
        var words: [String] = []
        for token in raw.split(whereSeparator: \.isWhitespace) {
            let parts = token.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2, !parts[1].isEmpty {
                let value = parts[1].lowercased()
                switch parts[0] {
                case "h": query.host = value; continue
                case "s": query.status = value; continue
                case "p": query.project = value; continue
                case "m": query.model = value; continue
                case "in": query.scope = value; continue
                case "role": query.role = value; continue
                default: break
                }
            }
            words.append(String(token))
        }
        query.text = words.joined(separator: " ")
        return query
    }

    private static func has(_ value: String?, _ wanted: String?) -> Bool {
        guard let wanted else { return true }
        return (value ?? "").lowercased().contains(wanted)
    }

    /// Live sessions matching the filters, best text match first, then sidebar order.
    static func live(_ rows: [SessionRow], order: [String], _ query: Query) -> [SessionRow] {
        let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        return rows
            .filter { row in
                let d = row.dto
                return (has(d.agent ?? d.command, query.host) || has(row.host, query.host)) && has(d.status.rawValue, query.status)
                    && has(d.project, query.project) && has(d.model, query.model)
            }
            .compactMap { row -> (SessionRow, Double)? in
                let d = row.dto
                let score = CommandMatcher.fuzzy(query.text, "\(d.title) \(d.name) \(d.project) \(d.agent ?? d.command) \(d.session) \(d.branch ?? "")")
                return score > 0 ? (row, score) : nil
            }
            .sorted { a, b in a.1 != b.1 ? a.1 > b.1 : (rank[a.0.key] ?? 0) < (rank[b.0.key] ?? 0) }
            .map(\.0)
    }

    /// Ended and saved conversations, once the query reaches History; newest among equals.
    static func past(_ rows: [HistoryRow], _ query: Query) -> [HistoryRow] {
        guard query.reachesHistory else { return [] }
        if let status = query.status, !"ended saved".contains(status) { return [] }
        return rows
            .filter { row in
                (has(row.dto.harness, query.host) || has(row.host, query.host)) && has(row.dto.project, query.project) && has(row.dto.model, query.model)
            }
            .compactMap { row -> (HistoryRow, Double)? in
                let score = CommandMatcher.fuzzy(query.text, "\(row.dto.title) \(row.dto.project) \(row.dto.harness)")
                return score > 0 ? (row, score) : nil
            }
            .sorted { a, b in a.1 != b.1 ? a.1 > b.1 : a.0.dto.at > b.0.dto.at }
            .map(\.0)
    }

    /// Sessions then History, together capped at `limit`.
    static func results(live rows: [SessionRow], order: [String], history: [HistoryRow], _ query: Query) -> (live: [SessionRow], past: [HistoryRow]) {
        let live = Array(live(rows, order: order, query).prefix(limit))
        let past = Array(past(history, query).prefix(limit - live.count))
        return (live, past)
    }

    /// The content search to run, or nil while the text is under two characters.
    static func contentQuery(_ query: Query, limit: Int = 8) -> SearchQuery? {
        let text = query.text.trimmingCharacters(in: .whitespaces)
        guard text.count >= 2 else { return nil }
        let scope = query.scope == "transcripts" || query.scope == "chats" ? query.scope : nil
        return SearchQuery(q: text, scope: scope, role: query.role, project: query.project, host: query.host, model: query.model, limit: limit)
    }

    /// A server snippet's highlighted runs (between \u{1} and \u{2}), for drawing.
    static func highlights(_ snippet: String) -> [(text: String, marked: Bool)] {
        var out: [(String, Bool)] = []
        var buffer = ""
        var marked = false
        func flush() {
            if !buffer.isEmpty { out.append((buffer, marked)) }
            buffer = ""
        }
        // A snippet is the transcript's markdown: its emphasis and code marks would read as
        // literal asterisks and backticks around the very words that matched.
        for ch in plain(snippet) {
            if ch == "\u{1}" {
                flush()
                marked = true
            } else if ch == "\u{2}" {
                flush()
                marked = false
            } else {
                buffer.append(ch)
            }
        }
        flush()
        return out
    }

    /// Markdown's inline marks taken out of a snippet (`**bold**`, `__bold__`, `` `code` ``),
    /// the words left as they are.
    static func plain(_ snippet: String) -> String {
        snippet.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "__", with: "").replacingOccurrences(of: "`", with: "")
    }
}

/// The switcher's "In conversations" rows: one debounced search across hosts per query,
/// a newer query cancelling an older one.
@MainActor
@Observable
final class SwitcherContent {
    private(set) var hits: [SearchHit] = []
    /// "Search is off…", "Indexing…", or nil.
    private(set) var note: String?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private let search: @Sendable (SearchQuery) async throws -> SearchResponse

    init(search: @escaping @Sendable (SearchQuery) async throws -> SearchResponse) {
        self.search = search
    }

    func update(_ raw: String, debounce: Duration = .milliseconds(250)) {
        task?.cancel()
        guard let query = SwitcherSearch.contentQuery(SwitcherSearch.parse(raw)) else {
            hits = []
            note = nil
            return
        }
        let search = search
        task = Task { [weak self] in
            try? await Task.sleep(for: debounce)
            guard !Task.isCancelled else { return }
            let response = try? await search(query)
            guard !Task.isCancelled, let self else { return }
            // A search that didn't answer (a slow or dropped link) leaves the last results
            // up and says so, instead of emptying the list as if nothing matched.
            guard let response else {
                self.note = self.hits.isEmpty ? "Couldn’t search conversations just now." : "Couldn’t search just now; these are from before."
                return
            }
            self.hits = Array(response.results.prefix(8))
            self.note = !response.enabled ? "Content search is off (Settings → Search)." : response.building && response.results.isEmpty ? "Indexing conversations…" : nil
        }
    }

    /// Wait for the pending search (tests).
    func settle() async { await task?.value }
}
