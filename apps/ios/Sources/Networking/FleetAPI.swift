import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Unidirectional supervision (`features.supervision` 1) and Fleet coordination (`features.fleet` 1..2):
// Chief of Staff metadata, prompt forwarding, Space-scoped tasks, and asynchronous mailbox
// (`apps/server/server/supervision.ts`, `apps/server/server/fleet/`).
// Every DTO here is pinned against real captured server answers in `packages/protocol/fixtures/`.

/// In the state stream (`fleet` 2): when `revision` moves, Space tasks or mailbox changed.
struct FleetStateDTO: Codable, Equatable, Sendable {
    var revision: Int
}

/// Update to a session's supervision metadata (`PUT /api/sessions/:uid/supervision`).
struct SupervisionPatch: Encodable, Equatable, Sendable {
    /// Tri-state field distinguishing omitting a field (`.keep`) from clearing it (`.clear` → `null`).
    enum Field<T: Encodable & Equatable & Sendable>: Equatable, Sendable {
        case keep
        case set(T)
        case clear
    }

    var role: Field<SessionRoleDTO> = .keep
    var managedBy: Field<String> = .keep
    var space: Field<String> = .keep
    var muteAlerts: Field<Bool> = .keep
    var escalateAfterSeconds: Field<Int> = .keep
    var tags: Field<[String]> = .keep

    private enum CodingKeys: String, CodingKey {
        case role, managedBy, space, muteAlerts, escalateAfterSeconds, tags
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try encodeField(role, key: .role, into: &c)
        try encodeField(managedBy, key: .managedBy, into: &c)
        try encodeField(space, key: .space, into: &c)
        try encodeField(muteAlerts, key: .muteAlerts, into: &c)
        try encodeField(escalateAfterSeconds, key: .escalateAfterSeconds, into: &c)
        try encodeField(tags, key: .tags, into: &c)
    }

    private func encodeField<V: Encodable>(_ field: Field<V>, key: CodingKeys, into c: inout KeyedEncodingContainer<CodingKeys>) throws {
        switch field {
        case .keep: break
        case .set(let v): try c.encode(v, forKey: key)
        case .clear: try c.encodeNil(forKey: key)
        }
    }
}

/// Answer to `PUT /api/sessions/:uid/supervision` (`packages/protocol/fixtures/supervision.json`).
struct SupervisionResponseDTO: Codable, Equatable, Sendable {
    let uid: String
    let supervision: SupervisionDTO?
}

/// Answer to `POST /api/sessions/:uid/forward` (`packages/protocol/fixtures/forward.json`).
struct ForwardPromptResponseDTO: Codable, Equatable, Sendable {
    let forwarded: Bool
    let uid: String
    let title: String
    let body: String
    let status: SessionDTO.Status?
    let ask: AskDTO?
    let askId: String?
    let answerable: Bool

    private enum CodingKeys: String, CodingKey {
        case forwarded, uid, title, body, status, ask, askId, answerable
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        forwarded = try c.decodeIfPresent(Bool.self, forKey: .forwarded) ?? true
        uid = try c.decode(String.self, forKey: .uid)
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        status = try? c.decodeIfPresent(SessionDTO.Status.self, forKey: .status)
        ask = try? c.decodeIfPresent(AskDTO.self, forKey: .ask)
        askId = try? c.decodeIfPresent(String.self, forKey: .askId)
        answerable = try c.decodeIfPresent(Bool.self, forKey: .answerable) ?? false
    }
}

/// Lifecycle status of a durable fleet task (`server/fleet/tasks.ts` `TASK_STATUSES`).
enum FleetTaskStatus: String, Codable, CaseIterable, Equatable, Hashable, Sendable {
    case todo
    case inProgress = "in_progress"
    case blocked
    case inReview = "in_review"
    case done
    case cancelled

    init(from decoder: any Decoder) throws {
        self = FleetTaskStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .todo
    }

    var label: String {
        switch self {
        case .todo: "To do"
        case .inProgress: "In progress"
        case .blocked: "Blocked"
        case .inReview: "In review"
        case .done: "Done"
        case .cancelled: "Cancelled"
        }
    }

    var symbol: String {
        switch self {
        case .todo: "circle"
        case .inProgress: "circle.lefthalf.filled"
        case .blocked: "exclamationmark.octagon"
        case .inReview: "eye"
        case .done: "checkmark.circle.fill"
        case .cancelled: "xmark.circle"
        }
    }
}

