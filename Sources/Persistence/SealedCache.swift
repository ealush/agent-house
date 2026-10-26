import Foundation
import GRDB
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// The newest transcript page and session list per host, for an instant first paint
/// (`../ah/web/gui/feedCache.ts`'s intent, natively). Every entry is AES-GCM sealed with a
/// key derived from two halves: a device key kept in the Keychain and the per-sign-in key
/// the host derives (`POST /api/auth/cache-key`). Signing out, revocation or expiry leave
/// ciphertext nobody can read; a failed open deletes the entry. Bounded in size and count.
struct SealedCache: Sendable {
    let database: AppDatabase
    var maxBytes = 24 * 1024 * 1024
    var maxEntries = 400

    enum Kind: String, Sendable { case state, feed, queue }

    /// HKDF-SHA256 over the device key, salted with the sign-in's server key, bound to the host.
    static func key(device: SymmetricKey, server: String, origin: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: device, salt: Data(server.utf8), info: Data("ah-native-cache-v1|\(origin)".utf8), outputByteCount: 32)
    }

    private static func associated(_ origin: String, _ kind: Kind, _ key: String) -> Data {
        Data("\(origin)|\(kind.rawValue)|\(key)".utf8)
    }

    func put<T: Encodable>(_ value: T, origin: String, kind: Kind, key: String, using secret: SymmetricKey, at time: Double = Date().timeIntervalSince1970) throws {
        let plain = try JSONEncoder().encode(value)
        guard let sealed = try AES.GCM.seal(plain, using: secret, authenticating: Self.associated(origin, kind, key)).combined else { return }
        try database.pool.write { db in
            try db.execute(
                sql: "INSERT INTO cacheEntry (origin, kind, key, sealed, size, updatedAt) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(origin, kind, key) DO UPDATE SET sealed = excluded.sealed, size = excluded.size, updatedAt = excluded.updatedAt",
                arguments: [origin, kind.rawValue, key, sealed, sealed.count, time]
            )
            try prune(db)
        }
    }

    func get<T: Decodable>(_ type: T.Type, origin: String, kind: Kind, key: String, using secret: SymmetricKey) -> T? {
        guard let sealed = try? database.pool.read({ db in
            try Data.fetchOne(db, sql: "SELECT sealed FROM cacheEntry WHERE origin = ? AND kind = ? AND key = ?", arguments: [origin, kind.rawValue, key])
        }) else { return nil }
        do {
            let box = try AES.GCM.SealedBox(combined: sealed)
            let plain = try AES.GCM.open(box, using: secret, authenticating: Self.associated(origin, kind, key))
            return try JSONDecoder().decode(T.self, from: plain)
        } catch {
            // Another sign-in's key, a moved row, or an old format: it can never be read again.
            try? database.pool.write { db in
                try db.execute(sql: "DELETE FROM cacheEntry WHERE origin = ? AND kind = ? AND key = ?", arguments: [origin, kind.rawValue, key])
            }
            return nil
        }
    }

    func clear(origin: String) throws {
        try database.pool.write { db in try db.execute(sql: "DELETE FROM cacheEntry WHERE origin = ?", arguments: [origin]) }
    }

    func totals() throws -> (entries: Int, bytes: Int) {
        try database.pool.read { db in
            let row = try Row.fetchOne(db, sql: "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM cacheEntry")!
            return (row["n"], row["bytes"])
        }
    }

    /// Oldest first until under both bounds.
    private func prune(_ db: Database) throws {
        let row = try Row.fetchOne(db, sql: "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM cacheEntry")!
        var count: Int = row["n"]
        var bytes: Int = row["bytes"]
        while count > maxEntries || bytes > maxBytes {
            guard let oldest = try Row.fetchOne(db, sql: "SELECT rowid, size FROM cacheEntry ORDER BY updatedAt ASC LIMIT 1") else { break }
            try db.execute(sql: "DELETE FROM cacheEntry WHERE rowid = ?", arguments: [oldest["rowid"] as Int64])
            count -= 1
            bytes -= oldest["size"] as Int
        }
    }
}

/// Where the app keeps secrets: the device's Keychain on iOS, memory in tests.
protocol SecretStore: Sendable {
    func data(for account: String) throws -> Data?
    func set(_ data: Data?, for account: String) throws
}

final class MemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: Data] = [:]

    init() {}

    func data(for account: String) throws -> Data? { lock.withLock { values[account] } }
    func set(_ data: Data?, for account: String) throws { lock.withLock { values[account] = data } }
}

/// Bearer credentials and the device cache key, by host.
struct CredentialVault: Sendable {
    let store: any SecretStore

    private func credentialAccount(_ origin: String) -> String { "credential:\(origin)" }
    private static let cacheKeyAccount = "cache-device-key"

    func credential(origin: String) throws -> NativeCredential? {
        guard let data = try store.data(for: credentialAccount(origin)) else { return nil }
        return try JSONDecoder().decode(NativeCredential.self, from: data)
    }

    func save(_ credential: NativeCredential?, origin: String) throws {
        try store.set(credential.map { try JSONEncoder().encode($0) }, for: credentialAccount(origin))
    }

    /// The device half of the cache key, created once.
    func deviceCacheKey() throws -> SymmetricKey {
        if let data = try store.data(for: Self.cacheKeyAccount), data.count == 32 { return SymmetricKey(data: data) }
        let key = SymmetricKey(size: .bits256)
        try store.set(key.withUnsafeBytes { Data($0) }, for: Self.cacheKeyAccount)
        return key
    }
}
