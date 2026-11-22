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

/// A host with a queue of its own: listing, taking one out, a send while the agent works
/// (queued at the end, as ah does), and moving one.
private actor QueueHost {
    private(set) var items: [(id: String, text: String)] = [("a", "first"), ("b", "second"), ("c", "third")]
    private(set) var moves: [Int] = []
    private var made = 0

    func list() -> Data {
        let rows = items.map { #"{"id":"\#($0.id)","text":"\#($0.text)","enter":true,"at":1}"# }
        return Data("[\(rows.joined(separator: ","))]".utf8)
    }

    func remove(_ id: String) { items.removeAll { $0.id == id } }

    func send(_ text: String) -> Data {
        made += 1
        items.append(("n\(made)", text))
        return Data(#"{"outcome":"queued","windowId":"@1","resumed":false,"queued":\#(items.count),"queueId":"n\#(made)"}"#.utf8)
    }

    func move(_ id: String, to: Int) -> Data {
        moves.append(to)
        if let from = items.firstIndex(where: { $0.id == id }) {
            let item = items.remove(at: from)
            items.insert(item, at: min(to, items.count))
        }
        return list()
    }
}

private struct QueueTransport: HTTPTransport {
    let host: QueueHost

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let ok = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any]
        if path.hasSuffix("/queue"), request.httpMethod == "GET" { return (await host.list(), ok) }
        if path.hasSuffix("/send") { return (await host.send(body?["text"] as? String ?? ""), ok) }
        if path.hasSuffix("/move") {
            let id = request.url!.deletingLastPathComponent().lastPathComponent
            return (await host.move(id, to: body?["to"] as? Int ?? 0), ok)
        }
        if request.httpMethod == "DELETE", path.contains("/queue/") {
            await host.remove(request.url!.lastPathComponent)
            return (Data(#"{"ok":true}"#.utf8), ok)
        }
        return (Data(#"{"draft":null}"#.utf8), ok)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func aQueuedMessageEditedAndQueuedAgainKeepsItsPlace() async throws {
    let host = QueueHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: QueueTransport(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    let queue = QueueModel(api: api, outbox: outbox, uid: "u1", key: "u1")
    await queue.load()
    #expect(queue.items.map(\.id) == ["a", "b", "c"])

    // The middle one, out to edit: its words in the box, its place remembered.
    await queue.edit(queue.items[1], into: composer)
    #expect(composer.text == "second" && composer.requeueBefore == "c")
    #expect(queue.items.map(\.id) == ["a", "c"])

    // Reworded and sent while the agent works: queued at the end, then back in its place.
    composer.text = "second, reworded"
    #expect(composer.submit(working: true))
    await composer.settle()
    let events = composer.takeEvents()
    guard case .requeue(let id, let before)? = events.last else {
        Issue.record("no requeue in \(events)")
        return
    }
    #expect(before == "c" && composer.requeueBefore == nil)
    await queue.place(id, before: before)
    #expect(queue.items.map(\.text) == ["first", "second, reworded", "third"])
    #expect(await host.moves == [1])
}

@MainActor
@Test func theLastQueuedMessageEditedHasNoPlaceToGoBackTo() async {
    let host = QueueHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: QueueTransport(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    let queue = QueueModel(api: api, outbox: outbox, uid: "u1", key: "u1")
    await queue.load()
    await queue.edit(queue.items[2], into: composer)
    // The end is its place already.
    #expect(composer.text == "third" && composer.requeueBefore == nil)
}

@MainActor
@Test func aBoxEmptiedAfterAnEditLetsItsPlaceGo() {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: QueueTransport(host: QueueHost()), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let composer = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = "second"
    composer.requeueBefore = "c"
    composer.text = "second, reworded"
    #expect(composer.requeueBefore == "c", "edited, still on its way back")
    composer.text = ""
    #expect(composer.requeueBefore == nil, "a later message isn't moved for it")
}

/// A host that keeps one session's draft: what was PUT comes back on GET.
private actor DraftHost {
    private(set) var text: String?
    func put(_ text: String) { self.text = text }
}

private struct DraftTransport: HTTPTransport {
    let host: DraftHost

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let ok = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        if request.url!.path.hasSuffix("/draft") {
            if request.httpMethod == "PUT", let body = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any] {
                await host.put(body["text"] as? String ?? "")
            }
            guard let text = await host.text else { return (Data(#"{"draft":null}"#.utf8), ok) }
            let draft = DraftEnvelope(draft: Draft(text: text, at: 1, device: "iPhone", client: "c"))
            return (try JSONEncoder().encode(draft), ok)
        }
        return (Data("[]".utf8), ok)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func aDraftKeepsItsPicturesWhenTheBoxIsOpenedAfresh() async {
    let host = DraftHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: DraftTransport(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let photo = "/home/me/.cache/ah/uploads/2026-11-22T13-48-32-149Z-photo.png"
    // A picture attached and a few words around its chip, then the session left.
    let box = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    box.compose("after I answered \(photo) the answers never showed")
    #expect(box.text == "after I answered @photo.png the answers never showed" && box.attachments.count == 1)
    await box.background()
    #expect(await host.text == "after I answered \(photo) the answers never showed", "the host keeps the picture's path, not only its chip's name")

    // Back to the session: a new box, filled from the host's draft, has the picture again.
    let again = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    await again.open()
    #expect(again.text == "after I answered @photo.png the answers never showed")
    #expect(again.attachments.map(\.path) == [photo] && again.attachments.map(\.token) == ["photo.png"])
    #expect(again.draftText == "after I answered \(photo) the answers never showed", "sent as it was: its path where its chip is")
}
