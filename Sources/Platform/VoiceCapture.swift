import AVFoundation
import Speech

/// The microphone for dictation (`DictationModel`): AVAudioEngine's input, written to an AAC
/// `.m4a` for the host's speech subscription, and cut into batches as you speak (`BatchCutter`)
/// so the host can hear each while you go on; when asked, also fed to this device's own speech
/// recognizer as it comes (`DeviceSpeech`), its words reported as they're heard.
@MainActor
final class VoiceCapture: DictationCapture {
    private let engine = AVAudioEngine()
    private var tap: CaptureTap?
    private var url: URL?
    private var analyzer: SpeechAnalyzer?
    private var heard: Task<String, any Error>?
    private var started = false
    /// The engine's input has our tap on it (it takes one): removed before any other goes on.
    private var tapped = false
    /// The first batch's file, until the tap owns it.
    private var firstBatch: URL?
    /// Cancelled, maybe while `start` waited (the permission prompt, a language's download):
    /// it stops at its next step instead of going on to listen.
    private var cancelled = false
    /// This capture turned the audio session on (and only it turns it off again): a cancelled
    /// one that resumes late can't turn off the next one's.
    private var active = false
    #if DEBUG
    /// Tours: a recording played in as if spoken (`AH_VOICE_FILE`), where a simulator has no
    /// microphone to speak into.
    private var playing: Task<Void, Never>?
    #endif

