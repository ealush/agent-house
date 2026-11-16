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

/// A host with Voice (`../ah/server/voice.ts`): answers settings, dictation and refine as told,
/// and keeps what it was asked.
private final class VoiceHost: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    var settings: [String: Any] = ["speech": NSNull(), "cleanup": NSNull(), "style": "clean", "language": "auto", "vocabulary": [], "maxBytes": 26_214_400]
    var dictation: (status: Int, body: [String: Any]) = (200, ["raw": "um fix the build", "text": "Fix the build.", "style": "clean", "speech": "Groq", "cleanedBy": "Claude"])
    var refined: (status: Int, body: [String: Any]) = (200, ["text": "Fix the build.", "cleanedBy": "Claude"])
    private(set) var asked: [(method: String, path: String, query: String?, body: Data?)] = []

    func paths() -> [String] { lock.withLock { asked.map { "\($0.method) \($0.path)" } } }
    func last(_ path: String) -> (query: String?, body: Data?)? { lock.withLock { asked.last { $0.path == path }.map { ($0.query, $0.body) } } }

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        lock.withLock { asked.append((request.httpMethod ?? "GET", url.path, url.query, request.httpBody)) }
        func answer(_ status: Int, _ object: Any) -> (Data, HTTPURLResponse) {
            (try! JSONSerialization.data(withJSONObject: object), HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
        switch url.path {
        case "/api/voice": return answer(200, settings)
        case "/api/voice/dictate": return answer(dictation.status, dictation.body)
        case "/api/voice/refine": return answer(refined.status, refined.body)
        case "/api/voice/models": return answer(200, ["models": ["whisper-large-v3-turbo"]])
        default: return answer(200, ["draft": NSNull()])
        }
    }
    func stream(for request: URLRequest) async throws -> (HTTPURLResponse, AsyncThrowingStream<Data, any Error>) { fatalError("not used") }
    func webSocket(for request: URLRequest) -> any WebSocketConnection { fatalError("not used") }
}

/// A microphone that hears what it's told to.
@MainActor
private final class FakeCapture: DictationCapture {
    var heard: String?
    var fromFile = "heard on the device"
    var startError: CaptureError?
    private(set) var startedWith: [Locale?] = []
    private(set) var transcribed: [URL] = []
    private(set) var cancelled = false
    let file: URL

    init() {
        file = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-test-\(UUID().uuidString).m4a")
        FileManager.default.createFile(atPath: file.path, contents: Data("aac".utf8))
    }

    func start(transcribing locale: Locale?, events: @escaping @MainActor (CaptureEvent) -> Void) async throws {
        startedWith.append(locale)
        if let startError, locale != nil || startError == .microphoneDenied { throw startError }
        events(.level(0.4))
        if locale != nil, let heard { events(.partial(heard)) }
    }
    func finish() async throws -> CaptureResult { CaptureResult(file: file, text: startedWith.last! == nil ? nil : heard) }
    func cancel() async { cancelled = true }
    func transcribe(_ file: URL, locale: Locale) async throws -> String { transcribed.append(file); return fromFile }
}

@MainActor
private func bed(_ host: VoiceHost, voice: Bool = true, draft: String = "") -> (DictationModel, ComposerModel, FakeCapture) {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let composer = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = draft
    composer.caret = draft.utf16.count
    let capture = FakeCapture()
    let model = DictationModel(api: api, thisDevice: "this iPhone", hostDoesVoice: { voice }, makeCapture: { capture })
    return (model, composer, capture)
}

private var groq: [String: Any] { ["subscriptionId": "s1", "name": "Groq", "model": "whisper-large-v3-turbo"] }
private var claude: [String: Any] { ["subscriptionId": "s2", "name": "Claude", "model": "claude-haiku-5-5"] }

