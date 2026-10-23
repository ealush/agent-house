import Foundation

/// The GUI is a reducer over an ordered event log, not a terminal emulator
/// (`../ah/web/gui/reducer.ts`). Entries are keyed by `seq`: overlapping deliveries
/// dedupe, older pages merge in front, and a snapshot replaces the projection.
struct FeedState: Equatable, Sendable {
    enum Status: Equatable, Sendable { case connecting, live, unavailable }

    var status: Status = .connecting
    var reason: String? = nil
    var harness = ""
    var entries: [FeedEntry] = []
    /// Tool results by call id: a call is complete once its result is here.
    var results: [String: ToolResult] = [:]
    var hasOlder = false
    /// Bumped when the projection is rebuilt (new transcript, truncated file).
    var epoch = 0

    static let initial = FeedState()
}

enum FeedAction: Equatable, Sendable {
    case message(FeedMessage)
    case older(FeedPage)
    /// What this device kept of the conversation, shown until the stream catches up.
    case cached(harness: String, entries: [FeedEntry], hasOlder: Bool)
    case disconnected
}

enum FeedReducer {
    static func reduce(_ state: FeedState, _ action: FeedAction) -> FeedState {
        var s = state
        switch action {
        case .message(.snapshot(let reason, let harness, let entries, _, _, let hasOlder)):
            s.status = .live
            s.reason = nil
            s.harness = harness
            s.entries = merge([], entries)
            s.results = withResults([:], entries)
            s.hasOlder = hasOlder
            // A reconnect re-sends the same transcript from the top: not a rebuild.
            if reason != .initial { s.epoch += 1 }
        case .message(.append(let entries, _)):
            s.status = .live
            s.entries = merge(s.entries, entries)
            s.results = withResults(s.results, entries)
        case .older(let page):
            s.entries = merge(s.entries, page.entries)
            s.results = withResults(s.results, page.entries)
            s.hasOlder = page.hasOlder
        case .message(.unavailable(let reason)):
            s = FeedState(status: .unavailable, reason: reason, epoch: state.epoch + 1)
        case .cached(let harness, let entries, let hasOlder):
            // Only into an empty view that is still waiting: the stream always wins.
            guard s.entries.isEmpty, s.status == .connecting else { return s }
            s.harness = harness
            s.entries = merge([], entries)
            s.results = withResults([:], entries)
            s.hasOlder = hasOlder
        case .disconnected:
            if s.status == .live { s.status = .connecting }
        }
        return s
    }

    static func merge(_ a: [FeedEntry], _ b: [FeedEntry]) -> [FeedEntry] {
        guard !b.isEmpty else { return a }
        var bySeq = Dictionary(a.map { ($0.seq, $0) }, uniquingKeysWith: { _, last in last })
        for entry in b { bySeq[entry.seq] = entry }
        return bySeq.values.sorted { $0.seq < $1.seq }
    }

    static func withResults(_ results: [String: ToolResult], _ entries: [FeedEntry]) -> [String: ToolResult] {
        var out = results
        for entry in entries {
            for part in entry.parts {
                if case .toolResult(let result) = part { out[result.callId] = result }
            }
        }
        return out
    }
}

// MARK: - Projection: entries → blocks the timeline renders

enum FeedItem: Equatable, Sendable, Identifiable {
    case part(key: String, part: FeedPart)
    case tools(key: String, calls: [ToolCall])

    var id: String {
        switch self {
        case .part(let key, _), .tools(let key, _): return key
        }
    }
}

enum FeedBlock: Equatable, Sendable, Identifiable {
    case user(key: String, seq: Int, at: Double, parts: [FeedPart])
    case agent(key: String, seq: Int, at: Double, items: [FeedItem])
    case notice(key: String, seq: Int, at: Double, kind: FeedPart.NoticeKind, text: String)

    var id: String {
        switch self {
        case .user(let key, _, _, _), .agent(let key, _, _, _), .notice(let key, _, _, _, _): return key
        }
    }

    var seq: Int {
        switch self {
        case .user(_, let seq, _, _), .agent(_, let seq, _, _), .notice(_, let seq, _, _, _): return seq
        }
    }

    var at: Double {
        switch self {
        case .user(_, _, let at, _), .agent(_, _, let at, _), .notice(_, _, let at, _, _): return at
        }
    }

    var isUser: Bool {
        if case .user = self { return true }
        return false
    }

    var isAgent: Bool {
        if case .agent = self { return true }
        return false
    }

    /// Plain text a message copies as: its prose only (no tools, widgets, media or reasoning).
    var text: String {
        switch self {
        case .notice(_, _, _, _, let text): return text
        case .user(_, _, _, let parts):
            return parts.compactMap { if case .text(let t) = $0 { return t } else { return nil } }.joined(separator: "\n")
        case .agent(_, _, _, let items):
            return items.compactMap { item -> String? in
                if case .part(_, .text(let t)) = item { return t }
                return nil
            }.joined(separator: "\n\n")
        }
    }
}

