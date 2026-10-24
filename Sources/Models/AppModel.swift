import Foundation
import Observation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// Device keys by host: the Secure Enclave on iPhone/iPad (biometric to sign), memory in tests.
protocol DeviceKeyStore: Sendable {
    func key(origin: String) throws -> (any DeviceKey)?
    func create(origin: String) throws -> any DeviceKey
    func delete(origin: String) throws
}

final class MemoryDeviceKeyStore: DeviceKeyStore, @unchecked Sendable {
    private let lock = NSLock()
    private var keys: [String: SoftwareDeviceKey] = [:]
    init() {}
    func key(origin: String) throws -> (any DeviceKey)? { lock.withLock { keys[origin] } }
    func create(origin: String) throws -> any DeviceKey {
        let key = SoftwareDeviceKey()
        lock.withLock { keys[origin] = key }
        return key
    }
    func delete(origin: String) throws { _ = lock.withLock { keys.removeValue(forKey: origin) } }
}

/// The bearer for one account's requests. A 401 anywhere reports back, once, so the account
/// asks to sign in again instead of every screen failing on its own.
actor AccountCredentials: CredentialProvider {
    private var token: String?
    private let onRejected: @Sendable () async -> Void

    init(token: String?, onRejected: @escaping @Sendable () async -> Void) {
        self.token = token
        self.onRejected = onRejected
    }

    func set(_ token: String?) { self.token = token }
    func bearer() async -> String? { token }

    /// Only a refusal of the bearer in use now ends the sign-in: a request that went out
    /// before a lock and comes back refused after the next sign-in is no news.
    func rejected(bearer: String?) async {
        guard let token, bearer == token else { return }
        self.token = nil
        await onRejected()
    }
}

/// Lets the credentials actor reach its account once the account exists.
@MainActor
final class RejectionRelay: Sendable {
    weak var target: AccountSession?
    nonisolated init() {}
    func fire() { target?.signedOutByHost() }
}

/// One host this device is enrolled with: its sign-in, its live state, its encrypted cache.
@MainActor
@Observable
final class AccountSession: Identifiable {
    enum Status: Equatable, Sendable {
        case signedIn
        case signingIn
        /// Locked, expired or revoked: Face ID signs in again with the device key.
        case needsSignIn(String?)
        /// The host no longer knows this device (removed): enroll again with a code.
        case unenrolled(String)
    }

    nonisolated var id: String { origin }
    nonisolated let origin: String
    private(set) var account: Account
    let endpoint: HostEndpoint
    let api: APIClient
    let hub: HubStore
    private(set) var status: Status
    /// The cache key for this sign-in (device half + host half); nil until fetched.
    private(set) var cacheKey: SymmetricKey?

    @ObservationIgnored private let credentials: AccountCredentials
    @ObservationIgnored private let services: AppServices

    init(account: Account, credential: NativeCredential?, services: AppServices) {
        self.account = account
        origin = account.origin
        endpoint = account.endpoint ?? (try! HostEndpoint("https://invalid.ts.net"))
        self.services = services
        status = credential == nil ? .needsSignIn(nil) : .signedIn
        let relay = RejectionRelay()
        let box = AccountCredentials(token: credential?.token) { await relay.fire() }
        credentials = box
        api = APIClient(origin: endpoint.url, transport: services.transport, credentials: box, device: services.device)
        hub = HubStore(api: api)
        hub.onSignedOut = { [weak self] in self?.signedOutByHost() }
        relay.target = self
    }

    var hostname: String { hub.hostname ?? account.hostname }

    /// Start live state when signed in (app launch, foreground).
    func activate() {
        guard status == .signedIn else { return }
        hub.start()
        Task { await loadCacheKey() }
    }

    func deactivate() { hub.stop() }

    func signedOutByHost() {
        guard status == .signedIn || status == .signingIn else { return }
        hub.stop()
        cacheKey = nil
        try? services.vault.save(nil, origin: origin)
        status = .needsSignIn("Your sign-in ended (expired or revoked). Sign in again to continue.")
    }

    /// Face ID / Touch ID with the device key; a removed device must enroll again.
    func signIn() async {
        status = .signingIn
        do {
            guard let key = try services.keys.key(origin: origin) else {
                status = .unenrolled("This device’s key is gone. Enroll again with a code from your host.")
                return
            }
            let credential = try await NativeAuth(api: api).signIn(deviceId: account.deviceId, label: account.label, key: key)
            try services.vault.save(credential, origin: origin)
            await credentials.set(credential.token)
            try? services.accounts.touch(origin: origin)
            status = .signedIn
            activate()
        } catch let error as APIError {
            if case .unauthorized(let message) = error, message.contains("unknown device") {
                status = .unenrolled("This host no longer knows this device. Enroll again with a code from your host.")
            } else {
                status = .needsSignIn(error.message)
            }
        } catch {
            status = .needsSignIn(error.localizedDescription)
        }
    }

    /// Lock now / Sign out: the host ends this sign-in (closing its streams and terminals);
    /// the device stays enrolled.
    func lock() async {
        try? await api.logout()
        await credentials.set(nil)
        try? services.vault.save(nil, origin: origin)
        hub.stop()
        cacheKey = nil
        status = .needsSignIn(nil)
    }

    /// Remove this device from the host: every sign-in ends, the key and local data go.
    func removeDevice() async throws {
        try await api.removeDevice(account.deviceId)
        await forget()
    }

