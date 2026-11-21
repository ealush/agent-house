import Foundation

/// Where a long dictation is cut into batches the host hears while you speak
/// (`../ah/docs/spec/14-voice.md`, VOX-3): at the first pause once a batch holds 10 seconds
/// (the speech providers bill 10 seconds a request at least, so less only costs more), at a
/// quieter moment past 30, and at 40 whatever. Pauses are read from the audio's loudness, so
/// it works in any language, and wherever this device's own speech can't run.
struct BatchCutter: Sendable, Equatable {
    static let least: TimeInterval = 10
    static let longest: TimeInterval = 30
    static let hardest: TimeInterval = 40
    /// Quiet this long is a pause: longer than the gaps between words.
    static let pause: TimeInterval = 0.35

    /// Audio in the batch so far.
    private(set) var length: TimeInterval = 0
    private var quiet: TimeInterval = 0
    /// The room's own level (0…1, `CaptureEvent.level`'s scale): the quietest it's been,
    /// creeping up slowly, so a fan that starts later is heard as quiet too.
    private(set) var floor: Float = 1

    /// One buffer: how long and how loud. True when the batch ends after it.
    mutating func take(seconds: TimeInterval, level: Float) -> Bool {
        length += seconds
        floor = level < floor ? level : floor + (level - floor) * Float(min(1, seconds * 0.02))
        quiet = level < floor + 0.12 ? quiet + seconds : 0
        let cut = (length >= Self.least && quiet >= Self.pause)
            || (length >= Self.longest && level < floor + 0.2)
            || length >= Self.hardest
        if cut { length = 0 }
        return cut
    }
}
