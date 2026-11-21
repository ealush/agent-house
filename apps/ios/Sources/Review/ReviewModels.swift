import Foundation

// Stack review (`apps/server/web/reviewApi.ts`, types mirror server/review/service.ts).

struct Checks: Codable, Equatable, Sendable, Hashable {
    let pass: Int
    let fail: Int
    let pending: Int
    let failing: [String]

    /// "No checks reported" is not "checks passed": the two must never read the same.
    enum Outcome: Equatable, Sendable { case none, pending, failing, passing }
    var outcome: Outcome {
        if fail > 0 { return .failing }
        if pending > 0 { return .pending }
        if pass > 0 { return .passing }
        return .none
    }
}

struct Verdict: Codable, Equatable, Sendable, Hashable {
    struct Item: Codable, Equatable, Sendable, Hashable {
        let id: Int
        let verdict: String
        let evidence: String
    }
    struct Unrequested: Codable, Equatable, Sendable, Hashable {
        let title: String
        let path: String?
        let line: Int?
    }
    let items: [Item]
    let unrequested: [Unrequested]
    let summary: String
}

struct RevView: Codable, Equatable, Sendable, Hashable {
    let id: Int
    let baseSha: String
    let headSha: String
    let patchId: String
    let files: Int
    let additions: Int
    let deletions: Int
    let summary: String?
    let verdict: Verdict?
}

enum LayerStatus: String, Codable, Sendable, CaseIterable {
    case unreviewed, changes, fixing, rereview, approved, merged, closed, skipped

    var word: String {
        switch self {
        case .unreviewed: return "To review"
        case .changes: return "Changes"
        case .fixing: return "Fixing"
        case .rereview: return "Re-review"
        case .approved: return "Reviewed"
        case .merged: return "Merged"
        case .closed: return "Closed"
        case .skipped: return "Skipped"
        }
    }

    enum Tone: Sendable { case todo, needs, busy, ready, merged, off }
    var tone: Tone {
        switch self {
        case .changes, .rereview: return .needs
        case .fixing: return .busy
        case .approved: return .ready
        case .merged: return .merged
        case .skipped, .closed: return .off
        case .unreviewed: return .todo
        }
    }
}

struct MergeGate: Codable, Equatable, Sendable, Hashable {
    let key: String
    let ok: Bool
    let label: String
    let detail: String?
}

struct DispatchView: Codable, Equatable, Sendable, Hashable {
    let id: Int
    let pr: Int
    let kind: String
    let state: String
    let targetUid: String
    let targetTitle: String?
    let sentAt: Double
    let findings: [Int]
    let text: String
}

struct Finding: Codable, Equatable, Sendable, Hashable, Identifiable {
    enum Severity: String, Codable, Sendable, CaseIterable {
        case blocking, should, nit

        /// Said for a person: the wire's "should" reads as half a sentence.
        var label: String {
            switch self {
            case .blocking: return "Blocking"
            case .should: return "Should fix"
            case .nit: return "Nit"
            }
        }
    }
    enum State: String, Codable, Sendable, CaseIterable {
        case proposed, open, sent, addressed, wontfix, dismissed

        var label: String {
            switch self {
            case .proposed: return "Proposed"
            case .open: return "Open"
            case .sent: return "Sent for fixing"
            case .addressed: return "Addressed"
            case .wontfix: return "Won’t fix"
            case .dismissed: return "Dismissed"
            }
        }
    }
    let id: Int
    let ownerPr: Int
    let foundOnPr: Int
    let title: String
    let body: String
    let severity: Severity
    let state: State
    let source: String
    let path: String?
    let lineStart: Int?
    let lineEnd: Int?
    let ghUrl: String?
    let ghThread: Bool
    let note: String?
    let createdAt: Double

    /// Still asks something of the author.
    var isOpen: Bool { state == .open || state == .proposed || state == .sent }
}

struct Layer: Codable, Equatable, Sendable, Hashable, Identifiable {
    var id: Int { pr }
    let pr: Int
    let role: String
    let position: Int
    let title: String
    let url: String
    let author: String
    let state: String
    let draft: Bool
    let headRef: String
    let baseRef: String
    let headSha: String
    let mergeable: String?
    let checks: Checks
    let needs: String
    let status: LayerStatus
    let approved: Bool
    let samePatch: Bool
    let rebased: Bool
    let current: RevView?
    let reviewed: RevView?
    let open: Int
    let followups: Int
    let blocking: Int
    let dispatch: DispatchView?
    let gates: [MergeGate]
    let ownerUid: String?
    let ghStack: Int?
    let ghPos: Int?

