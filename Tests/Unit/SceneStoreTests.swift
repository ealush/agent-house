import Foundation
import Testing
import GRDB
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

private func temporaryDatabase() throws -> (AppDatabase, URL) {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    return (try AppDatabase(directory: root), root)
}

@Test func sceneJournalSurvivesReopeningAndKeepsWindowsIndependent() throws {
    let (database, root) = try temporaryDatabase()
    defer { try? FileManager.default.removeItem(at: root) }
    var first = SceneSnapshot(sceneID: "window-a", hostOrigin: "https://one.example.ts.net", route: .review(ReviewRoute(stack: "stack1", pr: 12)))
    first.session = .init(key: "u1", surface: .terminal, panel: .diff, scroll: .init(seq: 40, offset: 12), composerFocused: true)
    first.workspaces = Workspaces(current: 3, slots: [3: .init(layout: .split(direction: .horizontal, ratio: 0.3, first: .session("u1"), second: .session("peer/u2")), selected: nil)])
    first.focusedPane = [.second]
    let second = SceneSnapshot(sceneID: "window-b", hostOrigin: "https://two.example.ts.net", route: .history, historyFilter: "auth")
    let journal = SceneRepository(database: database)
    try journal.save(first)
    try journal.save(second)
    let reopened = SceneRepository(database: try AppDatabase(directory: root))
    #expect(try reopened.load(sceneID: "window-a") == first)
    #expect(try reopened.load(sceneID: "window-b") == second)
    try reopened.remove(sceneID: "window-a")
    #expect(try reopened.load(sceneID: "window-a") == nil)
    #expect(try reopened.load(sceneID: "window-b") == second)
    #expect(try reopened.mostRecent()?.sceneID == "window-b")
}

