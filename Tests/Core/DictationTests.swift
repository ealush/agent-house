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
    /// What each batch "says", in order (a batched dictation), and how many of the next
    /// dictate calls fail first.
    var batchTexts: [String] = []
    var failing = 0
    private(set) var asked: [(method: String, path: String, query: String?, body: Data?)] = []

    func all(_ path: String) -> [(query: String?, body: Data?)] { lock.withLock { asked.filter { $0.path == path }.map { ($0.query, $0.body) } } }

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
        case "/api/voice/dictate":
            let next: (Int, Any) = lock.withLock {
                if failing > 0 { failing -= 1; return (502, ["error": "speech provider: 503 busy", "code": "voice_provider"]) }
                if !batchTexts.isEmpty { let t = batchTexts.removeFirst(); return (200, ["raw": t, "text": t, "style": "verbatim", "speech": "Groq", "cleanedBy": NSNull()]) }
                return (dictation.status, dictation.body)
            }
            return answer(next.0, next.1)
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
    /// Batches cut while listening (each a file), and the one still open at Done.
    var batches = 0
    /// Batches cut whose word never reached the model before Done (returned only by finish).
    var unannounced = 0
    var slowStart = false
    /// A batch whose word reaches the model only after Done (as the audio thread's can).
    var late = false
    /// Seconds of speech each batch holds, by its loudness.
    var speechPerBatch: TimeInterval = 0.5
    /// This device's words with when each began (else `heard`, all at the start).
    var heardRuns: [HeardWords]?
    private var events: (@MainActor (CaptureEvent) -> Void)?
    private(set) var batchFiles: [URL] = []
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
        self.events = events
        if slowStart { try? await Task.sleep(for: .milliseconds(150)) }
        if let startError, locale != nil || startError == .microphoneDenied { throw startError }
        events(.level(0.4))
        if locale != nil, let heard { events(.partial(heardRuns ?? [HeardWords(text: heard, start: 0)])) }
        for _ in 0..<batches { events(.batch(newFile(), speech: speechPerBatch, end: 10)) }
    }
    func finish() async throws -> CaptureResult {
        let announced = batchFiles
        var quiet = (0..<unannounced).map { _ in newFile() }
        if late {
            let file = newFile()
            events?(.batch(file, speech: speechPerBatch, end: 20))
            quiet.append(file)
        }
        let tail = batches + unannounced > 0 ? newFile() : nil
        let all = announced + quiet + [tail].compactMap { $0 }
        return CaptureResult(file: file, text: startedWith.last! == nil ? nil : heard, lastBatch: tail, batches: announced + quiet, speech: Dictionary(uniqueKeysWithValues: all.map { ($0, speechPerBatch) }))
    }
    private func newFile() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-batch-\(UUID().uuidString).m4a")
        FileManager.default.createFile(atPath: url.path, contents: Data("aac".utf8))
        batchFiles.append(url)
        return url
    }
    func cancel() async { cancelled = true }
    func transcribe(_ file: URL, locale: Locale) async throws -> String { transcribed.append(file); return fromFile }
}

@MainActor
private func bed(_ host: VoiceHost, voice: Bool = true, draft: String = "", live: Bool = true) -> (DictationModel, ComposerModel, FakeCapture) {
    let api = APIClient(origin: URL(string: "https://desk.example.ts.net")!, transport: host, credentials: AccountCredentials(token: "t", onRejected: {}), device: DeviceDescriptor(name: "iPhone", client: "c"))
    let composer = ComposerModel(api: api, outbox: Outbox(), key: "u1", uid: "u1", isShell: false, draftDebounce: .seconds(3600))
    composer.text = draft
    composer.caret = draft.utf16.count
    let capture = FakeCapture()
    let model = DictationModel(api: api, thisDevice: "this iPhone", hostDoesVoice: { voice }, makeCapture: { capture }, wordsAsYouSpeak: { live })
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
    #expect(capture.startedWith.count == 1 && capture.startedWith[0] != nil, "the host hears it; this device listens too, for the cleanup's second hearing")
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
    #expect(model.levels == [0.4] && model.levelCount == 1, "how loud, for the box's waves")
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
    #expect(model.levels.isEmpty && model.levelCount == 0, "the waves go with it")
    #expect(composer.text == "draft")
}

