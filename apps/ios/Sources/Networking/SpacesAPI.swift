import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Spaces (`apps/server/server/spaces`, feature `spaces` 1, docs/spec/17-spaces.md): where
// sessions belong. A repository, a folder, or a plain Space the host made in its Spaces
// folder, whose agents share one AGENTS.md (preferences) and one memory/. Removing one hides
// its conversations and archives a plain Space's folder; nothing is deleted.

/// In the state stream: when `revision` moves, `GET /api/spaces` has a new list.
struct SpacesStateDTO: Codable, Equatable, Sendable {
    var revision: Int
}

enum SpaceKind: String, Codable, Sendable {
    case space, repo, folder

    /// A kind a newer host adds reads as a folder: something sessions ran in.
    init(from decoder: any Decoder) throws {
        self = SpaceKind(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .folder
    }

    var label: String {
        switch self {
        case .space: "Space"
        case .repo: "Repository"
        case .folder: "Folder"
        }
    }
}

struct SpaceDTO: Codable, Equatable, Sendable, Identifiable {
    /// Stable server-side identifier (`sp-xxxxxxxx`, `spaces` 2); nil on older hosts.
    var serverId: String?
    var name: String
    var kind: SpaceKind
    /// Its primary folder, short (`~/spaces/Trips`); nil when no session says where it is.
    var path: String?
    /// Space-owned context directory (preferences, memory/, artifacts/), short path (`spaces` 2).
    var contextPath: String?
    /// Distinct folder/repo roots attached to sessions in this Space (`spaces` 2).
    var roots: [String]?
    var exists: Bool
    var live: Int
    var conversations: Int
    var lastActivityAt: Int
    var id: String { name }

    init(
        name: String,
        kind: SpaceKind,
        path: String? = nil,
        exists: Bool = true,
        live: Int = 0,
        conversations: Int = 0,
        lastActivityAt: Int = 0,
        serverId: String? = nil,
        contextPath: String? = nil,
        roots: [String]? = nil
    ) {
        self.serverId = serverId
        self.name = name
        self.kind = kind
        self.path = path
        self.contextPath = contextPath
        self.roots = roots
        self.exists = exists
        self.live = live
        self.conversations = conversations
        self.lastActivityAt = lastActivityAt
    }

    private enum CodingKeys: String, CodingKey {
        case serverId = "id"
        case name, kind, path, contextPath, roots, exists, live, conversations, lastActivityAt
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serverId = try? c.decodeIfPresent(String.self, forKey: .serverId)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decodeIfPresent(SpaceKind.self, forKey: .kind) ?? .folder
        path = try c.decodeIfPresent(String.self, forKey: .path)
        contextPath = try? c.decodeIfPresent(String.self, forKey: .contextPath)
        roots = try? c.decodeIfPresent([String].self, forKey: .roots)
        exists = try c.decodeIfPresent(Bool.self, forKey: .exists) ?? true
        live = try c.decodeIfPresent(Int.self, forKey: .live) ?? 0
        conversations = try c.decodeIfPresent(Int.self, forKey: .conversations) ?? 0
        lastActivityAt = try c.decodeIfPresent(Int.self, forKey: .lastActivityAt) ?? 0
    }
}

struct RemovedSpaceDTO: Codable, Equatable, Sendable, Identifiable {
    var name: String
    var kind: SpaceKind
    var path: String?
    var removedAt: Int
    var conversations: Int
    /// A plain Space's folder waits in the Spaces archive.
    var archived: Bool
    var id: String { name }

    private enum CodingKeys: String, CodingKey { case name, kind, path, removedAt, conversations, archived }

    init(name: String, kind: SpaceKind, path: String? = nil, removedAt: Int, conversations: Int = 0, archived: Bool = false) {
        self.name = name
        self.kind = kind
        self.path = path
        self.removedAt = removedAt
        self.conversations = conversations
        self.archived = archived
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decodeIfPresent(SpaceKind.self, forKey: .kind) ?? .folder
        path = try c.decodeIfPresent(String.self, forKey: .path)
        removedAt = try c.decodeIfPresent(Int.self, forKey: .removedAt) ?? 0
        conversations = try c.decodeIfPresent(Int.self, forKey: .conversations) ?? 0
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
    }
}

struct SpacesListDTO: Codable, Equatable, Sendable {
    /// The Spaces folder, short (`~/spaces`).
    var root: String
    var spaces: [SpaceDTO]
    var removed: [RemovedSpaceDTO]

    init(root: String = "~/spaces", spaces: [SpaceDTO] = [], removed: [RemovedSpaceDTO] = []) {
        self.root = root
        self.spaces = spaces
        self.removed = removed
    }

    private enum CodingKeys: String, CodingKey { case root, spaces, removed }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        root = try c.decodeIfPresent(String.self, forKey: .root) ?? "~/spaces"
        spaces = try c.decodeIfPresent([SpaceDTO].self, forKey: .spaces) ?? []
        removed = try c.decodeIfPresent([RemovedSpaceDTO].self, forKey: .removed) ?? []
    }
}

struct SpacePreferencesDTO: Codable, Equatable, Sendable {
    var text: String
    var file: String
    var updatedAt: Int
}

struct SpaceMemoryFileDTO: Codable, Equatable, Sendable, Identifiable {
    var name: String
    var text: String
    var bytes: Int
    var updatedAt: Int
    /// Over 256 KB: only the start came back, and saving keeps only that.
    var truncated: Bool?
    var id: String { name }
}

