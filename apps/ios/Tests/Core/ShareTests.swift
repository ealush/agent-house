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

// The share extension's logic (`ShareModel`): what it reads, what it asks the host, and
// what it says happened.

private let origin = "https://box.tail.ts.net"

private func credential(_ token: String, expires: Date) throws -> Data {
    try JSONEncoder().encode(NativeCredential(token: token, sessionId: "s", deviceId: "d", expiresAt: expires.timeIntervalSince1970 * 1000, idleHours: 24))
}

@Test func theSignInsItReadsAreTheAppsOwn() throws {
    let now = Date()
    let accounts = SharedAccount.parse([
        ("credential:\(origin)", try credential("t1", expires: now.addingTimeInterval(3600))),
        ("credential:https://desk.tail.ts.net", try credential("t2", expires: now.addingTimeInterval(-60))),
        ("cache-device-key", Data(repeating: 1, count: 32)),
        ("credential:not a url", try credential("t3", expires: now.addingTimeInterval(3600))),
        ("credential:https://broken.tail.ts.net", Data("{".utf8)),
    ], now: now)
    #expect(accounts.map(\.origin) == [origin, "https://desk.tail.ts.net"], "only credentials, only well-formed")
    #expect(accounts.map(\.expired) == [false, true])
    #expect(accounts.first?.name == "box")
}

@Test func whatsSharedBecomesOneMessageWithTheUploadsFirst() {
    let items: [SharedItem] = [.link(URL(string: "https://example.com/post")!), .text("  a quote  "), .file(.init(name: "shot.png", url: URL(fileURLWithPath: "/tmp/shot.png"), bytes: 10, kind: .image))]
    #expect(ShareMessage.compose(note: "Look at this", items: items, uploaded: ["/home/u/.cache/ah/uploads/2026-shot.png", "/home/u/.cache/ah/uploads/my file.pdf"])
        == "/home/u/.cache/ah/uploads/2026-shot.png '/home/u/.cache/ah/uploads/my file.pdf'\n\nLook at this\n\nhttps://example.com/post\n\na quote")
    #expect(ShareMessage.compose(note: "   ", items: [.link(URL(string: "https://example.com")!)], uploaded: []) == "https://example.com", "a link alone is the message")
    #expect(ShareMessage.needsFile(String(repeating: "x", count: 30_001)))
    #expect(!ShareMessage.needsFile("short"))
}