@Test func whatWentInIsFoundWhereItWentInOrNotAtAll() {
    let twice = "Fix it. Fix it."
    #expect(DictationModel.replacing("Fix it.", at: 8, in: twice, with: "fix it")! == ("Fix it. fix it", 14), "the copy that went in, not the other")
    #expect(DictationModel.replacing("Fix it.", at: 0, in: twice, with: "fix it")! == ("fix it Fix it.", 6))
    #expect(DictationModel.replacing("Fix it.", at: 3, in: twice, with: "x") == nil, "not where it went in: no guessing")
    #expect(DictationModel.replacing("Fix it.", at: 0, in: "Hi Fix it.", with: "x") == nil, "the same words elsewhere may be yours")
    #expect(DictationModel.replacing("Fix it.", at: 0, in: "edited away", with: "x") == nil)
    #expect(DictationModel.change(from: "abc", to: "aXbc")! == (1, 1, 1))
    #expect(DictationModel.change(from: "abc", to: "ac")! == (1, 2, -1))
    #expect(DictationModel.change(from: "Repeat.Repeat.", to: "Repeat.")! == (0, 14, -7), "either copy could be the one gone")
    #expect(DictationModel.change(from: "aa", to: "aaa")! == (0, 2, 1), "a letter added to a run could be anywhere in it")
    #expect(DictationModel.change(from: "abc", to: "abc") == nil)
    #expect(DictationModel.replacing("Fix it.", at: 5, in: "שלום Fix it.", with: "fix it")!.caret == "שלום fix it".utf16.count)
}

@MainActor
@Test func theFirstTapAfterAColdStartAsksTheHostBeforeGuessing() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    let (model, composer, capture) = bed(host, live: false)
    // No refresh first: the settings aren't known when the microphone is tapped.
    await model.toggle(into: composer)
    #expect(capture.startedWith == [nil], "the host hears it, so this device only records")
    await model.toggle(into: composer)
    #expect(composer.text == "Fix the build.")
}

@MainActor
@Test func whenThisDeviceCantListenTheHostsSpeechSubscriptionStillCan() async {
    let host = VoiceHost()
    let (model, composer, capture) = bed(host)
    await model.refresh()
    capture.startError = .failed("Couldn’t get English ready on this iPhone.")
    host.settings["speech"] = groq
    await model.toggle(into: composer)
    #expect(capture.startedWith.count == 2 && capture.startedWith.last! == nil, "tried here, then recorded for the host")
    #expect(model.isListening)
}

@MainActor
private func until(_ done: () -> Bool) async {
    for _ in 0..<400 where !done() { try? await Task.sleep(for: .milliseconds(5)) }
}

