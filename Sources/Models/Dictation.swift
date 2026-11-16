import Foundation

// Dictation into the composer (`../ah/docs/spec/14-voice.md`). You speak; the host's speech
// subscription hears the recording, or with none this device does; a cleanup subscription
// may tidy the words; they go into the box at the caret. Nothing is ever sent from here.

/// Where a dictation's words come from.
enum DictationRoute: Equatable, Sendable {
    /// The host's speech subscription (its name) hears the recording.
    case host(speech: String)
    /// This device hears it; the host's cleanup subscription (its name), if any, tidies it.
    case device(cleanup: String?)

    /// `settings` is nil when the host doesn't do voice (no `features.voice`), or before
    /// they're read.
    static func of(_ settings: VoiceSettings?) -> DictationRoute {
        guard let settings else { return .device(cleanup: nil) }
        if let speech = settings.speech { return .host(speech: speech.name) }
        return .device(cleanup: settings.style == .verbatim ? nil : settings.cleanup?.name)
    }
}

/// What the microphone took: always the recording, this device's transcript when it wrote
/// one as it listened, and the batch still open when it stopped (`BatchCutter`).
struct CaptureResult: Sendable, Equatable {
    var file: URL?
    var text: String?
    var lastBatch: URL?
}

enum CaptureEvent: Sendable, Equatable {
    /// Loudness now, 0…1, for the meter.
    case level(Float)
    /// What this device has heard so far (it may still change).
    case partial(String)
    /// Something else took the microphone (a call): what was said so far goes in.
    case interrupted
    /// A batch of the recording, cut at a pause once it held 10 seconds: the host can hear it now.
    case batch(URL)
}

enum CaptureError: Error, Equatable, Sendable {
    /// The microphone is off for this app (Settings → Privacy & Security → Microphone).
    case microphoneDenied
    /// This device can't write down speech in this language.
    case noDeviceSpeech(String)
    case failed(String)

    var message: String {
        switch self {
        case .microphoneDenied: "Agent Hub can’t use the microphone. Turn it on in Settings."
        case .noDeviceSpeech(let language): "This device can’t write down \(language). Pick a speech subscription in Settings → Voice."
        case .failed(let why): why
        }
    }
}

/// The microphone and this device's own speech recognizer (`Platform/VoiceCapture.swift`).
@MainActor
protocol DictationCapture: AnyObject {
    /// Starts listening into a recording; with `locale`, this device writes down what it
    /// hears too. `events` carries the meter and the words so far.
    func start(transcribing locale: Locale?, events: @escaping @MainActor (CaptureEvent) -> Void) async throws
    func finish() async throws -> CaptureResult
    func cancel() async
    /// This device's transcript of a recording the host couldn't hear.
    func transcribe(_ file: URL, locale: Locale) async throws -> String
}

/// One composer's dictation: the microphone button, the card over the conversation while
/// you speak, and the words put into the box.
@MainActor
@Observable
final class DictationModel {
    enum Phase: Equatable, Sendable {
        case idle
        /// The microphone is coming on.
        case starting
        case listening(since: Date)
        /// The recording is being written down (and tidied).
        case writing
        /// Stopped; the recording is kept when trying again can help.
        case failed(String, retry: Bool)
        /// The microphone is off for this app; Settings turns it on.
        case denied
    }

    /// A dictation put into the box, kept so its cleanup can be undone.
    struct Inserted: Equatable, Sendable {
        let text: String
        let raw: String
        /// Who heard it: the speech subscription's name, or this device.
        let heardBy: String
        let cleanedBy: String?

        /// Words about to go in, and what to say about how they were made.
        struct Words: Equatable, Sendable {
            let text: String
            let raw: String
            let heardBy: String
            let cleanedBy: String?
            let note: String?
        }
    }

    /// The longest recording: past it, listening stops and the words go in.
    static let longest: TimeInterval = 300

    /// The microphone this app listens with (`VoiceCapture`, set at launch); none where there's
    /// no app around it (tests, the command line).
    static var makeCapture: @MainActor () -> any DictationCapture = { NoMicrophone() }
    /// "this iPhone", "this iPad", set at launch.
    static var thisDeviceName = "this device"
    /// Words as You Speak (Settings → Voice, this device's): each batch goes into the box as
    /// soon as the host hears it; set at launch from the device's preferences.
    static var wordsAsYouSpeak: @MainActor () -> Bool = { true }

