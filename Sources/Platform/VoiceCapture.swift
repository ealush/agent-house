import AVFoundation
import Speech

/// The microphone for dictation (`DictationModel`): AVAudioEngine's input, written to an AAC
/// `.m4a` for the host's speech subscription and, when asked, fed to this device's own speech
/// recognizer as it comes (`DeviceSpeech`), its words reported as they're heard.
@MainActor
final class VoiceCapture: DictationCapture {
    private let engine = AVAudioEngine()
    private var tap: CaptureTap?
    private var url: URL?
    private var analyzer: SpeechAnalyzer?
    private var heard: Task<String, any Error>?
    private var started = false
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
        let session = AVAudioSession.sharedInstance()
        do {
            // Other audio ducks while you speak, and comes back after.
            try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.duckOthers, .defaultToSpeaker, .allowBluetoothHFP])
            try session.setActive(true)
        } catch {
            throw CaptureError.failed("Couldn’t use the microphone: \(error.localizedDescription)")
        }

        let source = Self.debugSource
        let format = try source.map { try AVAudioFile(forReading: $0).processingFormat } ?? engine.inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            deactivate()
            throw CaptureError.failed("There’s no microphone to listen with.")
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("dictation-\(UUID().uuidString).m4a")
        let file: AVAudioFile
        do {
            file = try AVAudioFile(forWriting: url, settings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: format.channelCount,
                AVEncoderBitRateKey: 48_000,
            ], commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        } catch {
            deactivate()
            throw CaptureError.failed("Couldn’t record: \(error.localizedDescription)")
        }
        self.url = url

        var feed: AsyncStream<AnalyzerInput>.Continuation?
        var converter: AVAudioConverter?
        if let locale {
            do {
                // The language's model, downloaded the first time (`AssetInventory`).
                guard let (module, target) = try await DeviceSpeech.ready(for: locale, live: true) else { throw Self.notReady(locale) }
                converter = AVAudioConverter(from: format, to: target)
                let (stream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
                feed = continuation
                let analyzer = SpeechAnalyzer(modules: [module.module])
                self.analyzer = analyzer
                heard = Self.words(of: module) { words in events(.partial(words)) }
                try await analyzer.start(inputSequence: stream)
            } catch let error as CaptureError {
                cleanUp()
                throw error
            } catch {
                cleanUp()
                throw CaptureError.failed("Couldn’t listen on this device: \(error.localizedDescription)")
            }
        }

        let tap = CaptureTap(file: file, converter: converter, feed: feed) { level in
            Task { @MainActor in events(.level(level)) }
        }
        self.tap = tap
        if let source {
            #if DEBUG
            playing = Task.detached { await CaptureTap.play(source, into: tap) }
            #endif
        } else {
            engine.inputNode.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in tap.take(buffer) }
            engine.prepare()
            do {
                try engine.start()
            } catch {
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
        tap?.close()
        tap = nil
        var text: String?
        if let analyzer {
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
                text = try await heard?.value
            } catch {
                await analyzer.cancelAndFinishNow()
                deactivate()
                throw CaptureError.failed("Couldn’t write it down on this device: \(error.localizedDescription)")
            }
        }
        analyzer = nil
        heard = nil
        deactivate()
        return CaptureResult(file: url, text: text)
    }

    func cancel() async {
        stopInput()
        tap?.close()
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
        guard started else { return }
        started = false
        if Self.debugSource == nil {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
        }
    }

    private func cleanUp() {
        if let url { try? FileManager.default.removeItem(at: url) }
        url = nil
        analyzer = nil
        heard = nil
        deactivate()
    }

    private func deactivate() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// A transcriber's words: the finished phrases, with the one still being heard after them.
    private static func words(of module: DeviceSpeech.Module, _ partial: @escaping @MainActor (String) -> Void) -> Task<String, any Error> {
        switch module {
        case .speech(let m): collect(m.results, text: \.text, final: \.isFinal, partial)
        case .dictation(let m): collect(m.results, text: \.text, final: \.isFinal, partial)
        }
    }

    private static func collect<S: AsyncSequence & Sendable>(_ results: S, text: @escaping @Sendable (S.Element) -> AttributedString, final: @escaping @Sendable (S.Element) -> Bool, _ partial: @escaping @MainActor (String) -> Void) -> Task<String, any Error> where S.Element: Sendable {
        Task {
            var done = ""
            for try await result in results {
                let words = String(text(result).characters)
                if final(result) {
                    done += words
                    partial(done)
                } else {
                    partial(done + words)
                }
            }
            return done
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

/// What the microphone's buffers go to, off the main thread: the recording, this device's
/// recognizer (converted to its format), and the meter.
private final class CaptureTap: @unchecked Sendable {
    private let lock = NSLock()
    private var file: AVAudioFile?
    private let converter: AVAudioConverter?
    private var feed: AsyncStream<AnalyzerInput>.Continuation?
    private let level: @Sendable (Float) -> Void
    private var lastLevel = Date.distantPast

    init(file: AVAudioFile, converter: AVAudioConverter?, feed: AsyncStream<AnalyzerInput>.Continuation?, level: @escaping @Sendable (Float) -> Void) {
        self.file = file
        self.converter = converter
        self.feed = feed
        self.level = level
    }

    func take(_ buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard let file else { return }
        try? file.write(from: buffer)
        if let converter, let feed, let converted = Self.convert(buffer, with: converter) {
            feed.yield(AnalyzerInput(buffer: converted))
        }
        // The meter at about 20 a second: more is only work for the main thread.
        let now = Date()
        if now.timeIntervalSince(lastLevel) > 0.05 {
            lastLevel = now
            level(Self.loudness(buffer))
        }
    }

    /// No more audio: the recording is closed (whole on disk) and the recognizer told.
    func close() {
        lock.lock()
        defer { lock.unlock() }
        file = nil
        feed?.finish()
        feed = nil
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
        let rms = (sum / Float(buffer.frameLength)).squareRoot()
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