    var name: String { role.isEmpty ? "#\(pr)" : role }
}

struct StackOwner: Codable, Equatable, Sendable, Hashable {
    let uid: String
    let key: String
    let title: String
    let agent: String?
    let status: String
    let live: Bool
    let branch: String?
}

struct ReviewStack: Codable, Equatable, Sendable, Identifiable {
    struct LinkState: Codable, Equatable, Sendable { let ok: Bool; let prs: [Int]; let onto: Int?; let why: String? }
    struct Decision: Codable, Equatable, Sendable, Hashable, Identifiable { let id: Int; let text: String; let fromPr: Int?; let at: Double }
    let id: String
    let title: String
    let repo: String
    let repoRoot: String
    let trunk: String
    let mergeMethod: String
    let methods: [String]
    let source: String
    let ghStack: Int?
    let origin: StackOwner?
    let link: LinkState?
    let planPath: String?
    let state: String
    let syncedAt: Double
    let syncError: String?
    let syncing: Bool
    let owner: StackOwner?
    let layers: [Layer]
    let next: Int?
    let decisions: [Decision]
}

struct StackSummary: Codable, Equatable, Sendable, Identifiable {
    struct Spine: Codable, Equatable, Sendable, Hashable { let pr: Int; let role: String; let status: LayerStatus }
    let id: String
    let title: String
    let repo: String
    let trunk: String
    let state: String
    let source: String
    let ghStack: Int?
    let layers: Int
    let merged: Int
    let needsYou: Int
    let next: Int?
    let syncedAt: Double
    let spine: [Spine]
    let origin: StackOwner?
    let owner: StackOwner?
    let files: Int?
    let additions: Int?
    let deletions: Int?
    let openFindings: Int?
    let blockingFindings: Int?
    let checks: Checks?
    let readyToMerge: Bool?

    init(
        id: String,
        title: String,
        repo: String,
        trunk: String,
        state: String,
        source: String,
        ghStack: Int?,
        layers: Int,
        merged: Int,
        needsYou: Int,
        next: Int?,
        syncedAt: Double,
        spine: [Spine],
        origin: StackOwner? = nil,
        owner: StackOwner? = nil,
        files: Int? = nil,
        additions: Int? = nil,
        deletions: Int? = nil,
        openFindings: Int? = nil,
        blockingFindings: Int? = nil,
        checks: Checks? = nil,
        readyToMerge: Bool? = nil
    ) {
        self.id = id
        self.title = title
        self.repo = repo
        self.trunk = trunk
        self.state = state
        self.source = source
        self.ghStack = ghStack
        self.layers = layers
        self.merged = merged
        self.needsYou = needsYou
        self.next = next
        self.syncedAt = syncedAt
        self.spine = spine
        self.origin = origin
        self.owner = owner
        self.files = files
        self.additions = additions
        self.deletions = deletions
        self.openFindings = openFindings
        self.blockingFindings = blockingFindings
        self.checks = checks
        self.readyToMerge = readyToMerge
    }
}

extension StackSummary {
    /// The session linked to this review (origin first, else owner).
    var linkedSession: StackOwner? { origin ?? owner }

    /// Where the stack stands, in words: how many layers are in each state (the ones that
    /// want something first), and the layer up next.
    var statusLine: String {
        let order: [(LayerStatus, String)] = [
            (.changes, "with changes asked"), (.rereview, "to re-review"), (.fixing, "being fixed"), (.unreviewed, "to review"),
            (.approved, "reviewed"), (.merged, "merged"), (.skipped, "skipped"), (.closed, "closed"),
        ]
        var parts = order.compactMap { status, words -> String? in
            let n = spine.filter { $0.status == status }.count
            return n > 0 ? "\(n) \(words)" : nil
        }
        if let next, merged < layers { parts.append("next up #\(next)") }
        return parts.joined(separator: " · ")
    }
}

struct SessionReviewOpenResult: Codable, Equatable, Sendable {
    let stack: ReviewStack
    let pr: Int?
    let created: Bool
}

struct CloseLayerResult: Codable, Equatable, Sendable {
    let stack: ReviewStack?
    let removed: Bool
}