private func query(_ q: String?) -> [String: String] {
    Dictionary(uniqueKeysWithValues: (URLComponents(string: "x:/?" + (q ?? ""))?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
}

@MainActor
@Test func aLongDictationIsHeardInBatchesAndGoesInAsYouSpeak() async throws {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.settings["cleanup"] = claude
    host.batchTexts = ["okay so first", "then the second part", "and the last"]
    host.refined = (200, ["text": "First, the second part, and the last.", "cleanedBy": "Claude"])
    let (model, composer, capture) = bed(host, draft: "Note:")
    capture.heard = "okay so first then the second part and the last"
    capture.batches = 2
    await model.refresh()
    await model.toggle(into: composer)
    #expect(capture.startedWith.map { $0?.identifier } == [Locale.current.identifier], "this device listens too: the words as you speak, and the cleanup's second hearing")
    await until { composer.text == "Note: okay so first then the second part" }
    #expect(composer.text == "Note: okay so first then the second part", "each batch goes in as it's heard, after the one before")
    #expect(model.isListening)
    await model.toggle(into: composer)
    #expect(composer.text == "Note: First, the second part, and the last.", "tidied once, in place of what went in as you spoke")
    #expect(model.last?.raw == "okay so first then the second part and the last")

    let batches = host.all("/api/voice/dictate").map { query($0.query) }
    #expect(batches.map { $0["style"] } == ["verbatim", "verbatim", "verbatim"], "batches are only heard")
    #expect(batches.map { $0["context"] } == [nil, "okay so first", "okay so first then the second part"], "each goes with what was heard before it")
    let refine = try #require(host.last("/api/voice/refine")?.body)
    #expect(try JSONSerialization.jsonObject(with: refine) as? [String: String] == ["text": "okay so first then the second part and the last", "style": "clean", "phone": "okay so first then the second part and the last"])
    #expect(capture.batchFiles.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) }, "every batch's file is gone")
    #expect(!host.paths().contains { $0.hasSuffix("/send") })
}

@MainActor
@Test func withoutWordsAsYouSpeakTheBatchesGoInWhenYouAreDone() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["one", "two"]
    let (model, composer, capture) = bed(host, live: false)
    capture.batches = 1
    await model.refresh()
    await model.toggle(into: composer)
    #expect(capture.startedWith == [nil], "nothing needs this device's words: it only records")
    try? await Task.sleep(for: .milliseconds(50))
    #expect(composer.text.isEmpty, "nothing in the box while you speak")
    await model.toggle(into: composer)
    #expect(composer.text == "one two")
}

@MainActor
@Test func aBatchTheHostCantHearIsHeardByThisDevice() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["the rest"]
    host.failing = 2
    let (model, composer, capture) = bed(host, live: false)
    capture.batches = 1
    capture.fromFile = "the start"
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(composer.text == "the start the rest", "tried twice, then this device; the rest by the host")
    #expect(capture.transcribed.count == 1)
    #expect(composer.takeEvents() == [.notice("Groq didn’t answer for part of it, so this iPhone wrote that part down.")])
}

@MainActor
@Test func cancellingTakesBackWhatWentInAsYouSpoke() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["never mind this"]
    let (model, composer, capture) = bed(host, draft: "Keep")
    capture.batches = 1
    await model.refresh()
    await model.toggle(into: composer)
    await until { model.placed == "never mind this" }
    #expect(composer.text == "Keep never mind this")
    await model.cancel(in: composer)
    #expect(composer.text.trimmingCharacters(in: .whitespaces) == "Keep")
    #expect(model.phase == .idle)
}

@Test func batchesAreCutAtAPauseOnceTheyHoldTenSeconds() {
    var cutter = BatchCutter()
    let buffer = 0.085
    func run(_ seconds: Double, _ level: Float) -> [Double] {
        var cuts: [Double] = []
        var t = 0.0
        while t < seconds - 1e-9 {
            t += buffer
            if cutter.take(seconds: buffer, level: level) { cuts.append(t) }
        }
        return cuts
    }
    _ = run(0.5, 0.1)
    #expect(run(8, 0.7).isEmpty, "speech")
    #expect(run(0.6, 0.1).isEmpty, "a pause under ten seconds is no cut")
    #expect(run(1.5, 0.7).isEmpty, "past ten seconds, still speaking")
    #expect(run(0.6, 0.1).count == 1, "the first pause past ten seconds")
    #expect(cutter.length < 0.5, "the next batch starts there")
    let long = run(29, 0.7)
    #expect(long.isEmpty, "no pause yet")
    #expect(run(1, 0.75).isEmpty, "louder: still not a moment to cut")
    #expect(run(0.2, cutter.floor + 0.15).count == 1, "past thirty seconds, a quieter moment, short of a pause")
    var steady = BatchCutter()
    _ = steady.take(seconds: 0.5, level: 0.2)
    var at: Double?
    var t = 0.5
    while at == nil, t < 60 { t += buffer; if steady.take(seconds: buffer, level: 0.9) { at = t } }
    #expect((40...41).contains(at ?? 0), "forty seconds of one loud sound: cut anyway")
}