@Test func theRouteFollowsTheHostSettings() {
    #expect(DictationRoute.of(nil) == .device(cleanup: nil), "a host without voice: this device, untidied")
    let pick = VoiceSettings.Pick(subscriptionId: "s1", name: "Groq", model: "w")
    let tidy = VoiceSettings.Pick(subscriptionId: "s2", name: "Claude", model: "")
    #expect(DictationRoute.of(VoiceSettings(speech: pick, cleanup: tidy)) == .host(speech: "Groq"))
    #expect(DictationRoute.of(VoiceSettings(cleanup: tidy)) == .device(cleanup: "Claude"))
    #expect(DictationRoute.of(VoiceSettings(cleanup: tidy, style: .verbatim)) == .device(cleanup: nil), "as said: nothing to tidy")
    #expect(VoiceSettings(language: "he").locale.identifier == "he")
}

@Test func settingsDecodeLenientlyAndChangesSendOnlyWhatChanged() throws {
    let old = try JSONDecoder().decode(VoiceSettings.self, from: Data(#"{"speech":null,"style":"rhyming"}"#.utf8))
    #expect(old == VoiceSettings(), "unknown or missing fields fall back")
    func json(_ change: VoiceChange) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return String(decoding: try encoder.encode(change), as: UTF8.self)
    }
    #expect(try json(VoiceChange(style: .structured)) == #"{"style":"structured"}"#)
    #expect(try json(VoiceChange(speech: .some(nil))) == #"{"speech":null}"#, "off is an explicit null")
    #expect(try json(VoiceChange(cleanup: .some(.init(subscriptionId: "s2", model: "m")))) == #"{"cleanup":{"model":"m","subscriptionId":"s2"}}"#)
}

@MainActor
@Test func withASpeechSubscriptionTheRecordingGoesToTheHostAndTheWordsGoInAtTheCaret() async throws {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.settings["cleanup"] = claude
    let (model, composer, capture) = bed(host, draft: "Then")
    await model.refresh()
    await model.toggle(into: composer)
    #expect(model.isListening)
    #expect(capture.startedWith == [nil], "the host hears it: this device only records")
    await model.toggle(into: composer)
    #expect(model.phase == .idle)
    #expect(composer.text == "Then Fix the build.", "at the caret, spaced from the draft; never sent")
    #expect(model.last == .init(text: "Fix the build.", raw: "um fix the build", heardBy: "Groq", cleanedBy: "Claude"))
    #expect(host.last("/api/voice/dictate")?.query == "name=speech.m4a&style=clean")
    #expect(!FileManager.default.fileExists(atPath: capture.file.path), "the recording is gone once written down")
    #expect(!host.paths().contains { $0.hasSuffix("/send") }, "dictation never sends")

    // Undo the cleanup while it's still in the box as it went in.
    #expect(model.canUseWhatWasSaid(in: composer.text))
    model.useWhatWasSaid(in: composer)
    #expect(composer.text == "Then um fix the build")
    #expect(composer.caret == "Then um fix the build".utf16.count)
    #expect(model.last == nil)
}

@MainActor
@Test func withoutASpeechSubscriptionThisDeviceHearsItAndTheHostTidiesIt() async throws {
    let host = VoiceHost()
    host.settings["cleanup"] = claude
    host.settings["language"] = "he"
    let (model, composer, capture) = bed(host)
    capture.heard = "um fix the build"
    await model.refresh()
    await model.toggle(into: composer)
    #expect(capture.startedWith.map { $0?.identifier } == ["he"], "this device listens, in the host's language")
    #expect(model.partial == "um fix the build", "its words show as it hears them")
    await model.toggle(into: composer)
    #expect(composer.text == "Fix the build.")
    #expect(model.last?.heardBy == "this iPhone")
    #expect(model.last?.cleanedBy == "Claude")
    let refine = try #require(host.last("/api/voice/refine")?.body)
    #expect(try JSONSerialization.jsonObject(with: refine) as? [String: String] == ["text": "um fix the build", "style": "clean"])
    #expect(!host.paths().contains("POST /api/voice/dictate"))
}

@MainActor
@Test func aHostWithoutVoiceLeavesItAllToThisDevice() async {
    let host = VoiceHost()
    let (model, composer, capture) = bed(host, voice: false)
    capture.heard = "run the tests"
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(composer.text == "run the tests")
    #expect(host.paths().filter { $0.contains("/api/voice") }.isEmpty, "an older host isn't asked")
}

@MainActor
@Test func whenTheSpeechProviderFailsThisDeviceWritesItDownAndSaysSo() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.dictation = (502, ["error": "speech provider: 401 Invalid API Key", "code": "voice_provider"])
    let (model, composer, capture) = bed(host)
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(capture.transcribed == [capture.file], "the recording, heard on the device instead")
    #expect(composer.text == "heard on the device")
    #expect(composer.takeEvents() == [.notice("Groq didn’t answer, so this iPhone wrote it down.")])
}

