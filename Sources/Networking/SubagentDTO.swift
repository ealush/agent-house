import Foundation

/// A session row's subagents, counted over the whole tree (nested ones too), from a host
/// with `features.subagents`. `rev` changes whenever anything in the tree does.
struct SubagentSummaryDTO: Codable, Equatable, Sendable {
    let total: Int
    let active: Int
    let completed: Int
    let failed: Int
    let rev: String
}

/// GET /api/sessions/:ref/subagents: the tree under a conversation (ah's docs/spec/16-subagents.md).
struct SubagentTreeDTO: Codable, Equatable, Sendable {
    let root: Root
    /// The child the tree was asked for by, when it was.
    let selfRef: String?
    let nodes: [SubagentNodeDTO]

    struct Root: Codable, Equatable, Sendable {
        /// "harness:id", the conversation's ref.
        let ref: String
        /// Its live window, while it runs.
        let uid: String?
        let title: String
        let live: Bool
    }

    private enum CodingKeys: String, CodingKey {
        case root, nodes
        case selfRef = "self"
    }

    init(root: Root, selfRef: String?, nodes: [SubagentNodeDTO]) {
        self.root = root
        self.selfRef = selfRef
        self.nodes = nodes
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        root = try c.decode(Root.self, forKey: .root)
        selfRef = try c.decodeIfPresent(String.self, forKey: .selfRef)
        // A child this build can't read is left out, never the whole tree.
        nodes = (try c.decodeIfPresent([Lenient<SubagentNodeDTO>].self, forKey: .nodes) ?? []).compactMap(\.value)
    }
}

struct SubagentNodeDTO: Codable, Equatable, Sendable, Identifiable {
    let ref: String
    let harness: String
    let agentId: String
    let parentRef: String
    let rootRef: String
    let depth: Int
    let name: String
    let role: String?
    let prompt: String?
    let state: State
    let background: Bool
    let startedAt: Double
    let updatedAt: Double
    let endedAt: Double?
    let activity: String?
    let toolCallId: String?
    let capabilities: Capabilities

    var id: String { ref }

    /// Where it is in its life. A state a newer host adds reads as `unknown`: never as running.
    enum State: String, Codable, Sendable {
        case running, waiting, completed, failed, canceled, unknown

        init(from decoder: any Decoder) throws {
            self = State(rawValue: (try? decoder.singleValueContainer().decode(String.self)) ?? "") ?? .unknown
        }

        var isActive: Bool { self == .running || self == .waiting }
    }

    /// Only what the host can carry out for that harness (verified there). Absent ones are no.
    struct Capabilities: Codable, Equatable, Sendable {
        let transcript: Bool
        let live: Bool
        let send: Bool
        let cancel: Bool
        let `continue`: Bool

        init(transcript: Bool = true, live: Bool = false, send: Bool = false, cancel: Bool = false, continue: Bool = false) {
            self.transcript = transcript
            self.live = live
            self.send = send
            self.cancel = cancel
            self.continue = `continue`
        }

        init(from decoder: any Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            transcript = (try? c.decodeIfPresent(Bool.self, forKey: .transcript)) ?? true
            live = (try? c.decodeIfPresent(Bool.self, forKey: .live)) ?? false
            send = (try? c.decodeIfPresent(Bool.self, forKey: .send)) ?? false
            cancel = (try? c.decodeIfPresent(Bool.self, forKey: .cancel)) ?? false
            `continue` = (try? c.decodeIfPresent(Bool.self, forKey: .`continue`)) ?? false
        }
    }

    init(ref: String, harness: String = "claude", agentId: String = "", parentRef: String, rootRef: String, depth: Int = 1, name: String, role: String? = nil, prompt: String? = nil, state: State, background: Bool = false, startedAt: Double = 0, updatedAt: Double = 0, endedAt: Double? = nil, activity: String? = nil, toolCallId: String? = nil, capabilities: Capabilities = Capabilities()) {
        self.ref = ref
        self.harness = harness
        self.agentId = agentId
        self.parentRef = parentRef
        self.rootRef = rootRef
        self.depth = depth
        self.name = name
        self.role = role
        self.prompt = prompt
        self.state = state
        self.background = background
        self.startedAt = startedAt
        self.updatedAt = updatedAt
        self.endedAt = endedAt
        self.activity = activity
        self.toolCallId = toolCallId
        self.capabilities = capabilities
    }

    private enum CodingKeys: String, CodingKey {
        case ref, harness, agentId, parentRef, rootRef, depth, name, role, prompt, state, background, startedAt, updatedAt, endedAt, activity, toolCallId, capabilities
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ref = try c.decode(String.self, forKey: .ref)
        guard SubagentKey.validRef(ref) else { throw DecodingError.dataCorruptedError(forKey: .ref, in: c, debugDescription: "not a session ref") }
        harness = try c.decodeIfPresent(String.self, forKey: .harness) ?? ""
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId) ?? ""
        parentRef = try c.decode(String.self, forKey: .parentRef)
        rootRef = try c.decodeIfPresent(String.self, forKey: .rootRef) ?? parentRef
        depth = max(1, try c.decodeIfPresent(Int.self, forKey: .depth) ?? 1)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? "Subagent"
        role = try c.decodeIfPresent(String.self, forKey: .role)
        prompt = try c.decodeIfPresent(String.self, forKey: .prompt)
        state = try c.decodeIfPresent(State.self, forKey: .state) ?? .unknown
        background = try c.decodeIfPresent(Bool.self, forKey: .background) ?? false
        startedAt = try c.decodeIfPresent(Double.self, forKey: .startedAt) ?? 0
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? startedAt
        endedAt = try c.decodeIfPresent(Double.self, forKey: .endedAt)
        activity = try c.decodeIfPresent(String.self, forKey: .activity)
        toolCallId = try c.decodeIfPresent(String.self, forKey: .toolCallId)
        capabilities = (try? c.decodeIfPresent(Capabilities.self, forKey: .capabilities)) ?? Capabilities()
    }
}

/// One element of a list, or nil when it can't be read: the rest of the list still is.
struct Lenient<T: Decodable & Sendable>: Decodable, Sendable {
    let value: T?

    init(from decoder: any Decoder) throws {
        value = try? T(from: decoder)
    }
}