struct InlineComment: Encodable, Equatable, Sendable {
    let title: String
    var body: String? = nil
    var severity: String? = nil
    var path: String? = nil
    var lineStart: Int? = nil
    var lineEnd: Int? = nil
}

struct Candidate: Codable, Equatable, Sendable, Hashable, Identifiable {
    var id: Int { number }
    let number: Int
    let title: String
    let draft: Bool
    let author: String
    let additions: Int
    let deletions: Int
    let updatedAt: String
    let inStack: String?
}

/// GitHub's chain under a PR, as a tree (`CandidateTree`).
final class CandidateTree: Codable, Equatable, Sendable, Identifiable {
    var id: Int { pr.number }
    let pr: Candidate
    let children: [CandidateTree]

    init(pr: Candidate, children: [CandidateTree]) {
        self.pr = pr
        self.children = children
    }

    static func == (a: CandidateTree, b: CandidateTree) -> Bool { a.pr == b.pr && a.children == b.children }
}

struct Candidates: Codable, Equatable, Sendable {
    struct NativeStack: Codable, Equatable, Sendable, Hashable { let number: Int; let base: String; let prs: [Int] }
    struct Existing: Codable, Equatable, Sendable, Hashable { let id: String; let title: String }
    let root: String
    let repo: String
    let trunk: String
    let trees: [CandidateTree]
    let stacks: [Existing]
    let native: [NativeStack]
}

struct ReviewRepo: Codable, Equatable, Sendable, Hashable { let root: String; let repo: String; let trunk: String }

struct SessionStack: Codable, Equatable, Sendable {
    struct PR: Codable, Equatable, Sendable, Hashable {
        let number: Int
        let title: String
        let url: String
        let state: String
        let draft: Bool
        let checks: Checks
        let additions: Int
        let deletions: Int
    }
    struct Branch: Codable, Equatable, Sendable, Hashable {
        struct LayerRef: Codable, Equatable, Sendable, Hashable { let status: LayerStatus; let role: String }
        let branch: String
        let current: Bool
        let pr: PR?
        let layer: LayerRef?
    }
    struct ReviewRef: Codable, Equatable, Sendable { let id: String; let title: String }
    let repo: String?
    let root: String
    let trunk: String
    let source: String?
    let branch: String?
    let ghStack: Int?
    let branches: [Branch]
    let review: ReviewRef?
    let start: JSONValue?

    /// Converts the host's `start` payload (`{ native }`, `{ pr }`, or `{ prs }`) into a typed `ReviewAPI.Pick`.
    var startPick: ReviewAPI.Pick? {
        guard case .object(let obj) = start else { return nil }
        if case .number(let n) = obj["native"] { return .native(Int(n)) }
        if case .number(let n) = obj["pr"] { return .chain(Int(n)) }
        if case .array(let arr) = obj["prs"] {
            let nums: [Int] = arr.compactMap {
                if case .number(let n) = $0 { return Int(n) }
                return nil
            }
            return nums.isEmpty ? nil : .manual(nums)
        }
        return nil
    }
}

struct OwnerSuggestion: Codable, Equatable, Sendable, Hashable, Identifiable {
    var id: String { uid }
    let uid: String
    let key: String
    let title: String
    let agent: String?
    let status: String
    let cwd: String
    let branch: String?
    let live: Bool
    let reason: String
    let origin: Bool
}

/// What a question to the reviewer points at, besides the layer: lines carry the diff text you saw.
enum AskContext: Codable, Equatable, Sendable, Hashable {
    case finding(id: Int)
    case lines(pr: Int, path: String, start: Int, end: Int, text: String)
    case file(pr: Int, path: String)

    private enum CodingKeys: String, CodingKey { case kind, id, pr, path, start, end, text }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "finding": self = .finding(id: try c.decode(Int.self, forKey: .id))
        case "lines": self = .lines(pr: try c.decode(Int.self, forKey: .pr), path: try c.decode(String.self, forKey: .path), start: try c.decode(Int.self, forKey: .start), end: try c.decode(Int.self, forKey: .end), text: try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        default: self = .file(pr: try c.decode(Int.self, forKey: .pr), path: try c.decode(String.self, forKey: .path))
        }
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .finding(let id):
            try c.encode("finding", forKey: .kind)
            try c.encode(id, forKey: .id)
        case .lines(let pr, let path, let start, let end, let text):
            try c.encode("lines", forKey: .kind)
            try c.encode(pr, forKey: .pr)
            try c.encode(path, forKey: .path)
            try c.encode(start, forKey: .start)
            try c.encode(end, forKey: .end)
            try c.encode(text, forKey: .text)
        case .file(let pr, let path):
            try c.encode("file", forKey: .kind)
            try c.encode(pr, forKey: .pr)
            try c.encode(path, forKey: .path)
        }
    }

    var key: String {
        switch self {
        case .finding(let id): return "f\(id)"
        case .file(let pr, let path): return "p\(pr):\(path)"
        case .lines(let pr, let path, let start, let end, _): return "l\(pr):\(path):\(start)-\(end)"
        }
    }
}

