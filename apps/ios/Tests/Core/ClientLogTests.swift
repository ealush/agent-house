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

/// A clock tests move by hand.
private final class Clock: @unchecked Sendable {
    var now: Date
    init(_ now: Date) { self.now = now }
}

private let noon = Date(timeIntervalSince1970: 1_795_838_400) // 2026-11-22T12:00:00Z

private func scratch() -> (file: URL, defaults: UserDefaults) {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ah-clientlog-\(UUID().uuidString)")
    let suite = "ah.test.clientLog.\(UUID().uuidString)"
    return (dir.appendingPathComponent("log.jsonl"), UserDefaults(suiteName: suite)!)
}

@Test func nothingIsKeptUntilTheLogIsOnAndTheChoiceAndEntriesOutliveTheApp() throws {
    let (file, defaults) = scratch()
    let clock = Clock(noon)
    let log = ClientLog(file: file, defaults: defaults, now: { clock.now })
    log.event("request", ["path": .string("/api/state")])
    #expect(log.entries().isEmpty, "off by default")
    log.set(true)
    log.event("request", ["path": .string("/api/state")])
    log.save()
    let again = ClientLog(file: file, defaults: defaults, now: { clock.now })
    #expect(again.isOn)
    #expect(again.entries().map(\.kind) == ["logging", "request"])
    #expect(again.entries().last?.fields["path"] == .string("/api/state"))
    again.set(false)
    again.event("request")
    #expect(again.entries().map(\.kind) == ["logging", "request", "logging"], "off says so, then nothing more")
}

@Test func threeDaysAreKeptAndABundleTakesTheLastMinutesOrARange() {
    let entries = [-4 * 86400.0, -2 * 86400, -3600, -600, 0].map { ClientLog.Entry(at: noon.addingTimeInterval($0), kind: "request") }
    #expect(ClientLog.kept(entries, now: noon).count == 4)
    #expect(ClientLog.kept(entries, now: noon, max: 2).map(\.at) == [noon.addingTimeInterval(-600), noon])
    #expect(ClientLog.within(entries, from: noon.addingTimeInterval(-15 * 60), to: noon).count == 2)
    #expect(ClientLog.within(entries, from: noon.addingTimeInterval(-7200), to: noon.addingTimeInterval(-1800)).count == 1)
    #expect(ClientLog.within(entries, from: nil, to: nil).count == 5)
}

@Test func aRequestKeepsItsPathAndNeverASecretAndSendingTheLogIsNotInIt() throws {
    let (file, defaults) = scratch()
    let log = ClientLog(file: file, defaults: defaults)
    log.set(true)
    var req = URLRequest(url: URL(string: "https://desk.example.ts.net/api/auth/setup?code=123456&x=a%20b")!)
    req.httpMethod = "POST"
    log.request(req, status: 403, started: .now, error: .forbidden("no"))
    log.request(URLRequest(url: URL(string: "https://desk.example.ts.net/h/peer/api/state")!), status: nil, started: .now, error: .transport("The Internet connection appears to be offline."))
    log.request(URLRequest(url: URL(string: "https://desk.example.ts.net/api/system/logging/client")!), status: 201, started: .now, error: nil)
    let logged = log.entries().filter { $0.kind != "logging" }
    #expect(logged.count == 2)
    #expect(logged[0].kind == "request")
    #expect(logged[0].fields["path"] == .string("/api/auth/setup?code=…&x=a%20b"))
    #expect(logged[0].fields["status"] == .number(403))
    #expect(logged[0].fields["error"] == .string("no"))
    #expect(logged[1].kind == "network-error")
    #expect(logged[1].fields["path"] == .string("/h/peer/api/state"))
    #expect(logged[1].fields["status"] == nil)
}

