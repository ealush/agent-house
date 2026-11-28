import Foundation
import Testing
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if SWIFT_PACKAGE
@testable import AgentHubKit
#else
@testable import AgentHubNative
#endif

// Updating the hub's host from GitHub (`HostUpdater`, `apps/server/server/update.ts`): the
// app sends what it gates on, says what the host answers (a refusal, a failed build's log,
// already current), and after an update waits to see the host run what it built.

/// A host that answers the version and update routes as told, and keeps what it was sent.
private actor UpdateHost {
    var commit = "aaaaaaaa11111111"
    var update: (status: Int, body: String) = (200, "")
    var restartsAfter = 0
    struct Sent: Decodable { let check: Bool?; let requires: [String: Int] }
    private(set) var sent: [Sent] = []
    private var versionAsks = 0

    func answer(_ request: URLRequest) -> (Int, String) {
        switch (request.httpMethod ?? "GET", request.url!.path) {
        case ("GET", "/api/system/version"):
            versionAsks += 1
            // Down while it restarts, for `restartsAfter` asks.
            if versionAsks <= restartsAfter { return (502, #"{"error":"bad gateway"}"#) }
            return (200, #"{"api":28,"commit":"\#(commit)","branch":"main","committedAt":"2026-11-28T10:00:00+00:00","subject":"what runs","clean":true,"appReleases":["1.0","1.1"]}"#)
        case ("POST", "/api/system/update"):
            guard let body = try? JSONDecoder().decode(Sent.self, from: request.httpBody ?? Data()) else { return (400, #"{"error":"bad body"}"#) }
            sent.append(body)
            if body.check == true {
                return (200, #"{"current":{"commit":"\#(commit)","branch":"main","committedAt":"2026-11-28T10:00:00+00:00","subject":"what runs","clean":true,"appReleases":["1.0"]},"target":{"commit":"bbbbbbbb22222222","committedAt":"2026-11-28T12:00:00+00:00","subject":"newer"},"behind":3,"missing":[]}"#)
            }
            return update
        default:
            return (404, #"{"error":"not found"}"#)
        }
    }

    func set(update: (Int, String), restartsAfter: Int = 0, thenCommit: String? = nil) {
        self.update = update
        self.restartsAfter = restartsAfter
        versionAsks = 0
        if let thenCommit { commit = thenCommit }
    }
}

private struct UpdateTransport: HTTPTransport {
    let host: UpdateHost
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body) = await host.answer(request)
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
    }
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func updater(_ host: UpdateHost, requires: [String: Int] = ["notes": 2, "spaces": 3]) -> HostUpdater {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: UpdateTransport(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    return HostUpdater(api: api, requires: requires, restartTries: 5, pause: { _ in })
}

@MainActor
@Test func theHostSaysWhatItRunsAndAChecksSaysWhatGitHubHasSendingWhatThisAppNeeds() async throws {
    let host = UpdateHost()
    let model = updater(host)
    await model.loadVersion()
    #expect(model.version?.short == "aaaaaaaa")
    #expect(model.version?.appReleases == ["1.0", "1.1"])
    await model.lookForUpdate()
    #expect(model.phase == .idle)
    #expect(model.check?.behind == 3)
    #expect(model.check?.target.subject == "newer")
    let sent = try #require(await host.sent.last)
    #expect(sent.check == true)
    #expect(sent.requires == ["notes": 2, "spaces": 3])
}

@MainActor
@Test func anUpdateSendsWhatThisAppNeedsAndWaitsToSeeTheHostRunWhatItBuilt() async throws {
    let host = UpdateHost()
    let model = updater(host)
    await host.set(update: (200, #"{"ok":true,"updated":true,"from":"aaaaaaaa11111111","to":"bbbbbbbb22222222","restarting":true}"#), restartsAfter: 2, thenCommit: "bbbbbbbb22222222")
    await model.update()
    #expect(model.phase == .idle)
    #expect(model.version?.commit == "bbbbbbbb22222222")
    #expect(model.error == nil && model.buildLog == nil)
    let sent = try #require(await host.sent.last)
    #expect(sent.check == nil)
    #expect(sent.requires == ["notes": 2, "spaces": 3])
}

@MainActor
@Test func anUpdateThatFindsTheHostCurrentSaysSoAndNothingRestarts() async {
    let host = UpdateHost()
    let model = updater(host)
    await host.set(update: (200, #"{"ok":true,"updated":false,"from":"aaaaaaaa11111111","to":"aaaaaaaa11111111","restarting":false}"#))
    await model.update()
    #expect(model.phase == .idle)
    #expect(model.alreadyCurrent)
}

@MainActor
@Test func aFailedBuildKeepsItsLogAndARefusalItsReason() async {
    let host = UpdateHost()
    let model = updater(host)
    await host.set(update: (500, #"{"error":"ERR_PNPM_OUTDATED_LOCKFILE build-broke","code":"build_failed"}"#))
    await model.update()
    #expect(model.phase == .idle)
    #expect(model.buildLog?.contains("build-broke") == true)
    #expect(model.error == nil)

    await host.set(update: (409, #"{"error":"No server on GitHub serves this app yet: main lacks spaces 3.","code":"no_matching_server"}"#))
    await model.update()
    #expect(model.buildLog == nil)
    #expect(model.error == "No server on GitHub serves this app yet: main lacks spaces 3.")
}

@MainActor
@Test func theHubCallsItsHostBehindByWhatItLacksOfThisApp() throws {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: UpdateTransport(host: UpdateHost()), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let hub = HubStore(api: api)
    // Before the host answers: nothing to say.
    #expect(hub.hostBehind.isEmpty)
    #expect(hub.hostUpdate.requires == AppProtocol.requires)
}
