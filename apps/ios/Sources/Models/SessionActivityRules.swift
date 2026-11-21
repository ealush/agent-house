import Foundation

/// How a session's Live Activity follows its row while the app runs: the host's own rules
/// (`Apns.follow` in `server/apns.ts`), so what the app shows and what the host pushes agree.
/// Starts when you send it a message from this device ("Starting" until it's seen at work);
/// nothing ends it before then, except a minute with nothing at all (a turn too quick to
/// catch, or a message that never got there).
enum SessionActivityRules {
    /// The session's state as one Live Activity frame.
    /// While it works, the last thing said rather than the tool it's running ("$ gh pr merge …"
    /// says little about where a conversation is), and once it's done, its answer; the tool
    /// only where there's no transcript.
    static func state(of dto: SessionDTO, since: Double, privatePreview: Bool) -> SessionActivityState {
        var state: SessionActivityState
        let queued = dto.queued > 0 ? dto.queued : nil
        let said = lastSaid(dto.reply)
        if let limit = dto.limit, dto.status != .busy {
            state = .init(phase: .limited, detail: line(limit), answerable: false, since: since)
        } else {
            switch dto.status {
            case .waiting:
                let ask = AskParts.line(dto.ask)
                state = .init(phase: .waiting, detail: line(ask.isEmpty ? (said ?? dto.detail) : ask), answerable: dto.answerable, since: since, prompt: dto.answerable ? dto.askId : nil, queued: queued)
            case .busy:
                state = .init(phase: .working, detail: said ?? line(dto.detail), answerable: false, since: since, queued: queued)
            case .idle, .attention:
                state = .init(phase: .finished, detail: dto.reply?.isYours == false ? said : nil, answerable: false, since: since)
            }
        }
        if privatePreview { state.detail = nil }
        return state
    }

    /// One activity being followed.
    struct Follow: Equatable, Sendable {
        /// When it started (you sent the message), seconds since 1970.
        let began: Double
        /// The session was seen at work since.
        var started = false
        var shown: SessionActivityState?
    }

    enum Step: Equatable, Sendable {
        case wait
        case update(SessionActivityState)
        case end(SessionActivityState)
    }

    /// A turn that went by between two looks (or a message that never got there) ends here.
    static let unstartedLimit: Double = 60

    /// What a new activity shows before its session is seen at work.
    static func starting(at now: Double) -> SessionActivityState {
        .init(phase: .starting, detail: nil, answerable: false, since: now)
    }

    /// The next thing to do with one activity. `dto` nil: the session is gone.
    static func step(_ follow: inout Follow, dto: SessionDTO?, now: Double, privatePreview: Bool) -> Step {
        guard let dto else {
            guard follow.started || now - follow.began > unstartedLimit else { return .wait }
            // Gone mid-turn is not finished: it stopped (ended, killed) with work in hand.
            let wasWorking = follow.shown.map { [.working, .waiting, .starting].contains($0.phase) } ?? true
            return .end(.init(phase: wasWorking ? .failed : .finished, detail: nil, answerable: false, since: now))
        }
        let working = dto.status == .busy || dto.status == .waiting
        if !follow.started {
            guard working else {
                guard now - follow.began > unstartedLimit else { return .wait }
                let last = state(of: dto, since: now, privatePreview: privatePreview)
                follow.shown = last
                return .end(last.isOver ? last : .init(phase: .finished, detail: nil, answerable: false, since: now))
            }
            follow.started = true
        }
        let phase = state(of: dto, since: 0, privatePreview: privatePreview).phase
        // "Starting" hands its clock to "Working": the turn is the one you started.
        let since = follow.shown.map { $0.phase == phase || ($0.phase == .starting && phase == .working) ? $0.since : now } ?? now
        let next = state(of: dto, since: since, privatePreview: privatePreview)
        guard next != follow.shown else { return .wait }
        follow.shown = next
        return next.isOver ? .end(next) : .update(next)
    }

    /// Whether the app, still following an activity with nothing new, shows it again so it
    /// doesn't go out of date: once half its time is gone (or when that time isn't known).
    static func looksAgain(staleAt: Double?, now: Double, staleAfter: Double) -> Bool {
        guard let staleAt else { return true }
        return staleAt - now < staleAfter / 2
    }

    /// The last thing said, as a list shows it under its title: the agent's words, or yours
    /// ("You: …") while it works on them and hasn't answered yet. One line, at most `max`
    /// characters (the host's `lastSaid`).
    static func lastSaid(_ reply: SessionDTO.Reply?, max: Int = 120) -> String? {
        let flat = (reply?.text ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard let reply, !flat.isEmpty else { return nil }
        let said = reply.isYours ? "You: \(flat)" : flat
        return said.count > max ? String(said.prefix(max - 1)) + "…" : said
    }

    /// The first line of `text`, at most 120 characters (the host's `activityState`).
    static func line(_ text: String?) -> String? {
        guard let first = text?.split(separator: "\n").map({ $0.trimmingCharacters(in: .whitespaces) }).first(where: { !$0.isEmpty }) else { return nil }
        return first.count > 120 ? String(first.prefix(119)) + "…" : first
    }

    /// The most activities shown at once. Starting another ends the one longest without news:
    /// a finished one first, then the oldest.
    static let limit = 3

    /// Which of `current` (keys with when they began and whether they're over) gives way for
    /// a new one, if any.
    static func evict(_ current: [(key: String, began: Double, over: Bool)]) -> String? {
        guard current.count >= limit else { return nil }
        let sorted = current.sorted { ($0.over ? 0 : 1, $0.began) < ($1.over ? 0 : 1, $1.began) }
        return sorted.first?.key
    }
}
