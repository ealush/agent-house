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

/// A host whose agent won't stop: Send Now answers 409 `did_not_stop`, and the queue still
/// lists the message, as ah leaves it.
private struct StuckTransport: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let answer = { (code: Int) in HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)! }
        if path.hasSuffix("/send-now") { return (Data(#"{"error":"the agent is working; it did not stop after the interrupt","code":"did_not_stop"}"#.utf8), answer(409)) }
        if path.hasSuffix("/queue"), request.httpMethod == "GET" { return (Data(#"[{"id":"a","text":"urgent","enter":true,"at":1}]"#.utf8), answer(200)) }
        return (Data(#"{"ok":true}"#.utf8), answer(200))
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func aSendNowThatFailsSaysWhyAfterTheQueueReloads() async throws {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: StuckTransport(), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let queue = QueueModel(api: api, outbox: Outbox(), uid: "u1", key: "u1")
    await queue.load()
    #expect(queue.error == nil)

    // The reload right after the refusal reads the queue fine; why it wasn't sent stays.
    #expect(await queue.steer(queue.items[0]) == nil)
    #expect(queue.error?.hasPrefix("Couldn’t send it now: ") == true)
    #expect(queue.error?.contains("did not stop") == true)
    #expect(queue.items.map(\.id) == ["a"])
    // So does the tray's next poll.
    await queue.load()
    #expect(queue.error?.hasPrefix("Couldn’t send it now: ") == true)

    // What you do next says how that went instead.
    await queue.cancel(queue.items[0])
    #expect(queue.error == nil)
}
