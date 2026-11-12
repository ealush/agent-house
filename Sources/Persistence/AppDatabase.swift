import Foundation
import GRDB

/// The app's one local database: scene restoration journal, signed-in accounts (no
/// secrets), device preferences and an encrypted, bounded cache. Server-owned state is
/// never authoritative here. A `DatabasePool` (WAL) lets every window read while one writes.
final class AppDatabase: Sendable {
    let pool: DatabasePool

    /// `directory` nil: Application Support/AgentHub, excluded from backups, Data
    /// Protection until first unlock (the app needs it to restore after a reboot).
    init(directory: URL? = nil) throws {
        let root = try directory ?? AppDatabase.defaultDirectory()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: root.path)
        var excluded = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        #endif
        var configuration = Configuration()
        configuration.foreignKeysEnabled = true
        configuration.busyMode = .timeout(5)
        pool = try DatabasePool(path: root.appendingPathComponent("agenthub.sqlite").path, configuration: configuration)
        try AppDatabase.migrator.migrate(pool)
    }

    static func defaultDirectory() throws -> URL {
        try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            .appendingPathComponent("AgentHub", isDirectory: true)
    }

    /// Migration history is append-only: never edit or reorder a shipped migration.
    static var migrator: DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1.scene-journal") { db in
            try db.create(table: "sceneSnapshot") { t in
                t.primaryKey("sceneID", .text)
                t.column("payload", .blob).notNull()
            }
        }
        migrator.registerMigration("v2.accounts-preferences-cache") { db in
            try db.alter(table: "sceneSnapshot") { t in
                t.add(column: "savedAt", .double).notNull().defaults(to: 0)
            }
            try db.create(table: "account") { t in
                t.primaryKey("origin", .text)
                t.column("hostname", .text).notNull()
                t.column("deviceId", .text).notNull()
                t.column("label", .text).notNull()
                t.column("enrolledAt", .double).notNull()
                t.column("lastUsedAt", .double).notNull()
            }
            try db.create(table: "preference") { t in
                t.primaryKey("key", .text)
                t.column("value", .blob).notNull()
            }
            try db.create(table: "sessionSurface") { t in
                t.column("origin", .text).notNull()
                t.column("sessionKey", .text).notNull()
                t.column("surface", .text).notNull()
                t.column("updatedAt", .double).notNull()
                t.primaryKey(["origin", "sessionKey"])
            }
            try db.create(index: "sessionSurface_updatedAt", on: "sessionSurface", columns: ["updatedAt"])
            try db.create(table: "cacheEntry") { t in
                t.column("origin", .text).notNull()
                t.column("kind", .text).notNull()
                t.column("key", .text).notNull()
                t.column("sealed", .blob).notNull()
                t.column("size", .integer).notNull()
                t.column("updatedAt", .double).notNull()
                t.primaryKey(["origin", "kind", "key"])
            }
            try db.create(index: "cacheEntry_updatedAt", on: "cacheEntry", columns: ["updatedAt"])
        }
        return migrator
    }
}

// MARK: - Scene journal

/// One row per UIKit scene session (`persistentIdentifier`), written on every significant
/// navigation or layout change and on backgrounding, never only at termination.
struct SceneRepository: Sendable {
    let database: AppDatabase

    enum Failure: Error, Equatable { case unsupportedSnapshot }

    func load(sceneID: String) throws -> SceneSnapshot? {
        let data = try database.pool.read { db in
            try Data.fetchOne(db, sql: "SELECT payload FROM sceneSnapshot WHERE sceneID = ?", arguments: [sceneID])
        }
        guard let data else { return nil }
        let stored = try JSONDecoder().decode(SceneSnapshot.self, from: data)
        guard stored.sceneID == sceneID, let snapshot = stored.upgraded() else { throw Failure.unsupportedSnapshot }
        if let origin = snapshot.hostOrigin { _ = try HostEndpoint(origin, allowLoopback: true) }
        return snapshot
    }

    func save(_ snapshot: SceneSnapshot) throws {
        guard snapshot.version == SceneSnapshot.currentVersion else { throw Failure.unsupportedSnapshot }
        if let origin = snapshot.hostOrigin { _ = try HostEndpoint(origin, allowLoopback: true) }
        let data = try JSONEncoder().encode(snapshot)
        try database.pool.write { db in
            // A newer version written by a newer build is never overwritten by an older one.
            if let existing = try Data.fetchOne(db, sql: "SELECT payload FROM sceneSnapshot WHERE sceneID = ?", arguments: [snapshot.sceneID]),
               let version = (try? JSONDecoder().decode(VersionOnly.self, from: existing))?.version, version > SceneSnapshot.currentVersion {
                throw Failure.unsupportedSnapshot
            }
            try db.execute(
                sql: "INSERT INTO sceneSnapshot (sceneID, payload, savedAt) VALUES (?, ?, ?) ON CONFLICT(sceneID) DO UPDATE SET payload = excluded.payload, savedAt = excluded.savedAt",
                arguments: [snapshot.sceneID, data, snapshot.savedAt]
            )
        }
    }

    func remove(sceneID: String) throws {
        try database.pool.write { db in try db.execute(sql: "DELETE FROM sceneSnapshot WHERE sceneID = ?", arguments: [sceneID]) }
    }

    /// A new window with no journal of its own starts where the most recent one was.
    func mostRecent() throws -> SceneSnapshot? {
        let data = try database.pool.read { db in
            try Data.fetchOne(db, sql: "SELECT payload FROM sceneSnapshot ORDER BY savedAt DESC LIMIT 1")
        }
        return data.flatMap { try? JSONDecoder().decode(SceneSnapshot.self, from: $0) }.flatMap { $0.upgraded() }
    }

    private struct VersionOnly: Decodable { let version: Int }
}

// MARK: - Accounts (non-secret)

/// A host this device is enrolled with. The bearer secret is in the Keychain, never here.
struct Account: Codable, Equatable, Sendable, FetchableRecord, PersistableRecord {
    static let databaseTableName = "account"
    var origin: String
    var hostname: String
    var deviceId: String
    var label: String
    /// Seconds since the epoch.
    var enrolledAt: Double
    var lastUsedAt: Double

    var endpoint: HostEndpoint? { try? HostEndpoint(origin, allowLoopback: true) }
}

struct AccountRepository: Sendable {
    let database: AppDatabase

    func all() throws -> [Account] {
        try database.pool.read { db in try Account.order(Column("lastUsedAt").desc).fetchAll(db) }
    }

    func account(origin: String) throws -> Account? {
        try database.pool.read { db in try Account.fetchOne(db, key: origin) }
    }

    func save(_ account: Account) throws {
        try database.pool.write { db in try account.save(db) }
    }

    func touch(origin: String, at time: Double = Date().timeIntervalSince1970) throws {
        try database.pool.write { db in
            try db.execute(sql: "UPDATE account SET lastUsedAt = ? WHERE origin = ?", arguments: [time, origin])
        }
    }

    /// Signing out or a removed device: the account and everything cached for it go.
    func remove(origin: String) throws {
        try database.pool.write { db in
            _ = try Account.deleteOne(db, key: origin)
            try db.execute(sql: "DELETE FROM cacheEntry WHERE origin = ?", arguments: [origin])
            try db.execute(sql: "DELETE FROM sessionSurface WHERE origin = ?", arguments: [origin])
        }
    }
}
