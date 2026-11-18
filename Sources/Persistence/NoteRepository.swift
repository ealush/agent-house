import Foundation
import GRDB

/// Where a note is filed: a folder on a host, as reached through one account. The host's
/// name is part of the identity: the same folder name on two machines is two projects.
/// Metadata only; nothing is written there.
struct NoteProject: Codable, Equatable, Hashable, Sendable {
    /// The account (hub origin) the host is reached through; nil when it isn't known yet.
    var origin: String?
    var host: String
    var path: String

    var name: String {
        let tail = path.split(separator: "/").last.map(String.init) ?? path
        return tail.isEmpty ? path : tail
    }
}

/// The host's version of a note when it and this device's changed apart: both are kept
/// until the person chooses.
struct NoteConflict: Codable, Equatable, Sendable {
    var title: String
    var markdown: String
    var revision: Int
    var writer: String
    var at: Double
    /// The host deleted it while this device was changing it.
    var deleted: Bool
}

/// A scratchpad as this device keeps it. The text is authoritative here: every edit is
/// written to this row before anything is sent anywhere.
struct Note: Codable, Equatable, Sendable, Identifiable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "note"

    var id: String
    /// Typed by the person; empty means "use the first line".
    var title: String
    var markdown: String
    var projectOrigin: String?
    var projectHost: String?
    var projectPath: String?
    /// The account it syncs with; nil keeps it on this device only.
    var syncOrigin: String?
    /// The host's revision this device's text was last in step with (0: never).
    var revision: Int
    /// This device's count of changes; a hand-off records which one went.
    var version: Int
    /// The version the host has. Behind `version` means changes still to send.
    var syncedVersion: Int
    /// The id of the write being sent, kept across retries until the host takes it.
    var writeId: String?
    /// Deleted here, the host not told yet (a synced note); a local one is just removed.
    var deletedAt: Double?
    var conflictJson: String?
    var syncError: String?
    var exportsJson: String
    /// Seconds since the epoch.
    var createdAt: Double
    var updatedAt: Double
    /// Where the editor was: the selection (UTF-16) and how far it was scrolled.
    var selectionStart: Int
    var selectionLength: Int
    var scrollOffset: Double
    var preview: Bool

    init(id: String = NoteKey.newID(), title: String = "", markdown: String = "", project: NoteProject? = nil, syncOrigin: String? = nil, now: Double = Date().timeIntervalSince1970) {
        self.id = id
        self.title = title
        self.markdown = markdown
        projectOrigin = project?.origin
        projectHost = project?.host
        projectPath = project?.path
        self.syncOrigin = syncOrigin
        revision = 0
        version = 1
        syncedVersion = 0
        writeId = nil
        deletedAt = nil
        conflictJson = nil
        syncError = nil
        exportsJson = "[]"
        createdAt = now
        updatedAt = now
        selectionStart = 0
        selectionLength = 0
        scrollOffset = 0
        preview = false
    }

    var key: String { NoteKey.key(id) }

    var project: NoteProject? {
        get { projectHost.flatMap { host in projectPath.map { NoteProject(origin: projectOrigin, host: host, path: $0) } } }
        set {
            projectOrigin = newValue?.origin
            projectHost = newValue?.host
            projectPath = newValue?.path
        }
    }

    var conflict: NoteConflict? {
        get { conflictJson.flatMap { try? JSONDecoder().decode(NoteConflict.self, from: Data($0.utf8)) } }
        set { conflictJson = newValue.flatMap { try? JSONEncoder().encode($0) }.map { String(decoding: $0, as: UTF8.self) } }
    }

    var exports: [NoteExportDTO] {
        get { (try? JSONDecoder().decode([NoteExportDTO].self, from: Data(exportsJson.utf8))) ?? [] }
        set { exportsJson = (try? JSONEncoder().encode(newValue)).map { String(decoding: $0, as: UTF8.self) } ?? "[]" }
    }

    /// What lists show: the title typed, else the first line of text (without a heading's #).
    var shownTitle: String {
        let typed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return typed }
        return Note.firstLine(markdown) ?? "Untitled Note"
    }

    static func firstLine(_ markdown: String) -> String? {
        for raw in markdown.split(separator: "\n", omittingEmptySubsequences: true).prefix(20) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            while line.hasPrefix("#") { line.removeFirst() }
            for marker in ["- [ ] ", "- [x] ", "- ", "* ", "> "] where line.hasPrefix(marker) { line.removeFirst(marker.count) }
            line = line.trimmingCharacters(in: .whitespaces)
            if !line.isEmpty, line != "```" { return String(line.prefix(80)) }
        }
        return nil
    }

    /// Changes the host hasn't taken yet.
    var hasUnsyncedChanges: Bool { syncOrigin != nil && (version != syncedVersion || deletedAt != nil) }
}

/// The device's notes in GRDB. Every call is a short write; callers keep the newest text in
/// memory and write it here within a moment of each change (and at once on backgrounding).
struct NoteRepository: Sendable {
    let database: AppDatabase

    /// Every note not deleted, newest first.
    func all() throws -> [Note] {
        try database.pool.read { db in try Note.filter(Column("deletedAt") == nil).order(Column("createdAt").desc).fetchAll(db) }
    }

    /// Including deletions the host hasn't been told of.
    func everything() throws -> [Note] {
        try database.pool.read { db in try Note.fetchAll(db) }
    }

    func note(_ id: String) throws -> Note? {
        try database.pool.read { db in try Note.fetchOne(db, key: id) }
    }

    func save(_ note: Note) throws {
        try database.pool.write { db in try note.save(db) }
    }

    func save(_ notes: [Note]) throws {
        try database.pool.write { db in for note in notes { try note.save(db) } }
    }

    func remove(_ id: String) throws {
        try database.pool.write { db in _ = try Note.deleteOne(db, key: id) }
    }

    func cursor(origin: String) throws -> Int {
        try database.pool.read { db in try Int.fetchOne(db, sql: "SELECT cursor FROM noteCursor WHERE origin = ?", arguments: [origin]) } ?? 0
    }

    func setCursor(_ cursor: Int, origin: String) throws {
        try database.pool.write { db in
            try db.execute(sql: "INSERT INTO noteCursor (origin, cursor) VALUES (?, ?) ON CONFLICT(origin) DO UPDATE SET cursor = excluded.cursor", arguments: [origin, cursor])
        }
    }

    // MARK: Hand-offs

    func saveHandoff(_ h: NoteHandoffRecord) throws {
        try database.pool.write { db in try h.save(db) }
    }

    func handoffs(noteId: String) throws -> [NoteHandoffRecord] {
        try database.pool.read { db in try NoteHandoffRecord.filter(Column("noteId") == noteId).order(Column("createdAt").desc).limit(20).fetchAll(db) }
    }
}

/// One hand-off of a note to an agent session, kept so a retry reuses its id (the host
/// answers a repeated id without sending again) and so the note can say what went where.
struct NoteHandoffRecord: Codable, Equatable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "noteHandoff"
    enum State: String, Codable, Sendable { case sending, delivered, queued, uncertain, failed }

    var id: String
    var noteId: String
    var version: Int
    var targetKey: String
    var origin: String
    var state: State
    /// Exactly what went (the note's text, or an uploaded file's path): a retry sends this.
    var sentText: String
    var detail: String?
    var createdAt: Double
}
