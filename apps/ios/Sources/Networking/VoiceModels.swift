import Foundation

// Voice dictation's shapes (`apps/server/server/voice.ts`, `docs/spec/14-voice.md`).
// Read leniently: a host from before a field was added still decodes.

/// How a dictation's words are tidied before they go into the box.
enum VoiceStyle: String, Codable, CaseIterable, Sendable, Identifiable {
    /// The words as said.
    case verbatim
    /// Fillers, false starts and repeats out; punctuation fixed.
    case clean
    /// Clean, and a long message in paragraphs and lists.
    case structured

    var id: String { rawValue }
    var title: String {
        switch self {
        case .verbatim: "As Said"
        case .clean: "Clean"
        case .structured: "Structured"
        }
    }
    var summary: String {
        switch self {
        case .verbatim: "Your words exactly as the speech model heard them."
        case .clean: "Fillers and false starts out, punctuation fixed, your meaning kept."
        case .structured: "Clean, and a long message in paragraphs and lists."
        }
    }
}

/// The host's Voice settings (`GET /api/voice`).
struct VoiceSettings: Codable, Equatable, Sendable {
    /// A subscription doing one of voice's jobs, by the name it has now.
    struct Pick: Codable, Equatable, Sendable {
        let subscriptionId: String
        let name: String
        let model: String
    }
    var speech: Pick?
    var cleanup: Pick?
    var style: VoiceStyle
    /// `auto`, or an ISO 639-1 code (`en`, `he`).
    var language: String
    var vocabulary: [String]
    var maxBytes: Int

    init(speech: Pick? = nil, cleanup: Pick? = nil, style: VoiceStyle = .clean, language: String = "auto", vocabulary: [String] = [], maxBytes: Int = 25 * 1024 * 1024) {
        self.speech = speech
        self.cleanup = cleanup
        self.style = style
        self.language = language
        self.vocabulary = vocabulary
        self.maxBytes = maxBytes
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        speech = try c.decodeIfPresent(Pick.self, forKey: .speech)
        cleanup = try c.decodeIfPresent(Pick.self, forKey: .cleanup)
        style = (try? c.decodeIfPresent(VoiceStyle.self, forKey: .style)) ?? .clean
        language = try c.decodeIfPresent(String.self, forKey: .language) ?? "auto"
        vocabulary = try c.decodeIfPresent([String].self, forKey: .vocabulary) ?? []
        maxBytes = try c.decodeIfPresent(Int.self, forKey: .maxBytes) ?? 25 * 1024 * 1024
    }

    /// The language to listen for on this device: the host's choice, else the device's own.
    var locale: Locale { language == "auto" ? .current : Locale(identifier: language) }
}

/// A change to the Voice settings (`PUT /api/voice`): only what's set is sent. For `speech`
/// and `cleanup`, `.some(nil)` turns that job off.
struct VoiceChange: Encodable, Equatable, Sendable {
    struct Pick: Encodable, Equatable, Sendable {
        let subscriptionId: String
        let model: String
    }
    var speech: Pick??
    var cleanup: Pick??
    var style: VoiceStyle?
    var language: String?
    var vocabulary: [String]?

    init(speech: Pick?? = nil, cleanup: Pick?? = nil, style: VoiceStyle? = nil, language: String? = nil, vocabulary: [String]? = nil) {
        self.speech = speech
        self.cleanup = cleanup
        self.style = style
        self.language = language
        self.vocabulary = vocabulary
    }

    private enum CodingKeys: String, CodingKey { case speech, cleanup, style, language, vocabulary }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        if let speech { if let speech { try c.encode(speech, forKey: .speech) } else { try c.encodeNil(forKey: .speech) } }
        if let cleanup { if let cleanup { try c.encode(cleanup, forKey: .cleanup) } else { try c.encodeNil(forKey: .cleanup) } }
        try c.encodeIfPresent(style, forKey: .style)
        try c.encodeIfPresent(language, forKey: .language)
        try c.encodeIfPresent(vocabulary, forKey: .vocabulary)
    }
}

/// What the host heard in a recording (`POST /api/voice/dictate`).
struct DictationResult: Decodable, Equatable, Sendable {
    /// What the speech model heard.
    let raw: String
    /// What goes into the box: `raw` tidied, or `raw` itself.
    let text: String
    /// The speech subscription's name.
    let speech: String?
    /// The cleanup subscription's name; nil when nothing tidied it.
    let cleanedBy: String?
    /// Why a cleanup that was asked for didn't happen (`text` is then `raw`).
    let cleanupError: String?
    let seconds: Double?
}

/// Text written on the device, tidied by the host (`POST /api/voice/refine`).
struct RefinedText: Decodable, Equatable, Sendable {
    let text: String
    let cleanedBy: String
}
