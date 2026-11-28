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

/// A host whose session's agent has exited: Send Now answers 409 `agent_gone` ("Offer Resume"),
/// and Resume (`POST …/resume`) is recorded.
private final class GoneTransport: HTTPTransport, @unchecked Sendable {
    private(set) var resumed = 0
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let answer = { (code: Int) in HTTPURLResponse(url: request.url!, statusCode: code, httpVersion: nil, headerFields: nil)! }
        if path.hasSuffix("/send-now") { return (Data(#"{"error":"its agent isn't running in its window; the message stays queued","code":"agent_gone"}"#.utf8), answer(409)) }
        if path.hasSuffix("/resume") {
            resumed += 1
            return (Data(#"{"id":"@1","uid":"u1","resumed":true}"#.utf8), answer(201))
        }
        if path.hasSuffix("/queue"), request.httpMethod == "GET" { return (Data(#"[{"id":"a","text":"urgent","enter":true,"at":1}]"#.utf8), answer(200)) }
        return (Data(#"{"ok":true}"#.utf8), answer(200))
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func sendNowOnAnExitedAgentOffersResumeWhereTheHostCanAndResumeAsksTheHost() async throws {
    let transport = GoneTransport()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: transport, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    // A host without `resumeInPlace`: the reason, no offer.
    let older = QueueModel(api: api, outbox: Outbox(), uid: "u1", key: "u1")
    await older.load()
    _ = await older.steer(older.items[0])
    #expect(older.error?.contains("isn't running") == true)
    #expect(older.offersResume == false)

    let queue = QueueModel(api: api, outbox: Outbox(), uid: "u1", key: "u1", hostResumesInPlace: { true })
    await queue.load()
    _ = await queue.steer(queue.items[0])
    #expect(queue.offersResume)
    await queue.resumeAgent()
    #expect(transport.resumed == 1)
    #expect(queue.offersResume == false, "asked; the queue goes in once it's back")
    #expect(queue.error == nil)
}

@Test func agentGoneIsItsOwnRefusalAndOther409sStayConflicts() {
    let gone = APIError(status: 409, body: Data(#"{"error":"its agent isn't running","code":"agent_gone"}"#.utf8))
    #expect(gone == .agentGone("its agent isn't running"))
    let other = APIError(status: 409, body: Data(#"{"error":"the agent is working","code":"did_not_stop"}"#.utf8))
    #expect(other == .conflict("the agent is working"))
}