/// A host for the extension: its state (and a peer's), uploads, sessions, sends, a queue.
private final class ShareHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private(set) var log: [String] = []
    private(set) var sent: [String] = []
    var failUpload = false
    var loseSendAnswer = false
    var queued: [[String: Any]] = []
    var refuse = false
    var loseCreateAnswer = false

    func record(_ s: String) { lock.withLock { log.append(s) } }

    private func ok(_ request: URLRequest, _ object: Any, status: Int = 200) -> (Data, HTTPURLResponse) {
        (try! JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }

    private func window(_ uid: String, _ title: String, activity: Double) -> [String: Any] {
        ["id": "@\(uid)", "uid": uid, "name": "claude", "title": title, "statusSource": "hook", "project": "orbit-api", "projectPath": "/p/orbit-api", "status": "idle", "agent": "claude", "activity": activity]
    }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        let method = request.httpMethod ?? "GET"
        record("\(method) \(path)")
        if refuse { return ok(request, ["error": "signed out"], status: 401) }
        if path == "/api/state" {
            return ok(request, ["api": 28, "hostname": "box", "hosts": [["name": "box", "self": true, "online": true], ["name": "mac", "self": false, "online": true], ["name": "gone", "self": false, "online": false]], "defaultSession": "main",
                                "windows": [window("u1", "Users latency", activity: 10), window("u2", "Payments", activity: 30)],
                                "presets": [["id": "shell", "name": "Shell", "command": "", "available": true], ["id": "claude", "name": "Claude Code", "command": "claude", "available": true]]])
        }
        if path == "/h/mac/api/state" {
            return ok(request, ["api": 28, "hostname": "mac", "windows": [window("m1", "On the Mac", activity: 20)]])
        }
        if path == "/api/windows" { if loseCreateAnswer { throw URLError(.networkConnectionLost) }; return ok(request, ["id": "@9", "uid": "n1"], status: 201) }
        if path.hasSuffix("/send") {
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]) ?? [:]
            lock.withLock { sent.append(body["text"] as? String ?? "") }
            if loseSendAnswer { throw URLError(.timedOut) }
            return ok(request, ["outcome": "queued", "windowId": "@1", "resumed": false, "queued": 1, "starting": true])
        }
        if path.hasSuffix("/queue") { return ok(request, queued) }
        return ok(request, ["error": "no"], status: 404)
    }
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) {
        record("UPLOAD \(request.url!.path)?\(request.url!.query ?? "")")
        if failUpload { return ok(request, ["error": "upload is too large (limit 50 MB)", "code": "upload_too_large"], status: 413) }
        return ok(request, ["path": "/home/u/.cache/ah/uploads/x-\(file.lastPathComponent)", "bytes": 3], status: 201)
    }
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) {
        if case .file(let url) = body { progress(1); return try await upload(for: request, fromFile: url) }
        return ok(request, ["error": "no"], status: 404)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func model(_ host: ShareHost, items: [SharedItem], expired: Bool = false) async -> ShareModel {
    let account = SharedAccount(origin: origin, token: "t", expired: expired)
    let model = ShareModel(accounts: [account], items: items, transport: host, device: DeviceDescriptor(name: "iPhone", client: "share"))
    await model.load()
    return model
}

private let photo = SharedItem.file(.init(name: "shot.png", url: URL(fileURLWithPath: "/tmp/shot.png"), bytes: 3, kind: .image))

@MainActor
@Test func itListsTheHostsSessionsAndItsPeersNewestFirst() async {
    let host = ShareHost()
    let share = await model(host, items: [.link(URL(string: "https://example.com")!)])
    #expect(share.hostname == "box")
    #expect(share.hosts == ["mac"], "an offline peer isn't asked")
    #expect(share.sessions.map(\.id) == ["u2", "mac/m1", "u1"])
    #expect(share.agents.map(\.id) == ["claude"], "no shell to start for a share")
    #expect(share.projects.map(\.path) == ["/p/orbit-api"])
    #expect(!share.canSend, "nowhere chosen yet")
}

@MainActor
@Test func filesGoUpToTheSessionsOwnHostThenOneMessage() async throws {
    let host = ShareHost()
    let share = await model(host, items: [photo, .link(URL(string: "https://example.com")!)])
    share.destination = .session(try #require(share.sessions.first { $0.uid == "m1" }))
    share.note = "Why is this red?"
    await share.send()
    #expect(share.phase == .sent(queued: true))
    #expect(host.log.contains("UPLOAD /h/mac/api/upload?name=shot.png"), "the Mac's session gets the Mac's upload")
    #expect(host.sent == ["/home/u/.cache/ah/uploads/x-shot.png\n\nWhy is this red?\n\nhttps://example.com"])
    #expect(!share.canSend, "done: it doesn't go twice")
}

@MainActor
@Test func aFileThatDoesntUploadSendsNothing() async throws {
    let host = ShareHost()
    host.failUpload = true
    let share = await model(host, items: [photo])
    share.destination = .session(try #require(share.sessions.first))
    await share.send()
    guard case .failed(let why) = share.phase else { Issue.record("expected failed, got \(share.phase)"); return }
    #expect(why.contains("larger than your host accepts"))
    #expect(why.contains("Nothing was sent"))
    #expect(host.sent.isEmpty)
    #expect(share.canSend, "nothing went: trying again is safe")
}

@MainActor
@Test func aNewSessionStartsOnceAndTakesTheMessage() async throws {
    let host = ShareHost()
    let share = await model(host, items: [.text("summarize this")])
    share.destination = .new(host: nil, preset: "claude", cwd: "/p/orbit-api")
    await share.send()
    #expect(share.phase == .sent(queued: true))
    #expect(host.log.filter { $0 == "POST /api/windows" }.count == 1)
    #expect(host.log.contains("POST /api/sessions/n1/send"))
    let lost = ShareHost()
    lost.loseCreateAnswer = true
    let again = await model(lost, items: [.text("summarize this")])
    again.destination = .new(host: nil, preset: "claude", cwd: "/p/orbit-api")
    await again.send()
    guard case .unsure = again.phase else { Issue.record("a lost answer to a start is unsure, got \(again.phase)"); return }
    #expect(lost.log.filter { $0 == "POST /api/windows" }.count == 1, "never a second session on its own")
    #expect(!again.canSend)
}

@MainActor
@Test func aLostAnswerIsCheckedNotGuessed() async throws {
    let host = ShareHost()
    host.loseSendAnswer = true
    let share = await model(host, items: [.text("hello")])
    share.destination = .session(try #require(share.sessions.first { $0.uid == "u1" }))
    await share.send()
    guard case .unsure = share.phase else { Issue.record("expected unsure, got \(share.phase)"); return }
    #expect(host.sent.count == 1)
    // Found in its queue: it did arrive.
    let landed = ShareHost()
    landed.loseSendAnswer = true
    landed.queued = [["id": "q1", "text": "hello", "enter": true, "at": Date().timeIntervalSince1970]]
    let other = await model(landed, items: [.text("hello")])
    other.destination = .session(try #require(other.sessions.first { $0.uid == "u1" }))
    await other.send()
    #expect(other.phase == .sent(queued: true))
    // The person looked and sends it again: once more, deliberately.
    host.loseSendAnswer = false
    await share.sendAgain()
    #expect(share.phase == .sent(queued: true))
    #expect(host.sent.count == 2)
}

@MainActor
@Test func anEndedSignInSaysSoAndIsLeftToTheApp() async {
    let expired = await model(ShareHost(), items: [.text("x")], expired: true)
    #expect(expired.account == nil, "an expired sign-in isn't picked")
    let host = ShareHost()
    host.refuse = true
    let share = await model(host, items: [.text("x")])
    #expect(share.loadError?.contains("has ended") == true, "\(share.loadError ?? "nil")")
}