/// Last verification command result recorded on a fleet task (`server/fleet/tasks.ts` `VerifyRecord`).
struct FleetVerifyRecordDTO: Codable, Equatable, Hashable, Sendable {
    let at: Double
    let command: String
    let exitCode: Int
    let ok: Bool
    let output: String?
}

/// Durable fleet task (`packages/protocol/fixtures/fleet-task.json`).
struct FleetTaskDTO: Codable, Equatable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
    let description: String
    let status: FleetTaskStatus
    /// 0 (Urgent) .. 3 (Low)
    let priority: Int
    let ownerUid: String?
    let assignedUid: String?
    let space: String?
    let checkoutId: String?
    let dependsOn: [String]
    let verifyCmd: String?
    let lastVerify: FleetVerifyRecordDTO?
    let result: String?
    let createdAt: Double
    let updatedAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, title, description, status, priority, ownerUid, assignedUid, space
        case checkoutId, dependsOn, verifyCmd, lastVerify, result, createdAt, updatedAt
    }

    init(
        id: String, title: String, description: String = "", status: FleetTaskStatus = .todo,
        priority: Int = 2, ownerUid: String? = nil, assignedUid: String? = nil,
        space: String? = nil, checkoutId: String? = nil, dependsOn: [String] = [],
        verifyCmd: String? = nil, lastVerify: FleetVerifyRecordDTO? = nil,
        result: String? = nil, createdAt: Double = 0, updatedAt: Double = 0
    ) {
        self.id = id
        self.title = title
        self.description = description
        self.status = status
        self.priority = priority
        self.ownerUid = ownerUid
        self.assignedUid = assignedUid
        self.space = space
        self.checkoutId = checkoutId
        self.dependsOn = dependsOn
        self.verifyCmd = verifyCmd
        self.lastVerify = lastVerify
        self.result = result
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        description = try c.decodeIfPresent(String.self, forKey: .description) ?? ""
        status = try c.decodeIfPresent(FleetTaskStatus.self, forKey: .status) ?? .todo
        priority = try c.decodeIfPresent(Int.self, forKey: .priority) ?? 2
        ownerUid = try c.decodeIfPresent(String.self, forKey: .ownerUid)
        assignedUid = try c.decodeIfPresent(String.self, forKey: .assignedUid)
        space = try c.decodeIfPresent(String.self, forKey: .space)
        checkoutId = try c.decodeIfPresent(String.self, forKey: .checkoutId)
        dependsOn = (try? c.decodeIfPresent([String].self, forKey: .dependsOn)) ?? []
        verifyCmd = try c.decodeIfPresent(String.self, forKey: .verifyCmd)
        lastVerify = try? c.decodeIfPresent(FleetVerifyRecordDTO.self, forKey: .lastVerify)
        result = try c.decodeIfPresent(String.self, forKey: .result)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
    }
}

struct FleetTasksResponseDTO: Codable, Equatable, Sendable {
    let tasks: [FleetTaskDTO]
}

struct CreateFleetTaskRequest: Encodable, Equatable, Sendable {
    var title: String
    var description: String? = nil
    var status: FleetTaskStatus? = nil
    var priority: Int? = nil
    var assignedUid: String? = nil
    var space: String? = nil
    var checkoutId: String? = nil
    var dependsOn: [String]? = nil
    var verifyCmd: String? = nil
}

struct UpdateFleetTaskRequest: Encodable, Equatable, Sendable {
    var title: String? = nil
    var description: String? = nil
    var status: FleetTaskStatus? = nil
    var priority: Int? = nil
    var assignedUid: String? = nil
    var space: String? = nil
    var verifyCmd: String? = nil
    var result: String? = nil
}

/// Cross-session mail kind (`server/fleet/mailbox.ts` `MAIL_KINDS`).
enum FleetMailKind: String, Codable, Equatable, Hashable, Sendable {
    case message, directive, report, blocker, handoff

    init(from decoder: any Decoder) throws {
        self = FleetMailKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .message
    }
}

/// Durable cross-session mail message (`packages/protocol/fixtures/fleet-mail.json`).
struct FleetMailDTO: Codable, Equatable, Hashable, Sendable, Identifiable {
    let id: String
    let fromUid: String?
    let toUid: String
    let threadId: String?
    let kind: FleetMailKind
    let subject: String
    let body: String
    let readAt: Double?
    let ackedAt: Double?
    let createdAt: Double

