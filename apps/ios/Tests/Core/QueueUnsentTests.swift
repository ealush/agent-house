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

/// A host whose agent never took one message ("lost"): it lists it first, `unsent`, only when
/// asked (`?unsent=1`), and places a move by the queue's own positions.
private actor UnsentHost {
    private(set) var queued: [String] = ["a", "b"]
    private(set) var lost: [String] = ["lost"]
    private(set) var moves: [Int] = []

    func list(unsent: Bool) -> Data {
        let rows = (unsent ? lost.map { #"{"id":"\#($0)","text":"never went in","enter":true,"at":1,"unsent":true}"# } : [])
            + queued.map { #"{"id":"\#($0)","text":"say \#($0)","enter":true,"at":2}"# }
        return Data("[\(rows.joined(separator: ","))]".utf8)
    }

    func remove(_ id: String) {
        queued.removeAll { $0 == id }
        lost.removeAll { $0 == id }
    }

    func move(_ id: String, to: Int) -> Data {
        moves.append(to)
        if let from = queued.firstIndex(of: id) { queued.insert(queued.remove(at: from), at: min(to, queued.count)) }
        return list(unsent: false)
    }
}

private struct UnsentTransport: HTTPTransport {
    let host: UnsentHost

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
        if url.path.hasSuffix("/queue"), request.httpMethod == "GET" { return (await host.list(unsent: url.query == "unsent=1"), ok) }
        if url.path.hasSuffix("/move") { return (await host.move(url.deletingLastPathComponent().lastPathComponent, to: body?["to"] as? Int ?? 0), ok) }
        if request.httpMethod == "DELETE", url.path.contains("/queue/") {
            await host.remove(url.lastPathComponent)
            return (Data(#"{"ok":true}"#.utf8), ok)
        }
        return (Data(#"{"draft":null}"#.utf8), ok)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func models(_ host: UnsentHost, showsUnsent: Bool) -> (QueueModel, ComposerModel) {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: UnsentTransport(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    return (QueueModel(api: api, outbox: outbox, uid: "u1", key: "u1", hostShowsUnsent: { showsUnsent }), composer)
}

@MainActor
@Test func whatTheAgentNeverTookShowsAboveTheQueueAndNeverShiftsItsPlaces() async throws {
    let host = UnsentHost()
    let (queue, composer) = models(host, showsUnsent: true)
    await queue.load()
    #expect(queue.unsent.map(\.id) == ["lost"])
    #expect(queue.items.map(\.id) == ["a", "b"])
    #expect(!queue.isEmpty)

    // "b" to the top of the queue is the queue's position 0, whatever is shown above it.
    await queue.move("b", to: 0)
    #expect(await host.moves == [0])
    #expect(queue.items.map(\.id) == ["b", "a"])

    // Taken back to edit, it was ahead of everything queued: queued again, it goes first.
    await queue.edit(queue.unsent[0], into: composer)
    #expect(composer.text == "never went in" && composer.requeueBefore == "b")
    #expect(queue.unsent.isEmpty)
}

@MainActor
@Test func aHostThatPredatesItListsTheQueueAsItWas() async throws {
    let (queue, _) = models(UnsentHost(), showsUnsent: false)
    await queue.load()
    #expect(queue.unsent.isEmpty)
    #expect(queue.items.map(\.id) == ["a", "b"])
}

@MainActor
@Test func lettingItGoTakesItAway() async throws {
    let host = UnsentHost()
    let (queue, _) = models(host, showsUnsent: true)
    await queue.load()
    await queue.cancel(queue.unsent[0])
    #expect(queue.unsent.isEmpty && queue.items.map(\.id) == ["a", "b"])
}

@Test func aQueueItemAndASessionSayWhatWasNeverTaken() throws {
    let item = try JSONDecoder().decode(QueueItem.self, from: Data(#"{"id":"x","text":"t","enter":true,"at":1,"unsent":true}"#.utf8))
    #expect(item.unsent == true)
    let old = try JSONDecoder().decode(QueueItem.self, from: Data(#"{"id":"x","text":"t","enter":true,"at":1}"#.utf8))
    #expect(old.unsent == nil)
}
