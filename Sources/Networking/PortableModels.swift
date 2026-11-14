import Foundation

// Portable conversations (`ah` `server/portable`, docs/spec/13-conductor.md CND-2): carrying a
// conversation from one agent to another, and the lineage that records it. The host owns the
// representation, the conversion and the launch; these are its answers, decoded leniently
// (fields a host adds later are optional) so an older or newer host never breaks a screen.

/// Where a session's conversation came from when the host carried it over (`continued` on
/// sessions and history items).
struct ContinuedLineage: Codable, Equatable, Sendable {
    let linkId: String
    let fromUid: String?
    let fromHarness: String
    let fromTitle: String
    let fromHost: String?
    /// resume, fork, portable, import, migration.
    let kind: String
    /// native-resume, native-fork, ancestor-fork, context-handoff, transfer.
    let strategy: String
    let at: Double
}

/// Something a portable record couldn't carry faithfully: shown, never hidden.
struct PortableLimitation: Codable, Equatable, Hashable, Sendable {
    let code: String
    let message: String
    var count: Int? = nil
}

/// What continuing in another agent asks for.
struct ContinueRequest: Codable, Equatable, Sendable {
    /// The destination agent (a preset id on the host).
    var to: String
    /// "continue" (same folder by default) or "fork" (its own worktree by default).
    var intent: String?
    var worktree: Bool?
    var name: String?
    /// The same key returns the same operation: a second tap, or a retry after a lost
    /// answer, never starts a second session.
    var idempotencyKey: String?
    /// Launch choices for the destination, sent only to a host that says it takes them.
    var model: String?
    var effort: String?
    var mode: String?
}

/// The host's plan for a continuation (`POST …/preview`): which strategy applies, what carries
/// over and what doesn't. It starts nothing.
struct ContinuePlan: Codable, Equatable, Sendable {
    let strategy: String
    let kind: String
    let source: Source
    let destination: Destination
    let transfers: [String]
    let limitations: [PortableLimitation]
    let blocked: Blocked?
    let ancestor: Ancestor?
    let handoff: Handoff?
    let stats: Stats?

    struct Source: Codable, Equatable, Sendable {
        let ref: String
        let uid: String?
        let harness: String
        let title: String
        let cwd: String
        let live: Bool
        let busy: Bool
    }

    struct Destination: Codable, Equatable, Sendable {
        let harness: String
        let name: String
        let cwd: String
        let worktree: Bool
        var model: String?
        var effort: String?
        var mode: String?
    }

    struct Blocked: Codable, Equatable, Sendable {
        let code: String
        let message: String
    }

    struct Ancestor: Codable, Equatable, Sendable {
        let conversationId: String
        let harness: String
        let title: String
        let checkpointLine: Int?
    }

    struct Handoff: Codable, Equatable, Sendable {
        let chars: Int
        let messagesIncluded: Int
        let messagesOmitted: Int
        let preview: String
    }

    struct Stats: Codable, Equatable, Sendable {
        let messages: Int
        let turns: Int
        let toolCalls: Int
        var reasoningOmitted: Int?
    }

    private enum CodingKeys: String, CodingKey { case strategy, kind, source, destination, transfers, limitations, blocked, ancestor, handoff, stats }

    init(strategy: String, kind: String, source: Source, destination: Destination, transfers: [String], limitations: [PortableLimitation], blocked: Blocked?, ancestor: Ancestor?, handoff: Handoff?, stats: Stats?) {
        self.strategy = strategy
        self.kind = kind
        self.source = source
        self.destination = destination
        self.transfers = transfers
        self.limitations = limitations
        self.blocked = blocked
        self.ancestor = ancestor
        self.handoff = handoff
        self.stats = stats
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        strategy = try c.decode(String.self, forKey: .strategy)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? ""
        source = try c.decode(Source.self, forKey: .source)
        destination = try c.decode(Destination.self, forKey: .destination)
        transfers = try c.decodeIfPresent([String].self, forKey: .transfers) ?? []
        limitations = try c.decodeIfPresent([PortableLimitation].self, forKey: .limitations) ?? []
        blocked = try c.decodeIfPresent(Blocked.self, forKey: .blocked)
        ancestor = try? c.decodeIfPresent(Ancestor.self, forKey: .ancestor)
        handoff = try? c.decodeIfPresent(Handoff.self, forKey: .handoff)
        stats = try? c.decodeIfPresent(Stats.self, forKey: .stats)
    }
}

/// One continuation (a lineage edge) and how far it got:
/// preparing → launching → delivering → linked, or failed (retry) / cancelled.
struct ContinueOperation: Codable, Equatable, Sendable, Identifiable {
    let id: String
    let kind: String
    let strategy: String
    let state: String
    let childUid: String?
    let parentUid: String?
    let fromHarness: String
    let toHarness: String
    /// The agents' names; a list of operations may leave them out (then the ids stand in).
    var fromName: String?
    var toName: String?
    var toHost: String?
    let error: String?
    var limitations: [PortableLimitation]?

    var isDone: Bool { state == "linked" || state == "failed" || state == "cancelled" }
}

struct ContinueStarted: Codable, Equatable, Sendable {
    let operation: ContinueOperation
    let existed: Bool
}

/// A conversation's whole family across agents (`GET …/lineage`).
struct PortableLineage: Codable, Equatable, Sendable {
    let root: String?
    let nodes: [Node]
    let edges: [Edge]

    struct Node: Codable, Equatable, Sendable, Identifiable {
        let conversationId: String
        let harness: String
        let harnessName: String?
        let title: String
        let host: String?
        let uids: [String]
        let current: Bool
        var id: String { conversationId }
    }

    struct Edge: Codable, Equatable, Sendable, Identifiable {
        let id: String
        let kind: String
        let strategy: String
        let state: String
        let parentId: String?
        let childId: String?
        let parentUid: String?
        let childUid: String?
        let fromName: String?
        let toName: String?
        var createdAt: Double?
    }
}

/// What the host can carry, per agent (`GET /api/portable/capabilities`).
struct PortableCapabilities: Codable, Equatable, Sendable {
    let version: Int
    let harnesses: [Harness]
    /// The host takes a destination's model, effort and mode with a continuation.
    var launchOptions: Bool?

    struct Harness: Codable, Equatable, Sendable {
        let id: String
        let name: String
        let available: Bool
        /// The host reads its transcripts: it can be the source of a continuation.
        let read: Bool
        let nativeResume: Bool
        let nativeFork: Bool
        let receive: Bool
        var notes: [String]?
    }
}
