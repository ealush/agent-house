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
    var name: String
    var kind: SpaceKind
    /// Its folder, short (`~/spaces/Trips`); nil when no session says where it is.
    var path: String?
    var exists: Bool
    var live: Int
    var conversations: Int
    var lastActivityAt: Int
    var id: String { name }

    init(name: String, kind: SpaceKind, path: String? = nil, exists: Bool = true, live: Int = 0, conversations: Int = 0, lastActivityAt: Int = 0) {
        self.name = name
        self.kind = kind
        self.path = path
        self.exists = exists
        self.live = live
        self.conversations = conversations
        self.lastActivityAt = lastActivityAt
    }

    private enum CodingKeys: String, CodingKey { case name, kind, path, exists, live, conversations, lastActivityAt }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        kind = try c.decodeIfPresent(SpaceKind.self, forKey: .kind) ?? .folder
        path = try c.decodeIfPresent(String.self, forKey: .path)
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

    func putSpacePreferences(_ name: String, text: String) async throws -> SpacePreferencesDTO {
        try await call("PUT", "/api/spaces/\(Self.enc(name))/preferences", json: ["text": text])
    }

    func spaceMemory(_ name: String) async throws -> SpaceMemoryDTO { try await call("GET", "/api/spaces/\(Self.enc(name))/memory") }

    func putSpaceMemory(_ name: String, file: String, text: String) async throws -> SpaceMemoryFileDTO {
        try await call("PUT", "/api/spaces/\(Self.enc(name))/memory/\(Self.enc(file))", json: ["text": text])
    }

    func deleteSpaceMemory(_ name: String, file: String) async throws {
        try await perform("DELETE", "/api/spaces/\(Self.enc(name))/memory/\(Self.enc(file))")
    }
}
