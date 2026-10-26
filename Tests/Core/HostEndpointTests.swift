import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

@Test func normalizesTailscaleServeOrigin() throws {
    let endpoint = try HostEndpoint("  https://MACHINE.example.ts.net:443/  ")
    #expect(endpoint.url.absoluteString == "https://machine.example.ts.net")
}

@Test(arguments: [
    "http://machine.example.ts.net", "https://example.com", "https://ts.net",
    "https://machine.example.ts.net.evil.com", "https://user:secret@machine.example.ts.net",
    "https://machine.example.ts.net/api", "https://machine.example.ts.net?token=secret",
    "https://machine.example.ts.net#secret", "https://machine.example.ts.net:7681",
    "https://localhost", "https://-machine.example.ts.net", "https://machine..ts.net"
])
func rejectsUnsafeOrNoncanonicalHostAddress(_ address: String) {
    #expect(throws: HostEndpoint.ValidationError.self) { try HostEndpoint(address) }
}


#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A host that refuses every request as signed out.
private struct Refusing: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        (Data(#"{"error":"sign in required"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

private actor RecordingCredentials: CredentialProvider {
    var token: String? = "first"
    private(set) var refused: [String?] = []
    func bearer() async -> String? { token }
    func rejected(bearer: String?) async { refused.append(bearer) }
}

@Test func aRefusedRequestReportsTheBearerItCarried() async throws {
    let credentials = RecordingCredentials()
    let api = APIClient(origin: URL(string: "https://host.example.ts.net")!, transport: Refusing(), credentials: credentials, device: DeviceDescriptor(name: "iPad", client: "c1"))
    let request = await api.request("GET", "/api/state")
    await #expect(throws: APIError.self) { _ = try await api.send(request) }
    #expect(await credentials.refused == ["first"], "the account can tell a late refusal of an old sign-in from one of the current")
}

@Test func aLateRefusalOfAnOldSignInLeavesTheNewOneAlone() async {
    let signedOut = SignedOutCount()
    let credentials = AccountCredentials(token: "old") { await signedOut.add() }
    // Locked, then signed in again while a request with the old bearer was still out.
    await credentials.set("new")
    await credentials.rejected(bearer: "old")
    #expect(await credentials.bearer() == "new")
    #expect(await signedOut.count == 0)
    // The current bearer refused: the account signs out, once.
    await credentials.rejected(bearer: "new")
    await credentials.rejected(bearer: "new")
    #expect(await credentials.bearer() == nil)
    #expect(await signedOut.count == 1)
}

private actor SignedOutCount {
    private(set) var count = 0
    func add() { count += 1 }
}