    private enum CodingKeys: String, CodingKey {
        case id, fromUid, toUid, threadId, kind, subject, body, readAt, ackedAt, createdAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        fromUid = try c.decodeIfPresent(String.self, forKey: .fromUid)
        toUid = try c.decode(String.self, forKey: .toUid)
        threadId = try c.decodeIfPresent(String.self, forKey: .threadId)
        kind = try c.decodeIfPresent(FleetMailKind.self, forKey: .kind) ?? .message
        subject = try c.decodeIfPresent(String.self, forKey: .subject) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        readAt = try c.decodeIfPresent(Double.self, forKey: .readAt)
        ackedAt = try c.decodeIfPresent(Double.self, forKey: .ackedAt)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? 0
    }
}

struct FleetMailboxResponseDTO: Codable, Equatable, Sendable {
    let messages: [FleetMailDTO]
}

struct SendFleetMailRequest: Encodable, Equatable, Sendable {
    var toUid: String
    var kind: FleetMailKind = .message
    var subject: String = ""
    var body: String
    var threadId: String? = nil
    var wake: Bool? = nil
}

extension APIClient {
    // MARK: Supervision (`features.supervision` 1)

    func setSupervision(_ uid: String, patch: SupervisionPatch) async throws -> SupervisionResponseDTO {
        try await call("PUT", "/api/sessions/\(Self.enc(uid))/supervision", json: patch)
    }

    func forwardPrompt(_ uid: String, title: String? = nil, note: String? = nil) async throws -> ForwardPromptResponseDTO {
        struct Body: Encodable { let title: String?; let note: String? }
        return try await call("POST", "/api/sessions/\(Self.enc(uid))/forward", json: Body(title: title, note: note))
    }

    // MARK: Fleet task ledger (`features.fleet` 1..2)

    func fleetTasks(space: String? = nil, status: FleetTaskStatus? = nil, assigned: String? = nil) async throws -> [FleetTaskDTO] {
        var query: [URLQueryItem] = []
        if let space, !space.isEmpty { query.append(URLQueryItem(name: "space", value: space)) }
        if let status { query.append(URLQueryItem(name: "status", value: status.rawValue)) }
        if let assigned, !assigned.isEmpty { query.append(URLQueryItem(name: "assigned", value: assigned)) }
        let res: FleetTasksResponseDTO = try await call("GET", "/api/fleet/tasks", query: query)
        return res.tasks
    }

    func fleetTask(_ id: String) async throws -> FleetTaskDTO {
        try await call("GET", "/api/fleet/tasks/\(Self.enc(id))")
    }

    func createFleetTask(_ body: CreateFleetTaskRequest) async throws -> FleetTaskDTO {
        try await call("POST", "/api/fleet/tasks", json: body)
    }

    func updateFleetTask(_ id: String, _ body: UpdateFleetTaskRequest) async throws -> FleetTaskDTO {
        try await call("PATCH", "/api/fleet/tasks/\(Self.enc(id))", json: body)
    }

    func deleteFleetTask(_ id: String) async throws {
        try await perform("DELETE", "/api/fleet/tasks/\(Self.enc(id))")
    }

    // MARK: Fleet mailbox (`features.fleet` 1..2)

    func fleetMail(to: String? = nil, unread: Bool = false) async throws -> [FleetMailDTO] {
        var query: [URLQueryItem] = []
        if let to, !to.isEmpty { query.append(URLQueryItem(name: "to", value: to)) }
        if unread { query.append(URLQueryItem(name: "unread", value: "1")) }
        let res: FleetMailboxResponseDTO = try await call("GET", "/api/fleet/mailbox", query: query)
        return res.messages
    }

    func fleetMailItem(_ id: String) async throws -> FleetMailDTO {
        try await call("GET", "/api/fleet/mailbox/\(Self.enc(id))")
    }

    func sendFleetMail(_ body: SendFleetMailRequest) async throws -> FleetMailDTO {
        try await call("POST", "/api/fleet/mailbox", json: body)
    }

    func ackFleetMail(_ id: String) async throws -> FleetMailDTO {
        try await call("POST", "/api/fleet/mailbox/\(Self.enc(id))/ack")
    }

    func deleteFleetMail(_ id: String) async throws {
        try await perform("DELETE", "/api/fleet/mailbox/\(Self.enc(id))")
    }
}
