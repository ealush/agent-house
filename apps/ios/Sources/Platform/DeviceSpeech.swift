import AVFoundation
import Speech
import UIKit

/// This device's side of Voice: the microphone's permission, and Apple's on-device speech
/// (`SpeechAnalyzer`, iOS 26) for a language. Nothing here leaves the device.
enum DeviceSpeech {
    enum Microphone: Equatable, Sendable {
        case notAsked, allowed, off
    }

    static var microphone: Microphone {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: .allowed
        case .denied: .off
        default: .notAsked
        }
    }

    /// Asks once; after a refusal only Settings can turn it on.
    static func askForMicrophone() async -> Bool { await AVAudioApplication.requestRecordPermission() }

    enum Readiness: Equatable, Sendable {
        /// Its model is on the device.
        case ready
        /// Its model downloads first (the first dictation, or Download).
        case download
        case downloading
        /// This device can't write this language down.
        case unavailable
    }

    /// The transcriber for a language. `SpeechTranscriber` (Apple's newer model) where the
    /// device and language allow it, else `DictationTranscriber` (the keyboard's dictation
    /// model: more languages, older devices). `live` reports words as they're heard.
    enum Module {
        case speech(SpeechTranscriber)
        case dictation(DictationTranscriber)

        var module: any SpeechModule {
            switch self {
            case .speech(let m): m
            case .dictation(let m): m
            }
        }
    }

    /// The transcribers that can write a language down here, best first: the newer model
    /// does Hebrew no more, and a device or simulator may lack it; the keyboard's covers more.
    static func modules(for locale: Locale, live: Bool) async -> [Module] {
        var found: [Module] = []
        if SpeechTranscriber.isAvailable, let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) {
            // Live: each word with when it was said, so what you're saying now can be told from
            // what's in the box already.
            found.append(.speech(SpeechTranscriber(locale: supported, preset: live ? .timeIndexedProgressiveTranscription : .transcription)))
        }
        if let supported = await DictationTranscriber.supportedLocale(equivalentTo: locale) {
            if live {
                let p = DictationTranscriber.Preset.progressiveLongDictation
                found.append(.dictation(DictationTranscriber(locale: supported, contentHints: p.contentHints, transcriptionOptions: p.transcriptionOptions, reportingOptions: p.reportingOptions, attributeOptions: p.attributeOptions.union([.audioTimeRange]))))
            } else {
                found.append(.dictation(DictationTranscriber(locale: supported, preset: .longDictation)))
            }
        }
        return found
    }

    /// The first transcriber that's ready to listen, its model downloaded if it has to be,
    /// with the audio format it takes; nil when none can be readied.
    static func ready(for locale: Locale, live: Bool) async throws -> (module: Module, format: AVAudioFormat)? {
        let found = await modules(for: locale, live: live)
        guard !found.isEmpty else { throw CaptureError.noDeviceSpeech(name(of: locale)) }
        for module in found {
            if let install = try? await AssetInventory.assetInstallationRequest(supporting: [module.module]) { try? await install.downloadAndInstall() }
            if let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [module.module]) { return (module, format) }
        }
        return nil
    }

    static func readiness(for locale: Locale) async -> Readiness {
        var best = Readiness.unavailable
        for module in await modules(for: locale, live: true) {
            let now: Readiness = switch await AssetInventory.status(forModules: [module.module]) {
            case .installed: .ready
            case .downloading: .downloading
            case .supported: .download
            default: .unavailable
            }
            if now == .ready { return .ready }
            if best == .unavailable || (best == .download && now == .downloading) { best = now }
        }
        return best
    }

    /// Downloads the language's model now, telling `progress` how far it's got (0…1).
    static func download(for locale: Locale, progress: @escaping @MainActor (Double) -> Void) async throws {
        guard let module = await modules(for: locale, live: true).first else { throw CaptureError.noDeviceSpeech(name(of: locale)) }
        guard let request = try await AssetInventory.assetInstallationRequest(supporting: [module.module]) else { return }
        let watch = Task { @MainActor in
            while !Task.isCancelled {
                progress(request.progress.fractionCompleted)
                try? await Task.sleep(for: .milliseconds(250))
            }
        }
        defer { watch.cancel() }
        try await request.downloadAndInstall()
        await progress(1)
    }

    /// A language's name, in this device's language ("Hebrew").
    static func name(of locale: Locale) -> String {
        Locale.current.localizedString(forLanguageCode: locale.language.languageCode?.identifier ?? locale.identifier) ?? locale.identifier
    }

    /// "this iPhone", "this iPad", "this Mac".
    @MainActor static var thisDevice: String {
        #if targetEnvironment(macCatalyst)
        "this Mac"
        #else
        UIDevice.current.userInterfaceIdiom == .pad ? "this iPad" : "this iPhone"
        #endif
    }
}