@Test func rejectsFutureSnapshotVersionsWithoutErasingThemAndUpgradesV1() throws {
    let (database, root) = try temporaryDatabase()
    defer { try? FileManager.default.removeItem(at: root) }
    let journal = SceneRepository(database: database)
    // A row a future build wrote: refused on read, never overwritten.
    let future = Data(#"{"version":999,"sceneID":"a","hostOrigin":null}"#.utf8)
    try database.pool.write { db in try db.execute(sql: "INSERT INTO sceneSnapshot (sceneID, payload) VALUES ('a', ?)", arguments: [future]) }
    #expect(throws: SceneRepository.Failure.self) { try journal.load(sceneID: "a") }
    #expect(throws: SceneRepository.Failure.self) { try journal.save(SceneSnapshot(sceneID: "a", hostOrigin: nil)) }
    let kept = try database.pool.read { db in try Data.fetchOne(db, sql: "SELECT payload FROM sceneSnapshot WHERE sceneID = 'a'") }
    #expect(kept == future)
    // The scaffold's v1 rows (host only) come back as v2 at their defaults.
    let v1 = Data(#"{"version":1,"sceneID":"b","hostOrigin":"https://one.example.ts.net"}"#.utf8)
    try database.pool.write { db in try db.execute(sql: "INSERT INTO sceneSnapshot (sceneID, payload) VALUES ('b', ?)", arguments: [v1]) }
    let upgraded = try #require(try journal.load(sceneID: "b"))
    #expect(upgraded.version == 2 && upgraded.route == .inbox && upgraded.hostOrigin == "https://one.example.ts.net")
}

@Test func migrationsRunFromTheScaffoldsV1Journal() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    // A database exactly as the scaffold left it: only v1 applied.
    do {
        let pool = try DatabasePool(path: root.appendingPathComponent("agenthub.sqlite").path)
        var v1 = DatabaseMigrator()
        v1.registerMigration("v1.scene-journal") { db in
            try db.create(table: "sceneSnapshot") { t in
                t.primaryKey("sceneID", .text)
                t.column("payload", .blob).notNull()
            }
        }
        try v1.migrate(pool)
        try pool.write { db in try db.execute(sql: "INSERT INTO sceneSnapshot VALUES ('w', ?)", arguments: [Data(#"{"version":1,"sceneID":"w","hostOrigin":null}"#.utf8)]) }
    }
    let database = try AppDatabase(directory: root)
    let applied = try database.pool.read { db in try AppDatabase.migrator.appliedMigrations(db) }
    #expect(applied == ["v1.scene-journal", "v2.accounts-preferences-cache", "v3.notes"])
    #expect(try SceneRepository(database: database).load(sceneID: "w")?.version == 2)
}

@Test func accountsHoldNoSecretsAndRemovingOneClearsItsCache() throws {
    let (database, root) = try temporaryDatabase()
    defer { try? FileManager.default.removeItem(at: root) }
    let accounts = AccountRepository(database: database)
    try accounts.save(Account(origin: "https://box.example.ts.net", hostname: "box", deviceId: "d1", label: "iPhone", enrolledAt: 1, lastUsedAt: 1))
    try accounts.save(Account(origin: "https://lab.example.ts.net", hostname: "lab", deviceId: "d2", label: "iPhone", enrolledAt: 1, lastUsedAt: 5))
    #expect(try accounts.all().map(\.hostname) == ["lab", "box"])
    let columns = try database.pool.read { db in try db.columns(in: "account").map(\.name) }
    #expect(!columns.contains { $0.lowercased().contains("token") || $0.lowercased().contains("secret") })
    let cache = SealedCache(database: database)
    let key = SymmetricKey(size: .bits256)
    try cache.put(["x"], origin: "https://box.example.ts.net", kind: .state, key: "s", using: key)
    try accounts.remove(origin: "https://box.example.ts.net")
    #expect(cache.get([String].self, origin: "https://box.example.ts.net", kind: .state, key: "s", using: key) == nil)
    #expect(try accounts.account(origin: "https://box.example.ts.net") == nil)
}

@Test func theSealedCacheIsUnreadableWithAnotherSignInsKeyAndStaysBounded() throws {
    let (database, root) = try temporaryDatabase()
    defer { try? FileManager.default.removeItem(at: root) }
    let device = SymmetricKey(size: .bits256)
    let origin = "https://box.example.ts.net"
    let signedIn = SealedCache.key(device: device, server: "server-key-1", origin: origin)
    var cache = SealedCache(database: database)
    try cache.put(["hello"], origin: origin, kind: .feed, key: "u1", using: signedIn)
    #expect(cache.get([String].self, origin: origin, kind: .feed, key: "u1", using: signedIn) == ["hello"])
    // The plaintext never touches the database.
    let raw = try database.pool.read { db in try Data.fetchOne(db, sql: "SELECT sealed FROM cacheEntry") }!
    #expect(raw.range(of: Data("hello".utf8)) == nil)
    // A new sign-in derives a new key: the old entry can't be read, and is deleted.
    let next = SealedCache.key(device: device, server: "server-key-2", origin: origin)
    #expect(cache.get([String].self, origin: origin, kind: .feed, key: "u1", using: next) == nil)
    #expect(try cache.totals().entries == 0)
    // Moving a row to another key is caught by its authenticated identity.
    try cache.put(["a"], origin: origin, kind: .feed, key: "u1", using: signedIn)
    try database.pool.write { db in try db.execute(sql: "UPDATE cacheEntry SET key = 'u2'") }
    #expect(cache.get([String].self, origin: origin, kind: .feed, key: "u2", using: signedIn) == nil)

    cache.maxEntries = 3
    for i in 0..<10 { try cache.put([String(i)], origin: origin, kind: .feed, key: "k\(i)", using: signedIn, at: Double(i)) }
    #expect(try cache.totals().entries == 3)
    #expect(cache.get([String].self, origin: origin, kind: .feed, key: "k9", using: signedIn) == ["9"])
    #expect(cache.get([String].self, origin: origin, kind: .feed, key: "k0", using: signedIn) == nil)
}

@Test func preferencesAndSurfacesPersistPerDevice() throws {
    let (database, root) = try temporaryDatabase()
    defer { try? FileManager.default.removeItem(at: root) }
    let prefs = PreferenceRepository(database: database)
    var device = prefs.device()
    #expect(device == DevicePreferences())
    device.appearance = .omarchy
    device.stepsHidden = true
    device.noteAgent("codex")
    device.noteAgent("claude")
    device.noteAgent("codex")
    try prefs.save(device)
    #expect(prefs.device().recentAgents == ["codex", "claude"])
    #expect(prefs.device().appearance == .omarchy)
    var bindings = KeyBindings()
    _ = bindings.set("go-inbox", Chord("i", ctrl: true, alt: true))
    try prefs.save(bindings)
    #expect(prefs.keyBindings().chords("go-inbox") == [Chord("i", ctrl: true, alt: true)])
    try prefs.setSurface(.terminal, origin: "o", sessionKey: "u1")
    #expect(prefs.surface(origin: "o", sessionKey: "u1") == .terminal)
    for i in 0..<(PreferenceRepository.surfaceLimit + 20) { try prefs.setSurface(.gui, origin: "o", sessionKey: "s\(i)", at: Double(i + 10)) }
    let rows = try database.pool.read { db in try Int.fetchOne(db, sql: "SELECT COUNT(*) FROM sessionSurface") }
    #expect(rows == PreferenceRepository.surfaceLimit)
}

@Test func vaultKeepsCredentialsAndOneDeviceCacheKey() throws {
    let vault = CredentialVault(store: MemorySecretStore())
    let credential = NativeCredential(token: "t", sessionId: "s", deviceId: "d", expiresAt: 1, idleHours: 24)
    try vault.save(credential, origin: "https://box.example.ts.net")
    #expect(try vault.credential(origin: "https://box.example.ts.net") == credential)
    try vault.save(nil, origin: "https://box.example.ts.net")
    #expect(try vault.credential(origin: "https://box.example.ts.net") == nil)
    let first = try vault.deviceCacheKey()
    #expect(try vault.deviceCacheKey() == first)
}

@Test func restorationReconcilesWithWhatTheHostHasNow() {
    var snapshot = SceneSnapshot(sceneID: "w", hostOrigin: "https://box.example.ts.net", route: .session("live1"))
    snapshot.session = .init(key: "live1", surface: .terminal, panel: .queue, scroll: .init(seq: 9, offset: 0), composerFocused: true)
    snapshot.workspaces = Workspaces(current: 1, slots: [
        1: .init(layout: .split(direction: .horizontal, ratio: 0.5, first: .session("live1"), second: .split(direction: .vertical, ratio: 0.5, first: .session("ended1"), second: .session("gone1"))), selected: nil),
        2: .init(layout: nil, selected: "gone2"),
    ])
    snapshot.focusedPane = [.second, .second]
    let presence: (String) -> RestorationReconciler.Presence = { key in
        switch key {
        case "live1": return .live
        case "ended1": return .ended(ref: "ended1", title: "Old work")
        default: return .gone
        }
    }
    let live = RestorationReconciler.reconcile(snapshot, presence: presence)
    #expect(live.snapshot.session == snapshot.session, "a live session comes back exactly")
    #expect(live.snapshot.workspaces.slots[1]?.layout?.keys == ["live1", "ended1", LayoutNode.pickKey()])
    #expect(live.snapshot.workspaces.slots[2]?.selected == nil)
    #expect(live.notices.contains { $0.contains("2 panes") })

    snapshot.session?.key = "ended1"
    snapshot.route = .session("ended1")
    let ended = RestorationReconciler.reconcile(snapshot, presence: presence)
    #expect(ended.snapshot.route == .session("ended1"))
    #expect(ended.snapshot.session?.composerFocused == false)
    #expect(ended.notices.first?.contains("Old work") == true)

    snapshot.session?.key = "gone1"
    snapshot.route = .session("gone1")
    let gone = RestorationReconciler.reconcile(snapshot, presence: presence)
    #expect(gone.snapshot.route == .inbox)
    #expect(gone.snapshot.session == nil)
}