struct SpaceMemoryDTO: Codable, Equatable, Sendable {
    var files: [SpaceMemoryFileDTO]
}

struct SpaceCreatedDTO: Codable, Sendable { var space: SpaceDTO }
struct SpaceRemovedDTO: Codable, Sendable { var removed: RemovedSpaceDTO }
struct SpaceRestoredDTO: Codable, Sendable { var space: SpaceDTO? }
struct SpaceBriefDTO: Codable, Equatable, Sendable {
    let brief: String
    let space: String
    let contextPath: String?
}
struct SpaceArtifactDTO: Codable, Equatable, Sendable, Identifiable {
    let name: String
    let path: String
    let shortPath: String
    let bytes: Int
    let updatedAt: Int
    var id: String { name }
}
struct SpaceContextDTO: Codable, Equatable, Sendable {
    let space: String
    let kind: SpaceKind
    let path: String?
    let contextPath: String
    let memoryDir: String
    let artifactsDir: String
    let contextFile: String
    let roots: [String]
    let preferences: String
    let memoryIndex: String
    let artifacts: [SpaceArtifactDTO]
    let hasCustomContext: Bool
    let pointer: String
    let markdown: String
}
struct PromoteSpaceKnowledgeRequest: Encodable, Equatable, Sendable {
    var title: String
    var markdown: String
    var file: String? = nil
    var source: String? = nil
}
struct PromotedKnowledgeDTO: Codable, Equatable, Sendable {
    let file: SpaceMemoryFileDTO
    let index: SpaceMemoryFileDTO
}
struct SessionSpaceResponseDTO: Codable, Equatable, Sendable {
    let uid: String
    let space: String?
}

extension APIClient {
    func spaces() async throws -> SpacesListDTO { try await call("GET", "/api/spaces") }

    /// A plain Space in the host's Spaces folder; `preferences` is its whole AGENTS.md, or the host's starting text.
    func createSpace(_ name: String, preferences: String? = nil) async throws -> SpaceDTO {
        var body = ["name": name]
        if let preferences, !preferences.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { body["preferences"] = preferences }
        let made: SpaceCreatedDTO = try await call("POST", "/api/spaces", json: body)
        return made.space
    }

    func removeSpace(_ name: String) async throws -> RemovedSpaceDTO {
        let out: SpaceRemovedDTO = try await call("POST", "/api/spaces/remove", json: ["name": name])
        return out.removed
    }

    func restoreSpace(_ name: String) async throws -> SpaceDTO? {
        let out: SpaceRestoredDTO = try await call("POST", "/api/spaces/restore", json: ["name": name])
        return out.space
    }

    func spacePreferences(_ name: String) async throws -> SpacePreferencesDTO { try await call("GET", "/api/spaces/\(Self.enc(name))/preferences") }

    func putSpacePreferences(_ name: String, text: String, expectedUpdatedAt: Int? = nil) async throws -> SpacePreferencesDTO {
        struct Body: Encodable {
            let text: String
            let expectedUpdatedAt: Int?
        }
        return try await call("PUT", "/api/spaces/\(Self.enc(name))/preferences", json: Body(text: text, expectedUpdatedAt: expectedUpdatedAt))
    }

    func spaceMemory(_ name: String) async throws -> SpaceMemoryDTO { try await call("GET", "/api/spaces/\(Self.enc(name))/memory") }

    func putSpaceMemory(_ name: String, file: String, text: String, expectedUpdatedAt: Int? = nil) async throws -> SpaceMemoryFileDTO {
        struct Body: Encodable {
            let text: String
            let expectedUpdatedAt: Int?
        }
        return try await call("PUT", "/api/spaces/\(Self.enc(name))/memory/\(Self.enc(file))", json: Body(text: text, expectedUpdatedAt: expectedUpdatedAt))
    }

    func deleteSpaceMemory(_ name: String, file: String) async throws {
        try await perform("DELETE", "/api/spaces/\(Self.enc(name))/memory/\(Self.enc(file))")
    }

    func promoteSpaceKnowledge(_ name: String, _ body: PromoteSpaceKnowledgeRequest) async throws -> PromotedKnowledgeDTO {
        try await call("POST", "/api/spaces/\(Self.enc(name))/knowledge/promote", json: body)
    }

    func spaceContext(_ name: String) async throws -> SpaceContextDTO {
        try await call("GET", "/api/spaces/\(Self.enc(name))/context")
    }

    func spaceBrief(_ name: String, instructions: String? = nil) async throws -> SpaceBriefDTO {
        var query: [URLQueryItem] = []
        if let instructions, !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            query.append(URLQueryItem(name: "instructions", value: instructions))
        }
        return try await call("GET", "/api/spaces/\(Self.enc(name))/brief", query: query)
    }

    func setSessionSpace(_ uid: String, space: String?) async throws -> SessionSpaceResponseDTO {
        struct Body: Encodable {
            let space: String?
            func encode(to encoder: any Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                if let space { try c.encode(space, forKey: .space) } else { try c.encodeNil(forKey: .space) }
            }
            private enum CodingKeys: String, CodingKey { case space }
        }
        return try await call("PUT", "/api/sessions/\(Self.enc(uid))/space", json: Body(space: space))
    }
}
