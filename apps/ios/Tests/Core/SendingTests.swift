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
@Test func aFileAttachedBeforeTheSessionExistsGoesWithItsFirstMessage() async throws {
    let host = SlowHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: SlowUploads(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    // New session's box: no session yet, so it only holds what's attached.
    let new = ComposerModel(api: api, outbox: outbox, key: "new", uid: "", isShell: false, draftDebounce: .seconds(3600))
    Task { await new.attach(name: "notes.txt", data: Data("hello".utf8), image: false) }
    await until { new.attachments.first?.upload.flatMap { outbox.uploads[$0] } == 0.5 }
    // The session starts while it's still uploading: its box takes the tile and the upload.
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = "look at this"
    composer.adopt(attachmentsOf: new)
    #expect(new.attachments.isEmpty)
    #expect(composer.attachments.map(\.name) == ["notes.txt"] && composer.isUploading)
    #expect(composer.submit(working: false))
    let item = try #require(outbox.items.first)
    #expect(item.waitingOn.count == 1 && outbox.progress(item) == 0.5, "the same upload, not a new one")
    #expect(await host.sent.isEmpty)
    await host.letGo()
    await composer.settle()
    #expect(await host.sent == ["/up/photo.png look at this"])
    #expect(outbox.uploads.isEmpty)
    // What the screen says while the session starts, before any path is known.
    #expect(Uploads.summary(images: 1, files: 1, words: "look at this") == "1 image, 1 file · look at this")
    #expect(Uploads.summary(images: 0, files: 2, words: "") == "2 files")
    #expect(Uploads.summary(images: 0, files: 0, words: "hi") == "hi")
}

@MainActor
@Test func aFileAttachedBeforeTheSessionExistsGoesWhereItsChipIs() async throws {
    let host = SlowHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: SlowUploads(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let outbox = Outbox()
    let new = ComposerModel(api: api, outbox: outbox, key: "new", uid: "", isShell: false, draftDebounce: .seconds(3600))
    new.text = "see  please"
    new.caret = 4
    Task { await new.attach(name: "notes.txt", data: Data("hello".utf8), image: false) }
    await until { new.attachments.first?.upload.flatMap { outbox.uploads[$0] } == 0.5 }
    #expect(new.text == "see @notes.txt please" && new.chips.map(\.path) == ["notes.txt"], "a chip in New session's box too")
    // The session's box takes the words and the tile, the chip still naming it.
    let composer = ComposerModel(api: api, outbox: outbox, key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = new.text
    composer.adopt(attachmentsOf: new)
    #expect(composer.chips.map(\.path) == ["notes.txt"])
    #expect(composer.submit(working: false))
    await host.letGo()
    await composer.settle()
    #expect(await host.sent == ["see /up/photo.png please"], "the path where its chip was, no token left behind")
}

private actor Requests {
    private(set) var paths: [String] = []
    func record(_ path: String) { paths.append(path) }
}

private struct RecordingHost: HTTPTransport {
    let requests: Requests

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        await requests.record("\(request.httpMethod ?? "GET") \(request.url!.path)")
        return (Data(#"{"draft":null}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func newSessionsBoxKeepsItsWordsOffTheHost() async throws {
    let requests = Requests()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: RecordingHost(requests: requests), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    // New session's box holds the first message (typed or dictated) with no session to keep a draft for.
    let new = ComposerModel(api: api, outbox: Outbox(), key: "new", uid: "", isShell: false, draftDebounce: .milliseconds(1))
    new.text = "fix the login page"
    // A session's box saves its draft once typing stops.
    let session = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .milliseconds(1))
    session.text = "fix the login page"
    for _ in 0..<400 where await !requests.paths.contains(where: { $0.hasPrefix("PUT") }) { try await Task.sleep(for: .milliseconds(5)) }
    try await Task.sleep(for: .milliseconds(50))
    let paths = await requests.paths
    #expect(paths.count == 1 && paths[0].hasPrefix("PUT") && paths[0].hasSuffix("u1/draft"), "only the session's draft: \(paths)")
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

@MainActor
@Test func anAttachmentIsAChipWhereTheCaretWasAndGoesInThatPlace() async throws {
    let host = SlowHost()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: SlowUploads(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let composer = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = "compare  please"
    composer.caret = 8
    Task { await composer.attach(name: "photo.png", data: Data("png".utf8), image: true) }
    await until { !composer.attachments.isEmpty }
    #expect(composer.text == "compare @photo.png please", "in at the caret, a space each side")
    #expect(composer.chips.map(\.path) == ["photo.png"])
    #expect(composer.attachment(for: composer.chips[0])?.name == "photo.png")
    // A second, then its chip's ×: the tile goes too.
    Task { await composer.attach(name: "photo.png", data: Data("png".utf8), image: true) }
    await until { composer.attachments.count == 2 }
    #expect(composer.attachments.map(\.token) == ["photo.png", "photo-2.png"])
    composer.removeChip(composer.chips.first { $0.path == "photo-2.png" }!)
    #expect(composer.attachments.count == 1 && !composer.text.contains("photo-2"))
    await host.letGo()
    await until { composer.attachments.first?.path != nil }
    #expect(composer.submit(working: false))
    await composer.settle()
    #expect(await host.sent == ["compare /up/photo.png please"], "the path where its chip was")
}

@Test func uploadTokensPlaceAndPlacing() {
    var taken = Set<String>()
    #expect(Uploads.token("paste.png", taken: &taken) == "paste.png")
    #expect(Uploads.token("paste.png", taken: &taken) == "paste-2.png")
    #expect(Uploads.token("my \"draft\" notes.txt", taken: &taken) == "my-draft-notes.txt")
    #expect(Uploads.token("README", taken: &taken) == "README")
    #expect(Uploads.token("README", taken: &taken) == "README-2")

    let dir = "/home/me/.cache/ah/uploads"
    let placed = Uploads.place("compare \(dir)/2026-10-12T18-08-27-998Z-paste.png with '/home/me/my cache/ah/uploads/2026-10-12T18-09-00-000Z-paste.png' please")
    #expect(placed.text == "compare @paste.png with @paste-2.png please")
    #expect(placed.uploads.map { [$0.token, $0.upload.path] } == [["paste.png", "\(dir)/2026-10-12T18-08-27-998Z-paste.png"], ["paste-2.png", "/home/me/my cache/ah/uploads/2026-10-12T18-09-00-000Z-paste.png"]])
    #expect(Uploads.place("no files here").text == "no files here")

    let files: [(token: String?, path: String)] = [("a.png", "\(dir)/x-a.png"), ("my-log.txt", "/home/me/my cache/ah/uploads/x-log.txt"), (nil, "\(dir)/x-b.png")]
    #expect(Uploads.placing(files, in: "see @a.png, then @my-log.txt and @a.png again") == "\(dir)/x-b.png see \(dir)/x-a.png, then '/home/me/my cache/ah/uploads/x-log.txt' and @a.png again")
    #expect(Uploads.placing([files[0]], in: "just words") == "\(dir)/x-a.png just words", "a chip deleted as text: in front")

    // The transcript: tiles above, the chip where it was; nothing but files, no words.
    let bubble = Attachment.placed("look at \(dir)/2026-10-12T18-08-27-998Z-shot.png please")
    #expect(bubble.attachments.map(\.name) == ["shot.png"] && bubble.rest == "look at @shot.png please" && bubble.uploads == ["shot.png": "\(dir)/2026-10-12T18-08-27-998Z-shot.png"])
    #expect(Attachment.placed("\(dir)/2026-10-12T18-08-27-998Z-shot.png").rest == "")
}

@Test func picturesTheAgentTookOutOfTheWordsAreChipsWhereTheyWere() {
    let dir = "/home/me/.cache/ah/uploads"
    let picture = FeedPart.media(kind: "image", src: "data:image/png;base64,AA==", alt: nil)
    // As Claude Code keeps it: three paths taken out, a fourth left glued to the third.
    let text = "[Image #4] [Image #5] [Image #6]\(dir)/2026-11-21T23-52-41-065Z-photo-1.png\nJust testing"
    let bubble = Attachment.placed(text, media: [picture, picture, picture])
    #expect(bubble.rest == "@Picture-1 @Picture-2 @Picture-3 @photo-1.png\nJust testing")
    #expect(bubble.attachments.map(\.name) == ["photo-1.png", "Image", "Image", "Image"])
    // Each picture's chip opens it among the message's pictures: after the upload's.
    #expect(bubble.uploads == ["Picture-1": "ah-picture:1", "Picture-2": "ah-picture:2", "Picture-3": "ah-picture:3", "photo-1.png": "\(dir)/2026-11-21T23-52-41-065Z-photo-1.png"])
    #expect(Attachment.place(fromMark: "ah-picture:2") == 2 && Attachment.place(fromMark: "/a.png") == nil)
    // One picture is just "Picture"; one named past the message's pictures stays as it is.
    #expect(Attachment.placed("[Image #8]push this", media: [picture]).rest == "@Picture push this")
    #expect(Attachment.placed("[Image #1] [Image #2]", media: [picture]).rest == "@Picture [Image #2]")
    // Nothing but the pictures: no words under them; none at all, the text as it is.
    #expect(Attachment.placed("[Image #1] [Image #2]", media: [picture, picture]).rest == "")
    #expect(Attachment.placed("[Image #1] what is this").rest == "[Image #1] what is this")
}