    private(set) var phase: Phase = .idle
    private(set) var level: Float = 0
    /// Loudness over the last few seconds, oldest first (about 20 a second): the box's waves.
    private(set) var levels: [Float] = []
    static let levelsKept = 96
    /// This device's words so far, while it listens.
    private(set) var partial = ""
    private(set) var last: Inserted?
    /// The host's Voice settings; nil when it doesn't do voice or before they're read.
    private(set) var settings: VoiceSettings?
    /// This dictation puts each batch in the box as it's heard (Words as You Speak).
    private(set) var live = false
    /// What this dictation has put in the box so far, as it went.
    private(set) var placed = ""

    /// A long dictation's batches (VOX-3), each heard by the host after the one before it,
    /// with what came before as its context.
    private struct Batch: Sendable {
        let file: URL
        var text: String?
        var queued = false
        /// The host didn't hear it; this device did.
        var byDevice = false
    }
    private var batches: [Batch] = []
    private var hearing: Task<Void, Never>?

    private let api: APIClient
    private let hostDoesVoice: @MainActor () -> Bool
    private let makeCapture: @MainActor () -> any DictationCapture
    /// "this iPhone", "this iPad".
    let thisDevice: String
    private var capture: (any DictationCapture)?
    /// The recording a failed dictation keeps, for Try Again.
    private var kept: CaptureResult?
    private var reading: Task<Void, Never>?
    private var limit: Task<Void, Never>?

    private let wantsWordsAsYouSpeak: @MainActor () -> Bool

    init(api: APIClient, thisDevice: String, hostDoesVoice: @escaping @MainActor () -> Bool, makeCapture: @escaping @MainActor () -> any DictationCapture, wordsAsYouSpeak: @escaping @MainActor () -> Bool = { DictationModel.wordsAsYouSpeak() }) {
        self.api = api
        self.thisDevice = thisDevice
        self.hostDoesVoice = hostDoesVoice
        self.makeCapture = makeCapture
        self.wantsWordsAsYouSpeak = wordsAsYouSpeak
    }

    var route: DictationRoute { .of(settings) }
    var isListening: Bool { if case .listening = phase { true } else { false } }
    var isBusy: Bool { phase == .starting || phase == .writing || isListening }

    /// Reads the host's settings (on showing the composer, and as each dictation starts).
    func refresh() async {
        guard hostDoesVoice() else { settings = nil; return }
        if let fresh = try? await api.voiceSettings() { settings = fresh }
    }

    /// The microphone button: starts listening, or stops and writes the words in.
    func toggle(into composer: ComposerModel) async {
        switch phase {
        case .idle, .failed, .denied: await start(into: composer)
        case .listening: await finish(into: composer)
        case .starting, .writing: break
        }
    }

