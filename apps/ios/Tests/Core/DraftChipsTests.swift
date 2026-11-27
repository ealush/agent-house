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

/// A host that keeps one draft: what was PUT, answered on GET.
private actor DraftHost {
    /// The draft as JSON, or none.
    var draft: Data?
    func set(_ json: Data?) { draft = json }
    /// The draft as an object, for the tests to read.
    var saved: [String: String] {
        guard let draft, let object = try? JSONSerialization.jsonObject(with: draft) as? [String: Any] else { return [:] }
        return object.mapValues { value in value as? String ?? "\(value)" }
    }
}

private struct DraftTransport: HTTPTransport {
    let host: DraftHost

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        if url.path == "/api/prompts" { return (Data("[]".utf8), ok) }
        if url.path.hasSuffix("/draft"), request.httpMethod == "PUT" {
            let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
            var draft = body
            draft["at"] = 1
            await host.set(try JSONSerialization.data(withJSONObject: draft))
        }
        let draft = await host.draft.map { String(decoding: $0, as: UTF8.self) } ?? "null"
        return (Data(#"{"draft":\#(draft)}"#.utf8), ok)
    }

    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func box(_ host: DraftHost, keepsParts: Bool) -> ComposerModel {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: DraftTransport(host: host), credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c1"))
    let composer = ComposerModel(api: api, outbox: Outbox(), key: "s1", uid: "s1", isShell: false, draftDebounce: .seconds(3600))
    composer.drafts.sendsParts = { keepsParts }
    return composer
}

@MainActor
@Test func aDraftsChipsComeBackAsChips() async {
    let host = DraftHost()
    let typed = box(host, keepsParts: true)
    typed.addSnippet(kind: .quote, body: "The cache misses on every\nsecond request.", source: "Claude")
    typed.addSnippet(kind: .paste, body: "line one\nline two")
    typed.text = "Why?"
    await typed.background()

    // Opened afresh (a relaunch, another device): the chips over the words again, not "> …".
    let opened = box(host, keepsParts: true)
    await opened.open()
    #expect(opened.snippets.map(\.kind) == [.quote, .paste])
    #expect(opened.snippets.first?.source == "Claude")
    #expect(opened.snippets.first?.body == "The cache misses on every\nsecond request.")
    #expect(opened.text == "Why?")
    #expect(opened.draftText == typed.draftText)
}

@MainActor
@Test func aDraftEditedWhereThereAreNoChipsIsWordsAlone() async {
    let host = DraftHost()
    // The web box saved it: its text changed, its chips gone with the edit, or left behind.
    await host.set(Data(#"{"text":"> quoted\n\nrewritten on the web","at":1,"device":"browser","client":"web","parts":[{"kind":"quote","body":"something else"}]}"#.utf8))
    let opened = box(host, keepsParts: true)
    await opened.open()
    #expect(opened.snippets.isEmpty)
    #expect(opened.text == "> quoted\n\nrewritten on the web")
}

@MainActor
@Test func anOlderHostIsSentTheTextAlone() async {
    let host = DraftHost()
    let typed = box(host, keepsParts: false)
    typed.addSnippet(kind: .paste, body: "a long log")
    typed.text = "look"
    await typed.background()
    let saved = await host.saved
    #expect(saved["text"] == "a long log\n\nlook")
    #expect(saved["parts"] == nil)
}

@Test func chipsArePutBackOnlyOverTheTextTheySend() {
    let parts = [DraftPart(kind: "quote", body: "a\nb"), DraftPart(kind: "reuse", body: "do it")]
    #expect(ComposerModel.chips(parts, in: "> a\n> b\n\ndo it\n\nthen this").words == "then this")
    #expect(ComposerModel.chips(parts, in: "> a\n> b\n\ndo it").chips == parts)
    #expect(ComposerModel.chips(parts, in: "> a\n> b\n\ndo it").words == "")
    #expect(ComposerModel.chips(parts, in: "> a\n> b\n\ndo it differently").chips.isEmpty)
    #expect(ComposerModel.chips(nil, in: "plain").words == "plain")
}
