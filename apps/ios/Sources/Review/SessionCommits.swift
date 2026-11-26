import Foundation
import Observation

/// What a session committed (`GET /api/review/sessions/:uid/commits`): newest first, each on
/// the branch of its stack it's in, with that stack, so a commit finds its PR and its review.
struct SessionCommits: Codable, Equatable, Sendable {
    struct Commit: Codable, Equatable, Sendable, Hashable, Identifiable {
        var id: String { sha }
        let sha: String
        let short: String
        let subject: String
        /// When it was committed (unix seconds).
        let at: Double
        let files: Int
        let additions: Int
        let deletions: Int
        let branch: String
    }

    /// Commits from before this (unix seconds) were there before the session; 0 when unknown.
    let since: Double
    let stack: SessionStack
    let commits: [Commit]

    /// Where a commit goes when it's picked. Always the review in this app: the one its PR is
    /// already in, or one started for it. GitHub is a link on that page, not where a tap goes.
    enum Target: Equatable, Sendable {
        /// Its PR's layer, in the review it's in.
        case review(ReviewRoute)
        /// No review yet, or this PR isn't in the one that would start: start one, then open its layer.
        case start(ReviewAPI.Pick, pr: Int)
        /// Its branch has no pull request yet: nowhere to review it.
        case nowhere
    }

    func branch(of commit: Commit) -> SessionStack.Branch? { stack.branches.first { $0.branch == commit.branch } }

    func target(of commit: Commit) -> Target {
        guard let pr = branch(of: commit)?.pr else { return .nowhere }
        if let review = stack.review { return .review(ReviewRoute(stack: review.id, pr: pr.number)) }
        // The stack we'd start already, when this PR is one of its open layers; otherwise a review of this PR.
        if pr.state == "OPEN", let pick = stack.startPick { return .start(pick, pr: pr.number) }
        return .start(.chain(pr.number), pr: pr.number)
    }

    /// The commits by the branch they're on, top of the stack first (as they're listed).
    var byBranch: [(branch: String, commits: [Commit])] {
        var out: [(branch: String, commits: [Commit])] = []
        for commit in commits {
            if out.last?.branch == commit.branch { out[out.count - 1].commits.append(commit) } else { out.append((commit.branch, [commit])) }
        }
        return out
    }
}

/// One session's commits, as its host last said. Asked when the session opens and again each
/// time its agent finishes a turn (when commits get made), never polled.
@MainActor
@Observable
final class SessionCommitsModel {
    enum Phase: Equatable, Sendable {
        case idle
        case loading
        case loaded
        /// The host has no such list (an older ah), or doesn't know the session.
        case unsupported
        /// The last ask failed; `value` keeps what the one before brought.
        case failed(String)
    }

    let ref: String
    private(set) var value: SessionCommits?
    private(set) var phase: Phase = .idle

    @ObservationIgnored private let fetch: @Sendable (String) async throws -> SessionCommits
    @ObservationIgnored private var inflight: Task<Void, Never>?
    @ObservationIgnored private var again = false
    @ObservationIgnored private var wasWorking = false

    init(ref: String, fetch: @escaping @Sendable (String) async throws -> SessionCommits) {
        self.ref = ref
        self.fetch = fetch
    }

    convenience init(ref: String, api: APIClient) {
        self.init(ref: ref) { ref in try await ReviewAPI(api: api).sessionCommits(ref) }
    }

    var commits: [SessionCommits.Commit] { value?.commits ?? [] }

    /// Asks now; asked while an ask is out, asks once more after it.
    func load() async {
        if let inflight {
            again = true
            await inflight.value
            return
        }
        let task = Task { await self.ask() }
        inflight = task
        await task.value
        inflight = nil
        if again {
            again = false
            await load()
        }
    }

    /// The row's status: a turn that just ended may have committed, so ask again (once it has
    /// been asked at all, and the host has the list).
    func rowChanged(working: Bool) {
        defer { wasWorking = working }
        guard wasWorking, !working, phase != .idle, phase != .unsupported else { return }
        Task { await load() }
    }

    private func ask() async {
        if value == nil { phase = .loading }
        do {
            let next = try await fetch(ref)
            if next != value { value = next }
            phase = .loaded
        } catch {
            switch APIError.wrap(error) {
            case .cancelled: if value == nil { phase = .idle }
            case .notFound: phase = .unsupported
            case let e: phase = .failed(e.message)
            }
        }
    }
}
