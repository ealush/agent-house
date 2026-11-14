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
    /// Counts every snapshot, a reconnect's too: the transcript in view was replaced, and
    /// where the view sits is to be settled again.
    var snapshots = 0

    static let initial = FeedState()
}

enum FeedAction: Equatable, Sendable {
    case message(FeedMessage)
    case older(FeedPage)
    /// What this device kept of the conversation, shown until the stream catches up.
    case cached(harness: String, entries: [FeedEntry], hasOlder: Bool)
    /// The newest few entries, read ahead of the stream's snapshot: a long session's
    /// snapshot (screenshots, long outputs) runs to megabytes, and on a slow link nothing
    /// that happened since this device last looked showed until all of it was in.
    case tail(FeedPage)
    case disconnected
}

enum FeedReducer {
    static func reduce(_ state: FeedState, _ action: FeedAction) -> FeedState {
        var s = state
        switch action {
        case .message(.snapshot(.resume, let harness, let entries, _, _, let hasOlder)):
            // The host carried on from what this device holds: what came after it goes on the
            // end, as an append would, and what's shown stays (a reconnect, or coming back to a
            // session, no longer sends the newest page again, megabytes of it).
            s.status = .live
            s.reason = nil
            s.harness = harness
            s.entries = merge(s.entries, entries)
            s.results = withResults(s.results, entries)
            if state.entries.isEmpty { s.hasOlder = hasOlder }
            if !entries.isEmpty { s.snapshots += 1 }
        case .message(.snapshot(let reason, let harness, let entries, _, _, let hasOlder)):
            s.status = .live
            s.reason = nil
            s.harness = harness
            s.entries = merge([], entries)
            s.results = withResults([:], entries)
            s.hasOlder = hasOlder
            s.snapshots += 1
            // A reconnect re-sends the same transcript from the top: not a rebuild. Nor is the
            // host's copy of what this device kept, carried on. One that doesn't reach back to
            // what's shown (much came while away) replaces it outright, and in the same scroll
            // view the new transcript was laid out but never drawn: blank until a drag.
            if reason != .initial || !joins(state.entries, entries) { s.epoch += 1 }
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
        case .tail(let page):
            // Only while the stream hasn't answered, and only what's newer than what's shown.
            guard s.status == .connecting, let newest = page.entries.last?.seq, newest > (s.entries.last?.seq ?? -1) else { return s }
            if joins(s.entries, page.entries) {
                // It carries on from what this device kept (or is all there is, in an empty view:
                // then whether there's more above is the page's to say; the stream carries on
                // from it without a snapshot to say so).
                if state.entries.isEmpty { s.hasOlder = page.hasOlder }
                s.entries = merge(s.entries, page.entries)
                s.results = withResults(s.results, page.entries)
            } else {
                // Too much happened meanwhile to join up: what's kept would read as if nothing
                // came between it and the tail. A new transcript, in a new scroll view.
                s.hasOlder = page.hasOlder || !s.entries.isEmpty
                s.entries = merge([], page.entries)
                s.results = withResults([:], page.entries)
                s.epoch += 1
            }
            s.snapshots += 1
        case .disconnected:
            if s.status == .live { s.status = .connecting }
        }
        return s
    }

    /// Whether `next` reaches back to what's shown: nothing shown, or they overlap.
    static func joins(_ shown: [FeedEntry], _ next: [FeedEntry]) -> Bool {
        guard let last = shown.last?.seq, let first = next.first?.seq else { return true }
        return first <= last
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

    /// Whether there are any words in `text`, without joining them all up to see.
    var hasText: Bool {
        switch self {
        case .notice(_, _, _, _, let text): return !text.isEmpty
        case .user(_, _, _, let parts): return parts.contains { if case .text(let t) = $0 { !t.isEmpty } else { false } }
        case .agent(_, _, _, let items): return items.contains { if case .part(_, .text(let t)) = $0 { !t.isEmpty } else { false } }
        }
    }
}

enum FeedProjection {
    /// Focus mode: what's said, not how. The agent's thinking and its runs of tool steps go,
    /// unless `keeps` a run (one asking you something), and so does a message of the agent's
    /// with nothing left.
    static func focused(_ blocks: [FeedBlock], keeps: ([ToolCall]) -> Bool) -> [FeedBlock] {
        blocks.compactMap { block in
            guard case .agent(let key, let seq, let at, let items) = block else { return block }
            let shown = items.filter { item in
                switch item {
                case .part(_, let part):
                    switch part {
                    case .reasoning, .toolCall, .toolResult: return false
                    default: return true
                    }
                case .tools(_, let calls):
                    return keeps(calls)
                }
            }
            return shown.isEmpty ? nil : .agent(key: key, seq: seq, at: at, items: shown)
        }
    }

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