@MainActor
@Test func review_aDraftThatSaysTheSameIsntTheOneTakenBack() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["Repeat."]
    let (model, composer, capture) = bed(host, draft: "Repeat.")
    composer.caret = 0
    capture.batches = 1
    await model.refresh()
    await model.toggle(into: composer)
    await until { model.placed == "Repeat." }
    #expect(composer.text == "Repeat.Repeat.")
    await model.cancel(in: composer)
    #expect(composer.text == "Repeat.", "the copy dictation put in goes; yours stays")
}

@MainActor
@Test func review_anEditWhileItGoesInIsKeptAndNothingIsDoubled() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.settings["cleanup"] = claude
    host.batchTexts = ["alpha", "beta"]
    let (model, composer, capture) = bed(host)
    capture.batches = 1
    await model.refresh()
    await model.toggle(into: composer)
    await until { model.placed == "alpha" }
    composer.text = "ALPHA"
    composer.caret = 5
    await model.toggle(into: composer)
    #expect(composer.text == "ALPHA beta", "the edit stays, the rest goes after it, nothing twice")
    #expect(composer.takeEvents() == [.notice("Kept your edits; the rest went in as said.")])
    #expect(host.last("/api/voice/refine") == nil, "nothing tidies over your edit")
}

@MainActor
@Test func review_aBatchCutJustBeforeDoneIsStillHeard() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["first", "second", "last"]
    let (model, composer, capture) = bed(host, live: false)
    capture.batches = 1
    capture.unannounced = 1
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(composer.text == "first second last")
    #expect(capture.batchFiles.allSatisfy { !FileManager.default.fileExists(atPath: $0.path) })
}

@MainActor
@Test func review_aStartCancelledWhileItWaitedStopsThere() async {
    let host = VoiceHost()
    let (model, composer, capture) = bed(host, voice: false)
    capture.slowStart = true
    let starting = Task { await model.toggle(into: composer) }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(model.phase == .starting)
    await model.cancel(in: composer)
    await starting.value
    #expect(model.phase == .idle, "it doesn't come back to life once its wait is over")
    #expect(capture.cancelled)
}

@MainActor
@Test func review_closingTheSessionLeavesNoRecordingBehind() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.dictation = (401, ["error": "signed out"])
    let (model, composer, capture) = bed(host, live: false)
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(model.phase == .failed("signed out", retry: true))
    #expect(FileManager.default.fileExists(atPath: capture.file.path))
    model.close(into: composer)
    #expect(!FileManager.default.fileExists(atPath: capture.file.path), "the kept recording is deleted")

    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("sweep-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    FileManager.default.createFile(atPath: folder.appendingPathComponent("dictation-1.m4a").path, contents: Data("x".utf8))
    FileManager.default.createFile(atPath: folder.appendingPathComponent("other.m4a").path, contents: Data("x".utf8))
    DictationModel.sweep(folder)
    #expect((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) == ["other.m4a"])
}

@MainActor
@Test func review2_whatWentInIsFollowedThroughYourEditsAndYourCopyIsNeverTaken() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["Repeat."]
    let (model, composer, capture) = bed(host, draft: "Repeat.")
    composer.caret = 0
    capture.batches = 1
    await model.refresh()
    await model.toggle(into: composer)
    await until { model.placed == "Repeat." }
    #expect(composer.text == "Repeat.Repeat.")
    // You change the dictated copy: it's yours now, and so is the original.
    composer.text = "Changed.Repeat."
    await model.cancel(in: composer)
    #expect(composer.text == "Changed.Repeat.", "nothing taken: neither copy is dictation's for sure any more")

    // Typed before what went in: it moves, and is still found.
    let host2 = VoiceHost()
    host2.settings["speech"] = groq
    host2.batchTexts = ["one", "two"]
    let (model2, composer2, capture2) = bed(host2)
    capture2.batches = 1
    await model2.refresh()
    await model2.toggle(into: composer2)
    await until { model2.placed == "one" }
    composer2.text = "Hi " + composer2.text
    composer2.caret = composer2.text.utf16.count
    await model2.toggle(into: composer2)
    #expect(composer2.text == "Hi one two", "the next part joins it where it moved to")
}