@Test func aMessageKeepsItsWordsCappedAndItsAttachmentsSizesAsThisDeviceSentThem() {
    let detail = ClientLog.messageDetail("look /up/a.png and ~/notes/b.md", sizes: ["/up/a.png": 2048])
    #expect(detail["attachments"] == .array([.object(["ext": .string("png"), "bytes": .number(2048)]), .object(["ext": .string("md"), "bytes": .null])]))
    #expect(detail["attachmentBytes"] == .number(2048))
    #expect(ClientLog.messageDetail("plain words", sizes: [:])["attachments"] == nil)
    let long = ClientLog.messageDetail(String(repeating: "y", count: ClientLog.textKeep + 5), sizes: [:])
    #expect(long["chars"] == .number(Double(ClientLog.textKeep + 5)))
    #expect(long["text"]?.string?.count == ClientLog.textKeep + 1)
}

/// A host that keeps the bundles it's sent.
private actor Bundles {
    private(set) var bodies: [Data] = []
    func keep(_ body: Data) { bodies.append(body) }
    var last: Data? { bodies.last }
}

private struct LoggingHost: HTTPTransport {
    let bundles: Bundles
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let ok = HTTPURLResponse(url: request.url!, statusCode: request.httpMethod == "POST" ? 201 : 200, httpVersion: nil, headerFields: nil)!
        if request.url!.path == "/api/system/logging/client" {
            let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any] ?? [:]
            await bundles.keep(request.httpBody ?? Data())
            let n = (body["entries"] as? [Any])?.count ?? 0
            return (Data(#"{"file":"/home/me/.local/state/ah/logs/2026-11-22/client-120000-ios-iPhone.jsonl","entries":\#(n)}"#.utf8), ok)
        }
        return (Data(#"{"server":true,"dir":"/home/me/.local/state/ah/logs","keepDays":3,"days":[{"day":"2026-11-22","files":[{"name":"server.jsonl","bytes":10}]}]}"#.utf8), ok)
    }
    func upload(for request: URLRequest, fromFile file: URL) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func upload(for request: URLRequest, body: UploadBody, progress: @escaping @Sendable (Double) -> Void) async throws -> (Data, HTTPURLResponse) { fatalError("not used") }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
@Test func theLast15MinutesGoToTheHostWithANoteAndShareAsAFileTheHostWouldKeep() async throws {
    let (file, defaults) = scratch()
    let clock = Clock(noon.addingTimeInterval(-7200))
    let log = ClientLog(file: file, defaults: defaults, now: { clock.now })
    log.set(true)
    clock.now = noon.addingTimeInterval(-3600)
    log.event("request", ["path": .string("/api/old")])
    clock.now = noon.addingTimeInterval(-60)
    log.sent(ref: "u1", text: "what is this /up/a.png", enter: true, outcome: "delivered")
    clock.now = noon
    let bundles = Bundles()
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: LoggingHost(bundles: bundles), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let model = DeveloperSettings(api: api, log: log, hostSupports: true, sender: ClientLog.Sender(device: "iPhone", version: "1.0", build: "72", os: "iOS 26.1"), now: { clock.now })
    await model.load()
    #expect(model.host?.server == true)
    model.span = .minutes15
    #expect(model.picked.map(\.kind) == ["send"])
    model.note = "  it took a while  "
    await model.send()
    #expect(model.saved?.file.hasSuffix("client-120000-ios-iPhone.jsonl") == true)
    #expect(model.note.isEmpty)
    let raw = try #require(await bundles.last)
    let body = try #require(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
    #expect(body["note"] as? String == "it took a while")
    #expect((body["client"] as? [String: Any])?["app"] as? String == "ios")
    let sent = try #require((body["entries"] as? [[String: Any]])?.first)
    #expect(sent["kind"] as? String == "send")
    #expect(sent["text"] as? String == "what is this /up/a.png")

    model.span = .all
    let shared = try model.file()
    let lines = try String(contentsOf: shared, encoding: .utf8).split(separator: "\n")
    let header = try #require(try JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as? [String: Any])
    #expect(header["kind"] as? String == "bundle" && header["entries"] as? Int == lines.count - 1)
    #expect(lines.count == 4, "the header, the log turned on, the old request and the send")

    model.span = .range
    model.from = noon
    model.to = noon.addingTimeInterval(-60)
    #expect(model.badRange && model.picked.isEmpty)
}