    /// Where each finished turn ends (the block before your next message, or the last one
    /// once the agent is done), with how long it took.
    static func turnEnds(_ blocks: [FeedBlock], durations: [String: Double], working: Bool) -> [String: Double] {
        var out: [String: Double] = [:]
        var start: String?
        for (index, block) in blocks.enumerated() {
            if block.isUser { start = nil; continue }
            if block.isAgent && start == nil { start = block.id }
            let next = index + 1 < blocks.count ? blocks[index + 1] : nil
            let ends = next.map(\.isUser) ?? !working
            if ends, let start, let seconds = durations[start] { out[block.id] = seconds }
        }
        return out
    }

    /// How long each answered turn took: from your message to the agent's last entry before
    /// your next one, keyed by the agent block that starts the answer (its first entry's seq).
    /// Turns without both ends (history cut mid-turn, timestamps missing) are left out.
    static func turnDurations(_ entries: [FeedEntry]) -> [String: Double] {
        var out: [String: Double] = [:]
        var asked: Double?
        var answer: (key: String, end: Double)?
        func close() {
            if let asked, let answer, asked > 0, answer.end > asked { out[answer.key] = (answer.end - asked) / 1000 }
            answer = nil
        }
        for entry in entries {
            let speaks = entry.parts.contains { !$0.isNotice && !$0.isToolResult }
            if entry.role == .user && speaks {
                close()
                asked = entry.at
                continue
            }
            guard asked != nil else { continue }
            if answer == nil {
                guard entry.role != .user || !speaks, entry.parts.contains(where: { !$0.isNotice }) else { continue }
                answer = (String(entry.seq), entry.at)
            } else {
                answer!.end = max(answer!.end, entry.at)
            }
        }
        close()
        return out
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

    /// The first message for another agent picking up a conversation (`web/handoff.ts`):
    /// where it ran, what was said (newest last), and how to carry on. No model involved.
    static func continuePrompt(from agent: String, cwd: String, branch: String?, transcript: String, latest: String) -> String {
        let t = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        let body = t.isEmpty ? latest.trimmingCharacters(in: .whitespacesAndNewlines) : t
        return [
            "You are picking up a conversation that was running in \(agent), in this same directory (\(cwd)\(branch.map { ", branch \($0)" } ?? "")).",
            "Below is what was said so far, most recent last. Check the current state of the files before acting, do not redo finished work, and continue from where it left off.",
            "",
            "<previous-conversation>",
            body.isEmpty ? "(The earlier conversation had no readable messages.)" : body,
            "</previous-conversation>",
        ].joined(separator: "\n")
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

// MARK: The message rail (`../ah/web/gui/MessageRail.tsx`)

/// One tick per message you sent: what the host lists (the whole conversation, since a
/// reload draws only the newest page), what arrived since, then what's still sending.
struct RailItem: Equatable, Sendable, Identifiable {
    /// The message's seq, or "out:<id>" while it's still sending.
    let id: String
    /// Where to page in to reach it; nil while sending.
    let seq: Int?
    let text: String
}

extension FeedProjection {
    /// Past this many ticks the rail is a window that follows what you're reading.
    static let railWindow = 15

    static func railItems(prompts: [FeedPrompt], blocks: [FeedBlock], outgoing: [(id: Int, text: String)]) -> [RailItem] {
        var bySeq: [Int: String] = [:]
        for prompt in prompts { bySeq[prompt.seq] = prompt.text }
        for block in blocks where block.isUser { bySeq[block.seq] = block.text }
        let sent = bySeq.keys.sorted().map { RailItem(id: String($0), seq: $0, text: bySeq[$0]!) }
        return sent + outgoing.map { RailItem(id: "out:\($0.id)", seq: nil, text: $0.text) }
    }

    /// The tick for the turn you're reading: the newest at the end of the transcript,
    /// otherwise the last of yours that starts at or above the top of the screen.
    static func activeRail(_ items: [RailItem], topSeq: Int?, atLatest: Bool) -> Int? {
        guard !items.isEmpty else { return nil }
        guard !atLatest, let topSeq else { return items.count - 1 }
        return items.lastIndex { ($0.seq ?? .max) <= topSeq } ?? 0
    }

    /// What a tick's bubble says: your words on one line, attachments as "1 image · …", cut
    /// well past two lines' worth (the bubble ends what's left with an ellipsis).
    static func railPreview(_ text: String) -> String {
        let flat = Uploads.summary(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        return flat.isEmpty ? "Attachment" : String(flat.prefix(160))
    }

    /// Which ticks show: all of them, or a window of `railWindow` centred on `lead`.
    static func railRange(count: Int, lead: Int) -> Range<Int> {
        guard count > railWindow else { return 0..<count }
        let first = max(0, min(count - railWindow, lead - railWindow / 2))
        return first..<(first + railWindow)
    }
}