enum FeedProjection {
    /// Consecutive assistant and tool entries form one agent turn; within a turn,
    /// consecutive tool calls form one group. Results fold into their call by id.
    static func project(_ entries: [FeedEntry]) -> [FeedBlock] {
        var blocks: [FeedBlock] = []
        var turn: (index: Int, key: String, seq: Int, at: Double, items: [FeedItem])?

        func closeTurn() {
            guard let open = turn else { return }
            blocks[open.index] = .agent(key: open.key, seq: open.seq, at: open.at, items: open.items)
            turn = nil
        }

        for entry in entries {
            let notices = entry.parts.enumerated().compactMap { index, part -> (Int, FeedPart.NoticeKind, String)? in
                if case .notice(let kind, let text) = part { return (index, kind, text) }
                return nil
            }
            let rest = entry.parts.filter { !$0.isNotice && !$0.isToolResult }
            for (i, notice) in notices.enumerated() {
                closeTurn()
                blocks.append(.notice(key: "\(entry.seq).n\(i)", seq: entry.seq, at: entry.at, kind: notice.1, text: notice.2))
            }
            guard !rest.isEmpty else { continue }
            if entry.role == .user {
                closeTurn()
                blocks.append(.user(key: String(entry.seq), seq: entry.seq, at: entry.at, parts: rest))
                continue
            }
            if turn == nil {
                blocks.append(.agent(key: String(entry.seq), seq: entry.seq, at: entry.at, items: []))
                turn = (blocks.count - 1, String(entry.seq), entry.seq, entry.at, [])
            }
            for (i, part) in rest.enumerated() {
                if case .toolCall(let call) = part {
                    if case .tools(let key, let calls)? = turn!.items.last {
                        turn!.items[turn!.items.count - 1] = .tools(key: key, calls: calls + [call])
                    } else {
                        turn!.items.append(.tools(key: "\(entry.seq).\(i)", calls: [call]))
                    }
                } else {
                    turn!.items.append(.part(key: "\(entry.seq).\(i)", part: part))
                }
            }
        }
        closeTurn()
        return blocks
    }

    /// Prose of the newest assistant turn that said something.
    static func lastAssistantText(_ entries: [FeedEntry]) -> String {
        for block in project(entries).reversed() where block.isAgent {
            let text = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
        }
        return ""
    }

    /// The newest agent turn may have started before this page.
    static func assistantTurnCutOff(_ entries: [FeedEntry]) -> Bool {
        guard !entries.isEmpty else { return false }
        let blocks = project(entries)
        guard let lastAgent = blocks.lastIndex(where: \.isAgent) else { return false }
        return !blocks[..<lastAgent].contains { !$0.isAgent }
    }

    /// User and assistant prose, in order, for a handoff summary.
    static func transcriptProse(_ entries: [FeedEntry]) -> String {
        project(entries).compactMap { block -> String? in
            let text = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            switch block {
            case .user: return "User:\n\(text)"
            case .agent: return "Assistant:\n\(text)"
            case .notice: return text
            }
        }.joined(separator: "\n\n")
    }

    /// Keep the end of a transcript so the newest turns survive a length cap.
    static func clipTail(_ text: String, max: Int) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > max else { return trimmed }
        let cut = String(trimmed.suffix(max))
        if let range = cut.range(of: "\n\n"), cut.distance(from: cut.startIndex, to: range.lowerBound) < 400 {
            return String(cut[range.upperBound...]).trimmingLeadingWhitespace()
        }
        return cut.trimmingLeadingWhitespace()
    }

    /// What Send to… puts in the box: a summary, the latest reply, or both.
    static func handoffText(summary: String, latest: String) -> String {
        let s = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let l = latest.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.isEmpty && !l.isEmpty { return "Session summary:\n\(s)\n\nLatest reply:\n\(l)" }
        if !s.isEmpty { return "Session summary:\n\(s)" }
        return l
    }

    /// Last assistant prose, paging back while the newest turn is cut off (bounded).
    static func readLastAssistant(page: @Sendable (Int?, Int) async throws -> FeedPage) async throws -> String {
        var before: Int? = nil
        var entries: [FeedEntry] = []
        for _ in 0..<5 {
            let got = try await page(before, 200)
            guard let oldest = got.entries.first?.seq else { break }
            entries = got.entries + entries
            let text = lastAssistantText(entries)
            if !got.hasOlder || (!assistantTurnCutOff(entries) && !text.isEmpty) { break }
            if let b = before, oldest >= b { break }
            before = oldest
        }
        return lastAssistantText(entries)
    }

    /// Latest reply plus a clipped prose transcript for a subscription to summarize.
    static func readHandoff(page: @Sendable (Int?, Int) async throws -> FeedPage) async throws -> (latest: String, transcript: String) {
        let budget = 16_000
        var before: Int? = nil
        var entries: [FeedEntry] = []
        for _ in 0..<8 {
            let got = try await page(before, 200)
            guard let oldest = got.entries.first?.seq else { break }
            entries = got.entries + entries
            let latest = lastAssistantText(entries)
            let prose = transcriptProse(entries)
            if !got.hasOlder || (!assistantTurnCutOff(entries) && !latest.isEmpty && prose.count >= budget) { break }
            if let b = before, oldest >= b { break }
            before = oldest
        }
        return (lastAssistantText(entries), clipTail(transcriptProse(entries), max: budget))
    }
}

extension String {
    func trimmingLeadingWhitespace() -> String {
        String(drop(while: { $0.isWhitespace }))
    }
}
