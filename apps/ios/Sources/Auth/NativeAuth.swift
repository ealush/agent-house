import Foundation
#if canImport(CryptoKit)
import CryptoKit
#else
import Crypto
#endif

/// The device-bound P-256 key that proves this app is an enrolled device. On iPhone/iPad
/// it lives in the Secure Enclave and signing needs Face ID/Touch ID; tests use a
/// software key. The private key never leaves the device.
protocol DeviceKey: Sendable {
    /// Uncompressed X9.63 point (65 bytes).
    var publicKeyX963: Data { get }
    /// ECDSA P-256 over SHA-256, DER-encoded. May prompt for biometrics; throws if refused.
    func sign(_ message: Data) async throws -> Data
}

/// A key held in memory as raw bytes (tests, and the Simulator, which has no Secure Enclave).
struct SoftwareDeviceKey: DeviceKey {
    let rawRepresentation: Data

    init() {
        rawRepresentation = P256.Signing.PrivateKey().rawRepresentation
    }

    init(rawRepresentation: Data) throws {
        _ = try P256.Signing.PrivateKey(rawRepresentation: rawRepresentation)
        self.rawRepresentation = rawRepresentation
    }

    var publicKeyX963: Data {
        (try? P256.Signing.PrivateKey(rawRepresentation: rawRepresentation).publicKey.x963Representation) ?? Data()
    }

    func sign(_ message: Data) async throws -> Data {
        try P256.Signing.PrivateKey(rawRepresentation: rawRepresentation).signature(for: message).derRepresentation
    }
}

/// A native sign-in: the bearer secret for requests (Keychain only), and what identifies it.
struct NativeCredential: Codable, Equatable, Sendable {
    let token: String
    let sessionId: String
    let deviceId: String
    /// Milliseconds since the epoch; the host also signs out after `idleHours` unused.
    let expiresAt: Double
    let idleHours: Double
}

/// The host-side halves of enrollment and sign-in (`apps/server/server/auth.ts`, native app devices).
struct NativeAuth: Sendable {
    let api: APIClient

    enum Failure: Error, Equatable, LocalizedError {
        /// The challenge names a different Host than the one this app addressed.
        case hostMismatch(expected: String, got: String)
        case malformedChallenge

        var errorDescription: String? {
            switch self {
            case .hostMismatch(let expected, let got): return "The host answered as \(got), not \(expected). Check the address."
            case .malformedChallenge: return "The host’s sign-in challenge was malformed."
            }
        }
    }

    private struct Challenge: Decodable { let challengeId: String; let challenge: String; let host: String }
    private struct Granted: Decodable { let token: String; let sessionId: String; let deviceId: String; let expiresAt: Double; let idleHours: Double }
    private struct EnrollOptions: Encodable { let code: String? }
    private struct EnrollVerify: Encodable { let challengeId: String; let publicKey: String; let signature: String; let label: String }
    private struct LoginVerify: Encodable { let challengeId: String; let deviceId: String; let signature: String; let label: String }

    /// The Host header URLSession sends for this origin: the name, plus a non-default port.
    static func hostHeader(for origin: URL) -> String {
        let host = (origin.host ?? "").lowercased()
        guard let port = origin.port else { return host }
        let standard = origin.scheme == "https" ? 443 : 80
        return port == standard ? host : "\(host):\(port)"
    }

    /// The server keeps `[\w .·()-]`, 60 characters, of a label; the signature covers what it keeps.
    static func sanitizedLabel(_ raw: String) -> String {
        let kept = raw.filter { c in
            (c.isASCII && (c.isLetter || c.isNumber || c == "_" || c == " " || c == "." || c == "(" || c == ")" || c == "-")) || c == "·"
        }
        return String(kept.prefix(60))
    }

    /// The exact bytes a device key signs (`server/auth.ts nativeMessage`).
    static func message(purpose: String, challenge: String, host: String, subject: String, label: String) -> Data {
        Data(["ah-native-\(purpose)-v1", challenge, host, subject, label].joined(separator: "\n").utf8)
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func checkedChallenge(_ challenge: Challenge) throws -> Challenge {
        let expected = Self.hostHeader(for: api.origin)
        guard !challenge.challengeId.isEmpty, !challenge.challenge.isEmpty else { throw Failure.malformedChallenge }
        guard challenge.host == expected else { throw Failure.hostMismatch(expected: expected, got: challenge.host) }
        return challenge
    }

    /// Enrolls this device with a one-time code from the host (`ah auth code`, or Settings →
    /// Security on a signed-in device). The code is spent only after the key's proof verifies.
    func enroll(code: String, label rawLabel: String, key: any DeviceKey) async throws -> NativeCredential {
        let label = Self.sanitizedLabel(rawLabel)
        let options: Challenge = try checkedChallenge(await api.call("POST", "/api/auth/native/enroll/options", json: EnrollOptions(code: code)))
        let publicKey = Self.base64URL(key.publicKeyX963)
        let signature = try await key.sign(Self.message(purpose: "enroll", challenge: options.challenge, host: options.host, subject: publicKey, label: label))
        let granted: Granted = try await api.call("POST", "/api/auth/native/enroll/verify", json: EnrollVerify(challengeId: options.challengeId, publicKey: publicKey, signature: Self.base64URL(signature), label: label))
        return NativeCredential(token: granted.token, sessionId: granted.sessionId, deviceId: granted.deviceId, expiresAt: granted.expiresAt, idleHours: granted.idleHours)
    }

    /// Signs in again with the enrolled key (after expiry, a lock, or a revoked sign-in).
    func signIn(deviceId: String, label rawLabel: String, key: any DeviceKey) async throws -> NativeCredential {
        let label = Self.sanitizedLabel(rawLabel)
        let options: Challenge = try checkedChallenge(await api.call("POST", "/api/auth/native/login/options"))
        let signature = try await key.sign(Self.message(purpose: "login", challenge: options.challenge, host: options.host, subject: deviceId, label: label))
        let granted: Granted = try await api.call("POST", "/api/auth/native/login/verify", json: LoginVerify(challengeId: options.challengeId, deviceId: deviceId, signature: Self.base64URL(signature), label: label))
        return NativeCredential(token: granted.token, sessionId: granted.sessionId, deviceId: granted.deviceId, expiresAt: granted.expiresAt, idleHours: granted.idleHours)
    }
}
