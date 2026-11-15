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

private final class TerminalHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { recorded } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { recorded.append(request) }
        let body = #"{"terminal":{"id":"@42","cwd":"/project","command":"bash","busy":false}}"#
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { throw URLError(.unsupportedURL) }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@Test func attachedTerminalRequestsAddressTheOwnerOnItsHostWithNativeAuth() async throws {
    let host = TerminalHost()
    let api = APIClient(origin: URL(string: "https://box.tail.ts.net")!, transport: host, credentials: AccountCredentials(token: "device", onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "test")).peer("desk")
    #expect(try await api.openTerminal("owner").terminal?.id == "@42")
    _ = try await api.openTerminal("owner", command: "printf 'hello\\n'")
    _ = try await api.attachedTerminal("owner")
    try await api.closeTerminal("owner")
    let requests = host.requests
    #expect(requests.map(\.httpMethod) == ["POST", "POST", "GET", "DELETE"])
    #expect(requests.allSatisfy { $0.url?.path == "/h/desk/api/sessions/owner/terminal" })
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer device" })
    #expect(requests.allSatisfy { $0.value(forHTTPHeaderField: "Origin") == nil && $0.value(forHTTPHeaderField: "Cookie") == nil })
    let body = try JSONDecoder().decode([String: String].self, from: #require(requests[1].httpBody))
    #expect(body == ["command": "printf 'hello\\n'"])
}

@Test func attachedTerminalStateAndPanelSurviveRoundTrips() throws {
    let json = #"{"id":"@1","uid":"owner","name":"Agent","statusSource":"hook","project":"ah","projectPath":"/ah","status":"idle","terminal":{"id":"@2","cwd":"/ah","command":"node","busy":true}}"#
    let owner = try JSONDecoder().decode(SessionDTO.self, from: Data(json.utf8))
    #expect(owner.terminal?.id == "@2" && owner.terminal?.busy == true)
    #expect(owner.status == .idle, "the server's foreground command never changes the agent's state")
    #expect(try JSONDecoder().decode(SessionDTO.self, from: JSONEncoder().encode(owner)) == owner)
    #expect(try JSONDecoder().decode(SceneSnapshot.Panel.self, from: Data(#""terminal""#.utf8)) == .terminal)
    #expect(SceneModel.FocusTarget.attachedTerminal("owner").sessionKey == "owner")
    #expect(SceneModel.FocusTarget.attachedTerminal("owner") != .terminal("owner"))
}

private actor FailingResolution {
    var attempts = 0
    func resolve() throws -> String? {
        attempts += 1
        if attempts == 1 { throw URLError(.timedOut) }
        return nil
    }
}

@Test func aFailedAttachmentLookupReconnectsInsteadOfReportingAStoppedShell() async {
    let resolver = FailingResolution()
    let api = APIClient(origin: URL(string: "https://box.tail.ts.net")!, transport: TerminalHost(), credentials: AccountCredentials(token: "device", onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "test"))
    let connection = TerminalConnection(api: api) { try await resolver.resolve() }
    let events = await connection.events()
    await connection.start()
    var retried = false
    for await event in events {
        if case .disconnected(_, let retrying) = event { retried = retrying }
        if case .ended = event { break }
    }
    await connection.stop()
    #expect(retried)
    #expect(await resolver.attempts == 2)
}