struct SavedContext: Codable, Equatable, Sendable, Hashable {
    let kind: String
    let id: Int?
    let pr: Int?
    let path: String?
    let start: Int?
    let end: Int?
    let label: String
}

struct ThreadMessage: Codable, Equatable, Sendable, Hashable, Identifiable {
    let role: String
    let text: String
    let at: Double
    let id: Int
    let pr: Int?
    let context: [SavedContext]
}

struct ReviewThread: Codable, Equatable, Sendable {
    let messages: [ThreadMessage]
    let findings: [Finding]
    let subscriptionId: String?
}

struct AskReply: Codable, Equatable, Sendable {
    let asked: ThreadMessage
    let message: ThreadMessage
    let followups: [Followup]
    let findings: [Finding]
}

struct DiffOut: Codable, Equatable, Sendable {
    let kind: String
    let text: String
    let truncated: Bool
    let from: String
    let to: String
}

enum DiffScope: String, Sendable, CaseIterable, Codable {
    /// This PR against its base, at the reviewed or current head.
    case this
    /// What changed since you reviewed it (`git range-diff` when it was rebased).
    case since
    /// Everything from trunk up to this layer.
    case cumulative

    var label: String {
        switch self {
        case .this: return "This PR"
        case .since: return "Since review"
        case .cumulative: return "From trunk"
        }
    }
}

struct StackMergeResult: Codable, Equatable, Sendable {
    struct Stopped: Codable, Equatable, Sendable { let pr: Int; let why: String }
    let merged: [Int]
    let restack: [Int]
    let waiting: String?
    let stopped: Stopped?
    let next: Int?
}

struct LayerMergeResult: Codable, Equatable, Sendable {
    let next: Int?
    let restack: [Int]
    let merged: [Int]
    let waiting: String?
}

struct DispatchResult: Codable, Equatable, Sendable {
    let dispatch: DispatchView
    let outcome: String
}

struct ReviewBusy: Codable, Equatable, Sendable { let summarizing: Bool; let rechecking: Bool }
struct SummaryStart: Codable, Equatable, Sendable { let started: Bool; let reason: String? }
struct PlanText: Codable, Equatable, Sendable { let path: String?; let text: String? }
struct PRDescription: Codable, Equatable, Sendable { let body: String; let url: String }
struct ImportedThreads: Codable, Equatable, Sendable { let added: Int }
struct ReviewSettings: Codable, Equatable, Sendable { let summaryId: String? }

/// Where a review link points (`reviewHash`/`parseReviewHash`): the list, picking PRs, a stack, a layer.
struct ReviewRoute: Equatable, Sendable, Codable, Hashable {
    var stack: String?
    var pr: Int?
    var pick: Bool = false

    init(stack: String? = nil, pr: Int? = nil, pick: Bool = false) {
        self.stack = stack
        self.pr = pr
        self.pick = pick
    }

    init(fragment: String) {
        let h = fragment.hasPrefix("#") ? String(fragment.dropFirst()) : fragment
        if h == "review/new" { self.init(pick: true); return }
        let parts = h.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.first == "review" else { self.init(); return }
        let id = parts.count > 1 ? parts[1] : nil
        let validID = id.flatMap { (4...40).contains($0.count) && $0.allSatisfy { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" } ? $0 : nil }
        let tail = parts.count > 2 ? parts[2] : nil
        self.init(stack: validID, pr: tail.flatMap { Int($0) }, pick: tail == "add")
    }

    var fragment: String {
        if pick { return stack.map { "review/\($0)/add" } ?? "review/new" }
        guard let stack else { return "review" }
        return pr.map { "review/\(stack)/\($0)" } ?? "review/\(stack)"
    }
}
