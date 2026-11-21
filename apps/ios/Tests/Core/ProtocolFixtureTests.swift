import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// What this repository's server sends, read with the app's own decoders. The fixtures are
// real answers from a disposable host (`packages/protocol/fixtures`, captured and kept in step
// with `wire-shapes.txt` by `apps/server/test/contract.test.ts` and `protocol.test.ts`), so a
// server change the app can't read fails here, in plain `swift test`, without a host. The
// integration suite (`scripts/integration.sh`) checks the same against a live one.

/// `packages/protocol`, from this file (`apps/ios/Tests/Core/…`: five levels below the root).
private let protocolDir = (0..<5).reduce(URL(fileURLWithPath: #filePath)) { url, _ in url.deletingLastPathComponent() }
    .appendingPathComponent("packages/protocol")

private func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: protocolDir.appendingPathComponent(name))
}

private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
    try JSONDecoder().decode(T.self, from: fixture("fixtures/\(name)"))
}

@Test func theServersAPIVersionIsTheOneThisAppAccepts() throws {
    struct Versions: Decodable { let api: Int; let features: [String: Int] }
    let versions = try JSONDecoder().decode(Versions.self, from: fixture("versions.json"))
    #expect(versions.api == HubStateDTO.supportedAPIVersion)
    let hello = try decode(Hello.self, "hello.json")
    #expect(hello.ah)
}

@Test func theServersStateDecodesWithEverySessionAndAsk() throws {
    let state = try decode(HubStateDTO.self, "state.json")
    try state.validate()
    #expect(state.windows.contains { $0.name == "contract" })
    // The agent asking permission: its question and choices come through.
    #expect(state.windows.contains { $0.ask?.options?.isEmpty == false })
    #expect(state.supports("notes"))
}

@Test func theServersStateStreamBuildsTheStateFromItsSnapshotAndPatches() throws {
    var parser = ServerSentEventParser()
    let events = try parser.append(fixture("fixtures/state-stream.sse"))
    #expect(events.first?.name == "state")
    #expect(events.contains { $0.name == "patch" })
    var reducer = HubStateReducer()
    for event in events { try reducer.apply(event) }
    let state = try #require(reducer.state)
    // Started after the snapshot: it arrived in a patch's windowsDelta.
    #expect(state.windows.contains { $0.name == "contract stream" })
    #expect(state.windows.contains { $0.name == "contract" })
}

@Test func theServersAnswersToSendQueueAndCreateDecode() throws {
    let queued = try decode(SendResult.self, "send-queued.json")
    #expect(queued.outcome == .queued)
    #expect(queued.held == "picker")
    #expect(try decode(SendResult.self, "send-delivered.json").outcome == .delivered)
    let queue = try decode([QueueItem].self, "queue.json")
    #expect(queue.map(\.text) == ["after that, run the tests"])
    #expect(try decode(CreatedWindow.self, "window-created.json").uid.isEmpty == false)
    let auth = try decode(AuthStatus.self, "auth-status.json")
    #expect(auth.authenticated)
}

@Test func theServersRefusalsReadAsTheirMessage() throws {
    let answered = APIError(status: 409, body: try fixture("fixtures/error-code.json"))
    guard case .conflict(let message) = answered else {
        Issue.record("409 read as \(answered)")
        return
    }
    #expect(message == "that prompt was just answered")
    let bad = APIError(status: 400, body: try fixture("fixtures/error.json"))
    #expect(!bad.localizedDescription.isEmpty)
}
