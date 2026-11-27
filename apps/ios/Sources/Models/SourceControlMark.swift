import Foundation

/// What a session's checkout says at a glance, for the faint glyph by its name (the Inbox row,
/// the Commits chip, a branch in the Commits list): uncommitted changes, and its pull request
/// open, draft, failing its checks, or merged. Nothing for a clean checkout with no pull request
/// or a closed one, so a list at rest stays names and places.
struct SourceControlMark: Equatable, Sendable {
    enum Pull: Equatable, Sendable {
        case open, draft, failing, merged

        /// SF Symbols: the pull request's arrows, merged ones joined.
        var symbol: String { self == .merged ? "arrow.triangle.merge" : "arrow.triangle.pull" }
    }

    /// Files uncommitted; 0 for none.
    let dirty: Int
    let pull: Pull?
    let number: Int?

    init?(dirty: Int, pull: Pull?, number: Int?) {
        guard dirty > 0 || pull != nil else { return nil }
        self.dirty = max(0, dirty)
        self.pull = pull
        self.number = pull == nil ? nil : number
    }

    /// From a row's `scm`.
    init?(_ scm: ScmDTO?) {
        guard let scm else { return nil }
        self.init(dirty: scm.dirty, pull: scm.pull.flatMap { Self.pull(state: $0.state.rawValue, draft: $0.state == .draft, failing: $0.checks == .fail) }, number: scm.pull?.number)
    }

    /// From a branch's PR in the session's stack (the Commits list), with the checkout's files
    /// uncommitted when it's the branch checked out.
    init?(_ pr: SessionStack.PR?, dirty: Int = 0) {
        self.init(dirty: dirty, pull: pr.flatMap { Self.pull(state: $0.state, draft: $0.draft, failing: $0.checks.fail > 0) }, number: pr?.number)
    }

    /// A merged one is merged whatever its checks said; a closed one says nothing.
    private static func pull(state: String, draft: Bool, failing: Bool) -> Pull? {
        switch state.lowercased() {
        case "merged": return .merged
        case "closed": return nil
        default: return failing ? .failing : draft ? .draft : .open
        }
    }

    /// In words, for VoiceOver: "3 uncommitted files, pull request 12 failing checks".
    var spoken: String {
        var parts: [String] = []
        if dirty > 0 { parts.append(dirty == 1 ? "1 uncommitted file" : "\(dirty) uncommitted files") }
        if let pull {
            let pr = number.map { "pull request \($0)" } ?? "pull request"
            switch pull {
            case .open: parts.append("\(pr) open")
            case .draft: parts.append("draft \(pr)")
            case .failing: parts.append("\(pr) failing checks")
            case .merged: parts.append("\(pr) merged")
            }
        }
        return parts.joined(separator: ", ")
    }
}
