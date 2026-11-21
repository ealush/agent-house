import CryptoKit
import Foundation
import LocalAuthentication
import Security

/// Secrets in this device's Keychain: never synced (ThisDeviceOnly), readable after the first
/// unlock so a notification action can answer while the phone is locked-but-unlocked-once.
final class KeychainSecretStore: SecretStore, @unchecked Sendable {
    let service: String

    init(service: String = "dev.ealush.ah.native") {
        self.service = service
    }

    struct Failure: Error, CustomStringConvertible, LocalizedError {
        let status: OSStatus
        var description: String { "Keychain error \(status)" }
        var errorDescription: String? {
            let reason = SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)"
            return "This device’s Keychain couldn’t keep the sign-in (\(reason))."
        }
    }

    private func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }

    func data(for account: String) throws -> Data? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw Failure(status: status) }
        return result as? Data
    }

    func set(_ data: Data?, for account: String) throws {
        let status = SecItemDelete(query(account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw Failure(status: status) }
        guard let data else { return }
        var add = query(account)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw Failure(status: added) }
    }
}

/// A device key held by the Secure Enclave: the private key never leaves it, and every
/// signature (each sign-in) needs Face ID, Touch ID or the passcode.
struct SecureEnclaveDeviceKey: DeviceKey {
    /// The Enclave's wrapped key blob: useless off this device.
    let blob: Data
    let publicKeyX963: Data

    func sign(_ message: Data) async throws -> Data {
        let context = LAContext()
        context.localizedReason = "Sign in to your Agent House host"
        let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: context)
        return try key.signature(for: message).derRepresentation
    }
}

/// Device keys by host origin. In the Simulator (and only there) a software key in the
/// Keychain stands in: it has no Face ID or passcode to approve an Enclave signature.
final class SecureEnclaveKeyStore: DeviceKeyStore, @unchecked Sendable {
    private let store: KeychainSecretStore

    init(store: KeychainSecretStore = KeychainSecretStore(service: "dev.ealush.ah.native.keys")) {
        self.store = store
    }

    private struct Stored: Codable {
        let kind: String
        let blob: Data
        let publicKey: Data
    }

    enum Failure: Error, LocalizedError {
        case noSecureEnclave
        var errorDescription: String? { "This device can’t hold a hardware-protected key, which Agent House needs to sign in." }
    }

    private func account(_ origin: String) -> String { "devicekey:\(origin)" }

    func key(origin: String) throws -> (any DeviceKey)? {
        guard let data = try store.data(for: account(origin)) else { return nil }
        let stored = try JSONDecoder().decode(Stored.self, from: data)
        switch stored.kind {
        case "enclave": return SecureEnclaveDeviceKey(blob: stored.blob, publicKeyX963: stored.publicKey)
        #if targetEnvironment(simulator)
        case "software": return try SoftwareDeviceKey(rawRepresentation: stored.blob)
        #endif
        default: return nil
        }
    }

    func create(origin: String) throws -> any DeviceKey {
        #if targetEnvironment(simulator)
        // An Apple silicon Mac's simulator reports an Enclave, but it has no Face ID or
        // passcode to approve a signature, so sign-in would always fail there.
        let key = SoftwareDeviceKey()
        try store.set(try JSONEncoder().encode(Stored(kind: "software", blob: key.rawRepresentation, publicKey: key.publicKeyX963)), for: account(origin))
        return key
        #else
        guard SecureEnclave.isAvailable else { throw Failure.noSecureEnclave }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .userPresence], &error) else {
            throw error!.takeRetainedValue() as Error
        }
        let key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
        let publicKey = key.publicKey.x963Representation
        try store.set(try JSONEncoder().encode(Stored(kind: "enclave", blob: key.dataRepresentation, publicKey: publicKey)), for: account(origin))
        return SecureEnclaveDeviceKey(blob: key.dataRepresentation, publicKeyX963: publicKey)
        #endif
    }

    func delete(origin: String) throws {
        try store.set(nil, for: account(origin))
    }
}
