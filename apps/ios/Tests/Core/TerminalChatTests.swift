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

// The attached terminal's text into a message (Send to Chat), and a snippet typed, not run.

private final class TextHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [URLRequest] = []
    var requests: [URLRequest] { lock.withLock { recorded } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lock.withLock { recorded.append(request) }
        let body = request.url?.path.hasSuffix("/text") == true
            ? #"{"terminal":{"id":"@42","cwd":"~/ah","command":"bash","busy":false},"last":{"command":"pnpm test","line":"[me@box ah]$ pnpm test","output":"ok 12\nfail 0","running":false,"truncated":false},"screen":"[me@box ah]$ pnpm test\nok 12\nfail 0\n[me@box ah]$"}"#
            : #"{"terminal":{"id":"@42","cwd":"~/ah","command":"bash","busy":false}}"#
        return (Data(body.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { throw URLError(.unsupportedURL) }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

private func client(_ host: TextHost) -> APIClient {
    APIClient(origin: URL(string: "https://box.tail.ts.net")!, transport: host, credentials: AccountCredentials(token: "device", onRejected: {}), device: DeviceDescriptor(name: "iPad", client: "test"))
}

@Test func theTerminalsTextIsReadFromItsOwnersRoute() async throws {
    let host = TextHost()
    let text = try await client(host).peer("desk").terminalText("owner")
    #expect(host.requests.map(\.httpMethod) == ["GET"])
    #expect(host.requests.first?.url?.path == "/h/desk/api/sessions/owner/terminal/text")
    #expect(text.last?.command == "pnpm test")
    #expect(text.last?.output == "ok 12\nfail 0")
    #expect(text.screen?.hasSuffix("[me@box ah]$") == true)
}

@Test func aSnippetTypedWithoutRunningSaysSoAndARunOneSendsWhatItAlwaysDid() async throws {
    let host = TextHost()
    let api = client(host)
    _ = try await api.openTerminal("owner", command: "make deploy", run: false)
    _ = try await api.openTerminal("owner", command: "make")
    _ = try await api.openTerminal("owner")
    let bodies = host.requests.map { request in
        (request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]) ?? ["unreadable": true]
    }
    #expect(bodies.count == 3)
    #expect(bodies[0]["command"] as? String == "make deploy")
    #expect(bodies[0]["run"] as? Bool == false)
    // An older host refuses nothing it didn't know: a run sends only the command, as before.
    #expect(bodies[1].keys.sorted() == ["command"])
    #expect(bodies[2].isEmpty)
}

@Test func theLastCommandGoesInAsTheTerminalShowedIt() {
    let last = LastCommandDTO(command: "pnpm test", line: "[me@box ah]$ pnpm test", output: "ok 12\nfail 0", running: false, truncated: false)
    #expect(TerminalQuote.lastCommand(last) == "```console\n[me@box ah]$ pnpm test\nok 12\nfail 0\n```")
    #expect(TerminalQuote.plain(last) == "[me@box ah]$ pnpm test\nok 12\nfail 0")
    #expect(TerminalQuote.title(last) == "pnpm test")
    let running = LastCommandDTO(command: "npm run dev", line: "$ npm run dev", output: "ready on :5173", running: true, truncated: true)
    #expect(TerminalQuote.lastCommand(running) == "Still running; what it has printed so far:\n```console\n$ npm run dev\n…\nready on :5173\n```")
    #expect(TerminalQuote.title(running) == "npm run dev · running")
    let quiet = LastCommandDTO(command: "true", line: "$ true", output: "", running: false, truncated: false)
    #expect(TerminalQuote.lastCommand(quiet) == "```console\n$ true\n```")
    let long = LastCommandDTO(command: String(repeating: "x", count: 80), line: "", output: "", running: false, truncated: false)
    #expect(TerminalQuote.title(long).count == 48)
}

@Test func backticksInTheTerminalNeverCloseItsFence() {
    #expect(TerminalQuote.fenced("plain\n\n") == "```\nplain\n```")
    #expect(TerminalQuote.fenced("a ``` b") == "````\na ``` b\n````")
    #expect(TerminalQuote.fenced("`````") == "``````\n`````\n``````")
}

@MainActor
@Test func aBlockGoesAfterWhatsInTheBoxWithTheCaretAfterIt() {
    let api = client(TextHost())
    let composer = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.addBlock("```\nx\n```")
    #expect(composer.text == "```\nx\n```\n")
    composer.text = "Why did this fail?  \n"
    composer.caret = 3
    composer.addBlock("```\ny\n```")
    #expect(composer.text == "Why did this fail?\n\n```\ny\n```\n")
    #expect(composer.caret == composer.text.utf16.count)
}
