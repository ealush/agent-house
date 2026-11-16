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

/// A host whose Voice settings take what they're given, with a Groq and a Claude subscription.
private final class SettingsHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    var subscriptions: [[String: Any]] = [
        ["id": "s1", "name": "Claude", "baseUrl": "https://api.anthropic.com/v1", "model": "claude-sonnet-5-5", "hasKey": true, "keyHint": "sk-…x", "isDefault": true, "envName": NSNull()],
        ["id": "s2", "name": "Groq", "baseUrl": "https://api.groq.com/openai/v1", "model": "openai/gpt-oss-120b", "hasKey": true, "keyHint": "gsk…y", "isDefault": false, "envName": NSNull()],
    ]
    var speechModels: [String: [String]] = ["s1": [], "s2": ["whisper-large-v3", "whisper-large-v3-turbo"]]
    private var settings: [String: Any] = ["speech": NSNull(), "cleanup": NSNull(), "style": "clean", "language": "auto", "vocabulary": []]
    private(set) var puts: [[String: Any]] = []

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        func answer(_ object: Any, _ status: Int = 200) -> (Data, HTTPURLResponse) {
            (try! JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        return lock.withLock {
            switch (request.httpMethod ?? "GET", url.path) {
            case ("GET", "/api/voice"): return answer(settings)
            case ("PUT", "/api/voice"):
                puts.append(body)
                for (k, v) in body {
                    if let pick = v as? [String: Any], let id = pick["subscriptionId"] as? String {
                        let sub = subscriptions.first { $0["id"] as? String == id }!
                        let model = (pick["model"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? sub["model"] as! String
                        settings[k] = ["subscriptionId": id, "name": sub["name"]!, "model": model]
                    } else {
                        settings[k] = v
                    }
                }
                return answer(settings)
            case ("GET", "/api/subscriptions"): return answer(subscriptions)
            case ("POST", "/api/voice/models"): return answer(["models": speechModels[body["subscriptionId"] as? String ?? ""] ?? []])
            case ("POST", "/api/subscriptions/models"): return answer(["models": ["claude-haiku-5-5", "claude-sonnet-5-5"]])
            default: return answer(["error": "no"], 404)
            }
        }
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

@MainActor
private func voicePage(_ host: SettingsHost) -> VoiceSettingsModel {
    VoiceSettingsModel(api: APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c")))
}

@Test func aSpeechSubscriptionStartsOnItsFastestWhisper() {
    #expect(VoiceSettingsModel.preferredSpeechModel(["whisper-large-v3", "whisper-large-v3-turbo"]) == "whisper-large-v3-turbo")
    #expect(VoiceSettingsModel.preferredSpeechModel(["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"]) == "gpt-4o-mini-transcribe")
    #expect(VoiceSettingsModel.preferredSpeechModel(["parakeet-x"]) == "parakeet-x")
    #expect(VoiceSettingsModel.preferredSpeechModel([]) == nil)
    #expect(VoiceSettingsModel.languages(including: "auto").first == "en")
    #expect(VoiceSettingsModel.languages(including: "sw").last == "sw", "a language set elsewhere stays pickable")
}

@MainActor
@Test func theVoicePageSavesEachChoiceAsItIsMade() async throws {
    let host = SettingsHost()
    let page = voicePage(host)
    await page.load(hostDoesVoice: nil)
    #expect(!page.loaded && page.settings == nil, "not asked before the host's state says it does voice")
    await page.load(hostDoesVoice: true)
    #expect(page.settings?.speech == nil)
    #expect(page.subscriptions.map(\.name) == ["Claude", "Groq"])

    await page.hearWith("s2")
    #expect(page.settings?.speech == .init(subscriptionId: "s2", name: "Groq", model: "whisper-large-v3-turbo"))
    #expect(page.speechModels == ["whisper-large-v3", "whisper-large-v3-turbo"])

    await page.hearWith("s1")
    #expect(page.error == "Claude lists no speech models. Groq and OpenAI keys can hear you.")
    #expect(page.settings?.speech?.name == "Groq", "nothing saved for a provider that can't hear")

    await page.tidyWith("s1")
    #expect(page.settings?.cleanup == .init(subscriptionId: "s1", name: "Claude", model: "claude-sonnet-5-5"))
    #expect(page.chatModels == ["claude-haiku-5-5", "claude-sonnet-5-5"])
    await page.setCleanupModel("claude-haiku-5-5")
    await page.setStyle(.structured)
    await page.addWord(" SwiftUI ")
    await page.addWord("swiftui")
    await page.addWord("GRDB")
    #expect(page.settings?.vocabulary == ["SwiftUI", "GRDB"], "trimmed; the same word twice is one")
    await page.removeWord("SwiftUI")
    await page.hearWith(nil)
    #expect(page.settings?.speech == nil, "back to this device")
    #expect(host.puts.last?["speech"] is NSNull, "off is said, not left out")
    #expect(page.settings?.cleanup?.model == "claude-haiku-5-5")
    #expect(page.settings?.style == .structured)
}

@MainActor
@Test func aKeyAddedFromTheVoicePageHearsYouAtOnce() async {
    let host = SettingsHost()
    host.subscriptions.removeLast()
    let page = voicePage(host)
    await page.load(hostDoesVoice: true)
    host.subscriptions.append(["id": "s3", "name": "Groq", "baseUrl": "https://api.groq.com/openai/v1", "model": "openai/gpt-oss-120b", "hasKey": true, "keyHint": "gsk…", "isDefault": false, "envName": NSNull()])
    host.speechModels["s3"] = ["whisper-large-v3-turbo"]
    await page.added()
    #expect(page.settings?.speech?.subscriptionId == "s3")
}

@MainActor
@Test func aHostWithoutVoiceIsNotAsked() async {
    let host = SettingsHost()
    let page = voicePage(host)
    await page.load(hostDoesVoice: false)
    #expect(page.loaded)
    #expect(page.settings == nil)
    #expect(host.puts.isEmpty)
}