@MainActor
@Test func aCleanupThatFailsKeepsTheWordsAsSaid() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.settings["cleanup"] = claude
    host.dictation = (200, ["raw": "run it", "text": "run it", "speech": "Groq", "cleanedBy": NSNull(), "cleanupError": "chat provider: 529 overloaded"])
    let (model, composer, _) = bed(host)
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(composer.text == "run it")
    #expect(!model.canUseWhatWasSaid(in: composer.text), "nothing was tidied, so nothing to undo")
    #expect(composer.takeEvents() == [.notice("Couldn’t tidy it, so it’s as said: chat provider: 529 overloaded")])
}

@MainActor
@Test func silenceAddsNothingAndSaysSo() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.dictation = (200, ["raw": "", "text": "", "speech": "Groq", "cleanedBy": NSNull()])
    let (model, composer, _) = bed(host, draft: "keep me")
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(composer.text == "keep me")
    #expect(composer.takeEvents() == [.notice("Didn’t catch anything.")])
}

@MainActor
@Test func aRefusedMicrophoneAsksForSettingsAndASignInRefusalKeepsTheRecordingForLater() async {
    let host = VoiceHost()
    let (model, composer, capture) = bed(host, voice: false)
    capture.startError = .microphoneDenied
    await model.toggle(into: composer)
    #expect(model.phase == .denied)

    let host2 = VoiceHost()
    host2.settings["speech"] = groq
    host2.dictation = (401, ["error": "signed out"])
    let (model2, composer2, capture2) = bed(host2)
    await model2.refresh()
    await model2.toggle(into: composer2)
    await model2.toggle(into: composer2)
    #expect(model2.phase == .failed("signed out", retry: true))
    #expect(capture2.transcribed.isEmpty, "a sign-in problem isn't papered over")
    #expect(FileManager.default.fileExists(atPath: capture2.file.path), "kept for Try Again")
    host2.dictation = (200, ["raw": "ok", "text": "OK.", "speech": "Groq", "cleanedBy": "Claude"])
    await model2.retry(into: composer2)
    #expect(composer2.text == "OK.")
    #expect(!FileManager.default.fileExists(atPath: capture2.file.path))
}

@MainActor
@Test func cancellingKeepsNothing() async {
    let host = VoiceHost()
    let (model, composer, capture) = bed(host, voice: false, draft: "draft")
    capture.heard = "never mind"
    await model.toggle(into: composer)
    await model.cancel()
    #expect(capture.cancelled)
    #expect(model.phase == .idle)
    #expect(composer.text == "draft")
}

@Test func swappingBackFindsTheLastCopyOnly() {
    #expect(DictationModel.swap("Fix it. Fix it.", "Fix it.", for: "fix it")! == ("Fix it. fix it", 14))
    #expect(DictationModel.swap("edited away", "Fix it.", for: "fix it") == nil)
    #expect(DictationModel.swap("שלום Fix it.", "Fix it.", for: "fix it")!.caret == "שלום fix it".utf16.count)
}
