import Foundation

/// When a session has finished, as the app's nudges and its own alerts tell it (the host's
/// `server/finishes.ts`, which its push follows): not the moment a turn ends, since an agent
/// often stops for a breath (a background subagent's turn) and goes straight back to work, but
/// once it has stayed done a while.
struct Finishes: Sendable {
    /// A turn's end counts once nothing has moved for this long.
    static let settle: TimeInterval = 30
    /// At most one "finished" per session this often; a later one waits, it isn't lost.
    static let spacing: TimeInterval = 180

    private var last: [String: SessionDTO.Status] = [:]
    /// Sessions whose turn ended and hasn't been told yet → since when it has been quiet.
    private var pending: [String: Date] = [:]
    private var told: [String: Date] = [:]

    /// Every session as it is now: the keys of the ones that finished and are due a nudge or an
    /// alert. A turn ends going from working to attention; it's told once it has stayed there
    /// `settle` with none of its subagents at work and nothing told for it in the last
    /// `spacing`. Working again, needing you, or being looked at (idle) calls it off.
    mutating func observe(_ rows: [SessionRow], now: Date) -> Set<String> {
        var due: Set<String> = []
        var present: Set<String> = []
        for row in rows {
            let key = row.key, status = row.dto.status
            present.insert(key)
            let previous = last.updateValue(status, forKey: key)
            if status == .attention, previous == .busy { pending[key] = now }
            guard let since = pending[key] else { continue }
            guard status == .attention else {
                pending[key] = nil
                continue
            }
            // Its subagents still at work: not done, and quiet only from when they stop.
            if (row.dto.subagents?.active ?? 0) > 0 {
                pending[key] = now
                continue
            }
            if now.timeIntervalSince(since) < Self.settle { continue }
            if let told = told[key], now.timeIntervalSince(told) < Self.spacing { continue }
            pending[key] = nil
            told[key] = now
            due.insert(key)
        }
        last = last.filter { present.contains($0.key) }
        pending = pending.filter { present.contains($0.key) }
        told = told.filter { present.contains($0.key) }
        return due
    }

    /// When the next waiting finish could be due, or nil when none waits.
    var next: Date? {
        pending.map { key, since in
            max(since.addingTimeInterval(Self.settle), told[key]?.addingTimeInterval(Self.spacing) ?? .distantPast)
        }.min()
    }
}
