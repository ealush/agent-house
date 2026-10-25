import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

/// A disposable ah host started by scripts/integration.sh. Tests are skipped without one.
enum LiveHost {
    static let environment = ProcessInfo.processInfo.environment
    static let port = environment["AH_IT_PORT"].flatMap(Int.init)
    static let hostToken = environment["AH_IT_TOKEN"] ?? ""
    static let pickerKeys = environment["AH_IT_KEYS"] ?? ""
    static var available: Bool { port != nil }
    static var origin: URL { URL(string: "http://127.0.0.1:\(port ?? 0)")! }

    /// Acts as the host CLI (`ah auth code`): the local token, from a same-origin page shape.
    /// Test fixture only; the app never does this.
    static func hostCall(_ method: String, _ path: String, body: [String: Any] = [:]) async throws -> Data {
        var request = URLRequest(url: URL(string: "http://localhost:\(port!)\(path)")!)
        request.httpMethod = method
        request.setValue("Bearer \(hostToken)", forHTTPHeaderField: "Authorization")
        if method != "GET" {
            request.setValue("1", forHTTPHeaderField: "X-AH")
            request.setValue("http://localhost:\(port!)", forHTTPHeaderField: "Origin")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession(configuration: .ephemeral).data(for: request)
        let status = (response as! HTTPURLResponse).statusCode
        guard (200..<300).contains(status) else {
            throw APIError(status: status, body: data)
        }
        return data
    }

    /// The test host's own tmux server, by its socket path (never the developer's tmux, which
    /// a `TMUX` in the environment would otherwise pick). Stands in for an agent's hook here.
    static func tmux(_ args: String...) throws {
        guard let dir = environment["AH_IT_DIR"] else { throw APIError(status: 0, body: Data("AH_IT_DIR is not set".utf8)) }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["tmux", "-S", "\(dir)/tmux/tmux-\(getuid())/default"] + args
        var env = environment
        env["TMUX"] = nil
        process.environment = env
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw APIError(status: Int(process.terminationStatus), body: Data("tmux \(args.first ?? "") failed".utf8)) }
    }

    static func setupCode() async throws -> String {
        let data = try await hostCall("POST", "/api/auth/code")
        return try JSONDecoder().decode(SetupCode.self, from: data).code
    }

    static func client(_ credentials: any CredentialProvider, device: String = "iPhone") -> APIClient {
        APIClient(origin: origin, transport: LinuxTestTransport(), credentials: credentials, device: DeviceDescriptor(name: device, client: DeviceDescriptor.newClientID()))
    }

    /// A freshly enrolled native device, signed in.
    static func enrolled(label: String = "Test iPhone") async throws -> Device {
        let box = TokenBox()
        let api = client(box)
        let key = SoftwareDeviceKey()
        let credential = try await NativeAuth(api: api).enroll(code: try await setupCode(), label: label, key: key)
        await box.set(credential.token)
        return Device(api: api, credential: credential, key: key, box: box)
    }

    struct Device {
        let api: APIClient
        let credential: NativeCredential
        let key: SoftwareDeviceKey
        let box: TokenBox
    }

    /// A session created through the native client, once the host lists it.
    static func launch(_ api: APIClient, preset: String, label: String) async throws -> SessionDTO {
        let home = try await api.state().home
        let created = try await api.create(NewSessionRequest(preset: preset, cwd: home, session: "it", label: label))
        return try await until("\(label) listed", timeout: 20) {
            try await api.state().windows.first { $0.uid == created.uid && ($0.agent == preset || preset == "shell") }
        }
    }
}

actor TokenBox: CredentialProvider {
    private(set) var token: String?
    private(set) var rejections = 0

    init(_ token: String? = nil) { self.token = token }
    func set(_ token: String?) { self.token = token }
    func bearer() async -> String? { token }
    func rejected(bearer: String?) async { rejections += 1 }
}

struct Timeout: Error, CustomStringConvertible {
    let what: String
    var description: String { "timed out waiting for \(what)" }
}

/// Polls until `check` returns a value.
func until<T>(_ what: String, timeout: Double = 10, every: Duration = .milliseconds(150), _ check: () async throws -> T?) async throws -> T {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let value = try? await check() { return value }
        try await Task.sleep(for: every)
    }
    if let value = try await check() { return value }
    throw Timeout(what: what)
}

/// The next update from a stream that satisfies `match`.
func next<T: Sendable>(_ stream: AsyncStream<T>, _ what: String, timeout: Double = 15, where match: @escaping @Sendable (T) -> Bool) async throws -> T {
    try await withThrowingTaskGroup(of: T?.self) { group in
        group.addTask {
            for await value in stream where match(value) { return value }
            return nil
        }
        group.addTask {
            try await Task.sleep(for: .seconds(timeout))
            throw Timeout(what: what)
        }
        guard let first = try await group.next(), let value = first else { throw Timeout(what: what) }
        group.cancelAll()
        return value
    }
}
