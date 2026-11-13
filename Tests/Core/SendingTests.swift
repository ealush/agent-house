import Foundation
import Testing
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

/// A host whose uploads wait until let go (half-way reported first), and which keeps what
/// it's sent.
private actor SlowHost {
    private(set) var sent: [String] = []
    private var open = false
    func letGo() { open = true }
    func record(_ text: String) { sent.append(text) }
    func waitToOpen() async { while !open { try? await Task.sleep(for: .milliseconds(5)) } }
}

private struct SlowUploads: HTTPTransport {
    let host: SlowHost

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let ok = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        if path.hasSuffix("/send") {
            let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
            await host.record(body?["text"] as? String ?? "")
            return (Data(#"{"outcome":"delivered","windowId":"@1","resumed":false,"queued":0}"#.utf8), ok)
        }
        return (Data(#"{"draft":null}"#.utf8), ok)
    }

    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) {
        progress(0.5)
        await host.waitToOpen()
        progress(1)
        return (Data(#"{"path":"/up/photo.png"}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func until(_ done: () -> Bool) async {
    for _ in 0..<400 where !done() { try? await Task.sleep(for: .milliseconds(5)) }
}

@MainActor
@Test func aMessageSentBeforeItsAttachmentIsUpGoesOnceItIs() async throws {
    let host = SlowHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: SlowUploads(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    Task { await composer.attach(name: "notes.txt", data: Data("hello".utf8), image: false) }
    await until { composer.attachments.first?.upload.flatMap { outbox.uploads[$0] } == 0.5 }
    #expect(composer.isUploading)
    composer.text = "look at this"
    // Send isn't held for the upload: the message is out at once, waiting on it.
    #expect(composer.canSend)
    #expect(composer.submit(working: false))
    #expect(composer.attachments.isEmpty && composer.text.isEmpty)
    let item = try #require(outbox.items.first)
    #expect(item.waitingOn.count == 1 && item.text == "look at this")
    #expect(outbox.progress(item) == 0.5)
    #expect(await host.sent.isEmpty, "nothing goes before the attachment is up")
    await host.letGo()
    await composer.settle()
    #expect(await host.sent == ["/up/photo.png look at this"], "the path in its place, then the words")
    let went = try #require(outbox.items.first)
    #expect(went.waitingOn.isEmpty && went.text == "/up/photo.png look at this" && went.state == .sent)
    #expect(outbox.uploads.isEmpty, "an upload that's up is forgotten")
}

@MainActor
@Test func uploadProgressMovesInPercentsAndAMessageAveragesItsUploads() {
    let outbox = Outbox()
    let a = outbox.beginUpload(), b = outbox.beginUpload()
    outbox.progressed(a, 0.004)
    #expect(outbox.uploads[a] == 0, "less than a percent isn't worth drawing")
    outbox.progressed(a, 0.5)
    outbox.progressed(b, 1)
    let id = outbox.add(key: "k", text: "", state: .sending, waitingOn: [a, b])
    let item = try! #require(outbox.items.first { $0.id == id })
    #expect(outbox.progress(item) == 0.75)
    outbox.endUpload(b)
    #expect(outbox.progress(item) == 0.75, "one that's done counts as all there")
    outbox.ready(id, text: "x")
    #expect(outbox.progress(outbox.items[0]) == nil)
}

@MainActor
@Test func aMessageThatCouldntGoAfterItsBoxWasLeftComesBackToTheNextOne() {
    let outbox = Outbox()
    outbox.returnToBox(key: "u1", text: "the plan", reason: "Couldn’t send: offline")
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: URLSessionTransport(), credentials: AccountCredentials(token: nil, onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    #expect(composer.text == "the plan")
    #expect(composer.takeEvents() == [.failed("Couldn’t send: offline")])
    #expect(outbox.takeReturned("u1") == nil, "taken once")
}

@MainActor
@Test func aMessageHeldForAStartingAgentShowsAsSentNotQueued() async throws {
    // The host holds a new session's first message until the agent is up (`starting`).
    struct Starting: HTTPTransport {
        func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let ok = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            if request.url!.path.hasSuffix("/send") {
                return (Data(#"{"outcome":"queued","windowId":"@1","resumed":false,"queued":1,"queueId":"q1","starting":true}"#.utf8), ok)
            }
            return (Data(#"{"draft":null}"#.utf8), ok)
        }
        func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
        func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
    }
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: Starting(), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = "Add a health check"
    #expect(composer.submit(working: false))
    await composer.settle()
    let item = try #require(outbox.items.first)
    #expect(item.state == .sent, "your message in the conversation, not a row in the queue")
    #expect(item.heldAs == "q1")
}

/// A host that takes a message in and whose answer never arrives (the connection dropped
/// after it), with the message then in its queue.
private struct LostAnswer: HTTPTransport {
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let ok = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        if path.hasSuffix("/send") { throw URLError(.networkConnectionLost) }
        if path.hasSuffix("/queue") {
            let at = Date().timeIntervalSince1970
            return (Data(#"[{"id":"q1","text":"run the migration","enter":true,"at":\#(at)}]"#.utf8), ok)
        }
        if path.hasSuffix("/feed") { return (Data(#"{"entries":[],"hasOlder":false}"#.utf8), ok) }
        return (Data(#"{"draft":null}"#.utf8), ok)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func aSendWhoseAnswerIsLostIsSentIfTheHostHasIt() async {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: LostAnswer(), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = "run the migration"
    composer.submit(working: false)
    await composer.settle()
    // Not back in the box to be sent twice: it's there, as sent.
    #expect(composer.text.isEmpty)
    #expect(outbox.items.first?.state == .sent)
}