    /// Forget the account locally (after removal elsewhere, or by choice).
    func forget() async {
        await credentials.set(nil)
        hub.stop()
        try? services.vault.save(nil, origin: origin)
        try? services.keys.delete(origin: origin)
        try? services.accounts.remove(origin: origin)
        try? services.cache.clear(origin: origin)
        cacheKey = nil
        status = .unenrolled("Removed from this device.")
    }

    private func loadCacheKey() async {
        guard let server = try? await api.cacheKey(), let device = try? services.vault.deviceCacheKey() else { return }
        cacheKey = SealedCache.key(device: device, server: server, origin: origin)
        hub.useCache(HubStore.StateCache(
            load: { [weak self] in self?.cached(HubStateDTO.self, kind: .state, key: "hub") },
            store: { [weak self] state in self?.cache(state, kind: .state, key: "hub") }
        ))
    }

    /// Seal for this sign-in, or nothing when there is no key.
    func cache<T: Encodable>(_ value: T, kind: SealedCache.Kind, key: String) {
        guard let cacheKey else { return }
        try? services.cache.put(value, origin: origin, kind: kind, key: key, using: cacheKey)
    }

    func cached<T: Decodable>(_ type: T.Type, kind: SealedCache.Kind, key: String) -> T? {
        guard let cacheKey else { return nil }
        return services.cache.get(type, origin: origin, kind: kind, key: key, using: cacheKey)
    }
}

/// What the whole app shares across windows (UIKit scenes): storage, secrets, keys, transport.
struct AppServices: Sendable {
    let database: AppDatabase
    let vault: CredentialVault
    let keys: any DeviceKeyStore
    let transport: any HTTPTransport
    /// This device as other devices see it; `client` is replaced per window.
    var device: DeviceDescriptor
    /// Debug builds and tests may enroll with a loopback host.
    let allowLoopback: Bool

    var accounts: AccountRepository { AccountRepository(database: database) }
    var preferences: PreferenceRepository { PreferenceRepository(database: database) }
    var scenes: SceneRepository { SceneRepository(database: database) }
    var cache: SealedCache { SealedCache(database: database) }
}

/// The app's shared model: accounts, device preferences, shortcuts, the outbox, and the
/// needs-you count for the icon badge. Windows each get their own `SceneModel` on top.
@MainActor
@Observable
final class AppModel {
    let services: AppServices
    private(set) var accounts: [AccountSession] = []
    let outbox = Outbox()
    var preferences: DevicePreferences {
        didSet { if preferences != oldValue { try? services.preferences.save(preferences) } }
    }
    var keyBindings: KeyBindings {
        didSet { if keyBindings != oldValue { try? services.preferences.save(keyBindings) } }
    }

    init(services: AppServices) {
        self.services = services
        preferences = services.preferences.device()
        keyBindings = services.preferences.keyBindings()
        let saved = (try? services.accounts.all()) ?? []
        accounts = saved.map { AccountSession(account: $0, credential: try? services.vault.credential(origin: $0.origin), services: services) }
    }

    func account(origin: String?) -> AccountSession? {
        guard let origin else { return accounts.first }
        return accounts.first { $0.origin == origin }
    }

    /// The name other devices see for this one.
    var deviceName: String {
        DeviceDescriptor.sanitizedName(preferences.deviceName ?? services.device.name)
    }

    func activateAll() { accounts.forEach { $0.activate() } }
    func resyncAll() { accounts.forEach { $0.hub.resync() } }

    /// Sessions that need you, on every signed-in host.
    var badgeCount: Int {
        accounts.filter { $0.status == .signedIn }.reduce(0) { $0 + $1.hub.inbox(narrow: false).badge }
    }

    enum EnrollError: Error, Equatable, LocalizedError {
        case notAgentHub
        case alreadyEnrolled
        var errorDescription: String? {
            switch self {
            case .notAgentHub: return "That address didn’t answer as Agent Hub."
            case .alreadyEnrolled: return "This device is already enrolled with that host."
            }
        }
    }

    /// Pair with a host: check it's ah, create a device key, spend the one-time code.
    func enroll(address: String, code: String, label: String) async throws -> AccountSession {
        let endpoint = try HostEndpoint(address, allowLoopback: services.allowLoopback)
        let origin = endpoint.url.absoluteString
        if let existing = accounts.first(where: { $0.origin == origin }) {
            if case .unenrolled = existing.status {} else { throw EnrollError.alreadyEnrolled }
        }
        let anonymous = APIClient(origin: endpoint.url, transport: services.transport, credentials: AccountCredentials(token: nil) {}, device: services.device)
        let hello = try await anonymous.hello()
        guard hello.ah else { throw EnrollError.notAgentHub }
        let key = try services.keys.create(origin: origin)
        do {
            let credential = try await NativeAuth(api: anonymous).enroll(code: code, label: label, key: key)
            let now = Date().timeIntervalSince1970
            let account = Account(origin: origin, hostname: hello.hostname, deviceId: credential.deviceId, label: NativeAuth.sanitizedLabel(label), enrolledAt: now, lastUsedAt: now)
            try services.accounts.save(account)
            try services.vault.save(credential, origin: origin)
            accounts.removeAll { $0.origin == origin }
            let session = AccountSession(account: account, credential: credential, services: services)
            accounts.insert(session, at: 0)
            session.activate()
            return session
        } catch {
            try? services.keys.delete(origin: origin)
            throw error
        }
    }

    func removeLocally(_ session: AccountSession) async {
        await session.forget()
        accounts.removeAll { $0.origin == session.origin }
    }
}
