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

// What a tap or an action on a host's alert does (`NotificationResponses`), and the pieces
// around it: the payload newer hosts send, the badge across hosts, preferences.

private let box = NotifiedAccount(origin: "https://box.tail.ts.net", hostname: "box", peers: ["mac"])
private let desk = NotifiedAccount(origin: "https://desk.tail.ts.net", hostname: "desk", peers: [])

private func payload(_ ah: [String: Any]) -> PushPayload? { PushPayload(["ah": ah]) }

@Test func aNewerHostsAlertCarriesThePromptAndItsCount() throws {
    let full = try #require(payload(["v": 1, "host": "box", "route": "u1", "event": "waiting", "prompt": "a1b2c3d4e5f60718", "waiting": 2]))
    #expect(full.link == .session(host: "box", uid: "u1"))
    #expect(full.event == "waiting")
    #expect(full.prompt == "a1b2c3d4e5f60718")
    #expect(full.waiting == 2)
    let old = try #require(payload(["v": 1, "host": "box", "route": "u1", "event": "waiting"]))
    #expect(old.prompt == nil && old.waiting == nil, "an older host's alert still reads")
    #expect(payload(["v": 1, "route": "u1", "prompt": String(repeating: "x", count: 65)])?.prompt == nil, "a prompt id is short")
    #expect(payload(["v": 1, "route": "u1", "waiting": NSNumber(value: 3)])?.waiting == 3)
    #expect(PushPayload(["aps": ["badge": 1]]) == nil, "not one of ours")
    let own = try #require(PushPayload(PushPayload.userInfo(host: "box", route: "u1", event: "failed", draft: "run it again")))
    #expect(own.draft == "run it again")
    #expect(own.link == .session(host: "box", uid: "u1"))
}

@Test func anAnswerGoesOnlyToTheHostTheAlertCameFrom() throws {
    let alert = try #require(payload(["host": "box", "route": "u1", "event": "waiting", "prompt": "p1"]))
    #expect(NotificationResponses.plan(alert, action: NotificationResponses.approveAction, reply: nil, accounts: [desk, box])
        == .answer(origin: box.origin, key: "u1", approve: true, prompt: "p1"))
    #expect(NotificationResponses.plan(alert, action: NotificationResponses.denyAction, reply: nil, accounts: [box])
        == .answer(origin: box.origin, key: "u1", approve: false, prompt: "p1"))
    // Signed in only to another host: refused, never sent to the one that happens to be first.
    #expect(NotificationResponses.plan(alert, action: NotificationResponses.approveAction, reply: nil, accounts: [desk]) == .notSignedIn(host: "box"))
    #expect(NotificationResponses.plan(alert, action: NotificationResponses.approveAction, reply: nil, accounts: []) == .notSignedIn(host: "box"))
    // A peer's session, through the hub that reaches it.
    let peer = try #require(payload(["host": "mac", "route": "u9", "event": "waiting"]))
    #expect(NotificationResponses.plan(peer, action: NotificationResponses.approveAction, reply: nil, accounts: [desk, box])
        == .answer(origin: box.origin, key: "mac/u9", approve: true, prompt: nil))
    // An old alert without a host: only when there's no doubt which host it means.
    let bare = try #require(payload(["route": "u1", "event": "waiting"]))
    #expect(NotificationResponses.plan(bare, action: NotificationResponses.approveAction, reply: nil, accounts: [box]) == .answer(origin: box.origin, key: "u1", approve: true, prompt: nil))
    #expect(NotificationResponses.plan(bare, action: NotificationResponses.approveAction, reply: nil, accounts: [box, desk]) == .notSignedIn(host: nil))
}

@Test func aTapOpensAReplyReachesTheSessionAndADismissalDoesNothing() throws {
    let done = try #require(payload(["host": "box", "route": "u1", "event": "done"]))
    #expect(NotificationResponses.plan(done, action: NotificationResponses.defaultAction, reply: nil, accounts: [desk, box]) == .open(done.link, origin: box.origin))
    #expect(NotificationResponses.plan(done, action: NotificationResponses.defaultAction, reply: nil, accounts: [desk]) == .open(done.link, origin: nil), "a window picks the host itself")
    #expect(NotificationResponses.plan(done, action: NotificationResponses.dismissAction, reply: nil, accounts: [box]) == .nothing)
    #expect(NotificationResponses.plan(done, action: NotificationResponses.replyAction, reply: "  ship it\n", accounts: [box]) == .reply(origin: box.origin, key: "u1", text: "ship it"))
    #expect(NotificationResponses.plan(done, action: NotificationResponses.replyAction, reply: "   ", accounts: [box]) == .open(done.link, origin: box.origin), "nothing to send: open it")
    #expect(NotificationResponses.plan(done, action: NotificationResponses.replyAction, reply: "ship it", accounts: [desk]) == .notSignedIn(host: "box"))
    let review = try #require(payload(["host": "box", "route": "review/s1/101", "event": "waiting"]))
    #expect(NotificationResponses.plan(review, action: NotificationResponses.approveAction, reply: nil, accounts: [box]) == .open(review.link, origin: box.origin), "no session to answer")
}

