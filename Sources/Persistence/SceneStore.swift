import Foundation
import GRDB

/// One process-wide journal, with an independent row for each UIKit scene.
actor SceneStore {
    private var database: DatabasePool?
    private let directory: URL?

    init(directory: URL? = nil) {
        self.directory = directory
    }

    private func open() throws -> DatabasePool {
        if let database { return database }
        let root: URL
        if let directory {
            root = directory
        } else {
            root = try FileManager.default.url(
                for: .applicationSupportDirectory,
                in: .userDomainMask,
                appropriateFor: nil,
                create: true
            ).appendingPathComponent("SceneJournal", isDirectory: true)
        }
        try FileManager.default.createDirectory(
            at: root,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var excludedRoot = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excludedRoot.setResourceValues(values)

        let pool = try DatabasePool(path: root.appendingPathComponent("scenes.sqlite").path)
        var migrator = DatabaseMigrator()
        migrator.registerMigration("v1.scene-journal") { db in
            try db.create(table: "sceneSnapshot") { table in
                table.primaryKey("sceneID", .text)
                table.column("payload", .blob).notNull()
            }
        }
        try migrator.migrate(pool)
        database = pool
        return pool
    }

    func load(sceneID: String) throws -> SceneSnapshot? {
        let database = try open()
        let data = try database.read { db in
            try Data.fetchOne(db, sql: "SELECT payload FROM sceneSnapshot WHERE sceneID = ?", arguments: [sceneID])
        }
        guard let data else { return nil }
        let snapshot = try JSONDecoder().decode(SceneSnapshot.self, from: data)
        guard snapshot.version == SceneSnapshot.currentVersion, snapshot.sceneID == sceneID else {
            throw StoreError.unsupportedSnapshot
        }
        if let host = snapshot.hostOrigin { _ = try HostEndpoint(host) }
        return snapshot
    }

    func save(_ snapshot: SceneSnapshot) throws {
        guard snapshot.version == SceneSnapshot.currentVersion else { throw StoreError.unsupportedSnapshot }
        if let host = snapshot.hostOrigin { _ = try HostEndpoint(host) }
        let data = try JSONEncoder().encode(snapshot)
        try open().write { db in
            try db.execute(
                sql: """
                    INSERT INTO sceneSnapshot (sceneID, payload) VALUES (?, ?)
                    ON CONFLICT(sceneID) DO UPDATE SET payload = excluded.payload
                    """,
                arguments: [snapshot.sceneID, data]
            )
        }
    }

    func remove(sceneID: String) throws {
        try open().write { db in
            try db.execute(sql: "DELETE FROM sceneSnapshot WHERE sceneID = ?", arguments: [sceneID])
        }
    }

    enum StoreError: Error {
        case unsupportedSnapshot
    }
}