    func start(into composer: ComposerModel) async {
        discardKept()
        phase = .starting
        partial = ""
        level = 0
        levels = []
        live = wantsWordsAsYouSpeak()
        placed = ""
        // The words may need this device after all (the settings changed): read them while
        // listening, and decide when the recording ends.
        reading = Task { await refresh() }
        let capture = makeCapture()
        self.capture = capture
        // A host that does voice whose settings haven't been read yet (a cold start straight
        // into a session): read them first, rather than guess this device.
        if settings == nil, hostDoesVoice() { await settingsRead() }
        // This device listens too unless nothing needs its words: with the host hearing it,
        // they show as you speak (Words as You Speak) and are the cleanup's second hearing.
        let phone = live || (settings?.cleanup != nil && settings?.style != .verbatim)
        let onDevice: Locale? = if case .host = route, !phone { nil } else { (settings ?? VoiceSettings()).locale }
        let events: @MainActor (CaptureEvent) -> Void = { [weak self] event in
            guard let self, self.phase == .starting || self.isListening else { return }
            switch event {
            case .level(let v):
                self.level = v
                self.levels.append(v)
                if self.levels.count > Self.levelsKept { self.levels.removeFirst(self.levels.count - Self.levelsKept) }
            case .partial(let words): self.partial = words
            case .interrupted: Task { await self.finish(into: composer) }
            case .batch(let file): self.take(file, into: composer)
            }
        }
        do {
            do {
                try await capture.start(transcribing: onDevice, events: events)
            } catch let error as CaptureError where error != .microphoneDenied && onDevice != nil && hostDoesVoice() {
                // This device can't listen for the language (none, or not readied); the host may
                // have a speech subscription by now.
                await settingsRead()
                guard case .host = route else { throw error }
                try await capture.start(transcribing: nil, events: events)
            }
        } catch {
            self.capture = nil
            phase = error as? CaptureError == .microphoneDenied ? .denied : .failed((error as? CaptureError)?.message ?? "Couldn’t start listening: \(error.localizedDescription)", retry: false)
            return
        }
        guard phase == .starting else { await capture.cancel(); return }
        phase = .listening(since: Date())
        limit = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.longest))
            guard !Task.isCancelled, let self, self.isListening else { return }
            await self.finish(into: composer)
        }
    }

    /// Stops listening and puts the words in the box.
    func finish(into composer: ComposerModel) async {
        guard isListening, let capture else { return }
        limit?.cancel()
        phase = .writing
        let result: CaptureResult
        do {
            result = try await capture.finish()
        } catch {
            self.capture = nil
            phase = .failed((error as? CaptureError)?.message ?? "Couldn’t finish listening: \(error.localizedDescription)", retry: false)
            return
        }
        await settingsRead()
        if let tail = result.lastBatch { batches.append(Batch(file: tail)) }
        if case .host = route, !batches.isEmpty {
            await writeBatches(result, into: composer)
        } else {
            dropBatches()
            await write(result, into: composer)
        }
    }

    /// Stops listening and keeps nothing: what went into the box as you spoke comes out again.
    func cancel(in composer: ComposerModel? = nil) async {
        limit?.cancel()
        reading?.cancel()
        hearing?.cancel()
        if let capture { await capture.cancel() }
        capture = nil
        if let composer, !placed.isEmpty, let back = Self.swap(composer.text, placed, for: "") {
            composer.text = back.text
            composer.caret = back.caret
            composer.placeCaret = back.caret
        }
        dropBatches()
        discardKept()
        phase = .idle
        partial = ""
        level = 0
        levels = []
    }

    /// A failed dictation's recording, written down again.
    func retry(into composer: ComposerModel) async {
        guard case .failed(_, true) = phase, let kept else { return }
        phase = .writing
        await settingsRead()
        if !batches.isEmpty {
            for i in batches.indices where batches[i].text == nil { batches[i].queued = false }
            await writeBatches(kept, into: composer)
        } else {
            await write(kept, into: composer)
        }
    }

    // MARK: Batches

    /// A batch cut as you speak: heard now when the host hears this dictation.
    private func take(_ file: URL, into composer: ComposerModel) {
        batches.append(Batch(file: file))
        if case .host = route { queue(into: composer) }
    }

    /// Every batch not yet on its way, each after the one before it.
    private func queue(into composer: ComposerModel) {
        for i in batches.indices where !batches[i].queued {
            batches[i].queued = true
            let before = hearing
            hearing = Task { [weak self] in
                await before?.value
                await self?.hear(i, into: composer)
            }
        }
    }

    /// One batch heard by the host, with what was heard before it as its context; tried
    /// twice, then by this device.
    private func hear(_ i: Int, into composer: ComposerModel) async {
        guard !Task.isCancelled, batches.indices.contains(i), batches[i].text == nil else { return }
        let file = batches[i].file
        let context = batches[..<i].compactMap(\.text).joined(separator: " ")
        var text: String?
        var byDevice = false
        for _ in 0..<2 where text == nil && !Task.isCancelled {
            if let heard = try? await api.dictate(file, style: .verbatim, context: context) {
                text = heard.text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
        }
        if text == nil, !Task.isCancelled, let mine = try? await deviceWords(CaptureResult(file: file), locale: (settings ?? VoiceSettings()).locale) {
            text = mine
            byDevice = true
        }
        guard !Task.isCancelled, batches.indices.contains(i), batches[i].file == file else { return }
        batches[i].text = text
        batches[i].byDevice = byDevice
        if live, let text, !text.isEmpty { place(text, into: composer) }
    }

    /// A heard batch into the box, after the ones before it.
    private func place(_ text: String, into composer: ComposerModel) {
        if !placed.isEmpty, let after = Self.swap(composer.text, placed, for: placed + " " + text) {
            composer.text = after.text
            composer.caret = after.caret
            composer.placeCaret = after.caret
            placed += " " + text
        } else {
            // The first, or what went in before was edited: it's yours now, and this goes in
            // at the caret.
            composer.insert(text)
            placed = text
        }
    }

    /// Once you're done: the last batch heard, the batches' words tidied once (with this
    /// device's hearing to check against), in the box in place of what went in as you spoke.
    private func writeBatches(_ result: CaptureResult, into composer: ComposerModel) async {
        guard case .host(let speech) = route else { return }
        queue(into: composer)
        await hearing?.value
        if batches.contains(where: { $0.text == nil }) {
            kept = result
            capture = nil
            phase = .failed("Couldn’t write down part of it: \(speech) didn’t answer, nor did \(thisDevice).", retry: true)
            return
        }
        let raw = batches.compactMap(\.text).filter { !$0.isEmpty }.joined(separator: " ")
        let byDevice = batches.contains(where: \.byDevice)
        guard !raw.isEmpty else {
            finished(result)
            composer.notify("Didn’t catch anything.")
            return
        }
        var text = raw
        var cleanedBy: String?
        var note: String? = byDevice ? "\(speech) didn’t answer for part of it, so \(thisDevice) wrote that part down." : nil
        if let cleanup = settings?.cleanup, settings?.style != .verbatim {
            do {
                let tidy = try await api.refine(raw, style: settings?.style, phone: result.text)
                text = tidy.text
                cleanedBy = tidy.cleanedBy
            } catch {
                note = "Couldn’t tidy it with \(cleanup.name), so it’s as said."
            }
        }
        if placed.isEmpty {
            composer.insert(text)
        } else if let after = Self.swap(composer.text, placed, for: text) {
            composer.text = after.text
            composer.caret = after.caret
            composer.placeCaret = after.caret
        } else {
            // What went in as you spoke was edited: it stays as you left it.
            text = placed
            cleanedBy = nil
        }
        last = Inserted(text: text, raw: raw, heardBy: byDevice ? thisDevice : speech, cleanedBy: cleanedBy)
        finished(result)
        if let note { composer.notify(note) }
    }

    private func dropBatches() {
        hearing?.cancel()
        hearing = nil
        for batch in batches { try? FileManager.default.removeItem(at: batch.file) }
        batches = []
        placed = ""
    }

    func dismiss() {
        guard !isBusy else { return }
        discardKept()
        phase = .idle
    }

    private func write(_ result: CaptureResult, into composer: ComposerModel) async {
        do {
            guard let words = try await words(for: result) else {
                finished(result)
                composer.notify("Didn’t catch anything.")
                return
            }
            finished(result)
            composer.insert(words.text)
            last = Inserted(text: words.text, raw: words.raw, heardBy: words.heardBy, cleanedBy: words.cleanedBy)
            if let note = words.note { composer.notify(note) }
        } catch {
            kept = result
            capture = nil
            let message = (error as? CaptureError)?.message ?? APIError.wrap(error).message
            phase = .failed(message, retry: result.file != nil || result.text != nil)
        }
    }

    /// The settings read as listening began, but not a host that doesn't answer: after a few
    /// seconds the words go by the settings as they were.
    private func settingsRead() async {
        guard let reading else { return }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await reading.value }
            group.addTask { try? await Task.sleep(for: .seconds(3)) }
            await group.next()
            group.cancelAll()
        }
    }

    private func finished(_ result: CaptureResult) {
        if let file = result.file { try? FileManager.default.removeItem(at: file) }
        dropBatches()
        kept = nil
        capture = nil
        phase = .idle
        partial = ""
        level = 0
        levels = []
    }

    private func discardKept() {
        if let file = kept?.file { try? FileManager.default.removeItem(at: file) }
        kept = nil
        dropBatches()
    }

    /// The words for the box, by the settings as they are now; nil for none heard.
    private func words(for result: CaptureResult) async throws -> Inserted.Words? {
        let locale = (settings ?? VoiceSettings()).locale
        if case .host(let speech) = route, let file = result.file {
            do {
                let heard = try await api.dictate(file, style: settings?.style)
                let text = heard.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { return nil }
                let raw = heard.raw.trimmingCharacters(in: .whitespacesAndNewlines)
                return .init(text: text, raw: raw.isEmpty ? text : raw, heardBy: heard.speech ?? speech, cleanedBy: heard.cleanedBy, note: heard.cleanupError.map { "Couldn’t tidy it, so it’s as said: \($0)" })
            } catch let error as APIError where !Self.deviceCanHelp(error) {
                throw error
            } catch {
                // The host or its provider didn't answer: this device can still hear it.
                let mine = try await deviceWords(result, locale: locale)
                guard !mine.isEmpty else { throw error }
                return .init(text: mine, raw: mine, heardBy: thisDevice, cleanedBy: nil, note: "\(speech) didn’t answer, so \(thisDevice) wrote it down.")
            }
        }
        let mine = try await deviceWords(result, locale: locale)
        guard !mine.isEmpty else { return nil }
        guard case .device(let cleanup?) = route else { return .init(text: mine, raw: mine, heardBy: thisDevice, cleanedBy: nil, note: nil) }
        do {
            let tidy = try await api.refine(mine, style: settings?.style)
            return .init(text: tidy.text, raw: mine, heardBy: thisDevice, cleanedBy: tidy.cleanedBy, note: nil)
        } catch {
            return .init(text: mine, raw: mine, heardBy: thisDevice, cleanedBy: nil, note: "Couldn’t tidy it with \(cleanup), so it’s as said.")
        }
    }

    /// A refusal this device hearing the recording itself can fix (the host or its
    /// provider down, the speech subscription gone); not a sign-in or size refusal.
    private static func deviceCanHelp(_ error: APIError) -> Bool {
        switch error {
        case .unauthorized, .forbidden, .cancelled: false
        case .server(let status, _): status >= 500 || status == 400
        default: true
        }
    }

    /// This device's words: the ones it wrote as it listened, else from the recording.
    private func deviceWords(_ result: CaptureResult, locale: Locale) async throws -> String {
        if let text = result.text { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let file = result.file else { return "" }
        let capture = self.capture ?? makeCapture()
        self.capture = capture
        return try await capture.transcribe(file, locale: locale).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Undoing a cleanup

    /// The tidied words stay; Use What I Said is no longer offered.
    func keepTidied() { last = nil }

    /// Whether the last dictation was tidied and is still in the box as it went in.
    func canUseWhatWasSaid(in text: String) -> Bool {
        guard let last, last.raw != last.text else { return false }
        return text.contains(last.text)
    }

    /// The last dictation back as said, in place of its tidied words.
    func useWhatWasSaid(in composer: ComposerModel) {
        guard let last, let swapped = Self.swap(composer.text, last.text, for: last.raw) else { return }
        composer.text = swapped.text
        composer.caret = swapped.caret
        composer.placeCaret = swapped.caret
        self.last = nil
    }

    /// `draft` with its last copy of `inserted` replaced by `replacement`, and the caret
    /// (UTF-16) just after it; nil when `inserted` is no longer there.
    nonisolated static func swap(_ draft: String, _ inserted: String, for replacement: String) -> (text: String, caret: Int)? {
        guard !inserted.isEmpty, let range = draft.range(of: inserted, options: .backwards) else { return nil }
        var text = draft
        text.replaceSubrange(range, with: replacement)
        let caret = draft[..<range.lowerBound].utf16.count + replacement.utf16.count
        return (text, caret)
    }
}

/// Where there's no microphone to listen with (tests, the command line).
@MainActor
private final class NoMicrophone: DictationCapture {
    func start(transcribing locale: Locale?, events: @escaping @MainActor (CaptureEvent) -> Void) async throws { throw CaptureError.failed("There’s no microphone to listen with.") }
    func finish() async throws -> CaptureResult { CaptureResult() }
    func cancel() async {}
    func transcribe(_ file: URL, locale: Locale) async throws -> String { throw CaptureError.failed("There’s no microphone to listen with.") }
}