@Test func whatDidntGoThroughSaysSoWithoutClaimingMore() {
    let answer = NotificationPlan.answer(origin: box.origin, key: "u1", approve: true, prompt: "p1")
    #expect(NotificationResponses.failure(answer, error: nil, hostname: "box") == nil, "it went through")
    #expect(NotificationResponses.failure(answer, error: .conflict("it is asking something else now"), hostname: "box")?.body == "It’s asking something else now. Open it to see what.")
    #expect(NotificationResponses.failure(answer, error: .conflict("it is no longer waiting"), hostname: "box")?.title == "Not approved")
    let deny = NotificationPlan.answer(origin: box.origin, key: "u1", approve: false, prompt: nil)
    #expect(NotificationResponses.failure(deny, error: .notFound("session not found"), hostname: "box")?.title == "Not denied")
    let offline = NotificationResponses.failure(answer, error: .transport("The Internet connection appears to be offline."), hostname: "box")
    #expect(offline?.title == "Couldn’t reach box")
    #expect(offline?.body.contains("couldn’t confirm") == true, "a request lost on the way may still have landed")
    let reply = NotificationPlan.reply(origin: box.origin, key: "u1", text: "ship it")
    #expect(NotificationResponses.failure(reply, error: .unauthorized("expired"), hostname: "box")?.body.contains("Your words are kept") == true)
    #expect(NotificationResponses.failure(.notSignedIn(host: "box"), error: nil, hostname: nil)?.body == "This device isn’t signed in to box. Open Agent Hub to sign in.")
    #expect(NotificationResponses.failure(.open(.inbox(host: nil), origin: nil), error: .transport("x"), hostname: nil) == nil)
}

@Test func theBadgeAddsUpEveryHostsOwnCount() {
    var ledger = BadgeLedger()
    ledger.set(2, for: box.origin)
    ledger.set(1, for: desk.origin)
    #expect(ledger.total == 3, "a push from one host doesn't overwrite the other's")
    ledger.set(0, for: box.origin)
    #expect(ledger.total == 1)
    ledger.set(-4, for: desk.origin)
    #expect(ledger.total == 0)
    ledger.set(5, for: desk.origin)
    ledger.keep([box.origin])
    #expect(ledger.total == 0, "a host signed out of counts for nothing")
}

@Test func notificationPreferencesSavedBeforeAHostCouldBeMutedStillRead() throws {
    let old = Data(#"{"enabled":true,"needsYou":false,"finished":true,"privatePreview":true}"#.utf8)
    let prefs = try JSONDecoder().decode(DevicePreferences.Notifications.self, from: old)
    #expect(prefs.enabled && !prefs.needsYou && prefs.finished && prefs.privatePreview, "nothing reset by a new field")
    #expect(prefs.mutedHosts.isEmpty)
    var muted = prefs
    muted.mutedHosts = [box.origin]
    #expect(try JSONDecoder().decode(DevicePreferences.Notifications.self, from: JSONEncoder().encode(muted)) == muted)
}

@Test func theAppsOwnAlertsCarryThePromptTheyAreAbout() throws {
    func row(_ status: String, askId: String?) throws -> SessionRow {
        var object: [String: Any] = ["id": "@1", "uid": "u1", "name": "keys", "title": "Rotate keys", "statusSource": "screen", "project": "infra", "projectPath": "/p/infra", "status": status, "command": "claude", "agent": "claude", "answerable": true, "ask": ["kind": "command", "text": "Bash command\n./rotate.sh"]]
        if let askId { object["askId"] = askId }
        return SessionRow(key: "u1", host: "box", isLocal: true, dto: try JSONDecoder().decode(SessionDTO.self, from: JSONSerialization.data(withJSONObject: object)))
    }
    #expect(try row("waiting", askId: nil).dto.askId == nil, "an older host sends none")
    var watcher = AlertWatcher()
    let start = Date()
    _ = watcher.observe(origin: "h", rows: [try row("busy", askId: nil)], now: start)
    let alerts = watcher.observe(origin: "h", rows: [try row("waiting", askId: "f00dfeed00112233")], now: start.addingTimeInterval(40))
    #expect(alerts.first?.prompt == "f00dfeed00112233")
}

/// A host that records what it was asked.
private final class Recording: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var bodies: [String: [String: String]] = [:]
    func body(_ path: String) -> [String: String]? { lock.withLock { bodies[path] } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let json = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
        lock.withLock { bodies[request.url!.path] = json }
        return (Data("{}".utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@Test func anAnswerSendsThePromptItIsAbout() async throws {
    let host = Recording()
    let api = APIClient(origin: URL(string: "https://box.tail.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    try await api.answer("u1", approve: true, prompt: "p1")
    #expect(host.body("/api/sessions/u1/answer") == ["answer": "approve", "prompt": "p1"])
    try await api.answer("u2", approve: false)
    #expect(host.body("/api/sessions/u2/answer") == ["answer": "deny"], "without one, exactly what older hosts expect")
}

@Test func aSignInEndedWhileOfflineIsKeptUntilItsHostHearsOfIt() throws {
    let vault = CredentialVault(store: MemorySecretStore())
    #expect(vault.pendingLogouts().isEmpty)
    try vault.addPendingLogout("t1", origin: box.origin)
    try vault.addPendingLogout("t2", origin: desk.origin)
    try vault.addPendingLogout("t3", origin: box.origin)
    #expect(vault.pendingLogouts() == [box.origin: "t3", desk.origin: "t2"])
    try vault.clearPendingLogout(origin: box.origin)
    try vault.clearPendingLogout(origin: "https://gone.tail.ts.net")
    #expect(vault.pendingLogouts() == [desk.origin: "t2"])
}