    func start(transcribing locale: Locale?, events: @escaping @MainActor (CaptureEvent) -> Void) async throws {
        switch DeviceSpeech.microphone {
        case .off: throw CaptureError.microphoneDenied
        case .notAsked: guard await DeviceSpeech.askForMicrophone() else { throw CaptureError.microphoneDenied }
        case .allowed: break
        }
        guard !cancelled else { throw CancellationError() }
        let session = AVAudioSession.sharedInstance()
        do {
            // Other audio ducks while you speak, and comes back after.
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
            active = true
        } catch {
            throw CaptureError.failed("Couldn’t use the microphone: \(error.localizedDescription)")
        }

        let source = Self.debugSource
        let format = try source.map { try AVAudioFile(forReading: $0).processingFormat } ?? engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            deactivate()
            throw CaptureError.failed("There’s no microphone to listen with.")
        }
        // The whole recording, and each batch on its own: AAC, as the speech providers take it.
        let recording: @Sendable () throws -> (AVAudioFile, URL) = {
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).m4a")
            let file = try AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: format.channelCount,
                AVEncoderBitRateKey: 48_000,
            ], commonFormat: format.commonFormat, interleaved: format.isInterleaved)
            return (file, url)
        }
        let file: AVAudioFile
        let url: URL
        let batch: (AVAudioFile, URL)
        do {
            (file, url) = try recording()
            self.url = url
            batch = try recording()
            firstBatch = batch.1
        } catch {
            cleanUp()
            throw CaptureError.failed("Couldn’t record: \(error.localizedDescription)")
        }

        var feed: AsyncStream<AnalyzerInput>.Continuation?
        var converter: AVAudioConverter?
        if let locale {
            do {
                // The language's model, downloaded the first time (`AssetInventory`).
                guard let (module, target) = try await DeviceSpeech.ready(for: locale, live: true) else { throw Self.notReady(locale) }
                guard !cancelled else { throw CancellationError() }
                converter = AVAudioConverter(from: format, to: target)
                let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
                feed = continuation
                let analyzer = SpeechAnalyzer(modules: [module.module])
                self.analyzer = analyzer
                heard = Self.words(of: module) { words in events(.partial(words)) }
                try await analyzer.start(inputSequence: stream)
                guard !cancelled else { throw CancellationError() }
            } catch let error as CaptureError {
                cleanUp()
                throw error
            } catch is CancellationError {
                if let analyzer { await analyzer.cancelAndFinishNow() }
                cleanUp()
                throw CancellationError()
            } catch {
                cleanUp()
                throw CaptureError.failed("Couldn’t listen on this device: \(error.localizedDescription)")
            }
        }

        let tap = CaptureTap(file: file, batch: batch, newBatch: recording, converter: converter, feed: feed, level: { level in
            Task { @MainActor in events(.level(level)) }
        }, cut: { batch, speech, end in
            Task { @MainActor in events(.batch(batch, speech: speech, end: end)) }
        })
        self.tap = tap
        firstBatch = nil
        if let source {
            #if DEBUG
            playing = Task.detached { await CaptureTap.play(source, into: tap) }
            #endif
        } else {
            engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: format, block: Self.tapBlock(tap))
            tapped = true
            engine.prepare()
            do {
                try engine.start()
            } catch {
                untap()
                _ = tap.close()
                self.tap = nil
                cleanUp()
                throw CaptureError.failed("Couldn’t start the microphone: \(error.localizedDescription)")
            }
        }
        started = true
        // A call, Siri, or another app taking the microphone: what was said so far goes in.
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: .main) { note in
            guard (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began else { return }
            MainActor.assumeIsolated { events(.interrupted) }
        }
    }

    private var interruption: (any NSObjectProtocol)?

    func finish() async throws -> CaptureResult {
        stopInput()
        let closed = tap?.close()
        tap = nil
        var text: String?
        if let analyzer {
            // This device's words are a help, not the dictation: failing, the recording still
            // goes on (to the host, or to be written down from the file).
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                text = try await heard?.value
            } catch {
                await analyzer.cancelAndFinishNow()
                text = nil
            }
        }
        analyzer = nil
        heard = nil
        deactivate()
        return CaptureResult(file: url, text: text, lastBatch: closed?.open, batches: closed?.cut ?? [], speech: closed?.speech ?? [:])
    }

    func cancel() async {
        cancelled = true
        stopInput()
        if let closed = tap?.close() {
            for file in closed.cut + [closed.open].compactMap({ $0 }) { try? FileManager.default.removeItem(at: file) }
        }
        tap = nil
        if let analyzer { await analyzer.cancelAndFinishNow() }
        heard?.cancel()
        cleanUp()
    }

    func transcribe(_ file: URL, locale: Locale) async throws -> String {
        guard let (module, _) = try await DeviceSpeech.ready(for: locale, live: false) else { throw Self.notReady(locale) }
        let audio = try AVAudioFile(forReading: file)
        let analyzer = SpeechAnalyzer(modules: [module.module])
        let words = Self.words(of: module) { _ in }
        if let end = try await analyzer.analyzeSequence(from: audio) {
            try await analyzer.finalizeAndFinish(through: end)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await words.value
    }

    private func stopInput() {
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        interruption = nil
        #if DEBUG
        playing?.cancel()
        playing = nil
        #endif
        untap()
        guard started else { return }
        started = false
        if Self.debugSource == nil { engine.stop() }
    }

    private func untap() {
        guard tapped else { return }
        tapped = false
        engine.inputNode.removeTap(onBus: 0)
    }

    /// The tap's block, made outside the main actor: AVAudioEngine calls it on its own audio
    /// thread, and a block that inherited main-actor isolation traps there (Swift 6).
    nonisolated private static func tapBlock(_ tap: CaptureTap) -> AVAudioNodeTapBlock {
        { buffer, _ in tap.take(buffer) }
    }

    private func cleanUp() {
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
        if let firstBatch { try? FileManager.default.removeItem(at: firstBatch) }
        firstBatch = nil
        analyzer = nil
        heard = nil
        deactivate()
    }

    private func deactivate() {
        guard active else { return }
        active = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// A transcriber's words: the finished phrases, with the one still being heard after them,
    /// each word with when it was said.
    private static func words(of module: DeviceSpeech.Module, _ partial: @escaping @MainActor ([HeardWords]) -> Void) -> Task<String, any Error> {
        switch module {
        case .speech(let m): collect(m.results, text: \.text, final: \.isFinal, partial)
        case .dictation(let m): collect(m.results, text: \.text, final: \.isFinal, partial)
        }
    }

    private static func collect<S: AsyncSequence & Sendable>(_ results: S, text: @escaping @Sendable (S.Element) -> AttributedString, final: @escaping @Sendable (S.Element) -> Bool, _ partial: @escaping @MainActor ([HeardWords]) -> Void) -> Task<String, any Error> where S.Element: Sendable {
        Task {
            var done: [HeardWords] = []
            for try await result in results {
                let words = runs(of: text(result))
                if final(result) {
                    done += words
                    partial(done)
                } else {
                    partial(done + words)
                }
            }
            return done.map(\.text).joined()
        }
    }

    /// The words in a result, each with when it began (its time-code attribute, when asked for).
    private static func runs(of text: AttributedString) -> [HeardWords] {
        text.runs.map { run in
            HeardWords(text: String(text[run.range].characters), start: run[AttributeScopes.SpeechAttributes.TimeRangeAttribute.self]?.start.seconds)
        }
    }

    /// A language this device has a model for, which couldn't be readied (offline for its
    /// download; a simulator, which has none to run).
    private static func notReady(_ locale: Locale) -> CaptureError {
        .failed("Couldn’t get \(DeviceSpeech.name(of: locale)) ready on \(DeviceSpeech.thisDevice). Try again, or pick a speech subscription in Settings → Voice.")
    }

    private static var debugSource: URL? {
        #if DEBUG
        ProcessInfo.processInfo.environment["AH_VOICE_FILE"].map { URL(fileURLWithPath: $0) }
        #else
        nil
        #endif
    }
}

/// What the microphone's buffers go to, off the main thread: the recording, the batch being
/// filled (cut at a pause once it holds 10 seconds, and handed on), this device's recognizer
/// (converted to its format), and the meter.
private final class CaptureTap: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private var batch: (file: AVAudioFile, url: URL)?
    private var batchSeconds: TimeInterval = 0
    /// Where in the recording the audio so far reaches (seconds), the recognizer's clock too.
    private var elapsed: TimeInterval = 0
    /// How much of the batch being filled is speech (louder than the room by 10 dB).
    private var batchSpeech: TimeInterval = 0
    private var speech: [URL: TimeInterval] = [:]
    private var cutter = BatchCutter()
    /// Every batch cut so far, in order: handed back at the end too, so one cut just before
    /// Done isn't lost on its way to the model.
    private var cutBatches: [URL] = []
    private let newBatch: @Sendable () throws -> (AVAudioFile, URL)
    private let converter: AVAudioConverter?
    private var feed: AsyncStream<AnalyzerInput>.Continuation?
    private let level: @Sendable (Float) -> Void
    private let cut: @Sendable (URL, TimeInterval, TimeInterval) -> Void
    /// The meter's window (a thirtieth of a second): a buffer holds several (the engine's are
    /// about 85 ms), so the waves get thirty readings a second rather than twelve.
    private var windowSquares: Float = 0
    private var windowFrames = 0

    init(file: AVAudioFile, batch: (AVAudioFile, URL), newBatch: @escaping @Sendable () throws -> (AVAudioFile, URL), converter: AVAudioConverter?, feed: AsyncStream<AnalyzerInput>.Continuation?, level: @escaping @Sendable (Float) -> Void, cut: @escaping @Sendable (URL, TimeInterval, TimeInterval) -> Void) {
        self.file = file
        self.batch = batch
        self.newBatch = newBatch
        self.converter = converter
        self.feed = feed
        self.level = level
        self.cut = cut
    }

    func take(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let file else { return }
        try? file.write(from: buffer)
        if let converter, let feed, let converted = Self.convert(buffer, with: converter) {
            feed.yield(AnalyzerInput(buffer: converted))
        }
        let loud = Self.loudness(buffer)
        if let batch {
            try? batch.file.write(from: buffer)
            let seconds = Double(buffer.frameLength) / buffer.format.sampleRate
            batchSeconds += seconds
            elapsed += seconds
            if loud > cutter.floor + 0.2 { batchSpeech += seconds }
            if cutter.take(seconds: seconds, level: loud) {
                // Closed (whole on disk) before it's handed on; the next one starts here.
                batch.file.close()
                self.batch = nil
                cutBatches.append(batch.url)
                speech[batch.url] = batchSpeech
                cut(batch.url, batchSpeech, elapsed)
                batchSeconds = 0
                batchSpeech = 0
                self.batch = try? newBatch()
            }
        }
        meter(buffer)
    }

    /// The buffer's loudness in windows of a thirtieth of a second, each sent on its own.
    private func meter(_ buffer: AVAudioPCMBuffer) {
        guard let samples = buffer.floatChannelData?[0] else { return }
        let window = max(1, Int(buffer.format.sampleRate / 30))
        for i in 0..<Int(buffer.frameLength) {
            windowSquares += samples[i] * samples[i]
            windowFrames += 1
            if windowFrames >= window {
                level(Self.loudness(rms: (windowSquares / Float(windowFrames)).squareRoot()))
                windowSquares = 0
                windowFrames = 0
            }
        }
    }

    /// No more audio: the recording is closed (whole on disk), the recognizer told, and the
    /// batches handed back: every one cut, and the one being filled (nil when it holds next
    /// to nothing).
    func close() -> (cut: [URL], open: URL?, speech: [URL: TimeInterval]) {
        lock.lock()
        defer { lock.unlock() }
        file?.close()
        file = nil
        feed?.finish()
        feed = nil
        guard let open = batch else { return (cutBatches, nil, speech) }
        open.file.close()
        batch = nil
        if batchSeconds < 0.3 {
            try? FileManager.default.removeItem(at: open.url)
            return (cutBatches, nil, speech)
        }
        speech[open.url] = batchSpeech
        return (cutBatches, open.url, speech)
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> AVAudioPCMBuffer? {
        let ratio = converter.outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 1
        guard let out = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: capacity) else { return nil }
        var given = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if given {
                status.pointee = .noDataNow
                return nil
            }
            given = true
            status.pointee = .haveData
            return buffer
        }
        return error == nil && out.frameLength > 0 ? out : nil
    }

    /// 0 for silence, 1 for shouting: the buffer's RMS on a 50 dB scale.
    private static func loudness(_ buffer: AVAudioPCMBuffer) -> Float {
        guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<Int(buffer.frameLength) { sum += samples[i] * samples[i] }
        return loudness(rms: (sum / Float(buffer.frameLength)).squareRoot())
    }

    private static func loudness(rms: Float) -> Float {
        let db = 20 * log10(max(rms, 1e-7))
        return max(0, min(1, (db + 50) / 50))
    }

    #if DEBUG
    /// A recording played in at the pace it was spoken.
    static func play(_ source: URL, into tap: CaptureTap) async {
        guard let file = try? AVAudioFile(forReading: source) else { return }
        let chunk: AVAudioFrameCount = 4096
        while !Task.isCancelled, file.framePosition < file.length {
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) else { return }
            do { try file.read(into: buffer, frameCount: chunk) } catch { return }
            tap.take(buffer)
            try? await Task.sleep(for: .seconds(Double(buffer.frameLength) / file.processingFormat.sampleRate))
        }
    }
    #endif
}