@MainActor
@Test func review2_aRecordingThatFailsAfterItsSessionClosedIsDeleted() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.dictation = (401, ["error": "signed out"])
    let (model, composer, capture) = bed(host, live: false)
    await model.refresh()
    await model.toggle(into: composer)
    model.close(into: composer)
    await until { model.phase != .writing && !model.isListening }
    try? await Task.sleep(for: .milliseconds(50))
    #expect(model.phase == .idle, "no Try Again for a session that's gone")
    #expect(!FileManager.default.fileExists(atPath: capture.file.path))
}

@MainActor
@Test func review3_deletingOneOfTwoSameCopiesTakesNothingOfYours() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["Repeat."]
    let (model, composer, capture) = bed(host, draft: "Repeat.")
    composer.caret = 0
    capture.batches = 1
    await model.refresh()
    await model.toggle(into: composer)
    await until { model.placed == "Repeat." }
    #expect(composer.text == "Repeat.Repeat.")
    composer.text = "Repeat."
    await model.cancel(in: composer)
    #expect(composer.text == "Repeat.", "which copy went can't be told, so neither is taken")
}

@MainActor
@Test func review3_aBatchWhoseWordArrivesAfterDoneIsStillHeard() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["first", "late", "tail"]
    let (model, composer, capture) = bed(host, live: false)
    capture.batches = 1
    capture.late = true
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(composer.text == "first late tail", "heard by the host from its file, not lost or left to the device")
    #expect(capture.transcribed.isEmpty)
}

@MainActor
@Test func aSilentBatchIsntSentAndOneTheHostMissedIsHeardByThisDevice() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["", ""]
    let (model, composer, capture) = bed(host, live: false)
    capture.batches = 1
    capture.speechPerBatch = 0.1
    await model.refresh()
    await model.toggle(into: composer)
    await model.toggle(into: composer)
    #expect(host.all("/api/voice/dictate").isEmpty, "silence isn't sent, nor made up into words")
    #expect(composer.takeEvents() == [.notice("Didn’t catch anything.")])

    let host2 = VoiceHost()
    host2.settings["speech"] = groq
    host2.batchTexts = ["so", "and that's it"]
    let (model2, composer2, capture2) = bed(host2, live: false)
    capture2.batches = 1
    capture2.speechPerBatch = 9
    capture2.fromFile = "so I want the layout fixed before the waves go in"
    await model2.refresh()
    await model2.toggle(into: composer2)
    await model2.toggle(into: composer2)
    #expect(composer2.text.hasPrefix("so I want the layout fixed before the waves go in"), "one word for nine seconds of speech: this device's hearing of it instead")
    #expect(composer2.takeEvents() == [.notice("Groq missed part of it, so this iPhone wrote that part down.")])
}

@MainActor
@Test func heldToStartThePreviewShowsOnlyWhatIsntInTheBoxYet() async {
    let host = VoiceHost()
    host.settings["speech"] = groq
    host.batchTexts = ["First part.", "Second part."]
    let (model, composer, capture) = bed(host)
    capture.heard = "first part second part"
    capture.heardRuns = [HeardWords(text: "first ", start: 1), HeardWords(text: "part ", start: 2), HeardWords(text: "second ", start: 11), HeardWords(text: "part", start: 12)]
    capture.batches = 1
    await model.refresh()
    await model.toggle(into: composer, preview: true)
    #expect(model.preview, "held to start: what you're saying now shows above the box")
    #expect(model.pending == "first part second part" || model.placed == "First part.")
    await until { model.placed == "First part." }
    #expect(composer.text == "First part.")
    #expect(model.pending == "second part", "the part in the box isn't shown twice: only what follows it")
    await model.toggle(into: composer)
    #expect(composer.text == "First part. Second part.")
    #expect(!model.preview)

    let (plain, composer2, _) = bed(VoiceHost(), voice: false)
    let starting = Task { await plain.toggle(into: composer2) }
    await starting.value
    #expect(!plain.preview, "a tap: the box alone")
}

