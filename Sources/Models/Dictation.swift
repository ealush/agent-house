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
    /// Every batch cut while listening, in order (each was also sent as `CaptureEvent.batch`).
    var batches: [URL] = []
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
    /// What this dictation has put in the box so far, as it went, and where (UTF-16 offset).
    private(set) var placed = ""
    private var placedAt: Int?
    /// What went in as you spoke was edited meanwhile: it's yours now, and nothing replaces it.
    private var editedLive = false
    /// Where the last dictation went in (UTF-16 offset), for Use What I Said.
    private var lastAt: Int?
    /// Each start, cancel and close moves this on: a start that resumes after it moved isn't
    /// this dictation's any more.
    private var attempt = 0
    /// The last capture stopping (a cancel): the next start waits for it, so two never hold
    /// the microphone and the audio session at once.
    private var stopping: Task<Void, Never>?
    /// The session closed: a recording that fails from here is deleted, not kept for a Try
    /// Again nobody can reach.
    private var closed = false
    /// Which of our spans our own change to the box is about (the others follow it as any edit).
    private enum Span { case live, last }
    private var managing: Span?

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
        attempt += 1
        let mine = attempt
        closed = false
        composer.onTextChange = { [weak self] before, after in self?.follow(before, after) }
        phase = .starting
        partial = ""
        level = 0
        levels = []
        live = wantsWordsAsYouSpeak()
        placed = ""
        editedLive = false
        // The words may need this device after all (the settings changed): read them while
        // listening, and decide when the recording ends.
        reading = Task { await refresh() }
        // The last one let go of the microphone first.
        await stopping?.value
        guard attempt == mine, phase == .starting else { return }
        let capture = makeCapture()
        self.capture = capture
        // A host that does voice whose settings haven't been read yet (a cold start straight
        // into a session): read them first, rather than guess this device.
        if settings == nil, hostDoesVoice() { await settingsRead() }
        guard attempt == mine, phase == .starting else { return }
        // This device listens too unless nothing needs its words: with the host hearing it,
        // they show as you speak (Words as You Speak) and are the cleanup's second hearing.
        let phone = live || (settings?.cleanup != nil && settings?.style != .verbatim)
        let onDevice: Locale? = if case .host = route, !phone { nil } else { (settings ?? VoiceSettings()).locale }
        let events: @MainActor (CaptureEvent) -> Void = { [weak self] event in
            guard let self else { return }
            // A cancelled dictation's last words are nobody's: its late batches go.
            guard self.attempt == mine else {
                if case .batch(let file) = event { try? FileManager.default.removeItem(at: file) }
                return
            }
            // This one's, once it stopped listening: Done hands back every batch cut (`finish`).
            guard self.phase == .starting || self.isListening else { return }
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
                guard attempt == mine, case .host = route else { throw error }
                try await capture.start(transcribing: nil, events: events)
            }
        } catch {
            guard attempt == mine else { return }
            self.capture = nil
            phase = error as? CaptureError == .microphoneDenied ? .denied : .failed((error as? CaptureError)?.message ?? "Couldn’t start listening: \(error.localizedDescription)", retry: false)
            return
        }
        // Cancelled, left, or started again while this one waited (a permission prompt, a
        // language's download): it stops here and keeps nothing.
        guard attempt == mine, phase == .starting else { await capture.cancel(); return }
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
        // Every batch cut, in order, whether or not its word reached us before Done.
        let known = Dictionary(batches.map { ($0.file, $0) }, uniquingKeysWith: { a, _ in a })
        batches = (result.batches + [result.lastBatch].compactMap { $0 }).map { known[$0] ?? Batch(file: $0) }
        if case .host = route, !batches.isEmpty {
            await writeBatches(result, into: composer)
        } else {
            dropBatches()
            await write(result, into: composer)
        }
    }

    /// Stops listening and keeps nothing: what went into the box as you spoke comes out again.
    func cancel(in composer: ComposerModel? = nil) async {
        attempt += 1
        limit?.cancel()
        reading?.cancel()
        hearing?.cancel()
        let capture = self.capture
        self.capture = nil
        if let capture {
            let before = stopping
            stopping = Task {
                await before?.value
                await capture.cancel()
            }
        }
        if let composer, !placed.isEmpty, let back = Self.replacing(placed, at: placedAt, in: composer.text, with: "") {
            apply(back, to: composer, as: .live)
        }
        dropBatches()
        discardKept()
        phase = .idle
        partial = ""
        level = 0
        levels = []
        await stopping?.value
    }

    /// The session is closing (off screen, or signed out): what was being said goes into its
    /// box, a start still waiting stops, and a failed recording kept for Try Again is deleted.
    /// One being written down finishes into its box.
    func close(into composer: ComposerModel) {
        closed = true
        switch phase {
        case .listening: Task { await self.finish(into: composer) }
        case .starting: Task { await self.cancel(in: composer) }
        case .failed, .denied: dismiss()
        case .idle, .writing: break
        }
    }

    /// Recordings left in the temporary folder by a dictation the app didn't live to finish
    /// (they're deleted once written down): at launch, when none is under way.
    nonisolated static func sweep(_ folder: URL = FileManager.default.temporaryDirectory) {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        for name in names where name.hasPrefix("dictation-") && name.hasSuffix(".m4a") {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
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
        if !placed.isEmpty, let at = placedAt, let after = Self.replacing(placed, at: at, in: composer.text, with: placed + " " + text) {
            apply(after, to: composer, as: .live)
            placedAt = at
            placed += " " + text
        } else {
            // The first; or what went in before was edited, which makes it yours: this goes in
            // at the caret, and nothing replaces either once you're done.
            if !placed.isEmpty { editedLive = true }
            placedAt = insert(text, into: composer, as: .live)
            placed = text
        }
    }

    /// Our own change to the box, about one of our spans (`follow` moves the other).
    private func apply(_ change: (text: String, caret: Int), to composer: ComposerModel, as span: Span) {
        managing = span
        composer.text = change.text
        composer.caret = change.caret
        composer.placeCaret = change.caret
        managing = nil
    }

    /// Words in at the caret; where they start (UTF-16).
    private func insert(_ text: String, into composer: ComposerModel, as span: Span) -> Int {
        managing = span
        composer.insert(text)
        managing = nil
        return composer.caret - text.utf16.count
    }

    /// A change to the box (yours, the host's draft, or ours): our spans move with text that
    /// changed before them; one the change touched is no longer ours to replace.
    private func follow(_ before: String, _ after: String) {
        let followsLive = managing != .live && !placed.isEmpty && placedAt != nil
        let followsLast = managing != .last && last != nil && lastAt != nil
        guard followsLive || followsLast else { return }
        guard let (start, oldEnd, delta) = Self.change(from: before, to: after) else { return }
        func moved(_ at: Int, _ length: Int) -> Int? {
            if oldEnd <= at { return at + delta }
            if start >= at + length { return at }
            return nil
        }
        if followsLive, let at = placedAt {
            placedAt = moved(at, placed.utf16.count)
            if placedAt == nil { editedLive = true }
        }
        if followsLast, let at = lastAt, let last {
            lastAt = moved(at, last.text.utf16.count)
            if lastAt == nil { self.last = nil }
        }
    }

    /// Where `before` became `after` (UTF-16): the stretch of `before` that may have changed,
    /// its start and end, and how much longer it got; nil for no change. Two snapshots can't
    /// say which of two same words was edited ("Repeat.Repeat." to "Repeat." is either copy
    /// gone), so the stretch covers every place the change could have been: what's in it is
    /// no longer known to be ours.
    nonisolated static func change(from before: String, to after: String) -> (start: Int, oldEnd: Int, delta: Int)? {
        let old = Array(before.utf16), new = Array(after.utf16)
        guard old != new else { return nil }
        let shorter = min(old.count, new.count)
        // As early as it could be: the longest shared start, then the shared end.
        var head = 0
        while head < shorter, old[head] == new[head] { head += 1 }
        var tail = 0
        while tail < shorter - head, old[old.count - 1 - tail] == new[new.count - 1 - tail] { tail += 1 }
        // As late as it could be: the longest shared end, then the shared start.
        var lateTail = 0
        while lateTail < shorter, old[old.count - 1 - lateTail] == new[new.count - 1 - lateTail] { lateTail += 1 }
        var lateHead = 0
        while lateHead < shorter - lateTail, old[lateHead] == new[lateHead] { lateHead += 1 }
        return (min(head, lateHead), max(old.count - tail, old.count - lateTail), new.count - old.count)
    }

    /// Once you're done: the last batch heard, the batches' words tidied once (with this
    /// device's hearing to check against), in the box in place of what went in as you spoke.
    private func writeBatches(_ result: CaptureResult, into composer: ComposerModel) async {
        guard case .host(let speech) = route else { return }
        queue(into: composer)
        await hearing?.value
        if batches.contains(where: { $0.text == nil }) {
            if closed { finished(result); return }
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
        if live, editedLive || (!placed.isEmpty && (placedAt == nil || Self.located(placed, at: placedAt, in: composer.text) == nil)) {
            // What went in as you spoke was edited: it stays as you left it, untidied.
            finished(result)
            last = nil
            composer.notify("Kept your edits; the rest went in as said.")
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
        last = nil
        lastAt = nil
        if placed.isEmpty {
            lastAt = insert(text, into: composer, as: .live)
        } else if let after = Self.replacing(placed, at: placedAt, in: composer.text, with: text) {
            apply(after, to: composer, as: .live)
            lastAt = after.caret - text.utf16.count
        } else {
            // Edited while it was being tidied: yours stays.
            finished(result)
            last = nil
            composer.notify("Kept your edits; the rest went in as said.")
            return
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
        placedAt = nil
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
            last = nil
            lastAt = insert(words.text, into: composer, as: .last)
            last = Inserted(text: words.text, raw: words.raw, heardBy: words.heardBy, cleanedBy: words.cleanedBy)
            if let note = words.note { composer.notify(note) }
        } catch {
            // Its session is gone: no Try Again to keep the recording for.
            if closed { finished(result); return }
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
        // Cancelling the read itself is what ends the wait: its request stops, and the settings
        // stay as they were.
        let deadline = Task {
            try? await Task.sleep(for: .seconds(3))
            if !Task.isCancelled { reading.cancel() }
        }
        await reading.value
        deadline.cancel()
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
        return Self.located(last.text, at: lastAt, in: text) != nil
    }

    /// The last dictation back as said, in place of its tidied words.
    func useWhatWasSaid(in composer: ComposerModel) {
        guard let last, let swapped = Self.replacing(last.text, at: lastAt, in: composer.text, with: last.raw) else { return }
        apply(swapped, to: composer, as: .last)
        self.last = nil
        lastAt = nil
    }

    /// Where `inserted` is in `draft`: where it went in (`at`, UTF-16, kept up to date by
    /// `follow`), if it's still there as it went in. Nil otherwise: the same words elsewhere
    /// may be yours, and replacing a guess could take them.
    nonisolated static func located(_ inserted: String, at offset: Int?, in draft: String) -> Range<String.Index>? {
        guard !inserted.isEmpty, let offset, offset >= 0, offset + inserted.utf16.count <= draft.utf16.count else { return nil }
        let lower = String.Index(utf16Offset: offset, in: draft)
        let upper = String.Index(utf16Offset: offset + inserted.utf16.count, in: draft)
        return draft[lower..<upper] == inserted ? lower..<upper : nil
    }

    /// `draft` with `inserted` (`located`) replaced by `replacement`, and the caret (UTF-16)
    /// just after it; nil when it can't be found for sure.
    nonisolated static func replacing(_ inserted: String, at offset: Int?, in draft: String, with replacement: String) -> (text: String, caret: Int)? {
        guard let range = located(inserted, at: offset, in: draft) else { return nil }
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

