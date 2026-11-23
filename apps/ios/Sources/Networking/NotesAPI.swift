import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Scratchpads on the host (`docs/spec/15-scratchpads.md`, feature `notes` 1). Writes
// name the revision they were made on; a refusal (409) carries the host's version, so this
// client reads refusals' bodies instead of only their message.

struct NoteProjectDTO: Codable, Equatable, Sendable, Hashable {
    var host: String
    var path: String
}

struct NoteExportDTO: Codable, Equatable, Sendable, Hashable {
    var host: String
    var path: String
    var revision: Int
    var at: Double
}

/// A session the note started (`start`) or was handed to (`handoff`), as the host keeps it
/// (`notes` 2, SCR-8): `host` is the session's host's name, `title` the session's then.
struct NoteSessionDTO: Codable, Equatable, Sendable, Hashable {
    var uid: String
    var host: String
    var title: String
    var via: String
    var at: Double
}

struct NoteDTO: Codable, Equatable, Sendable {
    var id: String
    var title: String
    var markdown: String
    var project: NoteProjectDTO?
    var revision: Int
    var seq: Int
    var writer: String
    var createdAt: Double
    var updatedAt: Double
    var deleted: Bool
    var exports: [NoteExportDTO]
    /// Newest first; nil from a host before `notes` 2.
    var sessions: [NoteSessionDTO]? = nil
}

struct NotesStateDTO: Codable, Equatable, Sendable {
    var cursor: Int
    var count: Int
}

struct NotesPage: Decodable, Sendable {
    var notes: [NoteDTO]
    var cursor: Int
    var more: Bool
}

/// What the host said when it didn't do it: `code` is its stable reason.
struct NoteRefusal: Decodable, Equatable, Sendable, Error {
    var status: Int
    var error: String
    var code: String?
    var note: NoteDTO?
    var suggestion: String?

    private enum CodingKeys: String, CodingKey { case error, code, note, suggestion }

    init(status: Int, error: String, code: String? = nil, note: NoteDTO? = nil, suggestion: String? = nil) {
        self.status = status
        self.error = error
        self.code = code
        self.note = note
        self.suggestion = suggestion
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = 0
        error = try c.decodeIfPresent(String.self, forKey: .error) ?? "refused"
        code = try c.decodeIfPresent(String.self, forKey: .code)
        note = try? c.decodeIfPresent(NoteDTO.self, forKey: .note)
        suggestion = try c.decodeIfPresent(String.self, forKey: .suggestion)
    }
}

struct NoteWriteBody: Encodable, Sendable {
    var baseRevision: Int
    var writeId: String
    var title: String
    var markdown: String
    /// nil clears the project (encoded as null, not left out).
    var project: NoteProjectDTO?
    var createdAt: Double

    private enum CodingKeys: String, CodingKey { case baseRevision, writeId, title, markdown, project, createdAt }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(baseRevision, forKey: .baseRevision)
        try c.encode(writeId, forKey: .writeId)
        try c.encode(title, forKey: .title)
        try c.encode(markdown, forKey: .markdown)
        if let project { try c.encode(project, forKey: .project) } else { try c.encodeNil(forKey: .project) }
        try c.encode(Int(createdAt), forKey: .createdAt)
    }
}

struct NoteExportBody: Encodable, Sendable {
    var dir: String
    var path: String
    var markdown: String
    var replace: Bool
    var noteId: String?
    var revision: Int?
}

struct NoteExportResult: Decodable, Equatable, Sendable {
    var path: String
    var bytes: Int
    var replaced: Bool
}

/// A session started from a note (`notes` 2): one on another host names it and its title.
struct NoteSessionBody: Encodable, Sendable {
    var uid: String
    var host: String?
    var title: String?
}

struct NoteHandoffBody: Encodable, Sendable {
    var id: String
    var noteId: String
    var revision: Int
    var target: String
    var text: String
    var resend: Bool
}

struct NoteHandoffResult: Decodable, Equatable, Sendable {
    enum Outcome: String, Decodable, Sendable { case delivered, queued, uncertain, failed }
    var id: String
    var outcome: Outcome
    var queueId: String?
    var resumed: Bool
    var error: String?
    var replay: Bool
}

/// A note route's answer: what was asked for, or the host's refusal with its reasons.
enum NoteAnswer<T: Sendable>: Sendable {
    case ok(T)
    case refused(NoteRefusal)
}

extension APIClient {
    private func noteExchange<T: Decodable & Sendable>(_ method: String, _ path: String, query: [URLQueryItem] = [], json: (any Encodable)? = nil, as type: T.Type) async throws -> NoteAnswer<T> {
        let body = try json.map { try JSONEncoder().encode(AnyEncodable($0)) }
        let (status, data) = try await exchange(await request(method, path, query: query, body: body))
        if (200..<300).contains(status) {
            do {
                return .ok(try JSONDecoder().decode(T.self, from: data))
            } catch {
                throw APIError.decoding(String(describing: error))
            }
        }
        // A refusal with a reason is the host's answer; anything else (a gate, a fault, an
        // older host without these routes) stays an error.
        if (400..<500).contains(status), status != 403, var refusal = try? JSONDecoder().decode(NoteRefusal.self, from: data), refusal.code != nil {
            refusal.status = status
            return .refused(refusal)
        }
        throw APIError(status: status, body: data)
    }

    func notes(since: Int, limit: Int = 200) async throws -> NotesPage {
        try await call("GET", "/api/notes", query: [URLQueryItem(name: "since", value: String(since)), URLQueryItem(name: "limit", value: String(limit))])
    }

    func putNote(_ id: String, _ body: NoteWriteBody) async throws -> NoteAnswer<NoteDTO> {
        try await noteExchange("PUT", "/api/notes/\(id)", json: body, as: NoteDTO.self)
    }

    func deleteNote(_ id: String, baseRevision: Int, writeId: String) async throws -> NoteAnswer<NoteDTO> {
        try await noteExchange("DELETE", "/api/notes/\(id)", query: [URLQueryItem(name: "baseRevision", value: String(baseRevision)), URLQueryItem(name: "writeId", value: writeId)], as: NoteDTO.self)
    }

    func exportNote(_ body: NoteExportBody) async throws -> NoteAnswer<NoteExportResult> {
        try await noteExchange("POST", "/api/notes/export", json: body, as: NoteExportResult.self)
    }

    func handOff(_ body: NoteHandoffBody) async throws -> NoteAnswer<NoteHandoffResult> {
        try await noteExchange("POST", "/api/notes/handoffs", json: body, as: NoteHandoffResult.self)
    }

    func noteSession(_ noteId: String, _ body: NoteSessionBody) async throws -> NoteAnswer<NoteDTO> {
        try await noteExchange("POST", "/api/notes/\(noteId)/sessions", json: body, as: NoteDTO.self)
    }
}
